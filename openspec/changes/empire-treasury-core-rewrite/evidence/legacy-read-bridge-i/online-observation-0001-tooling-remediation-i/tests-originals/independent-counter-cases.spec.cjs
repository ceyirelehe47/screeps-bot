'use strict';
// 独立反例套件（Agent 构造，不属于任务包）。
// 覆盖 AGENT-RUN.md §4 要求的九类反例；每类带合法正对照，不允许靠另一个前置错误提前失败。
// 针对 KIT 修复后版本（tools/ 未改动，tests/collector-wire.spec.cjs 已做 win32 适配）。
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),cp=require('node:child_process'),{EventEmitter}=require('node:events');
const KIT='D:/code/screeps/incoming/compat-online-tooling-r1/treasury-compat-online-tooling-remediation-I';
const C=require(KIT+'/tools/common.cjs'),P=require(KIT+'/tools/protocol.cjs'),OPS=require(KIT+'/tools/operations.cjs'),S=require(KIT+'/tools/session.cjs'),{runBounded}=require(KIT+'/tools/bounded-child.cjs');
const guard=require(KIT+'/references/deployGuard.cjs');
const ROOT=KIT;
const code=f=>a.throws(()=>f(),e=>e instanceof C.Failure&&typeof e.code==='string'&&e.code.length>0,e=>`expect Failure got ${e}`);
function wsFrame(text){const b=Buffer.from(text);let h;if(b.length<126)h=Buffer.from([0x81,b.length]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(b.length,2);}return Buffer.concat([h,b]);}
function mkRun(dir,over={}){const backup=P.makeSnapshot({main:'ORIGINAL'},guard),candidate=P.makeSnapshot({main:'DEPLOYED'},guard);
 C.writeNew(path.join(dir,'backup.json'),backup);C.writeNew(path.join(dir,'candidate.json'),candidate);
 const session={kind:'compat-online-run-v1',runId:'d'.repeat(32),...C.EXPECTED,preparedAtMs:Date.now(),wallLimitMs:5400000,
  profile:{enabled:true,shardName:'shard1',rooms:['E3N59'],resources:['energy','H'],startTick:1000,endTick:2100,intervalTicks:100,minBucket:2000,maxSampleCpu:2,reserveCpu:5,maxLogBytes:16384},
  backupFileSha256:C.sha256(fs.readFileSync(path.join(dir,'backup.json'))),candidateFileSha256:C.sha256(fs.readFileSync(path.join(dir,'candidate.json'))),...over};
 C.writeNew(path.join(dir,'session.json'),session);return {backup,candidate,session};}
async function serve(handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s;}
async function spawnCli(name,args,env){return new Promise(res=>{const c=cp.spawn(process.execPath,[path.join(ROOT,'tools',name),...args],{env,stdio:['ignore','pipe','pipe']});
 let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);
 const t=setTimeout(()=>{c.kill('SIGKILL');res({code:null,out,err,killed:true});},15000);
 c.once('close',code=>{clearTimeout(t);res({code,out,err});});});}
function cliEnv(fixture){return {...process.env,COMPAT_CLI_TEST_FIXTURE:fixture,NODE_OPTIONS:`--require=${path.join(ROOT,'tests/cli-preload.cjs')}`};}

