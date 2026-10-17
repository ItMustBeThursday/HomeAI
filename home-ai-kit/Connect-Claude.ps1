#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly,[switch]$SkipLogin)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Claude-Common.ps1')
$settings=Get-HomeAISettings $Root
Write-Host 'Install optional Claude Code 2.1.299 from its official Windows package, then sign in to Claude Pro.'
Write-Host 'Qwen remains the local default. No API key or paid extra usage is configured.'
if($PlanOnly){Write-Host 'PLAN ONLY: no downloads, login, profile writes, or Claude requests.';return}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIClaudeEnvironment $settings
$profile=$env:CLAUDE_CONFIG_DIR
if(-not (Test-Path -LiteralPath $profile)){New-Item -ItemType Directory -Path $profile -Force | Out-Null}
$profileMarker=Join-Path $profile 'homeai-profile.json'
if(Test-Path -LiteralPath $profileMarker) {
    $owner=Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json
    if($owner.root -ne $settings.root){throw 'This private Claude profile belongs to another HomeAI installation.'}
} elseif(@(Get-ChildItem -LiteralPath $profile -Force).Count -gt 0) {
    throw 'Refusing to adopt an unowned non-empty Claude profile.'
} else { Write-HomeAIJson $profileMarker @{owner='home-ai-claude-v1';root=$settings.root} }
$profileSettings=Join-Path $profile 'settings.json'
if(-not (Test-Path -LiteralPath $profileSettings)) {
    Write-HomeAIJson $profileSettings @{forceLoginMethod='claudeai';autoUpdatesChannel='stable'}
}
$npm=Join-Path $settings.root "runtime\node-v$($settings.nodeVersion)-win-x64\npm.cmd"
$packageRoot=Join-Path $settings.root 'runtime\claude'
$platformRoot=Join-Path $packageRoot 'node_modules\@anthropic-ai\claude-code-win32-x64'
$packageJson=Join-Path $platformRoot 'package.json'
if(-not (Test-Path -LiteralPath $packageJson)) {
    Invoke-HomeAINative $npm @('install','--prefix',$packageRoot,'--save-exact',
        '@anthropic-ai/claude-code-win32-x64@2.1.299','--ignore-scripts','--no-audit','--no-fund',
        '--registry','https://registry.npmjs.org')
}
$package=Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
if($package.version -ne '2.1.299'){throw 'Unexpected Claude package version; no automatic upgrade performed.'}
$node=Get-HomeAINode $settings
$lockText=& $node (Join-Path $PSScriptRoot 'read-claude-lock.mjs') (Join-Path $packageRoot 'package-lock.json')
if($LASTEXITCODE -ne 0){throw 'Could not read the Claude package integrity record. Nothing from it was launched.'}
$lockEntry=$lockText | ConvertFrom-Json
$expectedIntegrity='sha512-3m+7cON+VYa7IqQv5qCURyty0WwwpoKhqIgO8/3fnuTQ8KNoJkHe7BTSsK0T7Rq7K/xxlG2oYgVuS1Zr10UJ/A=='
if($lockEntry.integrity -ne $expectedIntegrity -or
    $lockEntry.resolved -ne 'https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.299.tgz') {
    throw 'Claude package integrity/source does not match the checked official release. Nothing from it was launched.'
}
$executables=@(Get-ChildItem -LiteralPath $platformRoot -Filter 'claude.exe' -Recurse -File)
if($executables.Count -ne 1){throw 'Could not uniquely locate the official native Claude executable.'}
$exe=Assert-HomeAIChild $executables[0].FullName $settings.root
Invoke-HomeAINative $exe @('--version')
Write-HomeAIJson (Join-Path $settings.root 'state\claude-connector.json') @{
    owner='home-ai-claude-v1';version='2.1.299';executable=$exe;
    executableSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;
    mode='native-subscription-text-only';apiKeyConfigured=$false
}
Write-HomeAIJson (Join-Path $settings.root 'state\claude-empty-mcp.json') @{mcpServers=@{}}
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {
    $destination=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$file.Name)) $settings.root
    if($file.FullName -ne $destination){Copy-Item -LiteralPath $file.FullName -Destination $destination -Force}
}
if(-not $SkipLogin) {
    Write-Host 'Complete the browser login with your Claude Pro account. Do not choose Console/API billing.'
    Invoke-HomeAINative $exe @('auth','login')
    $authText=& $exe auth status
    if($LASTEXITCODE -ne 0){throw 'Native login did not complete.'}
    $auth=$authText | ConvertFrom-Json
    Assert-HomeAIClaudeSubscription $auth
    Write-Host 'Native subscription login verified. No authentication JSON or token was saved in the report.'
}
Write-Host 'In Claude billing/settings, keep paid usage credits/extra usage disabled for the $20-only trial.'
Write-Host 'The script does not change billing. A subscription login alone cannot prove extra usage is disabled.'
$billing=Read-Host 'After checking your Claude billing settings, type OFF to confirm paid extra usage is disabled'
$connectorPath=Join-Path $settings.root 'state\claude-connector.json'
$connector=Get-Content -LiteralPath $connectorPath -Raw | ConvertFrom-Json
$connector | Add-Member -NotePropertyName paidExtraUsageDisabledByUser -NotePropertyValue ($billing -ceq 'OFF') -Force
Write-HomeAIJson $connectorPath $connector
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root
Write-Host 'Connector installed. Try Ask-HomeAI.ps1 -Mode BestAvailable -Prompt "Draft a short project brief".'
Write-Host 'Hosted inference prompts are authorized without SEND confirmation; usage limits switch to the other connected worker, then Qwen.'
Write-Host 'This first bridge is text-only and separate from the orchestrator WebUI.'
