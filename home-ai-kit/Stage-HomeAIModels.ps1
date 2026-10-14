#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
Write-Host 'Stage EmbeddingGemma 300M (622 MB) for the next semantic-memory phase. Download only; no GPU inference or memory configuration changes.'
if($PlanOnly){return}
Set-HomeAIEnvironment $settings
$source='embeddinggemma:300m';$prefix='85462619ee72'
$alias='homeai-embedding:locked'
$tags=(Get-HomeAIOllama $settings '/api/tags').models
$found=@($tags | Where-Object {$_.name -eq $alias}) | Select-Object -First 1
if(-not $found){
    $drive=Get-PSDrive -Name ([IO.Path]::GetPathRoot($settings.root).Substring(0,1))
    if($drive.Free -lt 3GB){throw 'Reserve at least 3 GB before staging the embedding model.'}
    $ollama=Join-Path $settings.root 'runtime\ollama\ollama.exe'
    Invoke-HomeAINative $ollama @('pull',$source)
    $download=@((Get-HomeAIOllama $settings '/api/tags').models | Where-Object {$_.name -eq $source}) | Select-Object -First 1
    if(-not $download -or ($download.digest -replace '^sha256:','') -notlike ($prefix+'*')){throw 'Embedding model changed from the checked catalogue pin; alias was not created.'}
    Invoke-HomeAINative $ollama @('cp',$source,$alias)
    $found=@((Get-HomeAIOllama $settings '/api/tags').models | Where-Object {$_.name -eq $alias}) | Select-Object -First 1
}
if(-not $found -or ($found.digest -replace '^sha256:','') -notlike ($prefix+'*')){throw 'Existing embedding alias differs; automatic replacement refused.'}
Write-HomeAIJson (Join-Path $settings.root 'state\embedding-stage.json') @{owner='home-ai-embedding-stage-v1';model=$alias;source=$source;digest=$found.digest;status='downloaded-not-enabled';reason='Verify a CPU memory backend before enabling continuous embeddings alongside GPU jobs.'}
Write-Host 'Embedding model staged. It is not a chat model and is not yet an enabled memory backend.'
