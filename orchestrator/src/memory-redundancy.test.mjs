import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, sameEpisode } from './memory.mjs';
import { createConversationStore } from './history.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { backfillExperiences } from './experience.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'memory-redundancy-'));

test('exact duplicate retries collapse while corrections, paths, word order and provenance survive', () => {
  const m = createMemoryStore(tmp());
  const fields = { title: 'Router', text: 'Use port 8000', scope: 'ops', kind: 'fact' };
  const a = m.add(fields);
  assert.equal(m.add(fields).duplicateOf, a.id);
  assert.equal(m.list().length, 1);
  const ep = text => ({ scope: 'chat', text });
  for (const [a,b] of [['Use port 8000','Use port 8001'], ['Do use the port','Do not use the port'], ['Copy A to B','Copy B to A'], ['Use /Data/FILE','Use /data/file'], ['User said: saved','Assistant report (unverified): saved']]) assert.equal(sameEpisode(ep(a),ep(b)), false);
});

test('memory false persists across resume and restart; Discord room/review backfill stays excluded', async () => {
  const dir = tmp(), conversations = createConversationStore(dir), memory = createMemoryStore(tmp());
  memory.add({ title: 'sentinel', text: 'SHARED_MEMORY_CANARY', tags: ['core'] });
  let system = '';
  const config = { default:'quick', connectors:{a:{kind:'ollama',model:'m'}},routes:{quick:{chain:['a']}} };
  const o = createOrchestrator({config,conversations,memory,episodic:true,run:async(e,p)=>{system=p.system;return {ok:true,text:'Response'};}});
  const r = await o.chat({prompt:'Room greeting', memory:false});
  assert.doesNotMatch(system, /SHARED_MEMORY_CANARY/);
  await o.chat({conversationId:r.conversation.id,prompt:'Follow up'});
  assert.doesNotMatch(system, /SHARED_MEMORY_CANARY/);
  for(const prompt of ['Guide\n\nNew messages (untrusted chat, one per line):\nAdam: hello', 'ROOM REVIEW (private; nothing you write here is posted). Review']) await o.chat({prompt});
  assert.equal(memory.list().length,1);
  const rebuilt = createConversationStore(dir);
  assert.equal(rebuilt.get(r.conversation.id).memory,false);
  assert.deepEqual(backfillExperiences(memory,rebuilt),{written:0,errors:0});
});
