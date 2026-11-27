import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startGateway } from '../deploy/sandbox/gateway.mjs';

test('the sandbox gateway forwards HTTP bodies, cookies and status codes without changing them', async () => {
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.writeHead(201,{'Content-Type':'application/json','Set-Cookie':'test_session=opaque; HttpOnly; Secure'});
    res.end(JSON.stringify({path:req.url,cookie:req.headers.cookie,body}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=await startGateway({ports:[[0,server.address().port]]});
  try{
    const url='http://127.0.0.1:'+gateway.servers[0].address().port;
    const payload='test-only-body'.repeat(10000);
    const response=await fetch(url+'/api/check',{method:'POST',headers:{cookie:'test_session=opaque',connection:'close'},body:payload});
    assert.equal(response.status,201);assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure/);
    assert.deepEqual(await response.json(),{path:'/api/check',cookie:'test_session=opaque',body:payload});
  }finally{await gateway.close();await new Promise(r=>server.close(r));}
});
