# Starts the orchestrator in the background (hidden window) unless it is already listening.
# Usage: .\scripts\start.ps1 [-Port 18850] [-Foreground]
param([int]$Port = 18850, [switch]$Foreground)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force $data | Out-Null

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  "Something is already listening on port $Port; not starting another copy."
  return
}
$env:HOMEAI_ORCH_PORT = "$Port"
if ($Foreground) {
  Set-Location $root
  node src/main.mjs
  return
}
$p = Start-Process -FilePath node -ArgumentList 'src/main.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $data 'service.out.log') -RedirectStandardError (Join-Path $data 'service.err.log')
Start-Sleep -Seconds 2
try {
  $h = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
  "HomeAI orchestrator $($h.version) running (pid $($p.Id)): http://127.0.0.1:$Port"
} catch {
  "Started pid $($p.Id) but health check failed. See $data\service.err.log"
}
