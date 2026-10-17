$ErrorActionPreference='Stop'
$log='D:\HomeAI\logs\memory-dedup-deploy.log'
$root='D:\HomeAI\projects\orchestrator'
try {
 Add-Content -LiteralPath $log -Value ('{0:o} Waiting for idle; active work will continue.' -f (Get-Date))
 & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$root\scripts\restart-when-idle.ps1" -Detached -DeadlineMinutes 240
 if($LASTEXITCODE -ne 0){throw 'Idle deployment incomplete'}
 & D:\HomeAI\runtime\node-v24.21.0-win-x64\node.exe "$root\scripts\clean-memory-redundancy.mjs" --apply >> $log 2>&1
 if($LASTEXITCODE -ne 0){throw 'Cleanup verification incomplete'}
 & D:\HomeAI\runtime\node-v24.21.0-win-x64\node.exe "$root\scripts\verify-memory-redundancy-live.mjs" >> $log 2>&1
 if($LASTEXITCODE -ne 0){throw 'Live verification incomplete'}
 Add-Content -LiteralPath $log -Value ('{0:o} VERIFIED: memory cleanup and durable/history WebUI API views active.' -f (Get-Date))
} catch {
 Add-Content -LiteralPath $log -Value ('{0:o} FAILED: deployment or verification incomplete. Check webui-reload.log and backup/live-verification.json.' -f (Get-Date))
 exit 1
}
