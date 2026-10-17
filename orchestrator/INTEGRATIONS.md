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


## GitHub discovery review (2026-10-16)
- Full report: `D:/HomeAI/research/github-discovery-20261016/REVIEW.md`.
- Screened 10,000 public non-fork repositories by stars from the hash-verified RepoSource Registry snapshot dated 2026-10-12T09:22:50Z; current exact global top-10,000 membership is unverified. Live GitHub Search fetched 2498 unique repositories before repeated secondary throttling; kept separately from dated ranks.
- Assessed all 22 current monthly trending repos and 58 candidates individually; fetched 140 READMEs; inspected 7 pinned source files across QMD, Graphiti, context-mode. This is metadata screening plus selected review, not 10,000 source/security audits.
- Reusable local research catalog: `D:/HomeAI/research/github-discovery-20261016/catalog.py`, database `catalog.sqlite`. Read-only query function returns bounded JSON; SQLite FTS5/BM25, no network/GPU/new service. Only public research data indexed. CSV/JSON coverage, source hashes, and 58 assessments retained beside it.
- Priorities: structured temporal fact/provenance fields (Graphiti/Hindsight); indexed tool output and layered retrieval (QMD/context-mode/OpenViking); local parsing (MarkItDown/Docling/PageIndex); held-out prompt/structured-output evaluation (DSPy/Outlines/promptfoo); scoped MCP/browser acceptance and AST code graph (Playwright/Graphify). Detailed constraints and acceptance requirements are in the report.
- Compatibility/performance of candidate runtimes remains unverified. No third-party runtime, hook, provider, agent bundle, or model installed. Existing memory store/routes/services unchanged; no publishing or paid calls.
- Verified: 6 offline regression tests; 255 coverage/hash/index checks passed. Dated catalog has 10002 rows, including supplements. Prior documentation backup location is recorded in the research directory's `backup-location.txt`.
