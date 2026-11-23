#!/usr/bin/env node
// used-pc-search-lp — 週次スペック見直し
// Perplexity Search で最新のローカルLLM運用要件情報を収集 → Gemini 4 Hydrogen で
// ターゲットスペックの提案を合成 → 現行 config/target-spec.json と比較 →
// data/spec-review-latest.{json,md} を更新。変更提案がある場合はGitHub Issueを起票(人間レビュー)。
// env: PERPLEXITY_API_KEY, GEMINI_API_KEY, GITHUB_TOKEN(任意: Issue起票用), GEMINI_MODEL(任意)

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ROOT = new URL("..", import.meta.url).pathname;
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const REPO = process.env.GITHUB_REPOSITORY || "terisuke/used-pc-search-lp";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";

if (!PERPLEXITY_KEY || !GEMINI_KEY) {
  console.error("PERPLEXITY_API_KEY / GEMINI_API_KEY が必要です");
  process.exit(1);
}

const QUERIES = [
  "local LLM VRAM requirements guide 2026 Q4",
  "Qwen3.8 Flash Next local requirements RAM llama.cpp",
  "Strata local inference engine RAM requirements",
  "llama.cpp release notes MoE expert offload",
];

const now = () => new Date().toISOString();
const today = now().slice(0, 10);

async function search(q) {
  const res = await fetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, max_results: 5 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.snippet || "").slice(0, 700), last_updated: r.last_updated || null }));
}

async function geminiJson(text, schema) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema },
      }),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const t = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return JSON.parse(t);
}

const Proposed = z.object({
  reviewed_at: z.string(),
  engine_basis: z.string(),
  profiles: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    min_vram_gb: z.number(),
    preferred_vram_gb: z.number(),
    min_ram_gb: z.number(),
    min_cpu_cores: z.number(),
    storage: z.string(),
    target_models: z.string(),
  })).min(1),
  search_target: z.object({
    gpu_priority: z.string(),
    min_vram_gb: z.number(),
    preferred_vram_gb: z.number(),
    ram_tiers_gb: z.array(z.number()),
    max_price_yen: z.number(),
  }),
  sources: z.array(z.object({ title: z.string(), url: z.string(), date: z.string().nullish() })).min(1),
  change_summary: z.string(),
});

/* ---------- main ---------- */
console.log(`[spec-review] start ${now()} model=${GEMINI_MODEL}`);

const evidence = [];
for (const q of QUERIES) {
  try {
    const rs = await search(q);
    evidence.push(...rs);
    console.log(`[spec-review] ${q} -> ${rs.length} results`);
  } catch (e) {
    console.error(`[warn] search failed: ${q}: ${e.message}`);
  }
}
if (evidence.length < 3) {
  console.error("[error] 情報が少なすぎます — 既存specを維持します");
  process.exit(0);
}

let current = null;
try { current = JSON.parse(await readFile(path.join(ROOT, "config/target-spec.json"), "utf8")); } catch { /* none */ }

