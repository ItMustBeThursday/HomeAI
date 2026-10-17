# Copies the orchestrator working copy, then commits only orchestrator/. Publishing requires -Push.
# Refuses to publish if the offline tests fail or anything resembling a credential is found.
param(
  [Parameter(Mandatory)][string]$Message,
  [string]$Source = 'D:\HomeAI\projects\orchestrator',
  [switch]$NoPush,
  [switch]$Push,
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$dest = Join-Path $repo 'orchestrator'
. (Join-Path $repo 'home-ai-kit\Common.ps1')
$Source = Get-HomeAIPath $Source
$dest = Get-HomeAIPath $dest
if ($Push -and $NoPush) { throw 'Use either Push or NoPush, not both.' }
# Reject links before recursive enumeration, rather than following them into private folders.
function Get-SafeFiles([string]$Root) {
  $item = Get-Item -LiteralPath $Root -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Publish refuses links.' }
  foreach ($child in Get-ChildItem -LiteralPath $Root -Force) {
    if ($child.Name -match '^OneDrive($| - )' -or $child.Name -in @('node_modules','.git','data','state','logs','private','scratch')) { continue }
    if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Publish refuses links.' }
    if ($child.PSIsContainer) { Get-SafeFiles $child.FullName } else { $child }
  }
}
if (-not (Test-Path (Join-Path $Source 'SPEC.md'))) { throw "Orchestrator source not found: $Source" }

if (-not $SkipTests) {
  Push-Location $Source
  $previousErrorPreference = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; node --test 2>&1 | Out-Null; $failed = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previousErrorPreference; Pop-Location }
  if ($failed) { throw "Tests failed in $Source; not publishing (run 'node --test' there for details)." }
}

# The repo is public: block known credential formats. This is a heuristic, not proof of absence.
$secretPattern = 'sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{20,}|tskey-[A-Za-z0-9-]{20,}'
$hits = Get-SafeFiles $Source |
  Select-String -Pattern $secretPattern -List
if ($hits) { throw "Possible secret found; not publishing:`n$(($hits | ForEach-Object { "$($_.Path):$($_.LineNumber)" }) -join "`n")" }

# Preserve and verify every existing publishable file before mirroring deletions.
$backup = Join-Path 'D:\HomeAI\backups' ('publish-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
$manifest = @()
foreach ($f in Get-SafeFiles $dest) {
  $relative = $f.FullName.Substring($dest.Length + 1)
  $saved = Join-Path $backup $relative
  New-Item -ItemType Directory -Path (Split-Path $saved -Parent) -Force | Out-Null
  Copy-Item -LiteralPath $f.FullName -Destination $saved
  $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  if ($hash -ne (Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash) { throw 'Publish backup verification failed.' }
  $manifest += @{path=$relative;sha256=$hash}
}
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json')
# /MIR mirrors deletions only after the verified snapshot; runtime folders never leave the PC.
robocopy $Source $dest /MIR /XJ /XD node_modules .git state data logs private scratch OneDrive* /XF *.log *.sqlite* .env* auth.json vault.json OneDrive* /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
$hits = Get-SafeFiles $dest | Select-String -Pattern $secretPattern -List
if ($hits) { throw 'Possible secret in mirrored source; commit and publish refused.' }

# git writes warnings (e.g. line endings) to stderr; rely on exit codes instead of PowerShell errors.
$ErrorActionPreference = 'Continue'
git -C $repo add -- orchestrator
if ($LASTEXITCODE) { throw 'git add failed (check that D:\HomeAIGit\HomeAI\.git is writable)' }
git -C $repo diff --cached --quiet -- orchestrator
if ($LASTEXITCODE -eq 0) { 'No orchestrator changes.'; return }
git -C $repo commit -m $Message -- orchestrator
if ($LASTEXITCODE) { throw 'git commit failed' }
if ($Push) {
  git -C $repo pull --rebase --autostash origin main
  if ($LASTEXITCODE) { throw 'git pull failed' }
  git -C $repo push origin main
  if ($LASTEXITCODE) { throw 'git push failed' }
}
