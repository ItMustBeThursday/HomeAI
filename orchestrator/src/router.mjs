// Explicit task-type → connector chain routing. Pure; no I/O.
import { validateAuto } from './autoroute.mjs';

const KINDS = new Set(['claude-cli', 'codex-cli', 'ollama', 'comfyui']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateRoutes(config) {
  if (!isObj(config)) throw new Error('Route config must be an object');
  const { connectors, routes } = config;
  if (!isObj(connectors) || Object.keys(connectors).length === 0) throw new Error('config.connectors must be a non-empty object');
  for (const [name, c] of Object.entries(connectors)) {
    if (!isObj(c)) throw new Error(`Connector "${name}" must be an object`);
    if (!KINDS.has(c.kind)) throw new Error(`Connector "${name}" has unknown kind "${c.kind}"`);
    if (typeof c.model !== 'string' || !c.model) throw new Error(`Connector "${name}" needs a model string`);
    if (c.vision !== undefined && typeof c.vision !== 'boolean') throw new Error(`Connector "${name}" vision must be a boolean`);
    if (c.startTimeoutMs !== undefined && !(c.kind === 'ollama' && Number.isInteger(c.startTimeoutMs) && c.startTimeoutMs >= 1000 && c.startTimeoutMs <= 300000)) throw new Error(`Connector "${name}" startTimeoutMs must be 1000-300000 for Ollama`);
    for (const f of ['category', 'label', 'note']) if (c[f] !== undefined && (typeof c[f] !== 'string' || !c[f].trim())) throw new Error(`Connector "${name}" ${f} must be a non-empty string`);
  }
  if (!isObj(routes) || Object.keys(routes).length === 0) throw new Error('config.routes must be a non-empty object');
  for (const [type, r] of Object.entries(routes)) {
    if (!isObj(r)) throw new Error(`Route "${type}" must be an object`);
    if (!Array.isArray(r.chain) || r.chain.length === 0) throw new Error(`Route "${type}" needs a non-empty chain`);
    for (const name of r.chain) {
      if (!Object.hasOwn(connectors, name)) throw new Error(`Route "${type}" references unknown connector "${name}"`);
    }
    if (r.maxTurns !== undefined && !(Number.isInteger(r.maxTurns) && r.maxTurns >= 1)) throw new Error(`Route "${type}" maxTurns must be a positive integer`);
    if (r.tools !== undefined && !(Array.isArray(r.tools) && r.tools.every((t) => typeof t === 'string' && t))) throw new Error(`Route "${type}" tools must be an array of strings`);
    if (r.agent !== undefined && typeof r.agent !== 'boolean') throw new Error(`Route "${type}" agent must be a boolean`);
    // readOnly: an agent that may only look (planning). then: the route that carries out an approved plan.
    if (r.readOnly !== undefined && typeof r.readOnly !== 'boolean') throw new Error(`Route "${type}" readOnly must be a boolean`);
    if (r.readOnly && !r.agent) throw new Error(`Route "${type}" readOnly only applies to agent routes`);
    if (r.then !== undefined) {
      const next = routes[r.then];
      if (!r.readOnly) throw new Error(`Route "${type}" then only applies to readOnly (planning) routes`);
      if (!isObj(next) || !next.agent || next.readOnly) throw new Error(`Route "${type}" then must name an agent route that can make changes`);
    }
    // memory: true = core notes plus relevant ones; an array limits it to notes with those tags.
    if (r.memory !== undefined && !(typeof r.memory === 'boolean' || (Array.isArray(r.memory) && r.memory.every((t) => typeof t === 'string' && t)))) throw new Error(`Route "${type}" memory must be a boolean or an array of tags`);
  }
  if (typeof config.default !== 'string' || !Object.hasOwn(routes, config.default)) throw new Error(`config.default must name an existing route`);
  validateAuto(config.auto, routes, connectors);
  return config;
}

// Extra fields a ComfyUI connector needs in a chain entry (other kinds need none).
export function comfyFields(c) {
  return c.kind === 'comfyui' ? { workflow: c.workflow, media: c.media, defaults: c.defaults ?? {} } : {};
}

export function resolveChain(config, taskType) {
  const route = Object.hasOwn(config.routes, taskType) ? config.routes[taskType] : config.routes[config.default];
  return route.chain.map((name) => {
    const c = config.connectors[name];
    return {
      connector: name, kind: c.kind, model: c.model, maxTurns: route.maxTurns ?? 1, tools: [...(route.tools ?? [])],
      ...comfyFields(c),
      ...(Number.isInteger(c.ctx) ? { ctx: c.ctx } : {}),
      ...(Number.isInteger(c.startTimeoutMs) ? { startTimeoutMs: c.startTimeoutMs } : {}),
      ...(c.vision ? { vision: true } : {}),
      ...(route.agent ? { agent: true } : {}),
      ...(route.readOnly ? { readOnly: true } : {}),
    };
  });
}

export function nextInChain(chain, failedIndex) {
  if (!Array.isArray(chain)) throw new Error('chain must be an array');
  if (!Number.isInteger(failedIndex) || failedIndex < 0) throw new Error('failedIndex must be a non-negative integer');
  return chain[failedIndex + 1] ?? null;
}
