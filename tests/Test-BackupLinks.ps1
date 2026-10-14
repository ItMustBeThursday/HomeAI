$ErrorActionPreference='Stop'
$kit=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\home-ai-kit'))
. (Join-Path $kit 'Common.ps1')
$caseRoot=Join-Path $PSScriptRoot ('artifacts\j-'+[guid]::NewGuid().ToString('N').Substring(0,6))
$install=Join-Path $caseRoot 'install'
$backup=Join-Path $caseRoot 'backups'
$external=Join-Path $caseRoot 'outside-install'
foreach($path in @($install,$backup,$external,(Join-Path $install 'state\openclaw\plugin-skills'),
    (Join-Path $install 'state\openclaw\npm\projects\openclaw-codex-8902d781d4\node_modules\@openclaw\codex\node_modules'),
    (Join-Path $install 'workspace\skills'),(Join-Path $install 'projects'))) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
Write-HomeAIJson (Join-Path $install 'homeai.json') @{
    owner='home-ai-kit-v1';root=$install;backupRoot=$backup;gatewayPort=18795;nodeVersion='24.21.0'
}
[IO.File]::WriteAllText((Join-Path $external 'outside.txt'),'outside-install sentinel: do not copy')
[IO.File]::WriteAllText((Join-Path $install 'workspace\skills\personal.txt'),'preserve this user skill')
New-Item -ItemType Junction -Path (Join-Path $install 'state\openclaw\plugin-skills\browser-automation') -Target $external | Out-Null
# A cycle in an excluded generated cache cannot trap the backup in recursion.
New-Item -ItemType Junction -Path (Join-Path $install 'state\openclaw\plugin-skills\cycle') -Target $install | Out-Null
New-Item -ItemType Junction -Path (Join-Path $install 'state\openclaw\npm\projects\openclaw-codex-8902d781d4\node_modules\@openclaw\codex\node_modules\openclaw') -Target $external | Out-Null
New-Item -ItemType Junction -Path (Join-Path $install 'state\openclaw\npm\projects\cycle') -Target $install | Out-Null
[IO.File]::WriteAllText((Join-Path $install 'state\openclaw\npm\installation-record.json'),'{"plugin":"codex","version":"2026.10.3"}')
[IO.File]::WriteAllText((Join-Path $install 'projects\user-project.txt'),'preserve actual project')
function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction);return @()}
$snapshot=& (Join-Path $kit 'Backup-HomeAI.ps1') -Root $install
$manifest=Get-Content -LiteralPath (Join-Path $snapshot 'backup-manifest.json') -Raw | ConvertFrom-Json
if(-not $manifest.verified){throw 'Snapshot was not verified.'}
if(@($manifest.excluded | Where-Object {$_.path -eq 'state\openclaw\plugin-skills'}).Count -ne 1){throw 'Cache exclusion not recorded.'}
if(Test-Path -LiteralPath (Join-Path $snapshot 'state\openclaw\plugin-skills')){throw 'Generated cache was copied.'}
if(@($manifest.excluded | Where-Object {$_.path -eq 'state\openclaw\npm\projects'}).Count -ne 1){throw 'Generated npm project exclusion not recorded.'}
if(Test-Path -LiteralPath (Join-Path $snapshot 'state\openclaw\npm\projects')){throw 'Generated npm runtime projects were copied.'}
if(-not (Test-Path -LiteralPath (Join-Path $snapshot 'state\openclaw\npm\installation-record.json'))){throw 'Npm metadata outside generated projects was lost.'}
if((Get-Content -LiteralPath (Join-Path $snapshot 'projects\user-project.txt') -Raw) -ne 'preserve actual project'){throw 'Actual user project was excluded.'}
if(@($manifest.files | Where-Object {$_.path -match 'outside.txt'}).Count -gt 0){throw 'An external junction target was copied.'}
if((Get-Content -LiteralPath (Join-Path $snapshot 'workspace\skills\personal.txt') -Raw) -ne 'preserve this user skill'){throw 'User skill was lost.'}
foreach($file in $manifest.files) {
    if((Get-FileHash -LiteralPath (Join-Path $snapshot $file.path) -Algorithm SHA256).Hash -ne $file.sha256){throw 'Snapshot hash mismatch.'}
}
Write-Output 'PASS: generated cache with an external junction and a cycle is excluded without following links.'
Write-Output 'PASS: exclusion is recorded; user skills are preserved; copied files verify against the manifest.'
Write-Output 'PASS: generated npm dependency projects with host-package links/cycles are excluded; npm metadata and actual user projects are preserved.'

New-Item -ItemType Junction -Path (Join-Path $install 'projects\unexpected-link') -Target $external | Out-Null
$before=@(Get-ChildItem -LiteralPath $backup -Directory | Select-Object -ExpandProperty FullName)
$caught=$null
try {& (Join-Path $kit 'Backup-HomeAI.ps1') -Root $install | Out-Null} catch {$caught=$_.Exception.Message}
if(-not $caught -or $caught -notmatch 'unrecognized link'){throw 'Unexpected project link was not rejected.'}
$new=@(Get-ChildItem -LiteralPath $backup -Directory | Where-Object {$before -notcontains $_.FullName})
foreach($folder in $new) {
    if(Test-Path -LiteralPath (Join-Path $folder.FullName 'backup-manifest.json')){throw 'Failed snapshot was marked complete.'}
}
if((Get-Content -LiteralPath (Join-Path $external 'outside.txt') -Raw) -ne 'outside-install sentinel: do not copy'){throw 'External target was modified.'}
Write-Output 'PASS: unexpected project junction is refused; failed snapshots have no completion manifest; target is unchanged.'
