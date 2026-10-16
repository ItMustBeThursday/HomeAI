// Text embeddings from the local Ollama embedding model (no cloud calls). Used by memory search.
export function createOllamaEmbedder({ model, url, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!model) throw new Error('embedder needs a model name');
  if (!url) throw new Error('embedder needs an Ollama URL');
  return {
    model,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) throw new Error('texts must be strings');
      if (!texts.length) return [];
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Embedding HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) throw new Error('Embedding response has the wrong shape');
      return body.embeddings;
    },
  };
}
