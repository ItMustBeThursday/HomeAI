$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Test-WorkbenchConfig.ps1')
. (Join-Path $kit 'Fleet-Config.ps1')
$fleet=Set-HomeAIFleetConfig $config $settings
$json=($fleet | ConvertTo-Json -Depth 50) | ConvertFrom-Json
if($json.agents.defaults.maxConcurrent -ne 4 -or $json.agents.defaults.modelSelectionScope -ne 'session'){throw 'Coordinator capacity or selection scope differs.'}
foreach($lane in @('codex','claude','local')) {
    $worker=$json.agents.entries.('homeai-worker-'+$lane)
    if(($worker.tools.allow -join ',') -ne 'homeai_project'){throw 'Worker received extra tool authority.'}
    if($worker.model.fallbacks -is [string]){throw 'Fallback array collapsed.'}
}
Write-HomeAIJson (Join-Path $PSScriptRoot 'artifacts\fleet-config.json') $fleet
Write-Output 'PASS: PS5.1 fleet configuration, explicit worker models and separate chat selection scope.'
