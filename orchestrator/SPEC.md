# HomeAI Orchestrator — spec

Single local service that routes tasks to LLM connectors (claude-cli, codex-cli, ollama), tracks usage, enforces budgets. Later phases: Logan catalog, device API, MCP server, WebUI.

## Roadmap
1. **Core** (this spec): router, usage ledger + budgets, CLI/Ollama connectors.
2. **Service**: local HTTP API (`127.0.0.1`, own port, separate from OpenClaw) exposing chat/task, routes, usage, budgets.
3. **Logan**: approved choice-menu catalog, device API, live menu reprogramming (switch presses stay deterministic).
4. **MCP server**: lets Claude talk to the orchestrator directly.
5. **WebUI**: browser UI served by the service — chat with route/model shown per reply, usage and budget dashboard, route/connector editor, Logan menu/catalog editor, job/history view. Static HTML/CSS/JS with no build step, talking only to the Phase 2 API.
6. **Companion apps**: after everything above is working, update the existing HomeAI companion apps (`D:\HomeAI\projects\homeai-companion`: desktop, android, remote) to use the orchestrator API instead of OpenClaw.

OpenClaw stays the working system until the orchestrator is verified and Adam signs off on cutover.

Status (2026-10-15): Phases 1, 2 and 5 (WebUI v1) done. Phase 3 next.

## Still to do (coverage review 2026-10-15)
What we will need that isn't built yet, grouped by when it blocks us.

**Blocks OpenClaw cutover**
- [ ] Standalone Codex install. The service still uses the codex.js inside OpenClaw's folder, so removing OpenClaw would break the `codex` connector.
- [x] Codex verified live through the orchestrator: `POST /api/task` pinned to `codex` returned `OK` using `gpt-6.1-sol` on 2026-10-15 (15,927 input / 5 output tokens). Direct CLI smoke remains blocked in the Codex sandbox by home-directory/profile access; rerun `node scripts/smoke.mjs codex` in Adam's normal session.
- [x] Auto-start at logon: scheduled task `HomeAI-Orchestrator-Autostart` runs `scripts/autostart.ps1` (pins node and claude paths, since a task does not get the interactive PATH). Registered with Adam's approval 2026-10-15; verified all three backends are detected when started that way.
- [x] In-service scheduler (`src/scheduler.mjs`, `config/schedule.json`, log `data/schedule.jsonl`, Schedule tab, `GET /api/schedule`, `POST /api/schedule/run`). Nightly `backup-data.ps1` at 03:00 is enabled; a missed run catches up once. Still to add later: the weekly Logan curation job, and an LLM-task job type.
- [ ] Migration checklist: list everything OpenClaw does today that Adam relies on (automations, memory files, channels, Tailscale Funnel exposure, HomeAI jobs), with the replacement for each.
- [ ] Memory: carry the durable facts and preferences (workspace `MEMORY.md`/`USER.md`) into a small store that routes can opt into, rather than injecting them into every prompt.

**Blocks Logan devices and companion apps**
- [ ] Phase 3 Logan catalog, rules checker, versioning/rollback, device feed, choice log. Needs from Adam: TV brand(s), what the runner hardware is, and the subscribed services list.
- [ ] Network access beyond this PC. Today the service is loopback-only. Needed: an opt-in LAN/Tailscale bind, a token that is mandatory when not on loopback, per-device tokens with limited scope (a Logan device can read its menu and post choices, nothing else), and HTTPS via Tailscale.
- [ ] Phase 4 MCP server so Claude can use the orchestrator directly.

**Quality of life**
- [ ] Streaming replies and a cancel button in chat (long Opus/Codex calls currently show only a timer).
- [x] Concurrency limits (`src/limiter.mjs`): 1 in flight for Ollama, 2 per CLI; extra requests queue. Shown on the Schedule tab.
- [ ] Vision route (`homeai-vision`) with image attachments; the runner is text-only today.
- [x] Ledger (5 MB) and history (20 MB) rotate to `*.YYYYMMDD.jsonl` without deleting anything (`src/rotate.mjs`); the ledger reloads files rotated in the last 48 h so same-day budgets survive a restart.
- [ ] Concurrent writes to the same conversation can race (single-user today, so acceptable for now).

