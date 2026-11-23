# ターゲットスペック見直し (2026-11-23)

- エンジン前提: llama.cpp (--n-cpu-moe / --moe-cache-mib / --moe-cache-cpu-share / --ple) + Strata (Qwen MoE expert-streaming & SSD n-gram table offload) 
- 変更サマリ: llama.cppのMoE GPU LRUキャッシュ(--moe-cache-mib/--moe-cache-cpu-share)やn-gramテーブルSSD直読み(--ple)、Strataでの12GB+ VRAM・48-64GB RAM・SSDテーブル配置の最新要件を反映し、engine_basis・プロファイル説明・target_models・sourcesを更新した。VRAM/RAM/ストレージ/中古上限価格の数値要件は最新データでも妥当であるため維持した。

## 標準: MoEストリーミング運用
- Qwen3.8-Flash-Next(125B MoE/活性6B)等をStrataまたはllama.cppのMoE GPU LRUキャッシュ(--moe-cache-mib)とSSDテーブル直読み(--ple)で動かす構成。頻出エキスパートを12-16GB VRAMにキャッシュし、残余エキスパートを64GB RAM、約29GBのn-gramテーブルをNVMe SSDに配置する
- VRAM: 最小12GB / 推奨16GB・RAM: 最小64GB・CPU: 8コア以上・NVMe SSD 1TB以上
- 想定モデル: Qwen3.8-Flash-Next (125B MoE), Qwen3.6-35B-A3B級MoE
## 高速: フルGPU展開
- 35B級MoEや14B-27B級denseモデルをVRAMに全展開し高token/sで運用する構成
- VRAM: 最小16GB / 推奨20GB・RAM: 最小32GB・CPU: 6コア以上・NVMe SSD 1TB以上
- 想定モデル: Qwen3.6-35B-A3B級MoE (Q4), Qwen3.8 27B / 14B級dense

## 検索ターゲット
- GPU優先: RTX 3060 12GB / RTX 4060 Ti 16GB / RX 7600 XT 16GB (≥12GB, 推奨16GB)
- RAM階層: 32/64GB・価格上限: ¥110,000

## 根拠
- [How Much VRAM for Local LLMs? Table by Model (2026) ](https://llmconfigurator.com/en/guides/vram-requirements-guide) (2026-11-19)
- [Strata LLM Engine: Requirements, Setup and vs vLLM](https://vdf.ai/blog/strata-local-llm/) (2026-11-15)
- [Strata Local AI: Run Qwen3.8-Flash-Next on a Gaming PC](https://aitokenprice.com/guides/strata-local-ai) (2026-11-18)
- [Strata backend (experimental) - LocalAI](https://localai.io/docs/features/strata/) (2026-11-07)
- [llama.cpp v0.7.0 Released with MoE GPU Cache and New Models](https://localmodelwatch.tsuchitsuchi.com/en/2026/11/17/llamacpp-v0-7-0-released/) (2026-11-22)
- [llama.cpp 1.0: What Changed for Home Users](https://underclassic.com/llama-cpp-1-0.html) (2026-11-21)
- [Qwen3.8-Flash-Next: How to Run Locally (Unsloth) ](https://unsloth.ai/docs/models/qwen3.8-next) (2026-11-17)
- [How to Run Qwen3.8 Flash Next Locally](https://atomic.chat/blog/guides/how-to-run-qwen-3-8-flash-next-locally) (2026-11-22)
- [Qwen3.8 Flash Next VRAM Requirements to Run Locally](https://vramglass.com/model/qwen/qwen3-8-flash-next?market=amazon_jp) (2026-11-22)
