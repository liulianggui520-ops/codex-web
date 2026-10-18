import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {rm,chmod,chown} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {Updater} from './update-core.mjs';
const run=promisify(execFile),socket='/run/codex-workbench-updater/control.sock';
const updater=new Updater({base:'/opt/codex-workbench',state:'/var/lib/codex-workbench-updater',
  control:action=>run('/usr/bin/systemctl',[action,'codex-web.service'],{timeout:45000,maxBuffer:65536}),
  async health(manifest){for(let i=0;i<30;i++){try{const response=await fetch('http://127.0.0.1:47832/healthz',{headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host},signal:AbortSignal.timeout(1500)}),data=await response.json();if(response.ok&&data.ok&&(!manifest||(data.releaseId===manifest.releaseId&&data.version===manifest.version)))return true;}catch{}await delay(1000);}return false;}
});
await updater.recover();await rm(socket,{force:true});
const gid=Number((await run('/usr/bin/id',['-g','codexweb'])).stdout.trim());
const server=http.createServer(async(req,res)=>{
  let status=200,data;
  try{
    let input='';for await(const chunk of req){input+=chunk;if(input.length>1024)throw Error('请求过大');}
    if(req.url==='/status'&&req.method==='GET')data=await updater.snapshot();
    else if(req.url==='/check'&&req.method==='POST')data=await updater.check();
    else if(req.url==='/apply'&&req.method==='POST')data=await updater.begin(JSON.parse(input||'{}').version);
    else {status=404;data={error:'不支持此操作'};}
  }catch(error){status=409;data={error:error.message};}
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
});
server.requestTimeout=30000;server.headersTimeout=10000;server.maxConnections=8;
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
await chown(socket,0,gid);await chmod(socket,0o660);
