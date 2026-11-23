// 純粋フィルタ関数群 — ingest とテストの単一の真実源(依存なし)
// 「商品ページらしからぬURL」の判定: 検索一覧・カテゴリ・ニュース/技術記事

const MEDIA_HOSTS = [
  "impress.co.jp", "itmedia.co.jp", "mynavi.jp", "gigazine.net",
  "publickey.jp", "gihyo.jp", "ascii.jp", "pc.watch.impress.co.jp",
];

const BLOCK_HOSTS = [
  "youtube.com", "x.com", "twitter.com", "facebook.com", "instagram.com",
  "wikipedia.org", "note.com", "hatenablog.com", "qiita.com", "zenn.dev",
  ...MEDIA_HOSTS,
  /* SPAで在庫/価格がクライアント描画のみ → サーバ側で売り切れ検証不能のため自動結果から除外 */
  "mercari.com", "jp.mercari.com",
];

export const isBlockedHost = (hostname) => {
  const h = String(hostname || "").replace(/^www\./, "");
  return BLOCK_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
};

export function isListingPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return true;
    if (isBlockedHost(u.hostname)) return true; // ニュース/技術記事/SNS等
    const h = u.hostname.replace(/^www\./, "");
    if (h === "search.rakuten.co.jp") return true;
    if (h === "item.rakuten.co.jp" && /(^|\/)c(\/|$)/.test(u.pathname)) return true; // 楽天のカテゴリ(/c/)
    if (h.endsWith("kakaku.com") && /^\/used\//.test(u.pathname)) return true;
    const p = u.pathname;
    if (/(^|\/)(search|closedsearch)(\/|$)/.test(p)) return true;
    if (/\/view\/category\//.test(p)) return true;
    if (/^\/(BR|SBR)\d+/.test(p)) return true; // ドスパラ一覧
    if (/\/docs\/column\//.test(p)) return true; // コラム記事
    if (/(^|\/)article(\/|$)/.test(p)) return true; // 記事系パス
    return false;
  } catch {
    return true;
  }
}

/* URL正規化: http/httpsのみ許可 + トラッキング系クエリ除去 → 同一商品の重複ID/NEW誤爆を防ぐ */
export function canonUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => !/^(utm_|ref$|affid|asclid|scid$|s$)/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    u.search = new URLSearchParams(keep).toString();
    return u.toString();
  } catch {
    return null;
  }
}

/* SPA等の<script>内JSONにも価格がある → タグ除去前の生HTMLから価格表記候補を収集
   本文表記(¥12,345 / 12,345円 / 12345円)に加え、price系キーに紐づくJSON数値("price":104980)も
   カンマ区切りに正規化して収集する */
