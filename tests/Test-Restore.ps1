$ErrorActionPreference='Stop'
$kit=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\home-ai-kit'))
. (Join-Path $kit 'Common.ps1')
$caseRoot=Join-Path $PSScriptRoot ('artifacts\r-'+[guid]::NewGuid().ToString('N').Substring(0,6))
$install=Join-Path $caseRoot 'install'
$backup=Join-Path $caseRoot 'backups'
$alternate=Join-Path $caseRoot 'alternate'
foreach($path in @($install,$backup,(Join-Path $install 'state\openclaw\plugin-skills'),(Join-Path $install 'projects\app'))) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}
Write-HomeAIJson (Join-Path $install 'homeai.json') @{
    owner='home-ai-kit-v1';root=$install;backupRoot=$backup;gatewayPort=18795;ollamaPort=11435;nodeVersion='24.21.0'
}
function Write-Text([string]$Relative,[string]$Text){[IO.File]::WriteAllText((Join-Path $install $Relative),$Text)}
function Read-Text([string]$Base,[string]$Relative){Get-Content -LiteralPath (Join-Path $Base $Relative) -Raw}
function Get-Backups {@(Get-ChildItem -LiteralPath $backup -Directory)}
Write-Text 'state\openclaw\openclaw.json' '{"version":1}'
Write-Text 'projects\app\main.txt' 'original'
Write-Text 'state\openclaw\plugin-skills\generated.txt' 'generated runtime'
function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction);return @()}
$snapshot=& (Join-Path $kit 'Backup-HomeAI.ps1') -Root $install

# Damage the installation after the snapshot.
Write-Text 'projects\app\main.txt' 'damaged'
Remove-Item -LiteralPath (Join-Path $install 'state\openclaw\openclaw.json')
Write-Text 'state\openclaw\openclaw.sqlite-wal' 'stale journal'
Write-Text 'projects\app\new.txt' 'created after snapshot'
Write-Text 'state\openclaw\plugin-skills\generated.txt' 'regenerated runtime'

& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $snapshot -PlanOnly
if((Read-Text $install 'projects\app\main.txt') -ne 'damaged'){throw 'PlanOnly changed files.'}
if((Get-Backups).Count -ne 1){throw 'PlanOnly made a backup.'}
Write-Output 'PASS: PlanOnly changes nothing.'

& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $snapshot
if((Read-Text $install 'projects\app\main.txt') -ne 'original'){throw 'Changed project file was not restored.'}
if((Read-Text $install 'state\openclaw\openclaw.json') -ne '{"version":1}'){throw 'Deleted state file was not restored.'}
if(Test-Path -LiteralPath (Join-Path $install 'state\openclaw\openclaw.sqlite-wal')){throw 'Stale journal beside restored state was kept.'}
if(Test-Path -LiteralPath (Join-Path $install 'projects\app\new.txt')){throw 'File absent from the snapshot was kept.'}
if((Read-Text $install 'state\openclaw\plugin-skills\generated.txt') -ne 'regenerated runtime'){throw 'Excluded generated cache was modified.'}
Write-Output 'PASS: in-place restore recovers changed and deleted files and removes files absent from the snapshot.'
Write-Output 'PASS: excluded generated caches are left untouched.'

$safety=@(Get-Backups | Where-Object {$_.FullName -ne $snapshot})
if($safety.Count -ne 1){throw 'No pre-restore backup was made.'}
if((Read-Text $safety[0].FullName 'projects\app\main.txt') -ne 'damaged' -or
    (Read-Text $safety[0].FullName 'projects\app\new.txt') -ne 'created after snapshot') {
    throw 'Pre-restore backup does not hold the replaced state.'
}
Write-Output 'PASS: replaced and removed files are kept in a verified pre-restore backup.'

& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $snapshot -Target $alternate
if((Read-Text $alternate 'projects\app\main.txt') -ne 'original'){throw 'Alternate restore is incomplete.'}
$caught=$null
try {& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $snapshot -Target $alternate} catch {$caught=$_.Exception.Message}
if($caught -notmatch 'must be empty'){throw 'Non-empty alternate target was accepted.'}
Write-Output 'PASS: alternate restore fills an empty folder and refuses a non-empty one.'

$caught=$null
try {& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $snapshot -Target 'C:\Users\example\OneDrive - Contoso\HomeAI'} catch {$caught=$_.Exception.Message}
if($caught -notmatch 'OneDrive'){throw 'OneDrive restore target was accepted.'}
$caught=$null
try {& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $install} catch {$caught=$_.Exception.Message}
if($caught -notmatch 'outside the intended'){throw 'Snapshot outside the backup folder was accepted.'}
Write-Output 'PASS: OneDrive targets and snapshots outside the backup folder are refused.'

# A damaged snapshot is refused before services, backups or files are touched.
Write-Text 'projects\app\main.txt' 'edited again'
[IO.File]::WriteAllText((Join-Path $snapshot 'projects\app\main.txt'),'tampered')
$before=(Get-Backups).Count
$caught=$null
try {& (Join-Path $kit 'Restore-HomeAI.ps1') -Root $install -Snapshot $snapshot} catch {$caught=$_.Exception.Message}
if($caught -notmatch 'damaged'){throw 'Damaged snapshot was not refused.'}
if((Read-Text $install 'projects\app\main.txt') -ne 'edited again' -or (Get-Backups).Count -ne $before){throw 'Damaged snapshot changed the installation.'}
Write-Output 'PASS: a damaged snapshot is refused before anything is changed.'
