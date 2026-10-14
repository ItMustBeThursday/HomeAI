#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Root='D:\HomeAI',
    [switch]$PlanOnly,
    [switch]$CompareModels,
    [switch]$InstallQuickModel,
    [switch]$Retest,
    [switch]$NoBrowser
)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Stage-Report.ps1')
$settings=Get-HomeAISettings $Root
$releases=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'releases.json') -Raw | ConvertFrom-Json
Write-Host 'Continue with stage 2: check dependencies, start local chat, evaluate models, save a readable report.'
if($CompareModels){Write-Host 'Optional comparison adds Gemma 4 26B and gpt-oss 20B (roughly 30 GB).'}
if($InstallQuickModel){Write-Host 'Optional quick model adds roughly 6.6 GB; it does not replace Qwen.'}
Write-Host 'Stages 3-6 are designed but their full installers/workers are not implemented in this package.'
if($PlanOnly){Write-Host 'PLAN ONLY: no changes, downloads, service restarts, or inference.';return}
foreach($required in @('evaluations\first-completion.json','evaluations\first-gpu-state.json','runtime\ollama\ollama.exe')) {
    if(-not (Test-Path -LiteralPath (Join-Path $settings.root $required))) {
        throw 'Foundation setup has not completed. Finish Setup-HomeAI.ps1 before continuing.'
    }
}
if(-not $settings.openclawInstalled) { throw 'OpenClaw was skipped. Complete foundation setup with OpenClaw first.' }
if($settings.openclawVersion -ne $releases.openclaw.version -or $settings.nodeVersion -ne $releases.node.version) {
    throw 'Installed runtime versions differ from this continuation. No automatic upgrade was attempted.'
}

