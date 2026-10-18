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
