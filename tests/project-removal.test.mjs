import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink,lstat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../server/store.mjs';
import {Files} from '../server/files.mjs';
import {ProjectRemoval} from '../server/project-removal.mjs';

const scratch=resolve(process.env.TEST_TMPDIR||fileURLToPath(new URL('../../../work/',import.meta.url)));
async function fixture(){
  await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,'delete-test-')),root=join(base,'projects'),folder=join(root,'project');await mkdir(folder,{recursive:true});await writeFile(join(folder,'keep.txt'),'original');
  const store=new Store(join(base,'state','web.sqlite')),files=new Files(store,[root]),project=await files.register(folder,'delete-test');
  const removal=new ProjectRemoval(store,files,[join(base,'state')]);
  return {base,root,folder,store,files,project,removal,async input(){const preview=await removal.preview(project.id);assert.equal(preview.canDeleteFiles,true,preview.reason);return {deleteFiles:true,confirmationPath:folder,etag:preview.etag};},finish(){store.removeProject(project.id);},async cleanup(){store.close();assert.ok(relative(scratch,base).startsWith('delete-test-'));await rm(base,{recursive:true,force:true});}};
}
test('physical deletion removes only the confirmed directory and does not follow internal symlinks',async()=>{
  const f=await fixture();try{
    const outside=join(f.base,'outside');await mkdir(outside);await writeFile(join(outside,'private.txt'),'keep outside');await symlink(outside,join(f.folder,'outside-link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(f.removal.remove(f.project.id,{confirmationPath:'wrong'},async()=>{},f.finish),error=>error.status===400);
    const input=await f.input();await f.removal.remove(f.project.id,input,async()=>{},f.finish);
    await assert.rejects(lstat(f.folder),error=>error.code==='ENOENT');assert.equal(await readFile(join(outside,'private.txt'),'utf8'),'keep outside');assert.equal(f.store.project(f.project.id),undefined);
  }finally{await f.cleanup();}
});
test('root, nested registrations, protected data and replaced directory identities are rejected',async()=>{
  const f=await fixture();try{
    const rootProject=await f.files.register(f.root,'root');assert.equal((await f.removal.preview(rootProject.id)).canDeleteFiles,false);
    const input=await f.input(),child=join(f.folder,'child');await mkdir(child);const sub=await f.files.register(child,'child');assert.match((await f.removal.preview(f.project.id)).reason,/其他已登记项目/);f.store.removeProject(sub.id);
    f.removal.protectedPaths.push(child);assert.match((await f.removal.preview(f.project.id)).reason,/配置目录/);f.removal.protectedPaths.pop();
    f.files.roots.push(child);assert.match((await f.removal.preview(f.project.id)).reason,/其他工作区根/);f.files.roots.pop();
    const original=join(f.root,'original');await rename(f.folder,original);await mkdir(f.folder);await writeFile(join(f.folder,'new.txt'),'new identity');
    await assert.rejects(f.removal.remove(f.project.id,input,async()=>{},f.finish),error=>error.status===409);
    assert.equal(await readFile(join(f.folder,'new.txt'),'utf8'),'new identity');assert.equal(await readFile(join(original,'keep.txt'),'utf8'),'original');
  }finally{await f.cleanup();}
});
test('interrupted deletion persists its location and retry never removes a recreated original path',async()=>{
  const f=await fixture();try{
    const input=await f.input(),mounts=f.removal.mounts.bind(f.removal);let calls=0;
    f.removal.mounts=async target=>{if(++calls===2)throw Error('simulated deletion failure');await mounts(target);};
    await assert.rejects(f.removal.remove(f.project.id,input,async()=>{},f.finish),/项目记录已保留/);
    assert.ok(f.store.project(f.project.id));const record=f.store.get(f.removal.key(f.project.id));assert.equal(record.phase,'deleting');assert.equal(await readFile(join(record.target,'keep.txt'),'utf8'),'original');
    await assert.rejects(f.files.register(record.target,'reserved'),error=>error.status===403);await assert.rejects(f.files.resolve(f.project.id),error=>error.status===409);
    await mkdir(f.folder);await writeFile(join(f.folder,'new.txt'),'must survive');
    const restarted=new ProjectRemoval(f.store,f.files),preview=await restarted.preview(f.project.id);assert.equal(preview.canDeleteFiles,true);assert.equal(preview.recoveryPath,record.target);
    await restarted.remove(f.project.id,{...input,etag:preview.etag},async()=>{},f.finish);
    assert.equal(await readFile(join(f.folder,'new.txt'),'utf8'),'must survive');await assert.rejects(lstat(record.target),error=>error.code==='ENOENT');assert.equal(f.store.get(restarted.key(f.project.id)),null);
  }finally{await f.cleanup();}
});
test('prepared deletion can resume and a substituted quarantine directory is never deleted',async()=>{
  const f=await fixture();try{
    const input=await f.input(),pending=f.removal.pending.bind(f.removal);let stop=true;
    f.removal.pending=async(...args)=>{if(stop){stop=false;throw Error('simulated shutdown before rename');}return pending(...args);};
    await assert.rejects(f.removal.remove(f.project.id,input,async()=>{},f.finish),/项目记录已保留/);assert.equal(f.store.get(f.removal.key(f.project.id)).phase,'prepared');
    f.removal.pending=pending;
    const target=f.store.get(f.removal.key(f.project.id)).target,old=target+'-saved';let moved=false;
    f.removal.pending=async(...args)=>{if(!moved&&await lstat(target).then(()=>true,()=>false)){moved=true;await rename(target,old);await symlink(f.folder,target,process.platform==='win32'?'junction':'dir');}return pending(...args);};
    await assert.rejects(f.removal.remove(f.project.id,input,async()=>{},f.finish),/目录身份已变化/);assert.equal(await readFile(join(old,'keep.txt'),'utf8'),'original');assert.ok(f.store.project(f.project.id));
  }finally{await f.cleanup();}
});
test('mount preflight refuses the mounted filesystem root on Linux',{skip:process.platform!=='linux'},async()=>{
  const f=await fixture();try{await assert.rejects(f.removal.mounts('/'),/挂载点/);}finally{await f.cleanup();}
});
