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

## モデル

| 用役 | モデル | 備考 |
|---|---|---|
| 一次検索 | Perplexity Search API | モデル無し・実URL・リクエスト課金 |
| スペック抽出/照合 | `gemini-4-hydrogen` (Gemini 4 Flash級) | `GEMINI_MODEL` で上書き可 |
| 週次スペック見直し | `gemini-4-hydrogen` + Perplexity Search | 提案はIssue起票し人間レビュー |

## リアルタイム検索 (Cloudflare Worker)

`worker/` に実装済み(Waiting: Cloudflare認証のみ)。

```sh
cd worker
bunx wrangler login                      # 人力ゲート(初回のみ)
bunx wrangler deploy
bwenv get PERPLEXITY_API_KEY | wrangler secret put PERPLEXITY_API_KEY
bwenv get NFC_GEMINI_API_KEY  | wrangler secret put GEMINI_API_KEY
# data/worker-config.json の worker_url に https://used-pc-search-worker.<account>.workers.dev を設定して commit
```

- `POST /search`: Perplexity一次検索→機械HTTP判定→Gemini抽出(CORS=Pages origin限定, 10req/min/IP)
- `POST /verify`: 個別URLの機械判定+実ページ照合(価格候補は `<script>` 内JSONからも収集)
- ローカルE2E: `PERPLEXITY_API_KEY=… GEMINI_API_KEY=… node worker/test/local-e2e.mjs`

## 週次スペック見直し (`.github/workflows/spec-review.yml`)

毎週月曜 01:00 JST に最新のローカルLLM運用要件(VRAM/RAM/エンジン進化: llama.cpp MoEオフロード,
Strata等)をPerplexityで収集し、Geminiが `config/target-spec.json` 相当の提案を合成。
`data/spec-review-latest.{json,md}` を更新し、現行と差分があればGitHub Issueを起票(人間が確認して
`config/target-spec.json` と `config/conditions.json` に反映)。LP上部の「ターゲットスペック」ボックスは
この結果を表示する。

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
npm test   # 自動テスト(node:test・依存追加なし)
```

## 自動テスト (P4, `tests/`)

`node --test`。実データで起きた事故を回帰テストとして固定:
技術記事(pc.watch.impress等)・一覧/カテゴリページ(rakuten検索/dospara BR/kakaku used)の除外、
正当な商品ページの通過、canonUrl(トラッキング除去・プロトコル検証)、価格候補抽出(本文+`<script>`内JSON)、
死リンクbadge優先、worker/libフィルタ一致(parity)。CI: `.github/workflows/test.yml`(push/PR)。

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
