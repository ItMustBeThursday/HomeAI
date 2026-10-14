# HomeAI

Windows home AI: local Qwen through Ollama, OpenClaw chat, and optional subscription-backed Codex and Claude Code runtimes.

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






