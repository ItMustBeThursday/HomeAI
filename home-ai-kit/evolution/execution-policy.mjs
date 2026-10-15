// Pure validation and planning, not an OS sandbox. No processes or servers.
const TOOLS=new Set(['node','npm','dotnet','cargo','cmake']);
const KINDS=new Set(['test','build','compile']);
const identifier=s=>typeof s==='string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s);
const dangerous=/[\u0000-\u001f\u007f;&|<>\x60$]/;
const reserved=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const segment=s=>s && s!=='.' && s!=='..' && !/[. ]$/.test(s) && !reserved.test(s);
function localAbsolute(value) {
  if (typeof value!=='string' || !value || value.length>4096 || dangerous.test(value) ||
      /["?*]/.test(value) || /^[\\/]{2}/.test(value)) return false;
  const windows=/^[A-Za-z]:[\\/]/.test(value);
  if (!windows && !value.startsWith('/')) return false;
  const normalized=value.replace(/\\/g,'/');
  const rest=windows ? normalized.slice(3) : normalized.slice(1);
  return !rest || rest.replace(/\/$/,'').split('/').every(s=>segment(s) && !s.includes(':'));
}
function canonicalRoot(value) {
  const root=value.replace(/\\/g,'/').replace(/\/+$/,'') || '/';
  return /^[A-Za-z]:/.test(root) ? root.toLowerCase() : root;
}
function relativePath(value) {
  return typeof value==='string' && value.length>0 && value.length<=4096 &&
    !dangerous.test(value) && !/^[\\/]/.test(value) && !/[:"?*]/.test(value) &&
    value.replace(/\\/g,'/').split('/').every(segment);
}
function validateArgs(step) {
  if (!Array.isArray(step.args) || !step.args.length || step.args.length>64 ||
      !step.args.every(arg=>typeof arg==='string' && arg.trim().length>0 && arg.length<=4096 && !dangerous.test(arg)) ||
      step.args.reduce((n,arg)=>n+arg.length,0)>32768) throw new TypeError('Invalid arguments');
  for (const arg of step.args) {
    for (const value of arg.split('=')) {
      const parts=value.replace(/\\/g,'/').split('/');
      if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || /\\\\/.test(value) ||
          parts.some(s=>s==='..' || reserved.test(s))) throw new TypeError('Unbounded/device argument path');
    }
  }
  if (step.tool==='node' && step.kind==='test' &&
      (step.args[0]!=='--test' || step.args.length<2 ||
       !step.args.slice(1).every(arg=>relativePath(arg) && !arg.startsWith('-') && arg.endsWith('.test.mjs'))))
    throw new TypeError('Node test requires --test and safe relative .test.mjs targets');
}
export function validateManifest(manifest) {
  if (!manifest || typeof manifest!=='object' || Array.isArray(manifest) || manifest.version!==1 ||
      !identifier(manifest.id) || !localAbsolute(manifest.projectRoot) ||
      !Array.isArray(manifest.steps) || !manifest.steps.length || manifest.steps.length>128)
    throw new TypeError('Invalid manifest');
  const seen=new Set();
  const steps=manifest.steps.map(step=>{
    if (!step || !identifier(step.id) || seen.has(step.id) || !KINDS.has(step.kind) || !TOOLS.has(step.tool) ||
        !Number.isSafeInteger(step.timeoutMs) || step.timeoutMs<=0 || step.timeoutMs>300000)
      throw new TypeError('Invalid step');
    seen.add(step.id); validateArgs(step);
    return {id:step.id,kind:step.kind,tool:step.tool,args:[...step.args],timeoutMs:step.timeoutMs};
  });
  const result={version:1,id:manifest.id,projectRoot:manifest.projectRoot,steps};
  if (manifest.serve!==undefined) {
    const s=manifest.serve;
    if (!s || !relativePath(s.directory) || !Number.isSafeInteger(s.port) || s.port<1 || s.port>65535 ||
        !steps.some(step=>step.kind!=='test')) throw new TypeError('Invalid serve declaration');
    result.serve={directory:s.directory,port:s.port};
  }
  return result;
}
export function createRunPlan(manifest,context) {
  const m=validateManifest(manifest);
  if (!context || !localAbsolute(context.projectRoot) || canonicalRoot(context.projectRoot)!==canonicalRoot(m.projectRoot) ||
      typeof context.allowBuild!=='boolean' || typeof context.allowServe!=='boolean' ||
      !context.toolPaths || typeof context.toolPaths!=='object' || Array.isArray(context.toolPaths))
    throw new TypeError('Invalid execution context');
  const toolPaths={};
  const commands=m.steps.map(step=>{
    if ((step.kind!=='test' || step.tool!=='node') && !context.allowBuild) throw new TypeError('Build approval required');
    const executable=context.toolPaths[step.tool];
    if (!Object.hasOwn(context.toolPaths,step.tool) || !localAbsolute(executable)) throw new TypeError('Missing absolute executable');
    toolPaths[step.tool]=executable;
    return {...step,args:[...step.args],executable,shell:false,cwd:m.projectRoot};
  });
  if (m.serve && !context.allowServe) throw new TypeError('Serve approval required');
  return {version:1,id:m.id,projectRoot:m.projectRoot,commands,
    serve:m.serve ? {...m.serve,host:'127.0.0.1',requiresSuccessfulBuild:true,requiresHealthCheck:true} : null,
    manifest:m,context:{projectRoot:context.projectRoot,toolPaths,allowBuild:context.allowBuild,allowServe:context.allowServe}};
}
const statuses=new Set(['queued','running','passed','failed','cancelled','timed-out']);
export function nextState(state,event) {
  if (!state || typeof state!=='object' || Array.isArray(state) || !statuses.has(state.status) ||
      !event || typeof event!=='object' || Array.isArray(event) || typeof event.type!=='string')
    throw new TypeError('Invalid run state/event');
  for (const key of ['successfulBuild','artifactsReady','serveReady']) {
    if (state[key]!==undefined && typeof state[key]!=='boolean') throw new TypeError('Invalid evidence flags');
  }
  if ((state.artifactsReady || state.serveReady) && (state.status!=='passed' || !state.successfulBuild))
    throw new TypeError('Readiness without successful build');
  const base={...state,successfulBuild:state.successfulBuild===true,artifactsReady:state.artifactsReady===true,serveReady:state.serveReady===true};
  const invalid=()=>{throw new TypeError('Invalid run transition');};
  switch (event.type) {
    case 'start':
      if (base.status!=='queued') return invalid();
      return {...base,status:'running',successfulBuild:false,artifactsReady:false,serveReady:false};
    case 'buildSucceeded':
      if (base.status!=='running' || !['build','compile'].includes(event.kind)) return invalid();
      return {...base,successfulBuild:true,artifactsReady:false,serveReady:false};
    case 'pass':
      if (base.status!=='running') return invalid();
      return {...base,status:'passed',artifactsReady:false,serveReady:false};
    case 'fail':
    case 'timeout':
      if (base.status!=='running') return invalid();
      return {...base,status:event.type==='fail' ? 'failed' : 'timed-out',artifactsReady:false,serveReady:false};
    case 'cancel':
      if (!['queued','running'].includes(base.status)) return invalid();
      return {...base,status:'cancelled',artifactsReady:false,serveReady:false};
    case 'healthChecked':
      if (base.status!=='passed' || !base.successfulBuild || typeof event.ok!=='boolean') return invalid();
      return {...base,artifactsReady:event.ok,serveReady:event.ok};
    default: return invalid();
  }
}
