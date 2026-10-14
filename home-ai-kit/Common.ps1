Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-HomeAIPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\')) {
        throw 'Use an absolute path on a local drive, such as D:\HomeAI.'
    }
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($resolved.Length -le 3) { throw 'A drive root cannot be used as the HomeAI folder.' }
    return $resolved
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
    $env:OPENCLAW_STATE_DIR = Join-Path $Settings.root 'state\openclaw'
    $env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
    $env:OPENCLAW_NO_AUTO_UPDATE = '1'
    $env:OPENCLAW_TELEMETRY_ENABLED = '0'
    # Keep the foreground gateway in the recorded process for ownership checks.
    $env:OPENCLAW_NO_RESPAWN = '1'
    $env:NODE_DISABLE_COMPILE_CACHE = '1'
    $env:DO_NOT_TRACK = '1'
    $env:PATH = (Join-Path $Settings.root "runtime\node-v$($Settings.nodeVersion)-win-x64") + ';' +
        (Join-Path $Settings.root 'runtime\git\cmd') + ';' + $env:PATH
    $chatMarker=Join-Path $Settings.root 'state\openclaw-chat-connector.json'
    if(Test-Path -LiteralPath $chatMarker) {
        $chat=Get-Content -LiteralPath $chatMarker -Raw | ConvertFrom-Json
        if($chat.owner -eq 'home-ai-native-chat-v1') {
            $exe=Assert-HomeAIChild $chat.claudeExecutable $Settings.root
            if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $chat.claudeExecutableSha256){throw 'Claude executable changed; reconnect before starting native chat.'}
            $env:CLAUDE_CONFIG_DIR=Join-Path $env:LOCALAPPDATA 'HomeAI-Claude'
            $env:PATH=(Split-Path $exe -Parent)+';'+$env:PATH
            $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';$env:DISABLE_AUTOUPDATER='1'
            foreach($name in @('OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY')) {
                [Environment]::SetEnvironmentVariable($name,$null,'Process')
            }
        }
    }
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

function Get-HomeAIOpenClaw($Settings) {
    return Join-Path $Settings.root 'runtime\openclaw\node_modules\openclaw\openclaw.mjs'
}

function Get-HomeAINode($Settings) {
    return Join-Path $Settings.root "runtime\node-v$($Settings.nodeVersion)-win-x64\node.exe"
}

function New-HomeAIConfig($Settings, [string]$Token) {
    return @{
        gateway=@{mode='local';bind='loopback';port=$Settings.gatewayPort;auth=@{mode='token';token=$Token};
            controlUi=@{automaticallyFetchFavicons=$false};terminal=@{enabled=$false};cliAgents=@{enabled=$false};
            nodes=@{pairing=@{autoApproveLocal=$false;sshVerify=$false};commands=@{deny=@('system.run')}}}
        agents=@{entries=@{main=@{}};defaults=@{workspace=(Join-Path $Settings.root 'workspace');model=@{primary="ollama/$($Settings.mainModel)"};
            maxConcurrent=1;timeoutSeconds=900;heartbeat=@{every='0m'};
            bootstrapMaxChars=2000;bootstrapTotalMaxChars=6000;
            compaction=@{keepRecentTokens=4096;memoryFlush=@{enabled=$false}}}}
        tools=@{profile='minimal';deny=@('gateway');alsoAllow=@('memory_search','memory_get')}
        memory=@{search=@{enabled=$true;provider='none';fallback='none';rememberAcrossConversations=$true}}
        models=@{mode='replace';catalogRefresh=@{enabled=$false};providers=@{ollama=@{
            baseUrl="http://127.0.0.1:$($Settings.ollamaPort)";apiKey='ollama-local';api='ollama';timeoutSeconds=900;
            models=@(@{id=$Settings.mainModel;name='Main Qwen (fixed local weights)';reasoning=$true;
                input=@('text','image');contextWindow=$Settings.context;maxTokens=4096;
                cost=@{input=0;output=0;cacheRead=0;cacheWrite=0}})}}}
        update=@{checkOnStart=$false;auto=@{enabled=$false}}
        telemetry=@{enabled=$false}
        discovery=@{mdns=@{mode='off'}}
        channels=@{}
    }
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
