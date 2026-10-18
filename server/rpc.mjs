import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
import { fail } from './util.mjs';
import {version} from './release.mjs';
export class Rpc extends EventEmitter {
  constructor(config) { super(); this.config = config; this.pending = new Map(); this.next = 1; this.ready = false; this.connecting = null; this.transport = null; }
  async connect() {
    if (this.ready) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async open() {
    this.ending = false;
    let transport;
    try {
    if (this.config.socket) {
      const socket = this.config.socket;
      const ws = new WebSocket('ws://localhost/', { createConnection: () => net.connect(socket), perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10000 });
      this.transport = transport = ws;
      ws.on('message', data => { if(this.transport===ws)this.receive(data.toString()); }); ws.on('close', () => this.lost(ws)); ws.on('error', () => this.lost(ws));
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      this.write = message => ws.send(JSON.stringify(message));
    } else {
      const child = spawn(this.config.codexBinary, ['app-server', '--listen', 'stdio://'], { cwd: this.config.cwd, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: this.config.codexHome ? { ...process.env, CODEX_HOME: this.config.codexHome } : process.env });
      this.transport = transport = child;
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => this.lost(child)); child.on('error', () => this.lost(child)); child.on('exit', () => this.lost(child));
      createInterface({ input: child.stdout }).on('line', line => { if(this.transport===child)this.receive(line); });
      this.write = message => child.stdin.write(JSON.stringify(message) + '\n');
    }
    this.info = await this.call('initialize', { clientInfo: { name: 'codex_workbench', title: 'Codex Web Workbench', version }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } }, 20000);
    this.write({ method: 'initialized', params: {} }); this.ready = true;
    this.emit('ready'); return this;
    } catch (error) {
      this.lost(transport); transport?.kill?.(); transport?.terminate?.();
      if(this.transport===transport){this.transport=null;this.write=undefined;}
      throw error;
    }
  }
  receive(line) {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.method) { this.emit(message.id === undefined ? 'notification' : 'request', message); return; }
    const waiter = this.pending.get(message.id); if (!waiter) return;
    clearTimeout(waiter.timer); this.pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(fail(502, message.error.message), { code: message.error.code })); else waiter.resolve(message.result);
  }
  call(method, params = {}, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = this.next++, timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(fail(504, `${method} 请求结果未确认，请刷新状态；不要重复提交。`)); }, timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reply(id, result) { this.write({ id, result }); }
  reject(id) { this.write({ id, error: { code: -32601, message: 'Web workbench does not implement this request' } }); }
  lost(source = this.transport) {
    if (source !== this.transport || this.ending) return; this.ending = true; this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(fail(503, 'Codex 连接中断，任务状态需要重新确认')); }
    this.pending.clear(); this.emit('lost');
  }
  close() { this.lost(); this.transport?.kill?.(); this.transport?.close?.(); }
}
export async function protocolMethods(path) {
  const schema = JSON.parse(await readFile(path, 'utf8'));
  return schema.oneOf.flatMap(v => v.properties?.method?.enum ?? []);
}
