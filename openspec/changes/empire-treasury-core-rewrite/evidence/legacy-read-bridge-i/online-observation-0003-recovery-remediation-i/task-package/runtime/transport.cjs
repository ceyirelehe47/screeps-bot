'use strict';
const https=require('node:https'),http=require('node:http');
const C=require('./common.cjs'),K=require('./pins.cjs');
/** The only writable method accepts the pinned BACKUP, never a candidate or caller-selected branch. */
function createClient(secret,{testOrigin,expectedBackupMainSha256=K.backupMainSha256,timeoutMs=8000}={}){
 const origin=new URL(testOrigin||C.EXPECTED.server);
 if(testOrigin&&!(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'))C.fail('TEST_ORIGIN_INVALID');
 if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)C.fail('ORIGIN_INVALID');
 let writeUsed=false;
 const safeErrno=e=>['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH'].includes(e?.code)?e.code:'OTHER';
 function request(method,payloadPath,body,ms=timeoutMs){return new Promise((resolve,reject)=>{
  let req,timer,done=false;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v);};
  if(!Number.isFinite(ms)||ms<=0){finish(new C.Failure('HTTP_DEADLINE'));return;}
  const data=body===undefined?null:Buffer.from(JSON.stringify(body));
  try{req=(origin.protocol==='https:'?https:http).request({hostname:origin.hostname,port:origin.port||undefined,method,path:payloadPath,agent:false,
   headers:{'X-Token':secret.token,'X-Username':secret.token,Accept:'application/json',...(data?{'Content-Type':'application/json','Content-Length':data.length}:{})}},res=>{
    let bytes=0;const pieces=[];
    res.on('data',b=>{bytes+=b.length;if(bytes>20*1048576){finish(new C.Failure('HTTP_RESPONSE_TOO_LARGE'));req.destroy();}else pieces.push(b);});
    res.on('aborted',()=>finish(new C.Failure('HTTP_BODY_ABORTED')));res.on('error',()=>finish(new C.Failure('HTTP_BODY_ERROR')));
    res.on('end',()=>{if(done)return;if(res.statusCode!==200){finish(new C.Failure(res.statusCode===401||res.statusCode===403?'HTTP_AUTH_REJECTED':'HTTP_NOT_200'));return;}
     let x;try{x=JSON.parse(Buffer.concat(pieces).toString('utf8'));}catch{finish(new C.Failure('HTTP_JSON_INVALID'));return;}
     if(!C.obj(x)||x.ok!==1){finish(new C.Failure('API_RESULT_NOT_SUCCESS'));return;}finish(null,x);});
   });
   req.on('error',e=>finish(new C.Failure('HTTP_TRANSPORT_'+safeErrno(e))));
   timer=setTimeout(()=>{finish(new C.Failure('HTTP_DEADLINE'));req.destroy();},Math.min(ms,timeoutMs));req.end(data);
  }catch{req?.destroy();finish(new C.Failure('HTTP_REQUEST_FAILED'));}
 });}
 return Object.freeze({
  me:ms=>request('GET','/api/auth/me',undefined,ms),
  branches:ms=>request('GET','/api/user/branches',undefined,ms),
  code:ms=>request('GET','/api/user/code?branch=default',undefined,ms),
  restoreBackup:async modules=>{
   if(!modules||Object.keys(modules).length!==1||typeof modules.main!=='string'||C.sha256(modules.main)!==expectedBackupMainSha256)C.fail('ONLY_PINNED_BACKUP_WRITE_ALLOWED');
   if(writeUsed)C.fail('RESTORE_CLIENT_ALREADY_USED');writeUsed=true;
   return request('POST','/api/user/code',{branch:'default',modules},timeoutMs);
  }
 });
}
module.exports={createClient};
