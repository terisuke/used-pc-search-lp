// used-pc-search-lp — リアルタイム検索 Worker (Cloudflare Workers)
// POST /search  : Perplexity Search 一次検索 → 機械HTTP判定 → Gemini スペック抽出
// POST /verify  : 個別URLの機械判定 + Gemini 実ページ照合
// env: PERPLEXITY_API_KEY, GEMINI_API_KEY, ALLOWED_ORIGIN, GEMINI_MODEL(任意)
// core.mjs は Workers API 非依存(node でもテスト可能)。本ファイルは薄いアダプタ。

import { handleSearch, handleVerify } from "./core.mjs";

const ALLOWED_ORIGINS = (env) =>
  (env.ALLOWED_ORIGIN || "https://terisuke.github.io").split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(env, origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS(env).includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

/* 簡易レートリミット( isolate内 best-effort — 個人運用向け ) */
const buckets = new Map();
function rateLimit(ip, key, limit, windowMs) {
  const nowT = Date.now();
  const id = `${ip}:${key}`;
  const b = buckets.get(id) || { count: 0, reset: nowT + windowMs };
  if (nowT > b.reset) {
    b.count = 0;
    b.reset = nowT + windowMs;
  }
  b.count++;
  buckets.set(id, b);
  if (buckets.size > 5000) buckets.clear(); // メモリ保護
  return b.count <= limit;
}

const json = (env, origin, status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, origin) },
  });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }
    if (!corsHeaders(env, origin)["Access-Control-Allow-Origin"]) {
      return json(env, origin, 403, { error: "origin not allowed" });
    }
    if (url.pathname === "/search" && request.method === "POST") {
      if (!rateLimit(ip, "search", 10, 60_000)) return json(env, origin, 429, { error: "rate limit" });
      const body = await request.json().catch(() => ({}));
      const result = await handleSearch(env, body);
      return json(env, origin, result.status, result.body);
    }
    if (url.pathname === "/verify" && request.method === "POST") {
      if (!rateLimit(ip, "verify", 30, 60_000)) return json(env, origin, 429, { error: "rate limit" });
      const body = await request.json().catch(() => ({}));
      const result = await handleVerify(env, body);
      return json(env, origin, result.status, result.body);
    }
    return json(env, origin, 404, { error: "not found" });
  },
};
