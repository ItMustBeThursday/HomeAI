// Shared ordering and purpose text for the model picker and health dashboard.
export const CATEGORY_ORDER = ['Fast & everyday', 'General & reasoning', 'Heavyweight / CPU offload', 'Coding', 'Vision', 'Cloud agents (Claude / Codex)', 'Image', 'Video', 'Music'];
export function groupByCategory(entries) {
  const groups = new Map();
  for (const [name, c] of entries) {
    const cat = c.category || 'Other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push([name, c]);
  }
  const rank = cat => { const i = CATEGORY_ORDER.indexOf(cat); return i < 0 ? CATEGORY_ORDER.length : i; };
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || compare(a[0], b[0]))
    .map(([cat, items]) => [cat, items.sort(([a, x], [b, y]) => compare(x.label || a, y.label || b) || compare(a, b))]);
}
export const modelTitle = c => [c.label, c.model, c.note].filter(Boolean).join(' — ');
export const modelDescription = c => c
  ? [c.category || 'Other', c.note || c.model].filter(Boolean).join(' · ')
  : 'Automatic follows the selected route. Choose a model to see its purpose and hardware notes.';
