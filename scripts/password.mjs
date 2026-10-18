import { randomBytes } from 'node:crypto';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { passwordHash } from '../server/auth.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
async function hidden(prompt){
  if(!process.stdin.isTTY)throw new Error('需要交互终端；可使用 --stdin 或 --generate');
  process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();let value='';
  return new Promise((resolve,reject)=>{const listener=chunk=>{for(const char of chunk.toString()){
    if(char==='\u0003'){cleanup();reject(new Error('已取消'));return;}
    if(char==='\r'||char==='\n'){cleanup();process.stdout.write('\n');resolve(value);return;}
    if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' '&&value.length<256)value+=char;
  }};function cleanup(){process.stdin.off('data',listener);process.stdin.setRawMode(false);process.stdin.pause();}process.stdin.on('data',listener);});
}
let password;
if(process.argv.includes('--generate'))password=randomBytes(24).toString('base64url');
else if(process.argv.includes('--stdin')){let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>258)throw new Error('口令过长');}password=input.replace(/\r?\n$/,'');}
else{password=await hidden('设置工作台访问口令（至少16字符，不回显）: ');const confirm=await hidden('再次输入: ');if(password!==confirm)throw new Error('两次口令不同');}
const credential=await passwordHash(password),store=new Store(join(resolve(process.env.DATA_DIR||join(root,'runtime')),'web.sqlite'));
store.set('credential',credential);store.db.exec('DELETE FROM sessions');store.close();
console.log('访问口令已设置；已有网页登录已失效。');
if(process.argv.includes('--generate'))console.log(`请保存口令（仅显示这一次）: ${password}`);
