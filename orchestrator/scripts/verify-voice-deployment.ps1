# Read-only follow-up monitor. The existing idle watcher owns the actual restart.
param([int]$Minutes=120)
$ErrorActionPreference='Stop'
$voiceHeaders=@{Authorization='Bearer '+([IO.File]::ReadAllText('D:\HomeAI\projects\orchestrator\data\token.txt')).Trim()}
$voiceDeadline=(Get-Date).AddMinutes($Minutes)
$voiceLog='D:\HomeAI\logs\voice-deployment.log'
Add-Content -LiteralPath $voiceLog -Value ('{0:o} Waiting for authenticated production voice endpoints.' -f (Get-Date))
while((Get-Date) -lt $voiceDeadline){
    try {
        $voiceState=Invoke-RestMethod 'http://127.0.0.1:18850/api/voice/status' -Headers $voiceHeaders -TimeoutSec 6
        if($voiceState.available -and $voiceState.ok){
            $voiceList=Invoke-RestMethod 'http://127.0.0.1:18850/api/voice/voices' -Headers $voiceHeaders -TimeoutSec 30
            Add-Content -LiteralPath $voiceLog -Value ('{0:o} VERIFIED production voice available; {1} built-in voices.' -f (Get-Date),@($voiceList.builtin).Count)
            exit 0
        }
    } catch { }
    Start-Sleep -Seconds 10
}
Add-Content -LiteralPath $voiceLog -Value ('{0:o} UNVERIFIED: production voice did not become available before deadline.' -f (Get-Date))
exit 1
