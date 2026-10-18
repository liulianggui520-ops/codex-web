import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,join} from 'node:path';
export const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
export const release=await readFile(new URL('../release.json',import.meta.url),'utf8').then(JSON.parse).catch(()=>({version,releaseId:null}));
export async function verifyRelease(directory){
  const root=await realpath(directory),manifest=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
  if(!/^2\.\d+\.\d+$/.test(manifest.version)||!new RegExp(`^${manifest.version.replaceAll('.','\\.')}-[a-f0-9]{8}$`).test(manifest.releaseId)||manifest.stateVersion!==1)throw Error('Unsupported release manifest');
  const names=Object.keys(manifest.files||{});if(!names.length||names.length>20000)throw Error('Invalid manifest file count');
  const found=new Set();
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name),info=await lstat(file);if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))throw Error('Links and special files are forbidden');if(info.isDirectory())await walk(file);else found.add(relative(root,file).replaceAll('\\','/'));}}
  await walk(root);found.delete('release.json');
  for(const name of names){const rel=relative(root,resolve(root,name));if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||name.includes('\\')||!found.delete(name)||!/^[a-f0-9]{64}$/.test(manifest.files[name]))throw Error('Invalid manifest path');const info=await lstat(resolve(root,name));if(info.size>32*1024*1024)throw Error('Release file too large');if(createHash('sha256').update(await readFile(resolve(root,name))).digest('hex')!==manifest.files[name])throw Error(`Checksum mismatch: ${name}`);}
  if(found.size)throw Error('Unlisted release files');
  return manifest;
}
