function Set-HomeAIWorkbenchConfig($Config,$Settings,$Roles,[switch]$Disabled) {
    $Config=($Config | ConvertTo-Json -Depth 50) | ConvertFrom-Json
    if(-not $Config.PSObject.Properties['plugins']){throw 'Native chat plugins must be connected first.'}
    if(-not $Config.plugins.PSObject.Properties['entries']){$Config.plugins | Add-Member -NotePropertyName entries -NotePropertyValue ([pscustomobject]@{})}
    # A installed plugin may still validate its config when disabled. Always
    # supply root, including rollback after its package was installed.
    $Config.plugins.entries | Add-Member -NotePropertyName 'homeai-workbench' -NotePropertyValue @{enabled=(-not $Disabled);config=@{root=$Settings.root}} -Force
    if($Disabled) {
        $Config.tools.allow=@($Config.tools.allow | Where-Object {$_ -notin @('homeai_project','homeai_task','homeai_specialist')})
        return $Config
    }
    # The minimal profile filters plugin tools out before the explicit allowlist
    # is evaluated. The finite allowlist remains the permission boundary.
    $Config.tools | Add-Member -NotePropertyName profile -NotePropertyValue 'full' -Force
    $Config.tools | Add-Member -NotePropertyName toolSearch -NotePropertyValue $false -Force
    if($Config.plugins.PSObject.Properties['allow']){$Config.plugins.allow=@($Config.plugins.allow)+@('homeai-workbench') | Select-Object -Unique}
    $Config.tools.allow=@($Config.tools.allow)+@('homeai_project','homeai_task','homeai_specialist') | Select-Object -Unique
    foreach($role in @('quick','vision')) {
        $route=$Roles[$role]
        if($route.status -ne 'installed'){continue}
        # Assign an array directly; an if-expression unwraps a one-item array
        # to a string in Windows PowerShell 5.1.
        $inputTypes=@('text')
        if($role -eq 'vision'){$inputTypes+= 'image'}
        $Config.models.providers.ollama.models=@($Config.models.providers.ollama.models | Where-Object {$_.id -ne $route.model})+@(@{
            id=$route.model;name=('Local '+$role);reasoning=$false;input=$inputTypes;
            contextWindow=8192;maxTokens=2048;cost=@{input=0;output=0;cacheRead=0;cacheWrite=0}
        })
        $Config.agents.defaults.models | Add-Member -NotePropertyName ('ollama/'+$route.model) -NotePropertyValue @{alias=('Local '+$role)} -Force
    }
    return $Config
}
