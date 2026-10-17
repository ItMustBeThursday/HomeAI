Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-HomeAIPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\')) {
        throw 'Use an absolute path on a local drive, such as D:\HomeAI.'
    }
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($resolved.Length -le 3) { throw 'A drive root cannot be used as the HomeAI folder.' }
    if (Test-HomeAIOneDrivePath $resolved) { throw 'HomeAI never uses OneDrive folders. Choose a local folder outside OneDrive.' }
    return $resolved
}

function Test-HomeAIOneDrivePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    foreach ($name in @('OneDrive','OneDriveCommercial','OneDriveConsumer')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) {
            $base = [IO.Path]::GetFullPath($value).TrimEnd('\')
            if ($full -eq $base -or $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
    }
    # The folder-name check also covers business libraries whose variables are unset.
    return @($full.Split('\') | Where-Object { $_ -match '^OneDrive($| - )' }).Count -gt 0
}

function Get-HomeAIBackupItems {
    # Top-level HomeAI items captured by Backup-HomeAI.ps1 and restored by Restore-HomeAI.ps1.
    return @('homeai.json','state','workspace','projects','output','scripts','evaluations')
}

function Assert-HomeAIChild([string]$Path, [string]$Root) {
    $base = (Get-HomeAIPath $Root) + '\'
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the intended HomeAI directory: $full"
    }
    # Refuse reparse points so a junction cannot redirect a write outside the root.
    $cursor = $full
    while ($cursor -and $cursor.Length -ge $base.TrimEnd('\').Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "HomeAI paths must not contain junctions or symlinks: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Write-HomeAIJson([string]$Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 30
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-HomeAISettings([string]$Root) {
    $script:HomeAIRoot = Get-HomeAIPath $Root
    $marker = Join-Path $script:HomeAIRoot 'homeai.json'
    if (-not (Test-Path -LiteralPath $marker)) { throw "Run Setup-HomeAI.ps1 first: $marker missing." }
    $settings = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($settings.root -ne $script:HomeAIRoot -or $settings.owner -ne 'home-ai-kit-v1') {
        throw 'HomeAI directory ownership or location does not match. Do not move an installed folder.'
    }
    return $settings
}

function Set-HomeAIEnvironment($Settings) {
    # These are process-scoped. No persistent changes to the user's environment or PATH.
    $env:OLLAMA_HOST = "127.0.0.1:$($Settings.ollamaPort)"
    $env:OLLAMA_MODELS = Join-Path $Settings.root 'models\ollama'
    $env:OLLAMA_NO_CLOUD = '1'
    $env:OLLAMA_MAX_LOADED_MODELS = '1'
    $env:OLLAMA_NUM_PARALLEL = '1'
    $env:OLLAMA_CONTEXT_LENGTH = [string]$Settings.context
    $env:OLLAMA_FLASH_ATTENTION = '1'
    $env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
    $env:OLLAMA_KEEP_ALIVE = '5m'
    $env:NODE_DISABLE_COMPILE_CACHE = '1'
    $env:DO_NOT_TRACK = '1'
    $env:PATH = (Join-Path $Settings.root "runtime\node-v$($Settings.nodeVersion)-win-x64") + ';' +
        (Join-Path $Settings.root 'runtime\git\cmd') + ';' + $env:PATH
}

function Invoke-HomeAINative([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Exe" }
}

function Get-HomeAIOllama($Settings, [string]$Route) {
    $response=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Settings.ollamaPort)$Route" -TimeoutSec 15
    ConvertFrom-HomeAIUtf8Response $response
}

function Send-HomeAIOllama($Settings, [string]$Route, $Body, [int]$Timeout = 900) {
    $response=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Settings.ollamaPort)$Route" -Method Post `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30))) `
        -TimeoutSec $Timeout
    ConvertFrom-HomeAIUtf8Response $response
}

function ConvertFrom-HomeAIUtf8Response($Response) {
    # JSON is UTF-8 even when the server omits a charset. PowerShell 5.1's
    # default HTTP string decoder can otherwise corrupt accented text.
    $stream=$Response.RawContentStream
    if($stream.CanSeek){$stream.Position=0}
    $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,4096,$true)
    try {return ($reader.ReadToEnd() | ConvertFrom-Json)} finally {$reader.Dispose()}
}

function Get-HomeAINode($Settings) {
    return Join-Path $Settings.root "runtime\node-v$($Settings.nodeVersion)-win-x64\node.exe"
}

function Test-HomeAIListenerOwned($Settings, [string]$Service, [int]$Port, [string]$Exe) {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) { return $false }
    $pidFile = Join-Path $Settings.root "state\$Service.pid.json"
    if (-not (Test-Path -LiteralPath $pidFile)) { throw "Port $Port is in use by an unmanaged process; nothing was stopped." }
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if (-not $process -or $process.Path -ne $Exe -or
        $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks -or
        @($connections | Where-Object { $_.OwningProcess -ne $process.Id }).Count -gt 0) {
        throw "Port $Port ownership does not match this kit. Nothing was stopped."
    }
    return $true
}

function Save-HomeAIProcess($Settings, [string]$Service, $Process) {
    Write-HomeAIJson (Join-Path $Settings.root "state\$Service.pid.json") @{
        pid = $Process.Id
        startTicks = $Process.StartTime.ToUniversalTime().Ticks.ToString()
        executable = $Process.Path
    }
}