## Rules for all code
- Node.js 24, ES modules (`.mjs`), **no npm dependencies**. Only `node:` built-ins.
- Pure functions where possible; no network, no process spawning in Phase 1 modules (spawning is a thin later wrapper).
- Each module has a `*.test.mjs` using `node:test` and `node:assert/strict`.
- Throw `Error` with clear messages on invalid input. No console output.

## Environment facts (verified 2026-10-15)
- claude CLI 2.1.299. Headless: `claude -p <prompt> --output-format json --model <m> --system-prompt <s> --tools <list> --strict-mcp-config --no-session-persistence --max-turns <n>`; `--tools ""` = no tools.
- codex-cli 0.160.0 at `D:\HomeAI\state\openclaw\npm\projects\openclaw-codex-8902d781d4\node_modules\.bin\codex.cmd`. Headless: `codex exec --json --ephemeral --skip-git-repo-check -m <m> -s read-only <prompt>`; output is JSONL events.
- Ollama 0.40.4 at `http://127.0.0.1:11435`. Models: homeai-main:locked (qwen3.8 27b), homeai-coder:locked (qwen3-coder 30b), homeai-fast:locked (gemma4 e4b), homeai-vision:locked (qwen3-vl 4b), homeai-embedding:locked.

## Module 1: src/router.mjs
- `validateRoutes(config)` — config shape: `{ connectors: { [name]: { kind: "claude-cli"|"codex-cli"|"ollama", model: string } }, routes: { [taskType]: { chain: string[], maxTurns?: number, tools?: string[] } }, default: string }`. Every chain entry must name an existing connector; `default` must name an existing route. Returns the config; throws otherwise.
- `resolveChain(config, taskType)` — returns array of `{ connector, kind, model, maxTurns, tools }` for the route (falls back to `config.default` route if taskType unknown). maxTurns default 1, tools default [].
- `nextInChain(chain, failedIndex)` — returns the next entry or `null`.

## Module 2: src/ledger.mjs
Entry shape: `{ ts: number(ms), connector: string, taskType: string, inputTokens: number, outputTokens: number, costUsd: number|null, ok: boolean }`.
- `makeEntry(fields)` — validates and returns a frozen entry (defaults: costUsd null, ok true).
- `summarize(entries, sinceMs)` — `{ total: {calls, inputTokens, outputTokens, costUsd}, byConnector: {...}, byTaskType: {...} }` for entries with ts >= sinceMs. costUsd sums only non-null values.
- `checkBudget(entries, caps, connector, taskType, nowMs)` — caps: `{ daily: { perConnector?: {[name]: {tokens?, calls?}}, perTaskType?: {[t]: {tokens?, calls?}}, globalTokens? } }`. Day window = last 24h from nowMs. Tokens = input+output. Returns `{ allowed: boolean, reason: string|null }`; reason names the cap exceeded.

## Module 3: src/connectors/cli.mjs
- `buildClaudeArgs({ prompt, model, systemPrompt, tools = [], maxTurns = 1 })` → argv array (no shell quoting), per facts above; `--tools` followed by `""`-equivalent empty string when tools empty, else comma-joined.
- `parseClaudeJson(stdout)` → `{ text, inputTokens, outputTokens, costUsd, ok }` from Claude's JSON result object (`result`, `usage.input_tokens` + `usage.cache_creation_input_tokens` + `usage.cache_read_input_tokens`, `usage.output_tokens`, `total_cost_usd`, `is_error`). Missing usage → 0. Cache tokens count fully toward budgets.
- `buildCodexArgs({ prompt, model, sandbox = "read-only" })` → argv array starting with `exec`.
- `parseCodexJsonl(stdout)` → `{ text, inputTokens, outputTokens, costUsd: null, ok }`; text = last agent message text found in events; usage from any event with `usage.input_tokens`/`usage.output_tokens` (take the last). Ignore unparseable lines.
- `buildOllamaRequest({ model, prompt, system })` → `{ url: "http://127.0.0.1:11435/api/chat", body: { model, stream: false, messages: [...] } }`.
- `parseOllamaResponse(json)` → `{ text: message.content, inputTokens: prompt_eval_count||0, outputTokens: eval_count||0, costUsd: 0, ok: true }`.
