# Codex handoff — 2026-10-15 15:20 ET

Claude is out of credits until ~17:00 ET. You (Codex) continue the HomeAI Orchestrator in this directory.
Read `README.md` (status, API) and `SPEC.md` (rules, "Still to do") first — they are the source of truth. Keep this run small and verifiable.

## Hard rules
- Node 24, ES modules, **no npm deps**, every module gets a `*.test.mjs` (`node:test`). Run `npm test` after each change; never claim passing without the output.
- Do **not** touch OpenClaw (`D:\HomeAI\state\openclaw`, `D:\HomeAI\runtime\openclaw`) — it stays the live system until Adam approves cutover.
- Never touch anything under OneDrive. No system changes (scheduled tasks, services, firewall, installs) — list them for Adam instead.
- Never send messages, purchase, or publish anything except the sync below. Repo is **public**: never commit secrets/tokens/`data/`.
- Back up before deleting any file (`scripts\backup-data.ps1` for data/config).

## Tasks, in order (stop at whichever you can't finish cleanly)
1. **Live-verify the codex connector** (OpenAI quota is back after 15:19). Start the service (`.\scripts\start.ps1`), `POST /api/task` with `{"connector":"<codex connector name from config/routes.json>","prompt":"Reply with OK"}`, and also `node scripts/smoke.mjs codex` if supported. Fix `parseCodexJsonl` / runner against real codex-cli 0.160 output if it fails (add a test using the real captured output, with anything sensitive removed). Tick the SPEC box.
2. **Concurrency limits** (SPEC "Quality of life"): one in-flight request per Ollama GPU, small cap (e.g. 2) per CLI connector; extra requests queue. Pure queue module + tests, wired in `orchestrator.mjs`.
3. **Ledger/history rotation**: when `data/ledger.jsonl` / `tasks.jsonl` exceed a size cap, roll to `*.YYYYMMDD.jsonl` (no deletion). Tests.
4. **In-service scheduler** (SPEC "Blocks cutover"): simple timer module; first job = nightly `backup-data.ps1`. Config-driven, off by default. Tests.
5. Update `README.md` Status + `SPEC.md` checkboxes to match reality.

## Finish
- Publish: `powershell -File D:\HomeAIGit\HomeAI\Sync-Orchestrator.ps1 -Message "<summary>"` (commits only `orchestrator/`). Check `git status` there first that no `data/` or secret is staged.
- Append a short report to the bottom of this file: what was done, test output summary, anything blocked or needing Adam's decision.

## Report
_(Codex: write here)_

### Codex report - 2026-10-15
- Task 1: invoked `scripts/start.ps1`; the initial launcher hit duplicate Path/PATH environment entries. Retried with a deduplicated child environment and it reported the service healthy on port 18850. Node fetch then posted the requested `{connector:"codex", prompt:"Reply with OK"}`: HTTP 200, ok=true, text=OK, model=gpt-6.1-sol, 4,096 ms, 15,927 input tokens / 5 output tokens. No parser/runner defect was demonstrated by the API check, so those files were left unchanged.
- Fixed the smoke script's real Windows shell-quoting failure and stale hardcoded model. It now uses the service runner with stdin, configured models, stripped API-key environment, scratch cwd and meaningful failure exit codes. Added two offline smoke tests. README status and the SPEC live-verification checkbox match the API result.
- Tests: baseline `npm test` reported 58 passed / 0 failed; after the smoke change, `npm test` reported 60 passed / 0 failed. Final documentation verification and publication outcome are recorded below.
- Blocked: `node scripts/smoke.mjs codex` now reaches the runner but returns ok=false and exits 1: "Could not find home directory". A process-only explicit HOME/CODEX_HOME retry reached the existing profile but was denied access initializing Codex. No credentials were read or copied. Adam should rerun the smoke command from his normal user session. Per the handoff's stop-at-first-block rule, tasks 2 (concurrency), 3 (rotation), and 4 (scheduler) were not started; their SPEC boxes remain unchecked.
- No OpenClaw files or OneDrive files were modified. No installs, system configuration changes, messages, purchases, or data-file deletions were performed. Standalone Codex installation and auto-start still need Adam's action/approval as already listed in SPEC.
- Final verification: `npm test` after the documentation update reported 60 tests, 60 pass, 0 fail, 0 cancelled/skipped/todo. The final report-only append is checked again below in this run.
- Publication BLOCKED: checked repo status and staged names first (both empty); no destination-only publishable files would be deleted. Invoked the requested Sync-Orchestrator.ps1 with a process-only Git safe.directory override (no global Git configuration changes). Robocopy remained in retries and was stopped; Git then reported `Unable to create D:/HomeAIGit/HomeAI/.git/index.lock: Permission denied`. The script misleadingly printed `No orchestrator changes.` despite that failure. No commit or push was made. Adam should run `powershell -File D:\HomeAIGit\HomeAI\Sync-Orchestrator.ps1 -Message "Verify Codex API and fix configured connector smoke checks"` from his normal user session after reviewing these local changes.
