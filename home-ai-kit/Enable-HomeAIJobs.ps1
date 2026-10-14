#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly,[switch]$Fleet)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Workbench-Config.ps1')
. (Join-Path $PSScriptRoot 'Fleet-Config.ps1')
$settings=Get-HomeAISettings $Root
$markerPath=Join-Path $settings.root 'state\workbench-connector.json'
if(-not (Test-Path -LiteralPath $markerPath)){throw 'Finish Enable-HomeAIWorkbench.ps1 successfully before enabling jobs.'}
$marker=Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if($marker.owner -ne 'home-ai-workbench-v1' -or $settings.openclawVersion -ne '2026.10.3'){throw 'This job installer requires the owned, pinned workbench.'}
Write-Host 'Enable bounded project-file jobs using the existing Codex/Claude/Qwen routes. No shell, publishing or unattended system installation.'
if($PlanOnly){Write-Host 'PLAN ONLY: no writes, backup, installs or restarts.';return}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIEnvironment $settings
$configPath=Join-Path $settings.root 'state\openclaw\openclaw.json'
$saved=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
try {
    foreach($folder in @('workbench-plugin','jobs-plugin')) {
        $destination=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$folder)) $settings.root
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        foreach($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $folder) -File) {
            $target=Assert-HomeAIChild (Join-Path $destination $file.Name) $settings.root
            if($target -ne $file.FullName){Copy-Item -LiteralPath $file.FullName -Destination $target -Force}
        }
    }
    foreach($name in @('Enable-HomeAIJobs.ps1','Fleet-Config.ps1','Enable-HomeAIOrchestrator.ps1','Stage-HomeAIModels.ps1','Audit-HomeAI.ps1','audit-homeai.mjs','Workbench-Config.ps1','Enable-HomeAIWorkbench.ps1','Manage-HomeAIJobs.ps1')) {
        $source=Join-Path $PSScriptRoot $name;$target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$name)) $settings.root
        if($source -ne $target){Copy-Item -LiteralPath $source -Destination $target -Force}
    }
    # These exact locally-owned packages are replaced only after verified backup.
    foreach($name in @('homeai-workbench','homeai-jobs')) {
        $installed=Assert-HomeAIChild (Join-Path $settings.root ('state\openclaw\extensions\'+$name+'\package.json')) $settings.root
        if(Test-Path -LiteralPath $installed) {
            $package=Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json
            if($package.name -ne $name -or $package.version -notin @('0.1.0','0.2.0','0.3.0')){throw "Unrecognized existing package: $name"}
        }
    }
    Invoke-HomeAINative $node @($claw,'plugins','install',(Join-Path $settings.root 'scripts\workbench-plugin'),'--force','--no-enable')
    $config=($saved | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $config.plugins.entries | Add-Member -NotePropertyName 'homeai-jobs' -NotePropertyValue @{enabled=$false;config=@{root=$settings.root}} -Force
    Write-HomeAIJson $configPath $config
    Invoke-HomeAINative $node @($claw,'plugins','install',(Join-Path $settings.root 'scripts\jobs-plugin'),'--force','--no-enable')
    $config.plugins.entries.'homeai-jobs'.enabled=$true
    if($config.plugins.PSObject.Properties['allow']){$config.plugins.allow=@($config.plugins.allow)+@('homeai-jobs') | Select-Object -Unique}
    $config.tools.allow=@($config.tools.allow)+@('homeai_job') | Select-Object -Unique
    $config.tools.profile='full'
    $config.tools | Add-Member -NotePropertyName toolSearch -NotePropertyValue $false -Force
    $config.agents.entries | Add-Member -NotePropertyName 'homeai-worker' -NotePropertyValue @{
        workspace=(Join-Path $settings.root 'workspace');
        tools=@{allow=@('homeai_project','homeai_task','homeai_specialist');exec=@{host='gateway';mode='ask'}}
    } -Force
    $config.agents | Add-Member -NotePropertyName ownership -NotePropertyValue 'explicit' -Force
    $config.agents.defaults | Add-Member -NotePropertyName systemAgent -NotePropertyValue @{agentId='main'} -Force
    if($Fleet -or $config.agents.entries.PSObject.Properties['homeai-worker-local']){$config=Set-HomeAIFleetConfig $config $settings}
    Write-HomeAIJson $configPath $config
    Invoke-HomeAINative $node @($claw,'config','validate')
    foreach($plugin in @('homeai-workbench','homeai-jobs')) {
        $text=& $node $claw plugins inspect $plugin --runtime --json
        if($LASTEXITCODE -ne 0){throw "Runtime inspection failed: $plugin"}
        $inspection=($text -join "`n") | ConvertFrom-Json
        if($inspection.plugin.status -ne 'loaded' -or @($inspection.diagnostics | Where-Object {$_.level -eq 'error'}).Count){throw "Runtime registration failed: $plugin"}
    }
    Write-HomeAIJson (Join-Path $settings.root 'state\jobs-connector.json') @{owner='home-ai-jobs-v1';version='0.1.0';automaticWindowsStartup=$false;installedAt=[DateTimeOffset]::UtcNow.ToString('o')}
    & (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
    Write-Host 'Jobs enabled. In a NEW chat, ask: Submit a 2-step job in project jobs-demo to create README.md describing HomeAI. Expected output: README.md.'
    Write-Host 'Use /homeai_jobs for status without model inference. Queued jobs resume when HomeAI starts; interrupted dispatches need inspection and explicit resume.'
    if($Fleet){& (Join-Path $PSScriptRoot 'Audit-HomeAI.ps1') -Root $settings.root}
} catch {
    $failure=$_
    try {& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root} catch {throw $failure}
    $saved.plugins.entries | Add-Member -NotePropertyName 'homeai-jobs' -NotePropertyValue @{enabled=$false;config=@{root=$settings.root}} -Force
    Write-HomeAIJson $configPath $saved
    try {& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser}catch{Write-Host ('Chat restart needs attention: '+$_.Exception.Message)}
    throw $failure
}
