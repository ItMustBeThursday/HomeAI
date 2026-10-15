# Current operations and handoff

This document supersedes operational claims in OPERATIONS.md, ACCESS-PLAN.md and HANDOFF.md. Those files are historical assignment outputs. Actual current evidence is RELEASE-EVIDENCE.json and its source hashes.

## Source and additive installation

Source: `D:\HomeAI\projects\homeai-evolution`. Additive payload: `D:\HomeAI\extensions\evolution\payload`. No existing service or plugin is replaced. Run commands from the source directory:

```powershell
node run-kit.mjs validate runner.example.json
node run-kit.mjs test runner.example.json
node run-kit.mjs serve simulator.manifest.json --allow-build --allow-serve
```

Open `http://127.0.0.1:18764/`; `localhost` is deliberately refused by Host validation. Only Node execution is verified. Other toolchains require actual installed native executables. Build permission allows reviewed project code execution; this is not a sandbox or implicit installation permission.

## Staging and launcher

```powershell
.\Prepare-HomeAIEvolution.ps1 -Mode PlanOnly
.\Prepare-HomeAIEvolution.ps1 -Mode Stage
.\Start-HomeAIEvolution.ps1 -Action test -NodeExe D:\HomeAI\runtime\node-v24.21.0-win-x64\node.exe
.\Start-HomeAIEvolution.ps1 -Action serve -Manifest simulator.manifest.json -AllowBuild -AllowServe -NodeExe D:\HomeAI\runtime\node-v24.21.0-win-x64\node.exe
```

Prepare stages exact allowlisted sources and generates manifests using the correct payload root. Sources and backup copies are hash-verified. Existing destinations are refused, never merged. Launcher verifies the complete receipt-owned inventory before execution. Fixture destinations are restricted to `D:\HomeAI\state\evolution-fixtures\<simple-name>`. The actual Windows PowerShell 5.1 `-File` default-root bug was fixed.

Rollback removes only unchanged receipt-owned payload files, retaining backups/receipts. Changed, unknown or generated output blocks rollback. In particular, after a build preserve `payload\dist` outside payload before rollback; never delete unknown material just to force removal. Existing destinations cannot be restaged in place.

## Checks

```powershell
node verify-release.mjs
```

This runs real node:test contract/host/staging suites, live HTTP assertions and headless Edge through the actual runner using the already-installed browser automation dependency. It writes logs and source-hashed evidence. `all.test.mjs` is also the offline AppContainer entry; host/staging tests must remain outside that entry.

Node test steps add `--test-isolation=none` internally for real execution, avoiding Node's Windows test-file fork on timeout/cancel. Injected unit adapters retain declared arguments. Arbitrary project code may still create descendants; direct-child cleanup is not process containment. Windows SIGTERM process-stop checks do not certify graceful console Ctrl+C handling.

## Contract updates and preview behavior

- Hosted ranking no longer requires fictional VRAM. Local ranking still requires measured VRAM; other quality/context/latency/digest gates are unchanged. The old hosted-no-VRAM exclusion assertion was replaced by a positive hosted test plus retained local/unknown-metric rejection checks.
- `createVoiceSession` accepts `maxRequests=4096`, integer 1..65536. New starts reject `session-capacity` at the bound without changing state. IDs are never evicted/reused; detach old callbacks/transports before creating a new controller. This bounds memory without reopening stale responses.
- All switch timestamps must already be translated to a trusted hub-monotonic clock. Backward cross-device clocks fail closed. No raw Pi clock adapter is claimed.
- Demo speech is on by default and initial choice is announced. Scanning waits for speech completion, configurable acceptance delay and a full scan dwell. Missing/failed speech and focus loss pause. Repeat, Cancel and Help are local-only actions. Timing defaults are developer settings, not child suitability recommendations.
- New exact-effect regressions cover A-B-A replay, first/late tick semantics, equal and backward cross-device timestamps, bounded voice IDs and hosted/local admission differences.

## Preserved state and model provenance

The owner already selected Full Access. This finish did not replay setup or alter access/credentials. Existing user repository modifications were preserved; prior worker/installer diffs were reviewed and existing access-preservation/dispatch tests executed. No Git commit/push, downloads, installs or device actuation.

The failing continuity watcher was inspected and disabled, not replaced with a paid polling loop. Saved job records remain historical; their old ready-for-review hashes do not certify modified files.

Actual original models: core/contracts gpt-6.1-sol, runner gpt-6-astra, independent tests/integration/final review claude-opus-5-5, bounded capability extraction homeai-fast:locked. An early provider failure used a local fallback before later actual Claude completion. Existing routing used role priors and observed latency; no human rating was fabricated. This finish uses the interactive gpt-6.1-sol coordinator and is not a new independent Claude review.

Future work needs real hardware/evidence: Pi/switch/HA adapters and harmless bench targets; microphone/speaker, screen-reader and caregiver evaluation; measured live-router candidate admission; non-Node compilers and native Heretic compatibility. Video stays deferred.
