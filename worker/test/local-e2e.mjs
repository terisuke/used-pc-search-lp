// ローカルE2E: Workers非依存のcore.mjsを本物のAPIキーで実行する(値は表示しない)
// 実行: PERPLEXITY_API_KEY=... GEMINI_API_KEY=... node test/local-e2e.mjs
import { handleSearch, handleVerify } from "../src/core.mjs";

const env = {
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-4-hydrogen",
};
if (!env.PERPLEXITY_API_KEY || !env.GEMINI_API_KEY) {
  console.error("PERPLEXITY_API_KEY / GEMINI_API_KEY が必要です");
  process.exit(1);
}

console.log("[test] /search 開始…");
const t0 = Date.now();
const search = await handleSearch(env, { gpu: "rtx3060-12", price: 110000, ram: 16 });
console.log(`[test] /search -> HTTP ${search.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (search.status !== 200) {
  console.error(JSON.stringify(search.body));
  process.exit(1);
}
console.log(`[test] query: ${search.body.query}`);
console.log(`[test] items: ${search.body.items.length}`);
for (const it of search.body.items) {
  console.log(`  - ${it.title?.slice(0, 40)} | ${it.price_yen ?? "価格不明"} | ${it.gpu ?? "?"} | http=${it.factcheck.http_status}`);
}

const priced = search.body.items.find((i) => i.price_yen && i.factcheck.http_status === 200)
  || search.body.items.find((i) => i.factcheck.http_status === 200);
if (priced) {
  console.log(`[test] /verify 開始: ${priced.url}`);
  const t1 = Date.now();
  const verify = await handleVerify(env, { url: priced.url });
  console.log(`[test] /verify -> HTTP ${verify.status} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log(JSON.stringify(verify.body, null, 2).slice(0, 800));
  if (verify.status !== 200) process.exit(1);
} else {
  console.log("[test] 検証可能なURLなし — スキップ");
}
console.log("[test] OK");
