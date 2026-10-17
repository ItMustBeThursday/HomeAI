param([switch]$Detached, [ValidateRange(1,1440)][int]$DeadlineMinutes = 60)
$ErrorActionPreference = 'Stop'
$log = 'D:\HomeAI\logs\webui-reload.log'
if (-not $Detached) {
    $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Detached -DeadlineMinutes {1}' -f $PSCommandPath, $DeadlineMinutes
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }
    if ($result.ReturnValue -ne 0) { throw 'Could not launch idle restart watcher.' }
    Write-Output ('Idle restart watcher queued, PID {0}. Log: {1}' -f $result.ProcessId, $log)
    exit 0
}
function Log([string]$message) { Add-Content -LiteralPath $log -Value ('{0:o} {1}' -f (Get-Date), $message) }
try {
    $authToken = (Get-Content -LiteralPath 'D:\HomeAI\projects\orchestrator\data\token.txt' -Raw).Trim()
    $headers = @{ Authorization = 'Bearer ' + $authToken }
    $initialListener = Get-NetTCPConnection -LocalPort 18850 -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess
    $deadline = (Get-Date).AddMinutes($DeadlineMinutes)
    $quiet = 0
    Log ('Waiting up to {0} minutes for model queues to idle before loading tested changes; deadline {1:o}.' -f $DeadlineMinutes, $deadline)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $listener = Get-NetTCPConnection -LocalPort 18850 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
        if ($listener -and $listener -ne $initialListener) { Log 'Service was already restarted by another operation; leaving it running.'; exit 0 }
        try {
            $state = Invoke-RestMethod 'http://127.0.0.1:18850/api/schedule' -Headers $headers -TimeoutSec 5
            $busy = @($state.queue.PSObject.Properties | Where-Object { $_.Value.active -gt 0 -or $_.Value.queued -gt 0 }).Count
            $jobState = Invoke-RestMethod 'http://127.0.0.1:18850/api/jobs' -Headers $headers -TimeoutSec 5
            $busy += @($jobState.jobs | Where-Object { $_.status -in @('queued','running','planning') }).Count
            if ($busy -eq 0) { $quiet++ } else { $quiet = 0 }
        } catch { $quiet = 0 }
        if ($quiet -lt 4) { continue }
        Log 'Model queues idle for four checks. Restarting via the existing service restart script.'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File 'D:\HomeAI\scripts\Restart-Orchestrator.ps1' -Detached
        if ($LASTEXITCODE -ne 0) { throw 'Restart script reported failure.' }
        $health = Invoke-RestMethod 'http://127.0.0.1:18850/api/health' -TimeoutSec 10
        $config = Invoke-RestMethod 'http://127.0.0.1:18850/api/config' -Headers $headers -TimeoutSec 10
        Log ('VERIFIED: health responds, version {0}; {1} connectors loaded.' -f $health.version, @($config.connectors.PSObject.Properties).Count)
        exit 0
    }
    Log 'TIMEOUT: service stayed busy; no restart performed.'
    exit 1
} catch {
    # Do not include exception details: an HTTP exception may contain request headers.
    Log 'FAILED: idle restart or verification did not complete. Existing service logs contain restart status.'
    exit 1
}
