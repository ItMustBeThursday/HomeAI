# Local setup checkpoint — 2026-10-15

This sanitized record captures machine-local setup work after the evolution-kit
commit `668ae1a`. It is documentation, not an installer or a portable configuration
backup. Private workspace memory, transcripts, authentication, runtime databases,
model weights and full live configuration intentionally remain outside this repo.

## Memory

- Builtin OpenClaw memory uses `memory.search.provider=ollama` and
  `homeai-embedding:locked`, served locally on port 11435.
- `agents.defaults.compaction.memoryFlush.enabled=true` enables pre-compaction
  saving. An actual automatic compaction save has not yet been demonstrated.
- Main-agent bootstrap limits were increased to 12,000 characters per file and
  30,000 total; worker limits were unchanged. USER.md retains its product cap.
- Existing nightly memory processing remains at 03:00 America/New_York.
  Promotion gates were retained; zero promotions is valid, not a failure.
- Workspace guidance now requires dated checkpoints and source-freshness checks.
- Post-restart verification on October 15 retrieved three durable facts using
  the local embedding provider. Configuration and deep embedding checks passed.
  Aggregate index dirty status and an intermittent search timeout were observed;
  this is not a claim of perfect recall or timeout-free operation.

## Local models and reverse engineering

- Installed aliases: `homeai-main:locked`, `homeai-fast:locked`,
  `homeai-vision:locked`, `homeai-embedding:locked`, `homeai-coder:locked`.
- Coder is Qwen3-Coder 30B A3B Q4_K_M. Earlier tool-use/GPU checks were reported
  successful; broad real-task quality remains unmeasured.
- REA (`rea-agents` 6.5.0) was registered with launch argument `--mcp`.
  Earlier live verification discovered 207 tools and completed `binary_session`.
  Optional Ghidra/Hopper/IDA/jadx engines are not configured.
- Heretic source was staged only; compatibility and execution remain unverified.

## Existing implementation and remaining work

The tracked evolution kit contains switch/voice policy, a manifest-driven Node
runner, model/context admission logic, an accessible preview and backed-up
PowerShell deployment. See `evolution/CURRENT-RUNBOOK.md` for its dated evidence.
No implementation tests were rerun for this documentation-only checkpoint.

The failed development-continuity watcher remains disabled. Memory maintenance
does not implicitly resume background development. Physical Pi/switch/Home
Assistant integration, real audio and caregiver trials, non-Node compilation
and broader routing-quality measurement remain unfinished. Video stays deferred.

## Recommended next sequence

1. Run one representative real application through plan, implementation, tests,
   build, serve and review; retain actual model, cost/usage and failure evidence.
2. Fix the reliability gaps exposed by that task, including memory cold-start
   latency and supervised pre-compaction persistence verification.
3. Repair the paused continuation watcher with bounded retries and explicit
   failure reporting before considering re-enabling unattended work.
4. Validate real speaker/microphone operation and a single physical switch,
   then expand to the remaining Pis and Home Assistant with caregiver testing.

Installed script copies can lag the tracked kit: comparison on October 15 found
an older workbench installer and roadmap locally. Do not overwrite newer tracked
sources with those installed copies merely to make directories match.
