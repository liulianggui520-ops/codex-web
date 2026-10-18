import http from 'node:http';
import {UpdateClient} from './update-client.mjs';
import {version,release} from './release.mjs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.mjs';
import { Auth, passwordHash } from './auth.mjs';
import { Rpc } from './rpc.mjs';
import { Files, inside } from './files.mjs';
import { Git } from './git.mjs';
import { Workbench } from './workbench.mjs';
import { Events } from './events.mjs';
import { jsonBody, fail, check, redact } from './util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export async function createApp(options = {}) {
  const config = { dataDir: resolve(process.env.DATA_DIR || join(here,'..','runtime')), cwd: process.cwd(), codexBinary: process.env.CODEX_BINARY || 'codex', codexHome: process.env.CODEX_HOME,
    socket: process.env.CODEX_SOCKET, origin: process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:47832', roots: JSON.parse(process.env.ALLOWED_ROOTS || JSON.stringify([process.env.WORKSPACE_ROOT || process.cwd()])), dist: join(here,'..','dist'), ...options.config };
  const origin = new URL(config.origin);
  check(origin.protocol === 'https:' || ['127.0.0.1','localhost'].includes(origin.hostname),'公网访问必须配置 HTTPS PUBLIC_ORIGIN');
  await mkdir(config.dataDir,{ recursive:true, mode:0o700 });
  const store = options.store || new Store(join(config.dataDir,'web.sqlite'));
  if (process.env.CODEX_WEB_PASSWORD && !store.get('credential')) store.set('credential',await passwordHash(process.env.CODEX_WEB_PASSWORD));
  delete process.env.CODEX_WEB_PASSWORD;
  const auth = new Auth(store,config.origin), events = new Events();
  const rpc = options.rpc || new Rpc(config), files = new Files(store,config.roots), git = new Git(files);
  const protocol = JSON.parse(await readFile(join(here,'..','protocol','methods.json'),'utf8'));
  const workbench = new Workbench(store,rpc,files,events,protocol.methods);
  const updates=options.updates||new UpdateClient();
  let mutations=0,applying=false,applyPending=false;
  const json = (res,status,data) => { res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let mutation=false;
    try {
      auth.originCheck(req);
      const url = new URL(req.url,config.origin), pathname = url.pathname, query = Object.fromEntries(url.searchParams);
      if (pathname === '/healthz' && req.method === 'GET') { json(res,200,{ ok:true,version,releaseId:release.releaseId }); return; }
      if (pathname === '/api/v2/auth/login' && req.method === 'POST') { json(res,200,await auth.login(req,res,await jsonBody(req,4096))); return; }
      if (pathname.startsWith('/api/')) {
        const session = auth.session(req);
        if (pathname === '/api/v2/auth/session' && req.method === 'GET') { json(res,200,{ csrf:session.csrf, projects:store.projects(), preferences:store.get('preferences',{}), roots:config.roots }); return; }
        if (pathname === '/api/v2/auth/logout' && req.method === 'POST') { auth.logout(req,res); for(const client of ws.clients)if(client.session.token===session.token)client.close(1008,'signed out'); json(res,200,{}); return; }
        if(req.method==='POST'&&!['/api/v2/updates/check','/api/v2/preferences'].includes(pathname)){
          mutations++;mutation=true;
          const state=await updates.request();
          if(!applyPending&&!state.busy){applying=false;workbench.maintenance=false;}
          check(!applying&&!state.busy,'工作台正在更新，请稍后重试',409);
        }
        if (pathname === '/api/v2/files/raw' && req.method === 'GET') { await files.raw(req,res,query.projectId,query.path,query.download === 'true'); return; }
        if (pathname === '/api/v2/files/upload' && req.method === 'POST') { json(res,200,await files.upload(req,query.projectId)); return; }
        const input = req.method === 'POST' ? await jsonBody(req,3 * 1024 * 1024) : {};
        let result, matched = true;
        const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent).slice(2);
        if (req.method === 'GET') {
          if (pathname === '/api/v2/updates') {result=await updates.request();if(!applyPending&&!result.busy){applying=false;workbench.maintenance=false;}}
          else if (pathname === '/api/v2/capabilities') result = await workbench.capabilities();
          else if (pathname === '/api/v2/projects') result = { projects:store.projects() };
          else if (pathname === '/api/v2/threads') result = await workbench.list(query);
          else if (parts[0] === 'threads' && parts.length === 2) result = await workbench.history(parts[1],query.cursor);
          else if (pathname === '/api/v2/queue') result = { jobs:store.jobs() };
          else if (pathname === '/api/v2/events') result = events.since(Number(query.after)||0);
          else if (pathname === '/api/v2/files/tree') result = await files.list(query.projectId,query.path);
          else if (pathname === '/api/v2/files/read') result = await files.read(query.projectId,query.path);
          else if (pathname === '/api/v2/files/search') result = await files.search(query.projectId,query.q,query.content === 'true');
          else if (pathname === '/api/v2/git/status') result = await git.status(query.projectId);
          else if (pathname === '/api/v2/git/diff') result = await git.diff(query.projectId,query.staged === 'true',query.path);
          else if (pathname === '/api/v2/terminals') result = { terminals:[...workbench.terminals.values()].filter(t => !query.projectId || t.projectId === query.projectId) };
          else if (pathname === '/api/v2/extensions') result = await workbench.extensions(query.projectId,query.catalog === 'true');
          else if (pathname === '/api/v2/diagnostics') result = { version, protocol:protocol.version, node:process.version, connected:rpc.ready, uptime:process.uptime(), memory:process.memoryUsage(), queue:store.jobs().length, terminalLimit:2, taskConcurrency:1 };
          else matched = false;
        } else if (req.method === 'POST') {
          if(pathname==='/api/v2/updates/check')result=await updates.request('check');
          else if(pathname==='/api/v2/updates/apply'){
            check(!applying&&mutations===1&&!workbench.draining&&!workbench.active.size&&!workbench.pending.size&&!store.jobs().some(j=>['queued','starting','running','uncertain'].includes(j.status))&&![...workbench.terminals.values()].some(t=>['running','starting'].includes(t.status)),'请先完成或取消任务并结束所有终端，再更新',409);
            applying=true;applyPending=true;workbench.maintenance=true;
            try{result=await updates.request('apply',{version:input.version});check(result.enabled,'服务器尚未启用更新服务',501);}catch(error){
              // An uncertain apply is never retried; retain the maintenance lock until status is confirmed.
              try{const state=await updates.request();applying=state.busy;workbench.maintenance=state.busy;}catch{}
              throw error;
            }finally{applyPending=false;}
          }
          else if (pathname === '/api/v2/connect') { await workbench.connect(); await workbench.reconcile(); workbench.drain(); result = { connected:true }; }
          else if (pathname === '/api/v2/preferences') { const preferences = { theme:input.theme === 'light' ? 'light' : 'dark', sidebar:Math.max(200,Math.min(400,Number(input.sidebar)||250)), inspector:Math.max(280,Math.min(700,Number(input.inspector)||360)), terminal:Math.max(150,Math.min(600,Number(input.terminal)||230)) }; store.set('preferences',preferences); result = preferences; }
          else if (pathname === '/api/v2/projects') { result = await files.register(input.directory,input.name); events.push('projects/changed',{}); }
          else if (pathname === '/api/v2/threads') result = await workbench.create(input);
          else if (parts[0] === 'threads' && parts.length === 3) {
            const thread = parts[1];
            if (parts[2] === 'actions') { result = await workbench.action(thread,input); events.push('threads/changed',{}); }
            else if (parts[2] === 'bind') result = await workbench.bind(thread,input.projectId);
            else if (parts[2] === 'turns') result = await workbench.enqueue(thread,input);
            else if (parts[2] === 'steer') result = await workbench.steer(thread,input);
            else if (parts[2] === 'stop') result = await workbench.stop(thread);
            else matched = false;
          }
          else if (parts[0] === 'queue' && parts.length === 2) result = await workbench.jobAction(parts[1],input.action);
          else if (parts[0] === 'approvals' && parts.length === 2) result = await workbench.answer(parts[1],input);
          else if (pathname === '/api/v2/files/save') { result = await files.save(input.projectId,input.path,input.text,input.etag); events.push('files/changed',{ projectId:input.projectId, path:input.path }); }
          else if (pathname === '/api/v2/git/action') { result = await git.action(input.projectId,input); events.push('git/changed',{ projectId:input.projectId }); }
          else if (pathname === '/api/v2/terminals') result = await workbench.terminalCreate(input.projectId,input.cols,input.rows);
          else if (parts[0] === 'terminals' && parts.length === 2) result = await workbench.terminalAction(parts[1],input);
          else if (pathname === '/api/v2/extensions/action') { result = await workbench.extensionAction(input.projectId,input); events.push('extensions/changed',{}); }
          else if (pathname === '/api/v2/account/login') { result = redact(await workbench.supported('account/login/start',{ type:'chatgptDeviceCode' })); workbench.cache = null; }
          else matched = false;
        } else matched = false;
        if (!matched) throw fail(404,'没有这个接口');
        json(res,200,result ?? {}); return;
      }
      check(req.method === 'GET','请求方法无效',405);
      const root = resolve(config.dist), candidate = resolve(root, '.' + pathname);
      check(inside(root,candidate),'路径无效',403);
      let file = candidate;
      try { if (!(await stat(file)).isFile()) file = join(root,'index.html'); } catch { file = join(root,'index.html'); }
      check(!pathname.includes('..') && !pathname.startsWith('/.'),'路径无效',403);
      const info = await stat(file);
      const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2' }[extname(file)] ?? 'application/octet-stream';
      res.writeHead(200,{ 'Content-Type':mime,'Content-Length':info.size,'Cache-Control':extname(file)==='.html' ? 'no-store' : 'public, max-age=31536000, immutable' }); createReadStream(file).pipe(res);
    } catch (error) { if (!res.headersSent) json(res,error.status ?? (error.code === 'ENOENT' ? 404 : 500),{ error:error.message, details:error.details }); else res.destroy(); } finally {if(mutation)mutations--;}
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000;
  const ws = new WebSocketServer({ noServer:true, maxPayload:1024, perMessageDeflate:false });
  server.on('upgrade',(req,socket,head) => {
    try {
      auth.originCheck(req); auth.session(req); check(ws.clients.size < 12,'连接数量过多',429);
      const url = new URL(req.url,config.origin); check(url.pathname === '/ws','路径无效',404);
      ws.handleUpgrade(req,socket,head,client => {
        client.session = auth.session(req);
        const requested = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : null;
        const snapshot = requested === null ? { gap:true,seq:events.seq,events:[] } : events.since(requested);
        client.send(JSON.stringify({ type:'sync',payload:snapshot }));
        client.on('message',() => client.close(1008,'read-only event channel'));
        ws.emit('connection',client,req);
      });
    } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); }
  });
  const broadcast = event => {
    const data = JSON.stringify(event);
    for (const client of ws.clients) {
      if (client.session.expires < Date.now()) { client.close(1008,'session expired'); continue; }
      if (client.bufferedAmount > 1024 * 1024) client.close(1013,'resync needed');
      else if (client.readyState === 1) client.send(data);
    }
  };
  events.on('event',broadcast);
  const heartbeat = setInterval(() => { for (const client of ws.clients) { const live = store.db.prepare('SELECT 1 FROM sessions WHERE token=? AND expires>?').get(client.session.token,Date.now()); if (!live) client.close(1008,'session expired'); else client.ping(); } },30000); heartbeat.unref();
  return { server,store,workbench,files,git,events,rpc,config,auth,
    async close() { clearInterval(heartbeat); events.off('event',broadcast); for (const client of ws.clients) client.terminate(); ws.close(); workbench.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); } };
}
async function main() {
  const app = await createApp(), port = Number(process.env.PORT || 47832);
  await new Promise((resolve,reject) => { app.server.once('error',reject); app.server.listen(port,'127.0.0.1',resolve); });
  console.log(`Codex Workbench ${version} listening on 127.0.0.1:${port}`);
  const reconnect=setInterval(()=>{if(app.config.socket&&!app.rpc.ready)app.workbench.connect().then(()=>app.workbench.reconcile()).then(()=>app.workbench.drain()).catch(()=>{});},5000);reconnect.unref();
  const stop = async () => { clearInterval(reconnect); await app.close(); process.exit(0); }; process.on('SIGINT',stop); process.on('SIGTERM',stop);
  if (app.config.socket) app.workbench.connect().then(() => app.workbench.reconcile()).then(() => app.workbench.drain()).catch(error => console.error('Codex not ready:',error.message));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exit(1); });
