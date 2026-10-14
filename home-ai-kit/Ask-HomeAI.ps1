#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Root='D:\HomeAI',
    [Parameter(Mandatory=$true)][string]$Prompt,
    [ValidateSet('Local','BestAvailable')][string]$Mode='Local',
    [ValidateSet('Codex','Claude')][string]$Provider='Codex'
)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Hosted-Workers.ps1')
$settings=Get-HomeAISettings $Root
if($Mode -eq 'BestAvailable') {
    # Outbound inference is authorized without per-prompt approval.
    # Messaging, purchases, uploads, and agent execution are not enabled here.
    $result=Invoke-HomeAIHostedRouting $settings $Provider $Prompt
    if($result.success){Write-Host "Answered by $($result.provider).";$result.answer;return}
    Write-Host 'Hosted workers are unavailable or limited. Using local Qwen.'
}
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -ModelsOnly
& (Join-Path $PSScriptRoot 'Invoke-HomeAI.ps1') -Root $settings.root -Prompt $Prompt -Think
