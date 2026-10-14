#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$ModelsOnly,[switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings = Get-HomeAISettings $Root
Set-HomeAIEnvironment $settings
$ollamaExe = Join-Path $settings.root 'runtime\ollama\ollama.exe'
if (-not (Test-HomeAIListenerOwned $settings 'ollama' $settings.ollamaPort $ollamaExe)) {
    $process = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -PassThru -WindowStyle Hidden `
        -WorkingDirectory $settings.root -RedirectStandardOutput (Join-Path $settings.root 'logs\ollama-out.log') `
        -RedirectStandardError (Join-Path $settings.root 'logs\ollama-error.log')
    Save-HomeAIProcess $settings 'ollama' $process
    $ready = $false
    for ($i=0;$i -lt 60;$i++) {
        try { Get-HomeAIOllama $settings '/api/version' | Out-Null; $ready=$true; break } catch { Start-Sleep -Seconds 1 }
        if ($process.HasExited) { throw 'Ollama exited. Read logs\ollama-error.log.' }
    }
    if (-not $ready) { throw 'Ollama did not become ready within 60 seconds. Read its log.' }
}
if ($ModelsOnly -or -not $settings.openclawInstalled) { Write-Host 'Local model server is ready.'; return }
$node = Get-HomeAINode $settings
$claw = Get-HomeAIOpenClaw $settings
Invoke-HomeAINative $node @($claw,'config','validate')
if (-not (Test-HomeAIListenerOwned $settings 'gateway' $settings.gatewayPort $node)) {
    $argsLine = '"'+$claw+'" gateway run'
    $process = Start-Process -FilePath $node -ArgumentList $argsLine -PassThru -WindowStyle Hidden `
        -WorkingDirectory $settings.root -RedirectStandardOutput (Join-Path $settings.root 'logs\gateway-out.log') `
        -RedirectStandardError (Join-Path $settings.root 'logs\gateway-error.log')
    Save-HomeAIProcess $settings 'gateway' $process
    $ready = $false
    for ($i=0;$i -lt 60;$i++) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $settings.gatewayPort -ErrorAction SilentlyContinue)
        if ($listeners.Count -gt 0) { $ready=$true; break }
        if ($process.HasExited) { throw 'OpenClaw exited. Read logs\gateway-error.log.' }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Gateway did not start within 60 seconds. Read its log.' }
}
Write-Host "OpenClaw is running locally on port $($settings.gatewayPort)."
if (-not $NoBrowser) { Invoke-HomeAINative $node @($claw,'dashboard') }
