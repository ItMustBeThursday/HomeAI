# Copies the orchestrator working copy into this repo, then commits and pushes only orchestrator/.
# Refuses to publish if the offline tests fail or anything resembling a credential is found.
param(
  [Parameter(Mandatory)][string]$Message,
  [string]$Source = 'D:\HomeAI\projects\orchestrator',
  [switch]$NoPush,
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$dest = Join-Path $repo 'orchestrator'
if (-not (Test-Path (Join-Path $Source 'SPEC.md'))) { throw "Orchestrator source not found: $Source" }

if (-not $SkipTests) {
  Push-Location $Source
  try { node --test 2>&1 | Out-Null; $failed = $LASTEXITCODE } finally { Pop-Location }
  if ($failed) { throw "Tests failed in $Source; not publishing (run 'node --test' there for details)." }
}

# The repo is public: block likely secrets (API keys, tokens, private keys, bearer values).
$secretPattern = 'sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{20,}|tskey-[A-Za-z0-9-]{20,}'
$hits = Get-ChildItem $Source -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|data|state|logs)\\' -and $_.Length -lt 2MB } |
  Select-String -Pattern $secretPattern -List
if ($hits) { throw "Possible secret found; not publishing:`n$(($hits | ForEach-Object { "$($_.Path):$($_.LineNumber)" }) -join "`n")" }

# /MIR mirrors deletions too; runtime/state folders never leave the PC.
robocopy $Source $dest /MIR /XD node_modules .git state data logs /XF *.log *.sqlite* .env* auth.json /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

# git writes warnings (e.g. line endings) to stderr; rely on exit codes instead of PowerShell errors.
$ErrorActionPreference = 'Continue'
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
