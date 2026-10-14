function Set-HomeAIClaudeEnvironment($Settings) {
    Set-HomeAIEnvironment $Settings
    # Use a separate native Claude profile in the current user's private app data.
    $env:CLAUDE_CONFIG_DIR=Join-Path $env:LOCALAPPDATA 'HomeAI-Claude'
    $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'
    $env:DISABLE_AUTOUPDATER='1'
    $env:CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS='1'
    foreach($name in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL',
        'ANTHROPIC_PROFILE','ANTHROPIC_GATEWAY_URL','ANTHROPIC_FOUNDRY_BASE_URL',
        'CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY')) {
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
}

function Get-HomeAIClaudeExecutable($Settings) {
    $marker=Join-Path $Settings.root 'state\claude-connector.json'
    if(-not (Test-Path -LiteralPath $marker)){throw 'Run Connect-Claude.ps1 first.'}
    $connector=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if($connector.owner -ne 'home-ai-claude-v1' -or $connector.version -ne '2.1.299') {
        throw 'Claude connector ownership/version mismatch.'
    }
    $file=Assert-HomeAIChild $connector.executable $Settings.root
    if(-not (Test-Path -LiteralPath $file)){throw 'The pinned Claude executable is missing.'}
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $connector.executableSha256) {
        throw 'Claude executable changed. Reconnect deliberately; no automatic version substitution.'
    }
    return $file
}

function Assert-HomeAIClaudeSubscription($Auth) {
    if(-not $Auth.loggedIn -or $Auth.authMethod -ne 'claude.ai') {
        throw 'This connector requires a native claude.ai subscription login. API keys and other providers are refused.'
    }
    if($Auth.PSObject.Properties.Name -contains 'subscriptionType') {
        if($Auth.subscriptionType -and $Auth.subscriptionType -ne 'pro') {
            throw 'This connector is configured for the agreed Pro trial; review the account plan before continuing.'
        }
    }
}

function Get-HomeAIClaudeArguments($Settings) {
    # All model execution tools are removed; strict empty MCP prevents third-party tools.
    return @('-p','--output-format','json','--model','sonnet','--tools=',
        '--disallowedTools','*','--safe-mode','--restricted','--strict-mcp-config','--mcp-config',
        (Join-Path $Settings.root 'state\claude-empty-mcp.json'),'--no-session-persistence',
        '--no-chrome','--permission-prompts','none','--max-turns','1')
}

function Test-HomeAIClaudeLimitError([string]$Text) {
    return $Text -match '(?i)(rate.?limit|usage.?limit|hit your limit|quota|over.?limit)'
}
