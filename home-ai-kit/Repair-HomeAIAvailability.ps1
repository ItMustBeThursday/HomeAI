#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[ValidateSet('Codex','Claude','Local')][string]$Primary='Codex',[switch]$ReconnectCodex,[switch]$PlanOnly,[switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
$configPath=Assert-HomeAIChild (Join-Path $settings.root 'state\openclaw\openclaw.json') $settings.root
$package=Get-Content -LiteralPath (Join-Path (Split-Path $claw -Parent) 'package.json') -Raw | ConvertFrom-Json
Write-Host ('Repair native model/runtime selection and start a clean recovery chat. Installed OpenClaw: '+$package.version)
Write-Host 'Preserves app files, credentials, previous chats, tool permissions and evolution kit. Pauses background jobs/downloads/cron and cross-provider chat fallback during recovery.'
if($package.version -ne '2026.10.3'){throw 'This recovery targets OpenClaw 2026.10.3; another installed version needs its own schema check.'}
if($PlanOnly){& $node (Join-Path $PSScriptRoot 'recovery-cli.mjs') $settings.root plan $Primary;if($LASTEXITCODE -ne 0){throw 'Recovery plan failed.'};return}
$receiptRoot=Assert-HomeAIChild (Join-Path $settings.root ('state\recovery\'+[guid]::NewGuid().ToString())) $settings.root
New-Item -ItemType Directory -Path $receiptRoot -Force | Out-Null
$report=@{owner='home-ai-availability-repair-v1';at=[DateTimeOffset]::UtcNow.ToString('o');openclawVersion=$package.version;primary=$Primary;status='starting';projectsChanged=$false;credentialsChanged=$false;oldChatsDeleted=$false;paused=@('homeai-jobs','homeai-autonomy','cron','heartbeat');root=$settings.root}
$reportPath=Join-Path $receiptRoot 'report.json'
function Save-RepairReport {Write-HomeAIJson $reportPath $report}
function Stop-RecoveryOwned {
    foreach($service in @('gateway','ollama')){
        $recordPath=Assert-HomeAIChild (Join-Path $settings.root ('state\'+$service+'.pid.json')) $settings.root
        if(-not (Test-Path -LiteralPath $recordPath)){continue}
        $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue;if(-not $process){continue}
        $expected=if($service -eq 'gateway'){$node}else{Join-Path $settings.root 'runtime\ollama\ollama.exe'}
        if($process.Path -ne $expected -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks){throw ('Refusing to stop an unowned '+$service+' process.')}
        # A seized Ollama server may not answer /api/ps or unload. Kill only this
        # verified process tree; do not query it before stopping or kill by name.
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
        if($LASTEXITCODE -ne 0 -and -not $process.HasExited){throw ('Could not stop owned '+$service+' tree.')}
        if(-not $process.WaitForExit(15000)){throw ('Owned '+$service+' did not stop.')}
    }
    if(@(Get-NetTCPConnection -State Listen -LocalPort $settings.gatewayPort,$settings.ollamaPort -ErrorAction SilentlyContinue).Count){throw 'A HomeAI port is still occupied by an unowned process. No configuration was changed.'}
}
function Set-RecoveryEnvironment {
    # Codex recovery must not be blocked by an unrelated Claude binary update or
    # expired Claude login. No credential files are read, copied or cleared.
    $env:OLLAMA_HOST='127.0.0.1:'+$settings.ollamaPort
    $env:OLLAMA_MODELS=Join-Path $settings.root 'models\ollama';$env:OLLAMA_NO_CLOUD='1'
    $env:OLLAMA_MAX_LOADED_MODELS='1';$env:OLLAMA_NUM_PARALLEL='1';$env:OLLAMA_CONTEXT_LENGTH=[string][Math]::Min([int]$settings.context,16384)
    $env:OLLAMA_FLASH_ATTENTION='1';$env:OLLAMA_KV_CACHE_TYPE='q8_0';$env:OLLAMA_KEEP_ALIVE='1m'
    $env:OPENCLAW_STATE_DIR=Join-Path $settings.root 'state\openclaw';$env:OPENCLAW_CONFIG_PATH=$configPath
    $env:OPENCLAW_NO_AUTO_UPDATE='1';$env:OPENCLAW_NO_RESPAWN='1';$env:NODE_DISABLE_COMPILE_CACHE='1';$env:NO_COLOR='1'
    $env:PATH=(Split-Path $node -Parent)+';'+(Join-Path $settings.root 'runtime\git\cmd')+';'+$env:PATH
    foreach($name in @('OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','OPENCLAW_QA_FORCE_RUNTIME')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
    if($Primary -eq 'Claude'){
        $chat=Get-Content -LiteralPath (Join-Path $settings.root 'state\openclaw-chat-connector.json') -Raw | ConvertFrom-Json
        $exe=Assert-HomeAIChild $chat.claudeExecutable $settings.root
        if($chat.owner -ne 'home-ai-native-chat-v1' -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $chat.claudeExecutableSha256){throw 'Claude executable needs reconnection; choose Codex recovery or rerun Connect-Claude.ps1.'}
        $env:CLAUDE_CONFIG_DIR=Join-Path $env:LOCALAPPDATA 'HomeAI-Claude';$env:PATH=(Split-Path $exe -Parent)+';'+$env:PATH
        $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';$env:DISABLE_AUTOUPDATER='1'
    }
}
function Start-RecoveryServices([switch]$ModelsOnly) {
    $ollama=Join-Path $settings.root 'runtime\ollama\ollama.exe'
    if(-not (Test-HomeAIListenerOwned $settings 'ollama' $settings.ollamaPort $ollama)){
        $process=Start-Process -FilePath $ollama -ArgumentList 'serve' -WorkingDirectory $settings.root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $settings.root 'logs\ollama-out.log') -RedirectStandardError (Join-Path $settings.root 'logs\ollama-error.log')
        Save-HomeAIProcess $settings 'ollama' $process
        $ready=$false;for($i=0;$i -lt 60;$i++){try {Get-HomeAIOllama $settings '/api/version' | Out-Null;$ready=$true;break}catch{};if($process.HasExited){break};Start-Sleep -Seconds 1}
        if(-not $ready){throw 'Ollama did not start; inspect its local error log.'}
    }
    if($ModelsOnly){return}
    $process=Start-Process -FilePath $node -ArgumentList ('"'+$claw+'" gateway run') -WorkingDirectory $settings.root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $settings.root 'logs\gateway-out.log') -RedirectStandardError (Join-Path $settings.root 'logs\gateway-error.log')
    Save-HomeAIProcess $settings 'gateway' $process
    $ready=$false;for($i=0;$i -lt 240;$i++){
        if($process.HasExited){throw 'Gateway exited; inspect the preserved/current local logs.'}
        try {$response=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:'+$settings.gatewayPort+'/readyz') -TimeoutSec 3;if($response.StatusCode -eq 200){$ready=$true;break}}catch{}
        if($i -gt 0 -and $i % 15 -eq 0){Write-Host ('Waiting for gateway readiness: '+$i+' seconds...')};Start-Sleep -Seconds 1
    }
    if(-not $ready){throw 'Gateway did not become ready. Inspect local error log; no inference was sent.'}
}
Save-RepairReport
$before=Join-Path $receiptRoot 'openclaw.before.json';$wroteConfig=$false
try {
    Write-Host 'Step 1/6: stop owned gateway and Ollama process trees...'
    Stop-RecoveryOwned
    foreach($name in @('gateway-error.log','gateway-out.log','ollama-error.log')){
        $source=Assert-HomeAIChild (Join-Path $settings.root ('logs\'+$name)) $settings.root
        if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $receiptRoot $name)}
    }
    Write-Host 'Step 2/6: create and verify the full state/project backup...'
    $snapshot=& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root
    $report.backup=$snapshot
    Copy-Item -LiteralPath $configPath -Destination $before
    $report.beforeSha256=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    if((Get-FileHash -LiteralPath $before -Algorithm SHA256).Hash -ne $report.beforeSha256){throw 'Recovery config backup hash differs.'}
    try {$os=Get-CimInstance Win32_OperatingSystem;$report.ram=@{totalGiB=[Math]::Round($os.TotalVisibleMemorySize/1MB,1);freeGiB=[Math]::Round($os.FreePhysicalMemory/1MB,1)}}catch{}
    Set-RecoveryEnvironment
    Write-Host 'Step 3/6: inspect native plugins (up to 90 seconds each)...'
    $text=& $node (Join-Path $PSScriptRoot 'recovery-cli.mjs') $settings.root plugins $Primary
    if($LASTEXITCODE -eq 0){$report.pluginsBefore=($text -join "`n") | ConvertFrom-Json}
    Write-Host 'Step 4/6: start model server and apply runtime repair...'
    Start-RecoveryServices -ModelsOnly
    $text=& $node (Join-Path $PSScriptRoot 'recovery-cli.mjs') $settings.root apply $Primary
    if($LASTEXITCODE -ne 0){throw 'Recovery configuration could not be applied.'}
    $wroteConfig=$true;$report.plan=($text -join "`n") | ConvertFrom-Json;Save-RepairReport
    Invoke-HomeAINative $node @($claw,'config','validate')
    if($ReconnectCodex){
        if($Primary -ne 'Codex'){throw '-ReconnectCodex requires -Primary Codex.'}
        Invoke-HomeAINative $node @($claw,'models','auth','login','--provider','openai','--method','oauth')
        $report.credentialsChanged=$true
    }
    Write-Host 'Step 5/6: start the repaired gateway...'
    Start-RecoveryServices
    Write-Host 'Step 6/6: create an independent recovery chat...'
    $text=& $node (Join-Path $PSScriptRoot 'recovery-cli.mjs') $settings.root create $Primary
    if($LASTEXITCODE -ne 0){throw 'Could not create the clean recovery chat. If Codex needs sign-in, rerun with -ReconnectCodex.'}
    $report.chat=($text -join "`n") | ConvertFrom-Json
    try {$report.ollamaLoadedModels=(Get-HomeAIOllama $settings '/api/ps').models | Select-Object name,size,size_vram,context_length}catch{}
    $report.status='ready-awaiting-first-real-message';Save-RepairReport
    $url='http://127.0.0.1:'+$settings.gatewayPort+'/chat?session='+[Uri]::EscapeDataString($report.chat.key)
    Write-Host ('Recovery chat: '+$url)
    Write-Host ('Selected model/runtime: '+$report.chat.ref+' / '+$report.chat.runtime)
    Write-Host ('Verified backup and local report: '+$reportPath)
    Write-Host 'No model inference was sent by this repair. Open the new recovery chat, not the previously pinned chat. Background orchestration remains paused pending diagnosis.'
    if(-not $NoBrowser){Start-Process $url}
} catch {
    $failure=$_;$report.status='needs-review';$report.error=$_.Exception.Message
    # Do not revive a known crashing gateway or silently erase repair settings.
    # The verified prior bytes remain available for explicit rollback.
    if($wroteConfig -and -not $report.ContainsKey('chat')){
        try {Stop-RecoveryOwned}catch{Write-Host 'Owned service cleanup needs attention.'}
        $report.keptRecoveryConfig=$true
    }
    Save-RepairReport
    Write-Host ('Recovery stopped safely. Report: '+$reportPath)
    Write-Host ('Original config is preserved at: '+$before)
    throw $failure
}
