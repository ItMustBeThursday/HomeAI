#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[ValidateSet('Codex','Claude','Qwen')][string]$Primary='Codex',
    [switch]$PlanOnly,[switch]$SkipLogin,[switch]$SkipSmokeTest)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Native-Chat-Config.ps1')
. (Join-Path $PSScriptRoot 'Claude-Common.ps1')
$settings=Get-HomeAISettings $Root
if($settings.openclawVersion -ne '2026.10.3'){throw 'This integration requires the pinned OpenClaw 2026.10.3 runtime.'}
Write-Host 'Install the official Codex harness and enable the bundled Claude Code backend in OpenClaw chat.'
Write-Host 'Chat context may reach the selected subscription service. Only local memory/history tools are enabled.'
if($PlanOnly){Write-Host 'PLAN ONLY: no writes, downloads, sign-in, inference or restarts.';return}
$claudeMarker=Join-Path $settings.root 'state\claude-connector.json'
$claudeReady=$false
if(Test-Path -LiteralPath $claudeMarker) {
    $claude=Get-Content -LiteralPath $claudeMarker -Raw | ConvertFrom-Json
    $claudeReady=($claude.PSObject.Properties.Name -contains 'paidExtraUsageDisabledByUser') -and $claude.paidExtraUsageDisabledByUser
}
if(-not $claudeReady){& (Join-Path $PSScriptRoot 'Connect-Claude.ps1') -Root $settings.root}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIClaudeEnvironment $settings
$claudeExe=Get-HomeAIClaudeExecutable $settings
$env:PATH=(Split-Path $claudeExe -Parent)+';'+$env:PATH
foreach($name in @('OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CODEX_ACCESS_TOKEN','CODEX_ACCESS_TOKEN_FILE')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
}
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
$npm=Join-Path $settings.root "runtime\node-v$($settings.nodeVersion)-win-x64\npm.cmd"
# Check the exact official plugin pin before using OpenClaw's provenance-recording installer.
$metadataText=& $npm view '@openclaw/codex@2026.10.3' version dist.integrity --json --registry 'https://registry.npmjs.org'
if($LASTEXITCODE -ne 0){throw 'Could not verify the official Codex plugin release.'}
$metadata=@($metadataText | ConvertFrom-Json)[0]
if($metadata.version -ne '2026.10.3' -or $metadata.'dist.integrity' -ne 'sha512-xJyvPba1Nb6nc5B31WqTaCmK6csUA7v6djVGRSZjyIsP+UAXObZVSba5L/HKrU9WrM9t9Jm+3KvAE8F8OpGQRQ==') {
    throw 'Official Codex plugin metadata differs from the checked pin. Nothing was installed.'
}
$installedPlugin=Assert-HomeAIChild (Join-Path $settings.root 'state\openclaw\extensions\codex\package.json') $settings.root
if(Test-Path -LiteralPath $installedPlugin) {
    $installed=Get-Content -LiteralPath $installedPlugin -Raw | ConvertFrom-Json
    if($installed.name -ne '@openclaw/codex' -or $installed.version -ne '2026.10.3') {
        throw 'A different Codex plugin is already installed. The verified backup is available; automatic replacement was refused.'
    }
    Write-Host 'The pinned official Codex plugin is already installed; keeping it.'
} else {
    Invoke-HomeAINative $node @($claw,'plugins','install','@openclaw/codex@2026.10.3')
}
$configPath=Join-Path $settings.root 'state\openclaw\openclaw.json'
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config=Enable-HomeAINativeChatConfig $config $settings $Primary
Write-HomeAIJson $configPath $config
# Persist only non-secret launch metadata. Claude credentials remain in its private profile.
Write-HomeAIJson (Join-Path $settings.root 'state\openclaw-chat-connector.json') @{
    owner='home-ai-native-chat-v1';primary=$Primary;claudeExecutable=$claudeExe;
    claudeExecutableSha256=(Get-FileHash -LiteralPath $claudeExe -Algorithm SHA256).Hash;
    codexPluginVersion='2026.10.3';installedAt=[DateTimeOffset]::UtcNow.ToString('o')
}
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {
    if($file.Name -in @('Invoke-OpenClawWorker.ps1','OpenClaw-Chat-Config.ps1')){continue}
    $target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$file.Name)) $settings.root
    if($target -ne $file.FullName){Copy-Item -LiteralPath $file.FullName -Destination $target -Force}
}
Invoke-HomeAINative $node @($claw,'config','validate')
Invoke-HomeAINative $node @($claw,'exec-policy','preset','cautious')
foreach($pluginId in @('codex','anthropic')) {
    $inspectionText=& $node $claw plugins inspect $pluginId --runtime --json
    if($LASTEXITCODE -ne 0){throw "Runtime inspection failed for $pluginId. The gateway remains stopped."}
    $inspection=($inspectionText -join "`n") | ConvertFrom-Json
    $pluginErrors=@($inspection.diagnostics | Where-Object {$_.level -eq 'error'})
    if($inspection.plugin.status -ne 'loaded' -or $pluginErrors.Count) {
        throw "The $pluginId runtime could not register correctly: $($pluginErrors.message -join '; '). The gateway remains stopped."
    }
    Write-Host "Verified runtime registration: $pluginId."
}
if(-not $SkipLogin) {
    Write-Host 'Complete OpenClaw native Codex sign-in with your ChatGPT account. Do not choose an API key.'
    Invoke-HomeAINative $node @($claw,'models','auth','login','--provider','openai','--method','oauth','--set-default')
    Write-Host 'Register the existing Claude Code subscription login with OpenClaw.'
    Invoke-HomeAINative $node @($claw,'models','auth','login','--provider','anthropic','--method','cli')
}
# Auth flows may add model entries or select defaults. Reapply only the agreed route and restrictions.
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config=Enable-HomeAINativeChatConfig $config $settings $Primary
Write-HomeAIJson $configPath $config
Invoke-HomeAINative $node @($claw,'config','validate')
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
if(-not $SkipSmokeTest) {
    Write-Host 'Checking a real chat reply. This uses the selected subscription or its configured fallback.'
    Invoke-HomeAINative $node @($claw,'agent','--agent','main','--message','Reply with exactly READY. This is an installation check.','--json')
}
Write-Host 'Native chat routes installed. Open a NEW chat in the dashboard.'
Write-Host "Selected preference: $Primary. Use /status to see the actual runtime/model and /codex status for native account limits."
Write-Host 'No project modification, shell, purchase, messaging, browser or desktop tools were enabled.'
Invoke-HomeAINative $node @($claw,'dashboard')