test('类3b folded_out dirty 形态：rollup属性消除产物可判 folded_out；脏字面量/无签名仍拒绝',()=>{
 const head='a'.repeat(40),tree='b'.repeat(40);
 const wrap=s=>({main:s+'\n;globalThis.__DEPLOY_BUNDLE_HASH__="'+C.sha256(s)+'";\n'});
 const consts=(dirtyLine)=>['const BUILD_COMMIT = "'+head+'";','const BUILD_TREE = "'+tree+'";','const BUILD_TAG = "tag";','const BUILD_DEPLOY_BRANCH = "default";',dirtyLine].join('\n');
 const folded=consts('')+ '\nconst BUILD_INFO = {\n tag: BUILD_TAG,\n commit: BUILD_COMMIT,\n tree: BUILD_TREE,\n deployBranch: BUILD_DEPLOY_BRANCH,\n get bundleHash() {\n return readDeployBundleHash();\n },\n};';
 const r=P.confirmBuild(wrap(folded),head,tree); // 正对照：真实消除形态（无dirty属性、无BUILD_DIRTY、三常量引用签名）
 a.equal(r.dirty,'folded_out');a.equal(r.deployBranch,'default');
 a.equal(P.buildIdentity(wrap(consts('const BUILD_DIRTY = "false";')).main).dirty,'false'); // 正对照：直接字面量
 code(()=>P.confirmBuild(wrap(consts('const BUILD_DIRTY = "true";')),head,tree)); // 反例：脏树声明必须拒绝
 const noSig=consts('')+'\nconst BUILD_INFO = {\n commit: BUILD_COMMIT,\n};';
 a.equal(P.buildIdentity(wrap(noSig).main).dirty,'not_read'); // 反例：缺 tree/deployBranch 引用签名 → 不采信
 code(()=>P.confirmBuild(wrap(noSig),head,tree));
 const stray=consts('')+ '\nconst BUILD_INFO = {\n commit: BUILD_COMMIT,\n tree: BUILD_TREE,\n deployBranch: BUILD_DEPLOY_BRANCH,\n};\nconst X = BUILD_DIRTY;';
 a.equal(P.buildIdentity(wrap(stray).main).dirty,'not_read'); // 反例：残留 BUILD_DIRTY 痕迹 → 不采信消除形态
 code(()=>P.confirmBuild(wrap(stray),head,tree));
});
test('类1 activeWorld：多/零/类型错/换分支拒绝，唯一真值且activeSim不干扰为正',()=>{
 code(()=>P.activeBranch({ok:1,list:[{branch:'default',activeWorld:true},{branch:'sim',activeWorld:true}]}));
 code(()=>P.activeBranch({ok:1,list:[{branch:'default',activeWorld:false},{branch:'sim',activeWorld:false}]}));
 code(()=>P.activeBranch({ok:1,list:[{branch:'default',activeWorld:'true'}]}));
 code(()=>P.activeBranch({ok:1,list:[{branch:'world2',activeWorld:true}]}));
 a.equal(P.activeBranch({ok:1,list:[{branch:'default',activeWorld:true},{branch:'sim',activeSim:true}]}),'default');
});
test('类2 modules响应：ok0/缺字段/空/数组/null/缺main拒绝；文本与合法二进制为正',()=>{
 for(const bad of [{ok:0},{ok:1},{ok:1,modules:{}},{ok:1,modules:[]},{ok:1,modules:null},{ok:1,modules:{helper:'x'}}])code(()=>P.modulesFromResponse(bad));
 a.equal(P.modulesFromResponse({ok:1,modules:{main:'a'}}).main,'a');
 const b=P.modulesFromResponse({ok:1,modules:{main:'x',logo:{binary:'aGVsbG8='}}});
 a.equal(b.logo.binary,'aGVsbG8=');
});
test('类3 文本/二进制：bin:前缀文本与同值二进制集合摘要相同但必须判不等；真相等为正',()=>{
 // main 必须是非空文本（validateModules 的正确约束），用第二模块承载类型对比
 const text={main:'x',logo:'bin:'+'QUJD'.repeat(3)},bin={main:'x',logo:{binary:'QUJD'.repeat(3)}};
 a.equal(guard.computeModulesHash(text),guard.computeModulesHash(bin)); // 原算法输入串确实相同
 a.equal(P.equalModules(text,bin,guard),false);                          // 逐模块类型/内容差异必须拦截
 a.equal(P.equalModules(text,{main:'x',logo:text.logo},guard),true);
 a.equal(P.equalModules(bin,{main:'x',logo:{binary:bin.logo.binary}},guard),true);
 const d=P.describeModules(bin,guard);a.equal(d.files.find(f=>f.name==='logo').kind,'binary');
 a.equal(P.describeModules(text,guard).files.find(f=>f.name==='logo').kind,'text');
});
function mockApi(current,opts={}){const calls={setCode:0,reads:0};
 const next=()=>{calls.reads++;return {ok:1,modules:typeof current==='function'?current():current};};
 return {calls,api:Object.freeze({
  me:async()=>({ok:1,_id:C.EXPECTED.userId,username:C.EXPECTED.username}),
  branches:async()=>({ok:1,list:[{branch:'default',activeWorld:true}]}),
  code:async()=>next(),
  setCode:async(branch,modules)=>{calls.setCode++;opts.onPost&&opts.onPost();if(opts.postResult==='timeout')throw new C.Failure('HTTP_DEADLINE');if(opts.postResult!=='stuck')current=modules;return {ok:1};}})};}
