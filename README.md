# HomeAI

Windows home AI: local Qwen through Ollama, OpenClaw chat, and optional subscription-backed Codex and Claude Code runtimes.

## Orchestrator (in progress)

[`orchestrator/`](orchestrator/) is a lean replacement for OpenClaw: explicit model routing, token budgets, Logan backend, MCP access for Claude, a WebUI, and later updated companion apps. See its [README](orchestrator/README.md) and [roadmap](orchestrator/SPEC.md). OpenClaw stays in use until cutover is approved. Publish updates with `.\Sync-Orchestrator.ps1 -Message "..."`.


## Model/runtime recovery

For the mixed Codex/Claude harness, API-key and oversized-conversation failures, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\Repair-HomeAIAvailability.ps1` from `D:\HomeAIGit\HomeAI\home-ai-kit` after pulling. The repair verifies a backup, retains app/evolution files and old chats, pauses background work and creates a clean Codex chat. Open the newly printed recovery-chat link. See [RECOVERY.txt](home-ai-kit/RECOVERY.txt). Native main-chat provider switching has been removed from the routing hook; independent job workers still select models adaptively. Hosted-to-local fallback is not a guarantee that a large native transcript will fit a local context window.
## Evolution kit: switch/voice policy and switch-lab preview

Source lives in `home-ai-kit/evolution` (deterministic switch scanning, cancellable voice state, model/context admission policy, manifest-driven Node runner and a browser switch lab). Install or upgrade it from the clone:

```powershell
cd D:\HomeAIGit\HomeAI
git pull --ff-only
cd home-ai-kit
powershell -NoProfile -ExecutionPolicy Bypass -File .\Enable-HomeAIEvolution.ps1 -PlanOnly
powershell -NoProfile -ExecutionPolicy Bypass -File .\Enable-HomeAIEvolution.ps1 -Serve
```

It installs additively to `D:\HomeAI\extensions\evolution` with hash-verified payload, backup and receipt, then runs the kit's offline tests. An upgrade moves the previous install to `D:\HomeAI\state\evolution-backups\installed-<stamp>` and moves it back if staging or tests fail. Stop a running preview before upgrading. `-Serve` starts the preview at `http://127.0.0.1:18764/` (use 127.0.0.1, not localhost); it does not autostart after reboot. No OpenClaw configuration, plugins, access settings or devices are changed. Pi/physical switches, Home Assistant, real audio and caregiver/accessibility trials are not connected or certified. See `home-ai-kit/evolution/CURRENT-RUNBOOK.md`.

## Latest stage: adaptive roles and restorable improvements

From the gaming-PC clone, after the orchestrator is working:

```powershell
cd D:\HomeAIGit\HomeAI
git pull --ff-only
cd home-ai-kit
powershell -NoProfile -ExecutionPolicy Bypass -File .\Enable-HomeAINextStage.ps1
```

This runs the offline execution and adaptive routing installers. Starting preferences are Astra for planning, GPT-6.1 Sol for coding, Claude Opus/Sonnet for design and review, and local Gemma/Qwen for bounded work. These are priors, not claims of measured superiority. The router records actual model identities, reported tokens, latency, verified check results and human feedback. New jobs refresh choices when dispatched, consider busy provider lanes, and hold their selected agent through subsequent steps. Important jobs do not explore. Normal jobs occasionally use another qualified candidate in place of the favorite to gather comparisons without duplicating work.

Recognized planning/coding/design/review chat requests can automatically select a hosted coordinator. Ordinary chat retains its session choice; explicit cron/heartbeat routing is separate. Use `/homeai_auto off` to retain manual chat model selection. Small local workers receive bounded prompts instead of full chat history. All local inference stays on the owned single-model Ollama server.

