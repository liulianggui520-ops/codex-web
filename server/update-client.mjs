import http from 'node:http';
export class UpdateClient {
  constructor(socket=process.env.UPDATE_SOCKET){this.socket=socket;}
  async request(action='status',input={}){
    if(!this.socket)return {enabled:false,busy:false,message:'请在 Linux 使用新版安装脚本启用更新服务'};
    return new Promise((resolve,reject)=>{const req=http.request({socketPath:this.socket,path:`/${action}`,method:action==='status'?'GET':'POST',headers:{'Content-Type':'application/json'}},res=>{let data='';res.on('data',chunk=>{data+=chunk;if(data.length>65536)res.destroy(Error('更新响应过大'));});res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(data);if(res.statusCode!==200)throw Error(value.error||'更新服务错误');resolve(value);}catch(e){reject(e);}});});req.setTimeout(25000,()=>req.destroy(Error('更新服务超时')));req.on('error',reject);req.end(JSON.stringify(input));});
  }
}
