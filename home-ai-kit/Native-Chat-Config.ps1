function Enable-HomeAINativeChatConfig($Config,$Settings,[string]$Primary='Codex') {
    # Normalize nested PowerShell dictionaries before enumerating JSON fields;
    # repeated calls must not mistake IDictionary's Count/Keys for model ids.
    $Config=($Config | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $codex='openai/gpt-6-astra'
    $claude='anthropic/claude-opus-5-5'
    $qwen="ollama/$($Settings.mainModel)"
    $models=@{}
    if($Config.agents.defaults.PSObject.Properties['models']) {
        foreach($property in $Config.agents.defaults.models.PSObject.Properties) {
            if($property.Name -notlike 'homeai-subscription/*'){$models[$property.Name]=$property.Value}
        }
    }
    $models[$codex]=@{alias='Codex subscription';agentRuntime=@{id='codex'}}
    $models[$claude]=@{alias='Claude Code subscription';agentRuntime=@{id='claude-cli'}}
    $models['anthropic/*']=@{agentRuntime=@{id='claude-cli'}}
    $models[$qwen]=@{alias='Local Qwen'}
    $Config.agents.defaults | Add-Member -NotePropertyName models -NotePropertyValue $models -Force
    $order=@(switch($Primary){'Claude'{@($claude,$codex,$qwen)}'Qwen'{@($qwen)}default{@($codex,$claude,$qwen)}})
    $Config.agents.defaults | Add-Member -NotePropertyName model -NotePropertyValue @{primary=$order[0];fallbacks=@($order | Select-Object -Skip 1)} -Force
    $Config.agents.defaults.timeoutSeconds=900
    $Config.agents.defaults | Add-Member -NotePropertyName utilityModel -NotePropertyValue $qwen -Force
    # An explicit finite list triggers the harness's exact native-tool restrictions.
    # Profile narrowing alone is insufficient for the native Codex harness.
    $Config.tools.PSObject.Properties.Remove('alsoAllow')
    $Config.tools | Add-Member -NotePropertyName allow -NotePropertyValue @('memory_search','memory_get','sessions_history') -Force
    $Config.tools | Add-Member -NotePropertyName exec -NotePropertyValue @{host='gateway';mode='deny'} -Force
    if(-not $Config.PSObject.Properties['plugins']){$Config | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{})}
    $entries=@{}
    if($Config.plugins.PSObject.Properties['entries']){foreach($p in $Config.plugins.entries.PSObject.Properties){$entries[$p.Name]=$p.Value}}
    $entries['codex']=@{enabled=$true;config=@{
        appServer=@{transport='stdio';homeScope='agent';approvalPolicy='on-request';approvalsReviewer='user';sandbox='read-only';
            enableUltrafast=$false;cyberFailover=@{mode='off'};clearEnv=@('OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL')};
        computerUse=@{enabled=$false;autoInstall=$false};codexPlugins=@{enabled=$false};
        sessionCatalog=@{enabled=$false};supervision=@{enabled=$false}
    }}
    $entries['anthropic']=@{enabled=$true}
    $entries['openai']=@{enabled=$true}
    if($entries.ContainsKey('homeai-subscription')){$entries['homeai-subscription']=@{enabled=$false}}
    $Config.plugins | Add-Member -NotePropertyName entries -NotePropertyValue $entries -Force
    if($Config.plugins.PSObject.Properties['allow']) {
        $Config.plugins.allow=@($Config.plugins.allow)+@('codex','anthropic','openai') | Select-Object -Unique
    }
    return $Config
}
