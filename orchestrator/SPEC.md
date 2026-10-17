# HomeAI Orchestrator — spec

Single local service that routes tasks to LLM connectors (claude-cli, codex-cli, ollama), tracks usage with informational counters. Later phases: Logan catalog, device API, MCP server, WebUI.

## Roadmap
1. **Core** (this spec): router, usage ledger + budgets, CLI/Ollama connectors.
2. **Service**: local HTTP API (`127.0.0.1`, own port, ) exposing chat/task, routes, usage, budgets.
3. **Logan**: approved choice-menu catalog, device API, live menu reprogramming (switch presses stay deterministic).
4. **MCP server**: lets Claude talk to the orchestrator directly.
5. **WebUI**: browser UI served by the service — chat with route/model shown per reply, usage and budget dashboard, route/connector editor, Logan menu/catalog editor, job/history view. Static HTML/CSS/JS with no build step, talking only to the Phase 2 API.
6. **Companion apps**: after everything above is working, update the existing HomeAI companion apps (`D:\HomeAI\projects\homeai-companion`: desktop, android, remote) to use the orchestrator API instead of OpenClaw.

Preserve OpenClaw until explicit cutover approval. Historical removal claims are not authorization.

Status (2026-10-15): Phases 1, 2 and 5 (WebUI v1) done. Phase 3 next.

## Remaining work

- Port companion clients from their legacy gateway protocol; preserve current endpoints until approved cutover.
- Complete Logan approved catalog/device integration with deterministic switch behavior.
- Complete browser interruption/Stop and media acceptance checks in CHAT-CONTINUITY-PLAN.md.
- Verify pending source deployment only after all active jobs/model queues are idle.
- Add boot/crash supervision for local backends after inspecting their current ownership.

## Rules for all code
- Node.js 24, ES modules (`.mjs`), **no npm dependencies**. Only `node:` built-ins.
- Pure functions where possible; no network, no process spawning in Phase 1 modules (spawning is a thin later wrapper).
- Each module has a `*.test.mjs` using `node:test` and `node:assert/strict`.
- Throw `Error` with clear messages on invalid input. No console output.

## Environment facts (verified 2026-10-15)
- claude CLI 2.1.299. Headless: `claude -p <prompt> --output-format json --model <m> --system-prompt <s> --tools <list> --strict-mcp-config --no-session-persistence --max-turns <n>`; `--tools ""` = no tools.
- codex-cli 0.160.0 standalone at `D:\HomeAI\runtime\codex`. Headless: `codex exec --json --ephemeral --skip-git-repo-check -m <m> -s read-only <prompt>`; output is JSONL events.
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
