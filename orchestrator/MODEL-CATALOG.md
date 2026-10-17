# Quantized model catalog — 2026-10-16

Selection target: five strong usable choices across reasoning, coding, general chat and vision. This is a task-based shortlist, not a measured universal top-five ranking. Model-card benchmark results are not measurements of these quantized models on this PC. Two models were newly downloaded; three were already installed and are included in the recommended collection.

Owner requested a 30% larger planning envelope: 26 GB VRAM and 83.2 GB RAM, versus the actual RX 7900 XT 20 GB and nominal 64 GB RAM. That envelope does not increase physical memory. CPU offload and runtime overhead still apply; RAM and VRAM are separate pools. Only one large local model should run at a time. Initial context is bounded to 4096 tokens rather than the advertised maximum.

| Active shortlist | Quantization | Approximate download | Purpose | Fit caveat |
| --- | --- | --- | --- | --- |
| GPT-OSS 120B (existing) | MXFP4 | 65 GB | Reasoning specialist | CPU offload; use one large model at a time |
| Qwen3-Next 80B-A3B (existing) | Q4_K_M | 50 GB | Deep analysis and long-form text | CPU offload required |
| Qwen3-Coder-Next 80B | Q4_K_M | 52 GB | Coding specialist | CPU offload required; text connector has no shell tools |
| Qwen 3.8 27B (existing) | Q4_K_M | 18 GB | General chat, research and coding | Context and vision add overhead |
| Qwen 3.5 35B-A3B | Q4_K_M | 22 GB | General chat and vision | Exceeds actual 20 GB VRAM; partial CPU offload |

Smaller models remain available. Existing default route chains are preserved. New `flagship`, `coding-local` and `general-local` routes contain local Ollama connectors only, so those routes do not fall back to paid cloud providers. A star identifies the five shortlisted choices in the picker. All five begin at 4096 context and allow a bounded 240-second cold load (requires the updated backend).

## Stretch candidates and observed limit

The initial hypothetical shortlist also included Qwen 3.5 122B-A10B Q4 (~81 GB), Mistral Medium 3.5 128B Q4 (~80 GB) and Nemotron 3.5 Super Q4 (~90 GB).

Qwen 122B finished downloading and passed Ollama's SHA256 check. Its real runtime test drove available physical memory down to 149540 KiB (about 146 MiB). Only its verified `llama-server.exe` runner was stopped; Ollama stayed running and free RAM recovered to over 50 GB. The runner termination in the evidence was caused by this intervention, not a spontaneous provider failure. It is not a successful runtime test. The installed source and alias were retained, but the candidate was removed from active routes/pickers to avoid repeating the memory exhaustion.

Mistral's partial download was retained and its download queue stopped; Nemotron was not started. Neither is installed or runtime validated. The proposed 30% envelope cannot make these candidates usable on the actual machine. These three are documented candidates, not active recommended models.

The model picker and Status view group models by purpose and sort labels within each category. Selecting a model shows its purpose and hardware caveat below the composer. Status distinguishes installation from loading; neither is a quality benchmark. ComfyUI availability describes the backend, not proof that every workflow works.

## Observed checks

All five returned the exact `MODEL_OK` marker locally at 4096 context: Qwen 3.5 35B 31.24 s, Coder-Next 80B 66.88 s, Qwen3-Next 80B 63.99 s, Qwen 3.8 27B 31.34 s, GPT-OSS 120B 128.23 s. These times include loading and are not generation-speed benchmarks. GPT-OSS used low reasoning effort and a 256-token allowance; its initial 32-token attempt had no final text and remains in the evidence as a previous failed check.

The updated real connector runner also passed Coder-Next in 79.94 s with `startTimeoutMs:240000`. Browser acceptance: a Qwen 3.5 35B chat on `general-local` returned the marker in 41 s, including a real refresh mid-run; the saved reply and route attribution survived. Full suite 318/318, final affected 8/8, syntax checks passed. Complex reasoning/coding quality and image understanding remain unverified.

UI and config are live. The new cold-load allowance requires a backend reload; idle watcher PID8800 was verified running with a real 19:48:55 deadline. The active Codex request was preserved. Actual backend deployment remains unverified until the restart log confirms it.

## Verification and recovery

The initial downloader was `D:/HomeAI/scripts/pull-new-models.sh`, log `D:/HomeAI/logs/pull-new-models.log`. It was stopped after the memory failure. Do not rerun it unchanged: its queue includes the oversized candidates.

`scripts/verify-model-catalog.mjs` uses only local APIs. It copies installed source manifests to dedicated `homeai-*:locked` aliases without changing existing aliases, checks quantization/capabilities, then requests a fixed text marker with 4096 context and unloads after completion. An alias with a different digest is never overwritten. Evidence is recorded at `D:/HomeAI/evaluations/model-catalog-20261016.json`. Missing downloads are not recorded as installed. A failed or timed-out smoke check is retained as a failure. Vision, complex coding, quality and sustained speed require separate acceptance tests.

Verified pre-edit backup: `D:/HomeAI/backups/model-catalog-20261016-182527` (routes, UI, status source and package metadata; hashes compared).

## Primary sources

- [Qwen 3.5 122B Q4 manifest and model card](https://ollama.com/library/qwen3.5:122b-a10b-q4_K_M)
- [Qwen 3.5 35B Q4 manifest and model card](https://ollama.com/library/qwen3.5:35b-a3b-q4_K_M)
- [Qwen3-Coder-Next Q4 model card](https://ollama.com/library/qwen3-coder-next:q4_K_M)
- [GPT-OSS 120B MXFP4](https://ollama.com/library/gpt-oss:120b)
- [Qwen3-Next 80B Q4](https://ollama.com/library/qwen3-next:80b-a3b-instruct-q4_K_M)
- [Qwen 3.8 27B Q4](https://ollama.com/library/qwen3.8:27b-q4_K_M)
- [Mistral Medium 3.5 quantized variants](https://ollama.com/library/mistral-medium-3.5/tags)
- [Mistral model documentation](https://docs.mistral.ai/models/mistral-medium-3-5-26-04)
- [Nemotron 3.5 Super model library](https://ollama.com/library/nemotron-3.5-super)
- [NVIDIA Nemotron 3.5 Super release](https://research.nvidia.com/labs/nemotron/Nemotron-3.5-Super-and-Lightning/)
