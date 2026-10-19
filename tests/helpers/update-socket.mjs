import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UpdateClient} from '../../server/update-client.mjs';

export async function updateSocket(handler){
  const directory=await mkdtemp(join(tmpdir(),'cw-up-'));
  const socket=process.platform==='win32'?`\\\\.\\pipe\\cw-up-${randomUUID()}`:join(directory,'control.sock');
  const server=http.createServer(handler);
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});}
  catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  return {client:new UpdateClient(socket),server,async close(){
    const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    server.closeAllConnections();await closed;await rm(directory,{recursive:true,force:true});
  }};
}
