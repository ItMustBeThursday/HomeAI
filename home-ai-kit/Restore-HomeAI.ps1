#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[Parameter(Mandatory=$true)][string]$Snapshot,[string]$Target,[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
$backupRoot=Get-HomeAIPath $settings.backupRoot
$snapshotPath=Assert-HomeAIChild $Snapshot $backupRoot
$manifestPath=Join-Path $snapshotPath 'backup-manifest.json'
if(-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'The snapshot has no completion manifest; it is incomplete and cannot be restored.'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if(-not $manifest.verified){throw 'The snapshot manifest is not marked verified.'}
$files=@($manifest.files)
$excluded=@()
if($manifest.PSObject.Properties['excluded']){$excluded=@($manifest.excluded | ForEach-Object {$_.path})}

# Verify the whole snapshot before anything is stopped or changed.
foreach($file in $files) {
    $source=Assert-HomeAIChild (Join-Path $snapshotPath $file.path) $snapshotPath
    if(-not (Test-Path -LiteralPath $source -PathType Leaf) -or
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $file.sha256) {
        throw "Snapshot is damaged: $($file.path). Nothing was changed."
    }
}

$inPlace=$true
$destRoot=$settings.root
if($Target) {
    $destRoot=Get-HomeAIPath $Target
    if($destRoot -ne $settings.root) {
        $inPlace=$false
        foreach($protected in @($settings.root,$backupRoot)) {
            if($destRoot.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)) {
                throw 'An alternate restore target must be outside the HomeAI and backup folders.'
            }
        }
        if((Test-Path -LiteralPath $destRoot) -and @(Get-ChildItem -LiteralPath $destRoot -Force).Count) {
            throw 'An alternate restore target must be empty.'
        }
    }
}

Write-Host "Snapshot: $snapshotPath ($($files.Count) verified files, created $($manifest.createdAt))."
if($inPlace) {
    Write-Host 'In-place restore: stop services, back up current state, replace HomeAI data, and remove files absent from the snapshot.'
    Write-Host 'Generated runtime caches excluded from the snapshot are left in place. Models are not touched.'
} else {
    Write-Host "Alternate restore into empty folder $destRoot. The running installation is not changed."
}
if($PlanOnly){Write-Host 'PLAN ONLY: no services stopped, no backup, no files changed.';return}

$safety=$null
$removed=0
if($inPlace) {
    & (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
    # Every overwrite or removal below is covered by this verified backup.
    $safety=& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root
    Write-Host "Current state saved first: $safety"

    $keep=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($file in $files){[void]$keep.Add($file.path)}
    $skip=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($path in $excluded){[void]$skip.Add($path)}

    function Remove-HomeAIExtra([string]$Path,[string]$Relative) {
        if($skip.Contains($Relative)){return}
        $item=Get-Item -LiteralPath $Path -Force
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Restore refuses unrecognized link: $Path"}
        if($item.PSIsContainer) {
            # One level at a time, as in Backup-HomeAI.ps1, so no junction is followed.
            foreach($child in Get-ChildItem -LiteralPath $Path -Force) {
                Remove-HomeAIExtra $child.FullName (Join-Path $Relative $child.Name)
            }
        } elseif(-not $keep.Contains($Relative)) {
            Remove-Item -LiteralPath (Assert-HomeAIChild $Path $destRoot) -Force
            $script:removed++
        }
    }
    # Stale files such as SQLite -wal/-shm beside a restored database would corrupt it.
    # homeai.json and scripts are overwritten but never pruned.
    foreach($name in (Get-HomeAIBackupItems | Where-Object {$_ -notin @('homeai.json','scripts')})) {
        $path=Assert-HomeAIChild (Join-Path $destRoot $name) $destRoot
        if(Test-Path -LiteralPath $path){Remove-HomeAIExtra $path $name}
    }
} else {
    New-Item -ItemType Directory -Path $destRoot -Force | Out-Null
}

foreach($file in $files) {
    $source=Join-Path $snapshotPath $file.path
    $dest=Assert-HomeAIChild (Join-Path $destRoot $file.path) $destRoot
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $dest -Force
    if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -ne $file.sha256) {
        throw "Restored file failed verification: $($file.path). Pre-restore backup: $safety"
    }
}

Write-Host "Restored and verified $($files.Count) files; removed $removed files absent from the snapshot."
if($excluded.Count) {
    Write-Host "Not in the snapshot (regenerated or reinstalled): $($excluded -join ', ')."
}
if($inPlace) {
    Write-Host "Pre-restore backup: $safety"
    Write-Host 'Run Start-HomeAI.ps1 and Restart-Orchestrator.ps1.'
} else {
    Write-Host 'This copy is for inspection or testing. Its homeai.json still names the original folder, so it is not runnable as-is.'
}
