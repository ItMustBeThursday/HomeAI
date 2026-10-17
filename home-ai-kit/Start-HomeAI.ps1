#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI')
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
Write-Host 'Local model server is ready. The orchestrator is started separately (Restart-Orchestrator.ps1).'
