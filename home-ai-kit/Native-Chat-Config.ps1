function Enable-HomeAINativeChatConfig($Config,$Settings,[string]$Primary='Codex') {
    # Normalize nested PowerShell dictionaries before enumerating JSON fields;
    # repeated calls must not mistake IDictionary's Count/Keys for model ids.
    $Config=($Config | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $operatorFullAccess=($Config.tools.PSObject.Properties['exec'] -and $Config.tools.exec.PSObject.Properties['mode'] -and $Config.tools.exec.mode -eq 'full')
    $originalTools=($Config.tools | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    $originalApp=$null
    if($Config.PSObject.Properties['plugins'] -and $Config.plugins.PSObject.Properties['entries'] -and $Config.plugins.entries.PSObject.Properties['codex'] -and $Config.plugins.entries.codex.PSObject.Properties['config'] -and $Config.plugins.entries.codex.config.PSObject.Properties['appServer']){$originalApp=($Config.plugins.entries.codex.config.appServer | ConvertTo-Json -Depth 50) | ConvertFrom-Json}
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
    if($Config.PSObject.Properties['plugins'] -and $Config.plugins.PSObject.Properties['entries'] -and
        $Config.plugins.entries.PSObject.Properties['homeai-workbench'] -and $Config.plugins.entries.'homeai-workbench'.enabled) {
        $Config.tools.allow+=@('homeai_project','homeai_task','homeai_specialist')
        $Config.tools.profile='full'
        $Config.tools | Add-Member -NotePropertyName toolSearch -NotePropertyValue $false -Force
    }
    if($Config.PSObject.Properties['plugins'] -and $Config.plugins.PSObject.Properties['entries'] -and
        $Config.plugins.entries.PSObject.Properties['homeai-jobs'] -and $Config.plugins.entries.'homeai-jobs'.enabled) {
        $Config.tools.allow+= 'homeai_job'
    }
    if($Config.PSObject.Properties['plugins'] -and $Config.plugins.PSObject.Properties['entries'] -and
        $Config.plugins.entries.PSObject.Properties['homeai-execution'] -and $Config.plugins.entries.'homeai-execution'.enabled) {
        $Config.tools.allow+= 'homeai_check'
    }
    if($Config.PSObject.Properties['plugins'] -and $Config.plugins.PSObject.Properties['entries'] -and
        $Config.plugins.entries.PSObject.Properties['homeai-autonomy'] -and $Config.plugins.entries.'homeai-autonomy'.enabled) {
        $Config.tools.allow+= @('homeai_route','homeai_maintain')
    }
    # deny/allowlist also block Codex app-server runtime admission. Use the
    # human approval route while the finite tool list and read-only sandbox
    # continue to restrict what the native client may do.
    $Config.tools | Add-Member -NotePropertyName exec -NotePropertyValue @{host='gateway';mode='ask'} -Force
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
    # Preserve an explicit operator full-access choice across connector updates.
    if($operatorFullAccess) {
        $Config.tools=$originalTools
        if($originalApp){$Config.plugins.entries.codex.config.appServer=$originalApp}
    }
    return $Config
}
