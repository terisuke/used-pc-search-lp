#!/usr/bin/env node
// used-pc-search-lp — 定期取得パイプライン
// Perplexity Search API (一次検索・実URL) → 機械HTTP判定(全候補) → Gemini(スペック抽出+上位照合) → data/*.json
// env: PERPLEXITY_API_KEY, GEMINI_API_KEY (必須 / GEMINI_MODEL 任意)

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isListingPage, canonUrl, extractPriceCandidates, diffBadge, hasProductUrlSignal, detectProductMarkers, detectSoldOutFromHtml } from "./lib/filters.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CFG = JSON.parse(await readFile(path.join(ROOT, "config/conditions.json"), "utf8"));
const UA = "used-pc-search-lp/0.1 (+https://github.com/terisuke/used-pc-search-lp)";
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || CFG.gemini_model || "gemini-flash-latest";

if (!PERPLEXITY_KEY || !GEMINI_KEY) {
  console.error("PERPLEXITY_API_KEY / GEMINI_API_KEY が必要です");
  process.exit(1);
}

const now = () => new Date().toISOString();
const idOf = (url) => createHash("sha1").update(url).digest("hex").slice(0, 12);

/* ---------- Perplexity Search API ---------- */
async function searchOnce(query) {
  const res = await fetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, max_results: CFG.max_results_per_query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`perplexity search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function primarySearch() {
  const all = [];
  const seen = new Set();
  for (const q of CFG.queries) {
    let results = [];
    try {
      results = await searchOnce(q);
    } catch (e) {
      console.error(`[warn] query failed: ${q} -> ${e.message}`);
    }
    for (const r of results) {
      const canon = canonUrl(r.url || "");
      if (!canon || seen.has(canon)) continue;
      let host = "";
      try { host = new URL(canon).hostname.replace(/^www\./, ""); } catch { continue; }
      if (isListingPage(canon)) continue; // 一覧・カテゴリ・ニュース/技術記事・SNSを一括除外
      seen.add(canon);
      all.push({
        id: idOf(canon),
        url: canon,
        host,
        search_title: r.title || "",
        snippet: (r.snippet || "").slice(0, 1200),
        search_rank: all.length + 1,
        updated_at: r.last_updated || r.date || null,
      });
    }
  }
  return all.slice(0, CFG.max_items);
}

/* ---------- 機械 HTTP 判定 (全候補) ---------- */
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function httpStatus(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: { "User-Agent": UA, "Accept-Language": "ja" },
        signal: AbortSignal.timeout(12_000),
      });
      if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue;
      return res.status;
    } catch {
      if (method === "GET") return null;
    }
  }
  return null;
}

/* ---------- ページ本文取得 ---------- */
async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer().then((b) => b.slice(0, 400_000));
    let raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if ((raw.match(/\uFFFD/g) || []).length > 40) {
      try { raw = new TextDecoder("shift_jis", { fatal: false }).decode(buf); } catch { /* keep utf-8 */ }
    }
    /* SPA等では価格が <script> 内JSONにしか無いことがある → タグ除去前に価格候補を収集 */
    const priceCandidates = extractPriceCandidates(raw);
    const soldOut = detectSoldOutFromHtml(raw);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 15_000);
    return { text, priceCandidates, soldOut };
  } catch {
    return null;
  }
}

/* ---------- Gemini ---------- */
const ItemSpec = z.object({
  index: z.number().int().min(0),
  shop: z.string().nullish(),
  title: z.string().nullish(),
  price_yen: z.number().int().nullish(),
  gpu: z.string().nullish(),
  gpu_vram_gb: z.number().nullish(),
  cpu: z.string().nullish(),
  ram_gb: z.number().int().nullish(),
  storage: z.string().nullish(),
  rank: z.string().nullish(),
});
const VerifyOut = z.object({
  verdict: z.enum(["verified", "partial", "mismatch"]),
  issues: z.array(z.string()).max(5).default([]),
  page_price_yen: z.number().int().nullish(),
  in_stock: z.boolean().nullish(),
});

async function gemini(parts, schema, { temperature = 0 } = {}) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature, responseMimeType: "application/json", responseSchema: schema },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return { parsed: JSON.parse(text), usage: data?.usageMetadata || null };
}

async function extractSpecs(items) {
  if (!items.length) return [];
  const rows = [];
  const CHUNK = 4;
  for (let start = 0; start < items.length; start += CHUNK) {
    const chunk = items.slice(start, start + CHUNK);
    const list = chunk
      .map((it) => `index=${start + chunk.indexOf(it)}\nhost=${it.host}\n題名: ${it.search_title}\nスニペット: ${it.snippet}`)
      .join("\n\n");
    const prompt =
      "以下は日本の中古デスクトップPC商品ページの検索結果(題名+スニペット)です。" +
      "各項目について商品スペックを抽出してください。推測は禁止、書かれていない項目はnull。"
      + `目安: 価格上限${CFG.target.max_price_yen}円・GPU優先${CFG.target.gpu_priority}・メモリ${CFG.target.min_ram_gb}GB以上。`
      + "ランクはショップ表記(S/A/B/C/D)のみ。日本語で。indexは各行に明記された値をそのまま返す。\n\n" + list;
    const schema = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER" },
          shop: { type: "STRING", nullable: true },
          title: { type: "STRING", nullable: true },
          price_yen: { type: "INTEGER", nullable: true },
          gpu: { type: "STRING", nullable: true },
          gpu_vram_gb: { type: "NUMBER", nullable: true },
          cpu: { type: "STRING", nullable: true },
          ram_gb: { type: "INTEGER", nullable: true },
          storage: { type: "STRING", nullable: true },
          rank: { type: "STRING", nullable: true },
        },
        required: ["index"],
      },
    };
    let got = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        got = await gemini([{ text: prompt }], schema);
        break;
      } catch (e) {
        console.error(`[warn] extract chunk ${start} attempt ${attempt}: ${e.message}`);
      }
    }
    if (!got) continue;
    try {
      const parsedRows = z.array(ItemSpec).parse(got.parsed);
      for (const row of parsedRows) {
        if (row.index < start || row.index >= start + CHUNK) continue; // ハルシネーションindex拒否
        rows.push(row);
      }
    } catch (e) {
      console.error(`[warn] extract chunk ${start} validation: ${e.message}`);
    }
  }
  return rows;
}

async function verifyOne(item) {
  const page = await fetchText(item.url);
  if (!page) {
    return { verdict: "partial", issues: ["ページ本文取得失敗(内容照合不可)"], page_price_yen: null, in_stock: null };
  }
  /* 機械判定: SOLD OUT等はモデルに委ねず即・売り切れ(コードで決定) */
  if (page.soldOut) {
    return { verdict: "mismatch", issues: ["売り切れ表示(SOLD OUT/完売等)"], page_price_yen: null, in_stock: false };
  }
  const { parsed } = await gemini(
    [{
      text:
        "商品ページ本文と、検索から抽出した候補データを照合してください。\n" +
        `候補: ${JSON.stringify({
          title: item.title, price_yen: item.price_yen, gpu: item.gpu, gpu_vram_gb: item.gpu_vram_gb,
          cpu: item.cpu, ram_gb: item.ram_gb, storage: item.storage, rank: item.rank,
        })}\n\nページ本文中の価格表記候補(スクリプト内JSON含むから収集): ${page.priceCandidates.join(" / ") || "(なし)"}\n\nページ本文:\n${page.text.slice(0, 12_000)}\n\n` +
        "page_price_yen は本文または価格候補から判断(税込優先、ない場合はnull)。候補の価格がnullで本文に価格がある場合は必ずpage_price_yenに入れる。" +
        "重要: 候補の項目がnull(未取得)の場合は『不一致』としない(情報不足としてpartial寄りに扱う)。乖離の判定は、候補に値があり本文と矛盾する場合のみ。" +
        "SOLD OUT・完売・品切れ・在庫なし等の表記があれば sold_out=true とし verdict=mismatch。" +
        "判定: verified=主要項目(価格/GPU/メモリ)が一致 / partial=一部不一致または確認不能 " +
        "/ mismatch=重大な乖離または売り切れ・別商品。issuesは日本語で簡潔に(最大5件)。",
    }],
    {
      type: "OBJECT",
      properties: {
        verdict: { type: "STRING", enum: ["verified", "partial", "mismatch"] },
        issues: { type: "ARRAY", items: { type: "STRING" } },
        page_price_yen: { type: "INTEGER", nullable: true },
        in_stock: { type: "BOOLEAN", nullable: true },
      },
      required: ["verdict"],
    },
  );
  return VerifyOut.parse(parsed);
}

/* ---------- 差分(diffBadge は lib/filters.mjs を使用) ---------- */
/* ---------- 商品ページ確認(ポジティブ判定) ---------- */
/* deny-listは未知ショップに漏れるため、URL形状シグナルが無い候補は
   本文を取得して JSON-LD Product / og:type=product を要求する(無ければ落とす) */
async function sniffProduct(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer().then((b) => b.slice(0, 300_000));
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return detectProductMarkers(raw).isProduct;
  } catch {
    return false;
  }
}

async function confirmProductPages(candidates) {
  const needSniff = candidates; // URL形状だけでなく全候補の本文マーカーを要求
  const results = await mapPool(needSniff, 4, async (it) => {
    const signal = hasProductUrlSignal(it.url);
    try {
      const res = await fetch(it.url, {
        headers: { "User-Agent": UA, "Accept-Language": "ja" },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return false;
      const buf = await res.arrayBuffer().then((b) => b.slice(0, 300_000));
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      return detectProductMarkers(raw).isProduct;
    } catch {
      return signal; // 取得失敗時のみURL形状でフォールバック
    }
  });
  const sniffOk = new Set(needSniff.filter((it, i) => results[i]).map((it) => it.url));
  const dropped = needSniff.length - sniffOk.size;
  console.log(`[ingest] product-page confirm: markers-ok=${sniffOk.size}, dropped=${dropped}`);
  return candidates.filter((it) => sniffOk.has(it.url));
}

/* ---------- main ---------- */
const started = now();
console.log(`[ingest] start ${started} model=${GEMINI_MODEL}`);

const candidates = await primarySearch();
console.log(`[ingest] primary candidates: ${candidates.length}`);
if (!candidates.length) {
  const prevPath = path.join(ROOT, "data/latest.json");
  try {
    const prev = JSON.parse(await readFile(prevPath, "utf8"));
    if (Array.isArray(prev.items) && prev.items.length) {
      console.error("[warn] 検索0件 — 前回データを維持します");
      process.exit(0);
    }
  } catch { /* no prev */ }
  console.error("[error] 検索0件かつ前回データなし");
  process.exit(1);
}

const raw = await confirmProductPages(candidates);

const statuses = await mapPool(raw, 5, (it) => httpStatus(it.url));
raw.forEach((it, i) => { it.factcheck = { http_status: statuses[i], verdict: null, checked_at: null, issues: [] }; });

const live = raw.filter((it) => it.factcheck.http_status !== 404);
console.log(`[ingest] http check: live=${live.length} / 404=${raw.length - live.length}`);

let specs = [];
try {
  specs = await extractSpecs(live);
} catch (e) {
  console.error(`[warn] spec extract failed: ${e.message}`);
}
for (const s of specs) {
  const it = live[s.index];
  if (!it) continue;
  it.shop = s.shop ?? it.host;
  it.title = s.title ?? it.search_title;
  it.price_yen = s.price_yen ?? null;
  it.gpu = s.gpu ?? null;
  it.gpu_vram_gb = s.gpu_vram_gb ?? null;
  it.cpu = s.cpu ?? null;
  it.ram_gb = s.ram_gb ?? null;
  it.storage = s.storage ?? null;
  it.rank = s.rank ?? null;
}
const cleanTitle = (t, fallback) => {
  if (!t || typeof t !== "string" || t.length > 200 || /parseable|JSON (format|array|structure)/i.test(t)) {
    return (fallback || "").slice(0, 120) || t?.slice(0, 120) || null;
  }
  return t.slice(0, 120);
};
for (const it of live) {
  it.shop ??= it.host;
  it.title = cleanTitle(it.title, it.search_title);
  it.price_yen ??= null; it.gpu ??= null; it.gpu_vram_gb ??= null;
  it.cpu ??= null; it.ram_gb ??= null; it.storage ??= null; it.rank ??= null;
}
// 完成品PCらしからぬ候補(GPU単体など)は除外
const looksLikePc = (it) =>
  /PC|デスクトップ|パソコン|GALLERIA|LEVEL|FRGTH|ThinkStation|Precision|DeskPC/i.test(it.title || "") ||
  (it.cpu && it.ram_gb);
const pcs = live.filter(looksLikePc);
const dropped = live.length - pcs.length;
if (dropped) console.log(`[ingest] dropped non-PC entries: ${dropped}`);

/* 価格不明の候補を優先的にページ照合へ回し(ページから価格補完)、残り枠で安い順に検証 */
const nullPrice = pcs.filter((it) => it.price_yen == null).slice(0, Math.ceil(CFG.verify_top_n / 2));
const priced = [...pcs]
  .filter((it) => it.price_yen != null && it.price_yen <= CFG.target.max_price_yen)
  .sort((a, b) => a.price_yen - b.price_yen)
  .slice(0, CFG.verify_top_n - nullPrice.length);
const top = [...nullPrice, ...priced];
console.log(`[ingest] verifying top ${top.length} (価格補完 ${nullPrice.length} 件を含む)`);
await mapPool(top, 3, async (it) => {
  try {
    const v = await verifyOne(it);
    it.factcheck.verdict = v.verdict;
    it.factcheck.issues = v.issues || [];
    it.factcheck.checked_at = now();
    if (v.page_price_yen != null) it.factcheck.page_price_yen = v.page_price_yen;
    if (it.price_yen == null && v.page_price_yen != null) {
      it.price_yen = v.page_price_yen; // ページから価格補完(SPAの<script>内価格候補含む)
      it.factcheck.price_filled_from_page = true;
    }
    if (v.in_stock === false) it.factcheck.verdict = "mismatch";
    console.log(`[ingest] verify ${it.id} -> ${it.factcheck.verdict}${it.factcheck.price_filled_from_page ? " (価格補完)" : ""}`);
  } catch (e) {
    console.error(`[warn] verify failed ${it.id}: ${e.message}`);
  }
});

let prev = null;
try { prev = JSON.parse(await readFile(path.join(ROOT, "data/latest.json"), "utf8")).items; } catch { /* first run */ }

/* 在庫切れは一覧に出さない: HTTP 404 に加え、最終判定(持ち越し含む)が売り切れ系の行も除外(履歴側は維持) */
const isSoldOutContent = (factcheck) =>
  factcheck?.verdict === "mismatch" &&
  (factcheck.issues || []).some((s) => /売り切れ|在庫切れ|販売終了|完売|品切れ|在庫なし|SOLD/i.test(s));
const keep = [...pcs];
const itemsRaw = keep.map((it) => {
  const p = prev?.find((x) => x.id === it.id);
  /* 今回照合していない場合、前回の判定(HTTP 200のまま)を引き継ぐ — 信頼シグセルの毎サイクル消失を防ぐ */
  const factcheck =
    it.factcheck.verdict || it.factcheck.http_status !== 200 || !p?.factcheck?.verdict
      ? it.factcheck
      : { ...p.factcheck };
  return {
  id: it.id, shop: it.shop, title: it.title, url: it.url,
  price_yen: it.price_yen, gpu: it.gpu, gpu_vram_gb: it.gpu_vram_gb,
  cpu: it.cpu, ram_gb: it.ram_gb, storage: it.storage, rank: it.rank,
  updated_at: it.updated_at || started,
  factcheck,
  history: {
    first_seen: prev?.find((p) => p.id === it.id)?.history?.first_seen || started,
    last_seen: started,
    prev_price_yen: prev?.find((p) => p.id === it.id)?.price_yen ?? null,
    badge: diffBadge(prev, it),
  },
};
});
const items = itemsRaw.filter((it) => !isSoldOutContent(it.factcheck));
const soldOutExcluded =
  raw.filter((it) => it.factcheck.http_status === 404).length + (itemsRaw.length - items.length);

const out = {
  generated_at: started,
  source: "perplexity-search+gemini",
  queries: CFG.queries,
  counts: { found: raw.length, live: live.length, kept: items.length, sold_out_excluded: soldOutExcluded, verified: items.filter((i) => i.factcheck.verdict === "verified").length },
  items,
};

await mkdir(path.join(ROOT, "data/history"), { recursive: true });
await writeFile(path.join(ROOT, "data/latest.json"), JSON.stringify(out, null, 2) + "\n");
await writeFile(
  path.join(ROOT, `data/history/${started.replace(/[:.]/g, "-")}.json`),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(`[ingest] done: ${items.length} items -> data/latest.json (badges: ${
  JSON.stringify(items.reduce((m, i) => { m[i.history.badge || "none"] = (m[i.history.badge || "none"] || 0) + 1; return m; }, {}))
})`);
