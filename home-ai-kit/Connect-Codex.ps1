#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[string]$CodexPath,[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'Codex-Common.ps1')
$settings=Get-HomeAISettings $Root
Write-Host 'Connect the installed native Codex runtime through ChatGPT login. No API billing route.'
if($PlanOnly){Write-Host 'PLAN ONLY: no writes, login, inference, downloads or service changes.';return}
if(-not $CodexPath) {
    $command=Get-Command codex.exe -ErrorAction SilentlyContinue
    if($command){$CodexPath=$command.Source}
    else {
        $bin=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        $found=@()
        if(Test-Path -LiteralPath $bin) {
            foreach($directory in Get-ChildItem -LiteralPath $bin -Directory) {
                if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
                $candidate=Join-Path $directory.FullName 'codex.exe'
                if(Test-Path -LiteralPath $candidate -PathType Leaf){$found+=Get-Item -LiteralPath $candidate}
            }
        }
        if($found.Count){$CodexPath=($found | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName}
    }
}
if(-not $CodexPath -or -not (Test-Path -LiteralPath $CodexPath -PathType Leaf) -or
    [IO.Path]::GetExtension($CodexPath) -ne '.exe') {
    throw 'Native Codex executable not found. Re-run with -CodexPath pointing to your official installed codex.exe. Nothing was downloaded.'
}
$exe=[IO.Path]::GetFullPath($CodexPath)
$version=& $exe --version
if($LASTEXITCODE -ne 0 -or ($version -join '') -notmatch '^codex-cli '){throw 'Executable did not identify itself as Codex CLI.'}
$help=& $exe exec --help
foreach($flag in @('--ignore-user-config','--ignore-rules','--strict-config','--ephemeral','--json')) {
    if(($help -join "`n") -notmatch [regex]::Escape($flag)){throw "Installed Codex does not support required flag $flag. Update through the official Codex app first."}
}
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
Set-HomeAICodexEnvironment $settings
$profile=Get-HomeAIPath $env:CODEX_HOME
if(-not (Test-Path -LiteralPath $profile)){New-Item -ItemType Directory -Path $profile -Force | Out-Null}
$marker=Assert-HomeAIChild (Join-Path $profile 'homeai-profile.json') $profile
if(Test-Path -LiteralPath $marker) {
    $owner=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if($owner.owner -ne 'home-ai-codex-v1' -or $owner.root -ne $settings.root){throw 'Private Codex profile belongs to another installation.'}
} elseif(@(Get-ChildItem -LiteralPath $profile -Force).Count) {throw 'Refusing to adopt a non-empty unowned Codex profile.'}
else {Write-HomeAIJson $marker @{owner='home-ai-codex-v1';root=$settings.root}}
Test-HomeAICodexCapabilities $settings $exe
# No copied auth.json, hooks, MCP, plugins, history, or desktop configuration.
$auth=Invoke-HomeAINativeCapture $settings $exe @('-c','forced_login_method="chatgpt"','login','status') -TimeoutSeconds 30
try {Assert-HomeAICodexSubscription $auth} catch {
    Write-Host 'Complete native Codex login with the ChatGPT account you use for Codex. A separate private profile keeps desktop settings intact.'
    & $exe -c 'forced_login_method=chatgpt' login
    if($LASTEXITCODE -ne 0){throw 'Codex login did not complete.'}
    $auth=Invoke-HomeAINativeCapture $settings $exe @('-c','forced_login_method="chatgpt"','login','status') -TimeoutSeconds 30
    Assert-HomeAICodexSubscription $auth
}
Write-HomeAIJson (Join-Path $settings.root 'state\codex-connector.json') @{
    owner='home-ai-codex-v1';executable=$exe;executableSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash;
    version=($version -join '').Trim();mode='subscription-text';apiKeyConfigured=$false
}
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {
    $destination=Assert-HomeAIChild (Join-Path $settings.root ('scripts\'+$file.Name)) $settings.root
    if($file.FullName -ne $destination){Copy-Item -LiteralPath $file.FullName -Destination $destination -Force}
}
& (Join-Path $PSScriptRoot 'Start-HomeAI.ps1') -Root $settings.root -NoBrowser
Write-Host 'Codex connected. No inference was sent by this installer.'
Write-Host 'Use Ask-HomeAI.ps1 -Mode BestAvailable -Provider Codex -Prompt "Your task".'
Write-Host 'Hosted prompts no longer ask SEND, as requested. This text bridge does not register a model in the OpenClaw dashboard.'
