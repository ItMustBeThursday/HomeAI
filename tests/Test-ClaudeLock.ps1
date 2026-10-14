param([string]$Node=(Get-Command node.exe -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
$kit=Join-Path $PSScriptRoot '..\home-ai-kit'
$fixture=Join-Path $PSScriptRoot 'artifacts\claude-lock-regression.json'
$integrity='sha512-3m+7cON+VYa7IqQv5qCURyty0WwwpoKhqIgO8/3fnuTQ8KNoJkHe7BTSsK0T7Rq7K/xxlG2oYgVuS1Zr10UJ/A=='
$resolved='https://registry.npmjs.org/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.299.tgz'
$lock=@{packages=@{''=@{name='fixture'};'node_modules/@anthropic-ai/claude-code-win32-x64'=@{integrity=$integrity;resolved=$resolved}}}
New-Item -ItemType Directory -Path (Split-Path $fixture) -Force | Out-Null
$lock | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $fixture -Encoding UTF8
$text=& $Node (Join-Path $kit 'read-claude-lock.mjs') $fixture
if($LASTEXITCODE -ne 0){throw 'Lockfile helper failed.'}
$entry=$text | ConvertFrom-Json
if($entry.integrity -cne $integrity -or $entry.resolved -cne $resolved){throw 'Integrity or source changed in extraction.'}
Write-Output 'PASS: npm empty property survives Node parsing and PowerShell 5.1 receives the exact integrity/source.'
[IO.File]::WriteAllText($fixture,'{"packages":{"":{}}}')
$stderr=Join-Path $PSScriptRoot 'artifacts\claude-lock-regression-error.txt'
try {
    $ErrorActionPreference='Continue'
    $result=& $Node (Join-Path $kit 'read-claude-lock.mjs') $fixture 2>$stderr
    $code=$LASTEXITCODE
} finally { $ErrorActionPreference='Stop' }
if($code -eq 0 -or $result){throw 'Missing package entry was not refused.'}
Write-Output 'PASS: missing integrity entry exits with failure instead of bypassing verification.'
