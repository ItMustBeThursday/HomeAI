# HomeAI

A staged Windows home AI kit: local Qwen through Ollama and restricted OpenClaw,
plus optional Codex and Claude subscription text workers.

## Existing HomeAI installation

Download the source ZIP from GitHub and extract it on the gaming PC. Open Windows
PowerShell in `home-ai-kit`. Keep all helper files together.

Connect the installed Codex runtime:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Connect-Codex.ps1
```

Complete the native ChatGPT login if asked. The connector uses a private HomeAI
profile and does not copy desktop credentials, settings or conversations. It
discovers the official installed native executable; if necessary, supply its
absolute path with `-CodexPath`. No API key or API billing fallback is configured.

Optional Claude Pro connector:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Connect-Claude.ps1
```

Complete native subscription login and confirm paid extra usage is disabled in
Claude billing. The installer reuses the pinned downloaded package on reruns.

Request with automatic fallback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\HomeAI\scripts\Ask-HomeAI.ps1 -Mode BestAvailable -Provider Codex -Prompt "Draft a short project brief."
```

Order: Codex, Claude, local Qwen. Use `-Provider Claude` to reverse hosted
preference. Omit `-Mode BestAvailable` for local-only inference. Missing login,
failed/incomplete requests and observed usage limits move to the next worker.
An observed limit produces a persisted five-minute retry cooldown; this is not
a predicted quota reset or remaining-token balance. Each hosted worker is tried
at most once per request. Quota classification ignores successful answer text.

Hosted inference prompts are authorized without a SEND confirmation. Only the
supplied prompt is passed as task content: project files, memory and previous
desktop conversations are not attached. These text workers do not execute code,
send messages, publish, buy anything or modify project files. Other external
actions still require approval; project deletion requires a verified backup.

**Current boundary:** the hosted bridge is a PowerShell interface. It does not
add Codex or Claude to OpenClaw's model selector, share persistent conversations,
or implement autonomous project tools. OpenClaw remains local. A shared task
ledger, policy broker, document/image workers, voice and assistive hardware work
remain future stages. No frontier-level local performance is promised.

## New installation

Review `home-ai-kit/releases.json` and `Setup-HomeAI.ps1 -PlanOnly`, then run setup.
Defaults: install `D:\HomeAI`, backup `E:\HomeAI-Backups`, Ollama port 11435,
OpenClaw port 18795. Installation downloads portable runtimes and a large Qwen
model. `Continue-HomeAI.ps1` performs dependency checks and model evaluations.
The installer pins release hashes and leaves shell/browser/device tools disabled.

## Verification

With Node available on PATH, run these from the repository root on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-Package.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-ClaudeLock.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-CodexRouting.ps1
node tests\test-native.mjs
```

`Test-CodexRuntime.ps1` additionally needs a native Codex executable, and checks
actual runtime restrictions without login or inference. `Test-BackupLinks.ps1`
exercises real Windows junction handling. Tests leave isolated artifacts under
`tests/artifacts`; they do not download models or call hosted inference.

The source has passed offline mock tests and runtime capability checks. Live
subscription login, first hosted completion and GPU behavior require testing on
the installation PC. After Codex updates, reconnect to validate its new executable.

## Repository contents

This repository contains generic source and tests only. Do not commit personal
proposals, credentials, auth profiles, installed state, models, outputs or logs.
Authentication profiles live in the user's local app data outside HomeAI backups.
No license for redistributing third-party runtimes or weights is implied.

Official integration references: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[Codex scripted execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Claude subscription interfaces](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).