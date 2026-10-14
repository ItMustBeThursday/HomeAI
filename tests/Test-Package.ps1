$ErrorActionPreference='Stop'
$kit = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\home-ai-kit'))
. (Join-Path $kit 'Common.ps1')
$script:checks=0
function Assert($Condition,[string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:checks++
    Write-Output "PASS: $Message"
}
function Assert-Throws([scriptblock]$Action,[string]$Message) {
    $caught=$false
    try { & $Action | Out-Null } catch { $caught=$true }
    Assert $caught $Message
}
foreach($scriptFile in Get-ChildItem -LiteralPath $kit -Filter '*.ps1') {
    $tokens=$null;$errors=$null
    [Management.Automation.Language.Parser]::ParseFile($scriptFile.FullName,[ref]$tokens,[ref]$errors) | Out-Null
    Assert ($errors.Count -eq 0) "PowerShell parses $($scriptFile.Name)"
}
Assert-Throws { Get-HomeAIPath 'D:\' } 'Drive-root installation refused'
Assert-Throws { Get-HomeAIPath '.\relative' } 'Relative installation refused'
Assert-Throws { Get-HomeAIPath '\\server\share\HomeAI' } 'Network installation refused'
Assert-Throws { Assert-HomeAIChild 'D:\elsewhere\file' 'D:\HomeAI' } 'Out-of-scope mutation refused'
Assert-Throws { Assert-HomeAIChild 'D:\HomeAI\..\escape.txt' 'D:\HomeAI' } 'Traversal refused'
$previewRoot=Join-Path $PSScriptRoot ('preview-'+[guid]::NewGuid().ToString('N'))
& (Join-Path $kit 'Setup-HomeAI.ps1') -Root $previewRoot -BackupRoot ($previewRoot+'-backups') -PlanOnly | Out-Null
Assert (-not (Test-Path -LiteralPath $previewRoot)) 'PlanOnly makes no installation directory'

$testRoot=Join-Path $PSScriptRoot 'artifacts\mock-homeai'
$testBackup=Join-Path $PSScriptRoot 'artifacts\mock-backups'
New-Item -ItemType Directory -Path $testRoot,$testBackup -Force | Out-Null
foreach($part in @('state','workspace','projects','output','scripts','evaluations')) {
    New-Item -ItemType Directory -Path (Join-Path $testRoot $part) -Force | Out-Null
}
$settings=@{owner='home-ai-kit-v1';root=$testRoot;backupRoot=$testBackup;ollamaPort=11435;gatewayPort=18795;
    mainModel='homeai-main:locked';fastModel='homeai-fast:locked';nodeVersion='24.21.0';context=16384;openclawInstalled=$true;
    openclawVersion='2026.10.3';ollamaVersion='0.40.4'}
Write-HomeAIJson (Join-Path $testRoot 'homeai.json') $settings
$config=New-HomeAIConfig $settings 'test-token-only'
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\config-to-validate.json') $config
Assert ($config.tools.profile -eq 'minimal' -and $config.tools.deny -contains 'gateway') 'No agent-triggered self-update'
Assert (-not $config.tools.ContainsKey('allow')) 'No conflicting allow/alsoAllow policies'
Assert ($config.memory.search.provider -eq 'none') 'No paid embedding default'
Assert ($config.models.providers.ollama.baseUrl -notmatch '/v1') 'Native Ollama API selected'
Assert ($config.models.mode -eq 'replace' -and -not $config.models.catalogRefresh.enabled) 'Cloud catalog refresh disabled'
Assert (-not $config.update.checkOnStart -and -not $config.telemetry.enabled) 'Update/telemetry requests disabled'

$global:HomeAIHarness=@{lastBody=$null;toolCalls=0}
function Invoke-RestMethod {
    param($Uri,$Method,$ContentType,$Body,$TimeoutSec)
    if($Uri -match '/api/tags$'){ return @{models=@(@{name='homeai-main:locked'},@{name='homeai-fast:locked'})} }
    if($Uri -match '/api/ps$'){ return @{models=@(@{name='homeai-main:locked';size_vram=17000000000})} }
    $global:HomeAIHarness.lastBody=[Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json
    if($global:HomeAIHarness.lastBody.PSObject.Properties.Name -contains 'tools') {
        $global:HomeAIHarness.toolCalls++
        if($global:HomeAIHarness.lastBody.messages.Count -eq 1) {
            return [pscustomobject]@{message=[pscustomobject]@{role='assistant';content='';tool_calls=@(@{function=@{name='get_room_state';arguments=@{room='bedroom'}}})}}
        }
    }
    return [pscustomobject]@{message=[pscustomobject]@{role='assistant';content='mock local answer'};eval_count=10;eval_duration=1000000000}
}
& (Join-Path $kit 'Invoke-HomeAI.ps1') -Root $testRoot -Task quick -Prompt 'Hello' | Out-Null
Assert ($global:HomeAIHarness.lastBody.model -eq 'homeai-fast:locked') 'Optional quick worker selected'
& (Join-Path $kit 'Invoke-HomeAI.ps1') -Root $testRoot -Task auto -Prompt 'Debug the function' | Out-Null
Assert ($global:HomeAIHarness.lastBody.model -eq 'homeai-main:locked') 'Coding request uses main model'
Assert (-not ($global:HomeAIHarness.lastBody.PSObject.Properties.Name -contains 'tools')) 'Direct helper has no executable tools'
Assert-Throws { & (Join-Path $kit 'Invoke-HomeAI.ps1') -Root $testRoot -Task image -Prompt 'A landscape' } 'Uninstalled image service fails explicitly'
& (Join-Path $kit 'Benchmark-HomeAI.ps1') -Root $testRoot | Out-Null
Assert ($global:HomeAIHarness.toolCalls -eq 2) 'Mock tool calling completes a genuine two-step round trip'
$benchmark=Get-Content -LiteralPath (Get-ChildItem (Join-Path $testRoot 'evaluations') -Filter 'benchmark-*.json' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Raw | ConvertFrom-Json
Assert ($benchmark.results.Count -eq 6 -and $benchmark.results[-1].validStructuredCall) 'Benchmark records all tasks and structured-call validity'
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction); return @() }
[IO.File]::WriteAllText((Join-Path $testRoot 'projects\important.txt'),'original project data')
$snapshot=& (Join-Path $kit 'Backup-HomeAI.ps1') -Root $testRoot
$manifest=Get-Content -LiteralPath (Join-Path $snapshot 'backup-manifest.json') -Raw | ConvertFrom-Json
Assert ($manifest.files.Count -gt 0) 'Backup produces a manifest'
$entry=@($manifest.files | Where-Object {$_.path -eq 'projects\important.txt'})[0]
Assert ((Get-FileHash -LiteralPath (Join-Path $snapshot $entry.path)).Hash -eq $entry.sha256) 'Project backup hash verifies'
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction); return @(@{OwningProcess=1}) }
Assert-Throws { & (Join-Path $kit 'Backup-HomeAI.ps1') -Root $testRoot } 'Live gateway blocks inconsistent SQLite backup'
Assert-Throws { Test-HomeAIListenerOwned $settings 'ollama' 11435 'C:\unrelated.exe' } 'Unmanaged listener refuses reuse'
. (Join-Path $kit 'Stage-Report.ps1')
$probe=@{passed=$true;checks=@(@{name='esbuild';passed=$true},@{name='koffi';passed=$true})}
$stageReport=New-HomeAIStageReport $settings $benchmark $probe $true @{os='Windows 11';ramGiB=64}
Assert ($stageReport.status -eq 'checks-run-quality-review-needed') 'Stage report does not falsely certify model quality'
Assert ($stageReport.notImplemented -contains 'voice modes') 'Unimplemented later stages are explicit'
Assert ($stageReport.runtimeVersions.openclaw -eq '2026.10.3') 'Report contains installed runtime versions'
$reportFile=Join-Path $testRoot 'evaluations\mock-stage-report.html'
Write-HomeAIStageHtml $reportFile $stageReport $benchmark
Assert ((Get-Content -LiteralPath $reportFile -Raw) -match 'mock local answer') 'Readable report contains benchmark answers'
Assert (-not ((Get-Content -LiteralPath $reportFile -Raw) -match 'test-token-only')) 'Report excludes gateway token'
$stageState=Join-Path $testRoot 'state\stage-2-progress.json'
& (Join-Path $kit 'Continue-HomeAI.ps1') -Root $testRoot -PlanOnly | Out-Null
Assert (-not (Test-Path -LiteralPath $stageState)) 'Continuation preview writes no progress state'
Assert-Throws { & (Join-Path $kit 'Continue-HomeAI.ps1') -Root $testRoot } 'Continuation refuses incomplete foundation before service changes'
. (Join-Path $kit 'Claude-Common.ps1')
Assert-HomeAIClaudeSubscription ([pscustomobject]@{loggedIn=$true;authMethod='claude.ai';subscriptionType='pro'})
Assert $true 'Native Pro subscription login accepted'
Assert-Throws {Assert-HomeAIClaudeSubscription ([pscustomobject]@{loggedIn=$true;authMethod='api_key';subscriptionType='pro'})} 'API-key route refused'
Assert-Throws {Assert-HomeAIClaudeSubscription ([pscustomobject]@{loggedIn=$false;authMethod='none'})} 'Logged-out Claude route refused'
$claudeArgs=Get-HomeAIClaudeArguments $settings
Assert ($claudeArgs -contains '--tools=' -and $claudeArgs -contains '--disallowedTools' -and $claudeArgs -contains '*') 'Native Claude request removes all executable tools'
Assert ($claudeArgs -contains '--strict-mcp-config' -and $claudeArgs -contains '--safe-mode') 'Native Claude request blocks automatic MCP/context customizations'
Assert ($claudeArgs -notcontains '--dangerously-skip-permissions') 'No bypass-permissions flag'
Assert (Test-HomeAIClaudeLimitError 'You have hit your limit') 'Observed quota error recognized'
Assert (-not (Test-HomeAIClaudeLimitError 'Native binary is missing')) 'Non-quota launch failure is distinguished'
$claudeMarker=Join-Path $testRoot 'state\claude-connector.json'
& (Join-Path $kit 'Connect-Claude.ps1') -Root $testRoot -PlanOnly | Out-Null
Assert (-not (Test-Path -LiteralPath $claudeMarker)) 'Claude connection preview does not install or log in'
Write-Output "Completed $script:checks checks. No model was downloaded or loaded."
