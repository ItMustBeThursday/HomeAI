$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Test-ExecutionConfig.ps1')
. (Join-Path $kit 'Adaptive-Config.ps1')
$adaptive=Set-HomeAIAdaptiveConfig $execution $settings
if($adaptive.agents.entries.'homeai-worker-codex-sol'.model.primary -ne 'openai/gpt-6.1-sol'){throw 'Sol worker model differs.'}
if('openai/gpt-6.1-sol' -notin $adaptive.agents.defaults.modelPolicy.allow){throw 'Model policy omitted Sol.'}
if(-not $adaptive.plugins.entries.'homeai-jobs'.hooks.allowConversationAccess -or -not $adaptive.plugins.entries.'homeai-jobs'.hooks.allowPromptInjection){throw 'Routing/guidance hooks would be blocked.'}
foreach($id in @('homeai-worker-codex-sol','homeai-worker-claude-sonnet','homeai-worker-local-fast','homeai-worker-local-coder')){if(($adaptive.agents.entries.$id.tools.allow -join ',') -ne 'homeai_project,homeai_check'){throw 'Variant worker gained unrelated tools.'}}
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\adaptive-config.json') $adaptive
Write-Output 'PASS: explicit variant runtimes, model policy allows new models, narrow worker tools and managed main tools.'
