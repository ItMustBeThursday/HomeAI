// Explicit task-type → connector chain routing. Pure; no I/O.

const KINDS = new Set(['claude-cli', 'codex-cli', 'ollama']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateRoutes(config) {
  if (!isObj(config)) throw new Error('Route config must be an object');
  const { connectors, routes } = config;
  if (!isObj(connectors) || Object.keys(connectors).length === 0) throw new Error('config.connectors must be a non-empty object');
  for (const [name, c] of Object.entries(connectors)) {
    if (!isObj(c)) throw new Error(`Connector "${name}" must be an object`);
    if (!KINDS.has(c.kind)) throw new Error(`Connector "${name}" has unknown kind "${c.kind}"`);
    if (typeof c.model !== 'string' || !c.model) throw new Error(`Connector "${name}" needs a model string`);
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
  }
  if (typeof config.default !== 'string' || !Object.hasOwn(routes, config.default)) throw new Error(`config.default must name an existing route`);
  return config;
}

export function resolveChain(config, taskType) {
  const route = Object.hasOwn(config.routes, taskType) ? config.routes[taskType] : config.routes[config.default];
  return route.chain.map((name) => {
    const c = config.connectors[name];
    return { connector: name, kind: c.kind, model: c.model, maxTurns: route.maxTurns ?? 1, tools: [...(route.tools ?? [])] };
  });
}

export function nextInChain(chain, failedIndex) {
  if (!Array.isArray(chain)) throw new Error('chain must be an array');
  if (!Number.isInteger(failedIndex) || failedIndex < 0) throw new Error('failedIndex must be a non-negative integer');
  return chain[failedIndex + 1] ?? null;
}