test('类4 恢复回读失败：POST成功但字节未恢复→不确认；回读一致为正',async()=>{
 const backup=P.makeSnapshot({main:'ORIGINAL'},guard),deployed=P.makeSnapshot({main:'DEPLOYED'},guard);
 const m1=mockApi({main:'DEPLOYED'},{postResult:'stuck'}); // POST 返回 ok 但服务端字节未恢复
 const r1=await OPS.restore(m1.api,guard,backup,deployed,{execute:true});
 a.equal(r1.status,'ONLINE_CLOSE_UNCONFIRMED');a.equal(r1.requestAttempted,true);a.equal(r1.confirmed,false);
 const m2=mockApi({main:'DEPLOYED'}); // 正对照：POST 后真实生效
 const r2=await OPS.restore(m2.api,guard,backup,deployed,{execute:true});
 a.equal(r2.status,'RESTORED_AND_VERIFIED');a.equal(r2.confirmed,true);a.equal(m2.calls.setCode,1);
});
test('类5 挂起子进程：超时杀掉仍确认关闭；kill后close永不到达时childClosed=false；正常退出为正',async()=>{
 const ok=await runBounded(process.execPath,['-e','process.exit(0)'],{timeoutMs:5000});
 a.equal(ok.code,0);a.equal(ok.childClosed,true);a.equal(ok.timedOut,false);
 const hung=await runBounded(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:600,killGraceMs:3000});
 a.equal(hung.timedOut,true);a.equal(hung.killRequested,true);a.equal(hung.childClosed,true);
 const fake={stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){},once(){},unref(){}};
 fake.stdout.destroy=()=>{};fake.stderr.destroy=()=>{};
 const never=await runBounded('node',['-e','hang'],{timeoutMs:150,killGraceMs:120,spawnFn:()=>fake});
 a.equal(never.childClosed,false);a.equal(never.code,null);a.equal(never.killRequested,true); // 无法确认退出绝不叫成功
});
test('类6 活PID无有效console：console静默/心跳过旧/错实例触发关闭；新鲜同实例为正',()=>{
 const now=Date.now(),s={runId:'d'.repeat(32),userId:C.EXPECTED.userId,shard:'shard1',profile:{startTick:1000,endTick:2100},wallLimitMs:5400000};
 const good={runId:s.runId,pid:process.pid,userId:s.userId,shard:'shard1',state:'streaming',updatedAtMs:now,lastConsoleAtMs:now};
 a.equal(S.heartbeatReason(good,s,now),null);
 a.equal(S.heartbeatReason({...good,lastConsoleAtMs:now-46000},s,now),'collector_stalled');
 a.equal(S.heartbeatReason({...good,updatedAtMs:now-11000},s,now),'collector_stalled');
 a.equal(S.heartbeatReason({...good,runId:'e'.repeat(32)},s,now),'collector_identity_or_state');
 const attempt={runId:s.runId,startedAtMs:now-100};
 a.equal(S.triggerReason({session:s,heartbeat:good,now,attempt,tick:1500}),'bridge_sample_stalled'); // 活PID心跳新鲜但桥样本停滞
 a.equal(S.triggerReason({session:s,heartbeat:{...good,lastBridgeTick:1500},now,attempt,tick:1500}),null); // 正对照：样本在跟
 a.equal(S.triggerReason({session:s,heartbeat:good,now,attempt:{...attempt,startedAtMs:now-s.wallLimitMs-1}}),'wall_deadline');
 a.equal(S.triggerReason({session:s,heartbeat:good,now,attempt,tick:2101}),'tick_window_ended');
});
test('类7 日志IO故障：audit目标不可写时抛错；可写路径追加成功为正',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc7-'));
 fs.mkdirSync(path.join(dir,'console.jsonl')); // 目录占位：appendFileSync 必然失败
 a.throws(()=>C.audit(path.join(dir,'console.jsonl'),{kind:'x'},C.redactor(['secret-value-1234'])));
 const f=path.join(dir,'ok.jsonl');C.audit(f,{kind:'x',note:'secret-value-1234'},C.redactor(['secret-value-1234']));
 const line=fs.readFileSync(f,'utf8');a.ok(line.includes('"kind":"x"'));a.ok(!line.includes('secret-value-1234'));
 fs.rmSync(dir,{recursive:true,force:true});
});
test('类7b 实际collector进程：console.jsonl不可写→exit 1非零且不外泄异常正文；可写→streaming+guard-result优雅退出为正',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc7b-'));const sockets=new Set();
 const server=await serve((q,r)=>r.end(JSON.stringify({ok:1,_id:C.EXPECTED.userId,username:C.EXPECTED.username})));
 server.on('upgrade',(q,socket)=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  const acc=crypto.createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
  setTimeout(()=>socket.write(wsFrame('auth ok')),10);});
 try{
  const fixture=path.join(dir,'env.json');
  const run1=path.join(dir,'run-bad');fs.mkdirSync(run1);mkRun(run1);fs.mkdirSync(path.join(run1,'console.jsonl')); // IO 故障注入
  C.writeNew(fixture,{origin:'http://127.0.0.1:'+server.address().port,websocketOrigin:'ws://127.0.0.1:'+server.address().port+'/socket/websocket'});
  const r1=await spawnCli('console-collector.cjs',['--repo',run1,'--secret','unused','--run',run1],cliEnv(fixture));
  a.equal(r1.code,1);
  a.equal(C.readJson(path.join(run1,'heartbeat.json')).stopReason,'collector_parse_or_io_failure');
  a.ok(!r1.err.includes('EACCES')&&!r1.err.includes('EISDIR'),`stderr leaked: ${r1.err}`); // 不输出原始异常正文
  const run2=path.join(dir,'run-good');fs.mkdirSync(run2);mkRun(run2);
  const env=cliEnv(fixture);
  const c2=cp.spawn(process.execPath,[path.join(ROOT,'tools/console-collector.cjs'),'--repo',run2,'--secret','unused','--run',run2],{env,stdio:['ignore','pipe','pipe']});
  let err2='';c2.stderr.on('data',b=>err2+=b);
  const began=Date.now();let h;
  while(Date.now()-began<2500){await C.pause(20);try{h=C.readJson(path.join(run2,'heartbeat.json'));if(h.state==='streaming')break;}catch{}}
  a.equal(h.state,'streaming',err2);
  a.ok(fs.readFileSync(path.join(run2,'console.jsonl'),'utf8').includes('auth-confirmed'));
  C.atomicJson(path.join(run2,'guard-result.json'),{runId:h.runId,status:'ONLINE_BYTES_RESTORED'});
  const end=new Promise(r=>c2.once('close',r));
  a.equal(await Promise.race([end,C.pause(10000).then(()=>{throw Error('collector exit timeout '+err2);})]),0);
 }finally{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('类9 函数级：上传结果未决时读到原件不得宣称已恢复；无未决时幂等为正',async()=>{
 const backup=P.makeSnapshot({main:'ORIGINAL'},guard),deployed=P.makeSnapshot({main:'DEPLOYED'},guard);
 const m=mockApi({main:'ORIGINAL'}); // 服务器当前就是原件
 const r1=await OPS.restore(m.api,guard,backup,deployed,{execute:true,unresolvedUpload:true});
 a.equal(r1.status,'ONLINE_CLOSE_UNCONFIRMED');a.equal(r1.reason,'UPLOAD_OUTCOME_UNRESOLVED');a.equal(r1.requestAttempted,false);a.equal(r1.confirmed,false);
 a.equal(m.calls.setCode,0);
 const r2=await OPS.restore(m.api,guard,backup,deployed,{execute:true,unresolvedUpload:false});
 a.equal(r2.status,'ALREADY_RESTORED');a.equal(r2.confirmed,true);a.equal(m.calls.setCode,0);
});
test('类8+9 进程级：同一次启用重复调用被拒且零POST零closing；未决上传后远端为原件→restore不确认',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc8-'));let state={main:'ORIGINAL'},posts=0;
 const server=await serve((q,r)=>{const json=(x,s=200)=>{r.writeHead(s);r.end(JSON.stringify(x));};
  if(q.url==='/api/auth/me')json({ok:1,_id:C.EXPECTED.userId,username:C.EXPECTED.username});
  else if(q.url==='/api/user/branches')json({ok:1,list:[{branch:'default',activeWorld:true}]});
  else if(q.url.startsWith('/api/user/overview'))json({ok:1,shards:{shard1:{rooms:['E3N59']}}});
  else if(q.url.startsWith('/api/game/time'))json({ok:1,time:350});
  else if(q.method==='GET'&&q.url.startsWith('/api/user/code'))json({ok:1,modules:state});
  else if(q.method==='POST'&&q.url==='/api/user/code'){let b='';q.on('data',x=>b+=x);q.on('end',()=>{posts++;state=JSON.parse(b).modules;json({ok:1});});}
  else json({ok:0},404);});
 try{
  const {session}=mkRun(dir,{profileHead:'e'.repeat(40),profileTree:'f'.repeat(40)});
  const fixture=path.join(dir,'env.json');
  C.writeNew(fixture,{origin:'http://127.0.0.1:'+server.address().port,profileHead:session.profileHead,profileTree:session.profileTree});
  const env=cliEnv(fixture),args=['--repo',dir,'--secret','unused','--run',dir];
  const now=Date.now();
  C.writeNew(path.join(dir,'guard-ready.json'),{runId:session.runId,pid:process.pid,updatedAtMs:now,state:'ready'});
  C.writeNew(path.join(dir,'heartbeat.json'),{runId:session.runId,pid:process.pid,userId:session.userId,shard:'shard1',state:'streaming',updatedAtMs:now,lastConsoleAtMs:now});
  const first=await spawnCli('upload-once.cjs',[...args,'--execute'],env);
  a.equal(first.code,0,first.err+' '+first.out);a.equal(posts,1);a.deepEqual(state,{main:'DEPLOYED'});
  const attemptBytes=fs.readFileSync(path.join(dir,'upload-attempt.json'));
  // 类8：同一次启用重复调用
  const dup=await spawnCli('upload-once.cjs',[...args,'--execute'],env);
  a.notEqual(dup.code,0);a.ok(dup.err.includes('UPLOAD_ALREADY_ATTEMPTED'));
  a.equal(posts,1); // 零第二次 POST
  a.deepEqual(fs.readFileSync(path.join(dir,'upload-attempt.json')),attemptBytes); // attempt 原字节未动
  a.equal(fs.existsSync(path.join(dir,'closing.json')),false); // 失败路径未伪造关闭
  // 类9：上传已确认成功（upload-result 存在且 confirmed）后服务器其实又变回原件→restore 幂等确认
  state={main:'ORIGINAL'};
  const r2=await spawnCli('restore-modules.cjs',[...args,'--execute'],env);
  a.equal(r2.code,0);a.ok(r2.out.includes('ALREADY_RESTORED'));a.equal(posts,1);
  // 类9 反例：attempt 在、upload-result 缺失（未决）→ 即使读到原件也不确认、零 POST
  fs.unlinkSync(path.join(dir,'upload-result.json'));
  const r3=await spawnCli('restore-modules.cjs',[...args,'--execute'],env);
  a.notEqual(r3.code,0);a.ok(r3.out.includes('ONLINE_CLOSE_UNCONFIRMED'));a.equal(posts,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
