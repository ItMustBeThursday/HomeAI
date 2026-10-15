// Explicit caller metrics and token counts only; no benchmark/tokenizer claims.
const nonempty = s => typeof s==='string' && s.trim().length>0;
const count = n => Number.isSafeInteger(n) && n>=0;
const metric = n => typeof n==='number' && Number.isFinite(n) && n>=0;
const digest = s => typeof s==='string' && /^(?:sha256:)?[a-fA-F0-9]{64}$/.test(s);
const byId = (a,b) => a<b ? -1 : a>b ? 1 : 0;
export function rankCandidates(candidates,request,now) {
  if (!Array.isArray(candidates) || !request || !nonempty(request.role) ||
      !count(request.inputTokens) || !count(request.outputTokens) ||
      !count(request.inputTokens+request.outputTokens) ||
      !metric(request.minQuality) || request.minQuality>1 ||
      !metric(request.maxLatencyMs) || !count(request.reserveVramBytes) || !count(now))
    throw new TypeError('Invalid ranking request');
  const seen=new Set(), admitted=[];
  for (const c of candidates) {
    if (!c || !nonempty(c.id) || seen.has(c.id)) throw new TypeError('Invalid or duplicate candidate id');
    seen.add(c.id);
    if (c.status!=='admitted' || !digest(c.digest) ||
        !Array.isArray(c.roles) || !c.roles.length || !c.roles.every(nonempty) ||
        new Set(c.roles).size!==c.roles.length || !c.roles.includes(request.role) ||
        !count(c.contextTokens) || c.contextTokens===0 || !count(c.maxOutputTokens) ||
        !metric(c.quality) || c.quality>1 || !metric(c.latencyMs) ||
        typeof c.local!=='boolean' ||
        (c.local && (!count(c.freeVramBytes) || !count(c.requiredVramBytes)))) continue;
    if (c.contextTokens<request.inputTokens+request.outputTokens ||
        c.maxOutputTokens<request.outputTokens || c.quality<request.minQuality ||
        c.latencyMs>request.maxLatencyMs || (c.local && (c.requiredVramBytes>c.freeVramBytes ||
        request.reserveVramBytes>c.freeVramBytes-c.requiredVramBytes))) continue;
    admitted.push({id:c.id,reason:'admitted: role, context, output, quality, latency satisfied; '+(c.local?'local VRAM satisfied':'hosted VRAM not applicable'),
      quality:c.quality,latencyMs:c.latencyMs,local:c.local,digest:c.digest});
  }
  return admitted.sort((a,b)=>b.quality-a.quality || a.latencyMs-b.latencyMs || byId(a.id,b.id));
}
export function buildContext(items,budget) {
  if (!Array.isArray(items) || !count(budget) || budget===0) throw new TypeError('Invalid context budget');
  const unique=new Map();
  for (const item of items) {
    if (!item || !nonempty(item.id) || typeof item.text!=='string' || !count(item.tokens) ||
        typeof item.required!=='boolean' || typeof item.priority!=='number' || !Number.isFinite(item.priority))
      throw new TypeError('Invalid context item');
    const copy={id:item.id,text:item.text,tokens:item.tokens,required:item.required,priority:item.priority};
    const previous=unique.get(item.id);
    if (previous && (previous.text!==copy.text || previous.tokens!==copy.tokens ||
        previous.required!==copy.required || previous.priority!==copy.priority)) throw new TypeError('Conflicting context id');
    if (!previous) unique.set(item.id,copy);
  }
  const all=[...unique.values()], included=all.filter(i=>i.required), excluded=[];
  let usedTokens=0;
  for (const item of included) {
    if (item.tokens>budget-usedTokens) throw new RangeError('Required context exceeds budget');
    usedTokens+=item.tokens;
  }
  const optional=all.filter(i=>!i.required).sort((a,b)=>b.priority-a.priority || byId(a.id,b.id));
  for (const item of optional) {
    if (item.tokens<=budget-usedTokens) { included.push(item); usedTokens+=item.tokens; }
    else excluded.push(item);
  }
  return {included,excluded,usedTokens};
}