$progressPath=Join-Path $settings.root 'state\stage-2-progress.json'
$progress=@{stage=2;status='running';step='backup';lastUpdated=(Get-Date).ToUniversalTime().ToString('o')}
function Save-Step([string]$Step) {
    $progress.step=$Step;$progress.lastUpdated=(Get-Date).ToUniversalTime().ToString('o')
    Write-HomeAIJson $progressPath $progress
    Write-Host "Stage 2: $Step"
}
try {
    # Back up configuration and project data before changing scripts or dependencies.
    & (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
    & (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
    Save-Step 'copy updated helpers'
    foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {
        $target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$file.Name)) $settings.root
        if($file.FullName -ne $target){Copy-Item -LiteralPath $file.FullName -Destination $target -Force}
    }
    if($CompareModels -or $InstallQuickModel) {
        Save-Step 'acquire requested optional models'
        $setupArgs=@{Root=$settings.root;BackupRoot=$settings.backupRoot;Context=$settings.context;
            OllamaPort=$settings.ollamaPort;GatewayPort=$settings.gatewayPort;
            IncludeComparisonModels=[bool]$CompareModels;IncludeFastModel=[bool]$InstallQuickModel}
        & (Join-Path $PSScriptRoot 'Setup-HomeAI.ps1') @setupArgs
    }
    Set-HomeAIEnvironment $settings
    $env:npm_config_update_notifier='false'
    $node=Get-HomeAINode $settings
    $claw=Get-HomeAIOpenClaw $settings
    $packageRoot=Join-Path $settings.root 'runtime\openclaw'
    Save-Step 'probe native dependencies'
    $probeText=& $node (Join-Path $PSScriptRoot 'check-dependencies.mjs') $packageRoot
    $probeCode=$LASTEXITCODE
    $probe=$probeText | ConvertFrom-Json
    if($probeCode -ne 0) {
        Write-Host 'A known native dependency failed; running its narrow, version-checked repair.'
        & (Join-Path $PSScriptRoot 'Repair-HomeAIDependencies.ps1') -Root $settings.root
        $probeText=& $node (Join-Path $PSScriptRoot 'check-dependencies.mjs') $packageRoot
        if($LASTEXITCODE -ne 0){throw 'Dependency repair did not pass. Read the failed probe; no tool permissions were widened.'}
        $probe=$probeText | ConvertFrom-Json
    }
    Save-Step 'check approval configuration'
    $config=Get-Content -LiteralPath (Join-Path $settings.root 'state\openclaw\openclaw.json') -Raw | ConvertFrom-Json
    if($config.tools.profile -ne 'minimal' -or $config.gateway.bind -ne 'loopback' -or
        $config.memory.search.provider -ne 'none' -or $config.update.checkOnStart -or $config.telemetry.enabled -or
        $config.models.providers.ollama.baseUrl -ne "http://127.0.0.1:$($settings.ollamaPort)") {
        throw 'Configuration differs from the agreed restricted foundation. Review it before continuing.'
    }
    Invoke-HomeAINative $node @($claw,'config','validate')
    # Reassert the already agreed deny-all host policy while the gateway is stopped.
    Invoke-HomeAINative $node @($claw,'exec-policy','preset','deny-all')
    Save-Step 'start gateway and verify health'
    & (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
    Invoke-HomeAINative $node @($claw,'health')
    Save-Step 'evaluate installed models'
    $models=@($settings.mainModel)
    if($CompareModels){$models+=$releases.comparisonModels}
    if($InstallQuickModel){$models+=$settings.fastModel}
    $tags=Get-HomeAIOllama $settings '/api/tags'
    $fingerprint=@{context=$settings.context;modelDigests=@($tags.models | Where-Object { $models -contains $_.name } | Select-Object name,digest);
        benchmarkScriptHash=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'Benchmark-HomeAI.ps1')).Hash}
    $fingerprintJson=$fingerprint | ConvertTo-Json -Depth 10 -Compress
    $cacheFile=Join-Path $settings.root 'evaluations\stage-2-cache.json'
    $benchmarkPath=Join-Path $settings.root 'evaluations\stage-2-benchmark.json'
    $reuse=$false
    if(-not $Retest -and (Test-Path -LiteralPath $cacheFile) -and (Test-Path -LiteralPath $benchmarkPath)) {
        $cache=Get-Content -LiteralPath $cacheFile -Raw | ConvertFrom-Json
        $reuse=$cache.fingerprint -eq $fingerprintJson
    }
    if(-not $reuse) {
        & (Join-Path $PSScriptRoot 'Benchmark-HomeAI.ps1') -Root $settings.root -Models $models -OutputPath $benchmarkPath | Out-Null
        Write-HomeAIJson $cacheFile @{fingerprint=$fingerprintJson}
    } else { Write-Host 'Reusing benchmark for unchanged model digests and context. Use -Retest to repeat.' }
    $benchmark=Get-Content -LiteralPath $benchmarkPath -Raw | ConvertFrom-Json
    $hardware=Get-Content -LiteralPath (Join-Path $settings.root 'state\hardware.json') -Raw | ConvertFrom-Json
    $report=New-HomeAIStageReport $settings $benchmark $probe $true $hardware
    $reportPath=Join-Path $settings.root 'evaluations\next-steps.json'
    Write-HomeAIJson $reportPath $report
    $htmlPath=Join-Path $settings.root 'evaluations\next-steps.html'
    Write-HomeAIStageHtml $htmlPath $report $benchmark
    # Leave the main model resident after any optional comparisons.
    Send-HomeAIOllama $settings '/api/chat' @{model=$settings.mainModel;stream=$false;think=$false;
        messages=@(@{role='user';content='Reply with exactly READY.'});options=@{num_ctx=$settings.context;num_predict=32};keep_alive='5m'} | Out-Null
    $progress.status='checks-run-quality-review-needed';Save-Step 'report ready'
    Write-Host "Open this report: $htmlPath"
    Write-Host "For troubleshooting or planning the next stage, share only: $reportPath"
    Write-Host 'Qwen remains the main model. No automatic model promotion or permissions expansion was performed.'
    if(-not $NoBrowser){Invoke-HomeAINative $node @($claw,'dashboard');Start-Process -FilePath $htmlPath -WindowStyle Hidden}
} catch {
    $progress.status='needs-attention';$progress.error=$_.Exception.Message
    Write-HomeAIJson $progressPath $progress
    throw
}
