$ErrorActionPreference='Stop'
$kit=Join-Path $PSScriptRoot '..\home-ai-kit'
. (Join-Path $kit 'Common.ps1')
. (Join-Path $kit 'Native-Chat-Config.ps1')
. (Join-Path $kit 'Workbench-Config.ps1')
$settings=@{root='D:\HomeAI';mainModel='homeai-main:locked';context=16384;ollamaPort=11435;gatewayPort=18795}
$base=Enable-HomeAINativeChatConfig ((New-HomeAIConfig $settings 'fixture-token' | ConvertTo-Json -Depth 30) | ConvertFrom-Json) $settings
$roles=@{quick=@{status='installed';model='homeai-fast:locked'};vision=@{status='installed';model='homeai-vision:locked'}}
$config=Set-HomeAIWorkbenchConfig $base $settings $roles
$serialized=($config | ConvertTo-Json -Depth 40) | ConvertFrom-Json
$fast=@($serialized.models.providers.ollama.models | Where-Object {$_.id -eq 'homeai-fast:locked'})[0]
if($fast.input -is [string] -or $fast.input.Count -ne 1){throw 'Text input was not serialized as a one-item array.'}
$vision=@($serialized.models.providers.ollama.models | Where-Object {$_.id -eq 'homeai-vision:locked'})[0]
if(($vision.input -join ',') -ne 'text,image'){throw 'Vision input differs.'}
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\workbench-config.json') $config
$rollback=Set-HomeAIWorkbenchConfig $base $settings @{} -Disabled
if($rollback.plugins.entries.'homeai-workbench'.enabled -or $rollback.plugins.entries.'homeai-workbench'.config.root -ne $settings.root){throw 'Rollback plugin config is invalid.'}
if($rollback.agents.defaults.model.primary -ne $base.agents.defaults.model.primary){throw 'Rollback changed the existing main route.'}
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\workbench-rollback.json') $rollback
Write-Output 'PASS: actual PS5.1 one-item arrays, multimodal catalog and installed-plugin rollback configuration.'
