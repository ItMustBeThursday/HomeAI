// Pure, narrowly scoped recovery changes. Never reads or rewrites credentials.
export function recoveryPlan(source, {primary='Codex', mainModel='homeai-main:locked', fastInstalled=false}={}) {
  if(!['Codex','Claude','Local'].includes(primary))throw Error('Unsupported recovery primary.');
  const config=structuredClone(source), changes=[];
  const defaults=config.agents?.defaults;
  if(!defaults||!config.agents?.entries?.main)throw Error('Expected an existing HomeAI main agent.');
  const local='ollama/'+(fastInstalled?'homeai-fast:locked':mainModel);
  const ref=primary==='Claude'?'anthropic/claude-opus-5-5':primary==='Local'?local:'openai/gpt-6-astra';
  const runtime=primary==='Claude'?'claude-cli':primary==='Local'?'openclaw':'codex';
  const owner=primary==='Codex'?'codex':primary==='Claude'?'anthropic':null;
  if(owner&&!config.plugins?.entries?.[owner])throw Error('The existing '+owner+' connector is missing; reconnect that native client first.');
  if(owner){config.plugins.entries[owner].enabled=true;if(Array.isArray(config.plugins.allow))config.plugins.allow=[...new Set([...config.plugins.allow,owner])];}
  if(primary==='Codex'&&config.plugins.entries.anthropic){config.plugins.entries.anthropic.enabled=false;changes.push('Temporarily disable the Anthropic plugin during Codex recovery; retain installation and login.');}
  const runtimeFor=model=>model.startsWith('anthropic/')?'claude-cli':/^(openai|codex)\//.test(model)?'codex':model.startsWith('ollama/')?'openclaw':null;
  // Per-agent model maps outrank defaults; repair both without discarding aliases,
  // parameters, tools, workspaces, permissions, user instructions or app files.
  for(const scope of [defaults,...Object.values(config.agents.entries)]){
    for(const [model,value] of Object.entries(scope.models||{})){
      const id=runtimeFor(model);if(id&&value&&typeof value==='object')value.agentRuntime={id};
    }
  }
  defaults.models??={};
  for(const model of ['openai/gpt-6-astra','openai/gpt-6.1-sol','anthropic/claude-opus-5-5','anthropic/claude-sonnet-5-5',local]){
    defaults.models[model]={...defaults.models[model],agentRuntime:{id:runtimeFor(model)}};
  }
  defaults.modelPolicy??={};
  defaults.modelPolicy.allow=[...new Set([...(defaults.modelPolicy.allow||[]),ref])];
  defaults.model={primary:ref,fallbacks:[]};
  config.agents.entries.main.model={primary:ref,fallbacks:[]};
  // Main can also have its own exact model row. Ensure it cannot shadow the fix.
  if(config.agents.entries.main.models?.[ref])config.agents.entries.main.models[ref].agentRuntime={id:runtime};
  defaults.maxConcurrent=1;
  defaults.heartbeat={...defaults.heartbeat,every:'0m'};
  defaults.bootstrapMaxChars=Math.min(defaults.bootstrapMaxChars||2000,2000);
  defaults.bootstrapTotalMaxChars=Math.min(defaults.bootstrapTotalMaxChars||6000,6000);
  defaults.startupContext={...defaults.startupContext,enabled:false};
  defaults.compaction={...defaults.compaction,memoryFlush:{...defaults.compaction?.memoryFlush,enabled:false}};
  // An explicit utility/compaction override can drag a tiny model into a huge
  // native chat even after /new. Let the selected runtime own maintenance.
  delete defaults.utilityModel;
  delete defaults.compaction.model;
  if(config.agents.entries.main.compaction){delete config.agents.entries.main.compaction.model;if(config.agents.entries.main.compaction.memoryFlush)config.agents.entries.main.compaction.memoryFlush.enabled=false;}
  for(const id of ['homeai-jobs','homeai-autonomy'])if(config.plugins?.entries?.[id])config.plugins.entries[id].enabled=false;
  config.cron={...config.cron,enabled:false};
  changes.push('Correct provider/runtime mappings in default and per-agent model maps.','Select '+ref+' through '+runtime+' with no cross-provider fallbacks.','Pause HomeAI background jobs, automatic chat routing, model staging, cron and heartbeat.','Bound bootstrap context; disable startup prelude and implicit local utility/compaction overrides.');
  if(primary==='Local'){
    // New-chat system/tool instructions also count toward a local context window.
    config.tools??={};delete config.tools.alsoAllow;
    config.tools.allow=['homeai_project','homeai_task'];
    config.agents.entries.main.tools={...config.agents.entries.main.tools,allow:['homeai_project','homeai_task']};
    delete config.agents.entries.main.tools.alsoAllow;
    changes.push('Temporarily narrow main-chat tool schemas for the local recovery context.');
  }
  return {config,ref,runtime,changes,paused:true};
}
