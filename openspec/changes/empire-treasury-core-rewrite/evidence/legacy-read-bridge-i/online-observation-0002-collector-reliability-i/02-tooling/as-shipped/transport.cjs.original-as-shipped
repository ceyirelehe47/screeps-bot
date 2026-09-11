'use strict';
const http=require('node:http');
const https=require('node:https');
const {performance}=require('node:perf_hooks');
const {Failure,fail,obj,remaining,EXPECTED}=require('./common.cjs');
/** Narrow transport: no automatic retries, redirects, console injection, or Memory writes.
 * Socket destroy bounds LOCAL waiting; it does NOT prove an accepted server write was cancelled. */
function client(secret, {testOrigin, timeoutMs=8000}={}) {
  const origin=testOrigin?new URL(testOrigin):new URL(EXPECTED.server);
  if(testOrigin && !(origin.protocol==='http:' && origin.hostname==='127.0.0.1')) fail('INVALID_TEST_ORIGIN');
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash) fail('INVALID_ORIGIN');
  function request(method, pathname, body, budgetMs=timeoutMs) {
    return new Promise((resolve,reject)=>{
      if(!Number.isFinite(budgetMs)||budgetMs<=0) {reject(new Failure('OPERATION_DEADLINE'));return;}
      const deadline=performance.now()+Math.min(budgetMs,timeoutMs);
      const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
      let finished=false,req,timer;
      const finish=(err,value)=>{if(finished)return;finished=true;clearTimeout(timer);err?reject(err):resolve(value);};
      try {
        req=(origin.protocol==='https:'?https:http).request({hostname:origin.hostname,port:origin.port||undefined,
          method,path:pathname,agent:false,
          headers:{'X-Token':secret.token,'X-Username':secret.token,Accept:'application/json',
            ...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{})}}, res=>{
          const chunks=[];let size=0;
          res.on('data', b=>{size+=b.length;if(size>20*1024*1024){finish(new Failure('HTTP_RESPONSE_TOO_LARGE'));req.destroy();}else chunks.push(b);});
          res.on('aborted',()=>finish(new Failure('HTTP_BODY_ABORTED')));
          res.on('error',()=>finish(new Failure('HTTP_BODY_ERROR')));
          res.on('end',()=>{
            if(finished)return;
            if(performance.now()>deadline){finish(new Failure('HTTP_DEADLINE'));return;}
            if(res.statusCode!==200){
              const n=Number(res.headers['retry-after']);
              finish(new Failure('HTTP_NOT_200',{httpStatus:res.statusCode,
                ...(Number.isFinite(n)&&n>=0?{retryAfterSeconds:n}:{})}));return;
            }
            let data;try {data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish(new Failure('HTTP_JSON_INVALID'));return;}
            if(!obj(data)||data.ok!==1){finish(new Failure('API_RESULT_NOT_SUCCESS'));return;}
            finish(null,data);
          });
        });
        req.on('error',()=>finish(new Failure('HTTP_TRANSPORT_ERROR')));
        timer=setTimeout(()=>{finish(new Failure('HTTP_DEADLINE'));req.destroy();},Math.max(1,remaining(deadline)));
        req.end(payload);
      }catch{if(req)req.destroy();finish(new Failure('HTTP_REQUEST_FAILED'));}
    });
  }
  return Object.freeze({
    me: ms=>request('GET','/api/auth/me',undefined,ms),
    branches:ms=>request('GET','/api/user/branches',undefined,ms),
    code:(branch,ms)=>{if(typeof branch!=='string'||!branch.length)fail('EXPLICIT_BRANCH_REQUIRED');return request('GET','/api/user/code?branch='+encodeURIComponent(branch),undefined,ms);},
    setCode:(branch,modules,ms)=>{if(branch!==EXPECTED.branch)fail('WRONG_WRITE_BRANCH');return request('POST','/api/user/code',{branch,modules},ms);},
    overview:(shard,ms)=>request('GET','/api/user/overview?shard='+encodeURIComponent(shard)+'&interval=8',undefined,ms),
    time:(shard,ms)=>request('GET','/api/game/time?shard='+encodeURIComponent(shard),undefined,ms),
    queryToken:ms=>request('GET','/api/auth/query-token?token='+encodeURIComponent(secret.token),undefined,ms),
  });
}
module.exports={client};
