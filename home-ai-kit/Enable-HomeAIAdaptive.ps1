#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Fleet-Config.ps1')
. (Join-Path $PSScriptRoot 'Execution-Config.ps1')
. (Join-Path $PSScriptRoot 'Adaptive-Config.ps1')
$settings=Get-HomeAISettings $Root
$configPath=Join-Path $settings.root 'state\openclaw\openclaw.json'
$saved=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if(-not $saved.plugins.entries.PSObject.Properties['homeai-execution'] -or -not $saved.plugins.entries.'homeai-execution'.enabled){throw 'Finish Enable-HomeAIExecution.ps1 first.'}
Write-Host 'Enable task-role routing, persistent measurements/human feedback, checked model staging, and verified restorable task-guidance changes. No idle paid-model loop.'
if($PlanOnly){return}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIEnvironment $settings
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
try {
    foreach($folder in @('jobs-plugin','workbench-plugin','execution-plugin','autonomy-plugin')) {
        $target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$folder)) $settings.root
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        foreach($file in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $folder) -File){$destination=Assert-HomeAIChild (Join-Path $target $file.Name) $settings.root;if($file.FullName -ne $destination){Copy-Item -LiteralPath $file.FullName -Destination $destination -Force}}
    }
    foreach($name in @('Adaptive-Config.ps1','Execution-Config.ps1','Fleet-Config.ps1','Native-Chat-Config.ps1','Enable-HomeAIAdaptive.ps1','Enable-HomeAIJobs.ps1','Start-HomeAI.ps1','initialize-homeai-router.mjs','ADAPTIVE.txt','audit-homeai.mjs')) {
        $source=Join-Path $PSScriptRoot $name;$target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$name)) $settings.root
        if($source -ne $target){Copy-Item -LiteralPath $source -Destination $target -Force}
    }
    & (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -ModelsOnly -NoBrowser
    Invoke-HomeAINative $node @((Join-Path $settings.root 'scripts\initialize-homeai-router.mjs'),$settings.root)
    foreach($id in @('homeai-workbench','homeai-jobs','homeai-execution','homeai-autonomy')) {
        $installed=Assert-HomeAIChild (Join-Path $settings.root ('state\openclaw\extensions\'+$id+'\package.json')) $settings.root
        if(Test-Path -LiteralPath $installed){$package=Get-Content $installed -Raw | ConvertFrom-Json;if($package.name -ne $id -or $package.version -notin @('0.1.0','0.2.0','0.3.0','0.4.0')){throw "Unrecognized owned plugin: $id"}}
    }
    $config=($saved | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $config.plugins.entries | Add-Member -NotePropertyName 'homeai-autonomy' -NotePropertyValue @{enabled=$false;config=@{root=$settings.root}} -Force
    Write-HomeAIJson $configPath $config
    foreach($folder in @('workbench-plugin','jobs-plugin','execution-plugin','autonomy-plugin')){Invoke-HomeAINative $node @($claw,'plugins','install',(Join-Path $settings.root ('scripts\'+$folder)),'--force','--no-enable')}
    $config=Set-HomeAIAdaptiveConfig $config $settings
    Write-HomeAIJson $configPath $config
    Invoke-HomeAINative $node @($claw,'config','validate')
    foreach($id in @('homeai-workbench','homeai-jobs','homeai-execution','homeai-autonomy')) {
        $text=& $node $claw plugins inspect $id --runtime --json
        if($LASTEXITCODE -ne 0){throw "Runtime inspection failed: $id"}
        $inspection=($text -join "`n") | ConvertFrom-Json
        if($inspection.plugin.status -ne 'loaded' -or @($inspection.diagnostics | Where-Object {$_.level -eq 'error'}).Count){throw "Runtime registration failed: $id"}
    }
    Invoke-HomeAINative $node @((Join-Path $settings.root 'scripts\initialize-homeai-router.mjs'),$settings.root,'--enable')
    & (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
    Write-Host 'Adaptive routing enabled. Use roles in plans; /homeai_router shows preferences; /homeai_rate JOB-ID 1-to-5 records human feedback.'
    Write-Host 'Use /homeai_changes for queued models/change reports and /homeai_restore CHANGE-ID to restore the newest managed revision.'
} catch {
    $failure=$_
    try {& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root} catch {throw $failure}
    try {Invoke-HomeAINative $node @((Join-Path $settings.root 'scripts\initialize-homeai-router.mjs'),$settings.root,'--disable')} catch {Write-Host ('Router disable needs attention: '+$_.Exception.Message)}
    $saved.plugins.entries | Add-Member -NotePropertyName 'homeai-autonomy' -NotePropertyValue @{enabled=$false;config=@{root=$settings.root}} -Force
    Write-HomeAIJson $configPath $saved
    try {& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser} catch {Write-Host ('Chat restart needs attention: '+$_.Exception.Message)}
    throw $failure
}
