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

/* 差分badge: 死リンクをNEW扱いしない(404判定を優先) */
export function diffBadge(prev, item) {
  if (item.factcheck.http_status === 404) return "sold_out";
  const p = prev?.find((x) => x.id === item.id);
  if (!p) return "new";
  if (p.price_yen && item.price_yen && item.price_yen < p.price_yen) return "price_down";
  return null;
}
