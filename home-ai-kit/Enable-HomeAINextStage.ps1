#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'Enable-HomeAIExecution.ps1') -Root $Root -PlanOnly:$PlanOnly
if(-not $PlanOnly){& (Join-Path $PSScriptRoot 'Enable-HomeAIAdaptive.ps1') -Root $Root}
