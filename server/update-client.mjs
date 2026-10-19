import http from 'node:http';
export class UpdateClient {
  constructor(socket=process.env.UPDATE_SOCKET){this.socket=socket;}
  async request(action='status',input={}){
    if(!this.socket)return {enabled:false,busy:false,message:'请在 Linux 使用新版安装脚本启用更新服务'};
    const body=action==='status'?undefined:JSON.stringify(input);
    const headers=body===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)};
    return new Promise((resolve,reject)=>{
      const req=http.request({socketPath:this.socket,path:`/${action}`,method:action==='status'?'GET':'POST',headers},res=>{
        const prefix=`更新服务 HTTP ${res.statusCode}`;
        const chunks=[];let bytes=0;
        res.on('data',chunk=>{
          bytes+=chunk.length;
          if(bytes>65536){reject(Error(`${prefix}：更新响应过大`));res.destroy();return;}
          chunks.push(chunk);
        });
        res.on('error',()=>reject(Error(`${prefix}：响应中断`)));
        res.on('end',()=>{
          const data=Buffer.concat(chunks).toString('utf8');
          if(!data.trim()){reject(Error(`${prefix}：空响应`));return;}
          let value;
          try{value=JSON.parse(data);}catch{reject(Error(`${prefix}：非 JSON 响应`));return;}
          if(res.statusCode!==200){reject(Error(`${prefix}：${typeof value?.error==='string'?value.error:'请求失败'}`));return;}
          resolve(value);
        });
      });
      req.setTimeout(25000,()=>req.destroy(Error('更新服务超时')));
      req.on('error',reject);
      req.end(body);
    });
  }
}
