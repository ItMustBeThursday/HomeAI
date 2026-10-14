#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
Write-Host 'Stage Heretic source in an isolated experiment and probe existing native Windows PyTorch/HIP.'
Write-Host 'No model weights, drivers, Python packages or Linux distributions are installed; no abliteration is started.'
if($PlanOnly){return}
Set-HomeAIEnvironment $settings
$git=Join-Path $settings.root 'runtime\git\cmd\git.exe'
$source=Assert-HomeAIChild (Join-Path $settings.root 'runtime\heretic-source') $settings.root
$markerPath=Join-Path $settings.root 'state\heretic-stage.json'
if(Test-Path -LiteralPath $source) {
    if(-not (Test-Path -LiteralPath $markerPath)){throw 'Existing Heretic source is not owned by this stage.'}
    $marker=Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if($marker.owner -ne 'home-ai-heretic-v1'){throw 'Heretic source ownership differs.'}
    $sha=$marker.sourceCommit
} else {
    $remote=& $git ls-remote 'https://github.com/p-e-w/heretic.git' 'refs/heads/master'
    if($LASTEXITCODE -ne 0 -or ($remote -join '') -notmatch '^([0-9a-f]{40})\s'){throw 'Could not resolve the official Heretic source commit.'}
    $sha=$Matches[1]
    Write-HomeAIJson $markerPath @{owner='home-ai-heretic-v1';sourceCommit=$sha;status='source-fetch-in-progress';activeMainModelChanged=$false}
    New-Item -ItemType Directory -Path $source | Out-Null
    Invoke-HomeAINative $git @('init',$source)
    Invoke-HomeAINative $git @('-C',$source,'remote','add','origin','https://github.com/p-e-w/heretic.git')
    Invoke-HomeAINative $git @('-C',$source,'fetch','--depth','1','origin',$sha)
    Invoke-HomeAINative $git @('-C',$source,'checkout','--detach',$sha)
}
$head=& $git -C $source rev-parse HEAD 2>$null
if($LASTEXITCODE -ne 0 -or ($head -join '').Trim() -ne $sha) {
    Invoke-HomeAINative $git @('-C',$source,'fetch','--depth','1','origin',$sha)
    Invoke-HomeAINative $git @('-C',$source,'checkout','--detach',$sha)
}
$probe=@{gpuReady=$false;status='native-python-pytorch-probe-needed'}
$python=Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if($python -and $python.Source -notmatch '\\WindowsApps\\') {
    $probeText=& $python.Source (Join-Path $PSScriptRoot 'heretic-probe.py')
    if($LASTEXITCODE -eq 0){try{$probe=($probeText -join "`n") | ConvertFrom-Json}catch{Write-Host 'Existing Python probe was inconclusive.'}}
}
Write-HomeAIJson $markerPath @{owner='home-ai-heretic-v1';sourceCommit=$sha;sourceDirectory=$source;probe=$probe;
    firstExperiment='Qwen/Qwen3-4B-Instruct-2507';status='staged-not-run';activeMainModelChanged=$false;
    nextSteps=@('Create isolated environment with the pinned source uv.lock and a verified native Windows HIP PyTorch build',
        'Run first experiment on the small supported Qwen3-4B model, saving a separate output',
        'Compare capability/quality before GGUF quantization and import under an experimental Ollama alias')}
Write-Host "Heretic source pinned at $sha. Experiment is staged, not run. Report: $markerPath"
Write-Host 'Use the probe report to select a compatible Windows PyTorch environment before installing dependencies.'
