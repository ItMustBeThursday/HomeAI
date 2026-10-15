# Logon autostart for the orchestrator (registered as scheduled task HomeAI-Orchestrator-Autostart).
# A scheduled task does not inherit the interactive PATH, so pin node and claude explicitly.
$env:Path = 'D:\HomeAI\runtime\node-v24.21.0-win-x64;' + $env:Path
$env:HOMEAI_CLAUDE_BIN = 'D:\HomeAI\runtime\claude\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe'
& (Join-Path $PSScriptRoot 'start.ps1')
