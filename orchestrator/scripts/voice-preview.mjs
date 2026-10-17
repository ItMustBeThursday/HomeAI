// Isolated local UI acceptance server. Never runs a model or touches live chats.
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../src/server.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { createConversationStore, createTaskHistory } from '../src/history.mjs';
const dir='D:/HomeAI/evaluations/voice-preview-'+Date.now(); mkdirSync(dir,{recursive:true});
const config={connectors:{local:{kind:'ollama',model:'voice-preview'}},routes:{general:{chain:['local']}},default:'general'};
const conversations=createConversationStore(dir+'/conversations');
const orchestrator=createOrchestrator({config,conversations,history:createTaskHistory(dir+'/history.jsonl'),run:async()=>({ok:true,text:'Local voice preview.',inputTokens:0,outputTokens:0,costUsd:0})});
const tokenFile='D:/HomeAI/projects/orchestrator/data/token.txt';
const server=await startServer({orchestrator,conversations,token:readFileSync(tokenFile,'utf8').trim(),tokenFile,webDir:resolve('D:/HomeAI/projects/orchestrator/web'),version:'voice-preview'}, {port:18871});
console.log('Isolated voice preview listening at http://127.0.0.1:18871');
setTimeout(()=>server.close(),15*60*1000).unref();
