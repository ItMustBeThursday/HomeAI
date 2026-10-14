#Requires -Version 5.1
param([string]$Root='D:\HomeAI')
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings = Get-HomeAISettings $Root
# Stopping does not need launch/authentication environment setup. It must still
# work if an optional client was updated or its connector needs repair.
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
    $nativeChat=Join-Path $settings.root 'state\openclaw-chat-connector.json'
    $stopTree=$false
    if($service -eq 'gateway' -and (Test-Path -LiteralPath $nativeChat)) {
        $chat=Get-Content -LiteralPath $nativeChat -Raw | ConvertFrom-Json
        $stopTree=$chat.owner -eq 'home-ai-native-chat-v1'
    }
    if($stopTree) {
        # The PID/path/start-time check above binds this to our own gateway.
        # Its native Codex/Claude descendants must stop before SQLite backup.
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
        if($LASTEXITCODE -ne 0 -and -not $process.HasExited){throw 'Could not stop the owned gateway process tree.'}
    } else {Stop-Process -Id $process.Id}
    $process.WaitForExit(15000) | Out-Null
    Write-Host "Stopped this kit's $service process."
}
