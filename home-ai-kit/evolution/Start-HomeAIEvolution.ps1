#requires -Version 5.1
<#
STAGED FOR REVIEW. Defaults to run-kit validate (lexical validation only).
No installs, PATH lookup, runtime configuration edits or implicit serving.
#>
[CmdletBinding()]
param(
    [ValidateSet('validate','run','test','build','serve')][string]$Action = 'validate',
    [string]$KitRoot = 'D:\HomeAI\extensions\evolution\payload',
    [string]$Manifest = 'kit.manifest.json',
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [switch]$AllowBuild,
    [switch]$AllowServe,
    [hashtable]$ToolPaths = @{}
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Checked-Path([string]$Path, [bool]$Directory) {
    if ($Path -notmatch '^[DEde]:\\' -or $Path -match '[\x00-\x1f"*?<>|]' -or
        $Path.Substring(2).Contains(':') -or $Path -match '(^|\\)\.\.?($|\\)' -or
        $Path -match '(^|\\)[^\\]*[. ]($|\\)') { throw 'Require an absolute plain D/E path.' }
    $Full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $Item = Get-Item -LiteralPath $Full -Force
    if ($Item.PSIsContainer -ne $Directory) { throw 'Wrong path type.' }
    $Cursor = $Full
    while ($Cursor.Length -gt 3) {
        $Part = Get-Item -LiteralPath $Cursor -Force
        if ($Part.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
        $Cursor = Split-Path -Parent $Cursor
    }
    return $Full
}
function Hash([string]$Path) {
    $null = Checked-Path $Path $false
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Quote-Argument([string]$Value) {
    # Windows native argv quoting. Embedded quotes/control characters are not needed.
    if ($Value -match '["\x00-\x1f]') { throw 'Invalid native argument.' }
    return '"' + ($Value -replace '(\\+)$', '$1$1') + '"'
}
$KitRoot = Checked-Path $KitRoot $true
if ($KitRoot -ine 'D:\HomeAI\extensions\evolution\payload' -and
    $KitRoot -notmatch '^D:\\HomeAI\\state\\evolution-fixtures\\[A-Za-z0-9_-]+\\payload$') { throw 'Unexpected kit root.' }
$NodeExe = Checked-Path $NodeExe $false
if ([IO.Path]::GetExtension($NodeExe) -ine '.exe') { throw 'A verified native Node .exe is required, not a wrapper.' }
# Conservative PE metadata gate; actual installed Node identity/version still needs host review.
$NodeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($NodeExe)
if ($NodeVersion.ProductMajorPart -lt 24) { throw 'Node >=24 product metadata required; verify the actual binary separately.' }
if ($Manifest -notmatch '^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$' -or $Manifest -match '\.\.') {
    throw 'Manifest must be a simple project-relative JSON filename.'
}
$null = Checked-Path (Join-Path $KitRoot $Manifest) $false
$Parent = Split-Path -Parent $KitRoot
$ReceiptPath = Join-Path $Parent 'stage-receipt.json'
$null = Hash $ReceiptPath
$Receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
if ($Receipt.owner -cne 'homeai-evolution-stage-v1' -or $Receipt.version -ne 1 -or
    $Receipt.destination -ine $Parent) { throw 'Invalid stage ownership receipt.' }
if ((Hash $ReceiptPath) -ne (Hash (Join-Path $Parent 'backup\stage-receipt.json'))) { throw 'Backup receipt mismatch.' }
$Required = @(
    'README.md','CURRENT-RUNBOOK.md','STATUS.md',
    'MISSION.md','SPEC.md','CONTRACTS.md','CAPABILITY-MATRIX.md',
    'execution-policy.mjs','model-policy.mjs','switch-core.mjs','voice-core.mjs',
    'runtime-runner.mjs','run-kit.mjs',
    'all.test.mjs','switch.test.mjs','policy.test.mjs','voice.test.mjs','runner.test.mjs','regression.test.mjs',
    'demo/index.html','demo/app.mjs','demo/build.mjs',
    'Prepare-HomeAIEvolution.ps1','Start-HomeAIEvolution.ps1',
    'OPERATIONS.md','ACCESS-PLAN.md','DEVICE-VOICE-ROADMAP.md','GROWTH-BACKLOG.md','kit.manifest.json','simulator.manifest.json'
)
$Records = @($Receipt.files)
if ($Records.Count -ne $Required.Count) { throw 'Invalid file inventory.' }
foreach ($Name in $Required) {
    $Rows = @($Records | Where-Object { $_.name -ceq $Name })
    if ($Rows.Count -ne 1 -or $Rows[0].sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid manifest digest.' }
    if ((Hash (Join-Path $KitRoot $Name)) -ne $Rows[0].sha256 -or
        (Hash (Join-Path $Parent ('backup\' + $Name))) -ne $Rows[0].sha256) { throw "Staged or backup bytes changed: $Name" }
}
$Arguments = @((Join-Path $KitRoot 'run-kit.mjs'), $Action, $Manifest)
if ($AllowBuild) { $Arguments += '--allow-build' }
if ($AllowServe) { $Arguments += '--allow-serve' }
foreach ($Tool in @($ToolPaths.Keys | Sort-Object)) {
    if (@('npm','dotnet','cargo','cmake') -cnotcontains $Tool) { throw 'Unsupported tool override; use NodeExe for node.' }
    $Executable = Checked-Path ([string]$ToolPaths[$Tool]) $false
    if ([IO.Path]::GetExtension($Executable) -ine '.exe') { throw 'Tool must be native .exe, not .cmd/.bat.' }
    $Arguments += ('--tool=' + $Tool + '=' + $Executable)
}
if ($Action -eq 'serve' -and -not $AllowServe) { throw 'serve requires explicit AllowServe plus a serve manifest.' }
# run-kit enforces manifest build/serve approval, command types and loopback binding.
# This launcher is NOT an OS sandbox. Reviewed project code can have side effects.
$Info = New-Object Diagnostics.ProcessStartInfo
$Info.FileName = $NodeExe
$Info.WorkingDirectory = $KitRoot
$Info.UseShellExecute = $false
$Info.Arguments = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
$Info.EnvironmentVariables.Clear()
foreach ($Key in @('SystemRoot','WINDIR')) {
    $Value = [Environment]::GetEnvironmentVariable($Key)
    if ($Value) { $Info.EnvironmentVariables[$Key] = $Value }
}
# No credentials, NODE_OPTIONS, PATH or package-manager environment inherited.
# Console streams are inherited, avoiding redirected pipe deadlock. Serve stays foreground.
$Process = New-Object Diagnostics.Process
$Process.StartInfo = $Info
try {
    if (-not $Process.Start()) { throw 'Node did not start.' }
    $Process.WaitForExit()
    if ($Process.ExitCode -ne 0) { throw "run-kit exited with code $($Process.ExitCode)." }
} finally { $Process.Dispose() }
