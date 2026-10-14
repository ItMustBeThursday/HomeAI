$ErrorActionPreference='Stop'
$kit=Join-Path $PSScriptRoot '..\home-ai-kit'
. (Join-Path $kit 'Common.ps1')
. (Join-Path $kit 'Native-Chat-Config.ps1')
$settings=@{root='D:\HomeAI';mainModel='homeai-main:locked';context=16384;ollamaPort=11435;gatewayPort=18795}
$config=(New-HomeAIConfig $settings 'fixture-token' | ConvertTo-Json -Depth 30) | ConvertFrom-Json
$changed=Enable-HomeAINativeChatConfig $config $settings
if($changed.agents.defaults.model.primary -ne 'openai/gpt-6-astra'){throw 'Codex is not primary.'}
if(($changed.agents.defaults.model.fallbacks -join ',') -ne 'anthropic/claude-opus-5-5,ollama/homeai-main:locked'){throw 'Fallback order differs.'}
if($changed.agents.defaults.models['openai/gpt-6-astra'].agentRuntime.id -ne 'codex'){throw 'Codex native runtime not pinned.'}
if($changed.agents.defaults.models['anthropic/claude-opus-5-5'].agentRuntime.id -ne 'claude-cli'){throw 'Claude native runtime not pinned.'}
if($changed.tools.PSObject.Properties['alsoAllow']){throw 'Conflicting alsoAllow retained.'}
if(($changed.tools.allow -join ',') -ne 'memory_search,memory_get,sessions_history'){throw 'Action tools enabled.'}
if($changed.plugins.entries.codex.config.appServer.sandbox -ne 'read-only' -or $changed.tools.exec.mode -ne 'deny'){throw 'Execution protection weakened.'}
if($changed.plugins.entries.codex.config.computerUse.enabled -or $changed.plugins.entries.codex.config.codexPlugins.enabled){throw 'Native external actions enabled.'}
$changed=Enable-HomeAINativeChatConfig (($changed | ConvertTo-Json -Depth 40) | ConvertFrom-Json) $settings 'Qwen'
if($changed.agents.defaults.model.primary -ne 'ollama/homeai-main:locked' -or $changed.agents.defaults.model.fallbacks.Count){throw 'Local-only option is not local-only.'}
$changed=Enable-HomeAINativeChatConfig $changed $settings 'Codex'
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\native-chat-config.json') $changed
Write-Output 'PASS: official native runtimes, automatic fallback order, local-only option, finite read-only tool policy, deny exec, no computer/app plugins, local housekeeping.'
