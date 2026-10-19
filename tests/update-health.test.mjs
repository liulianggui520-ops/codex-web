import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {probeWebHealth,waitWebHealth} from '../server/update-health.mjs';

async function serverFor(handler){
  const server=http.createServer(handler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,async close(){const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}};
}

test('health probe sends public Host to loopback, including a non-default public port',async()=>{
  const requests=[];
  const server=await serverFor((req,res)=>{
    requests.push({host:req.headers.host,path:req.url,method:req.method});
    if(req.headers.host!=='workbench.example:8443'){res.writeHead(403);res.end('{}');return;}
    res.end(JSON.stringify({ok:true,version:'2.1.5',releaseId:'2.1.5-12345678'}));
  });
  try{
    const options={origin:'https://workbench.example:8443',port:server.port,manifest:{version:'2.1.5',releaseId:'2.1.5-12345678'}};
    assert.equal((await probeWebHealth(options)).ok,true);
    assert.deepEqual(requests,[{host:'workbench.example:8443',path:'/healthz',method:'GET'}]);
    assert.equal((await probeWebHealth({...options,origin:'https://wrong.example'})).message,'HTTP 403');
    assert.match((await probeWebHealth({...options,manifest:{version:'2.1.4',releaseId:'other'}})).message,/不匹配/);
    assert.equal((await probeWebHealth({...options,manifest:undefined})).ok,true);
  }finally{await server.close();}
});

test('health retries startup and reports final failure without accepting bad responses',async()=>{
  let count=0;
  const server=await serverFor((req,res)=>{if(++count===1){res.writeHead(503);res.end();}else res.end(JSON.stringify({ok:true}));});
  try{assert.equal(await waitWebHealth({origin:'https://workbench.example',port:server.port,attempts:2,interval:1}),true);assert.equal(count,2);}
  finally{await server.close();}
});

test('health rejects invalid, oversized, interrupted and stalled responses',async t=>{
  for(const [name,handler,pattern] of [
    ['invalid JSON',(req,res)=>res.end('<html>private-content</html>'),/不是有效JSON/],
    ['not ready',(req,res)=>res.end('null'),/未确认就绪/],
    ['oversized',(req,res)=>res.end('x'.repeat(8193)),/超过8KiB/],
    ['interrupted',(req,res)=>{res.writeHead(200,{'Content-Length':'200'});res.write('{');setImmediate(()=>res.destroy());},/中断/],
    ['timeout',(req,res)=>{req.resume();},/超时/],
  ])await t.test(name,async()=>{
    const server=await serverFor(handler);let message;
    try{assert.equal(await waitWebHealth({origin:'https://workbench.example',port:server.port,attempts:1,timeout:100,onFailure:value=>message=value}),false);assert.match(message,pattern);assert.ok(!message.includes('private-content'));}
    finally{await server.close();}
  });
});
