#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI')
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
Set-HomeAIEnvironment $settings
$node=Get-HomeAINode $settings
$claw=Get-HomeAIOpenClaw $settings
Invoke-HomeAINative $node @($claw,'config','validate')
Invoke-HomeAINative $node @((Join-Path $PSScriptRoot 'audit-homeai.mjs'),$settings.root)
