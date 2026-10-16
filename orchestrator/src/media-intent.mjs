// Explicit requests only: discussing models or writing a prompt is still text chat.
const REQUEST = /^(?:(?:ok(?:ay)?|yes)[,!. ]+)?(?:(?:please|can you|could you|would you|will you|i want you to|i'd like you to)\s+)*(?:generate|make|create|render|draw|paint|compose|produce)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:(?!(?:for|about|of|to|in|with|from|that|which|the|plan|list|prompt|description|title|name|lyrics|playlist|idea|ideas|script|storyboard|review|critique)\b)[\w'-]+\s+){0,6}(video|clip|movie|music|song|soundtrack|tune|image|picture|photo|painting|illustration|drawing)\b/i;
const MODES = { video:'video', clip:'video', movie:'video', music:'music', song:'music', soundtrack:'music', tune:'music', image:'image', picture:'image', photo:'image', painting:'image', illustration:'image', drawing:'image' };
export function mediaIntent(prompt, config, previous) {
  const text = String(prompt ?? '').trim();
  const match = REQUEST.exec(text);
  let route = match && MODES[match[1].toLowerCase()];
  if (!route && /^(?:please\s+)?(?:draw|paint)\s+(?!up\b|a blank\b)/i.test(text)) route = 'image';
  if (!route && previous && /^(?:please\s+)?(?:resume|continue|try again|retry|again|make it\b|same (?:scene|prompt)|another (?:one|version))\b/i.test(text)) route = previous;
  if (!route || !config.routes[route]?.chain.some(n => config.connectors[n]?.kind === 'comfyui')) return null;
  return { kind: 'media', route, via: 'rule', reason: `local ${route} generation`, ms: 0 };
}
