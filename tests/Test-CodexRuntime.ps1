param([string]$Node=(Get-Command node.exe -ErrorAction Stop).Source,[string]$Codex=(Get-Command codex.exe -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
$kit=Join-Path $PSScriptRoot '..\home-ai-kit'
. (Join-Path $kit 'Common.ps1')
. (Join-Path $kit 'Codex-Common.ps1')
function Get-HomeAINode($Settings){return $Node}
$testHome=Join-Path $PSScriptRoot ('artifacts\codex-runtime-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testHome | Out-Null
$env:CODEX_HOME=$testHome
$exe=$Codex
$unicodePrompt='caf'+[char]0x00e9+' '+[char]0x03bb+' literal $(no-execution)'
$echo=Invoke-HomeAINativeCapture @{} $Node @('-e','process.stdin.pipe(process.stdout)') $unicodePrompt
if($echo.stdout -cne $unicodePrompt){throw 'PowerShell native transport corrupted Unicode or literal prompt characters.'}
Test-HomeAICodexCapabilities @{} $exe
$execArgs=Get-HomeAICodexArguments
$flags=@()
for($i=0;$i -lt $execArgs.Count;$i++){if($execArgs[$i] -eq '-c'){$flags+=@('-c',$execArgs[++$i])}}
$flags+=@('features','list')
$result=Invoke-HomeAINativeCapture @{} $exe $flags -TimeoutSeconds 30
if($result.code -ne 0){throw "Actual Codex rejected feature configuration: $($result.stderr)"}
foreach($feature in @('shell_tool','apps','hooks','multi_agent','goals','remote_plugin')) {
    if($result.stdout -notmatch ($feature+'\s+\S+\s+false')){throw "Feature did not disable: $feature"}
}
Write-Output 'PASS: actual installed Codex confirms disabled execution, apps, hooks, delegation, goals, and remote plugins. No login or inference.'