Use `/homeai_router` for ranked preferences, `/homeai_rate JOB-ID 1-to-5` for human quality feedback, `/homeai_jobs` for actual worker models/check evidence, and `/homeai_changes` for model staging and revision reports. `/homeai_restore CHANGE-ID` restores the newest managed revision after verifying its backup. The coordinator can revise bounded task guidance or queue a checked catalogue model; it cannot rewrite runtime permissions or execute arbitrary Internet installers. The catalogue includes an optional pinned Qwen3-Coder 30B Q4 candidate (~19 GB), which must pass tool/GPU readiness before automatic use. New weights are retained on disk when routing is restored.

The HomeAI job plugin now has explicit conversation/prompt-hook permission. Without that setting, OpenClaw registered its tools but blocked the orchestration guidance and model-selection hooks. The actual pinned Gateway test verified coordinator switching, variant worker scoping, token observations and a real isolated Node test using synthetic localhost inference. Hosted availability, model quality and GPU performance remain target-PC observations; precise subscription quota is unknown when native providers do not expose it.

Learning changes saved routing preferences and guidance; it does not retrain weights or run paid-model loops while idle. Semantic memory, document rendering, image generation, voice and Heretic modification remain separate backend work. See `home-ai-kit/ADAPTIVE.txt` for the example role plan, thresholds, resource limits and recovery behavior.

