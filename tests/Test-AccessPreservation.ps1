$ErrorActionPreference='Stop'
$kit=Join-Path $PSScriptRoot '..\home-ai-kit'
. (Join-Path $kit 'Common.ps1')
. (Join-Path $kit 'Native-Chat-Config.ps1')
. (Join-Path $kit 'Workbench-Config.ps1')
. (Join-Path $kit 'Fleet-Config.ps1')
$settings=@{root='D:\HomeAI';mainModel='homeai-main:locked';context=16384;ollamaPort=11435;gatewayPort=18795}
$fixture=(New-HomeAIConfig $settings 'test-only-token' | ConvertTo-Json -Depth 50) | ConvertFrom-Json
$normal=Enable-HomeAINativeChatConfig $fixture $settings
if($normal.tools.exec.mode -ne 'ask' -or $normal.plugins.entries.codex.config.appServer.sandbox -ne 'read-only'){throw 'Default connector posture changed.'}
$full=($normal | ConvertTo-Json -Depth 50) | ConvertFrom-Json
$full.tools.PSObject.Properties.Remove('allow')
$full.tools.exec.mode='full'
$full.tools.profile='full'
$full.plugins.entries.codex.config.appServer.approvalPolicy='never'
$full.plugins.entries.codex.config.appServer.sandbox='danger-full-access'
$beforeDeny=@($full.tools.deny) -join ','
$updated=Enable-HomeAINativeChatConfig $full $settings
if($updated.tools.PSObject.Properties['allow']){throw 'Connector reintroduced a finite allowlist.'}
if($updated.tools.exec.mode -ne 'full' -or $updated.plugins.entries.codex.config.appServer.approvalPolicy -ne 'never' -or $updated.plugins.entries.codex.config.appServer.sandbox -ne 'danger-full-access'){throw 'Connector reset explicit operator native access.'}
if((@($updated.tools.deny) -join ',') -ne $beforeDeny){throw 'Connector removed explicit denies.'}
$roles=@{quick=@{status='not-installed'};vision=@{status='not-installed'}}
$updated=Set-HomeAIWorkbenchConfig $updated $settings $roles
if($updated.tools.PSObject.Properties['allow']){throw 'Workbench reintroduced a finite allowlist.'}
$updated=Set-HomeAIWorkbenchConfig $updated $settings $roles -Disabled
if($updated.tools.PSObject.Properties['allow']){throw 'Workbench disabled path reintroduced a finite allowlist.'}
$updated=Set-HomeAIFleetConfig $updated $settings
if($updated.tools.PSObject.Properties['allow']){throw 'Fleet reintroduced a finite main allowlist.'}
foreach($lane in @('codex','claude','local')){
 $worker=$updated.agents.entries.('homeai-worker-'+$lane)
 if(($worker.tools.allow -join ',') -ne 'homeai_project'){throw "Worker project scope changed for $lane"}
 if($worker.tools.exec.mode -ne 'ask'){throw 'Worker command policy broadened.'}
}
. (Join-Path $kit 'Execution-Config.ps1')
. (Join-Path $kit 'Adaptive-Config.ps1')
$updated=Set-HomeAIAdaptiveConfig $updated $settings
if($updated.tools.PSObject.Properties['allow']){throw 'Adaptive/execution upgrade reintroduced a finite main allowlist.'}
foreach($id in @('homeai-worker-codex-sol','homeai-worker-claude-sonnet','homeai-worker-local-fast','homeai-worker-local-coder')){if(($updated.agents.entries.$id.tools.allow -join ',') -ne 'homeai_project,homeai_check'){throw 'Adaptive worker scope broadened.'}}
Write-Output 'PASS: default restrictions retained; explicit operator full access survives connector/workbench/fleet updates; worker scopes and denies preserved.'
