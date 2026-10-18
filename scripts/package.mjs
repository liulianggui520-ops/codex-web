import { readFile,writeFile,mkdir,cp,readdir,stat,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve,dirname,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url))),work=resolve(process.env.PACKAGE_WORK_DIR||resolve(root,'..','..','work')),stage=join(work,'package-stage'),target=join(stage,'codex-workbench');
await mkdir(stage,{recursive:true});if(!relative(work,target).startsWith('package-stage'))throw new Error('Invalid stage');await rm(target,{recursive:true,force:true});await mkdir(target,{recursive:true});
for(const name of ['server','src','dist','protocol','deploy','scripts','tests','docs','package.json','pnpm-lock.yaml','index.html','tsconfig.json','vite.config.ts','playwright.config.ts','README.md','DEPLOY-HANDOFF.md','.env.example','VERIFICATION.md','PRE-DELIVERY-REVIEW.md'])await cp(join(root,name),join(target,name),{recursive:true});
const req=createRequire(import.meta.url),copied=new Map();
async function vendor(name,from=req){let entry=from.resolve(name),dir=dirname(entry);while(true){try{const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(pkg.name===name){if(copied.has(name)){if(copied.get(name)!==pkg.version)throw Error('Dependency version conflict');return;}copied.set(name,pkg.version);await cp(dir,join(target,'node_modules',name),{recursive:true});for(const dep of Object.keys(pkg.dependencies||{}))await vendor(dep,createRequire(join(dir,'package.json')));return;}}catch(e){if(e.code!=='ENOENT')throw e;}const parent=dirname(dir);if(parent===dir)throw Error('Dependency root not found');dir=parent;}}
for(const name of ['ws','busboy','tar'])await vendor(name);
const files={};
async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Symlinks are not permitted in package');if(entry.isDirectory())await walk(file);else files[relative(target,file).replaceAll('\\','/')]=createHash('sha256').update(await readFile(file)).digest('hex');}}
const {version}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
await walk(target);const digest=createHash('sha256').update(JSON.stringify(files)).digest('hex'),manifest={version,releaseId:`${version}-${digest.slice(0,8)}`,stateVersion:1,codexVersion:'0.159.3',nodeMajor:24,updaterProtocol:1,createdAt:new Date().toISOString(),files};
await writeFile(join(target,'release.json'),JSON.stringify(manifest,null,2)+'\n');
const output=resolve(process.env.PACKAGE_OUTPUT_DIR||resolve(root,'..'));await mkdir(output,{recursive:true});
const name=`codex-workbench-${version}.tar.gz`,archive=join(output,name);execFileSync('tar',['-czf',archive,'-C',stage,'codex-workbench'],{stdio:'inherit'});
const sum=createHash('sha256').update(await readFile(archive)).digest('hex');await writeFile(archive+'.sha256',`${sum}  ${name}\n`);console.log(JSON.stringify({archive,releaseId:manifest.releaseId,bytes:(await stat(archive)).size,sha256:sum}));
