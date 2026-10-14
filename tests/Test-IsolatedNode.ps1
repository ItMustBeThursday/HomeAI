$ErrorActionPreference='Stop'
$workspace=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root=Join-Path $PSScriptRoot ('artifacts\isolated-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $root 'scripts\execution-plugin') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'runtime\isolated-node') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $root 'state') -Force | Out-Null
foreach($name in @('Common.ps1','Invoke-HomeAIIsolatedNode.ps1','IsolatedNode.cs','probe-homeai-execution.mjs')){Copy-Item -LiteralPath (Join-Path $workspace ('home-ai-kit\'+$name)) -Destination (Join-Path $root ('scripts\'+$name))}
Copy-Item -Path (Join-Path $workspace 'home-ai-kit\execution-plugin\*') -Destination (Join-Path $root 'scripts\execution-plugin')
$node='C:\Users\DefaultUser\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
Copy-Item -LiteralPath $node -Destination (Join-Path $root 'runtime\isolated-node\node.exe')
. (Join-Path $root 'scripts\Common.ps1')
Write-HomeAIJson (Join-Path $root 'homeai.json') @{owner='home-ai-kit-v1';root=$root}
Write-HomeAIJson (Join-Path $root 'state\execution-connector.json') @{owner='home-ai-execution-v1';nodeSha256=(Get-FileHash $node -Algorithm SHA256).Hash;enabled=$false}
& $node (Join-Path $root 'scripts\probe-homeai-execution.mjs') $root
if($LASTEXITCODE -ne 0){throw 'Actual native AppContainer probe failed.'}
Write-Host ('Fixture: '+$root)
