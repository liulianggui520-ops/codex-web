import { randomBytes, createHash } from 'node:crypto';
export const id = () => randomBytes(16).toString('hex');
export const hash = data => createHash('sha256').update(data).digest('hex');
export const fail = (status, message, details) => Object.assign(new Error(message), { status, details });
export function check(condition, message, status = 400) { if (!condition) throw fail(status, message); }
export function text(value, max = 20000) { check(typeof value === 'string' && value.length <= max, '文字格式或长度不正确'); return value; }
export function compactError(error) { return { message: error.message, code: error.code ?? null }; }
export async function jsonBody(req, limit = 128 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, '请求内容过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail(400, 'JSON 格式错误'); }
}
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(accessToken|refreshToken|idToken|apiKey|authorization|env|headers|bearerToken|clientSecret)$/i.test(key)).map(([key, v]) => [key, redact(v)]));
}
// Schema property names describe inputs; they are not stored credentials.
export function formSchema(value,depth=0,propertyMap=false) {
  check(depth<=30,'工具表单结构过深',400);
  if(Array.isArray(value))return value.map(v=>formSchema(v,depth+1));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>propertyMap||!['default','examples'].includes(key)).map(([key,v])=>[key,formSchema(v,depth+1,!propertyMap&&['properties','patternProperties','$defs','definitions','dependentSchemas'].includes(key))]));
}
export const safeURL = value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
