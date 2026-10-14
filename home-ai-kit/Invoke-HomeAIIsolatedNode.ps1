#Requires -Version 5.1
[CmdletBinding()]
param([string]$Root='D:\HomeAI',[Parameter(Mandatory=$true)][string]$RunId)
# Gateway child environments can inherit a different PowerShell module path.
# Load only this Windows PowerShell installation's built-in modules.
$env:PSModulePath=Join-Path $PSHOME 'Modules'
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings=Get-HomeAISettings $Root
if($RunId -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid run identifier.'}
$run=Assert-HomeAIChild (Join-Path $settings.root ('state\execution\runs\'+$RunId)) $settings.root
$requestPath=Assert-HomeAIChild (Join-Path $run 'request.json') $settings.root
$request=Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
if($request.owner -ne 'home-ai-execution-request-v1' -or $request.id -ne $RunId -or $request.kind -notin @('syntax','test')){throw 'Unrecognized execution request.'}
$snapshot=Assert-HomeAIChild (Join-Path $run 'input') $settings.root
$entry=[string]$request.entry
if($entry -notmatch '^[-a-zA-Z0-9_./]+\.(js|mjs|cjs)$' -or $entry.Split('/') -contains '..'){throw 'Entry must be a relative JavaScript file.'}
$entryPath=Assert-HomeAIChild (Join-Path $snapshot $entry) $snapshot
if(-not (Test-Path -LiteralPath $entryPath -PathType Leaf)){throw 'Entry is missing.'}
$node=Assert-HomeAIChild (Join-Path $settings.root 'runtime\isolated-node\node.exe') $settings.root
$marker=Get-Content (Join-Path $settings.root 'state\execution-connector.json') -Raw | ConvertFrom-Json
if($marker.owner -ne 'home-ai-execution-v1' -or (Get-FileHash $node -Algorithm SHA256).Hash -ne $marker.nodeSha256){throw 'Isolated Node executable changed.'}
$source=Assert-HomeAIChild (Join-Path $PSScriptRoot 'IsolatedNode.cs') $settings.root
Add-Type -Path $source
$profile='HomeAI.Test.'+$RunId.Replace('-','')
$sid=$null;$grants=@()
try {
    $sid=New-Object Security.Principal.SecurityIdentifier ([HomeAIIsolatedNode]::CreateProfile($profile))
    foreach($item in @((Split-Path $node -Parent),$snapshot)) {
        $acl=Get-Acl -LiteralPath $item
        $rule=New-Object Security.AccessControl.FileSystemAccessRule ($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule);Set-Acl -LiteralPath $item -AclObject $acl
        $grants+=@{path=$item;rule=$rule}
    }
    $temp=Assert-HomeAIChild (Join-Path $run 'temp') $settings.root
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    # Node gets no write permission, including to this temporary directory.
    $arguments=@('--permission',('--allow-fs-read='+$snapshot),('--allow-fs-read='+$node),'--preserve-symlinks','--preserve-symlinks-main','--max-old-space-size=256','--disable-proto=throw')
    if($request.kind -eq 'syntax'){$arguments+=@('--check',$entry)}
    else{$arguments+=@('--test','--test-isolation=none','--test-reporter=tap','--test-timeout=20000',$entry)}
    $seconds=30
    if($request.PSObject.Properties['timeoutSeconds']){$seconds=[int]$request.timeoutSeconds;if($seconds -lt 2 -or $seconds -gt 30){throw 'Invalid execution timeout.'}}
    $code=[HomeAIIsolatedNode]::Run($node,$arguments,$snapshot,$temp,(Join-Path $run 'stdout.txt'),(Join-Path $run 'stderr.txt'),$seconds)
} finally {
    foreach($grant in $grants){$acl=Get-Acl -LiteralPath $grant.path;$acl.RemoveAccessRuleSpecific($grant.rule);Set-Acl -LiteralPath $grant.path -AclObject $acl}
    [HomeAIIsolatedNode]::Cleanup()
}
Write-HomeAIJson (Join-Path $run 'native-result.json') @{owner='home-ai-native-execution-v1';id=$RunId;exitCode=$code;isolation='windows-appcontainer-no-capabilities';nodePermission=$true;finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
if($code -ne 0){exit 1}
