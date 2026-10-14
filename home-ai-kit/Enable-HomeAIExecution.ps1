#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Fleet-Config.ps1')
. (Join-Path $PSScriptRoot 'Execution-Config.ps1')
$settings=Get-HomeAISettings $Root
$configPath=Join-Path $settings.root 'state\openclaw\openclaw.json'
$saved=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if($settings.openclawVersion -ne '2026.10.3' -or -not $saved.agents.entries.PSObject.Properties['homeai-worker-local']){throw 'Finish Enable-HomeAIOrchestrator.ps1 first.'}
Write-Host 'Enable copied-snapshot JavaScript syntax checks and node:test execution in Windows AppContainer with no network capabilities. No Linux, API keys or dependency downloads.'
if($PlanOnly){Write-Host 'PLAN ONLY: no changes or test processes.';return}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIEnvironment $settings
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
$markerPath=Join-Path $settings.root 'state\execution-connector.json'
try {
    foreach($folder in @('execution-plugin','jobs-plugin')) {
        $target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$folder)) $settings.root
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        foreach($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $folder) -File){$destination=Assert-HomeAIChild (Join-Path $target $file.Name) $settings.root;if($destination -ne $file.FullName){Copy-Item -LiteralPath $file.FullName -Destination $destination -Force}}
    }
    foreach($name in @('Enable-HomeAIExecution.ps1','Execution-Config.ps1','Fleet-Config.ps1','Invoke-HomeAIIsolatedNode.ps1','IsolatedNode.cs','probe-homeai-execution.mjs','EXECUTION.txt','Native-Chat-Config.ps1','Enable-HomeAIJobs.ps1')) {
        $source=Join-Path $PSScriptRoot $name;$target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$name)) $settings.root
        if($source -ne $target){Copy-Item -LiteralPath $source -Destination $target -Force}
    }
    $runtime=Assert-HomeAIChild (Join-Path $settings.root 'runtime\isolated-node') $settings.root
    $copy=Assert-HomeAIChild (Join-Path $runtime 'node.exe') $settings.root
    if(Test-Path -LiteralPath $copy){
        if(-not (Test-Path -LiteralPath $markerPath)){throw 'An unrecognized isolated Node copy exists.'}
        $previous=Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        if($previous.owner -ne 'home-ai-execution-v1' -or (Get-FileHash $copy -Algorithm SHA256).Hash -ne $previous.nodeSha256){throw 'Existing isolated Node copy changed.'}
    }
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Copy-Item -LiteralPath $node -Destination $copy -Force
    $sha=(Get-FileHash $node -Algorithm SHA256).Hash
    if((Get-FileHash $copy -Algorithm SHA256).Hash -ne $sha){throw 'Copied Node hash verification failed.'}
    Write-HomeAIJson $markerPath @{owner='home-ai-execution-v1';enabled=$false;nodeSha256=$sha;version='0.1.0'}
    Invoke-HomeAINative $node @((Join-Path $settings.root 'scripts\probe-homeai-execution.mjs'),$settings.root)
    $probe=Get-Content -LiteralPath (Join-Path $settings.root 'state\execution-probe.json') -Raw | ConvertFrom-Json
    if($probe.owner -ne 'home-ai-execution-probe-v1' -or -not $probe.passed){throw 'Isolation probe did not pass.'}
    foreach($id in @('homeai-jobs','homeai-execution')) {
        $packagePath=Assert-HomeAIChild (Join-Path $settings.root ('state\openclaw\extensions\'+$id+'\package.json')) $settings.root
        if(Test-Path -LiteralPath $packagePath){$package=Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json;if($package.name -ne $id -or $package.version -notin @('0.1.0','0.2.0','0.3.0')){throw "Unrecognized existing package: $id"}}
    }
    # A valid disabled entry exists before official installation and rollback.
    $config=($saved | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $config.plugins.entries | Add-Member -NotePropertyName 'homeai-execution' -NotePropertyValue @{enabled=$false;config=@{root=$settings.root}} -Force
    Write-HomeAIJson $configPath $config
    Invoke-HomeAINative $node @($claw,'plugins','install',(Join-Path $settings.root 'scripts\jobs-plugin'),'--force','--no-enable')
    Invoke-HomeAINative $node @($claw,'plugins','install',(Join-Path $settings.root 'scripts\execution-plugin'),'--force','--no-enable')
    $config=Set-HomeAIExecutionConfig $config $settings
    $config.plugins.entries.'homeai-jobs'.enabled=$true
    Write-HomeAIJson $configPath $config
    Invoke-HomeAINative $node @($claw,'config','validate')
    foreach($id in @('homeai-execution','homeai-jobs')) {
        $text=& $node $claw plugins inspect $id --runtime --json
        if($LASTEXITCODE -ne 0){throw "Runtime inspection failed: $id"}
        $inspection=($text -join "`n") | ConvertFrom-Json
        if($inspection.plugin.status -ne 'loaded' -or @($inspection.diagnostics | Where-Object {$_.level -eq 'error'}).Count){throw "Runtime registration failed: $id"}
    }
    Write-HomeAIJson $markerPath @{owner='home-ai-execution-v1';enabled=$true;nodeSha256=$sha;version='0.1.0';probe=$probe.safetyRunId;installedAt=[DateTimeOffset]::UtcNow.ToString('o')}
    & (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
    Write-Host 'Offline checks enabled. Ask chat to use homeai_check with kind test and a node:test entry. Reports: D:\HomeAI\state\execution\runs.'
} catch {
    $failure=$_
    try {& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root} catch {throw $failure}
    if(Test-Path -LiteralPath $markerPath){$marker=Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json;if($marker.owner -eq 'home-ai-execution-v1'){$marker.enabled=$false;Write-HomeAIJson $markerPath $marker}}
    $saved.plugins.entries | Add-Member -NotePropertyName 'homeai-execution' -NotePropertyValue @{enabled=$false;config=@{root=$settings.root}} -Force
    Write-HomeAIJson $configPath $saved
    try {& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser} catch {Write-Host ('Chat restart needs attention: '+$_.Exception.Message)}
    throw $failure
}
