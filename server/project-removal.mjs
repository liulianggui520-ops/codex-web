import {lstat,realpath,mkdtemp,rename,rm,rmdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {inside} from './files.mjs';
import {check,fail,hash} from './util.mjs';

const identity=info=>`${info.dev}:${info.ino}`;
async function metadata(file){try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export class ProjectRemoval {
  constructor(store,files,protectedPaths=[]){Object.assign(this,{store,files,protectedPaths});this.busy=false;}
  key(id){return 'project-removal/'+id;}
  async boundary(project){
    const target=project.path,parent=path.dirname(target);
    check(path.isAbsolute(target)&&parent!==target,'不能删除文件系统根目录',403);
    const roots=await Promise.all(this.files.roots.map(root=>realpath(root)));
    check(roots.some(root=>inside(root,target)&&root!==target)&&!roots.some(root=>inside(target,root)),'不能删除工作区根目录或包含其他工作区根目录的文件夹',403);
    for(const protectedPath of this.protectedPaths){
      let canonical;try{canonical=await realpath(protectedPath);}catch{canonical=path.resolve(protectedPath);}
      check(!inside(target,canonical)&&!inside(canonical,target),'不能删除工作台代码、数据或 Codex 配置目录',403);
    }
    check(!this.store.projects().some(other=>other.id!==project.id&&inside(target,other.path)),'此文件夹包含其他已登记项目，请先处理子项目',409);
    check(await realpath(parent)===parent,'项目父目录已被符号链接替换',409);
    const info=await lstat(parent);check(info.isDirectory()&&!info.isSymbolicLink(),'项目父目录已变化',409);
    return {parent,parentIdentity:identity(info)};
  }
  async inspect(project){
    const parent=await this.boundary(project),info=await lstat(project.path);
    check(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(project.path)===project.path,'项目目录已被替换或为符号链接，请重新核对',409);
    const directoryIdentity=identity(info),etag=hash(JSON.stringify([project.id,project.path,directoryIdentity,parent.parentIdentity]));
    return {...parent,directoryIdentity,etag};
  }
  async pending(project,record){
    const parent=await this.boundary(project);
    check(record.path===project.path&&record.parentIdentity===parent.parentIdentity,'删除记录对应的目录身份已变化，请管理员核对',409);
    check(path.dirname(record.holding)===parent.parent&&/^\.codex-project-delete-[A-Za-z0-9]{6}$/.test(path.basename(record.holding))&&record.target===path.join(record.holding,'project'),'删除恢复路径无效',409);
    check(!this.store.projects().some(other=>other.id!==project.id&&inside(record.holding,other.path)),'删除恢复目录包含其他已登记项目，请管理员核对',409);
    const holding=await metadata(record.holding),target=await metadata(record.target);
    check(holding&&holding.isDirectory()&&!holding.isSymbolicLink()&&identity(holding)===record.holdingIdentity&&await realpath(record.holding)===record.holding,'删除隔离目录已变化，请管理员核对',409);
    if(target)check(target.isDirectory()&&!target.isSymbolicLink()&&identity(target)===record.directoryIdentity,'待删除目录身份已变化，请管理员核对',409);
    else if(record.phase==='prepared')check(identity(await lstat(project.path))===record.directoryIdentity,'无法定位原目录，请管理员核对删除记录',409);
    else check(record.phase==='deleting','删除恢复状态无效',409);
    return {record,targetExists:!!target,etag:record.etag};
  }
  async preview(id){
    const project=this.store.project(id);check(project,'项目不存在',404);
    const record=this.store.get(this.key(id));
    try{const info=record?await this.pending(project,record):await this.inspect(project);return {path:project.path,canDeleteFiles:true,etag:info.etag,recoveryPath:record?.target??null};}
    catch(error){return {path:project.path,canDeleteFiles:false,reason:error.message,recoveryPath:record?.target??null};}
  }
  async mounts(target){
    if(process.platform!=='linux')return;
    const source=await readFile('/proc/self/mountinfo','utf8');
    for(const line of source.trim().split('\n')){
      const mount=line.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
      check(mount&&!inside(target,mount),'文件夹包含挂载点，不能从网页递归删除',409);
    }
  }
  async remove(id,input,assertIdle,finish){
    check(!this.busy,'正在删除项目，请稍后重试',409);
    this.busy=true;this.files.removing=true;
    let record;
    try{
      const project=this.store.project(id);check(project,'项目不存在',404);
      check(input.confirmationPath===project.path,'请输入完整项目路径确认删除文件夹',400);
      record=this.store.get(this.key(id));
      const info=record?await this.pending(project,record):await this.inspect(project);
      check(typeof input.etag==='string'&&input.etag===info.etag,'目录已变化，请重新打开删除窗口核对',409);
      await assertIdle();
      if(!record){
        await this.mounts(project.path);
        const holding=await mkdtemp(path.join(info.parent,'.codex-project-delete-'));
        record={path:project.path,target:path.join(holding,'project'),holding,holdingIdentity:identity(await lstat(holding)),...info,phase:'prepared'};
        this.store.set(this.key(id),record);
      }
      const pending=await this.pending(project,record);
      if(!pending.targetExists&&record.phase==='prepared'){
        const current=await this.inspect(project);check(current.etag===record.etag,'目录已变化，尚未删除文件',409);
        await rename(project.path,record.target);
      }
      await this.pending(project,record);
      record={...record,phase:'deleting'};this.store.set(this.key(id),record);
      if(await metadata(record.target)){
        await this.mounts(record.target);
        await rm(record.target,{recursive:true,force:false,maxRetries:2,retryDelay:100});
      }
      finish();
      await rmdir(record.holding).catch(()=>{});
      return {ok:true,filesDeleted:true};
    }catch(error){
      if(record)throw fail(error.status||500,`${error.message}。项目记录已保留；删除恢复目录：${record.target}`,{recoveryPath:record.target});
      throw error;
    }finally{this.files.removing=false;this.busy=false;}
  }
}
