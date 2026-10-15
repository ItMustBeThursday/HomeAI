# HomeAI Orchestrator

A lean local replacement for OpenClaw. It routes each task to the right model (local Ollama models, Claude CLI, Codex CLI), tracks token use and enforces budgets. It will also be the backend for Logan devices, and later it gets a WebUI and drives the companion apps.

- Spec and roadmap: [SPEC.md](SPEC.md)
- Runtime: Node.js 24, ES modules, no npm dependencies
- Tests: `node --test` (each `src/**/*.mjs` module has a `*.test.mjs`)

## Status
Phase 1 (core) is specified but not implemented yet. OpenClaw remains the live system until cutover is approved.

## Source of truth
Development happens in `D:\HomeAI\projects\orchestrator`. `Sync-Orchestrator.ps1` (repo root) copies it into this repo folder, commits and pushes.
