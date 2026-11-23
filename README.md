# 中古PCサーチ (used-pc-search-lp)

ローカルLLM（Qwen系MoE）の実用運用に向けた中古デスクトップPC候補を、約2時間ごとに
自動取得して比較するLP（ランディングページ）。

## 構成

- **フロント**: 静的サイト（HTML + vanilla JS + [Pico.css v2](https://picocss.com/)）。
  WCAG 2.2 AA を目標に、`aria-sort` ソートテーブル・`aria-live` 状態通知・
  テキスト併記のステータスラベル・24px 以上のターゲットサイズ等を実装。
- **定期取得**: GitHub Actions（cron 2時間ごと）→ Perplexity API で一次検索 →
  HTTP ステータスによる機械チェック（全候補）→ Gemini API で内容照合（上位3〜5件）→
  `data/latest.json` を commit → GitHub Pages へデプロイ。
- **リアルタイム検索**: Cloudflare Worker 経由（Phase 3 で有効化）。

## 開発

```sh
npm install
cp node_modules/@picocss/pico/css/pico.min.css assets/css/pico.min.css
```

`assets/css/pico.min.css` は上記で vendoring したものを commit している
（バージョンは package.json / package-lock.json を参照）。

## データスキーマ (`data/latest.json`)

| フィールド | 説明 |
|---|---|
| `generated_at` | 取得時刻 (ISO 8601) |
| `items[].factcheck.http_status` | 機械チェックした HTTP ステータス |
| `items[].factcheck.verdict` | `verified` / `partial` / `mismatch` / `null` |
| `items[].history.badge` | `new` / `price_down` / `sold_out` / `null` |

## ライセンス

アプリケーションコードはリポジトリ所有者に帰属。Pico.css は MIT License。
