#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly,[switch]$SkipModels)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Workbench-Config.ps1')
$settings=Get-HomeAISettings $Root
if($settings.openclawVersion -ne '2026.10.3'){throw 'Workbench targets the checked OpenClaw 2026.10.3 runtime.'}
Write-Host 'Stage 3: local project file tools with verified backups, durable task notes, and local specialist routing.'
Write-Host 'Default downloads: Gemma 4 E4B Q4 (~6.6 GB) and Qwen3-VL 4B Q4 (~3.3 GB). Main Qwen is retained.'
if($PlanOnly){Write-Host 'PLAN ONLY: no writes, downloads, backups, restarts or inference.';return}
$savedConfigPath=Assert-HomeAIChild (Join-Path $settings.root 'state\openclaw\openclaw.json') $settings.root
$savedConfigBytes=[IO.File]::ReadAllBytes($savedConfigPath)
try {
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAIEnvironment $settings
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {
    if($file.Name -in @('Invoke-OpenClawWorker.ps1','OpenClaw-Chat-Config.ps1','PROJECT-DESIGN.html')){continue}
    $target=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$file.Name)) $settings.root
    if($target -ne $file.FullName){Copy-Item -LiteralPath $file.FullName -Destination $target -Force}
}
$pluginDir=Assert-HomeAIChild (Join-Path $settings.root 'scripts\workbench-plugin') $settings.root
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
foreach($name in @('package.json','openclaw.plugin.json','index.mjs')) {
    $source=Join-Path $PSScriptRoot ('workbench-plugin\'+$name)
    $target=Assert-HomeAIChild (Join-Path $pluginDir $name) $settings.root
    if($source -ne $target){Copy-Item -LiteralPath $source -Destination $target -Force}
}
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -ModelsOnly
$ollama=Join-Path $settings.root 'runtime\ollama\ollama.exe'
$modelSpecs=@(
    @{role='quick';source='gemma4:e4b-it-q4_K_M';alias='homeai-fast:locked';prefix='dc35e8d9c606'},
    @{role='vision';source='qwen3-vl:4b-instruct-q4_K_M';alias='homeai-vision:locked';prefix='ee4b975b58c1'}
)
$roles=@{}
foreach($spec in $modelSpecs) {
    $tags=(Get-HomeAIOllama $settings '/api/tags').models
    $alias=@($tags | Where-Object {$_.name -eq $spec.alias}) | Select-Object -First 1
    if(-not $alias -and -not $SkipModels) {
        $free=(Get-PSDrive -Name ([IO.Path]::GetPathRoot($settings.root).Substring(0,1))).Free
        if($free -lt 25GB){throw 'Reserve 25 GB for specialist downloads and runtime scratch space.'}
        Invoke-HomeAINative $ollama @('pull',$spec.source)
        $source=@((Get-HomeAIOllama $settings '/api/tags').models | Where-Object {$_.name -eq $spec.source}) | Select-Object -First 1
        if(-not $source -or ($source.digest -replace '^sha256:','') -notlike ($spec.prefix+'*')){throw "Model source differs from checked catalog pin: $($spec.source). Existing aliases were not replaced."}
        Invoke-HomeAINative $ollama @('cp',$spec.source,$spec.alias)
        $alias=@((Get-HomeAIOllama $settings '/api/tags').models | Where-Object {$_.name -eq $spec.alias}) | Select-Object -First 1
    }
    if($alias) {
        if(($alias.digest -replace '^sha256:','') -notlike ($spec.prefix+'*')){throw "Existing alias differs from the checked pin: $($spec.alias). Refusing to replace it."}
        $roles[$spec.role]=@{status='installed';model=$spec.alias;digest=$alias.digest;source=$spec.source}
    } else {$roles[$spec.role]=@{status='not-installed';model=$spec.alias;source=$spec.source}}
}
$main=@((Get-HomeAIOllama $settings '/api/tags').models | Where-Object {$_.name -eq $settings.mainModel}) | Select-Object -First 1
if(-not $main){throw 'The existing main model is missing.'}
foreach($role in @('general','code','document')){$roles[$role]=@{status='installed';model=$settings.mainModel;digest=$main.digest}}
Write-HomeAIJson (Join-Path $settings.root 'state\specialist-routes.json') @{owner='home-ai-specialists-v1';roles=$roles;maxLoadedModels=1;context=8192}
$node=Get-HomeAINode $settings;$claw=Get-HomeAIOpenClaw $settings
$installed=Assert-HomeAIChild (Join-Path $settings.root 'state\openclaw\extensions\homeai-workbench\package.json') $settings.root
if(Test-Path -LiteralPath $installed) {
    $package=Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json
    if($package.name -ne 'homeai-workbench' -or $package.version -notin @('0.1.0','0.2.0','0.3.0')){throw 'A different workbench plugin is installed; automatic replacement refused.'}
} else {Invoke-HomeAINative $node @($claw,'plugins','install',$pluginDir)}
$configPath=Join-Path $settings.root 'state\openclaw\openclaw.json'
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$config=Set-HomeAIWorkbenchConfig $config $settings $roles
Write-HomeAIJson $configPath $config
Invoke-HomeAINative $node @($claw,'config','validate')
$inspectionText=& $node $claw plugins inspect homeai-workbench --runtime --json
if($LASTEXITCODE -ne 0){throw 'Workbench runtime inspection failed.'}
$inspection=($inspectionText -join "`n") | ConvertFrom-Json
if($inspection.plugin.status -ne 'loaded' -or @($inspection.diagnostics | Where-Object {$_.level -eq 'error'}).Count){throw 'Workbench runtime registration has errors; gateway remains stopped.'}
Write-Host 'Checking real local specialist replies and recording GPU residency. First load can take a few minutes.'
Invoke-HomeAINative $node @((Join-Path $settings.root 'scripts\check-workbench.mjs'),$settings.root)
Write-HomeAIJson (Join-Path $settings.root 'state\workbench-connector.json') @{owner='home-ai-workbench-v1';version='0.1.0';installedAt=[DateTimeOffset]::UtcNow.ToString('o');backgroundExecutionEnabled=$false}
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
Write-Host 'Workbench ready. Open a NEW chat. Ask: Create a saved task named Workbench check, then write README.md in project sandbox-demo.'
Write-Host 'For routing: Use the local quick specialist to summarize this paragraph. Report the actual model used.'
Write-Host 'Task notes persist, but unattended execution/reboot continuation is not enabled in this stage.'
Invoke-HomeAINative $node @($claw,'dashboard')
} catch {
    $failure=$_
    Write-Host 'Workbench setup did not finish. Restoring the prior chat configuration and attempting to restart it.'
    try {& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root} catch {Write-Host ('Service cleanup needs attention: '+$_.Exception.Message);throw $failure}
    $restored=[Text.Encoding]::UTF8.GetString($savedConfigBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $restored=Set-HomeAIWorkbenchConfig $restored $settings @{} -Disabled
    Write-HomeAIJson $savedConfigPath $restored
    try {& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser} catch {Write-Host ('Chat restart also needs attention: '+$_.Exception.Message)}
    throw $failure
}
