import { mkdir,mkdtemp,writeFile,readFile } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/index.mjs';
import { passwordHash } from '../server/auth.mjs';
const exec=promisify(execFile),root=dirname(dirname(fileURLToPath(import.meta.url))),scratch=resolve(process.env.SMOKE_ROOT||join(root,'..','..','work'));
await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,'real-codex-smoke-')),project=join(base,'project');await mkdir(project);
await writeFile(join(project,'README.md'),'Create proof.cjs using node:assert/strict; assert.equal(2 + 2, 4); print CODEX_WORKBENCH_OK. Run node proof.cjs. Do not change other files.\n');
await exec('git',['init','-b','main',project]);
const app=await createApp({config:{dataDir:join(base,'state'),roots:[project],cwd:project,codexBinary:process.env.CODEX_BINARY||'codex',socket:process.env.CODEX_SOCKET}});
const password=randomBytes(24).toString('base64url');app.store.set('credential',await passwordHash(password));await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${app.server.address().port}`;app.auth.origin=new URL(origin);let cookie='',csrf='';
async function request(path,input){const r=await fetch(origin+'/api/v2'+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:input===undefined?undefined:JSON.stringify(input)});const data=await r.json();if(!r.ok)throw new Error(data.error);return{data,headers:r.headers};}
const approved=[];
const auto=app.events.on('event',event=>{
  if(event.type!=='approval/request')return;
  const p=event.payload,params=p.params;
  const own=String(params.cwd??'').replaceAll('\\','/').toLowerCase()===project.replaceAll('\\','/').toLowerCase();
  const safeCommand=p.method==='item/commandExecution/requestApproval'&&own&&/node[^\n]*proof\.cjs/.test(params.command??'');
  const safeFile=p.method==='item/fileChange/requestApproval'&&String(params.grantRoot??'').replaceAll('\\','/').toLowerCase().startsWith(project.replaceAll('\\','/').toLowerCase());
  if(safeCommand||safeFile){approved.push(p.method);app.workbench.answer(p.id,{decision:'accept'}).catch(()=>{});}else app.workbench.answer(p.id,{decision:'decline'}).catch(()=>{});
});
try{
  const login=await request('/auth/login',{password});cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
  await request('/connect',{});const p=(await request('/projects',{directory:project,name:'Real Codex smoke'})).data;
  const t=(await request('/threads',{projectId:p.id,sandbox:'workspace-write'})).data.thread;
  const requestId=randomBytes(16).toString('hex');await request(`/threads/${t.id}/turns`,{requestId,projectId:p.id,text:'这是一次独立临时项目的连接验收。请用工具读取 README.md，按其中要求只创建 proof.cjs，然后运行 node proof.cjs。不要启用子代理，不调用外部服务，不操作其他项目。完成后简要报告测试结果。'});
  const deadline=Date.now()+300000;let job;
  while(Date.now()<deadline){job=app.store.submission(requestId);if(['completed','failed','interrupted','uncertain'].includes(job.status))break;await delay(1000);}
  if(job.status!=='completed')throw new Error(`Real task did not complete: ${JSON.stringify(job.result)}`);
  const file=(await request('/files/read?'+new URLSearchParams({projectId:p.id,path:'proof.cjs'}))).data;
  if(!/assert/.test(file.text))throw new Error('The model did not create the expected assertion file');
  const result=await exec(process.execPath,['proof.cjs'],{cwd:project});if(!result.stdout.includes('CODEX_WORKBENCH_OK'))throw new Error('Test marker missing');
  await exec('git',['-C',project,'add','-N','--','proof.cjs']);const diff=(await request('/git/diff?'+new URLSearchParams({projectId:p.id}))).data.diff;if(!diff.includes('proof.cjs'))throw new Error('Diff is missing generated file');
  const history=(await request(`/threads/${t.id}`)).data;
  const executed=history.turns.flatMap(t=>t.items).some(i=>i.type==='commandExecution'&&String(i.command).includes('proof.cjs')&&String(i.aggregatedOutput).includes('CODEX_WORKBENCH_OK'));
  if(!executed)throw new Error('Native history did not confirm the model ran the test command');
  const report={ok:true,platform:process.platform,project,threadId:t.id,readViaAPI:true,fileModified:true,diffVerified:true,modelTestExecutionVerified:true,independentTestPassed:true,approvals:approved,completedAt:new Date().toISOString()};
  await writeFile(join(base,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{app.events.removeAllListeners('event');await app.close();}
