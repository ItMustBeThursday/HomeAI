. (Join-Path $PSScriptRoot 'Claude-Common.ps1')
. (Join-Path $PSScriptRoot 'Codex-Common.ps1')

function Invoke-HomeAIHostedText($Settings,[string]$Provider,[string]$Prompt) {
    if($Provider -eq 'Codex') {
        Set-HomeAICodexEnvironment $Settings
        $exe=Get-HomeAICodexExecutable $Settings
        $auth=Invoke-HomeAINativeCapture $Settings $exe @('-c','forced_login_method="chatgpt"','login','status') -TimeoutSeconds 30
        Assert-HomeAICodexSubscription $auth
        return Invoke-HomeAINativeCapture $Settings $exe (Get-HomeAICodexArguments) $Prompt -ParseCodex
    }
    Set-HomeAIClaudeEnvironment $Settings
    $exe=Get-HomeAIClaudeExecutable $Settings
    $connector=Get-Content -LiteralPath (Join-Path $Settings.root 'state\claude-connector.json') -Raw | ConvertFrom-Json
    if(-not ($connector.PSObject.Properties.Name -contains 'paidExtraUsageDisabledByUser') -or
        -not $connector.paidExtraUsageDisabledByUser) {throw 'Claude paid extra usage has not been confirmed disabled.'}
    $requestDir=Assert-HomeAIChild (Join-Path $Settings.root 'workspace\claude-requests') $Settings.root
    New-Item -ItemType Directory -Path $requestDir -Force | Out-Null
    $auth=Invoke-HomeAINativeCapture $Settings $exe @('auth','status') -TimeoutSeconds 30 -WorkingDirectory $requestDir
    if($auth.code -ne 0){throw 'Claude is not logged in.'}
    Assert-HomeAIClaudeSubscription ($auth.stdout | ConvertFrom-Json)
    $raw=Invoke-HomeAINativeCapture $Settings $exe (Get-HomeAIClaudeArguments $Settings) $Prompt -WorkingDirectory $requestDir
    try {$reply=$raw.stdout | ConvertFrom-Json} catch {$reply=$null}
    $success=$raw.code -eq 0 -and -not $raw.timedOut -and -not $raw.oversized -and $null -ne $reply
    if($reply -and $reply.PSObject.Properties.Name -contains 'is_error'){$success=$success -and -not $reply.is_error}
    $answer=''
    if($reply -and $reply.PSObject.Properties.Name -contains 'result'){$answer=[string]$reply.result}
    $success=$success -and -not [string]::IsNullOrWhiteSpace($answer)
    return [pscustomobject]@{success=$success;answer=$answer;
        limited=(-not $success -and (Test-HomeAIClaudeLimitError ($raw.stdout+$raw.stderr)))}
}

function Invoke-HomeAIHostedRouting($Settings,[string]$Preferred,[string]$Prompt) {
    $other=if($Preferred -eq 'Codex'){'Claude'}else{'Codex'}
    foreach($provider in @($Preferred,$other)) {
        $cooldown=Assert-HomeAIChild (Join-Path $Settings.root ('state\'+$provider.ToLowerInvariant()+'-cooldown.json')) $Settings.root
        if(Test-Path -LiteralPath $cooldown) {
            $last=Get-Content -LiteralPath $cooldown -Raw | ConvertFrom-Json
            if([DateTimeOffset]::Parse($last.until) -gt [DateTimeOffset]::UtcNow) {
                Write-Host "$provider is in a retry cooldown after reporting a limit. Trying the next worker."
                continue
            }
        }
        try {
            Write-Host "Trying $provider through subscription login. Only the supplied prompt is passed to the worker."
            $result=Invoke-HomeAIHostedText $Settings $provider $Prompt
        } catch {
            Write-Host "$provider connector is unavailable. Trying the next worker."
            continue
        }
        if($result.success) {return [pscustomobject]@{success=$true;provider=$provider;answer=$result.answer}}
        if($result.limited) {
            Write-HomeAIJson $cooldown @{until=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o');reason='observed-usage-limit'}
            Write-Host "$provider reported a usage limit. Switching workers; the cooldown is not a quota reset prediction."
        } else {Write-Host "$provider did not complete the text request. Trying the next worker."}
    }
    return [pscustomobject]@{success=$false;provider='Qwen';answer=''}
}
