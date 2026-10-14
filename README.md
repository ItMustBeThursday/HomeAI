# HomeAI

Windows home AI: local Qwen through Ollama, OpenClaw chat, and optional subscription-backed Codex and Claude Code runtimes.

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

The repair stops owned services, verifies a backup, changes requested and host policy to the human-approval `cautious` preset, and restarts HomeAI. It retains existing model routes, the finite memory/history tool list, and the read-only Codex sandbox. It does not reinstall clients or repeat account login. Backups exclude the exact generated `state\openclaw\npm\projects` dependency subtree, alongside the plugin-skill cache, and record these exclusions in the manifest. Configuration, conversations, npm metadata outside that subtree and actual user projects are preserved. Excluded runtimes require reinstalling their recorded plugin packages during a restore. The previous deny-all policy also blocked Codex runtime admission checks.

Claude is normally a fallback, rather than a separate chat window. To test it, send `/model anthropic/claude-opus-5-5`, then a short prompt and `/status`. Confirm the actual runtime is Claude Code, because a fallback may answer instead. Restore Codex with `/model openai/gpt-6-astra`.

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



