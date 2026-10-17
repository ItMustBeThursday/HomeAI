param([string]$ExpectedVersion = '0.32.2')
$ErrorActionPreference = 'Stop'
$log = 'D:\HomeAI\logs\memory-deployment.log'
function Log([string]$line) { Add-Content -LiteralPath $log -Value ('{0:o} {1}' -f (Get-Date), $line) }
try {
    Log ('Waiting for idle-reload deployment of shared memory v{0}; no model generation will be requested.' -f $ExpectedVersion)
    $deadline = (Get-Date).AddMinutes(65)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:18850/api/health' -TimeoutSec 5
            if ($health.version -eq $ExpectedVersion) { break }
        } catch {}
        Start-Sleep -Seconds 5
    }
    if ($health.version -ne $ExpectedVersion) { throw 'Deployment did not appear before deadline' }
    $authToken = (Get-Content -LiteralPath 'D:\HomeAI\projects\orchestrator\data\token.txt' -Raw).Trim()
    $headers = @{ Authorization = 'Bearer ' + $authToken }
    $packet = Invoke-RestMethod 'http://127.0.0.1:18850/api/memory/context?q=local%20models&maxChars=1200' -Headers $headers -TimeoutSec 90
    if ($packet.format -ne 'mcl' -or $packet.chars -gt 1200 -or $packet.chars -le 0) { throw 'Packet validation failed' }
    $notes = Invoke-RestMethod 'http://127.0.0.1:18850/api/memory' -Headers $headers -TimeoutSec 10
    Log ('VERIFIED health version={0}; authenticated context endpoint={1} chars within 1200; shared notes={2}. No inference generation requested.' -f $health.version, $packet.chars, @($notes.notes).Count)
} catch {
    # Header-bearing exceptions and memory contents must not enter logs.
    Log 'FAILED deployment or verification; inspect service status. Details withheld to protect credentials and memory.'
    exit 1
}
