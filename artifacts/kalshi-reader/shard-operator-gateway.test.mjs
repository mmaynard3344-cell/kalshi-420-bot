import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operatorGatewayAllowed, operatorGatewayUpstreamPath } from './shard-operator-gateway.mjs';
const origin='https://shawshank.example.com';
const req={method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json','content-length':'70'}};
test('only explicit login and preview paths accepted',()=>{
 assert.equal(operatorGatewayUpstreamPath('/api/operator/shards/login'),'/api/trade/shard-transfer/operator-login');
 assert.equal(operatorGatewayUpstreamPath('/api/operator/shards/preview'),'/api/trade/shard-transfer/session-preview');
 assert.equal(operatorGatewayUpstreamPath('/api/trade/shard-transfer'),null);
 assert.equal(operatorGatewayUpstreamPath('/api/operator/shards/submit'),null);
 assert.equal(operatorGatewayAllowed(req,'/api/operator/shards/login',origin),true);
 assert.equal(operatorGatewayAllowed(req,'/api/operator/shards/submit',origin),false);
});
test('non-POST and cross-site requests denied',()=>{
 assert.equal(operatorGatewayAllowed({...req,method:'GET'},'/api/operator/shards/login',origin),false);
 assert.equal(operatorGatewayAllowed({...req,headers:{...req.headers,origin:'https://bad.example'}},'/api/operator/shards/login',origin),false);
 assert.equal(operatorGatewayAllowed({...req,headers:{...req.headers,'sec-fetch-site':'cross-site'}},'/api/operator/shards/login',origin),false);
 assert.equal(operatorGatewayAllowed({...req,headers:{...req.headers,'content-length':'5000'}},'/api/operator/shards/login',origin),false);
});

test('gateway remains off by default and makes zero upstream requests',async()=>{
 const {Readable}=await import('node:stream');
 const {operatorGateway}=await import('./shard-operator-gateway.mjs');
 const request=Readable.from(['{"operatorCredential":"test"}']);
 request.method='POST';request.headers={...req.headers,'content-length':'29'};
 const response={status:null,headers:null,body:null,writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
 const oldFetch=globalThis.fetch;
 let called=false;
 globalThis.fetch=async()=>{called=true;throw Error('No upstream request expected');};
 try{
  await operatorGateway(request,response,'/api/operator/shards/login',{enabled:false,origin,baseUrl:'https://api.example.com',tradeToken:'server-only'});
  assert.equal(response.status,403);
  assert.equal(called,false);
 }finally{globalThis.fetch=oldFetch;}
});

test('same-origin gateway forwards secure login cookie but never leaks trade token',async()=>{
 const {Readable}=await import('node:stream');
 const {operatorGateway}=await import('./shard-operator-gateway.mjs');
 const body=JSON.stringify({operatorCredential:'not-a-real-credential'});
 const request=Readable.from([body]);
 request.method='POST';
 request.headers={...req.headers,'content-length':String(Buffer.byteLength(body))};
 const response={status:null,headers:null,body:null,writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
 const oldFetch=globalThis.fetch;
 let upstreamHeaders=null;
 globalThis.fetch=async(url,init)=>{
   assert.equal(url,'https://api.example.com/api/trade/shard-transfer/operator-login');
   upstreamHeaders=init.headers;
   return new Response(JSON.stringify({authenticated:true,csrf:'dummy',transfer_submitted:false}),{
     status:200,headers:{'set-cookie':'__Host-shard_operator=mock.token; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900','content-type':'application/json'}
   });
 };
 try{
  await operatorGateway(request,response,'/api/operator/shards/login',{enabled:true,origin,baseUrl:'https://api.example.com',tradeToken:'private-server-key'});
  assert.equal(response.status,200);
  assert.match(response.headers['set-cookie'],/^__Host-shard_operator=/);
  assert.equal(upstreamHeaders['x-trade-token'],'private-server-key');
  assert.doesNotMatch(JSON.stringify(response),/private-server-key/);
 }finally{globalThis.fetch=oldFetch;}
});
