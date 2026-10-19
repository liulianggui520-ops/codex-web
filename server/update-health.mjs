import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

export function probeWebHealth({origin,manifest,port=47832,timeout=1500}){
  const host=new URL(origin).host;
  return new Promise(resolve=>{
    let settled=false;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
    // Node's fetch may replace Host with the loopback authority. Use HTTP directly
    // so the same origin validation as public requests remains in effect.
    const req=http.request({hostname:'127.0.0.1',port,path:'/healthz',method:'GET',headers:{Host:host},agent:false},res=>{
      res.on('error',()=>finish({ok:false,message:'健康响应中断'}));
      if(res.statusCode!==200){finish({ok:false,message:`HTTP ${res.statusCode}`});res.destroy();return;}
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>8192){finish({ok:false,message:'健康响应超过8KiB'});res.destroy();return;}chunks.push(chunk);});
      res.on('end',()=>{
        let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish({ok:false,message:'健康响应不是有效JSON'});return;}
        if(data?.ok!==true){finish({ok:false,message:'健康响应未确认就绪'});return;}
        if(manifest&&(data.version!==manifest.version||data.releaseId!==manifest.releaseId)){finish({ok:false,message:'运行版本与目标发布不匹配'});return;}
        finish({ok:true,message:'健康检查通过'});
      });
    });
    const timer=setTimeout(()=>{finish({ok:false,message:'健康请求超时'});req.destroy();},timeout);
    req.on('error',error=>finish({ok:false,message:`健康连接失败 (${error.code||'HTTP error'})`}));
    req.end();
  });
}

export async function waitWebHealth({attempts=30,interval=1000,onFailure,...options}){
  let result;
  for(let i=0;i<attempts;i++){
    result=await probeWebHealth(options);
    if(result.ok)return true;
    if(i+1<attempts)await delay(interval);
  }
  onFailure?.(result?.message||'未执行健康检查');return false;
}
