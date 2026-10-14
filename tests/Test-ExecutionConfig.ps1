$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Test-FleetConfig.ps1')
. (Join-Path $kit 'Execution-Config.ps1')
$execution=Set-HomeAIExecutionConfig $fleet $settings
$json=($execution | ConvertTo-Json -Depth 50) | ConvertFrom-Json
if(-not $json.plugins.entries.'homeai-execution'.enabled -or $json.plugins.entries.'homeai-execution'.config.root -ne $settings.root){throw 'Execution plugin is invalid.'}
foreach($lane in @('codex','claude','local')){if(($json.agents.entries.('homeai-worker-'+$lane).tools.allow -join ',') -ne 'homeai_project,homeai_check'){throw 'Execution worker tool policy differs.'}}
$again=Set-HomeAIFleetConfig $execution $settings
$again=Enable-HomeAINativeChatConfig $again $settings
if('homeai_check' -notin $again.tools.allow -or 'homeai_check' -notin $again.agents.entries.'homeai-worker-codex'.tools.allow){throw 'Reconnection lost execution tools.'}
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\execution-config.json') $execution
Write-Output 'PASS: PS5.1 execution config and preserved worker/check tools on reconnection.'
