# Code review and source reconciliation - 2026-10-16

Scope: active HomeAI orchestrator, host toolkit, evolution lab, Discord bridge and companion desktop/remote/Android sources. Codex inspected and changed code, Claude Sonnet performed two tool-disabled subscription reviews, and Codex verified and addressed the findings. This is a broad engineering review with targeted deeper inspection, not a claim that every line or every live workflow has been exhaustively verified.

## Changes

- Coalesce concurrent status probes per configuration. Twenty concurrent callers share one probe set instead of starting twenty sets of CLI/HTTP checks. Unknown backend kinds no longer break the entire status response.
- Compute memory keyword scores once. Replace repeated scans of preceding ranked records with a single source-count map, preserving selections and ordering.
- Fix limiter deadlock for inherited JavaScript property names such as constructor/toString.
- Replace scheduled unverified backup/pruning with SHA-256-verified snapshots, file flushes and a completion manifest. Exclude private/scratch/log content, refuse links and overlapping/OneDrive paths, reject missing sources, and retain old snapshots. The general host backup also excludes orchestrator private/scratch data.
- Harden source synchronization: snapshot and verify destination files before mirrored deletions, scan large files too, scan the mirrored source, refuse links and exclude OneDrive consistently. Publishing now requires explicit -Push. The credential scan is heuristic, not proof of absence.
- Restore run-native.mjs and read-claude-lock.mjs: unfinished legacy cleanup deleted them while current subscription connectors still required them.
- Complete the existing staged legacy cleanup, remove its orphaned access-preservation test, and archive 17 obsolete installed host scripts/docs after hash verification. Keep restoration compatibility tests/exclusions and legacy companion source until migration/cutover is approved.
- Replace stale current setup/operation docs. Historical removal claims are not cutover authorization. Preserve OpenClaw. Add current Discord and companion source to Git, excluding private provisioning assets, local SDK paths, signing keys, runtime state and generated output.
- Idle deployment watcher now waits for queued/running jobs as well as model queues. Source version 0.32.2; deployment is separate from source publication.

## Observed validation

| Area | Result |
|---|---|
| Orchestrator offline suite | 339 passed; no failures/skips |
| Evolution offline contracts | 88 passed |
| Discord bridge | 19 passed |
| Companion desktop | 16 passed |
| Companion remote policy | 44 passed |
| Android offline unit tests | 9 passed, no failures/errors/skips |
| Android offline lint | 0 errors, 4 warnings; Gradle build successful |
| Host package | 47 checks passed |
| Backup links, snapshot and restore | Passed, including link refusal, corrupt-snapshot refusal and retained pre-restore backup |
| Installed Codex capability check | Passed without inference/login |
| Published JavaScript syntax | 140 tracked files passed |
| Host/kit/orchestrator PowerShell syntax | Passed |
| Real data/config backup | 2,515 files verified; private/scratch excluded; older snapshots retained |

Android initially failed with an empty alternate Gradle cache; reusing the existing user cache passed entirely offline. Two old host tests initially failed because they did not provision their pinned Node fixture and asserted outdated wrapper behavior; repaired and rerun successfully. Broad repository test discovery was stopped without a result because generated fixture trees and manual live-check scripts are unsuitable for automatic root discovery; use the explicit suites above.

Synthetic 2,500-record diversity-filter benchmark: identical 1,500 selections, old 679.8 ms / new 0.6 ms in one run. This isolates that algorithm; it excludes file I/O, embeddings, model throughput and end-to-end response latency.

Local evidence: D:/HomeAI/logs/review-*-20261016.log, claude-code-review-20261016.json, claude-final-review-20261016.json; D:/HomeAI/evaluations/code-review-performance-20261016.json and publication-scan-20261016.json.

## Recovery and outstanding work

Initial hash-verified code/host snapshot plus verified complete Git bundle: D:/HomeAI/backups/code-review-20261016-212132. Retired installed files: D:/HomeAI/trash/legacy-host-scripts-20261016-review. The publisher also creates a verified pre-mirror snapshot. Runtime data backups remain local.

The live API reported 0.32.0 during this review. Its process is an ancestor of this active Codex job; restarting now would kill the job. Deployment of 0.32.2 is handed to the job-and-queue idle watcher and is unverified until its health verification succeeds. No OpenClaw process, configuration or endpoint was changed. No listener on 18789 was observed; that alone does not establish cutover or justify runtime removal.

Companion API migration, real device/Logan integration, browser reattached Stop/media continuity acceptance and local-backend supervision remain open. Existing private content in older backups was not audited or purged. No guarantee of atomic multi-file live snapshots, power-loss recovery, or general model quality is made. Full hardware/media/end-to-end acceptance was not repeated by this code review.

Performance follow-ups identified but not changed: media endpoints in server.mjs still read entire files synchronously, which can block the event loop and allocate large buffers; stream/range responses deserve a separate playback regression pass. Memory retrieval still reads all note files per query; a bounded cache would need explicit invalidation for external edits and corrupt-file recovery. Jobs persist whole JSON snapshots during progress updates; further batching must preserve interruption recovery. These are candidates, not measured speedups.
