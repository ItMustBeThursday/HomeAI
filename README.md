# HomeAI

The current project is the [orchestrator](orchestrator/README.md): a local Node 24 service for model routing, persistent chat/memory, coding jobs, media and a browser interface. Usage counters are informational.

- [Specification](orchestrator/SPEC.md), [transition status](orchestrator/MIGRATION.md), [review report](CODE-REVIEW.md).
- `home-ai-kit/` contains local model setup, backup/restore and standalone subscription CLI helpers, plus the deterministic switch/voice lab.
- `companion/` preserves desktop, Android and remote client source pending API migration.
- `discord-bridge/` contains the current channel bridge source and offline tests.
- `tests/` contains offline host-tooling tests.

Preserve OpenClaw until explicit cutover approval. Companion clients still use the legacy gateway protocol. Historical removal claims do not establish approval.

## Validation and publishing

Run `npm test` from `orchestrator/`; run the PowerShell tests from the repository root. Development source is `D:/HomeAI/projects/orchestrator`.

`Sync-Orchestrator.ps1 -Message "summary"` tests, scans, makes a verified backup, mirrors source and commits locally. Add `-Push` only when publication is explicitly authorized. This public repository excludes runtime data, credentials, private conversations and local connection settings.
