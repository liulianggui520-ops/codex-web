import {test} from 'node:test';
import assert from 'node:assert/strict';
import {updateSocket} from './helpers/update-socket.mjs';

test('updater HTTP socket sends bodyless status GET and byte-counted JSON POST',async()=>{
  const requests=[];
  const socket=await updateSocket(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push({method:req.method,path:req.url,headers:req.headers,body:Buffer.concat(chunks)});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({enabled:true,busy:false}));
  });
  try{
    assert.deepEqual(await socket.client.request(),{enabled:true,busy:false});
    await socket.client.request('check');
    const input={version:'2.1.4',note:'中文 🚀'};await socket.client.request('apply',input);
    assert.equal(requests.length,3);
    const [get,check,post]=requests;
    assert.equal(get.method,'GET');assert.equal(get.path,'/status');assert.equal(get.body.length,0);
    assert.equal(get.headers['content-type'],undefined);assert.equal(get.headers['content-length'],undefined);assert.equal(get.headers['transfer-encoding'],undefined);
    for(const request of [check,post]){
      assert.equal(request.method,'POST');assert.equal(request.headers['content-type'],'application/json');
      assert.equal(Number(request.headers['content-length']),request.body.length);assert.equal(request.headers['transfer-encoding'],undefined);
    }
    assert.equal(check.path,'/check');assert.equal(check.body.toString(),'{}');
    assert.equal(post.path,'/apply');assert.deepEqual(JSON.parse(post.body),input);assert.equal(post.body.length,Buffer.byteLength(JSON.stringify(input)));
  }finally{await socket.close();}
});

test('updater empty, invalid JSON and JSON errors include HTTP status without leaking response bodies',async t=>{
  for(const [status,body,pattern] of [
    [400,'',/HTTP 400.*空响应/],[200,' \n ',/HTTP 200.*空响应/],
    [502,'<html>private-token</html>',/HTTP 502.*非 JSON/],[200,'{',/HTTP 200.*非 JSON/],
    [409,JSON.stringify({error:'任务正在运行'}),/HTTP 409.*任务正在运行/],
    [503,'null',/HTTP 503/],
  ])await t.test(`${status}: ${pattern.source}`,async()=>{
    const socket=await updateSocket((req,res)=>{req.resume();res.writeHead(status);res.end(body);});
    try{await assert.rejects(socket.client.request(),error=>{assert.match(error.message,pattern);assert.ok(!error.message.includes('private-token'));assert.ok(!error.message.includes('Unexpected end'));return true;});}
    finally{await socket.close();}
  });
});

test('updater rejects oversized and truncated HTTP responses',async t=>{
  await t.test('bounded response',async()=>{
    const socket=await updateSocket((req,res)=>{req.resume();res.writeHead(200);res.end(JSON.stringify({text:'界'.repeat(24000)}));});
    try{await assert.rejects(socket.client.request(),/更新响应过大/);}finally{await socket.close();}
  });
  await t.test('truncated response',async()=>{
    const socket=await updateSocket((req,res)=>{req.resume();res.writeHead(502,{'Content-Length':'100'});res.write('{');setImmediate(()=>res.destroy());});
    try{await assert.rejects(socket.client.request(),/HTTP 502.*响应中断/);}finally{await socket.close();}
  });
});
