'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const C=require('../runtime/common.cjs'),F=require('./fixture.cjs'),T=require('../runtime/transport.cjs'),A=require('../runtime/closure.cjs'),V=require('../runtime/verify-closure.cjs');
async function server(mode='normal'){
 const s=F.session();let modules=s.candidate.modules,posts=0;const requests=[];
 const srv=http.createServer((req,res)=>{requests.push(req.method+' '+req.url);let text='';req.on('data',b=>text+=b);req.on('end',()=>{
  if(mode==='hang')return;if(mode==='auth'){res.writeHead(401);res.end(F.secret.token);return;}if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid/'});res.end();return;}
  if(mode==='bad-json'){res.end('{broken '+F.secret.token);return;}
  let response={ok:1};
  if(req.url==='/api/auth/me')response={ok:1,_id:s.userId,username:s.username};
  else if(req.url==='/api/user/branches')response={ok:1,list:[{branch:'default',activeWorld:true}]};
  else if(req.method==='GET'&&req.url==='/api/user/code?branch=default')response={ok:1,modules};
  else if(req.method==='POST'&&req.url==='/api/user/code'){posts++;const b=JSON.parse(text);assert.equal(b.branch,'default');modules=b.modules;if(mode==='lost-ack'){req.socket.destroy();return;}}
  else{res.writeHead(404);res.end();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));
 });});
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+srv.address().port;
 return {s,origin,srv,requests,get posts(){return posts;},stop:async()=>{srv.closeAllConnections();await new Promise(r=>srv.close(r));}};
}
test('loopback full closure issues exactly one backup POST and only allowed GET endpoints',async()=>{const h=await server(),root=F.root();try{
 const prior=path.join(root,'prior'),out=path.join(root,'out');F.priorFiles(prior,h.s);
 const api=T.createClient(F.secret,{testOrigin:h.origin,expectedBackupMainSha256:C.sha256(h.s.backup.modules.main)});
 const r=await A.close0003({api,s:h.s,prior,out,executeRecovery:true,exclusiveTarget:true,priorWorkersStopped:true,secret:F.secret,pause:async()=>{},observer:F.fastObserver});
 assert.equal(r.runtimeConfirmed,true);assert.equal(h.posts,1);assert.equal(V.verifyClosure(out,h.s,{runtimeMs:250,silenceMs:1000}).status,'RECOVERY_CLOSURE_VERIFIED');
 assert.ok(h.requests.every(x=>['GET /api/auth/me','GET /api/user/branches','GET /api/user/code?branch=default','POST /api/user/code'].includes(x)));
 }finally{fs.rmSync(root,{recursive:true,force:true});await h.stop();}});
test('transport cannot upload a candidate or arbitrary modules',async()=>{const h=await server();try{const api=T.createClient(F.secret,{testOrigin:h.origin,expectedBackupMainSha256:C.sha256(h.s.backup.modules.main)});
 await assert.rejects(api.restoreBackup(h.s.candidate.modules),{code:'ONLY_PINNED_BACKUP_WRITE_ALLOWED'});assert.equal(h.posts,0);
 assert.deepEqual(Object.keys(api).sort(),['branches','code','me','restoreBackup']);}finally{await h.stop();}});
test('transport never retries an acknowledged restore',async()=>{const h=await server();try{const api=T.createClient(F.secret,{testOrigin:h.origin,expectedBackupMainSha256:C.sha256(h.s.backup.modules.main)});await api.restoreBackup(h.s.backup.modules);await assert.rejects(api.restoreBackup(h.s.backup.modules),{code:'RESTORE_CLIENT_ALREADY_USED'});assert.equal(h.posts,1);}finally{await h.stop();}});
test('real lost HTTP acknowledgement remains single-use while GET can reconcile bytes',async()=>{const h=await server('lost-ack');try{const api=T.createClient(F.secret,{testOrigin:h.origin,expectedBackupMainSha256:C.sha256(h.s.backup.modules.main)});await assert.rejects(api.restoreBackup(h.s.backup.modules));await assert.rejects(api.restoreBackup(h.s.backup.modules),{code:'RESTORE_CLIENT_ALREADY_USED'});assert.deepEqual((await api.code()).modules,h.s.backup.modules);assert.equal(h.posts,1);}finally{await h.stop();}});
for(const [mode,error]of [['auth','HTTP_AUTH_REJECTED'],['redirect','HTTP_NOT_200'],['bad-json','HTTP_JSON_INVALID'],['hang','HTTP_DEADLINE']])
 test('HTTP '+mode+' returns a stable error without response or credential text',async()=>{const h=await server(mode);try{const api=T.createClient(F.secret,{testOrigin:h.origin,timeoutMs:50});await assert.rejects(api.me(),e=>{assert.equal(e.code,error);assert.ok(!JSON.stringify(e).includes(F.secret.token));return true;});assert.equal(h.requests.length,1);}finally{await h.stop();}});
test('test origin cannot point to another external service',()=>assert.throws(()=>T.createClient(F.secret,{testOrigin:'https://example.com/'}),{code:'TEST_ORIGIN_INVALID'}));
