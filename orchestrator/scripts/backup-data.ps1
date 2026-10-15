# Copies data/ (usage ledger, task history, conversations, config backups) to a dated local folder.
# data/ is deliberately never pushed to GitHub, so this is its only backup.
# Usage: .\scripts\backup-data.ps1 [-Dest D:\HomeAI\backups\orchestrator] [-Keep 14]
param([string]$Dest = 'D:\HomeAI\backups\orchestrator', [int]$Keep = 14)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'data'
if (-not (Test-Path $src)) { 'No data folder yet; nothing to back up.'; return }
$target = Join-Path $Dest (Get-Date -Format 'yyyy-MM-dd_HHmmss')
New-Item -ItemType Directory -Force $target | Out-Null
# Copy config too, so a backup restores a working setup on its own.
robocopy $src (Join-Path $target 'data') /E /XD scratch /XF *.log /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
robocopy (Join-Path $root 'config') (Join-Path $target 'config') /E /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
$old = Get-ChildItem $Dest -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($d in $old) { Remove-Item -Recurse -Force $d.FullName }
"Backed up to $target (kept newest $Keep)."
