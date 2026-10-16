# HomeAI Orchestrator

A lean local replacement for OpenClaw. It routes each task to the right model (local Ollama models, Claude CLI, Codex CLI), tracks token use and enforces budgets. It will also be the backend for Logan devices, and later it gets a WebUI and drives the companion apps.

- Spec and roadmap: [SPEC.md](SPEC.md)
- Runtime: Node.js 24, ES modules, no npm dependencies
- Tests: `node --test` (each `src/**/*.mjs` module has a `*.test.mjs`)

## Status
- **Phase 1 core: done (2026-10-15).** `src/router.mjs`, `src/ledger.mjs` and `src/connectors/cli.mjs` are written, and 19 offline tests pass (`npm test`). `node scripts/smoke.mjs ollama claude` checks the parsers against real output. Ollama and Claude have been verified live; Codex was verified live through `/api/task` on 2026-10-15 (`gpt-6.1-sol`, reply `OK`). The direct Codex smoke check remains blocked in the Codex sandbox by home-directory/profile access.
- Claude prompt-cache reads/writes count fully as input tokens (decided 2026-10-15).
- **Phase 2 service: done (2026-10-15).** 41 offline tests pass. Verified live through the API:
  - Claude Sonnet and Haiku answered.
  - Haiku took over automatically when the local model was busy.
  - The usage log on disk recorded every attempt.

  Codex was verified live through `/api/task` on 2026-10-15 (`gpt-6.1-sol`, reply `OK`). The direct Codex smoke check remains blocked in the Codex sandbox by home-directory/profile access.
- **Operations (2026-10-15): done.** Autostart at logon (scheduled task), in-service scheduler with nightly backup, per-backend request queue, log rotation, Schedule tab. 77 offline tests pass; verified live (Codex `OK` via `gpt-6.1-sol`, local Ollama, real backup run).
- **Phase 5 WebUI v1: done (2026-10-15).** Open http://127.0.0.1:18850. Tabs: Chat (saved multi-turn conversations, route picker, pin a model, shows who answered, time, tokens and fallbacks), Usage (totals, budget meters, by model/route), History (every task with prompt, answer and attempts), Status (Claude/Codex/Ollama health, installed/loaded models), Config (edit routes and budgets with validation, live reload, automatic backups), Logan (placeholder for Phase 3). 58 offline tests pass; chat verified live with Claude Haiku, including a follow-up turn.
- **Codex handoff verification (2026-10-15):** 60 offline tests pass. `node scripts/smoke.mjs codex` now uses the service runner (stdin, no shell, subscription environment) and the configured model, and exits nonzero on failure. Run it from Adam's normal user session to finish direct CLI verification. Concurrency limits, log rotation and the scheduler remain pending because the handoff requires stopping at the first blocked task.
- **Migration steps 1-6 (2026-10-15): done.** Standalone Codex install (`D:\HomeAI\runtime\codex`), streaming replies with a Stop button, image input (WebUI attach/paste/drop, API `images`, MCP), an `agent` route and Terminal/Projects tabs for shell, tests, git and GitHub, scoped device tokens, a Memory tab, and the MCP server (`src/mcp.mjs`, 15 tools; register with `claude mcp add --scope user homeai -- node <path>\src\mcp.mjs`). 147 offline tests pass. `node scripts/live-check.mjs` runs 16 end-to-end checks against the running service (real Claude, Codex, Ollama, vision, shell, git, GitHub, agent, token scopes). The WebUI page itself has not been click-tested in a browser. See [MIGRATION.md](MIGRATION.md) for what is and is not replaced yet.
- Next: Phase 3 (Logan), then port the companion apps. See "Still to do" in [SPEC.md](SPEC.md).

## Running
```powershell
.\scripts\start.ps1              # background, logs in data\service.*.log; http://127.0.0.1:18850
.\scripts\start.ps1 -Foreground  # or: node src/main.mjs
.\scripts\backup-data.ps1        # copies data\ and config\ to D:\HomeAI\backups\orchestrator\<timestamp>
```
Environment overrides: `HOMEAI_ORCH_PORT`, `HOMEAI_ORCH_TOKEN` (bearer token required for everything except `/api/health`), `HOMEAI_ORCH_ROUTES`, `HOMEAI_ORCH_BUDGETS`, `HOMEAI_ORCH_SCHEDULE`, `HOMEAI_ORCH_DATA`, `HOMEAI_CLAUDE_BIN`, `HOMEAI_CODEX_SCRIPT`, `HOMEAI_OLLAMA_URL`.

Config: `config/routes.json` (connectors and fallback chains per task type) and `config/budgets.json` (daily caps). Both can be edited in the WebUI; the previous version is kept in `data/config-backups` (newest 50).

Local data (never goes to GitHub; back it up with `scripts/backup-data.ps1`):
- `data/ledger.jsonl`: one line per model attempt (tokens, cost, ok)
- `data/tasks.jsonl`: task history (prompt, answer, attempts), newest 1000 kept in memory
- `data/conversations/*.json`: chats; archived chats move to `data/conversations/archive`

## API
| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ok, version}`, no auth |
| GET | `/api/config` | connectors, routes, default route, caps, `editable` |
| PUT | `/api/config/routes` | replace routes.json (validated, applied live, backed up) |
| PUT | `/api/config/budgets` | replace budgets.json (cap names must match connectors/routes) |
| GET | `/api/usage?hours=24` | totals by connector and by task type, plus `caps[]` with 24h used/limit |
| GET | `/api/status[?fresh=1]` | backend and per-connector health (cached 30 s) |
| GET | `/api/schedule` | scheduler on/off, jobs with last run, and the request queue per backend |
| POST | `/api/schedule/run` | `{name}` run a job now (works even when the scheduler is off) |
| GET | `/api/history?limit=50` | recent tasks, newest first |
| POST | `/api/task` | `{taskType?, prompt, system?, connector?}` → `{id, ok, text, connector, model, taskType, attempts[], ms}`; `connector` pins one model |
| POST | `/api/chat` | `{conversationId?, prompt, taskType?, connector?}` → `{conversation, reply}`; omitting the id starts a new chat |
| GET | `/api/conversations` | chat list |
| GET/PATCH/DELETE | `/api/conversations/:id` | read; rename `{title}`; archive (moved, not deleted) |

## How it behaves
- Prompts reach the CLIs over stdin, never on the command line.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `OPENAI_API_KEY` are removed from the child environment, so the CLIs use subscription logins rather than metered API billing.
- CLIs run in an empty `data/scratch` directory so they don't load stray project instructions.
- Ollama is streamed. If it produces nothing within 60 s (another model is holding the GPU, or the model is loading), the route moves on to the next connector. Once tokens are flowing, the overall limit is 300 s.
- Requests with a non-loopback `Host` header are refused, which blocks DNS-rebinding attacks. POST requires `application/json`.

OpenClaw remains the live system until cutover is approved.

- Chat folds earlier turns into each prompt (newest first, about 12,000 characters), because the CLIs run statelessly. Chat uses a one-line system prompt, which keeps a Claude Haiku turn around 600 input tokens.

## Source of truth
Development happens in `D:\HomeAI\projects\orchestrator`. `Sync-Orchestrator.ps1` (repo root) copies it into this repo folder, commits and pushes. It refuses to publish if `node --test` fails or if anything looks like a credential (API keys, GitHub/Slack/Tailscale tokens, private keys). `data/` is excluded by both the sync script and `.gitignore`.
