#requires -Version 5.1
<#
STAGED FOR REVIEW. No automatic execution, installs or live configuration changes.
PlanOnly reads/hashes only. Stage creates a NEW additive destination; never merges.
Rollback removes only unchanged staged payload bytes after verifying backup bytes.
#>
[CmdletBinding()]
param(
    [ValidateSet('PlanOnly','Stage','Rollback')][string]$Mode = 'PlanOnly',
    [string]$SourceRoot = '',
    [string]$Destination = 'D:\HomeAI\extensions\evolution'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = $PSScriptRoot }
$Owner = 'homeai-evolution-stage-v1'
$Files = @(
    'README.md','CURRENT-RUNBOOK.md','STATUS.md',
    'MISSION.md','SPEC.md','CONTRACTS.md','CAPABILITY-MATRIX.md',
    'execution-policy.mjs','model-policy.mjs','switch-core.mjs','voice-core.mjs',
    'runtime-runner.mjs','run-kit.mjs',
    'all.test.mjs','switch.test.mjs','policy.test.mjs','voice.test.mjs','runner.test.mjs','regression.test.mjs',
    'demo/index.html','demo/app.mjs','demo/build.mjs',
    'Prepare-HomeAIEvolution.ps1','Start-HomeAIEvolution.ps1',
    'OPERATIONS.md','ACCESS-PLAN.md','DEVICE-VOICE-ROADMAP.md','GROWTH-BACKLOG.md'
)
function Safe-LocalPath([string]$Path) {
    if ($Path -notmatch '^[DEde]:\\' -or $Path -match '[\x00-\x1f"*?<>|]' -or
        $Path.Substring(2).Contains(':') -or $Path -match '(^|\\)\.\.?($|\\)' -or
        $Path -match '(^|\\)[^\\]*[. ]($|\\)') { throw "Require a plain absolute D/E path without traversal or streams: $Path" }
    $Full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($Full.Length -le 2) { throw 'Drive root refused.' }
    $Cursor = $Full
    while ($Cursor.Length -gt 3) {
        if (Test-Path -LiteralPath $Cursor) {
            $Item = Get-Item -LiteralPath $Cursor -Force
            if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point refused: $Cursor" }
        }
        $Cursor = Split-Path -Parent $Cursor
    }
    return $Full
}
function Hash([string]$Path) {
    $null = Safe-LocalPath $Path
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Regular file required: $Path"
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function New-Text([string]$Path, [string]$Text) {
    $Bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
    $Stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $Stream.Write($Bytes, 0, $Bytes.Length) } finally { $Stream.Dispose() }
}
function Copy-Verified([string]$From, [string]$To, [string]$Expected) {
    if ((Hash $From) -ne $Expected) { throw "Source changed: $From" }
    $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $To))
    [IO.File]::Copy($From, $To, $false)
    if ((Hash $From) -ne $Expected -or (Hash $To) -ne $Expected) { throw "Copy verification failed: $To" }
}
$Destination = Safe-LocalPath $Destination
if ($Destination -ine 'D:\HomeAI\extensions\evolution' -and
    $Destination -notmatch '^D:\\HomeAI\\state\\evolution-fixtures\\[A-Za-z0-9_-]+$') {
    throw 'Destination must be the additive evolution extension or a scoped evolution fixture.'
}
$Payload = Join-Path $Destination 'payload'
$Backup = Join-Path $Destination 'backup'
$ReceiptPath = Join-Path $Destination 'stage-receipt.json'
if ($Mode -eq 'Rollback') {
    # Retain backups and receipts. Never restore over live/repository paths.
    $null = Safe-LocalPath $Payload
    $null = Safe-LocalPath $Backup
    $null = Hash $ReceiptPath
    $Receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
    if ($Receipt.owner -cne $Owner -or $Receipt.destination -ine $Destination -or $Receipt.version -ne 1) { throw 'Ownership mismatch.' }
    $BackupReceipt = Join-Path $Backup 'stage-receipt.json'
    if ((Hash $ReceiptPath) -ne (Hash $BackupReceipt)) { throw 'Backup receipt mismatch.' }
    $ExpectedNames = @($Files + 'kit.manifest.json' + 'simulator.manifest.json')
    $Records = @($Receipt.files)
    if ($Records.Count -ne $ExpectedNames.Count) { throw 'Unexpected receipt count.' }
    foreach ($Name in $ExpectedNames) {
        $Rows = @($Records | Where-Object { $_.name -ceq $Name })
        if ($Rows.Count -ne 1 -or $Rows[0].sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid receipt entry.' }
        if ((Hash (Join-Path $Backup $Name)) -ne $Rows[0].sha256 -or
            (Hash (Join-Path $Payload $Name)) -ne $Rows[0].sha256) { throw "Changed file; rollback refused: $Name" }
    }
    foreach ($Directory in @(Get-ChildItem -LiteralPath $Payload -Force -Directory)) {
        if ($Directory.Name -cne 'demo' -or ($Directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            @(Get-ChildItem -LiteralPath $Directory.FullName -Force -Directory).Count -ne 0) {
            throw 'Unknown or linked directory; rollback refused. Preserve generated build output separately.'
        }
    }
    $Entries = @(Get-ChildItem -LiteralPath $Payload -Force -Recurse -File)
    if ($Entries.Count -ne $ExpectedNames.Count) { throw 'Unknown payload entries; rollback refused.' }
    foreach ($Entry in $Entries) {
        $RelativeName = $Entry.FullName.Substring($Payload.Length + 1).Replace('\','/')
        if ($ExpectedNames -cnotcontains $RelativeName) { throw 'Unknown payload entry.' }
    }
    # Recheck the restorable copy and payload immediately before each deletion.
    foreach ($Record in $Records) {
        $Target = Join-Path $Payload $Record.name
        if ((Hash (Join-Path $Backup $Record.name)) -ne $Record.sha256 -or
            (Hash $Target) -ne $Record.sha256) { throw 'Concurrent change; stopped.' }
        Remove-Item -LiteralPath $Target
    }
    Write-Output 'Staged payload removed; verified backup and receipts retained. No live settings restored or changed.'
    return
}
$SourceRoot = Safe-LocalPath $SourceRoot
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw 'Source directory missing.' }
if ($SourceRoot -ieq $Destination -or $SourceRoot.StartsWith($Destination + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $Destination.StartsWith($SourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source and destination must be disjoint.' }
if (Test-Path -LiteralPath $Destination) { throw 'Destination already exists: no merge, overwrite, upgrade or unknown-file adoption.' }
# Exact allowlist only: no .env, credentials, account state, runtime config,
# repository tree, user backup directories, models, logs or arbitrary recursion.
$Records = @()
foreach ($Name in $Files) {
    $Path = Join-Path $SourceRoot $Name
    $Records += [pscustomobject]@{ name = $Name; sha256 = (Hash $Path) }
}
$Manifest = [ordered]@{
    version = 1; id = 'homeai-offline-tests'; projectRoot = $Payload
    steps = @([ordered]@{ id = 'all-tests'; kind = 'test'; tool = 'node'; args = @('--test','all.test.mjs'); timeoutMs = 60000 })
}
$ManifestText = $Manifest | ConvertTo-Json -Depth 8
$SimulatorManifest = [ordered]@{
    version = 1; id = 'homeai-switch-lab'; projectRoot = $Payload
    steps = @(
        [ordered]@{ id = 'tests'; kind = 'test'; tool = 'node'; args = @('--test','all.test.mjs'); timeoutMs = 60000 },
        [ordered]@{ id = 'build'; kind = 'build'; tool = 'node'; args = @('demo/build.mjs'); timeoutMs = 30000 }
    )
    serve = [ordered]@{ directory = 'dist'; port = 18764 }
}
if ($Mode -eq 'PlanOnly') {
    [pscustomobject]@{
        mode = 'PlanOnly'; destination = $Destination; source = $SourceRoot
        files = $Records; generatedManifest = $Manifest; writes = $false
        note = 'Read/hash plan only; no deployment, execution, backup or runtime validation performed.'
    } | ConvertTo-Json -Depth 10
    return
}
# No existing installation is updated. Parent creation is confined to this
# additive D:\HomeAI\extensions path; pre-existing ancestors were checked above.
$null = [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
if (Test-Path -LiteralPath $Destination) { throw 'Destination appeared; stopped.' }
$null = [IO.Directory]::CreateDirectory($Destination)
New-Text (Join-Path $Destination 'OWNER.txt') $Owner
$null = [IO.Directory]::CreateDirectory($Backup)
$null = [IO.Directory]::CreateDirectory($Payload)
# Back up reviewed source bytes before creating a usable payload.
foreach ($Record in $Records) {
    Copy-Verified (Join-Path $SourceRoot $Record.name) (Join-Path $Backup $Record.name) $Record.sha256
}
New-Text (Join-Path $Backup 'kit.manifest.json') $ManifestText
$Records += [pscustomobject]@{ name = 'kit.manifest.json'; sha256 = (Hash (Join-Path $Backup 'kit.manifest.json')) }
New-Text (Join-Path $Backup 'simulator.manifest.json') ($SimulatorManifest | ConvertTo-Json -Depth 8)
$Records += [pscustomobject]@{ name = 'simulator.manifest.json'; sha256 = (Hash (Join-Path $Backup 'simulator.manifest.json')) }
foreach ($Record in $Records) {
    Copy-Verified (Join-Path $Backup $Record.name) (Join-Path $Payload $Record.name) $Record.sha256
}
foreach ($Record in @($Records | Where-Object { $_.name -ne 'kit.manifest.json' -and $_.name -ne 'simulator.manifest.json' })) {
    if ((Hash (Join-Path $SourceRoot $Record.name)) -ne $Record.sha256) { throw 'Source changed during staging; incomplete stage must be reviewed.' }
}
$Receipt = [ordered]@{
    version = 1; owner = $Owner; destination = $Destination; source = $SourceRoot
    createdUtc = [DateTime]::UtcNow.ToString('o'); files = $Records
}
$ReceiptText = $Receipt | ConvertTo-Json -Depth 8
New-Text (Join-Path $Backup 'stage-receipt.json') $ReceiptText
New-Text $ReceiptPath $ReceiptText
if ((Hash $ReceiptPath) -ne (Hash (Join-Path $Backup 'stage-receipt.json'))) { throw 'Receipt verification failed.' }
Write-Output 'Additive files staged and hash-verified only. No tests, runtime deployment, services or settings changes performed.'
