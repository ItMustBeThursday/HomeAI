# HomeAI Orchestrator

A lean local replacement for OpenClaw. It routes each task to the right model (local Ollama models, Claude CLI, Codex CLI), tracks token use and enforces budgets. It will also be the backend for Logan devices, and later it gets a WebUI and drives the companion apps.

- Spec and roadmap: [SPEC.md](SPEC.md)
- Runtime: Node.js 24, ES modules, no npm dependencies
- Tests: `node --test` (each `src/**/*.mjs` module has a `*.test.mjs`)

## Status
- **Phase 1 core: done (2026-10-15).** `src/router.mjs`, `src/ledger.mjs` and `src/connectors/cli.mjs` are written, and 19 offline tests pass (`npm test`). `node scripts/smoke.mjs ollama claude` checks the parsers against real output. Ollama and Claude have been verified live; Codex hasn't been run live yet.
- Open item: Claude's `usage.input_tokens` leaves out prompt-cache tokens, so the ledger undercounts Claude input. Decide how cache reads/writes should count toward budgets before Phase 2.
- Next: Phase 2 service, which adds the process-spawning wrappers, a persistent ledger and the HTTP API.

OpenClaw remains the live system until cutover is approved.

## Source of truth
Development happens in `D:\HomeAI\projects\orchestrator`. `Sync-Orchestrator.ps1` (repo root) copies it into this repo folder, commits and pushes.
