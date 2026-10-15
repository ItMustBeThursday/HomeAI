#Requires -Version 5.1
<#
Installs or upgrades the HomeAI evolution kit (switch/voice/model policy, Node runner, switch-lab preview)
from this clone's home-ai-kit\evolution folder into D:\HomeAI\extensions\evolution.

Additive only: no OpenClaw config, plugin, service, access or credential changes.
- Fresh install: stage, hash-verify, then run the kit's offline tests.
- Already current (receipt hashes match this clone): only reruns the tests.
- Upgrade: the existing install is MOVED (not deleted) to D:\HomeAI\state\evolution-backups\installed-<stamp>,
  the new version is staged and tested, and on any failure the previous install is moved back.
#>
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly,[switch]$Serve)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
if($settings.root -ine 'D:\HomeAI'){throw 'The evolution stager and launcher only support D:\HomeAI.'}
$node=Get-HomeAINode $settings
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw "HomeAI Node runtime missing: $node"}
$source=Join-Path $PSScriptRoot 'evolution'
$destination='D:\HomeAI\extensions\evolution'
$backupRoot='D:\HomeAI\state\evolution-backups'
$port=18764
$owner='homeai-evolution-stage-v1'
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'

function Invoke-EvolutionScript([string]$Script,[string[]]$Arguments) {
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $source $Script) @Arguments
    if($LASTEXITCODE -ne 0){throw "$Script failed with exit code $LASTEXITCODE"}
}
function Get-Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# Decide fresh / current / upgrade from the existing ownership receipt.
$state='fresh';$changed=@()
if(Test-Path -LiteralPath $destination){
    $receiptPath=Join-Path $destination 'stage-receipt.json'
    if(-not (Test-Path -LiteralPath $receiptPath)){throw "$destination exists without a stage receipt; refusing to touch an unrecognized folder."}
    $receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if($receipt.owner -cne $owner){throw 'Existing evolution folder has an unexpected owner; refusing.'}
    foreach($record in @($receipt.files | Where-Object {$_.name -notlike '*.manifest.json'})){
        $path=Join-Path $source $record.name
        if(-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Sha $path) -ne $record.sha256){$changed+=$record.name}
    }
    $state=if($changed.Count -eq 0){'current'}else{'upgrade'}
}
Write-Host "Evolution kit: $state ($source -> $destination)"
if($changed.Count){Write-Host ('Changed files: '+($changed -join ', '))}
if($PlanOnly){
    if($state -eq 'fresh'){Invoke-EvolutionScript 'Prepare-HomeAIEvolution.ps1' @('-Mode','PlanOnly','-SourceRoot',$source,'-Destination',$destination)}
    if($state -eq 'upgrade'){Write-Host "PLAN: move existing install to $backupRoot\installed-$stamp, stage, test; restore on failure."}
    Write-Host 'PLAN ONLY: no changes made.';return
}

$listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if($state -eq 'upgrade' -and $listener){
    throw "The switch-lab preview is running (PID $($listener.OwningProcess)) and locks the install. Stop it first: Stop-Process -Id $($listener.OwningProcess)"
}

$aside=$null
if($state -eq 'upgrade'){
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $aside=Join-Path $backupRoot "installed-$stamp"
    Move-Item -LiteralPath $destination -Destination $aside
    Write-Host "Previous install moved to $aside"
}
try {
    if($state -ne 'current'){Invoke-EvolutionScript 'Prepare-HomeAIEvolution.ps1' @('-Mode','Stage','-SourceRoot',$source,'-Destination',$destination)}
    $launcherArgs=@('-Action','test','-NodeExe',$node)
    $testOutput=& $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destination 'payload\Start-HomeAIEvolution.ps1') @launcherArgs 2>&1
    if($LASTEXITCODE -ne 0){$testOutput | ForEach-Object {Write-Host $_};throw "Evolution kit tests failed with exit code $LASTEXITCODE"}
    $counts=[regex]::Matches(($testOutput | Out-String),'(?:\\n|^)\S+ (tests|pass|fail) (\d+)') | ForEach-Object {$_.Groups[1].Value+' '+$_.Groups[2].Value}
    Write-Host ('Kit tests: '+(($counts | Select-Object -Last 3) -join ', '))
} catch {
    if($state -ne 'current'){
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        if(Test-Path -LiteralPath $destination){
            Move-Item -LiteralPath $destination -Destination (Join-Path $backupRoot "failed-$stamp")
            Write-Host "Failed attempt kept at $backupRoot\failed-$stamp for review."
        }
        if($aside){Move-Item -LiteralPath $aside -Destination $destination;Write-Host 'Previous install restored.'}
    }
    throw
}
Write-Host "Evolution kit installed and tests passed ($destination)."

if($Serve){
    if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){Write-Host "Preview already running: http://127.0.0.1:$port/";return}
    $logs=Join-Path $settings.root 'logs';New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $serveArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $destination 'payload\Start-HomeAIEvolution.ps1'),
        '-Action','serve','-Manifest','simulator.manifest.json','-AllowBuild','-AllowServe','-NodeExe',$node)
    $process=Start-Process -FilePath $powershell -ArgumentList $serveArgs -WorkingDirectory (Join-Path $destination 'payload') -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logs "evolution-preview-$stamp.log") -RedirectStandardError (Join-Path $logs "evolution-preview-$stamp.err.log") -PassThru
    for($i=0;$i -lt 60;$i++){
        if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){Write-Host "Preview running: http://127.0.0.1:$port/ (launcher PID $($process.Id); use 127.0.0.1, not localhost)";return}
        if($process.HasExited){break}
        Start-Sleep -Milliseconds 500
    }
    throw "Preview did not start; see $logs\evolution-preview-$stamp.err.log"
}
