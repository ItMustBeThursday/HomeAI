# External tools evaluated/added (2026-10-16)

## XERJ (xerj-org/xerj, Apache-2.0) — installed as a tool; NOT adopted as the memory backend
- Installed: `D:\HomeAI\runtime\xerj` (v1.0.0-rc.96, sha256-verified release zip; source clone in `D:\HomeAI\external\xerj-src`).
  `start-xerj.ps1` runs it on loopback with auth on; `xerj-mcp.cmd` is a stdio MCP wrapper (key read from the data dir, never put in a client config).
- Use it for: `xerj autoindex <folder>`, `xerj search "<q>"`, `xerj def "<symbol>"` — token-cheap code/doc search for agents. Smoke-tested on `src/` (80 files, 697 records, ranked hits with file:line).
- Memory decision: skipped. Its `/_memory` API stores text + caller-supplied vectors + metadata with BM25/kNN/hybrid recall and its built-in embedder is lexical only. Our `src/memory.mjs` already does keyword + Ollama-embedding hybrid ranking, core notes, scoped/tagged recall, episode caps, correction-preserving exact-duplicate removal, query-focused squeezing into a char budget, MCL compact rendering, trash and `.bak` recovery, with no extra service. Nothing there improves on that.
- Not enabled: `xerj feedback --open-pr`, Jev rerank, hub features (all send data/PRs externally; need Adam's approval).

## CLI-Anything (HKUDS/CLI-Anything, Apache-2.0)
- Codex skill installed at `~\.codex\skills\cli-anything` (restart Codex to load). Source: `D:\HomeAI\external\cli-anything-src`.
- `cli-hub` (package manager for agent-ready CLIs) installed in venv `D:\HomeAI\runtime\cli-hub-venv`: `Scripts\cli-hub.exe list|search|info|install <name>`. e.g. `ollama`, `comfyui`, `blender`. Installing a given CLI pulls third-party code; do per need.
- Claude Code skill copy (`~\.claude\skills\cli-anything`) and MCP registration were not done (writes to `~\.claude` were blocked in this run). One-liner: copy the codex skill dir there; and `claude mcp add --scope user xerj -- D:\HomeAI\runtime\xerj\xerj-mcp.cmd`.
