#Requires -Version 5.1
param([string]$Root='D:\HomeAI')
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
$backupRoot=Get-HomeAIPath $settings.backupRoot
$destination=Assert-HomeAIChild (Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))) $backupRoot
$node=Get-HomeAINode $settings
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'Pinned HomeAI Node runtime is missing; backup was not started.'}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Write-Host ('Backup: streaming and SHA-256-verifying files to '+$destination)
# Native helper retains the same scope/exclusions and reports progress on stdout.
# Out-Host prevents its JSON summary from contaminating the returned backup path.
& $node (Join-Path $PSScriptRoot 'backup-snapshot.mjs') $settings.root $destination | Out-Host
if($LASTEXITCODE -ne 0){throw 'Backup did not finish. No completion manifest was published; partial files were retained.'}
if(-not (Test-Path -LiteralPath (Join-Path $destination 'backup-manifest.json'))){throw 'Backup completion manifest is missing.'}
Write-Host ('Verified backup: '+$destination+' (models and generated runtime caches excluded; see backup-manifest.json).')
return $destination