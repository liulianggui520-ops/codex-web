import { realpath, stat, opendir, open, mkdir, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import Busboy from 'busboy';
import { check, fail, hash, id, text } from './util.mjs';
const skip = new Set(['.git','node_modules','.pnpm','.codex-web-uploads','.codex-worktrees','dist','build','.next']);
export function inside(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
const imageType = name => ({ '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp' }[path.extname(name).toLowerCase()]);
async function readBounded(handle, limit) { const bytes=Buffer.alloc(limit+1);let count=0;while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}check(count<=limit,'文件超过读取上限',413);return bytes.subarray(0,count); }
export class Files {
  constructor(store, roots) { this.store = store; this.roots = roots; this.saves = new Set(); }
  project(id) { const project = this.store.project(id); check(project, '项目不存在', 404); return project; }
  async register(directory, name) {
    const root = await realpath(text(directory, 4096));
    check((await stat(root)).isDirectory(), '项目必须是目录');
    const allowed = await Promise.all(this.roots.map(r => realpath(r)));
    check(allowed.some(r => inside(r, root)), '项目不在允许的工作目录内', 403);
    const old = this.store.projects().find(p => p.path === root); if (old) return old;
    return this.store.addProject({ id: id(), name: text(name || path.basename(root), 100), path: root });
  }
  async directories(directory=this.roots[0],query='') {
    const allowed=await Promise.all(this.roots.map(r=>realpath(r))),candidate=path.resolve(text(directory,4096));
    check(allowed.some(root=>inside(root,candidate))||this.roots.some(root=>inside(path.resolve(root),candidate)),'目录不在允许的工作目录内',403);
    const canonical=await realpath(candidate);check(allowed.some(root=>inside(root,canonical)),'符号链接指向工作目录外',403);
    check((await stat(canonical)).isDirectory(),'请选择服务器目录');
    const search=text(query,100).toLocaleLowerCase(),entries=[];let scanned=0,truncated=false;
    for await(const entry of await opendir(canonical)){
      if(++scanned>5000){truncated=true;break;}
      if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name==='.git'||entry.name==='node_modules'||!entry.name.toLocaleLowerCase().includes(search))continue;
      if(entries.length===200){truncated=true;break;}entries.push({name:entry.name,path:path.join(canonical,entry.name)});
    }
    entries.sort((a,b)=>a.name.localeCompare(b.name));const parent=path.dirname(canonical);
    return {directory:canonical,parent:parent!==canonical&&allowed.some(root=>inside(root,parent))?parent:null,roots:allowed,entries,truncated};
  }
  async resolve(projectId, relative = '', create = false) {
    const project = this.project(projectId), root = await realpath(project.path);
    check(root === project.path, '项目根目录已被替换，请重新注册项目',403);
    const allowed = await Promise.all(this.roots.map(r => realpath(r)));
    check(allowed.some(r => inside(r,root)), '项目已不在允许的工作目录内',403);
    text(relative, 4096); check(!relative.includes('\0') && !path.isAbsolute(relative), '必须使用项目内的相对路径');
    const candidate = path.resolve(root, relative); check(inside(root, candidate), '不能访问项目外的文件', 403);
    let canonical;
    try { canonical = await realpath(candidate); }
    catch (error) { if (!create || error.code !== 'ENOENT') throw error;let ancestor=path.dirname(candidate),suffix=path.basename(candidate);while(true){try{canonical=path.join(await realpath(ancestor),suffix);break;}catch(inner){if(inner.code!=='ENOENT'||ancestor===path.dirname(ancestor))throw inner;suffix=path.join(path.basename(ancestor),suffix);ancestor=path.dirname(ancestor);}} }
    check(inside(root, canonical), '符号链接指向项目外，无法访问', 403);
    return canonical;
  }
  async list(projectId, relative = '') {
    const directory = await this.resolve(projectId, relative);
    const entries=[];for await(const entry of await opendir(directory)){if(!skip.has(entry.name))entries.push(entry);if(entries.length>1000)break;}
    const visible = entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { entries: visible.slice(0, 1000).map(e => ({ name: e.name, path: path.posix.join(relative.replaceAll('\\','/'), e.name), directory: e.isDirectory(), symlink: e.isSymbolicLink() })), truncated: visible.length > 1000 };
  }
  async read(projectId, relative) {
    const file = await this.resolve(projectId, relative), info = await stat(file);
    check(info.isFile(), '只能打开文件');
    const mime = imageType(file);
    if (mime) return { path: relative, image: true, mime, size: info.size };
    check(info.size <= 2 * 1024 * 1024, '文件超过 2MB，请下载后查看', 413);
    const handle=await open(file,'r');let buffer;try{buffer=await readBounded(handle,2*1024*1024);}finally{await handle.close();}check(!buffer.includes(0), '二进制文件请下载后查看');
    return { path: relative, text: buffer.toString('utf8'), etag: hash(buffer), size: info.size };
  }
  async save(projectId, relative, content, etag) {
    text(content, 2 * 1024 * 1024);
    const target = await this.resolve(projectId, relative, true);
    check(!this.saves.has(target), '该文件正在保存，请重试', 409); this.saves.add(target);
    const temp = path.join(path.dirname(target), `.codex-save-${id()}`);
    try {
      let original, mode, identity;
      try { const handle = await open(target, 'r'); try { const metadata = await handle.stat(); check(metadata.isFile(), '只能保存普通文件'); check(metadata.size <= 2 * 1024 * 1024, '文件过大', 413); original = await readBounded(handle,2*1024*1024); mode = metadata.mode; identity = `${metadata.dev}:${metadata.ino}:${metadata.mtimeMs}:${metadata.ctimeMs}`; } finally { await handle.close(); } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const currentTag = original ? hash(original) : null;
      if (currentTag !== (etag ?? null)) throw fail(409, '文件已被其他程序修改，请比较后重新加载', { etag: currentTag, text: original?.toString('utf8') });
      const handle = await open(temp, 'wx', mode ?? 0o644);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      // Re-resolve after writing the temporary file to catch directory/symlink replacement.
      check(await this.resolve(projectId, relative, true) === target, '文件路径已变化，请重新加载', 409);
      let latest, latestIdentity;
      try { const handle = await open(target,'r'); try { const metadata = await handle.stat(); check(metadata.isFile() && metadata.size <= 2 * 1024 * 1024,'文件已变化，请重新加载',409); latest = await readBounded(handle,2*1024*1024); latestIdentity = `${metadata.dev}:${metadata.ino}:${metadata.mtimeMs}:${metadata.ctimeMs}`; } finally { await handle.close(); } }
      catch(error) { if(error.code !== 'ENOENT') throw error; }
      if ((latest ? hash(latest) : null) !== currentTag || latestIdentity !== identity) throw fail(409,'保存期间文件被其他程序修改，请比较后重新加载',{etag:latest ? hash(latest) : null,text:latest?.toString('utf8')});
      await rename(temp, target);
      return { etag: hash(Buffer.from(content)) };
    } finally { this.saves.delete(target); await unlink(temp).catch(() => {}); }
  }
  async search(projectId, query, content = false) {
    text(query, 100); if (!query.trim()) return { matches: [], truncated: false };
    const root = await this.resolve(projectId), matches = []; let scanned = 0, truncated = false;
    const walk = async (directory, relative) => {
      for await (const entry of await opendir(directory)) {
        if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
        if (++scanned > 10000 || matches.length >= 100) { truncated = true; return; }
        const name = path.posix.join(relative, entry.name), file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file, name);
        else if (name.toLowerCase().includes(query.toLowerCase())) matches.push({ path: name });
        else if (content && (await stat(file)).size <= 128 * 1024) {
          const handle=await open(file,'r');let bytes;try{bytes=await readBounded(handle,128*1024);}catch(e){if(e.status===413)continue;throw e;}finally{await handle.close();}if (bytes.includes(0)) continue;
          const lines = bytes.toString('utf8').split('\n'); const index = lines.findIndex(line => line.toLowerCase().includes(query.toLowerCase()));
          if (index >= 0) matches.push({ path: name, line: index + 1, preview: lines[index].slice(0,200) });
        }
        if (truncated) return;
      }
    };
    await walk(root, ''); return { matches, truncated };
  }
  async raw(req, res, projectId, relative, download) {
    const file = await this.resolve(projectId, relative), info = await stat(file); check(info.isFile(), '只能下载文件');
    const mime = imageType(file);
    res.writeHead(200, { 'Content-Type': !download && mime ? mime : 'application/octet-stream', 'Content-Length': info.size,
      'Content-Disposition': `${!download && mime ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replaceAll("'",'%27')}` });
    await pipeline(createReadStream(file), res);
  }
  async upload(req, projectId) {
    const root = await this.resolve(projectId);
    const folder = path.join(root, '.codex-web-uploads'); await mkdir(folder, { recursive: true });
    await this.resolve(projectId, '.codex-web-uploads');
    return new Promise((resolve, reject) => {
      let parser, total = 0, finishing = false, failure; const uploads = [], paths = [], tasks = [], streams=new Set();
      const finish = async error => {
        if(error&&!failure){failure=error;req.unpipe(parser);queueMicrotask(()=>{for(const stream of streams)stream.destroy(error);parser?.destroy();req.resume();});}
        if(finishing)return;finishing=true;
        await Promise.allSettled(tasks);
        req.off('aborted',aborted);req.off('error',failed);
        if(failure){await Promise.all(paths.map(p=>unlink(p).catch(()=>{})));reject(failure);}else resolve({files:uploads});
      };
      const failed = error => { void finish(error); },aborted=()=>failed(fail(400,'上传已中断'));
      try { parser = Busboy({ headers: req.headers, limits: { files: 8, fileSize: 20 * 1024 * 1024, fields: 0, parts: 9 } }); } catch { reject(fail(400, '上传格式错误')); return; }
      parser.on('file', (field, stream, info) => {
        if(finishing){stream.resume();return;}streams.add(stream);stream.once('close',()=>streams.delete(stream));
        const name = path.basename(info.filename.replaceAll('\\','/')).replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(-150) || 'file';
        const relative = `.codex-web-uploads/${id()}-${name}`, target = path.join(root, relative); paths.push(target);
        stream.on('limit', () => failed(fail(413, '每个文件最大 20MB')));
        stream.on('data', chunk => { total += chunk.length; if (total > 80 * 1024 * 1024) failed(fail(413, '单次上传最大 80MB')); });
        tasks.push(pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 })).then(() => uploads.push({ name, path: relative, absolutePath: target, image: !!imageType(name) })).catch(failed));
      });
      parser.on('filesLimit', () => failed(fail(413, '单次最多上传 8 个文件'))); parser.on('partsLimit', () => failed(fail(413, '上传项目过多')));parser.on('fieldsLimit',()=>failed(fail(400,'上传只接受文件')));
      parser.on('error', failed); req.on('aborted',aborted);req.on('error',failed);
      parser.on('close', () => { void finish(); });
      req.pipe(parser);
    });
  }
}
