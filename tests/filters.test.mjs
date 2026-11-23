// P4 自動テストスイート(node:test — 依存なし)
// 実行: npm test
// 対象: URLフィルタ(一覧/記事弾き)・URL正規化・価格候補抽出・差分badge
//   ※ ここで守るのは「実データで起きた事故」:
//     - 技術記事(pc.watch.impress.co.jp のコラム)が候補に入った
//     - 検索一覧ページ(rakuten/dospara/kakaku)が候補に入った
//     - 死リンクが NEW badge を受けた
//     - SPAの<script>内価格が抽出されなかった

import test from "node:test";
import assert from "node:assert/strict";
import {
  isListingPage, canonUrl, extractPriceCandidates, diffBadge,
  hasProductUrlSignal, detectProductMarkers, detectSoldOutFromHtml,
} from "../scripts/lib/filters.mjs";

test("技術記事・ニュースサイトは候補から除外される", () => {
  // 実際に混入した事故URL
  assert.equal(isListingPage("https://pc.watch.impress.co.jp/docs/column/nishikawa/2064084.html"), true);
  assert.equal(isListingPage("https://pc.watch.impress.co.jp/docs/news/1511.html"), true);
  assert.equal(isListingPage("https://news.mynavi.jp/article/2026-11-1/pc-watch/"), true);
  assert.equal(isListingPage("https://www.itmedia.co.jp/pcuser/articles/2611/20/news001.html"), true);
  assert.equal(isListingPage("https://gigazine.net/news/20261123-rtx3060/"), true);
  assert.equal(isListingPage("https://www.publickey.jp/2611/llm.html"), true);
  assert.equal(isListingPage("https://gihyo.jp/article/2026/11/local-llm"), true);
});

test("検索一覧・カテゴリページは候補から除外される", () => {
  assert.equal(isListingPage("https://search.rakuten.co.jp/search/mall/rtx3060+%E4%B8%AD%E5%8F%A4/211368/"), true);
  assert.equal(isListingPage("https://www.dospara.co.jp/BR234?prefn1=txGraphicFilter"), true);
  assert.equal(isListingPage("https://www.dospara.co.jp/SBR1514?prefn1=txGraphicFilter"), true);
  assert.equal(isListingPage("https://kakaku.com/used/pc/ca=0010/"), true);
  assert.equal(isListingPage("https://auctions.yahoo.co.jp/closedsearch/closedsearch/RTX+3060/0"), true);
  assert.equal(isListingPage("https://www.pckujira.jp/view/category/rtx3060"), true);
});

test("正当な商品ページは通過する", () => {
  assert.equal(isListingPage("https://www.pc-koubou.jp/products/detail.php?product_id=1225988"), false);
  assert.equal(isListingPage("https://jp.mercari.com/item/m14763685413"), false);
  assert.equal(isListingPage("https://paypayfleamarket.yahoo.co.jp/item/z726344624"), false);
  assert.equal(isListingPage("https://item.rakuten.co.jp/e-fellows5/12100134/"), false);
  assert.equal(isListingPage("https://www.dospara.co.jp/5shopping/detail.php/pr=191123/"), false);
});

test("非http(s)・不正URLは除外される", () => {
  assert.equal(isListingPage("javascript:alert(1)"), true);
  assert.equal(isListingPage("ftp://example.com/pc"), true);
  assert.equal(isListingPage("not a url"), true);
});

test("canonUrl: トラッキング除去とプロトコル検証", () => {
  assert.equal(canonUrl("javascript:alert(1)"), null);
  assert.equal(canonUrl("https://example.com/p?utm_source=x&id=9"), "https://example.com/p?id=9");
  assert.equal(canonUrl("https://example.com/p?b=2&a=1"), "https://example.com/p?a=1&b=2");
  const canon = canonUrl("https://example.com/p?utm_campaign=news&id=42");
  assert.ok(canon.includes("id=42") && !canon.includes("utm"));
});

test("extractPriceCandidates: script内JSON・本文から価格候補を収集", () => {
  const html = [
    '<script>window.__DATA__={"price":104980,"tax":"incl"}</script>',
    "<main>この商品は 89,000円(税込) です</main>",
    '<script>var p = "69800円";</script>',
    "<div>定価 1,200,000円</div>",
  ].join("\n");
  const cands = extractPriceCandidates(html);
  assert.ok(cands.some((c) => c.includes("104,980")), `104,980 missing in ${JSON.stringify(cands)}`);
  assert.ok(cands.some((c) => c.includes("89,000")));
  assert.ok(cands.some((c) => c.includes("69,800") || c.includes("69800")), `69800 missing in ${JSON.stringify(cands)}`);
  assert.ok(cands.length <= 12);
});

test("buildQuery: GPU/RAM/価格/自由条件がクエリに反映される", async () => {
  const { buildQuery, buildMarketQuery } = await import("../worker/src/core.mjs");
  const q = buildQuery({ gpu: "rtx3060-12", ram: 32, price: 110000, free: "SSD 1TB" });
  assert.ok(q.includes("RTX 3060 12GB"));
  assert.ok(q.includes("メモリ32GB以上"));
  assert.ok(q.includes("11万円以下"));
  assert.ok(q.includes("SSD 1TB"));
  const bare = buildQuery({});
  assert.ok(!bare.includes("メモリ"));
  /* 市場系クエリ: 定期取得と同じソース(メルカリ/ヤフオク/フリマ)を拾う */
  const market = buildMarketQuery({ ram: 16 });
  assert.ok(market.includes("メルカリ") && market.includes("ヤフオク") && market.includes("フリマ"));
  assert.ok(market.includes("メモリ16GB"));
});

