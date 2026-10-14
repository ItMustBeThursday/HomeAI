#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Root='D:\HomeAI',
    [Parameter(Mandatory=$true)][string]$Prompt,
    [ValidateSet('auto','general','quick','code','document','vision','image')][string]$Task='auto',
    [string]$ImagePath,
    [switch]$Think
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$settings = Get-HomeAISettings $Root
Set-HomeAIEnvironment $settings
if ($Task -eq 'image') { throw 'Image generation belongs to stage 4; no image backend is installed by this foundation.' }
if ($Task -eq 'auto') {
    $Task = if ($ImagePath) {'vision'} elseif ($Prompt -match '(?i)\b(code|debug|function|repository|refactor|compile)\b') {'code'}
        elseif ($Prompt -match '(?i)\b(document|proposal|report|letter|presentation)\b') {'document'} else {'general'}
}
$model = $settings.mainModel
if ($Task -eq 'quick') {
    if ((Get-HomeAIOllama $settings '/api/tags').models.name -contains $settings.fastModel) { $model=$settings.fastModel }
}
$message = @{role='user';content=$Prompt}
if ($ImagePath) {
    $info = Get-Item -LiteralPath $ImagePath
    if ($info.Length -gt 20MB) { throw 'Use an image below 20 MB.' }
    $message.images = @([Convert]::ToBase64String([IO.File]::ReadAllBytes($info.FullName)))
}
Write-Host "Task: $Task; model: $model. This direct helper returns text; OpenClaw owns persistent chat."
# Serialize direct helper calls across processes; the runtime also limits loaded models and parallel inference.
$lock = New-Object Threading.Mutex($false, 'Local\HomeAI-Inference')
try {
    if (-not $lock.WaitOne(900000)) { throw 'Timed out waiting for the local inference queue.' }
    try {
        $reply = Send-HomeAIOllama $settings '/api/chat' @{model=$model;stream=$false;think=[bool]$Think;
            messages=@($message);options=@{num_ctx=$settings.context;num_predict=4096};keep_alive='5m'}
        $reply.message.content
    } finally { $lock.ReleaseMutex() }
} finally { $lock.Dispose() }