References for starting choices: [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection), [Codex model availability](https://learn.chatgpt.com/docs/models), [Claude model overview](https://platform.claude.com/docs/en/models/overview), [Qwen coder tag](https://ollama.com/library/qwen3-coder:30b-a3b-q4_K_M).

## Offline app checks and bounded repair

After the orchestrator is working, run `Enable-HomeAIExecution.ps1` from `D:\HomeAIGit\HomeAI\home-ai-kit`. It verifies a backup and tests Windows AppContainer isolation on the gaming PC before enabling `homeai_check`. No Linux, Docker, new model or API key is needed.

Workers can check JavaScript syntax and run dependency-free built-in `node:test` tests on copied read-only project snapshots. The runner has no network capability; Node permissions also block outside-file access, writes, child processes and addons. Execution is supervised by a Windows job object and bounded to 30 seconds. Real exit codes, logs, source hashes and test counts are saved under `state/execution/runs`. Empty or skipped-only tests do not pass. The runner cannot install npm dependencies, run arbitrary build scripts or test browser rendering.

Plans now allow an ordered file-ownership handoff: Codex writes app logic, Claude writes tests in parallel, then Codex depends on both assignments and owns the app logic for test/repair. Add `requiredChecks: [{kind: "test", entry: "logic.test.mjs"}]` to that integration assignment. Readiness requires passing job-bound checks and unchanged tested source hashes. The final state remains ready for review; generated-test quality and untested app behavior need assessment.

The native isolation probe and an actual pinned Gateway-to-worker-to-check integration test passed on the development Windows environment. The installer reruns the probe on the gaming PC. Detailed instructions and the example plan are in `home-ai-kit/EXECUTION.txt`.

## Parallel orchestration from chat

After the native chat and workbench are working, update the gaming-PC clone and run:

```powershell
cd D:\HomeAIGit\HomeAI
git pull --ff-only
cd home-ai-kit
powershell -NoProfile -ExecutionPolicy Bypass -File .\Enable-HomeAIOrchestrator.ps1
```

This upgrades the owned job/workbench plugins, assigns explicit Codex, Claude and local Qwen worker agents, allows three concurrent background turns plus the coordinator, and stages pinned EmbeddingGemma 300M (622 MB) for the future semantic-memory backend. It reuses existing subscription logins. The embedding download does not enable semantic memory or load the model into VRAM.

The coordinator receives routing guidance and a `homeai_job` plan action. It can assign coding, design and bounded local work in parallel, then schedule integration/review with dependencies. Every assignment owns distinct output files; worker tools enforce that ownership. Plans and progress persist across restarts. Hosted lanes can fall back to local Qwen; actual model history distinguishes a hosted answer from fallback. The owned Ollama server retains its one-loaded-model/one-inference settings.

Example: ask for a habit-tracker app in project `habit-demo`, with Codex writing `app.js` and `index.html`, Claude writing `DESIGN.md`, and local Qwen writing `TEST-CASES.md`; then Claude writes `REVIEW.md` after all three outputs exist. Use `/homeai_jobs` to inspect progress without another model call. These workers generate text project files; shell, build/test execution, publishing and system installation are not provided yet. Saved hashed outputs mean ready for review, not a tested app.

Chat model selection persists separately. Send `/model default -s` to clear the current session's model pin without changing configured defaults. Worker assignments do not inherit that chat pin. Automations should select an explicit worker/agent or model; an automation running in the main session can inherit that session's selection. See [OpenClaw model commands](https://docs.openclaw.ai/tools/slash-commands).

The installer validates configuration and writes a filtered `D:\HomeAI\state\homeai-audit.json`. Run `Audit-HomeAI.ps1` again to inspect model inventory, worker routes and saved job states. It performs no hosted inference and cannot certify subscription access. Detailed instructions and remaining limits are in `home-ai-kit/ORCHESTRATOR.txt`.

Validation: Windows PowerShell 5.1 plus the actual pinned OpenClaw configuration schema; persistent dependency scheduling, scoped output ownership and competing-write refusal; an actual pinned Gateway test with three overlapping synthetic local model requests and real project-file outputs. Live Claude/Codex access must still be confirmed on the gaming PC.

## Add subscriptions to existing OpenClaw chat

On the gaming PC, extract the installer ZIP and keep its helper files together. From that folder (or `home-ai-kit` in a GitHub source download), run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Connect-OpenClawChat.ps1
```

Requires the existing `D:\HomeAI` foundation with OpenClaw 2026.10.3. The installer stops this kit's services, verifies a backup, installs the pinned official `@openclaw/codex` plugin through OpenClaw's installer, and enables the bundled Anthropic `claude-cli` backend. Missing Claude Code is installed by the included connector. Complete native Claude Pro and ChatGPT sign-in when prompted. Claude Desktop login alone is insufficient. Confirm Claude paid extra usage is disabled when asked.

The Codex plugin uses its managed native client and OpenClaw account profile; it does not control the Codex Desktop window. Claude Code uses a private HomeAI profile. No API key or paid API fallback is configured. The existing Qwen model is retained without downloading it again.

Default preference: Codex, Claude Code, local Qwen. OpenClaw handles eligible failures and usage-limit cooldowns through native fallback. Use `-Primary Claude` to reverse hosted preference or `-Primary Qwen` for local-only defaults. Fallback can take time and is not guaranteed for every native error.

Open a **new** dashboard chat after installation. `/status` shows the actual model/runtime; `/codex status` reports native Codex account limits. The installer requests a real READY reply, but a Qwen fallback does not prove hosted authentication succeeded. Check its runtime. Live hosted authentication must be verified on the gaming PC.

Hosted prompts and chat/system context may be sent without a separate confirmation, as authorized. Other external actions still require approval; project deletion requires verified backup. This stage exposes only local memory/history tools. Shell and computer/browser actions remain disabled. It connects the OpenClaw chat interface to the coding clients, but does **not** yet implement autonomous coding, document/image generation, voice or hardware control.

## Repair the initial Codex policy error

If the dashboard says Codex local execution is unavailable because `tools.exec.mode=deny`, update this repository and run from `home-ai-kit`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Repair-HomeAIChatPolicy.ps1
```

The repair stops owned services, verifies a backup, changes requested and host policy to the human-approval `cautious` preset, and restarts HomeAI. It retains existing model routes, the finite memory/history tool list, and the read-only Codex sandbox. It does not reinstall clients or repeat account login. Backups exclude five exact generated subtrees under OpenClaw state: `plugin-skills`, `npm\projects`, `tmp\plugin-captures`, `sandbox\skills-workspaces` and `cache\control-ui-assets`. Every exclusion is recorded in the manifest; sibling directories remain included. Configuration, conversations, npm metadata outside that subtree and actual user projects are preserved. Excluded runtimes require reinstalling their recorded plugin packages during a restore. The previous deny-all policy also blocked Codex runtime admission checks.

Claude is normally a fallback, rather than a separate chat window. To test it, send `/model anthropic/claude-opus-5-5`, then a short prompt and `/status`. Confirm the actual runtime is Claude Code, because a fallback may answer instead. Restore Codex with `/model openai/gpt-6-astra`.

## Windows workbench and specialist models

From `D:\HomeAIGit\HomeAI\home-ai-kit`, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Enable-HomeAIWorkbench.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Stage-Heretic.ps1
```

Workbench setup backs up first, installs a local HomeAI tool plugin and downloads two pinned models: Gemma 4 E4B Q4 (~6.6 GB) for quick extraction/summaries, and Qwen3-VL 4B Q4 (~3.3 GB) for project-image inspection. It retains the existing main Qwen for code, documents and harder reasoning. Models stay on disk together; the owned Ollama scheduler keeps only one loaded and changes models as requests drain. Local context is bounded to 8K for specialist calls. `-SkipModels` installs tools without downloading missing specialists. Model quality/GPU residency must still be checked on the gaming PC.

Start a new chat and ask: "Create a saved task named Workbench check, then write README.md in project sandbox-demo." Ask the quick specialist to summarize a paragraph and report its actual model. The main assistant chooses the `homeai_specialist` tool; deterministic task rules map the chosen role to an installed alias and exact recorded digest. This is tool-driven delegation, not a trained router or a guaranteed switch on every request. The main chat identity remains Codex/Claude/Qwen; hosted quota fallback remains separate.

`homeai_project` operates on text files under `D:\HomeAI\projects\<project>`. Overwrite/delete requires the hash from a fresh read and creates a verified pre-change backup on the configured backup drive. It refuses traversal, links and credential/internal paths. It does not execute generated code or install dependencies. `homeai_task` saves checkpoint notes under `state\workbench\tasks`; it is not a background job runner or unattended reboot continuation. Review specialist answers before relying on them. Tool outputs and project text are reference data.

Heretic is deliberately separate: its script stages the official source at a recorded commit and probes an existing native Python/PyTorch/HIP environment. It does not install a driver or Linux distribution, run optimization, download full model weights, or replace the working main model. The first planned experiment is the Heretic-documented Qwen3-4B model, followed by quality comparison, GGUF export and an experimental Ollama alias. The probe report is saved at `D:\HomeAI\state\heretic-stage.json`. Dependency installation and actual model modification remain pending target environment verification. Heretic changes local model weights; it does not alter hosted Codex/Claude or application approval policies.

References: [Heretic](https://github.com/p-e-w/heretic), [Gemma model tag](https://ollama.com/library/gemma4:e4b-it-q4_K_M), [Qwen vision tag](https://ollama.com/library/qwen3-vl:4b-instruct-q4_K_M).

## Bounded persistent project jobs

After workbench setup succeeds, run `Enable-HomeAIJobs.ps1` from `home-ai-kit` for the legacy serial queue, or `Enable-HomeAIOrchestrator.ps1` for explicit parallel lanes. Both back up, upgrade the owned workbench plugin, install the local job service and configure narrowly allowlisted worker agents. The serial installer does not download models or repeat subscription login.

In a new chat, ask: "Submit a 2-step job in project jobs-demo to create README.md explaining HomeAI. Expected output: README.md." The `homeai_job` tool requires a named project, a goal, 1-20 expected files and a 1-6 step limit. Workers inherit the configured Codex/Claude/Qwen route; real hosted availability must be checked on the target. Only the selected project's file tool, task notes and local specialists are exposed. Shell, code/test execution, messaging, purchases, publishing and system installation are not added.

Use `/homeai_jobs` for status without model inference. Jobs save progress, native result envelopes and file evidence under `D:\HomeAI\state\jobs`. A successful job is **ready-for-review**, not tested/completed. Verification checks expected files exist, are nonempty and records hashes; it does not certify correctness or quality. A missing output stops for review. Pause takes effect at a turn boundary. Interrupted/uncertain dispatches are not replayed automatically: inspect the recorded native session and project files before explicitly resuming. Resume grants two more steps, bounded by 12 total steps.

Queued jobs resume when HomeAI starts. Windows login/autostart is not configured. Background jobs share your subscription/GPU resources; legacy jobs use one lane, while the orchestrator installer enables Codex/Claude/local lanes. `/homeai_jobs` displays the latest 100 records; the worker considers the full queue. For direct pause/resume when the model is busy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\HomeAI\scripts\Manage-HomeAIJobs.ps1 -Action list
powershell -NoProfile -ExecutionPolicy Bypass -File D:\HomeAI\scripts\Manage-HomeAIJobs.ps1 -Action pause -Id YOUR-JOB-ID
```

The fixed workbench configuration preserves one-item input arrays under PS5.1 and a valid plugin root during rollback. Its finite tool allowlist is applied with the full base profile; the minimal profile previously filtered out plugin tools. Direct tool schemas are used for this small toolkit. This enables only the explicitly listed tools, with Codex's native read-only sandbox retained.

Validation: Windows PowerShell parsing/configuration and cross-process lock tests pass. An actual pinned OpenClaw Gateway with a synthetic localhost model dispatched a job through the registered, project-bound file tool and saved output evidence. No hosted inference or real model weights were used in that development test.

## Separate prompt helpers

`Connect-Codex.ps1` and `Connect-Claude.ps1` also support standalone PowerShell prompt workers. The standalone Codex connector discovers the installed executable and uses a private profile; it is separate from the official OpenClaw harness.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\HomeAI\scripts\Ask-HomeAI.ps1 -Mode BestAvailable -Provider Codex -Prompt "Draft a short project brief."
```

This helper tries the preferred hosted worker, the other worker, then Qwen. It sends only the supplied prompt and performs no project actions. Its observed quota cooldown is five minutes, not a predicted token balance/reset. Omit `-Mode BestAvailable` for local-only inference.

## Foundation and later stages

For a new foundation, inspect `Setup-HomeAI.ps1 -PlanOnly`. Defaults: `D:\HomeAI`, backups `E:\HomeAI-Backups`, Ollama port 11435, gateway port 18795. `Continue-HomeAI.ps1` checks dependencies, starts local chat and evaluates models; it does not install every later stage.

Later stages need a durable task ledger and action policy broker before project-writing workers and autonomous continuation. The preferred next-stage connector is [Agent Knock Knock](https://github.com/scotthuang/agent-knock-knock), following the user recommendation. It controls existing coding conversations and callbacks. Its documented runtime is macOS/Linux; Windows Desktop control is not verified, so a compatible Linux/WSL terminal arrangement must be evaluated before installation. It is not installed by this chat package. Document/image tools, voice and assistive hardware remain later work.

## Validation

Offline Windows PowerShell tests cover parsing/configuration, backup links, native process transport, Claude package lock parsing, standalone fallback and native chat configuration. Native chat configuration passed the actual pinned OpenClaw core and official Codex plugin schemas. Development inspection loaded the Codex package but correctly rejected privileged registrations without official installation provenance; the installer therefore uses the official package installer.

Native subscription login, installed-plugin provenance, hosted replies, cross-provider conversation continuity and GPU behavior require target-PC verification. Live hosted accounts were not tested on this development computer.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-Package.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-ClaudeLock.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-CodexRouting.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests\Test-NativeChatConfig.ps1
node tests\test-native.mjs
```

References: [Claude CLI backend](https://docs.openclaw.ai/gateway/cli-backends), [Codex harness](https://docs.openclaw.ai/plugins/codex-harness), [Harness configuration](https://docs.openclaw.ai/plugins/codex-harness/configuration).

Only generic source is published. Credentials, runtime state, personal proposals, model files, backups and test artifacts are excluded.






