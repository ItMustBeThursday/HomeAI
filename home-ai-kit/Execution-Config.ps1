function Set-HomeAIExecutionConfig($Config,$Settings) {
    $Config=Set-HomeAIFleetConfig $Config $Settings
    $Config.plugins.entries | Add-Member -NotePropertyName 'homeai-execution' -NotePropertyValue @{enabled=$true;config=@{root=$Settings.root}} -Force
    if($Config.plugins.PSObject.Properties['allow']){$Config.plugins.allow=@($Config.plugins.allow)+@('homeai-execution') | Select-Object -Unique}
    $Config.tools.allow=@($Config.tools.allow)+@('homeai_check') | Select-Object -Unique
    foreach($lane in @('codex','claude','local')){$Config.agents.entries.('homeai-worker-'+$lane).tools.allow=@('homeai_project','homeai_check')}
    return $Config
}
