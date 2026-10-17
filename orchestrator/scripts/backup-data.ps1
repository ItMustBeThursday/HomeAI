# Hash-verified data/config snapshots; private sessions and scratch are excluded.
# Existing snapshots are retained. Keep is an advisory compatibility parameter.
param([string]$Dest = 'D:\HomeAI\backups\orchestrator', [ValidateRange(1,100000)][int]$Keep = 14)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& node (Join-Path $PSScriptRoot 'backup-data.mjs') $root $Dest
if ($LASTEXITCODE) { throw "Backup verification failed (exit $LASTEXITCODE); existing snapshots retained." }
Write-Output "All existing snapshots retained; Keep=$Keep is advisory, no automatic deletion."
