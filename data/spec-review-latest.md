# ターゲットスペック見直し (2026-11-23)

- エンジン前提: llama.cpp (--n-cpu-moe / --moe-cache-mib / --moe-cache-cpu-share / --ple) + Strata (Qwen MoE expert-streaming)
- 変更サマリ: RAM/VRAMの主要要件(12-16GB VRAM、32-64GB RAM)は維持しつつ、llama.cpp v0.7.0〜1.0のMoE GPUキャッシュ(--moe-cache-mib/--moe-cache-cpu-share)やSSDからのn-gramテーブル読み込み(--ple)をengine_basisとプロファイル説明に反映しました。また、all-in-vramの対象にQwen3.8 27Bを追加し、Strataの推奨GPUに合わせてRX 6800 16GBをgpu_priorityに追記するとともに、sourcesを最新の検索結果URLへ更新しました。

## 標準: MoEストリーミング運用
- Qwen3.8-Flash-Next級(125B MoE)をStrataやllama.cppのGPUキャッシュ(--moe-cache-mib)とSSDテーブル参照(--ple)で動かす構成。エキスパートをRAMに置き、ホットな層を12-16GB VRAMにキャッシュする
- VRAM: 最小12GB / 推奨16GB・RAM: 最小64GB・CPU: 8コア以上・NVMe SSD 1TB以上
- 想定モデル: Qwen3.8-Flash-Next級 (125B MoE / Q4・低bit), 35B級MoE
## 高速: フルGPU展開
- 27B〜35B級モデルをVRAMに全展開し高token/sで運用する構成
- VRAM: 最小16GB / 推奨20GB・RAM: 最小32GB・CPU: 6コア以上・NVMe SSD 1TB以上
- 想定モデル: 35B級MoE (Q4), Qwen3.8 27B (Q4_K_M), 14B級dense

## 検索ターゲット
- GPU優先: RTX 3060 12GB / RTX 4060 Ti 16GB / RX 7600 XT 16GB / RX 6800 16GB (≥12GB, 推奨16GB)
- RAM階層: 32/64GB・価格上限: ¥110,000

## 根拠
- [How Much VRAM for Local LLMs? Table by Model (2026)](https://llmconfigurator.com/en/guides/vram-requirements-guide) (2026-11-19)
- [Qwen3.8 Flash Next VRAM Requirements to Run Locally](https://vramglass.com/model/qwen/qwen3-8-flash-next?market=amazon_jp) (2026-11-22)
- [Qwen3.8-Flash-Next: How to Run Locally (Unsloth)](https://unsloth.ai/docs/models/qwen3.8-next) (2026-11-17)
- [How to Run Qwen3.8 Flash Next Locally](https://atomic.chat/blog/guides/how-to-run-qwen-3-8-flash-next-locally) (2026-11-22)
- [Strata Local AI: Run Qwen3.8-Flash-Next on a Gaming PC](https://aitokenprice.com/guides/strata-local-ai) (2026-11-18)
- [Strata: Run Qwen3.8-Flash-Next on your own PC](https://openfree.tools/strata) (2026-11-15)
- [llama.cpp v0.7.0 Released with MoE GPU Cache and New Models](https://localmodelwatch.tsuchitsuchi.com/en/2026/11/17/llamacpp-v0-7-0-released/) (2026-11-22)
- [llama.cpp b12191 release notes](https://whatsnew.fyi/product/llama-cpp/releases/b12191) (2026-11-22)
