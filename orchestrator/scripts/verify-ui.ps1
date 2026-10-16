$ErrorActionPreference = 'Stop'
Set-Location 'D:\HomeAI\projects\orchestrator'
foreach ($file in @('web/app.js','web/media.js','web/media-view.js')) {
    & node --check $file
    if ($LASTEXITCODE -ne 0) { throw ('Syntax check failed: ' + $file) }
}
$parseTokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'restart-when-idle.ps1'), [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Idle restart script has PowerShell parse errors.' }
& node --test src/recovery.test.mjs src/orchestrator.test.mjs src/orchestrator.features.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Recovery regression checks failed.' }
Write-Output 'JavaScript syntax, PowerShell syntax, and recovery checks passed.'
