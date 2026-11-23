// Workers非依存のコアロジック(node から直接テスト可能)
// env: PERPLEXITY_API_KEY, GEMINI_API_KEY, GEMINI_MODEL(任意)
// URLフィルタの真実源は scripts/lib/filters.mjs(テスト対象)。Workers bundlingを単純化するため
// 同等ロジックをここに保持し、filter-parity テストが両者の一致を保証する。

const UA = "used-pc-search-lp-worker/0.1 (+https://github.com/terisuke/used-pc-search-lp)";
const MEDIA_HOSTS = [
  "impress.co.jp", "itmedia.co.jp", "mynavi.jp", "gigazine.net",
  "publickey.jp", "gihyo.jp", "ascii.jp", "pc.watch.impress.co.jp",
];
const BLOCK_HOSTS = [
  "youtube.com", "x.com", "twitter.com", "facebook.com", "instagram.com",
  "wikipedia.org", "note.com", "hatenablog.com", "qiita.com", "zenn.dev",
  ...MEDIA_HOSTS,
];
const isBlockedHost = (hostname) => {
  const h = String(hostname || "").replace(/^www\./, "");
  return BLOCK_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
};

export function isListingPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return true;
    if (isBlockedHost(u.hostname)) return true;
    const h = u.hostname.replace(/^www\./, "");
    if (h === "search.rakuten.co.jp") return true;
    if (h.endsWith("kakaku.com") && /^\/used\//.test(u.pathname)) return true;
    const p = u.pathname;
    if (/(^|\/)(search|closedsearch)(\/|$)/.test(p)) return true;
    if (/\/view\/category\//.test(p)) return true;
    if (/^\/(BR|SBR)\d+/.test(p)) return true;
    if (/\/docs\/column\//.test(p)) return true;
    if (/(^|\/)article(\/|$)/.test(p)) return true;
    return false;
  } catch {
    return true;
  }
}

export function hasProductUrlSignal(url) {
  try {
    const u = new URL(url);
    const p = u.pathname;
    if (u.hostname === "item.rakuten.co.jp") return true;
    if (/\/item\/[A-Za-z0-9_-]{4,}/.test(p)) return true;
    if (/\/jp\/auction\/[A-Za-z0-9]+/.test(p)) return true;
    if (/detail\.(php|aspx|html?)/i.test(p)) return true;
    if (/\/(products?|goods)\/(?!$)/i.test(p)) return true;
    if (/\/g\/g[A-Za-z0-9]+\/?/.test(p)) return true;
    const keys = [...u.searchParams.keys()];
    if (keys.some((k) => /^(product_id|item_code|itemcode|sku|pid|pr)$/i.test(k))) return true;
    return false;
  } catch {
    return false;
  }
}

export const SOLD_OUT_RE = /SOLD\s*OUT|完売|品切れ|在庫なし|在庫切れ|売り切れ|販売終了|取り扱い(を)?終了|再入荷(待ち|予定)/i;

/* 売り切れの機械判定: 可視テキスト / availability=OutOfStock / "status":"sold_out" のみ
   (JSバンドル内の定数文字列への誤反応を避ける) */
export function detectSoldOutFromHtml(rawHtml) {
  const raw = String(rawHtml || "").slice(0, 400_000);
  const visibleText = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  if (SOLD_OUT_RE.test(visibleText)) return true;
  if (/"availability"\s*:\s*"[^"]*OutOfStock/i.test(raw)) return true;
  if (/"status"\s*:\s*"sold_out"/i.test(raw)) return true;
  return false;
}

