function Set-HomeAIAdaptiveConfig($Config,$Settings) {
    $Config=Set-HomeAIExecutionConfig $Config $Settings
    $Config.plugins.entries | Add-Member -NotePropertyName 'homeai-autonomy' -NotePropertyValue @{enabled=$true;config=@{root=$Settings.root}} -Force
    if($Config.plugins.PSObject.Properties['allow']){$Config.plugins.allow=@($Config.plugins.allow)+@('homeai-autonomy') | Select-Object -Unique}
    if($Config.tools.PSObject.Properties['allow']){$Config.tools.allow=@($Config.tools.allow)+@('homeai_route','homeai_maintain') | Select-Object -Unique}
    $refs=@('openai/gpt-6-astra','openai/gpt-6.1-sol','anthropic/claude-opus-5-5','anthropic/claude-sonnet-5-5',('ollama/'+$Settings.mainModel),'ollama/homeai-fast:locked','ollama/homeai-vision:locked','ollama/homeai-coder:locked')
    if(-not $Config.agents.defaults.PSObject.Properties['modelPolicy']){$Config.agents.defaults | Add-Member -NotePropertyName modelPolicy -NotePropertyValue ([pscustomobject]@{})}
    $allowed=@();if($Config.agents.defaults.modelPolicy.PSObject.Properties['allow']){$allowed=@($Config.agents.defaults.modelPolicy.allow)}
    $Config.agents.defaults.modelPolicy | Add-Member -NotePropertyName allow -NotePropertyValue (@($allowed)+$refs | Select-Object -Unique) -Force
    foreach($ref in @('openai/gpt-6.1-sol','anthropic/claude-sonnet-5-5')) {
        $runtime='codex';if($ref -like 'anthropic/*'){$runtime='claude-cli'}
        $Config.agents.defaults.models | Add-Member -NotePropertyName $ref -NotePropertyValue @{alias=$ref;agentRuntime=@{id=$runtime}} -Force
    }
    foreach($name in @('homeai-fast:locked','homeai-coder:locked')) {
        $Config.agents.defaults.models | Add-Member -NotePropertyName ('ollama/'+$name) -NotePropertyValue @{alias=('Local candidate '+$name)} -Force
        if(-not @($Config.models.providers.ollama.models | Where-Object {$_.id -eq $name}).Count){$Config.models.providers.ollama.models+=@(@{id=$name;name=('Local candidate '+$name);reasoning=$false;input=@('text');contextWindow=8192;maxTokens=2048;cost=@{input=0;output=0;cacheRead=0;cacheWrite=0}})}
    }
    $variants=@{
        'homeai-worker-codex-sol'='openai/gpt-6.1-sol'
        'homeai-worker-claude-sonnet'='anthropic/claude-sonnet-5-5'
        'homeai-worker-local-fast'='ollama/homeai-fast:locked'
        'homeai-worker-local-coder'='ollama/homeai-coder:locked'
    }
    foreach($id in $variants.Keys){
        $fallbacks=@('ollama/'+$Settings.mainModel)
        $Config.agents.entries | Add-Member -NotePropertyName $id -NotePropertyValue @{workspace=(Join-Path $Settings.root 'workspace');model=@{primary=$variants[$id];fallbacks=$fallbacks};tools=@{allow=@('homeai_project','homeai_check');exec=@{host='gateway';mode='ask'}}} -Force
    }
    return $Config
}
