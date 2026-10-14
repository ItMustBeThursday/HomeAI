#Requires -Version 5.1
param([string]$Root='D:\HomeAI')
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings = Get-HomeAISettings $Root
Set-HomeAIEnvironment $settings
foreach ($service in @('gateway','ollama')) {
    $file = Join-Path $settings.root "state\$service.pid.json"
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $record = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $expected = if ($service -eq 'gateway') { Get-HomeAINode $settings } else { Join-Path $settings.root 'runtime\ollama\ollama.exe' }
    if ($process.Path -ne $expected -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks) {
        throw "Refusing to stop ${service}: process ownership changed."
    }
    if ($service -eq 'ollama') {
        foreach ($model in (Get-HomeAIOllama $settings '/api/ps').models) {
            Send-HomeAIOllama $settings '/api/generate' @{model=$model.name;keep_alive=0} | Out-Null
        }
    }
    Stop-Process -Id $process.Id
    $process.WaitForExit(15000) | Out-Null
    Write-Host "Stopped this kit's $service process."
}
