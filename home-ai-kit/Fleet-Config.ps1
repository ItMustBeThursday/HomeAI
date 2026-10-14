function Set-HomeAIFleetConfig($Config,$Settings) {
    $Config=($Config | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $Config.agents | Add-Member -NotePropertyName ownership -NotePropertyValue 'explicit' -Force
    $Config.agents.defaults | Add-Member -NotePropertyName systemAgent -NotePropertyValue @{agentId='main'} -Force
    $Config.agents.defaults | Add-Member -NotePropertyName modelSelectionScope -NotePropertyValue 'session' -Force
    $Config.agents.defaults.maxConcurrent=4
    $local="ollama/$($Settings.mainModel)"
    $routes=@{codex='openai/gpt-6-astra';claude='anthropic/claude-opus-5-5';local=$local}
    $workerTools=@('homeai_project')
    if($Config.plugins.entries.PSObject.Properties['homeai-execution'] -and $Config.plugins.entries.'homeai-execution'.enabled){$workerTools+= 'homeai_check'}
    foreach($lane in @('codex','claude','local')) {
        $fallbacks=@();if($lane -ne 'local'){$fallbacks+= $local}
        $Config.agents.entries | Add-Member -NotePropertyName ('homeai-worker-'+$lane) -NotePropertyValue @{
            workspace=(Join-Path $Settings.root 'workspace')
            model=@{primary=$routes[$lane];fallbacks=$fallbacks}
            tools=@{allow=$workerTools;exec=@{host='gateway';mode='ask'}}
        } -Force
    }
    $Config.tools.profile='full'
    $Config.tools | Add-Member -NotePropertyName toolSearch -NotePropertyValue $false -Force
    $Config.tools.allow=@($Config.tools.allow)+@('homeai_job') | Select-Object -Unique
    return $Config
}
