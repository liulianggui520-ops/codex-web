import {mkdir,mkdtemp,writeFile,readFile,rm,rename,symlink,readlink,chmod,readdir,cp,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {join,resolve} from 'node:path';
import * as tar from 'tar';
import {verifyRelease} from './release.mjs';
export const REPOSITORY='liulianggui520-ops/codex-web';
export function newer(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);return x.some((n,i)=>n!==y[i]&&x.slice(0,i).every((v,j)=>v===y[j])&&n>y[i]);}
export async function githubFetch(address,limit,{binary=false,timeout=20000}={}){
  const signal=AbortSignal.timeout(timeout);
  for(let i=0;i<6;i++){
    const url=new URL(address);if(url.protocol!=='https:'||url.username||url.password||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(url.hostname)||url.port)throw Error('不允许的下载地址');
    const response=await fetch(url,{redirect:'manual',signal,headers:{Accept:'application/vnd.github+json','User-Agent':'codex-workbench-updater'}});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();address=new URL(response.headers.get('location'),url).href;continue;}
    if(!response.ok){await response.body?.cancel();throw Error(`GitHub 请求失败 (${response.status})`);}
    if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('下载文件超出大小限制');}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('下载文件超出大小限制');chunks.push(chunk);}const buffer=Buffer.concat(chunks);return binary?buffer:buffer.toString('utf8');
  }throw Error('下载重定向过多');
}
export function parseRelease(data,current){
  if(data.draft||data.prerelease||!/^v2\.\d+\.\d+$/.test(data.tag_name))throw Error('最新发布不是受支持的稳定版本');
  const version=data.tag_name.slice(1),name=`codex-workbench-${version}.tar.gz`,url=`https://github.com/${REPOSITORY}/releases/download/${data.tag_name}/`;
  const assets=[name,name+'.sha256'].map(n=>data.assets?.find(a=>a.name===n));
  if(assets.some((a,i)=>!a||a.browser_download_url!==url+[name,name+'.sha256'][i]||a.size>(i?4096:64*1024*1024)))throw Error('发布包缺失或格式不正确');
  return {version,tag:data.tag_name,name,archive:assets[0].browser_download_url,checksum:assets[1].browser_download_url,digest:assets[0].digest,available:newer(version,current),url:`https://github.com/${REPOSITORY}/releases/tag/${data.tag_name}`,notes:String(data.body||'').slice(0,12000)};
}
export async function extractRelease(archive,directory){
  let count=0,total=0,invalid;const names=new Set();
  // Validate the entire private archive before starting any filesystem writes.
  const unpack=tar.t({strict:true,filter(name,entry){
    const parts=name.replace(/\/$/,'').split('/');
    if(!['File','Directory'].includes(entry.type)||parts[0]!=='codex-workbench'||parts.some(p=>!p||p==='.'||p==='..')||name.includes('\\')||name.includes(':')||name.startsWith('/')||names.has(name)||++count>20000||entry.size>32*1024*1024||(total+=entry.size)>256*1024*1024){invalid=Error('发布包含不安全的路径、链接或超出解压限制');queueMicrotask(()=>unpack.abort(invalid));return false;}
    names.add(name);return true;
  }});
  await pipeline(createReadStream(archive),unpack);
  if(invalid)throw invalid;
  await tar.x({file:archive,cwd:directory,strict:true,preservePaths:false,preserveOwner:false,noChmod:true,noMtime:true});
  return verifyRelease(join(directory,'codex-workbench'));
}
export class Updater {
  constructor({base,state,control,health,fetch=githubFetch}){Object.assign(this,{base,state,control,health,fetch});this.status={enabled:true,busy:false,phase:'idle',message:'尚未检查更新',latest:null};this.checking=false;}
  async current(){return JSON.parse(await readFile(join(this.base,'current','release.json'),'utf8'));}
  async atomic(name,data){const next=join(this.state,name+'.next'),file=await open(next,'w',0o600);try{await file.writeFile(JSON.stringify(data));await file.sync();}finally{await file.close();}await rename(next,join(this.state,name));if(process.platform!=='win32'){const dir=await open(this.state,'r');try{await dir.sync();}finally{await dir.close();}}}
  async save(extra){Object.assign(this.status,extra);await this.atomic('status.json',this.status);}
  validPath(path){return typeof path==='string'&&/^2\.\d+\.\d+-[a-f0-9]{8}$/.test(path.slice(join(this.base,'releases').length+1))&&resolve(path)===join(this.base,'releases',path.split(/[\\/]/).at(-1));}
  async point(path){if(!this.validPath(path))throw Error('Invalid release target');const next=join(this.base,'current.next');await rm(next,{force:true});await symlink(path,next);await rename(next,join(this.base,'current'));}
  async recover(){
    await mkdir(this.state,{recursive:true,mode:0o700});
    this.status=await readFile(join(this.state,'status.json'),'utf8').then(JSON.parse).catch(()=>this.status);
    const journal=await readFile(join(this.state,'transaction.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(journal){if(!this.validPath(journal.previous))throw Error('更新事务路径无效，需要管理员检查');await this.control('stop');await this.point(journal.previous);await this.control('start');if(!await this.health())throw Error('回滚后健康检查失败');await rm(join(this.state,'transaction.json'));await this.save({busy:false,phase:'rolledBack',message:'更新服务曾中断，已恢复此前版本'});}
    else if(this.status.busy)await this.save({busy:false,phase:'failed',message:'上次下载中断；未自动重试'});
    // Only root-owned scratch directories with our exact generated prefix are removed.
    for(const [directory,prefix]of [[this.state,'download-'],[join(this.base,'releases'),'.stage-']])for(const name of await readdir(directory))if(new RegExp(`^${prefix.replace('.','\\.')}[A-Za-z0-9]{6}$`).test(name))await rm(join(directory,name),{recursive:true,force:true});
  }
  async snapshot(){const current=await this.current();return {...this.status,current:{version:current.version,releaseId:current.releaseId},repository:REPOSITORY,latest:this.status.latest?Object.fromEntries(Object.entries(this.status.latest).filter(([key])=>!['archive','checksum','digest','name'].includes(key))):null};}
  async check(){
    if(this.status.busy||this.checking)throw Error('更新操作正在进行');this.checking=true;
    try{const latest=parseRelease(JSON.parse(await this.fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,256*1024)),(await this.current()).version);await this.save({latest,phase:'checked',message:latest.available?'发现新版本':'已经是最新版本',checkedAt:new Date().toISOString()});return this.snapshot();}finally{this.checking=false;}
  }
  async begin(version){
    if(this.status.busy||this.checking)throw Error('更新操作正在进行');this.status.busy=true;
    const latest=this.status.latest;
    try{const current=await this.current();if(!latest||version!==latest.version||!newer(version,current.version))throw Error('请先检查并选择一个较新的版本');
      if((await readdir(join(this.base,'releases'))).length>=10)throw Error('已有 10 个本地版本，请管理员清理旧版后再更新');
      await this.save({busy:true,phase:'downloading',message:'正在下载并校验发布包'});
    }catch(error){this.status.busy=false;throw error;}
    this.running=this.install(latest).catch(async error=>{await this.save({busy:false,phase:'failed',message:error.message});});
    return this.snapshot();
  }
  async install(latest){
    const temp=await mkdtemp(join(this.state,'download-'));let journal=false,previous,stage;
    try{
      const checksum=await this.fetch(latest.checksum,4096),match=checksum.trim().match(/^([a-f0-9]{64})  ([^\r\n]+)$/);
      if(!match||match[2]!==latest.name)throw Error('SHA256 校验文件无效');
      const buffer=await this.fetch(latest.archive,64*1024*1024,{binary:true,timeout:120000});const digest=createHash('sha256').update(buffer).digest('hex');
      if(digest!==match[1]||(latest.digest&&latest.digest!==`sha256:${digest}`))throw Error('发布包 SHA256 不匹配');
      const archive=join(temp,'package.tgz');await writeFile(archive,buffer);await mkdir(join(temp,'extract'));
      await this.save({phase:'verifying',message:'正在检查文件清单和协议兼容性'});
      const manifest=await extractRelease(archive,join(temp,'extract')),current=await this.current();
      if(manifest.version!==latest.version||manifest.codexVersion!==current.codexVersion||manifest.nodeMajor!==24||manifest.updaterProtocol!==1||manifest.stateVersion!==current.stateVersion)throw Error('此版本需要管理员运行安装脚本升级引擎或更新服务');
      const target=join(this.base,'releases',manifest.releaseId);
      async function permissions(dir){await chmod(dir,0o755);for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await permissions(p);else await chmod(p,0o644);}}
      let existing;try{existing=await verifyRelease(target);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(existing){if(JSON.stringify(existing)!==JSON.stringify(manifest))throw Error('已存在的版本与下载包不一致');}
      else{stage=await mkdtemp(join(this.base,'releases','.stage-'));await cp(join(temp,'extract','codex-workbench'),stage,{recursive:true});await verifyRelease(stage);await permissions(stage);await rename(stage,target);stage=null;}
      previous=await readlink(join(this.base,'current'));if(!this.validPath(previous))throw Error('当前版本路径无效');
      await this.atomic('transaction.json',{previous,target});journal=true;
      await this.save({phase:'switching',message:'正在切换网页服务，浏览器将短暂重连'});
      await this.control('stop');await this.point(target);await this.control('start');
      if(!await this.health(manifest))throw Error('新版本健康检查失败');
      const previousNext=join(this.base,'previous.next');await rm(previousNext,{force:true});await symlink(previous,previousNext);await rename(previousNext,join(this.base,'previous'));
      await rm(join(this.state,'transaction.json'));journal=false;
      await this.save({busy:false,phase:'complete',message:'更新成功，请刷新页面',latest:{...latest,available:false}});
    }catch(error){
      if(journal){await this.control('stop');await this.point(previous);await this.control('start');if(!await this.health())throw Error('更新与回滚健康检查均失败，请运行诊断脚本');await rm(join(this.state,'transaction.json'));await this.save({busy:false,phase:'rolledBack',message:`更新失败，已回滚：${error.message}`});return;}
      throw error;
    }finally{await rm(temp,{recursive:true,force:true});if(stage)await rm(stage,{recursive:true,force:true});}
  }
}
