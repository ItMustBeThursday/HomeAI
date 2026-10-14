import {JobStore} from './store.mjs';
const [root,action,id]=process.argv.slice(2);
const store=new JobStore(root);
const value=action==='list'?await store.list():action==='get'?await store.get(id):await store.control(id,action);
console.log(JSON.stringify(value,null,2));