export function extractPriceCandidates(rawHtml, limit = 12) {
  const s = String(rawHtml || "");
  const out = [];
  const push = (v) => {
    if (v) out.push(String(v).trim());
  };
  for (const m of s.matchAll(/[¥￥]?\s?\d{1,3}(?:,\d{3})+|\b\d{4,6}\s?円/gi)) push(m[0]);
  for (const m of s.matchAll(/["']?(?:price|selling_?price|item_?price|amount)["']?\s*[:=]\s*"?[¥￥]?(\d{4,7})\b/gi)) {
    push(Number(m[1]).toLocaleString("en-US"));
  }
  return [...new Set(out)].slice(0, limit);
}

/* 商品個別ページのURL構造的シグナル(ポジティブ判定)。
   deny-listは未知ショップに漏れるため、原則「商品URL形状を持つか、本文に商品マーカーがあるか」で残す */
export function hasProductUrlSignal(url) {
  try {
    const u = new URL(url);
    const p = u.pathname;
    if (u.hostname === "item.rakuten.co.jp") return !/(^|\/)c(\/|$)/.test(p); // /c/ はカテゴリ
    if (/\/item\/[A-Za-z0-9_-]{4,}/.test(p)) return true;            // mercari / paypayフリマ / 等
    if (/\/jp\/auction\/[A-Za-z0-9]+/.test(p)) return true;   // Yahooオークション(u123...形式含む)
    if (/detail\.(php|aspx|html?)/i.test(p)) return true;             // EC-CUBE / .aspx 系商品詳細
    if (/\/(products?|goods)\/(?!$)/i.test(p)) return true;           // /products/... /goods/...
    if (/\/g\/g[A-Za-z0-9]+\/?/.test(p)) return true;                 // rakuten系 /g/gXXXX/
    const keys = [...u.searchParams.keys()];
    if (keys.some((k) => /^(product_id|item_code|itemcode|sku|pid|pr)$/i.test(k))) return true;
    return false;
  } catch {
    return false;
  }
}

/* 売り切れの機械判定。JSバンドル/i18n辞書の定数文字列への誤反応を避けるため、
   1) 可視テキスト中の売り切れ表記が2回以上(商品ページのバナー+注記等)
   2) 可視テキスト中で「この商品/当商品/本商品」直後の売り切れ表記(1回でも)
   3) schema.org availability=OutOfStock
   4) 明示的な "status":"sold_out" キー値
   のみを対象にする。 */
const SOLD_OUT_TEXT_RE = /SOLD\s*OUT|完売|品切れ|在庫なし|在庫切れ|売り切れ|販売終了|取り扱い(を)?終了|再入荷(待ち|予定)/i;
export const SOLD_OUT_RE = SOLD_OUT_TEXT_RE; // 可視テキスト用(regex単体テスト・parity用)
export function detectSoldOutFromHtml(rawHtml) {
  const raw = String(rawHtml || "").slice(0, 400_000);
  const visibleText = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  /* 本文上部(メイン商品領域)のみを見る — おすすめ欄等の他商品の売り切れラベル誤検知を避ける */
  const mainRegion = visibleText.slice(0, 4000);
  const hits = [...mainRegion.matchAll(new RegExp(SOLD_OUT_TEXT_RE.source, "gi"))].length;
  if (hits >= 2) return true;
  if (hits === 1 && /(この商品|当商品|本商品)[^。]{0,40}(売り切れ|在庫切れ|完売|品切れ|SOLD)/i.test(mainRegion)) return true;
  if (/"availability"\s*:\s*"[^"]*OutOfStock/i.test(raw)) return true;
  if (/"status"\s*:\s*"sold_out"/i.test(raw)) return true;
  return false;
}

/* 本文からの商品マーカー判定(JSON-LD Product / og:type=product)。
   カートボタンは一覧グリッドにも出るため単独では採用しない(誤検知防止)。
   一覧カテゴリはJSON-LD ItemListを持つため、Product+ItemList併存は一覧とみなす。 */
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

/* 「強」商品URLシグナル: 形状だけで商品個別ページと断定できるもの(本文マーカー不要)。
   それ以外(/products/等)は本文マーカー必須 — 一覧ページ誤入を防ぐ */
export function hasStrongProductUrlSignal(url) {
  try {
    const u = new URL(url);
    const p = u.pathname;
    if (u.hostname === "item.rakuten.co.jp") return !/(^|\/)c(\/|$)/.test(p);
    if (/\/jp\/auction\/[A-Za-z0-9]+/.test(p)) return true; // Yahooオークション
    if (/\/item\/[A-Za-z0-9_-]{4,}/.test(p)) return true;   // paypayフリマ等
    return false;
  } catch {
    return false;
  }
}

/* 差分badge: 死リンクをNEW扱いしない(404判定を優先) */
export function diffBadge(prev, item) {
  if (item.factcheck.http_status === 404) return "sold_out";
  const p = prev?.find((x) => x.id === item.id);
  if (!p) return "new";
  if (p.price_yen && item.price_yen && item.price_yen < p.price_yen) return "price_down";
  return null;
}
