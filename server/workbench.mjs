import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { validateForm } from './forms.mjs';
import { check, fail, text, id, redact, formSchema } from './util.mjs';

export class Workbench {
  constructor(store, rpc, files, events, methods) {
    Object.assign(this, { store, rpc, files, events, methods });
    this.pending = new Map(); this.active = new Map(); this.terminals = new Map(); this.epoch = id(); this.draining = false;
    this.loaded = new Map(); this.cache = null; this.completed = new Map(); this.decoders = new Map(); this.threadMutations = new Set(); this.enqueues = new Map();
    this.pinScans=new Map();
    store.recoverJobs();
    rpc.on('notification', message => this.notification(message));
    rpc.on('request', message => this.request(message));
    rpc.on('lost', () => {
      this.pending.clear(); this.loaded.clear(); this.cache = null; this.pinScans.clear(); this.epoch = id();
      for (const job of store.jobs()) if (['starting','running'].includes(job.status)) store.updateJob(job.id, 'uncertain', job.result);
      this.active.clear();
      for (const terminal of this.terminals.values()) terminal.status = 'disconnected';
      events.push('connection', { connected: false, message: '引擎连接中断；未确认的任务不会自动重发' });
    });
    rpc.on('ready', () => events.push('connection', { connected: true }));
    this.idleTimer = setInterval(() => this.releaseIdle(), 60000); this.idleTimer.unref();
  }
  async connect() { await this.rpc.connect(); return this.rpc; }
  async supported(method, params = {}) { if (!this.methods.includes(method)) throw fail(501, '当前 Codex 版本未提供此功能'); return (await this.connect()).call(method, params); }
  async optional(method, params, fallback) { try { return await this.supported(method, params); } catch (error) { return { ...fallback, unavailable: error.message }; } }
  async capabilities() {
    if (this.cache && Date.now() - this.cache.time < 60000) return this.cache.value;
    const rpc = await this.connect();
    const models = []; let cursor;
    do { const page = await rpc.call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }); models.push(...page.data); cursor = page.nextCursor; } while (cursor && models.length < 1000);
    const [modes, permissions, account, limits, requirements] = await Promise.all([
      this.optional('collaborationMode/list', {}, { data: [] }), this.optional('permissionProfile/list', { limit: 100 }, { data: [] }),
      this.optional('account/read', { refreshToken: false }, {}), this.optional('account/rateLimits/read', {}, {}), this.optional('configRequirements/read', {}, {}),
    ]);
    const value = redact({ models, modes: modes.data, permissions: permissions.data, account: account.account ?? null, limits,
      requirements: requirements.requirements ? { allowedApprovalPolicies: requirements.requirements.allowedApprovalPolicies, allowedSandboxModes: requirements.requirements.allowedSandboxModes } : null,
      methods: this.methods, engine: this.rpc.info?.userAgent ?? 'Codex app-server', unavailable: { modes: modes.unavailable, permissions: permissions.unavailable, account: account.unavailable },
      unavailableDesktop: ['桌面内嵌浏览器','桌面画面与电脑控制','专属云端自动化'] });
    this.cache = { time: Date.now(), value }; return value;
  }
  async thread(id) { const result = await this.supported('thread/read', { threadId: text(id,200), includeTurns: false }); return result.thread; }
  async list(query) {
    const params = { limit: 40, sortKey: 'updated_at', sourceKinds: ['cli','vscode','appServer','exec'], archived: query.archived === 'true', ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.q ? { searchTerm: text(query.q,100) } : {}) };
    // Filtering by cwd would hide migrated Windows conversations before they are rebound.
    const pins = new Set(this.store.pins()),filter={...params};delete filter.cursor;
    const [page,pinned]=await Promise.all([query.pinsOnly==='true'?{data:[],nextCursor:null}:this.supported('thread/list',params),this.findPinned(filter,pins)]);
    const decorate=t=>({...t,pinned:pins.has(t.id),projectId:this.store.binding(t.id)??this.store.projects().find(p=>p.path===t.cwd)?.id??null});
    const visible=t=>!query.projectId||query.projectId==='all'||t.projectId===query.projectId;
    const pinnedMap=new Map(pinned.data.map(t=>[t.id,t]));for(const t of page.data)if(pins.has(t.id))pinnedMap.set(t.id,t);
    return {...page,data:page.data.filter(t=>!pins.has(t.id)).map(decorate).filter(visible),pinnedData:[...pinnedMap.values()].map(decorate).filter(visible),pinnedLoading:pinned.loading};
  }
  async findPinned(params,pins){
    if(!pins.size)return {data:[],loading:false};
    const key=JSON.stringify([params.archived,params.searchTerm??'',params.sourceKinds,[...pins]]);let scan=this.pinScans.get(key);
    if(!scan||(!scan.promise&&Date.now()-(scan.complete?scan.completedAt:scan.accessed)>30000)){scan={data:new Map(),cursor:null,complete:false,accessed:Date.now(),completedAt:0,promise:null};this.pinScans.set(key,scan);while(this.pinScans.size>4)this.pinScans.delete(this.pinScans.keys().next().value);}
    scan.accessed=Date.now();
    if(!scan.complete&&!scan.promise){scan.promise=(async()=>{const started=Date.now();for(let i=0;i<4&&!scan.complete;i++){
      const page=await this.supported('thread/list',{...params,limit:100,useStateDbOnly:true,...(scan.cursor?{cursor:scan.cursor}:{})});
      for(const thread of page.data)if(pins.has(thread.id))scan.data.set(thread.id,thread);
      scan.cursor=page.nextCursor;scan.complete=!page.nextCursor||scan.data.size===pins.size;scan.accessed=Date.now();if(scan.complete)scan.completedAt=Date.now();if(Date.now()-started>250)break;
    }})().finally(()=>{scan.promise=null;});}
    if(scan.promise)await scan.promise;return {data:[...scan.data.values()],loading:!scan.complete};
  }
  async history(threadId, cursor) {
    const native = await this.thread(threadId);
    const page = await this.supported('thread/turns/list', { threadId, limit: 12, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    return { thread: native, turns: page.data, nextCursor: page.nextCursor, projectId: this.store.binding(threadId) ?? this.store.projects().find(p => p.path === native.cwd)?.id ?? null,
      activeTurn: this.active.get(threadId)?.turnId ?? null,
      pending: [...this.pending.values()].filter(r => r.params.threadId === threadId).map(r => ({ ...r, id: r.key })) };
  }
  hasJob(threadId) { return this.store.jobs().some(j => j.thread === threadId && ['queued','starting','running','uncertain'].includes(j.status)); }
  async bind(threadId, projectId) {
    check(!this.threadMutations.has(threadId) && !this.hasJob(threadId), '请先处理此会话的运行、排队或待确认任务再绑定项目',409);
    this.threadMutations.add(threadId);
    try { const native = await this.thread(threadId); check(native.status?.type !== 'active','请先停止正在运行的任务',409); await this.files.resolve(projectId); this.store.bind(threadId, projectId); this.loaded.delete(threadId); return { ok: true }; }
    finally { this.threadMutations.delete(threadId); }
  }
  async resolveProject(threadId, projectId) {
    const bound = this.store.binding(threadId);
    const native = await this.thread(threadId);
    const project = this.files.project(bound ?? projectId ?? this.store.projects().find(p => p.path === native.cwd)?.id);
    if (!bound) {
      let original; try { original = await realpath(native.cwd); } catch {}
      check(original === project.path, '会话原项目路径不可用，请先绑定到服务器项目', 409);
      this.store.bind(threadId, project.id);
    }
    await this.files.resolve(project.id); return project;
  }
  async ensureThread(threadId, project) {
    if (!this.loaded.has(threadId)) {
      const epoch = this.epoch;
      const result = await this.supported('thread/resume', { threadId, cwd: project.path, runtimeWorkspaceRoots: [project.path], excludeTurns: true });
      check(epoch === this.epoch, '恢复会话期间引擎连接变化，请重新核对状态',503);
      this.loaded.set(threadId, { time: Date.now(), projectId: project.id, model: result.model });
    } else this.loaded.get(threadId).time = Date.now();
  }
  async create(input) {
    const project = this.files.project(input.projectId); await this.files.resolve(project.id);
    const capabilities = await this.capabilities();
    if (input.model) check(capabilities.models.some(m => m.model === input.model), '模型不可用');
    const params = { cwd: project.path, approvalPolicy: 'on-request' };
    if (input.permissions) { check(capabilities.permissions.some(p => p.id === input.permissions && p.allowed), '权限配置不可用'); params.permissions = input.permissions; }
    else params.sandbox = input.sandbox === 'read-only' ? 'read-only' : 'workspace-write';
    if (input.model) params.model = input.model;
    const result = await this.supported('thread/start', params);
    this.store.bind(result.thread.id, project.id); this.loaded.set(result.thread.id, { time: Date.now(), projectId: project.id, model: result.model });
    this.events.push('threads/changed', {}); return result;
  }
  async action(threadId, input) {
    const native = await this.thread(threadId);
    const busy = this.active.has(threadId) || native.status?.type === 'active' || this.hasJob(threadId) || this.threadMutations.has(threadId);
    if (input.action === 'pin') { this.store.pin(threadId, !!input.pinned); this.pinScans.clear();return { pinned: !!input.pinned }; }
    if (input.action === 'rename') {const result=await this.supported('thread/name/set', { threadId, name: text(input.name,200) });this.pinScans.clear();return result;}
    if (input.action === 'archive' || input.action === 'unarchive') { check(!busy, '请先停止正在运行的任务',409); const result=await this.supported(`thread/${input.action}`, { threadId });this.pinScans.clear();return result; }
    if (input.action === 'fork') {
      check(!busy, '请等待当前任务完成后分叉',409);
      const project = await this.resolveProject(threadId, input.projectId);
      const result = await this.supported('thread/fork', { threadId, cwd: project.path, excludeTurns: true, ...(input.lastTurnId ? { lastTurnId: text(input.lastTurnId,200) } : {}) });
      this.store.bind(result.thread.id, project.id); return result;
    }
    if (input.action === 'compact') { check(!busy, '请等待当前任务完成后压缩上下文',409); const project = await this.resolveProject(threadId); await this.ensureThread(threadId,project); return this.supported('thread/compact/start', { threadId }); }
    throw fail(400,'不支持这个会话操作');
  }
  async turnParams(threadId, project, input) {
    const capability = await this.capabilities(), parts = [];
    text(input.text ?? '', 40000);
    if (input.text?.trim()) parts.push({ type: 'text', text: input.text });
    for (const attachment of (input.attachments ?? []).slice(0,8)) {
      const absolute = await this.files.resolve(project.id, text(attachment.path,4096));
      check(attachment.path.startsWith('.codex-web-uploads/'), '附件必须先上传到项目中');
      if (attachment.image) parts.push({ type: 'localImage', path: absolute });
      else parts.push({ type: 'text', text: `附件文件：${absolute}` });
    }
    for (const relative of (input.references ?? []).slice(0,20)) parts.push({ type: 'text', text: `引用项目文件：${await this.files.resolve(project.id, text(relative,4096))}` });
    if (input.skill) {
      const list = await this.supported('skills/list', { cwds: [project.path] });
      const skills = list.data.flatMap(entry => entry.skills ?? []), skill = skills.find(s => s.path === input.skill);
      check(skill, '技能不可用'); parts.push({ type: 'skill', name: skill.name, path: skill.path });
    }
    check(parts.length, '请输入任务或添加附件');
    const params = { threadId, cwd: project.path, input: parts, clientUserMessageId: input.requestId };
    if (input.model) { check(capability.models.some(m => m.model === input.model), '模型不可用'); params.model = input.model; }
    const model = capability.models.find(m => m.model === (input.model || this.loaded.get(threadId)?.model)) ?? capability.models.find(m => m.isDefault) ?? capability.models[0];
    if (input.effort) { check(model?.supportedReasoningEfforts.some(e => e.reasoningEffort === input.effort), '该模型不支持所选推理强度'); params.effort = input.effort; }
    if (input.permissions) { check(capability.permissions.some(p => p.id === input.permissions && p.allowed), '权限配置不可用'); params.permissions = input.permissions; }
    if (input.mode) {
      const preset = capability.modes.find(m => m.mode === input.mode); check(preset && model, '当前引擎不支持所选模式');
      params.collaborationMode = { mode: preset.mode, settings: { model: model.model, reasoning_effort: input.effort || preset.reasoning_effort || model.defaultReasoningEffort, developer_instructions: null } };
    }
    return params;
  }
  async enqueue(threadId, input) {
    check(typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId), '缺少有效的消息请求标识');
    const pending = this.enqueues.get(input.requestId);
    if (pending) { check(pending.threadId === threadId && pending.payload === JSON.stringify(input), '请求标识已用于其他消息',409); return pending.promise; }
    check(!this.threadMutations.has(threadId), '此会话正在处理另一项请求，请稍后重试',409);
    this.threadMutations.add(threadId);
    const promise = this.persistJob(threadId,input).finally(() => { this.threadMutations.delete(threadId); this.enqueues.delete(input.requestId); });
    this.enqueues.set(input.requestId,{threadId,payload:JSON.stringify(input),promise}); return promise;
  }
  async persistJob(threadId, input) {
    const old = this.store.submission(input.requestId);
    if (old) { check(old.thread === threadId && JSON.stringify(old.payload) === JSON.stringify(input), '请求标识已用于其他消息', 409); return old; }
    const project = await this.resolveProject(threadId, input.projectId);
    const native = await this.thread(threadId); check(native.status?.type !== 'active', '此会话正在其他客户端运行，请先在那里停止或完成任务', 409);
    check(!this.active.has(threadId) && !this.store.jobs().some(j => j.thread === threadId && ['queued','starting','running','uncertain'].includes(j.status)), '此会话已有任务，运行中请使用追加指令',409);
    await this.turnParams(threadId, project, input); // The reservation spans all asynchronous validation.
    check(this.store.jobs().length < 100, '任务队列已满，请先处理已有任务',409);
    check(!this.hasJob(threadId), '此会话已有任务，运行中请使用追加指令',409);
    check(this.store.binding(threadId) === project.id, '会话项目绑定已变化，请重新提交',409);
    const job = { id: input.requestId, thread: threadId, project: project.id, payload: input, created: Date.now() };
    this.store.enqueue(job); this.events.push('queue/changed', { jobs: this.store.jobs() }); this.drain();
    return this.store.submission(job.id);
  }
  async drain() {
    if (this.maintenance || this.closing || this.draining || this.active.size || this.store.jobs().some(j => j.status === 'uncertain')) return;
    this.draining = true;
    try {
      const summary = this.store.jobs().find(j => j.status === 'queued'); if (!summary) return;
      const job = this.store.submission(summary.id), project = this.files.project(job.project);
      this.store.updateJob(job.id,'starting');
      let sent = false;
      try {
        check(this.store.binding(job.thread) === job.project, '排队任务的项目绑定已变化，任务未启动',409);
        await this.files.resolve(project.id);
        await this.connect(); await this.ensureThread(job.thread,project);
        const params = await this.turnParams(job.thread,project,job.payload);
        this.active.set(job.thread,{ jobId: job.id, turnId: null });
        sent = true;
        const result = job.payload.review
          ? await this.rpc.call('review/start', { threadId: job.thread, delivery: 'inline', target: { type: 'uncommittedChanges' } })
          : await this.rpc.call('turn/start', params);
        if(this.closing)return;
        if (this.completed.get(job.thread) === result.turn.id || result.turn.status !== 'inProgress') { this.active.delete(job.thread); this.store.updateJob(job.id,'completed',{ turnId: result.turn.id }); }
        else { this.active.set(job.thread,{ jobId: job.id, turnId: result.turn.id }); this.store.updateJob(job.id,'running',{ turnId: result.turn.id }); }
      } catch (error) { if(this.closing)return;this.active.delete(job.thread); this.store.updateJob(job.id, sent ? 'uncertain' : 'failed', { error: error.message }); this.events.push('job/error',{ id: job.id, message: error.message },job.thread); }
      this.events.push('queue/changed',{ jobs: this.store.jobs() });
    } finally { this.draining = false; if (!this.maintenance && !this.closing && !this.active.size && !this.store.jobs().some(j => j.status === 'uncertain') && this.store.jobs().some(j => j.status === 'queued')) setImmediate(() => this.drain()); }
  }
  async reconcile() {
    if(this.reconciling)return this.reconciling;
    this.reconciling=this.reconcileJobs().finally(()=>{this.reconciling=null;});return this.reconciling;
  }
  async reconcileJobs() {
    const epoch=this.epoch;
    for (const job of this.store.jobs().filter(j => j.status === 'uncertain')) {
      if (!job.result?.turnId) continue;
      const native = await this.thread(job.thread);
      if(this.closing||epoch!==this.epoch)break;
      if(this.store.submission(job.id)?.status!=='uncertain')continue;
      if (native.status?.type !== 'active') this.store.updateJob(job.id,'interrupted',{ ...job.result, error: '连接中断后引擎未报告任务仍在运行；请检查历史后决定下一步' });
      else {
        const page=await this.supported('thread/turns/list',{threadId:job.thread,limit:1,sortDirection:'desc',itemsView:'none'});
        if(this.closing||epoch!==this.epoch)break;
        if(this.store.submission(job.id)?.status!=='uncertain'||this.completed.get(job.thread)===job.result.turnId)continue;
        if(page.data[0]?.id===job.result.turnId&&page.data[0]?.status==='inProgress'){
          this.active.set(job.thread,{jobId:job.id,turnId:job.result.turnId});this.store.updateJob(job.id,'running',job.result);
          try { await this.ensureThread(job.thread,this.files.project(job.project)); }
          catch (error) { if(!this.closing&&this.active.get(job.thread)?.jobId===job.id){this.active.delete(job.thread);this.store.updateJob(job.id,'uncertain',{...job.result,error:error.message});} }
        }
      }
    }
    if(this.closing)return [];this.events.push('queue/changed',{ jobs: this.store.jobs() }); return this.store.jobs();
  }
  async jobAction(jobId, action) {
    const job = this.store.submission(jobId); check(job, '任务不存在',404);
    if (action === 'cancel') {
        check(['queued','running','uncertain','interrupted'].includes(job.status),'任务状态不可取消',409);
        if (['running','uncertain'].includes(job.status)) {
          const native = await this.thread(job.thread);
          if (native.status?.type === 'active') {
            const turnId=job.result?.turnId??(this.active.get(job.thread)?.jobId===job.id?this.active.get(job.thread)?.turnId:null);
            check(turnId, '无法确认该记录对应的原生任务，请检查历史与当前会话后处理',409);
            const page=await this.supported('thread/turns/list',{threadId:job.thread,limit:1,sortDirection:'desc',itemsView:'none'});
            check(page.data.length,'无法确认原生任务状态，请稍后刷新',409);
            if(page.data[0].id===turnId&&page.data[0].status==='inProgress'){
              await this.supported('turn/interrupt',{threadId:job.thread,turnId});
              const after=await this.supported('thread/turns/list',{threadId:job.thread,limit:1,sortDirection:'desc',itemsView:'none'});
              check(after.data.length&&!after.data.some(t=>t.id===turnId&&t.status==='inProgress'), '已请求停止，正在等待引擎确认；队列保持阻塞',409);
            }
          }
        }
        if(this.active.get(job.thread)?.jobId===job.id)this.active.delete(job.thread);
        this.store.updateJob(jobId,'cancelled',job.result);
    } else if (action === 'acknowledge') { check(['uncertain','interrupted'].includes(job.status),'任务状态不匹配',409); const native = await this.thread(job.thread); check(native.status?.type !== 'active', '引擎仍报告任务正在运行，请先停止',409); this.store.updateJob(jobId,'acknowledged',job.result); }
    else throw fail(400,'不支持这个任务操作');
    this.events.push('queue/changed',{ jobs: this.store.jobs() }); this.drain(); return {};
  }
  async steer(threadId, input) {
    const active = this.active.get(threadId); check(active?.turnId, '当前没有可追加指令的任务',409);
    const project = await this.resolveProject(threadId); const params = await this.turnParams(threadId,project,input);
    return this.supported('turn/steer', { threadId, expectedTurnId: active.turnId, input: params.input });
  }
  async stop(threadId) {
    let active = this.active.get(threadId);
    if (!active?.turnId) { const page = await this.supported('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'none' }); const turn = page.data.find(t => t.status === 'inProgress'); if (turn) active = { turnId: turn.id }; }
    check(active?.turnId, '当前没有可停止的任务',409); return this.supported('turn/interrupt',{ threadId, turnId: active.turnId });
  }
  notification({ method, params = {} }) {
    if(this.closing)return;
    if(method.startsWith('account/'))this.cache=null;
    if(['thread/archived','thread/unarchived','thread/name/updated','thread/closed'].includes(method))this.pinScans.clear();
    const threadId = params.threadId ?? params.thread?.id ?? null;
    if (method === 'turn/started') {
      const active = this.active.get(threadId); if (active) active.turnId = params.turn.id;
    }
    if (method === 'turn/completed') {
      this.completed.set(threadId,params.turn.id);
      if(this.completed.size>2000)this.completed.delete(this.completed.keys().next().value);
      const active = this.active.get(threadId), matching=active&&(!active.turnId||active.turnId===params.turn.id)?active:null;
      const recovering = !matching && this.store.jobs().find(j=>j.thread===threadId&&j.status==='uncertain'&&j.result?.turnId===params.turn.id);
      if (matching || recovering) this.store.updateJob(matching?.jobId??recovering.id, params.turn.status === 'completed' ? 'completed' : 'interrupted', { turnId: params.turn.id, error: params.turn.error?.message });
      if(matching)this.active.delete(threadId);
      for (const [key, request] of this.pending) if (request.params.turnId === params.turn.id) this.pending.delete(key);
      this.events.push('queue/changed',{ jobs: this.store.jobs() }); setImmediate(() => this.drain());
    }
    if (method === 'serverRequest/resolved') for (const [key,request] of this.pending) if (request.originalId === params.requestId) this.pending.delete(key);
    if (method === 'command/exec/outputDelta') {
      const terminal = this.terminals.get(params.processId);
      if (terminal) { const delta = this.decoders.get(terminal.id).write(Buffer.from(params.deltaBase64 ?? '', 'base64')); terminal.version++; terminal.output = (terminal.output + delta).slice(-256000); this.events.push('terminal/output',{ id: terminal.id, delta, version: terminal.version },null); }
    }
    if (!/reasoning\/textDelta/.test(method)) this.events.push(method, redact(params), threadId);
  }
  request(message) {
    const known = ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request'];
    if (!known.includes(message.method)) { this.rpc.reject(message.id); this.events.push('unsupported/request',{ method: message.method, message: '当前网页没有注册此类交互，已拒绝执行' },message.params?.threadId); return; }
    const key = `${this.epoch}:${message.id}`;
    const params=redact(message.params);
    if(message.method==='mcpServer/elicitation/request'&&message.params.requestedSchema)params.requestedSchema=formSchema(message.params.requestedSchema);
    const request = { key, originalId: message.id, method: message.method, params };
    this.pending.set(key,request); this.events.push('approval/request',{ ...request, id: key },message.params.threadId);
  }
  async answer(key, input) {
    const request = this.pending.get(key); check(request, '请求已处理或连接已变化，请刷新',409);
    const { params, method } = request; let result;
    if (method === 'item/tool/requestUserInput') {
      const answers = Object.create(null);
      for (const q of params.questions) { const value = input.answers?.[q.id]; check(typeof value === 'string' && value.trim() && value.length <= 10000, '请回答全部问题'); answers[q.id] = { answers: [value] }; }
      result = { answers };
    } else if (method === 'mcpServer/elicitation/request') {
      check(['accept','decline','cancel'].includes(input.action), '请选择操作');
      result = { action: input.action, content: input.action === 'accept' ? (input.content ?? {}) : null };
      if (input.action === 'accept' && params.mode !== 'url') validateForm(params.requestedSchema ?? {}, result.content);
      if (params.mode === 'url' && input.action === 'accept') result.content = null;
    } else if (method === 'item/permissions/requestApproval') {
      check(['accept','decline'].includes(input.decision),'请选择允许或拒绝');
      check(['turn','session'].includes(input.scope ?? 'turn'),'权限范围无效');
      result = { permissions: input.decision === 'accept' ? params.permissions : {}, scope: input.scope ?? 'turn' };
    } else {
      const available = params.availableDecisions ?? ['accept','acceptForSession','decline','cancel'];
      check(available.some(d => JSON.stringify(d) === JSON.stringify(input.decision)), '此审批选项不可用'); result = { decision: input.decision };
    }
    this.rpc.reply(request.originalId,result); this.pending.delete(key); this.events.push('approval/resolved',{ id: key },params.threadId); return {};
  }
  async extensions(projectId, catalog = false) {
    const project = this.files.project(projectId);
    const [skills, plugins, mcp] = await Promise.all([
      this.optional('skills/list',{ cwds: [project.path], forceReload: false },{ data: [] }),
      this.optional(catalog ? 'plugin/list' : 'plugin/installed',{ cwds: [project.path], ...(catalog ? { forceRefetch: false } : {}) },{ plugins: [] }),
      this.optional('mcpServerStatus/list',{ limit: 100 },{ data: [] }),
    ]); return redact({ skills, plugins, mcp });
  }
  async extensionAction(projectId, input) {
    const project = this.files.project(projectId);
    if (input.action === 'skill') {
      const list = await this.supported('skills/list',{ cwds: [project.path] }); check(list.data.flatMap(e => e.skills ?? []).some(s => s.path === input.path),'技能不存在');
      return this.supported('skills/config/write',{ path: input.path, enabled: !!input.enabled });
    }
    if (input.action === 'plugin-install') {
      const catalog = await this.supported('plugin/list',{ cwds:[project.path], forceRefetch:false });
      const matches = catalog.marketplaces.flatMap(m => (m.plugins ?? []).map(p => ({ m,p }))).filter(({p}) => p.name === input.name);
      const found = matches.find(({m}) => (m.path ?? null) === (input.marketplacePath ?? null) && (m.name ?? null) === (input.remoteMarketplaceName ?? null)) ?? (matches.length === 1 ? matches[0] : null);
      check(found,'插件不在当前目录中');
      return this.supported('plugin/install',{ pluginName: found.p.name, ...(found.m.path ? { marketplacePath: found.m.path } : { remoteMarketplaceName: found.m.name }), installAttemptId: id() });
    }
    if (input.action === 'plugin-uninstall') return this.supported('plugin/uninstall',{ pluginId: text(input.pluginId,500) });
    if (input.action === 'mcp-reload') return this.supported('config/mcpServer/reload',{});
    if (input.action === 'mcp-login') return this.supported('mcpServer/oauth/login',{ name: text(input.name,200) });
    throw fail(400,'不支持这个扩展操作');
  }
  async terminalCreate(projectId, cols = 100, rows = 24) {
    const running = [...this.terminals.values()].filter(t => ['running','starting'].includes(t.status)); check(running.length < 2,'最多同时运行两个终端',409);
    const terminal = { id: id(), projectId, status: 'starting', output: '', version: 0 }; this.terminals.set(terminal.id,terminal);
    let project;
    try { project = this.files.project(projectId); await this.files.resolve(projectId); await this.connect(); }
    catch (error) { this.terminals.delete(terminal.id); throw error; }
    this.decoders.set(terminal.id,new StringDecoder('utf8'));
    const command = process.platform === 'win32' ? ['powershell.exe','-NoProfile'] : ['/bin/bash','--noprofile','--norc'];
    this.rpc.call('command/exec',{ command, cwd: project.path, tty: true, processId: terminal.id, size: { cols: Math.max(20,Math.min(300,cols)), rows: Math.max(5,Math.min(100,rows)) }, disableTimeout: true, env: { TERM:'xterm-256color' }, outputBytesCap: 256000 },0)
      .then(result => { terminal.status = 'exited'; this.events.push('terminal/exited',{ id: terminal.id, exitCode: result.exitCode }); })
      .catch(error => { terminal.status = 'failed'; terminal.output += `\r\n${error.message}`; this.events.push('terminal/exited',{ id:terminal.id, error:error.message }); });
    terminal.status = 'running';
    for (const [key,t] of this.terminals) if (!['running','starting'].includes(t.status) && this.terminals.size > 10) { this.terminals.delete(key); this.decoders.delete(key); }
    return terminal;
  }
  async terminalAction(terminalId, input) {
    const terminal = this.terminals.get(terminalId); check(terminal && terminal.status === 'running','终端未运行',409);
    if (input.action === 'input') return this.supported('command/exec/write',{ processId: terminalId, deltaBase64: Buffer.from(text(input.data,32768)).toString('base64') });
    if (input.action === 'resize') return this.supported('command/exec/resize',{ processId:terminalId, size:{ cols:Math.max(20,Math.min(300,Number(input.cols)||80)), rows:Math.max(5,Math.min(100,Number(input.rows)||24)) } });
    if (input.action === 'kill') return this.supported('command/exec/terminate',{ processId:terminalId });
    throw fail(400,'终端操作无效');
  }
  async releaseIdle() {
    for (const [threadId, loaded] of this.loaded) if (Date.now() - loaded.time > 300000 && !this.active.has(threadId) && ![...this.pending.values()].some(r => r.params.threadId === threadId)) {
      try { await this.supported('thread/unsubscribe',{ threadId }); this.loaded.delete(threadId); } catch {}
    }
  }
  close() { this.closing = true; clearInterval(this.idleTimer); this.rpc.close(); }
}
