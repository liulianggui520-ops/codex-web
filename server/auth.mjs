import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, fail, check } from './util.mjs';
const derive = promisify(scrypt);
export async function passwordHash(password) {
  check(typeof password === 'string' && password.length >= 16 && password.length <= 256, '口令应为 16 至 256 个字符');
  const salt = randomBytes(16).toString('hex');
  return { salt, digest: (await derive(password, salt, 32)).toString('hex') };
}
export class Auth {
  constructor(store, origin) { this.store = store; this.origin = new URL(origin); this.attempts = new Map(); }
  originCheck(req) {
    check(req.headers.host === this.origin.host, '访问主机不匹配', 403);
    if (req.method !== 'GET' || req.headers.upgrade) check(req.headers.origin === this.origin.origin, '请求来源不匹配', 403);
  }
  session(req) {
    const token = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('codex_session='))?.slice(14);
    const row = token && this.store.db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(hash(token), Date.now());
    if (!row) throw fail(401, '请先登录');
    if (req.method !== 'GET') check(req.headers['x-csrf-token'] === row.csrf, '会话验证失败，请重新登录', 403);
    return row;
  }
  async login(req, res, input) {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (now > value.until) this.attempts.delete(key);
    const ip = req.socket.remoteAddress;
    for (const [key, max] of [[ip, 10], ['global', 40]]) {
      const value = this.attempts.get(key) ?? { count: 0, until: now + 600000 };
      check(++value.count <= max, '登录尝试过多，请十分钟后重试', 429); this.attempts.set(key, value);
    }
    const credential = this.store.get('credential');
    check(credential, '请先在服务器运行口令设置命令', 503);
    check(typeof input.password === 'string' && input.password.length <= 256, '口令不正确', 401);
    const actual = await derive(input.password, credential.salt, 32);
    check(timingSafeEqual(actual, Buffer.from(credential.digest, 'hex')), '口令不正确', 401);
    this.store.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    check(this.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n < 30, '登录设备过多，请先退出其他设备', 429);
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
    this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), csrf, now + 7 * 86400000);
    this.attempts.delete(ip);
    res.setHeader('Set-Cookie', this.cookie(token, 7 * 86400));
    return { csrf };
  }
  cookie(token, age) { return `codex_session=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${this.origin.protocol === 'https:' ? '; Secure' : ''}`; }
  logout(req, res) { const session = this.session(req); this.store.db.prepare('DELETE FROM sessions WHERE token=?').run(session.token); res.setHeader('Set-Cookie', this.cookie('', 0)); }
}
