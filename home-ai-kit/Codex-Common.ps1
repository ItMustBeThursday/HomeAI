function Set-HomeAICodexEnvironment($Settings) {
    Set-HomeAIEnvironment $Settings
    $env:CODEX_HOME=Join-Path $env:LOCALAPPDATA 'HomeAI-Codex'
    foreach($name in @('OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CODEX_ACCESS_TOKEN',
        'CODEX_ACCESS_TOKEN_FILE','CODEX_IDENTITY_TOKEN','CODEX_IDENTITY_TOKEN_FILE','CODEX_PROFILE',
        'OPENAI_ORG_ID','OPENAI_PROJECT_ID')) {
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
    }
}

function Invoke-HomeAINativeCapture($Settings,[string]$Executable,[string[]]$Arguments,[string]$InputText='',
    [int]$TimeoutSeconds=900,[switch]$ParseCodex,[string]$WorkingDirectory=$env:CODEX_HOME) {
    $request=@{executable=$Executable;args=@($Arguments);cwd=$WorkingDirectory;input=$InputText;
        timeoutSeconds=$TimeoutSeconds;parseCodex=[bool]$ParseCodex} | ConvertTo-Json -Depth 8 -Compress
    # ASCII transport avoids PowerShell 5.1 code-page conversion in either direction.
    $request=[regex]::Replace($request,'[^\x00-\x7F]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
    $node=Get-HomeAINode $Settings
    $previousEncoding=$OutputEncoding
    $OutputEncoding=New-Object Text.UTF8Encoding($false)
    try { $raw=$request | & $node (Join-Path $PSScriptRoot 'run-native.mjs');$exit=$LASTEXITCODE }
    finally {$OutputEncoding=$previousEncoding}
    if($exit -ne 0){throw 'Native worker transport failed.'}
    return ($raw | ConvertFrom-Json)
}

function Assert-HomeAICodexSubscription($Status) {
    if($Status.code -ne 0 -or ($Status.stdout+$Status.stderr) -notmatch '(?i)Logged in using ChatGPT') {
        throw 'HomeAI Codex requires a ChatGPT login. API-key authentication is refused.'
    }
}

function Get-HomeAICodexArguments {
    return @('exec','--ignore-user-config','--ignore-rules','--strict-config','--ephemeral',
        '--skip-git-repo-check','--sandbox','read-only','--json','--color','never',
        '-c','forced_login_method="chatgpt"','-c','model_provider="openai"',
        '-c','approval_policy="never"','-c','project_doc_max_bytes=0',
        '-c','web_search="disabled"','-c','tools.view_image=false',
        '-c','features.shell_tool=false','-c','features.shell_snapshot=false',
        '-c','features.apps=false','-c','features.hooks=false','-c','features.multi_agent=false',
        '-c','features.goals=false','-c','features.memories=false','-c','features.remote_plugin=false',
        '-c','features.browser_use=false','-c','features.computer_use=false','-c','features.image_generation=false',
        '-c','features.plugins=false','-c','features.skill_search=false','-c','features.tool_suggest=false',
        '-c','features.skill_mcp_dependency_install=false','-c','features.workspace_dependencies=false',
        '-c','features.code_mode_host=false','-c','features.daemon_auto_start=false',
        '-c','features.code_mode.enabled=false','-c','analytics.enabled=false',
        '-c','mcp_servers={}','-c','plugins={}','-')
}

function Test-HomeAICodexCapabilities($Settings,[string]$Executable) {
    $execArgs=Get-HomeAICodexArguments
    $flags=@()
    for($i=0;$i -lt $execArgs.Count;$i++) {
        if($execArgs[$i] -eq '-c'){$flags+=@('-c',$execArgs[++$i])}
    }
    $flags+=@('features','list')
    $result=Invoke-HomeAINativeCapture $Settings $Executable $flags -TimeoutSeconds 30
    if($result.code -ne 0){throw 'Codex runtime rejected the restricted feature configuration.'}
    foreach($feature in @('shell_tool','apps','hooks','multi_agent','goals','remote_plugin','browser_use',
        'computer_use','image_generation','plugins','skill_search','tool_suggest','workspace_dependencies','code_mode_host')) {
        if($result.stdout -notmatch ($feature+'\s+\S+\s+false')) {
            throw "Codex cannot confirm disabled capability: $feature. No inference was sent."
        }
    }
}

function Get-HomeAICodexExecutable($Settings) {
    $marker=Join-Path $Settings.root 'state\codex-connector.json'
    if(-not (Test-Path -LiteralPath $marker)){throw 'Run Connect-Codex.ps1 first.'}
    $connector=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if($connector.owner -ne 'home-ai-codex-v1'){throw 'Codex connector ownership mismatch.'}
    $file=[IO.Path]::GetFullPath($connector.executable)
    if(-not (Test-Path -LiteralPath $file -PathType Leaf) -or [IO.Path]::GetExtension($file) -ne '.exe') {
        throw 'The registered native Codex executable is missing.'
    }
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $connector.executableSha256) {
        throw 'Codex was updated. Re-run Connect-Codex.ps1 to validate and register it again.'
    }
    $profileMarker=Join-Path $env:CODEX_HOME 'homeai-profile.json'
    $profile=Get-Content -LiteralPath $profileMarker -Raw | ConvertFrom-Json
    if($profile.owner -ne 'home-ai-codex-v1' -or $profile.root -ne $Settings.root){throw 'Private Codex profile ownership mismatch.'}
    return $file
}
