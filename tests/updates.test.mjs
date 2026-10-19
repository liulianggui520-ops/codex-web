import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readlink,lstat,chown} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import * as tar from 'tar';
import {Updater,parseRelease,newer,extractRelease,REPOSITORY} from '../server/update-core.mjs';
import http from 'node:http';
import {probeWebHealth} from '../server/update-health.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
async function fixture(){const scratch=process.env.TEST_TMPDIR||tmpdir();await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,'updater-test-'));await mkdir(join(base,'releases'));await mkdir(join(base,'state'));const old=join(base,'releases','2.1.0-12345678');await mkdir(old);await writeFile(join(old,'release.json'),JSON.stringify({version:'2.1.0',releaseId:'2.1.0-12345678',stateVersion:1,codexVersion:'0.159.3',nodeMajor:24}));await symlink(old,join(base,'current'),process.platform==='win32'?'junction':'dir');
 const src=join(base,'source');await mkdir(join(src,'codex-workbench'),{recursive:true});await writeFile(join(src,'codex-workbench','hello.txt'),'new release');const manifest={version:'2.2.0',releaseId:'2.2.0-abcdef12',stateVersion:1,codexVersion:'0.159.3',nodeMajor:24,updaterProtocol:1,files:{'hello.txt':hash('new release')}};await writeFile(join(src,'codex-workbench','release.json'),JSON.stringify(manifest));if(process.platform!=='win32'&&process.getuid()===0){await chown(join(src,'codex-workbench'),1001,1001);await chown(join(src,'codex-workbench','hello.txt'),1001,1001);}const archive=join(base,'release.tgz');await tar.c({gzip:true,file:archive,cwd:src},['codex-workbench']);const buffer=await readFile(archive),name='codex-workbench-2.2.0.tar.gz';const metadata={tag_name:'v2.2.0',assets:[name,name+'.sha256'].map(name=>({name,size:buffer.length,browser_download_url:`https://github.com/${REPOSITORY}/releases/download/v2.2.0/${name}`}))};metadata.assets[1].size=100;
 const calls=[];let healthy=true;const updater=new Updater({base,state:join(base,'state'),control:async action=>{calls.push(action);},health:async manifest=>!manifest||healthy,fetch:async url=>url.includes('/latest')?JSON.stringify(metadata):url.endsWith('.sha256')?`${hash(buffer)}  ${name}\n`:buffer});await updater.recover();return{base,old,src,archive,buffer,metadata,updater,calls,setHealthy:value=>healthy=value,cleanup:()=>rm(base,{recursive:true,force:true})};}
test('release metadata pins owner, assets, stable versions and no downgrade',()=>{assert.equal(newer('2.10.0','2.9.0'),true);assert.equal(newer('2.0.0','2.1.0'),false);assert.throws(()=>parseRelease({tag_name:'v2.2.0',assets:[]},'2.1.0'));});
test('safe extraction rejects outside roots and links without crashing',async()=>{const f=await fixture();try{await writeFile(join(f.src,'bad.txt'),'bad');const bad=join(f.base,'bad.tgz'),out=join(f.base,'out');await mkdir(out);await tar.c({gzip:true,file:bad,cwd:f.src},['bad.txt']);await assert.rejects(extractRelease(bad,out),/不安全/);await symlink(f.base,join(f.src,'codex-workbench','link'),process.platform==='win32'?'junction':'dir');await tar.c({gzip:true,file:bad,cwd:f.src},['codex-workbench']);await assert.rejects(extractRelease(bad,out),/不安全/);}finally{await f.cleanup();}});
test('successful update is verified and switches only web; parallel apply is rejected',{skip:process.platform==='win32'},async()=>{const f=await fixture();try{await f.updater.check();const results=await Promise.allSettled([f.updater.begin('2.2.0'),f.updater.begin('2.2.0')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await f.updater.running;assert.equal(f.updater.status.phase,'complete',f.updater.status.message);assert.match(await readlink(join(f.base,'current')),/2\.2\.0-abcdef12$/);assert.deepEqual(f.calls,['stop','start']);assert.equal(await readlink(join(f.base,'previous')),f.old);if(process.platform!=='win32'){const info=await lstat(join(f.base,'current','hello.txt'));assert.equal(info.mode&0o777,0o644);assert.equal(info.uid,process.getuid());assert.equal((await lstat(join(f.base,'current','release.json'))).uid,process.getuid());}}finally{await f.cleanup();}});
test('failed health rolls back and restart recovery restores journaled previous',{skip:process.platform==='win32'},async()=>{const f=await fixture();try{await f.updater.check();f.setHealthy(false);await f.updater.begin('2.2.0');await f.updater.running;assert.equal(f.updater.status.phase,'rolledBack',f.updater.status.message);assert.equal(await readlink(join(f.base,'current')),f.old);f.setHealthy(true);await f.updater.begin('2.2.0');await f.updater.running;assert.equal(f.updater.status.phase,'complete',f.updater.status.message);await writeFile(join(f.base,'state','transaction.json'),JSON.stringify({previous:f.old}));await f.updater.recover();assert.equal(f.updater.status.phase,'rolledBack');assert.equal(await readlink(join(f.base,'current')),f.old);}finally{await f.cleanup();}});
test('checksum failure never stops web or switches release',async()=>{const f=await fixture();try{await f.updater.check();const fetch=f.updater.fetch;f.updater.fetch=(url,...args)=>url.endsWith('.sha256')?'0'.repeat(64)+'  codex-workbench-2.2.0.tar.gz\n':fetch(url,...args);await f.updater.begin('2.2.0');await f.updater.running;assert.equal(f.updater.status.phase,'failed');assert.equal(await readlink(join(f.base,'current')),f.old);assert.deepEqual(f.calls,[]);}finally{await f.cleanup();}});

test('HTTP health verifies actual release switch, rollback and journal recovery without false Host failures',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();let rejectNew=false;
  const server=http.createServer(async(req,res)=>{
    if(req.headers.host!=='workbench.example'){res.writeHead(403);res.end('{}');return;}
    const current=await f.updater.current();res.end(JSON.stringify({ok:!(rejectNew&&current.version==='2.2.0'),version:current.version,releaseId:current.releaseId}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  f.updater.health=async manifest=>(await probeWebHealth({origin:'https://workbench.example',port:server.address().port,manifest})).ok;
  try{
    await f.updater.check();rejectNew=true;await f.updater.begin('2.2.0');await f.updater.running;
    assert.equal(f.updater.status.phase,'rolledBack');assert.equal(await readlink(join(f.base,'current')),f.old);
    rejectNew=false;await f.updater.begin('2.2.0');await f.updater.running;assert.equal(f.updater.status.phase,'complete');
    await writeFile(join(f.base,'state','transaction.json'),JSON.stringify({previous:f.old}));
    await f.updater.recover();assert.equal(f.updater.status.phase,'rolledBack');assert.equal(f.updater.status.busy,false);
    assert.equal(await readlink(join(f.base,'current')),f.old);
    await assert.rejects(readFile(join(f.base,'state','transaction.json')),error=>error.code==='ENOENT');
  }finally{const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;await f.cleanup();}
});