test("楽天のカテゴリページ(/c/)は商品として扱わない(実事故)", () => {
  const url = "https://item.rakuten.co.jp/pasonette/c/0000000141/";
  assert.equal(isListingPage(url), true);
  assert.equal(hasProductUrlSignal(url), false);
  // 商品ページは従来どおり通る
  assert.equal(hasProductUrlSignal("https://item.rakuten.co.jp/e-fellows5/12100134/"), true);
  assert.equal(isListingPage("https://item.rakuten.co.jp/e-fellows5/12100134/"), false);
});

test("diffBadge: 死リンクはNEWにならずsold_out優先", () => {
  const prev = [{ id: "x", price_yen: 90000 }];
  assert.equal(diffBadge(prev, { id: "x", factcheck: { http_status: 404 } }), "sold_out");
  assert.equal(diffBadge(null, { id: "y", factcheck: { http_status: 404 } }), "sold_out"); // 新規死リンクもNEWにしない
  assert.equal(diffBadge(null, { id: "y", factcheck: { http_status: 200 } }), "new");
  assert.equal(diffBadge(prev, { id: "x", price_yen: 80000, factcheck: { http_status: 200 } }), "price_down");
  assert.equal(diffBadge(prev, { id: "x", price_yen: 95000, factcheck: { http_status: 200 } }), null);
});

test("未知ショップの絞り込み/カテゴリURLは商品シグナルを持たない(実事故: mediator)", () => {
  const url = "https://www.mediator.co.jp/shop/r/r110_sr/?filtercode3=8&filtercode13=1&filtercode101=27";
  assert.equal(isListingPage(url), false); // deny-list は素通りする(既知の事故の再現)
  assert.equal(hasProductUrlSignal(url), false); // だからポジティブ判定で落とす
});

test("既知の商品URL形状はポジティブ判定を通る", () => {
  assert.equal(hasProductUrlSignal("https://jp.mercari.com/item/m14763685413"), true);
  assert.equal(hasProductUrlSignal("https://paypayfleamarket.yahoo.co.jp/item/z726344624"), true);
  assert.equal(hasProductUrlSignal("https://www.pc-koubou.jp/products/detail.php?product_id=1225988"), true);
  assert.equal(hasProductUrlSignal("https://item.rakuten.co.jp/e-fellows5/12100134/"), true);
  assert.equal(hasProductUrlSignal("https://page.auctions.yahoo.co.jp/jp/auction/u123456789"), true);
  assert.equal(hasProductUrlSignal("https://example.com/shop/g/gAB12345/"), true);
  assert.equal(hasProductUrlSignal("https://example.co.jp/products/detail/12345"), true);
});

test("本文スニフ: JSON-LD Product / og:type=product で商品ページと判定", () => {
  assert.equal(detectProductMarkers('<script type="application/ld+json">{"@type":"Product","name":"RTX3060 PC"}</script>').isProduct, true);
  assert.equal(detectProductMarkers('<meta property="og:type" content="product">').isProduct, true);
  assert.equal(detectProductMarkers('<meta content="product" property="og:type">').isProduct, true);
  // 一覧グリッド(カートボタンだけ・ItemList)は商品ページとしない
  const listing = '<script type="application/ld+json">{"@type":"ItemList"}</script><button>カートに入れる</button>';
  const r = detectProductMarkers(listing);
  assert.equal(r.isProduct, false);
  assert.ok(r.reasons.includes("cart-cta"));
  assert.equal(detectProductMarkers("<html><body>ただの記事</body></html>").isProduct, false);
  // カテゴリページ(Product+ItemList併存)も商品ページとしない(jawa.gg の実事故型)
  const category = '<script type="application/ld+json">{"@type":"ItemList"}</script><script type="application/ld+json">{"@type":"Product"}</script>';
  assert.equal(detectProductMarkers(category).isProduct, false);
});

test("売り切れの機械判定: 一目で分かるSOLD OUT表記をモデルに委ねない", () => {
  assert.equal(detectSoldOutFromHtml('<div class="soldout">SOLD OUT</div><div>SOLD OUT</div>'), true);
  assert.equal(detectSoldOutFromHtml("この商品は完売しました"), true);
  assert.equal(detectSoldOutFromHtml("品切れ・再入荷待ち"), true);
  assert.equal(detectSoldOutFromHtml('window.__DATA__={"status":"sold_out"}'), true);
  assert.equal(detectSoldOutFromHtml('{"availability":"https://schema.org/OutOfStock"}'), true);
  assert.equal(detectSoldOutFromHtml("在庫あり 今すぐ購入"), false);
  assert.equal(detectSoldOutFromHtml("カートに入れる"), false);
  /* 単発の在庫なし(注記・他商品ラベル等)は確定にしない */
  assert.equal(detectSoldOutFromHtml("<p>一部商品は在庫なし</p>"), false);
  /* JSバンドル内の定数文字列(enum配列)への誤反応をしない */
  assert.equal(detectSoldOutFromHtml('<script>var e=["sold_out","on_sale"];var tpl="在庫切れ";</script>'), false);
});
