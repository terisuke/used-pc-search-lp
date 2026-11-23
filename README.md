# 中古PCサーチ (used-pc-search-lp)

ローカルLLM（Qwen系MoE）の実用運用に向けた中古デスクトップPC候補を、約2時間ごとに
自動取得して比較するLP（ランディングページ）。

## 構成

- **フロント**: 静的サイト（HTML + vanilla JS + [Pico.css v2](https://picocss.com/)）。
  WCAG 2.2 AA を目標に、`aria-sort` ソートテーブル・`aria-live` 状態通知・
  テキスト併記のステータスラベル・24px 以上のターゲットサイズ等を実装。
- **定期取得** (`.github/workflows/ingest.yml`, 2時間ごと): Perplexity **Search API**
  （実URLを返す一次検索・幻覚URLなし）→ HTTP ステータス機械判定（全候補・無料）→
  Gemini API（スニペットからスペック抽出 + 安い順上位N件の実ページ照合）→
  `data/latest.json` + `data/history/*.json` を commit → GitHub Pages へデプロイ。
- **リアルタイム検索**: Cloudflare Worker 経由（Phase 3 で有効化）。

## 検索条件

`config/conditions.json` で変更（クエリ・件数・照合上位件数・目安条件）。

## Secrets (GitHub Actions)

| Secret | 由来 (Bitwarden `bwenv`) |
|---|---|
| `PERPLEXITY_API_KEY` | `env/unspecified/PERPLEXITY_API_KEY` |
| `GEMINI_API_KEY` | `env/common/NFC_GEMINI_API_KEY` |

投入: `bwenv get <変数名> | gh secret set <SECRET名> -R terisuke/used-pc-search-lp`（値は表示しない）

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
