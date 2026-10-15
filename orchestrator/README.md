# HomeAI Orchestrator

A lean local replacement for OpenClaw. It routes each task to the right model (local Ollama models, Claude CLI, Codex CLI), tracks token use and enforces budgets. It will also be the backend for Logan devices, and later it gets a WebUI and drives the companion apps.

- Spec and roadmap: [SPEC.md](SPEC.md)
- Runtime: Node.js 24, ES modules, no npm dependencies
- Tests: `node --test` (each `src/**/*.mjs` module has a `*.test.mjs`)

## Status
- **Phase 1 core: done (2026-10-15).** `src/router.mjs`, `src/ledger.mjs` and `src/connectors/cli.mjs` are written, and 19 offline tests pass (`npm test`). `node scripts/smoke.mjs ollama claude` checks the parsers against real output. Ollama and Claude have been verified live; Codex hasn't been run live yet.
- Claude prompt-cache reads/writes count fully as input tokens (decided 2026-10-15).
- **Phase 2 service: done (2026-10-15).** 41 offline tests pass. Verified live through the API:
  - Claude Sonnet and Haiku answered.
  - Haiku took over automatically when the local model was busy.
  - The usage log on disk recorded every attempt.

  Codex hasn't been run live yet.
- Next: Phase 3 (Logan) or Phase 5 (WebUI).

## Running
```powershell
node src/main.mjs        # http://127.0.0.1:18850
```
Environment overrides: `HOMEAI_ORCH_PORT`, `HOMEAI_ORCH_TOKEN` (bearer token required for everything except `/api/health`), `HOMEAI_ORCH_ROUTES`, `HOMEAI_ORCH_BUDGETS`, `HOMEAI_ORCH_DATA`, `HOMEAI_CLAUDE_BIN`, `HOMEAI_CODEX_SCRIPT`, `HOMEAI_OLLAMA_URL`.

Config: `config/routes.json` (connectors and fallback chains per task type) and `config/budgets.json` (daily caps). Usage is logged to `data/ledger.jsonl`, which never goes to GitHub.

## API
| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ok, version}`, no auth |
| GET | `/api/config` | connectors, routes, default route, caps |
| GET | `/api/usage?hours=24` | totals by connector and by task type |
| POST | `/api/task` | `{taskType?, prompt, system?}` → `{ok, text, connector, model, taskType, attempts[]}` |

## How it behaves
- Prompts reach the CLIs over stdin, never on the command line.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `OPENAI_API_KEY` are removed from the child environment, so the CLIs use subscription logins rather than metered API billing.
- CLIs run in an empty `data/scratch` directory so they don't load stray project instructions.
- Ollama is streamed. If it produces nothing within 60 s (another model is holding the GPU, or the model is loading), the route moves on to the next connector. Once tokens are flowing, the overall limit is 300 s.
- Requests with a non-loopback `Host` header are refused, which blocks DNS-rebinding attacks. POST requires `application/json`.

OpenClaw remains the live system until cutover is approved.

## Source of truth
Development happens in `D:\HomeAI\projects\orchestrator`. `Sync-Orchestrator.ps1` (repo root) copies it into this repo folder, commits and pushes.
