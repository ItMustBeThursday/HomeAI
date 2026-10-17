# HomeAI Orchestrator

A local Node.js 24 service for model routing, persistent chat and memory, coding jobs, media generation and a browser interface. It uses Node built-ins with no npm dependencies. Local inference runs through Ollama and ComfyUI; Claude and Codex use their standalone subscription CLIs.

Open http://127.0.0.1:18850. The interface includes Chat, Jobs, History, Usage, Status, Config, Memory, Terminal, Projects, Schedule and private local chat. Usage counters are informational and never block requests; real provider errors remain visible. Cancellation does not trigger fallback.

## Develop and verify

Development source is `D:/HomeAI/projects/orchestrator`; the publish checkout is `D:/HomeAIGit/HomeAI`. Run `npm test` for the offline suite. The source version is in `package.json`; `GET /api/health` reports the version actually loaded by the service. Source edits do not establish deployment.

Restart only through `D:/HomeAI/scripts/Restart-Orchestrator.ps1`, after jobs and model queues are idle. Never restart the service hosting an active coding task. `scripts/restart-when-idle.ps1` can wait for that safe point.

## Runtime and configuration

`config/routes.json` defines connectors and fallback routes. The service supports local text/vision, subscription CLI text and action routes, and ComfyUI image/video/audio routes. Preferred models fall back only to compatible connectors. Plan routes remain read-only; action routes require tool-capable CLIs. Text-only models do not have a shell.

`config/budgets.json` supplies dashboard counters, `config/projects.json` registers project roots, and `config/schedule.json` configures scheduled work. Runtime state belongs in `data/`, excluded from Git. Do not publish tokens, credentials, conversations, memory snapshots or local connection settings.

The authenticated API includes `/api/task`, `/api/chat`, `/api/conversations`, `/api/jobs`, `/api/history`, `/api/status`, `/api/usage`, `/api/config`, `/api/memory`, `/api/memory/context`, `/api/schedule` and project/terminal tools. Only `/api/health` is unauthenticated. MCP uses `src/mcp.mjs`.

Environment overrides include `HOMEAI_ORCH_PORT`, `HOMEAI_ORCH_TOKEN`, `HOMEAI_ORCH_DATA`, `HOMEAI_CLAUDE_BIN`, `HOMEAI_CODEX_SCRIPT` and `HOMEAI_OLLAMA_URL`. Subscription children remove API-key billing variables. Prompts use stdin.

## Memory, privacy and backups

Non-private text tasks retrieve bounded shared context by default; `memory:false` opts out. Retrieval is selective and lossy. Original transcripts remain authoritative. Assistant-derived statements are unverified evidence. See [MEMORY-LANGUAGE.md](MEMORY-LANGUAGE.md) and [CHAT-CONTINUITY-PLAN.md](CHAT-CONTINUITY-PLAN.md).

Private sessions use local connectors, do not read shared memory, and do not write normal conversations, history or the ledger. Their scratch files are temporary. Backups must exclude `private` and `scratch` folders.

`scripts/backup-data.ps1` creates a timestamped snapshot of data/config with a SHA-256 manifest. It refuses links and overlapping roots, excludes private/scratch/log files, and retains existing snapshots. `Keep` is advisory: there is no automatic deletion. A completed manifest verifies copied files; it does not guarantee an atomic cross-file snapshot of a busy service.

## Publishing

The root `Sync-Orchestrator.ps1 -Message "summary"` tests, scans source, verifies a backup, mirrors source and commits locally. Publication requires explicit `-Push` and owner authorization. Runtime directories and credential files are excluded. Review the entire staged change before publishing to the public repository.

## Remaining work

- Companion desktop/Android/remote clients still use the legacy gateway protocol; migration is incomplete.
- Logan needs the approved catalog and actual device/service facts. Live switch behavior stays deterministic.
- Browser refresh/reattached Stop, media continuity and crash recovery retain the acceptance gaps recorded in their plans.
- Preserve OpenClaw until explicit cutover approval. Historical removal claims do not establish current authorization. This review neither starts nor stops it.

See [SPEC.md](SPEC.md), [MIGRATION.md](MIGRATION.md), [MODEL-CATALOG.md](MODEL-CATALOG.md) and [INTEGRATIONS.md](INTEGRATIONS.md).
