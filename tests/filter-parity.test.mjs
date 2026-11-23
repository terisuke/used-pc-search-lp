// Worker と ingest のURLフィルタ一致保証(filter parity)
// 両者が独立実装のため、scripts/lib/filters.mjs と worker/src/core.mjs の
// isListingPage が同じ判定を返すことを固定する。

import test from "node:test";
import assert from "node:assert/strict";
import { isListingPage as libFilter, hasProductUrlSignal as libSignal, detectProductMarkers as libDetect } from "../scripts/lib/filters.mjs";
import { isListingPage as workerFilter, hasProductUrlSignal as workerSignal, detectProductMarkers as workerDetect } from "../worker/src/core.mjs";

const CASES = [
  // 事故実例: 技術記事
  "https://pc.watch.impress.co.jp/docs/column/nishikawa/2064084.html",
  // 事故実例: 未知ショップの絞り込み/カテゴリURL
  "https://www.mediator.co.jp/shop/r/r110_sr/?filtercode3=8&filtercode13=1&filtercode101=27",
  // 一覧・カテゴリ
  "https://search.rakuten.co.jp/search/mall/rtx3060/",
  "https://kakaku.com/used/pc/ca=0010/",
  "https://www.dospara.co.jp/BR234?prefn1=txGraphicFilter",
  // 正当な商品ページ
  "https://www.pc-koubou.jp/products/detail.php?product_id=1225988",
  "https://jp.mercari.com/item/m14763685413",
  "https://paypayfleamarket.yahoo.co.jp/item/z726344624",
  "https://item.rakuten.co.jp/e-fellows5/12100134/",
  // 変異系
  "javascript:alert(1)",
  "https://news.mynavi.jp/article/2026-11-1/pc-watch/",
  "https://example.com/products/detail?id=1",
];

const HTMLS = [
  '<script type="application/ld+json">{"@type":"Product"}</script>',
  '<meta property="og:type" content="product">',
  '<script type="application/ld+json">{"@type":"ItemList"}</script><button>カートに入れる</button>',
  "<html><body>ただのページ</body></html>",
];

test("worker と lib のURLフィルタ判定が一致する", () => {
  for (const url of CASES) {
    assert.equal(workerFilter(url), libFilter(url), `parity divergence (isListingPage): ${url}`);
    assert.equal(workerSignal(url), libSignal(url), `parity divergence (hasProductUrlSignal): ${url}`);
  }
});

test("worker と lib の商品マーカー判定が一致する", () => {
  for (const html of HTMLS) {
    assert.equal(workerDetect(html).isProduct, libDetect(html).isProduct, `parity divergence (detectProductMarkers): ${html.slice(0, 40)}`);
  }
});

test("worker と lib の売り切れ判定が一致する", async () => {
  const { SOLD_OUT_RE: workerRe } = await import("../worker/src/core.mjs");
  const { SOLD_OUT_RE: libRe } = await import("../scripts/lib/filters.mjs");
  const samples = ["SOLD OUT", "完売", "在庫あり", "カートに入れる", '{"status":"sold_out"}'];
  for (const s of samples) {
    assert.equal(workerRe.test(s), libRe.test(s), `parity divergence (SOLD_OUT_RE): ${s}`);
  }
});
