#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
$ErrorActionPreference='Stop'
Write-Host 'Configure Codex, Claude and local Qwen worker lanes, durable plans and output ownership. Existing native logins are reused.'
& (Join-Path $PSScriptRoot 'Enable-HomeAIJobs.ps1') -Root $Root -Fleet -PlanOnly:$PlanOnly
& (Join-Path $PSScriptRoot 'Stage-HomeAIModels.ps1') -Root $Root -PlanOnly:$PlanOnly