export function detectProductMarkers(rawHtml) {
  const s = String(rawHtml || "").slice(0, 400_000);
  const reasons = [];
  if (/"@type"\s*:\s*"?(Product|ProductModel)"?/i.test(s)) reasons.push("jsonld-product");
  if (/"@type"\s*:\s*"?(ItemList|CollectionPage)"?/i.test(s)) reasons.push("jsonld-itemlist");
  if (/property=["']og:type["'][^>]*content=["']product["']/i.test(s) ||
      /content=["']product["'][^>]*property=["']og:type["']/i.test(s)) reasons.push("og-product");
  if (/カートに入れる|カートに追加|買い物かごに入れる|購入する/.test(s)) reasons.push("cart-cta");
  const isProduct =
    reasons.includes("og-product") ||
    (reasons.includes("jsonld-product") && !reasons.includes("jsonld-itemlist"));
  return { isProduct, reasons };
}

async function perplexitySearch(env, query) {
  const res = await fetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: 10 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`perplexity ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function httpStatus(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: { "User-Agent": UA, "Accept-Language": "ja" },
        signal: AbortSignal.timeout(10_000),
      });
      if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue;
      return res.status;
    } catch {
      if (method === "GET") return null;
    }
  }
  return null;
}

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer().then((b) => b.slice(0, 300_000));
    let raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if ((raw.match(/\uFFFD/g) || []).length > 40) {
      try { raw = new TextDecoder("shift_jis", { fatal: false }).decode(buf); } catch { /* keep */ }
    }
    const soldOut = detectSoldOutFromHtml(raw);
    /* SPA等の価格は<script>内JSONにあることがあるため、タグ除去前に価格候補を収集 */
    const priceCandidates = [
      ...new Set([
        ...[...raw.matchAll(/[¥￥]?\s?\d{1,3}(?:,\d{3})+|\b\d{4,6}\s?円/gi)].map((m) => m[0].trim()),
        ...[...raw.matchAll(/["']?(?:price|selling_?price|item_?price|amount)["']?\s*[:=]\s*"?[¥￥]?(\d{4,7})\b/gi)]
          .map((m) => Number(m[1]).toLocaleString("en-US")),
      ]),
    ].slice(0, 12);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 12_000);
    return { text, priceCandidates, soldOut };
  } catch {
    return null;
  }
}

async function gemini(env, prompt, schema) {
  const model = env.GEMINI_MODEL || "gemini-4-hydrogen";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  const t = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return JSON.parse(t);
}

const ITEM_SCHEMA = {
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

export function buildQuery(body) {
  const gpuMap = {
    "rtx3060-12": "RTX 3060 12GB",
    vram12: "VRAM 12GB以上 グラフィックス",
    vram16: "VRAM 16GB以上 グラフィックス",
  };
  const parts = ["中古 デスクトップPC"];
  if (body.gpu && gpuMap[body.gpu]) parts.push(gpuMap[body.gpu]);
  if (body.ram) parts.push(`メモリ${body.ram}GB以上`);
  if (body.price) parts.push(`${Math.round(body.price / 10000)}万円以下`);
  if (body.free) parts.push(String(body.free).slice(0, 80));
  parts.push("中古");
  return parts.join(" ");
}

async function extractSpecs(env, items) {
  if (!items.length) return [];
  const list = items
    .map((it, i) => `index=${i}\nhost=${it.host}\n題名: ${it.search_title}\nスニペット: ${it.snippet}`)
    .join("\n\n");
  const rows = await gemini(
    env,
    "以下は日本の中古デスクトップPC商品ページの検索結果です。各項目のスペックを抽出してください。" +
    "推測禁止、不明はnull。スニペット中の 価格表記(円/¥/税込) を見逃さないこと。日本語で。indexは各行に明記された値。\n\n" + list,
    ITEM_SCHEMA,
  );
  return Array.isArray(rows) ? rows : [];
}

/* ---------- POST /search ---------- */
export function buildMarketQuery(body) {
  const parts = ["中古 デスクトップPC"];
  if (body.ram) parts.push(`メモリ${body.ram}GB`);
  parts.push("メルカリ ヤフオク フリマ");
  return parts.join(" ");
}

export async function handleSearch(env, body) {
  try {
    const query = buildQuery(body || {});
    const queries = [...new Set([query, buildMarketQuery(body || {})])];
    const resultSets = await Promise.all(queries.map((q) => perplexitySearch(env, q).catch(() => [])));
    const results = resultSets.flat();
    const seen = new Set();
    const candidates = [];
    for (const r of results) {
      let host = "";
      try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (!r.url || seen.has(r.url)) continue;
      if (BLOCK_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) continue;
      if (isListingPage(r.url)) continue;
      seen.add(r.url);
      candidates.push({
        id: String(candidates.length),
        url: r.url,
        host,
        search_title: r.title || "",
        snippet: (r.snippet || "").slice(0, 1000),
        factcheck: { http_status: null, verdict: null, checked_at: null, issues: [] },
      });
    }
    const top0 = candidates.slice(0, 10);
    /* 商品ページ確認+売り切れ機械判定を1フェッチで同時に実施(売り切れは最初から返さない) */
    const checks = await Promise.all(top0.map(async (it) => {
      const signal = hasProductUrlSignal(it.url);
      try {
        const res = await fetch(it.url, {
          headers: { "User-Agent": UA, "Accept-Language": "ja" },
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { keep: signal && res.status !== 404, soldOut: false };
        const buf = await res.arrayBuffer().then((b) => b.slice(0, 250_000));
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
        const soldOut = detectSoldOutFromHtml(raw);
        const isProduct = detectProductMarkers(raw).isProduct;
        return { keep: !soldOut && (signal || isProduct), soldOut };
      } catch {
        return { keep: signal, soldOut: false }; // 取得失敗時はURLシグナルのみで判断
      }
    }));
    const top = top0.filter((_, i) => checks[i].keep).slice(0, 10);
    const soldOutAtSearch = checks.filter((c) => c.soldOut).length;
    const statuses = await Promise.all(top.map((it) => httpStatus(it.url)));
    top.forEach((it, i) => { it.factcheck.http_status = statuses[i]; });
    const live = top.filter((it) => it.factcheck.http_status !== 404);
    for (const it of live) {
      it.shop = it.host;
      it.title = it.search_title.slice(0, 120);
      it.price_yen = null; it.gpu = null; it.gpu_vram_gb = null;
      it.cpu = null; it.ram_gb = null; it.storage = null; it.rank = null;
    }
    /* 一次検索は即返し(要件: 30秒目標)。スペック抽出・照合はクライアントから /verify で遅延実行 */
    return {
      status: 200,
      body: {
        generated_at: new Date().toISOString(),
        source: "realtime",
        query,
        items: live,
        soldOutExcluded: soldOutAtSearch,
        note: "売り切れ(SOLD OUT/完売等)・404は除外して返します。価格・スペックは行ごとの照合(/verify)または次回の定期取得で補完されます",
      },
    };
  } catch (e) {
    return { status: 502, body: { error: `search failed: ${String(e.message || e).slice(0, 200)}` } };
  }
}

/* ---------- POST /verify ---------- */
export async function handleVerify(env, body) {
  const url = String(body?.url || "");
  if (!/^https?:\/\//.test(url)) return { status: 400, body: { error: "invalid url" } };
  try {
    const status = await httpStatus(url);
    const factcheck = { http_status: status, verdict: null, checked_at: new Date().toISOString(), issues: [] };
    if (status === 404 || status === null) {
      factcheck.verdict = status === 404 ? "mismatch" : null;
      if (status === 404) factcheck.issues = ["リンク切れ(404)"];
      return { status: 200, body: { url, factcheck } };
    }
    const page = await fetchPageText(url);
    if (!page) {
      factcheck.issues = ["ページ本文取得失敗"];
      return { status: 200, body: { url, factcheck } };
    }
    /* 機械判定: SOLD OUT等の表記はモデルに委ねず即・売り切れ扱い(コードで決定) */
    if (page.soldOut) {
      factcheck.verdict = "mismatch";
      factcheck.issues = ["売り切れ表示(SOLD OUT/完売等)"];
      return { status: 200, body: { url, factcheck } };
    }
    const out = await gemini(
      env,
      "日本の中古PC商品ページ本文から、価格・スペック・販売中かを抽出・判定してください。\n" +
      `ページ本文中の価格表記候補: ${page.priceCandidates.join(" / ") || "(なし)"}\n\nページ本文:\n${page.text}\n\n` +
      "page_price_yen は本文または候補から(税込優先)。売り切れ/販売終了なら sold_out=true。推測禁止。\n" +
      "重要: この照合は『候補がnull(未取得)』の項目が多くあります。候補がnullの項目は不一致とせず、情報不足として扱ってください(noteに「未取得」と記載)。",
      {
        type: "OBJECT",
        properties: {
          page_price_yen: { type: "INTEGER", nullable: true },
          sold_out: { type: "BOOLEAN", nullable: true },
          gpu: { type: "STRING", nullable: true },
          ram_gb: { type: "INTEGER", nullable: true },
          note: { type: "STRING", nullable: true },
        },
        required: [],
      },
    );
    if (out.page_price_yen != null) factcheck.page_price_yen = out.page_price_yen;
    if (out.sold_out === true) {
      factcheck.verdict = "mismatch";
      factcheck.issues = ["売り切れ表示"];
    } else {
      /* 照合は成功したが完全比較ではない → partial(未照合のままにしない) */
      factcheck.verdict = "partial";
      factcheck.issues = [out.note ? String(out.note).slice(0, 120) : "ページから価格・スペックの一部のみ取得(未取得項目あり)"];
    }
    const specs = {};
    if (out.gpu != null) specs.gpu = out.gpu;
    if (out.ram_gb != null) specs.ram_gb = out.ram_gb;
    return { status: 200, body: { url, factcheck, specs } };
  } catch (e) {
    return { status: 502, body: { error: `verify failed: ${String(e.message || e).slice(0, 200)}` } };
  }
}
