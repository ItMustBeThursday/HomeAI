$ErrorActionPreference='Stop'
$kit=Join-Path $PSScriptRoot '..\home-ai-kit'
. (Join-Path $kit 'Common.ps1')
. (Join-Path $kit 'Hosted-Workers.ps1')
$root=Join-Path $PSScriptRoot ('artifacts\routing-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
$settings=@{root=$root}
$script:calls=New-Object 'Collections.Generic.List[string]'
function Invoke-HomeAIHostedText($Settings,$Provider,$Prompt) {
    $script:calls.Add($Provider)
    if($Provider -eq 'Codex'){return [pscustomobject]@{success=$false;limited=$true;answer=''}}
    return [pscustomobject]@{success=$true;limited=$false;answer='Claude fallback answer'}
}
$result=Invoke-HomeAIHostedRouting $settings 'Codex' 'test prompt'
if($result.provider -ne 'Claude' -or ($script:calls -join ',') -ne 'Codex,Claude'){throw 'Usage limit did not switch from Codex to Claude.'}
if(-not (Test-Path (Join-Path $root 'state\codex-cooldown.json'))){throw 'Usage limit did not persist cooldown.'}
$script:calls.Clear()
$result=Invoke-HomeAIHostedRouting $settings 'Codex' 'test prompt'
if(($script:calls -join ',') -ne 'Claude'){throw 'Cooldown did not skip Codex.'}
function Invoke-HomeAIHostedText($Settings,$Provider,$Prompt) {throw 'Mock unavailable'}
$result=Invoke-HomeAIHostedRouting $settings 'Codex' 'test prompt'
if($result.success -or $result.provider -ne 'Qwen'){throw 'Unavailable hosted workers did not choose local fallback.'}
Assert-HomeAICodexSubscription ([pscustomobject]@{code=0;stdout='';stderr='Logged in using ChatGPT'})
$refused=$false
try {Assert-HomeAICodexSubscription ([pscustomobject]@{code=0;stdout='Logged in using an API key';stderr=''})} catch {$refused=$true}
if(-not $refused){throw 'API-key login was accepted.'}
$args=Get-HomeAICodexArguments
foreach($required in @('read-only','--ignore-user-config','--ignore-rules','--strict-config','features.shell_tool=false','tools.view_image=false','features.apps=false','features.hooks=false','web_search="disabled"','project_doc_max_bytes=0')) {
    if($args -notcontains $required){throw "Missing runtime restriction $required"}
}
if(($args -join ' ') -match 'dangerously|danger-full-access'){throw 'Unexpected bypass.'}
Write-Output 'PASS: observed limit switches worker, cooldown persists and skips limited worker, both unavailable choose Qwen, ChatGPT auth accepted/API auth refused, restricted native arguments.'
