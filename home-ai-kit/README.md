# home-ai-kit

Host tooling for the HomeAI PC. The live system is the [orchestrator](../orchestrator/README.md); this kit only holds the pieces it still relies on.

| Script | Purpose |
|---|---|
| `Setup-HomeAI.ps1 -PlanOnly` | Lay out `D:\HomeAI` (defaults: backups `E:\HomeAI-Backups`, Ollama port 11435). |
| `Start-HomeAI.ps1` / `Stop-HomeAI.ps1` | Start/stop the owned local Ollama server (the orchestrator has its own `Restart-Orchestrator.ps1`). |
| `Backup-HomeAI.ps1` / `Restore-HomeAI.ps1` | Verified, hash-manifested snapshots and restore. |
| `Stage-HomeAIModels.ps1`, `Stage-Heretic.ps1`, `Benchmark-HomeAI.ps1`, `Stage-Report.ps1` | Model staging and evaluation. |
| `Connect-Codex.ps1`, `Connect-Claude.ps1`, `Ask-HomeAI.ps1`, `Invoke-HomeAI.ps1` | Standalone prompt helpers (subscription logins only, no API keys). |
| `Enable-HomeAIEvolution.ps1`, `evolution/` | Logan switch/voice lab; see `evolution/CURRENT-RUNBOOK.md`. |

Rules: never touch cloud-synced folders, never commit secrets, back up before deleting.

Tests: `powershell -NoProfile -ExecutionPolicy Bypass -File ..\tests\Test-Package.ps1` (also `Test-BackupLinks`, `Test-Restore`, `Test-AccessPreservation`, `Test-CodexRuntime`, `node ..\tests\test-backup-snapshot.mjs`).

Only generic source is published. Credentials, runtime state, model files, backups and test artifacts are excluded.
