#Requires -Version 5.1
param([string]$Root='D:\HomeAI',[ValidateSet('list','get','pause','resume')][string]$Action='list',[string]$Id)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
$jobArguments=@((Join-Path $settings.root 'scripts\jobs-plugin\manage.mjs'),$settings.root,$Action)
if($Action -ne 'list') {
    if($Id -notmatch '^[a-f0-9-]{36}$'){throw 'Provide the exact job ID.'}
    $jobArguments+=$Id
}
Invoke-HomeAINative (Get-HomeAINode $settings) $jobArguments
