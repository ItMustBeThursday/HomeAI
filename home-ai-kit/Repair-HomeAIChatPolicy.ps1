#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
$markerPath=Assert-HomeAIChild (Join-Path $settings.root 'state\openclaw-chat-connector.json') $settings.root
if(-not (Test-Path -LiteralPath $markerPath)){throw 'Run Connect-OpenClawChat.ps1 first; no native chat connector was found.'}
$marker=Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if($marker.owner -ne 'home-ai-native-chat-v1'){throw 'Native chat connector ownership differs.'}
if($settings.openclawVersion -ne '2026.10.3'){throw 'This repair targets the pinned OpenClaw 2026.10.3 runtime.'}
Write-Host 'Repair Codex runtime admission: human approval policy, existing model routes and tools retained.'
if($PlanOnly){Write-Host 'PLAN ONLY: no backup, writes, policy changes or restarts.';return}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIEnvironment $settings
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
$configPath=Assert-HomeAIChild (Join-Path $settings.root 'state\openclaw\openclaw.json') $settings.root
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if(-not $config.tools.PSObject.Properties['exec']){$config.tools | Add-Member -NotePropertyName exec -NotePropertyValue ([pscustomobject]@{})}
$config.tools.exec.PSObject.Properties.Remove('security')
$config.tools.exec.PSObject.Properties.Remove('ask')
$config.tools.exec | Add-Member -NotePropertyName host -NotePropertyValue 'gateway' -Force
$config.tools.exec | Add-Member -NotePropertyName mode -NotePropertyValue 'ask' -Force
Write-HomeAIJson $configPath $config
Invoke-HomeAINative $node @($claw,'config','validate')
# Synchronizes requested config and host-local defaults. On an unavailable
# approval route, the fallback remains deny. Never use the yolo preset here.
Invoke-HomeAINative $node @($claw,'exec-policy','preset','cautious')
Invoke-HomeAINative $node @($claw,'exec-policy','show')
foreach($name in @('Common.ps1','Backup-HomeAI.ps1','Native-Chat-Config.ps1','Connect-OpenClawChat.ps1','Repair-HomeAIChatPolicy.ps1','Stop-HomeAI.ps1')) {
    $source=Join-Path $PSScriptRoot $name
    $target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$name)) $settings.root
    if($source -ne $target){Copy-Item -LiteralPath $source -Destination $target -Force}
}
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
Write-Host 'Policy repaired. Refresh the dashboard. Check a new Codex reply and /status.'
Write-Host 'To test Claude, send /model anthropic/claude-opus-5-5, then a short message and /status.'
Write-Host 'Restore Codex with /model openai/gpt-6-astra. No account sign-in or model download was repeated.'
