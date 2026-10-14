#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[switch]$PlanOnly)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
$packageRoot=Join-Path $settings.root 'runtime\openclaw'
$reviewed=@{
    'esbuild'='0.28.2'
    'koffi'='3.3.1'
    'openclaw'='2026.10.3'
}
foreach($name in $reviewed.Keys) {
    $file=Assert-HomeAIChild (Join-Path $packageRoot "node_modules\$name\package.json") $settings.root
    $package=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if($package.version -ne $reviewed[$name]) { throw "Unexpected version of $name; refusing automatic repair." }
}
Write-Host 'Dependency repair is limited to pinned esbuild, koffi and OpenClaw installation scripts.'
if($PlanOnly) { Write-Host 'PLAN ONLY: no approval or rebuild performed.'; return }
Set-HomeAIEnvironment $settings
$env:npm_config_update_notifier='false'
& (Join-Path $PSScriptRoot 'Stop-HomeAI.ps1') -Root $settings.root
& (Join-Path $PSScriptRoot 'Backup-HomeAI.ps1') -Root $settings.root | Out-Null
$npm=Join-Path $settings.root "runtime\node-v$($settings.nodeVersion)-win-x64\npm.cmd"
Push-Location $packageRoot
try {
    Invoke-HomeAINative $npm @('install-scripts','approve','esbuild','koffi','openclaw')
    # No dependency update or blanket approval. Prebuilt binaries are normally present.
    Invoke-HomeAINative $npm @('rebuild','esbuild','koffi','openclaw','--offline','--no-audit','--no-fund')
} finally { Pop-Location }
Write-Host 'Known dependency scripts rebuilt. The continuation will probe the bindings again.'
