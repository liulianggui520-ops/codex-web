import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename,readdir } from 'node:fs/promises';
import { resolve,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { createApp } from '../server/index.mjs';
import { passwordHash } from '../server/auth.mjs';
import { Events } from '../server/events.mjs';
import { FakeRpc } from './fake-rpc.mjs';
import { Rpc } from '../server/rpc.mjs';
import {updateSocket} from './helpers/update-socket.mjs';
import {probeWebHealth} from '../server/update-health.mjs';
import {version,release} from '../server/release.mjs';
const exec=promisify(execFile),scratch=resolve(process.env.TEST_TMPDIR||fileURLToPath(new URL('../../../work/',import.meta.url)));
async function waitFor(predicate,message){
  const deadline=Date.now()+5000;
  while(!predicate()){assert.ok(Date.now()<deadline,message);await delay(10);}
}
async function harness(options={}){
  await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,'workbench-test-')),root=join(base,'projects');await mkdir(root);const rpc=new FakeRpc(root);
  const app=await createApp({rpc,updates:options.updates,config:{dataDir:join(base,'state'),roots:[root],cwd:root}});app.store.set('credential',await passwordHash('test-password-12345678'));
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${app.server.address().port}`;app.auth.origin=new URL(origin);
  let cookie='',csrf='';
  async function request(path,input,headers={}){const response=await fetch(origin+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,...(input===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf}),...headers},body:input===undefined?undefined:JSON.stringify(input)});let data;try{data=await response.json();}catch{}return{status:response.status,data,headers:response.headers};}
  async function login(){const result=await request('/api/v2/auth/login',{password:'test-password-12345678'});cookie=result.headers.get('set-cookie').split(';')[0];csrf=result.data.csrf;return result;}
  async function cleanup(){await app.close();const rel=relative(scratch,base);assert.ok(rel.startsWith('workbench-test-')&&!rel.includes('..'));await rm(base,{recursive:true,force:true});}
  return{app,rpc,root,base,origin,request,login,cleanup,get cookie(){return cookie;}};
}
test('updater health works through real app Host validation without bypassing it',async()=>{
  const h=await harness();try{
    const origin='https://workbench.example';h.app.auth.origin=new URL(origin);
    // The public Host is required even for loopback probes; the old fetch probe fails.
    assert.equal((await fetch(h.origin+'/healthz',{headers:{Host:new URL(origin).host}})).status,403);
    assert.equal((await probeWebHealth({origin,port:new URL(h.origin).port,manifest:{version,releaseId:release.releaseId}})).ok,true);
    assert.equal((await probeWebHealth({origin:'https://wrong.example',port:new URL(h.origin).port})).ok,false);
  }finally{await h.cleanup();}
});

test('real updater HTTP socket permits connect, account capabilities, queue reconciliation and approval responses',async()=>{
  const requests=[];
  const socket=await updateSocket(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push({method:req.method,path:req.url,bytes:Buffer.concat(chunks).length});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({enabled:true,busy:false}));
  });
  let h;
  try{
    h=await harness({updates:socket.client});await h.login();
    const connected=await h.request('/api/v2/connect',{});assert.equal(connected.status,200);assert.equal(connected.data.connected,true);
    const caps=await h.request('/api/v2/capabilities');assert.equal(caps.status,200);assert.equal(caps.data.account.type,'chatgpt');assert.ok(caps.data.models.some(m=>m.model==='fixture-model'));
    assert.equal((await h.request('/api/v2/updates')).status,200);
    assert.equal((await h.request('/api/v2/queue/reconcile',{})).status,200);
    h.rpc.emit('request',{id:94,method:'item/commandExecution/requestApproval',params:{threadId:'x',availableDecisions:['accept','decline']}});
    const key=[...h.app.workbench.pending.keys()][0];assert.ok(key);
    assert.equal((await h.request(`/api/v2/approvals/${key}`,{decision:'decline'})).status,200);
    assert.deepEqual(h.rpc.replies.at(-1),{id:94,result:{decision:'decline'}});
    assert.equal(requests.length,4);assert.ok(requests.every(r=>r.method==='GET'&&r.path==='/status'&&r.bytes===0));
  }finally{if(h)await h.cleanup();await socket.close();}
});

test('authentication, origin/CSRF, token redaction and websocket session revocation',async()=>{
  const h=await harness();try{
    assert.equal((await h.request('/api/v2/projects')).status,401);
    assert.equal((await h.request('/api/v2/account/limits')).status,401);
    assert.equal((await h.request('/api/v2/auth/login',{password:'test-password-12345678'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await h.request('/api/v2/auth/login',{password:'wrong'})).status,401);
    const login=await h.login();assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal((await h.request('/api/v2/projects',{directory:h.root},{'X-CSRF-Token':'bad'})).status,403);
    const caps=await h.request('/api/v2/capabilities');assert.equal(caps.status,200);assert.ok(!JSON.stringify(caps.data).includes('never-return'));
    const quota=await h.request('/api/v2/account/limits');assert.equal(quota.status,200);assert.equal(quota.data.rateLimits.primary.windowDurationMins,300);
    const client=new WebSocket(h.origin.replace('http:','ws:')+'/ws',{origin:h.origin,headers:{Cookie:h.cookie}});await new Promise((r,j)=>{client.once('open',r);client.once('error',j);});
    const closed=new Promise(r=>client.once('close',r));await h.request('/api/v2/auth/logout',{});await closed;assert.equal((await h.request('/api/v2/projects')).status,401);
    await h.login();for(let i=0;i<10;i++)await h.request('/api/v2/auth/login',{password:'wrong'});assert.equal((await h.request('/api/v2/auth/login',{password:'wrong'})).status,429);
  }finally{await h.cleanup();}
});
test('file root confinement, symlink rejection, optimistic saves and bounded uploads',async()=>{
  const h=await harness();try{
    await h.login();const project=await h.app.files.register(h.root,'test');await writeFile(join(h.root,'hello.txt'),'old');
    assert.equal((await h.request('/api/v2/files/read?'+new URLSearchParams({projectId:project.id,path:'../state/web.sqlite'}))).status,403);
    await assert.rejects(h.app.files.register(h.base,'outside'),e=>e.status===403);
    await mkdir(join(h.base,'private'));await symlink(join(h.base,'private'),join(h.root,'escape'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(h.app.files.resolve(project.id,'escape'),e=>e.status===403);
    const original=await h.app.files.read(project.id,'hello.txt');await writeFile(join(h.root,'hello.txt'),'changed externally');
    await assert.rejects(h.app.files.save(project.id,'hello.txt','mine',original.etag),e=>e.status===409&&e.details.text==='changed externally');
    const current=await h.app.files.read(project.id,'hello.txt');await h.app.files.save(project.id,'hello.txt','saved',current.etag);assert.equal(await readFile(join(h.root,'hello.txt'),'utf8'),'saved');
    const form=new FormData();form.append('files',new Blob(['attachment']), '../evil.txt');const session=(await h.request('/api/v2/auth/session')).data;
    const response=await fetch(h.origin+`/api/v2/files/upload?projectId=${project.id}`,{method:'POST',headers:{Cookie:h.cookie,Origin:h.origin,'X-CSRF-Token':session.csrf},body:form});assert.equal(response.status,200);const upload=await response.json();assert.match(upload.files[0].path,/^\.codex-web-uploads\/[a-z0-9]+-evil.txt$/);assert.equal((await h.app.files.search(project.id,'hello')).matches.length,1);
  }finally{await h.cleanup();}
});
test('native history, binding, pagination, queue ordering, idempotency, steering and recovery',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench;const first=(await w.create({projectId:p.id})).thread,second=(await w.create({projectId:p.id})).thread;
    const input={requestId:'request-first',projectId:p.id,text:'one'};await w.enqueue(first.id,input);
    await waitFor(()=>h.app.store.submission('request-first').status==='running','first queued task did not start');
    await w.enqueue(second.id,{requestId:'request-second',projectId:p.id,text:'two'});
    assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,1);assert.equal(h.app.store.submission('request-second').status,'queued');
    assert.equal((await w.enqueue(first.id,input)).id,'request-first');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,1);
    await assert.rejects(w.enqueue(first.id,{...input,text:'changed'}),e=>e.status===409);
    await w.steer(first.id,{text:'additional'});assert.equal(h.rpc.calls.at(-1).method,'turn/steer');
    h.rpc.complete(first.id);await waitFor(()=>h.app.store.submission('request-second').status==='running','second queued task did not start');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,2);
    await w.stop(second.id);await waitFor(()=>h.app.store.submission('request-second').status==='interrupted','stopped task did not settle');assert.equal(h.app.store.submission('request-second').status,'interrupted');
    const history=await w.history(first.id);assert.equal(history.turns[0].items[0].content[0].text,'one');assert.equal((await w.list({})).data.length,2);
    await w.action(first.id,{action:'rename',name:'renamed'});await w.action(first.id,{action:'pin',pinned:true});assert.equal((await w.list({})).pinnedData[0].pinned,true);
    const migrated=(await h.rpc.call('thread/start',{cwd:'C:\\old-project'})).thread;await assert.rejects(w.resolveProject(migrated.id,p.id),e=>e.status===409);await w.bind(migrated.id,p.id);assert.equal((await w.resolveProject(migrated.id)).id,p.id);
    await w.action(first.id,{action:'archive'});const archived=await w.list({archived:'true'});assert.equal(archived.data.length+archived.pinnedData.length,1);await w.action(first.id,{action:'unarchive'});
    await w.enqueue(first.id,{requestId:'request-lost',projectId:p.id,text:'disconnect'});await waitFor(()=>h.app.store.submission('request-lost').status==='running','task did not start before disconnect');h.rpc.emit('lost');assert.equal(h.app.store.submission('request-lost').status,'uncertain');
    const before=h.rpc.calls.filter(c=>c.method==='turn/start').length;await w.drain();assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,before);
  }finally{await h.cleanup();}
});
test('approvals reject stale IDs, validate forms and forward scoped decisions',async()=>{
  const h=await harness();try{
    const w=h.app.workbench;h.rpc.emit('request',{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'x',availableDecisions:['accept','decline']}});
    const key=[...w.pending.keys()][0];await assert.rejects(w.answer(key,{decision:'acceptForSession'}));await w.answer(key,{decision:'decline'});assert.deepEqual(h.rpc.replies.at(-1).result,{decision:'decline'});await assert.rejects(w.answer(key,{decision:'accept'}),e=>e.status===409);
    h.rpc.emit('request',{id:2,method:'mcpServer/elicitation/request',params:{threadId:'x',mode:'form',requestedSchema:{type:'object',required:['email'],properties:{email:{type:'string',minLength:3}}}}});
    const formKey=[...w.pending.keys()][0];await assert.rejects(w.answer(formKey,{action:'accept',content:{}}));await w.answer(formKey,{action:'accept',content:{email:'owner@example.test'}});
    h.rpc.emit('request',{id:3,method:'item/permissions/requestApproval',params:{threadId:'x',permissions:{network:{enabled:true}}}});await w.answer([...w.pending.keys()][0],{decision:'accept',scope:'session'});assert.equal(h.rpc.replies.at(-1).result.scope,'session');
  }finally{await h.cleanup();}
});
test('terminal concurrency and UTF-8 boundaries; event buffers handle gaps and restart',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench;const created=await Promise.allSettled([w.terminalCreate(p.id),w.terminalCreate(p.id),w.terminalCreate(p.id)]);assert.equal(created.filter(r=>r.status==='fulfilled').length,2);assert.equal(created.find(r=>r.status==='rejected').reason.status,409);const [first,second]=created.filter(r=>r.status==='fulfilled').map(r=>r.value);
    const bytes=Buffer.from('你好');for(const part of [bytes.subarray(0,2),bytes.subarray(2)])h.rpc.emit('notification',{method:'command/exec/outputDelta',params:{processId:first.id,deltaBase64:part.toString('base64')}});assert.match(first.output,/你好/);
    await w.terminalAction(second.id,{action:'kill'});await delay(5);assert.equal(second.status,'exited');
    const events=new Events();for(let i=0;i<2100;i++)events.push('test',{i});assert.equal(events.since(0).gap,true);assert.equal(events.since(3000).gap,true);assert.equal(events.since(2099).events.length,1);assert.ok(events.ring.length<=2000);
    events.push('large',{text:'x'.repeat(1100000)});events.push('after-large',{});assert.equal(events.since(2100).gap,true);assert.equal(events.since(2101).gap,false);
  }finally{await h.cleanup();}
});
test('native pagination traverses more than 100 threads and 600 turns',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench;let selected;
    for(let i=0;i<145;i++){const t=(await h.rpc.call('thread/start',{cwd:h.root})).thread;h.app.store.bind(t.id,p.id);selected=t;}
    selected.turns=Array.from({length:651},(_,i)=>({id:`historic-${i}`,status:'completed',items:[{id:`item-${i}`,type:'agentMessage',text:`history ${i}`}]}));
    const ids=new Set();let cursor;do{const page=await w.list({cursor});page.data.forEach(t=>ids.add(t.id));cursor=page.nextCursor;}while(cursor);assert.equal(ids.size,145);
    const turns=new Set();cursor=undefined;do{const page=await w.history(selected.id,cursor);page.turns.forEach(t=>turns.add(t.id));cursor=page.nextCursor;}while(cursor);assert.equal(turns.size,651);
    assert.equal((await w.list({q:'unmatched'})).data.length,0);
  }finally{await h.cleanup();}
});
test('parallel submissions reserve one thread; queued bindings cannot change; uncertain cancellation confirms native stop',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,a=(await w.create({projectId:p.id})).thread,b=(await w.create({projectId:p.id})).thread;
    const body={requestId:'parallel-id',projectId:p.id,text:'parallel'};
    const duplicate=await Promise.all([w.enqueue(a.id,body),w.enqueue(a.id,body)]);assert.equal(duplicate[0].id,duplicate[1].id);await delay(20);
    const results=await Promise.allSettled([w.enqueue(b.id,{...body,requestId:'parallel-b-one'}),w.enqueue(b.id,{...body,requestId:'parallel-b-two'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(w.bind(b.id,p.id),e=>e.status===409);
    h.rpc.emit('lost');const before=h.rpc.calls.filter(c=>c.method==='turn/start').length;
    const original=h.rpc.call.bind(h.rpc);h.rpc.call=async(method,params)=>method==='turn/interrupt'?{}:original(method,params);
    await assert.rejects(w.jobAction(body.requestId,'cancel'),e=>e.status===409);assert.equal(h.app.store.submission(body.requestId).status,'uncertain');await w.drain();assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,before);
    h.rpc.call=original;await w.jobAction(body.requestId,'cancel');await delay(30);assert.equal(h.app.store.submission(body.requestId).status,'cancelled');assert.equal(h.rpc.chats.get(a.id).status.type,'idle');
  }finally{await h.cleanup();}
});
test('replaced project roots fail closed and edits made during save return a conflict',async()=>{
  const h=await harness();try{
    const directory=join(h.root,'project');await mkdir(directory);const p=await h.app.files.register(directory,'test');await writeFile(join(directory,'test.txt'),'original');const original=await h.app.files.read(p.id,'test.txt');
    const resolveOriginal=h.app.files.resolve.bind(h.app.files);let checks=0;
    h.app.files.resolve=async(...args)=>{const result=await resolveOriginal(...args);if(++checks===2)await writeFile(join(directory,'test.txt'),'external during save');return result;};
    await assert.rejects(h.app.files.save(p.id,'test.txt','my edit',original.etag),e=>e.status===409&&e.details.text==='external during save');assert.equal(await readFile(join(directory,'test.txt'),'utf8'),'external during save');h.app.files.resolve=resolveOriginal;
    await rename(directory,join(h.root,'old-project'));const outside=join(h.base,'outside');await mkdir(outside);await symlink(outside,directory,process.platform==='win32'?'junction':'dir');await assert.rejects(h.app.files.resolve(p.id),e=>e.status===403);
  }finally{await h.cleanup();}
});
test('completion while resubscribing does not revive a recovered job',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;
    await w.enqueue(t.id,{projectId:p.id,requestId:'reconcile-race',text:'recover'});await delay(20);h.rpc.emit('lost');
    const original=h.rpc.call.bind(h.rpc);h.rpc.call=async(method,params)=>{if(method==='thread/resume')h.rpc.complete(t.id);return original(method,params);};
    await w.reconcile();assert.equal(h.app.store.submission('reconcile-race').status,'completed');assert.equal(w.active.size,0);
  }finally{await h.cleanup();}
});
test('late native status snapshots cannot revive a completed uncertain job',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;
    await w.enqueue(t.id,{projectId:p.id,requestId:'reconcile-snapshot',text:'recover snapshot'});await delay(20);h.rpc.emit('lost');
    const original=h.rpc.call.bind(h.rpc);h.rpc.call=async(method,params)=>{const value=await original(method,params);if(method==='thread/turns/list'){const snapshot=structuredClone(value);h.rpc.complete(t.id);return snapshot;}return value;};
    await Promise.all([w.reconcile(),w.reconcile()]);assert.equal(h.app.store.submission('reconcile-snapshot').status,'completed');assert.equal(w.active.size,0);
  }finally{await h.cleanup();}
});
test('cancelling an old interrupted record never interrupts the newer turn',async()=>{
  const h=await harness();try{
    const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;
    await w.enqueue(t.id,{projectId:p.id,requestId:'older-interrupted',text:'old'});await delay(20);await w.stop(t.id);await delay(10);
    await w.enqueue(t.id,{projectId:p.id,requestId:'newer-running',text:'new'});await delay(20);const active=w.active.get(t.id).turnId;
    await w.jobAction('older-interrupted','cancel');assert.equal(h.app.store.submission('older-interrupted').status,'cancelled');assert.equal(h.app.store.submission('newer-running').status,'running');assert.equal(w.active.get(t.id).turnId,active);assert.equal(h.rpc.chats.get(t.id).status.type,'active');
  }finally{await h.cleanup();}
});
test('failed RPC initialization closes each connection before retry',async()=>{
  await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,'workbench-test-rpc-')),socket=process.platform==='win32'?`\\\\.\\pipe\\codex-workbench-rpc-${Date.now()}`:join(base,'engine.sock');
  const server=http.createServer(),ws=new WebSocketServer({server}),clients=new Set();
  ws.on('connection',client=>{clients.add(client);client.on('close',()=>clients.delete(client));client.on('message',bytes=>{const message=JSON.parse(bytes.toString());client.send(JSON.stringify({id:message.id,error:{code:-32600,message:'Test initialize rejection'}}));});});
  await new Promise(r=>server.listen(socket,r));const rpc=new Rpc({socket});
  try{for(let i=0;i<3;i++)await assert.rejects(rpc.connect(),/Test initialize rejection/);await delay(30);assert.equal(clients.size,0);assert.equal(rpc.ready,false);assert.equal(rpc.pending.size,0);}
  finally{rpc.close();for(const client of clients)client.terminate();ws.close();await new Promise(r=>server.close(r));await rm(base,{recursive:true,force:true});}
});
test('Git operations use argv and handle filenames containing spaces',async()=>{
  const h=await harness();try{
    await exec('git',['init','-b','main',h.root]);await exec('git',['-C',h.root,'config','user.name','Test']);await exec('git',['-C',h.root,'config','user.email','test@example.test']);
    const p=await h.app.files.register(h.root,'test');await writeFile(join(h.root,'space name.txt'),'hello');const git=h.app.git;
    assert.equal((await git.status(p.id)).files[0].path,'space name.txt');await git.action(p.id,{action:'stage',paths:['space name.txt']});await git.action(p.id,{action:'unstage',paths:['space name.txt']});assert.equal(await readFile(join(h.root,'space name.txt'),'utf8'),'hello');assert.equal((await git.status(p.id)).files[0].status,'??');await git.action(p.id,{action:'stage',paths:['space name.txt']});await git.action(p.id,{action:'commit',message:'initial'});assert.equal((await git.status(p.id)).files.length,0);
    await assert.rejects(git.action(p.id,{action:'branch',branch:'--orphan'}));await writeFile(join(h.root,'space name.txt'),'updated');assert.match((await git.diff(p.id)).diff,/updated/);
    await mkdir(join(h.root,'gone'));await writeFile(join(h.root,'gone','deleted.txt'),'tracked');await git.action(p.id,{action:'stage',paths:['gone/deleted.txt']});await git.action(p.id,{action:'commit',message:'track nested file'});await rm(join(h.root,'gone'),{recursive:true});await git.action(p.id,{action:'stage',paths:['gone/deleted.txt']});assert.match((await git.diff(p.id,true,'gone/deleted.txt')).diff,/deleted file/);
  }finally{await h.cleanup();}
});
test('nested projects cannot operate on a parent Git repository',async()=>{
  const h=await harness();try{await exec('git',['init','-b','main',h.root]);await mkdir(join(h.root,'nested'));const p=await h.app.files.register(join(h.root,'nested'),'nested');const status=await h.app.git.status(p.id);assert.equal(status.repository,false);assert.match(status.reason,/父 Git/);await assert.rejects(h.app.git.action(p.id,{action:'commit',message:'must not commit parent'}),e=>e.status===409);}finally{await h.cleanup();}
});
test('MCP schemas preserve secret-named input fields while credential responses remain redacted',async()=>{
  const h=await harness();try{const w=h.app.workbench;h.rpc.emit('request',{id:10,method:'mcpServer/elicitation/request',params:{threadId:'t',mode:'form',requestedSchema:{type:'object',required:['apiKey','enabled'],properties:{apiKey:{type:'string',title:'API key',default:'not-for-browser'},enabled:{type:'boolean'},default:{type:'string'},examples:{type:'string'},headers:{type:'object',properties:{authorization:{type:'string'}}}}}}});const request=[...w.pending.values()][0];assert.equal(request.params.requestedSchema.properties.apiKey.type,'string');assert.equal(request.params.requestedSchema.properties.apiKey.default,undefined);assert.ok(request.params.requestedSchema.properties.headers.properties.authorization);assert.equal(request.params.requestedSchema.properties.default.type,'string');assert.equal(request.params.requestedSchema.properties.examples.type,'string');await w.answer(request.key,{action:'accept',content:{apiKey:'provided-by-user',enabled:false}});assert.equal(h.rpc.replies.at(-1).result.content.apiKey,'provided-by-user');const caps=await w.capabilities();assert.ok(!JSON.stringify(caps).includes('never-return'));w.notification({method:'account/login/completed',params:{success:true}});assert.equal(w.cache,null);}finally{await h.cleanup();}
});
test('older-page pins appear globally and retain native archive/search filters',async()=>{
  const h=await harness();try{const w=h.app.workbench,p=await h.app.files.register(h.root,'test');let older;for(let i=0;i<145;i++){const t=(await h.rpc.call('thread/start',{cwd:h.root})).thread;h.app.store.bind(t.id,p.id);t.name=`thread ${i}`;older=t;}await w.action(older.id,{action:'pin',pinned:true});const initial=await w.list({});assert.equal(initial.pinnedData[0].id,older.id);assert.ok(!initial.data.some(t=>t.id===older.id));await w.action(older.id,{action:'archive'});assert.equal((await w.list({})).pinnedData.length,0);assert.equal((await w.list({archived:'true'})).pinnedData[0].id,older.id);assert.equal((await w.list({archived:'true',q:'unmatched'})).pinnedData.length,0);}finally{await h.cleanup();}
});
test('long pinned scans keep progressing beyond the cache TTL',async()=>{
  const h=await harness(),originalNow=Date.now;try{let now=originalNow();Date.now=()=>now;h.rpc.call=async(method,params)=>{assert.equal(method,'thread/list');const start=Number(params.cursor)||0,end=Math.min(start+100,20000);return{data:Array.from({length:end-start},(_,i)=>({id:`t${start+i}`})),nextCursor:end<20000?String(end):null};};let result;for(let i=0;i<100;i++){result=await h.app.workbench.findPinned({archived:false},new Set(['t19000']));now+=1000;if(!result.loading)break;}assert.equal(result.data[0]?.id,'t19000');assert.equal(result.loading,false);}finally{Date.now=originalNow;await h.cleanup();}
});
test('upload total limit, failed writes and client aborts always settle and clean partial files',async()=>{
  const h=await harness();try{
    await h.login();const p=await h.app.files.register(h.root,'test'),session=(await h.request('/api/v2/auth/session')).data;
    const headers={Cookie:h.cookie,Origin:h.origin,'X-CSRF-Token':session.csrf},url=h.origin+`/api/v2/files/upload?projectId=${p.id}`,folder=join(h.root,'.codex-web-uploads');
    const form=new FormData(),file=new Blob([Buffer.alloc(17*1024*1024)]);for(let i=0;i<5;i++)form.append('files',file,`large-${i}.bin`);
    const exceeded=await fetch(url,{method:'POST',headers,body:form,signal:AbortSignal.timeout(10000)});assert.equal(exceeded.status,413);assert.deepEqual(await readdir(folder),[]);
    const original=h.app.files.resolve.bind(h.app.files);let replaced=false;h.app.files.resolve=async(...args)=>{const result=await original(...args);if(args[1]==='.codex-web-uploads'&&!replaced){replaced=true;await rm(folder,{recursive:true});await writeFile(folder,'not a directory');}return result;};
    const tiny=new FormData();tiny.append('files',new Blob(['tiny']),'tiny.txt');const failed=await fetch(url,{method:'POST',headers,body:tiny,signal:AbortSignal.timeout(5000)});assert.ok(failed.status>=400&&failed.status<600);assert.ok((await failed.json()).error);h.app.files.resolve=original;await rm(folder);await mkdir(folder);
    await new Promise(resolve=>{const req=http.request(url,{method:'POST',headers:{...headers,'Content-Type':'multipart/form-data; boundary=test-boundary'}},()=>resolve());req.on('error',()=>resolve());req.write('--test-boundary\r\nContent-Disposition: form-data; name="files"; filename="partial.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');req.write(Buffer.alloc(1024));setTimeout(()=>req.destroy(new Error('intentional test abort')),60);});
    await delay(150);assert.deepEqual(await readdir(folder),[]);
  }finally{await h.cleanup();}
});

test('directory browsing is confined and project removal preserves files/history while blocking jobs and terminals',async()=>{
  const h=await harness();try{
    const child=join(h.root,'browse-me');await mkdir(child);await writeFile(join(child,'keep.txt'),'keep this file');
    await symlink(h.base,join(h.root,'outside-link'),process.platform==='win32'?'junction':'dir');
    const p=await h.app.files.register(child,'browse-me'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;
    assert.equal((await h.request(`/api/v2/projects/${p.id}/remove`,{})).status,401);await h.login();
    const listing=await h.request('/api/v2/projects/directories');assert.equal(listing.status,200);assert.equal(listing.data.parent,null);assert.ok(listing.data.entries.some(e=>e.name==='browse-me'));assert.ok(!listing.data.entries.some(e=>e.name==='outside-link'));
    assert.equal((await h.request('/api/v2/projects/directories?'+new URLSearchParams({directory:h.base}))).status,403);
    assert.equal((await h.request('/api/v2/projects/directories?'+new URLSearchParams({directory:join(h.root,'outside-link')}))).status,403);
    const terminal=await w.terminalCreate(p.id);assert.equal((await h.request(`/api/v2/projects/${p.id}/remove`,{})).status,409);await w.terminalAction(terminal.id,{action:'kill'});await delay(10);
    await w.enqueue(t.id,{projectId:p.id,requestId:'remove-project-busy',text:'busy'});await delay(20);assert.equal((await h.request(`/api/v2/projects/${p.id}/remove`,{})).status,409);h.rpc.complete(t.id);await delay(20);
    assert.equal((await h.request(`/api/v2/projects/${p.id}/remove`,{})).status,200);assert.equal(h.app.store.project(p.id),undefined);assert.equal(h.app.store.binding(t.id),undefined);assert.equal(await readFile(join(child,'keep.txt'),'utf8'),'keep this file');assert.equal((await w.history(t.id)).thread.id,t.id);
    const again=await h.app.files.register(child,'again');await w.enqueue(t.id,{projectId:again.id,requestId:'re-register-send',text:'continue'});await delay(20);assert.equal(h.app.store.submission('re-register-send').status,'running');
  }finally{await h.cleanup();}
});
test('late thread creation cannot bind a project removed while the native request was pending',async()=>{
  const h=await harness();try{const p=await h.app.files.register(h.root,'test'),original=h.rpc.call.bind(h.rpc);let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);h.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='thread/start'){started();await gate;}return result;};const pending=h.app.workbench.create({projectId:p.id});await ready;h.app.workbench.removeProject(p.id);release();await assert.rejects(pending,e=>e.status===404);assert.equal(h.app.store.binding('chat-1'),undefined);}finally{await h.cleanup();}
});
test('removal during the first native directory lookup cannot leave a dangling imported-thread binding',async()=>{
  const h=await harness();try{const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;h.app.store.db.prepare('DELETE FROM bindings WHERE thread=?').run(t.id);const original=h.rpc.call.bind(h.rpc);let removed=false;h.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='thread/read')Object.defineProperty(result.thread,'cwd',{get(){if(!removed){removed=true;queueMicrotask(()=>w.removeProject(p.id));}return p.path;}});return result;};await assert.rejects(w.resolveProject(t.id,p.id),e=>e.status===404);assert.equal(h.app.store.binding(t.id),undefined);h.rpc.call=original;const again=await h.app.files.register(h.root,'again');assert.equal((await w.resolveProject(t.id,again.id)).id,again.id);}finally{await h.cleanup();}
});
test('completion after a lost start acknowledgement does not revert to uncertain or stall the next job',async()=>{
  const h=await harness();try{const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,a=(await w.create({projectId:p.id})).thread,b=(await w.create({projectId:p.id})).thread,original=h.rpc.call.bind(h.rpc);let rejectAck;h.rpc.call=async(method,params)=>{const result=await original(method,params);if(method==='turn/start'&&params.threadId===a.id)return new Promise((_,reject)=>rejectAck=reject);return result;};await w.enqueue(a.id,{projectId:p.id,requestId:'lost-start-ack',text:'first'});await delay(20);assert.equal(h.app.store.submission('lost-start-ack').result.turnId,'turn-1');await w.enqueue(b.id,{projectId:p.id,requestId:'after-lost-ack',text:'second'});h.rpc.complete(a.id);rejectAck(new Error('response timeout'));await delay(30);assert.equal(h.app.store.submission('lost-start-ack').status,'completed');assert.equal(h.app.store.submission('after-lost-ack').status,'running');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,2);}finally{await h.cleanup();}
});
test('reconciliation repairs a missing completion and permits the next message without steering an ended turn',async()=>{
  const h=await harness();try{const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;await w.enqueue(t.id,{projectId:p.id,requestId:'missing-completion',text:'first'});await delay(20);const emit=h.rpc.emit.bind(h.rpc);h.rpc.emit=(type,message)=>type==='notification'&&message.method==='turn/completed'?false:emit(type,message);h.rpc.complete(t.id);assert.equal(h.app.store.submission('missing-completion').status,'running');await assert.rejects(w.steer(t.id,{text:'next'}),e=>e.status===409&&!e.message.includes('no active turn'));assert.equal(h.app.store.submission('missing-completion').status,'completed');assert.equal(w.active.size,0);await w.enqueue(t.id,{projectId:p.id,requestId:'next-after-reconcile',text:'next'});await delay(20);assert.equal(h.app.store.submission('next-after-reconcile').status,'running');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/steer').length,0);}finally{await h.cleanup();}
});
test('legacy uncertain requests without a turn ID are reconciled while never being automatically resubmitted',async()=>{
  const h=await harness();try{const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;h.app.store.enqueue({id:'legacy-uncertain',thread:t.id,project:p.id,payload:{text:'old'},created:Date.now()});h.app.store.updateJob('legacy-uncertain','uncertain');await w.reconcile();assert.equal(h.app.store.submission('legacy-uncertain').status,'interrupted');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,0);await w.enqueue(t.id,{projectId:p.id,requestId:'after-legacy-idle',text:'next'});await delay(20);const native=h.rpc.chats.get(t.id);native.turns.at(-1).items[0].clientId='after-legacy-idle';h.rpc.emit('lost');h.app.store.updateJob('after-legacy-idle','uncertain');await w.reconcile();assert.equal(h.app.store.submission('after-legacy-idle').status,'running');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/start').length,1);}finally{await h.cleanup();}
});
test('an uncorrelated active request can only stop the current turn through the explicit recovery action',async()=>{
  const h=await harness();try{const p=await h.app.files.register(h.root,'test'),w=h.app.workbench,t=(await w.create({projectId:p.id})).thread;await w.enqueue(t.id,{projectId:p.id,requestId:'unknown-active-request',text:'task'});await delay(20);h.rpc.emit('lost');h.app.store.updateJob('unknown-active-request','uncertain');await assert.rejects(w.jobAction('unknown-active-request','cancel'),e=>e.status===409);assert.equal(h.rpc.calls.filter(c=>c.method==='turn/interrupt').length,0);await w.jobAction('unknown-active-request','stop-current');assert.equal(h.rpc.calls.filter(c=>c.method==='turn/interrupt').length,1);assert.equal(h.app.store.submission('unknown-active-request').status,'cancelled');assert.equal(h.rpc.chats.get(t.id).status.type,'idle');}finally{await h.cleanup();}
});
test('updates block tasks, terminals and concurrent writes, and failed downloads release maintenance without UI polling',async()=>{
  let busy=false,applies=0;const updates={async request(action='status'){if(action==='apply'){applies++;busy=true;}return {enabled:true,busy};}};
  const h=await harness({updates});try{await h.login();const p=await h.app.files.register(h.root,'test'),thread=(await h.app.workbench.create({projectId:p.id})).thread;await h.app.workbench.enqueue(thread.id,{requestId:'update-busy',projectId:p.id,text:'run'});await delay(30);assert.equal((await h.request('/api/v2/updates/apply',{version:'2.2.0'})).status,409);assert.equal(applies,0);h.rpc.complete(thread.id);await delay(40);const terminal=await h.app.workbench.terminalCreate(p.id,80,24);assert.equal((await h.request('/api/v2/updates/apply',{version:'2.2.0'})).status,409);await h.app.workbench.terminalAction(terminal.id,{action:'kill'});await delay(30);assert.equal((await h.request('/api/v2/updates/apply',{version:'2.2.0'})).status,200);assert.equal((await h.request('/api/v2/projects',{directory:h.root,name:'blocked'})).status,409);busy=false;assert.equal((await h.request('/api/v2/projects',{directory:h.root,name:'recovered'})).status,200);assert.equal(h.app.workbench.maintenance,false);assert.equal(applies,1);
  }finally{await h.cleanup();}
});
