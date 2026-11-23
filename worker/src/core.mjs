// Workers非依存のコアロジック(node から直接テスト可能)
// env: PERPLEXITY_API_KEY, GEMINI_API_KEY, GEMINI_MODEL(任意)

const UA = "used-pc-search-lp-worker/0.1 (+https://github.com/terisuke/used-pc-search-lp)";
const BLOCK_HOSTS = [
  "youtube.com", "x.com", "twitter.com", "facebook.com", "instagram.com",
  "wikipedia.org", "note.com", "hatenablog.com", "qiita.com", "zenn.dev",
];

function isListingPage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (h === "search.rakuten.co.jp") return true;
    const p = u.pathname;
    if (/(^|\/)(search|closedsearch)(\/|$)/.test(p)) return true;
    if (/\/view\/category\//.test(p)) return true;
    if (/^\/(BR|SBR)\d+/.test(p)) return true;
    return false;
  } catch {
    return true;
  }
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
    /* SPA等の価格は<script>内JSONにあることがあるため、タグ除去前に価格候補を収集 */
    const priceCandidates = [...raw.matchAll(/[¥￥]?\s?\d{1,3}(?:,\d{3})+|\b\d{4,6}\s?円/gi)]
      .map((m) => m[0].trim())
      .slice(0, 12);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 12_000);
    return { text, priceCandidates };
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

function buildQuery(body) {
  const gpuMap = {
    "rtx3060-12": "RTX 3060 12GB",
    vram12: "VRAM 12GB以上 グラフィックス",
    vram16: "VRAM 16GB以上 グラフィックス",
  };
  const parts = ["中古 デスクトップPC"];
  if (body.gpu && gpuMap[body.gpu]) parts.push(gpuMap[body.gpu]);
  if (body.price) parts.push(`${Math.round(body.price / 10000)}万円以下`);
  if (body.ram) parts.push(`メモリ${body.ram}GB以上`);
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
export async function handleSearch(env, body) {
  try {
    const query = buildQuery(body || {});
    const results = await perplexitySearch(env, query);
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
    const top = candidates.slice(0, 8);
    const statuses = await Promise.all(top.map((it) => httpStatus(it.url)));
    top.forEach((it, i) => { it.factcheck.http_status = statuses[i]; });
    const live = top.filter((it) => it.factcheck.http_status !== 404);
    let specs = [];
    try { specs = await extractSpecs(env, live); } catch (e) { /* 抽出失敗は許容 */ }
    for (const s of specs) {
      const it = live[s.index];
      if (!it) continue;
      it.shop = s.shop ?? it.host;
      it.title = ((s.title ?? it.search_title) || "").slice(0, 120);
      it.price_yen = s.price_yen ?? null;
      it.gpu = s.gpu ?? null;
      it.gpu_vram_gb = s.gpu_vram_gb ?? null;
      it.cpu = s.cpu ?? null;
      it.ram_gb = s.ram_gb ?? null;
      it.storage = s.storage ?? null;
      it.rank = s.rank ?? null;
    }
    for (const it of live) {
      it.shop ??= it.host;
      it.title ??= it.search_title;
      it.price_yen ??= null; it.gpu ??= null; it.gpu_vram_gb ??= null;
      it.cpu ??= null; it.ram_gb ??= null; it.storage ??= null; it.rank ??= null;
    }
    return {
      status: 200,
      body: {
        generated_at: new Date().toISOString(),
        source: "realtime",
        query,
        items: top,
        note: "価格不明の行は『詳細→個別照合』または数分後の定期データで補完されます",
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
    const out = await gemini(
      env,
      "日本の中古PC商品ページ本文から、価格・スペック・販売中かを抽出・判定してください。\n" +
      `ページ本文中の価格表記候補: ${page.priceCandidates.join(" / ") || "(なし)"}\n\nページ本文:\n${page.text}\n\n` +
      "page_price_yen は本文または候補から(税込優先)。売り切れ/販売終了なら sold_out=true。推測禁止。",
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
    } else if (out.note) {
      factcheck.issues = [String(out.note).slice(0, 120)];
    }
    const specs = {};
    if (out.gpu != null) specs.gpu = out.gpu;
    if (out.ram_gb != null) specs.ram_gb = out.ram_gb;
    return { status: 200, body: { url, factcheck, specs } };
  } catch (e) {
    return { status: 502, body: { error: `verify failed: ${String(e.message || e).slice(0, 200)}` } };
  }
}