const proposedRaw = await geminiJson(
  "あなたはローカルLLMハードウェア要件のアナリストです。以下の最新検索結果に基づき、" +
  "2026年11月時点で『中古デスクトップPCでローカルLLM(Qwen系MoE)を実際に運用する』ための" +
  "ターゲットスペック定義を提案してください。llama.cppのMoEオフロード(--n-cpu-moe)や" +
  "Strataのようなエキスパートストリーミング時代の要件を反映し、RAM/VRAM/ストレージの" +
  "妥当な最小値と推奨値を決めてください。根拠URLは必ずsourcesに反映。" +
  `現在の定義(参考・維持すべき場合は変更しない): ${JSON.stringify(current)}` +
  "\n\n検索結果:\n" + evidence.map((e, i) => `[${i}] ${e.title} (${e.url}, updated:${e.last_updated || "?"})\n${e.snippet}`).join("\n\n") +
  "\n\nchange_summaryには現行定義との差分を日本語1-3文で。変更が不要なら「変更不要」。",
  {
    type: "OBJECT",
    properties: {
      reviewed_at: { type: "STRING" },
      engine_basis: { type: "STRING" },
      profiles: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" }, label: { type: "STRING" }, description: { type: "STRING" },
            min_vram_gb: { type: "NUMBER" }, preferred_vram_gb: { type: "NUMBER" },
            min_ram_gb: { type: "NUMBER" }, min_cpu_cores: { type: "NUMBER" },
            storage: { type: "STRING" }, target_models: { type: "STRING" },
          },
          required: ["id", "label", "description", "min_vram_gb", "preferred_vram_gb", "min_ram_gb", "min_cpu_cores", "storage", "target_models"],
        },
      },
      search_target: {
        type: "OBJECT",
        properties: {
          gpu_priority: { type: "STRING" }, min_vram_gb: { type: "NUMBER" }, preferred_vram_gb: { type: "NUMBER" },
          ram_tiers_gb: { type: "ARRAY", items: { type: "NUMBER" } }, max_price_yen: { type: "NUMBER" },
        },
        required: ["gpu_priority", "min_vram_gb", "preferred_vram_gb", "ram_tiers_gb", "max_price_yen"],
      },
      sources: { type: "ARRAY", items: { type: "OBJECT", properties: { title: { type: "STRING" }, url: { type: "STRING" }, date: { type: "STRING" } }, required: ["title", "url"] } },
      change_summary: { type: "STRING" },
    },
    required: ["reviewed_at", "engine_basis", "profiles", "search_target", "sources", "change_summary"],
  },
);
const proposal = Proposed.parse(proposedRaw);
const changed = current
  ? JSON.stringify(current.profiles) !== JSON.stringify(proposal.profiles) ||
    JSON.stringify(current.search_target) !== JSON.stringify(proposal.search_target)
  : true;
console.log(`[spec-review] proposal: ${proposal.change_summary}`);
console.log(`[spec-review] changed=${changed}`);

await writeFile(path.join(ROOT, "data/spec-review-latest.json"), JSON.stringify(proposal, null, 2) + "\n");

const md = [
  `# ターゲットスペック見直し (${today})`,
  "",
  `- エンジン前提: ${proposal.engine_basis}`,
  `- 変更サマリ: ${proposal.change_summary}`,
  "",
  ...proposal.profiles.map((p) => `## ${p.label}\n- ${p.description}\n- VRAM: 最小${p.min_vram_gb}GB / 推奨${p.preferred_vram_gb}GB・RAM: 最小${p.min_ram_gb}GB・CPU: ${p.min_cpu_cores}コア以上・${p.storage}\n- 想定モデル: ${p.target_models}`),
  "",
  "## 検索ターゲット",
  `- GPU優先: ${proposal.search_target.gpu_priority} (≥${proposal.search_target.min_vram_gb}GB, 推奨${proposal.search_target.preferred_vram_gb}GB)`,
  `- RAM階層: ${proposal.search_target.ram_tiers_gb.join("/")}GB・価格上限: ¥${proposal.search_target.max_price_yen.toLocaleString("ja-JP")}`,
  "",
  "## 根拠",
  ...proposal.sources.map((s) => `- [${s.title}](${s.url})${s.date ? ` (${s.date})` : ""}`),
  "",
].join("\n");
await writeFile(path.join(ROOT, "data/spec-review-latest.md"), md);

if (changed && GITHUB_TOKEN) {
  const issueBody = md + "\n---\nこのIssueは週次spec-reviewが自動生成しました。問題なければ `config/target-spec.json` を提案内容へ手動更新してください(検索条件への自動反映は行いません)。\n";
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ title: `spec-review: ${today} — ターゲットスペック変更提案`, body: issueBody, labels: ["spec-review"] }),
  });
  if (res.ok) {
    const issue = await res.json();
    console.log(`[spec-review] issue opened: ${issue.html_url}`);
  } else {
    console.error(`[warn] issue create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
} else if (changed) {
  console.log("[spec-review] 変更あり(GITHUB_TOKEN無し — Issue起票スキップ)");
}

console.log(`[spec-review] done: data/spec-review-latest.{json,md} updated (changed=${changed})`);
