'use strict';
const http=require('node:http'),https=require('node:https'),{performance}=require('node:perf_hooks');
const C=require('./common.cjs'),I=require('./identity.cjs');
/** No automatic retry, no redirect and no console/Memory endpoint. Candidate and restore each have separate, externally durable one-shot boundaries. */
function client(secret,{testOrigin}={}){const origin=new URL(testOrigin||C.POLICY.expected.server);if(testOrigin&&!(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'))C.fail('TEST_ORIGIN_FORBIDDEN');if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)C.fail('ORIGIN_INVALID');
 function request(method,route,body,budgetMs){if(!Number.isFinite(budgetMs)||budgetMs<=0||budgetMs>120000)C.fail('HTTP_BUDGET_INVALID');const deadline=performance.now()+budgetMs;
  return new Promise((resolve,reject)=>{let req,timer,done=false;const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);};
   try{const payload=body===undefined?null:Buffer.from(JSON.stringify(body));req=(origin.protocol==='https:'?https:http).request({hostname:origin.hostname,port:origin.port||undefined,method,path:route,agent:false,headers:{'X-Token':secret.token,'X-Username':secret.token,Accept:'application/json',...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}},res=>{const chunks=[];let size=0;
    res.on('data',b=>{size+=b.length;if(size>20*1048576){finish(new C.Failure('HTTP_RESPONSE_TOO_LARGE'));req.destroy();}else chunks.push(b);});
    res.on('aborted',()=>finish(new C.Failure('HTTP_BODY_ABORTED')));res.on('error',()=>finish(new C.Failure('HTTP_BODY_ERROR')));
    res.on('end',()=>{if(done)return;if(performance.now()>deadline){finish(new C.Failure('HTTP_DEADLINE'));return;}if(res.statusCode!==200){finish(new C.Failure([401,403].includes(res.statusCode)?'HTTP_AUTH_REJECTED':([429,500,502,503,504].includes(res.statusCode)?'HTTP_TRANSIENT_STATUS':'HTTP_STATUS_REJECTED')));return;}let x;try{x=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish(new C.Failure('HTTP_JSON_INVALID'));return;}if(!C.obj(x)||x.ok!==1){finish(new C.Failure('API_RESULT_NOT_SUCCESS'));return;}finish(null,x);});});
    req.on('error',()=>finish(new C.Failure('HTTP_TRANSPORT_ERROR')));timer=setTimeout(()=>{finish(new C.Failure('HTTP_DEADLINE'));req.destroy();},Math.max(1,deadline-performance.now()));req.end(payload);
   }catch{req?.destroy();finish(new C.Failure('HTTP_REQUEST_FAILED'));}
  });
 }
 return Object.freeze({time:ms=>request('GET','/api/game/time?shard=shard1',undefined,ms),overview:ms=>request('GET','/api/user/overview?shard=shard1&interval=8',undefined,ms),upload:(m,head,tree,ms)=>{I.candidate(m,head,tree);return request('POST','/api/user/code',{branch:'default',modules:m},ms);},me:ms=>request('GET','/api/auth/me',undefined,ms),branches:ms=>request('GET','/api/user/branches',undefined,ms),code:ms=>request('GET','/api/user/code?branch=default',undefined,ms),restore:(m,ms)=>{if(!C.same(I.digest(m),C.POLICY.backupDigest))C.fail('RESTORE_PAYLOAD_NOT_CANONICAL');return request('POST','/api/user/code',{branch:'default',modules:m},ms);}});
}
module.exports={client};
