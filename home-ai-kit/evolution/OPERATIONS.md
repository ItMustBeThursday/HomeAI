# HomeAI evolution: staged operations

> Historical assignment output. Superseded by CURRENT-RUNBOOK.md, STATUS.md and current source-hashed RELEASE-EVIDENCE.json.

Status: review artifacts only, 2026-10-14. Neither PowerShell script has been parsed or executed on Windows. No deployment, integration, host test, device test or live-setting change is claimed. Required checks for this assignment: none. Human review is not functional certification.

## Scope and preservation

This kit is additive, not a replacement for the running OpenClaw/HomeAI installation. Do not touch D:\HomeAIGit\HomeAI, its uncommitted Backup-HomeAI.ps1/Common.ps1/Test-Package.ps1 changes or new Restore-HomeAI.ps1/Test-Restore.ps1, runtime configuration, credentials, services or account state. Existing backup locations on D/E are the user's layout, not assumed paths or available capacity.

Prepare owns only a newly created D:\HomeAI\extensions\evolution tree. Its source must be a separate D/E directory containing the exact allowlisted files. No recursive copy occurs. No .env, credential/config store, model, logs, repository history or arbitrary backup folders are copied. Review allowlisted source content for accidentally embedded secrets before staging; filename allowlisting cannot detect secrets inside code/docs.

Existing destinations are refused, even if marked as owned. This first-stage installer intentionally has no in-place upgrade/adoption path. Unknown files are never overwritten. PlanOnly also refuses an occupied destination so the plan cannot imply a safe merge. No automatic dependency installation or downloads.

## Reviewed script interface (manual examples, NOT executed here)

Run in Windows PowerShell 5.1 after source review, using the actual source directory. No execution-policy bypass is suggested.

~~~powershell
# From the source project directory:
.\Prepare-HomeAIEvolution.ps1
# Explicit, separate local file staging only:
.\Prepare-HomeAIEvolution.ps1 -Mode Stage
~~~

Default PlanOnly validates paths, checks the complete allowlist, computes SHA-256 and prints the intended file inventory and generated manifest without creating directories/backups or executing Node. Source and destination must be disjoint; D/E local absolute paths only, no traversal/streams/reparse ancestors.

Stage creates backup and payload directories inside the fresh owned destination. Each allowlisted source file is hash-checked before and after a non-overwriting copy into backup; payload copies come from verified backup bytes. A generated kit.manifest.json sets projectRoot to the actual payload and declares node --test all.test.mjs with a 60-second timeout. The repository's runner.example.json is reference only: its root is not assumed suitable and it is not copied. Identical receipts in the root and backup record all source/generated file hashes. A receipt is local integrity metadata, not a signature or proof of software correctness.

If staging fails, it does not claim success, automatically delete files or retry into the partial destination. Retain it for inspection and verified recovery; do not simply remove unknown contents. A failure before receipts are complete requires manual review.

~~~powershell
# Substitute a verified, installed Node >=24 .exe located on D/E.
.\Start-HomeAIEvolution.ps1 -NodeExe 'D:\verified-node\node.exe'
# Explicit execution of the generated test-only manifest:
.\Start-HomeAIEvolution.ps1 -NodeExe 'D:\verified-node\node.exe' -Action test
~~~

The Node path above is a placeholder, not observed installed evidence. C-drive executable paths are intentionally not accepted by these D/E-scoped launchers. If the only available Node is on C, stop for a separately scoped executable-access decision; do not copy/install a binary or broaden access automatically.

Start verifies the sealed file inventory, current payload hashes and backup hashes, and invokes the real run-kit.mjs CLI. It defaults to validate: lexical manifest/plan checks, not process execution of declared steps, filesystem preflight certification or network binding. Node's own CLI process does run when this launcher is manually used. Product-version metadata must indicate >=24; independently verify installed Node provenance and actual version, since PE metadata alone is not identity proof.

Supported actions are validate/run/test/build/serve; supported options are --allow-build, --allow-serve and --tool=name=absoluteExecutablePath. No invented --host, --dry-run or install flags. PowerShell AllowBuild/AllowServe map to those real options; ToolPaths accepts npm/dotnet/cargo/cmake native .exe paths. Windows .cmd/.bat wrappers are refused, so ordinary npm.cmd may be unavailable. Do not silently route it through a shell.

The generated manifest cannot build or serve. To review a different manifest, create a separately reviewed simple JSON filename in payload, with the same canonical projectRoot, safe relative arguments, tools, bounded timeouts and (for serve) an explicit build/compile step and artifact directory/port. Pass -Manifest that filename; build/compile and non-node tools need -AllowBuild, serving additionally needs -Action serve -AllowServe. Such custom manifests are not in the stage receipt; hash/review them separately before execution. They count as unknown additions for rollback and must be preserved/reviewed rather than deleted by rollback. A plan flag is caller authorization, not OS containment or install/network approval.

The launcher starts an absolute Node .exe with a clean environment (only SystemRoot/WINDIR), explicit working directory, no shell, PATH or NODE_OPTIONS. No package manager runs automatically. Declarations/tests may still execute arbitrary project code. Neither cwd nor these flags prohibit that code from accessing disks/network. Host restrictions must be separately verified.

Serve binds only 127.0.0.1 through the runner; no LAN/public bind, firewall change, tunnel or browser opening. It needs a real successful build and the unchanged in-process run record, takes a bounded immutable artifact snapshot and performs a loopback HTTP health check. HTTP health is not browser/function/accessibility correctness. Ctrl+C cancels foreground work; verify cancellation on the actual host. Windows cleanup evidence covers the direct child, not escaped descendants; closing PowerShell alone is not proof every process stopped.

## Rollback and recovery

Rollback means remove this staged payload, not restore/reconfigure the live runtime (which was never changed).

~~~powershell
.\Prepare-HomeAIEvolution.ps1 -Mode Rollback
~~~

Rollback validates ownership, matching receipt copies, exact file names/counts, all backup hashes and all payload hashes. Any changed/missing/unknown payload file stops it before deletion. Immediately before each individual deletion it rechecks payload and the verified restorable backup. It leaves backup, both receipts, OWNER.txt and the payload directory intact. No recursive deletion, directory cleanup, runtime restore, source replacement or unknown-file overwrite occurs. Stop any manually launched kit process first.

Recovery after rollback: manually review the retained receipt/backups and copy only verified files to their absent exact payload targets; verify every resulting digest. The scripts intentionally do not provide an automatic restore-overwrite option. A partly completed rollback stops safely on changed data but may already have removed earlier verified files; retain all backups. After rollback the destination still exists, so Stage continues to refuse it.

Filesystem checks assume a trusted local operator and a quiescent tree. PS5.1 path/hash checks are not atomic against a malicious concurrent writer; hashes/receipts can be replaced together by an attacker and hardlinks are not fully certified by these scripts. Do not run against actively changing/untrusted paths. This is not a sandbox or tamper-proof installer.

## Next verification gate

Before any manual execution: review PowerShell 5.1 parsing/quoting and no-write PlanOnly behavior; check actual D/E source layout, disk space, installed Node provenance/version, ACLs and backup policy. Then use a disposable, separately authorized host fixture for initial Stage, destination-conflict, source-mutation, hash-tamper, rollback and failure-recovery checks. The fixed production destination must not be used as an unreviewed test fixture; a reviewed test copy would need a separately scoped destination. Follow with genuine runner tests/build evidence, HTTP/browser checks and device tests as appropriate. No such checks ran in this step.
