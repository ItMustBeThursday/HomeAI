# Copies the orchestrator working copy into this repo, then commits and pushes only orchestrator/.
param(
  [Parameter(Mandatory)][string]$Message,
  [string]$Source = 'D:\HomeAI\projects\orchestrator',
  [switch]$NoPush
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$dest = Join-Path $repo 'orchestrator'
if (-not (Test-Path (Join-Path $Source 'SPEC.md'))) { throw "Orchestrator source not found: $Source" }

# /MIR mirrors deletions too; runtime/state folders never leave the PC.
robocopy $Source $dest /MIR /XD node_modules .git state data logs /XF *.log *.sqlite* .env* auth.json /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

git -C $repo add -- orchestrator
git -C $repo diff --cached --quiet -- orchestrator
if ($LASTEXITCODE -eq 0) { 'No orchestrator changes.'; return }
git -C $repo commit -m $Message -- orchestrator
if ($LASTEXITCODE) { throw 'git commit failed' }
if (-not $NoPush) {
  git -C $repo pull --rebase --autostash origin main
  if ($LASTEXITCODE) { throw 'git pull failed' }
  git -C $repo push origin main
  if ($LASTEXITCODE) { throw 'git push failed' }
}
