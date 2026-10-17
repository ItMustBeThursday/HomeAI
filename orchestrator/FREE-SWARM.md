# Free hosted LLM swarm

Status 2026-10-16: code + tests done; NO hosted provider has a key yet, so no hosted call was ever made. Hosted behaviour is tested only against mocks.

## Candidates (third-party reports, Oct 2026 - UNVERIFIED against provider dashboards; limits change often)
| Provider | Free limit (reported) | OpenAI-compatible | Caveat |
|---|---|---|---|
| Groq | 30 RPM, 1K RPD, 200K TPD per model (per org) | yes | gpt-oss-120b/20b, qwen3.8-27b |
| NVIDIA NIM | 40 RPM, 10K RPD per model | yes | needs Developer Program membership |
| OpenRouter `:free` | 20 RPM, 50 RPD (1000 after $10 top-up) | yes | free providers may log prompts. Keyless /models listing verified live: 16 free models incl. nemotron-3-super-120b, gemma-4-31b |
| Google Gemini | limits unpublished (check AI Studio) | via /v1beta/openai | free-tier prompts may improve Google products (non-EEA) |
| Mistral Experiment | credits/month | yes | may train on prompts unless opted out |
| Cerebras | sources conflict (permanent free tier reportedly ended Jul 2026) | yes | not included |
| Cloudflare Workers AI, Cohere (non-commercial), GitHub Models, HF, ModelScope, SiliconFlow | various | mostly not | not included (non-OpenAI API, restrictions, ID verification) |

CLI options not added: Gemini CLI / Qwen Code free logins (account sign-in needed, not evaluated).

## Design
- `src/hosted.mjs`: OpenAI-compatible client, https only, key from env `HOMEAI_KEY_<PROVIDER>`, key/secret shapes redacted from errors, no retries (swarm falls over instead).
- `src/swarm.mjs`: local model plans 1-6 self-contained sub-tasks -> up to 4 in parallel to enabled free providers (round-robin, per-provider RPM pacing, 90% daily cap, cooldown on 429/Retry-After) -> fallback to next provider, then local -> local model merges. Output carries per-part provenance and `verified:false`.
- Privacy: standalone, NOT a router connector, so chat memory, private sessions and agent tools can never reach it. Tasks/sub-tasks that look like secrets stay local. Free tiers may log/train: do not feed personal data.
- `config/free-providers.json`: provider catalog; a provider is disabled until its key env var exists.
- CLI: `node scripts/swarm.mjs --status` | `[--local-only] "task"`.

## To activate (needs owner action: account creation/keys are external)
Create free keys (Groq, NVIDIA, OpenRouter are the best-headroom, no-card options), set user env vars `HOMEAI_KEY_GROQ` etc., run `--status`, then try a harmless task. Verify model names/limits in each dashboard first.

## Not done
No server/UI wiring (swarm is CLI/module only); no quality benchmark vs local models; live service untouched (still needs idle restart for earlier work).
