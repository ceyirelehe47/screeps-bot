'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../runtime/common.cjs'),P=require('../runtime/protocol.cjs'),K=require('../runtime/policy.cjs');
const guard=require('../references/deployGuard.cjs');
function main(commit,tree,tag){const text=`const BUILD_COMMIT = "${commit}";\nconst BUILD_TREE = "${tree}";\nconst BUILD_DIRTY = "false";\nconst BUILD_DEPLOY_BRANCH = "default";\nconst BUILD_TAG = "${tag}";\n`;return text+`\n;globalThis.__DEPLOY_BUNDLE_HASH__="${C.sha256(text)}";\n`;}
function session(){const head='a'.repeat(40),tree='b'.repeat(40),profile=K.profileFor(1000);
 const backup=P.makeSnapshot({main:main(C.PRODUCTION_BASE,C.PRODUCTION_TREE,'fixture-backup')},guard),candidate=P.makeSnapshot({main:main(head,tree,'fixture-candidate')},guard);
 return {kind:K.KIND,runId:'c'.repeat(32),...C.EXPECTED,refactorBase:K.REFACTOR,compatBase:K.COMPAT,profile,observedTick:1000,profileHead:head,profileTree:tree,
  build:P.confirmBuild(candidate.modules,head,tree),backupBuild:P.buildIdentity(backup.modules.main),preparedAtMs:Date.now(),wallLimitMs:K.WALL_MS,backup,candidate,
  toolFingerprint:fs.existsSync(path.join(__dirname,'../INTEGRITY.json'))?C.sha256(fs.readFileSync(path.join(__dirname,'../INTEGRITY.json'))):'f'.repeat(64)};}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cpuDiag-II-'));
function save(run,s){for(const key of ['backup','candidate']){C.durable(path.join(run,key+'.json'),s[key]);s[key+'FileSha256']=C.sha256(fs.readFileSync(path.join(run,key+'.json')));}
 const{backup,candidate,...pub}=s;C.durable(path.join(run,'session.json'),pub);C.durable(path.join(run,'public-session.json'),{...pub,kind:K.PUBLIC_KIND,backupDigest:backup.digest,candidateDigest:candidate.digest});}
function reports(s,{partialFirst=false,partialAll=false}={}){
 const H=require('./reader-fixture.cjs'),f=H.fixture({cost:{readerLoad:partialAll?2.2:0.02,observationBuild:0.02},probeCost:0.001});
 const old=f.ports.readers;let n=0;f.ports.readers=()=>{if(partialFirst&&n++===0)f.charge(2.2);return old();};
 const reader=H.loadReader().exports.createTreasuryCompatPreview(s.profile,f.ports,{cpuDiagnostics:true});
 for(const tick of K.dueTicks(s.profile)){f.setTime(tick);reader.run();}
 return f.logs.map(JSON.parse);
}
function world(s){let modules=C.clone(s.backup.modules),writes=0,time=s.observedTick;const api={
 me:async()=>({ok:1,_id:s.userId,username:s.username}),branches:async()=>({ok:1,list:[{branch:s.branch,activeWorld:true}]}),
 code:async()=>({ok:1,modules:C.clone(modules)}),time:async()=>({ok:1,time}),overview:async()=>({ok:1,shards:{shard1:{rooms:K.ROOMS}}}),
 setCode:async(branch,m)=>{if(branch!==s.branch)throw new Error('branch');modules=C.clone(m);writes++;return {ok:1};}};
 return {api,get modules(){return modules;},set modules(v){modules=C.clone(v);},get writes(){return writes;},set tick(v){time=v;}};
}
function frame(s,logs){return JSON.stringify([`user:${s.userId}/console`,{shard:s.shard,messages:{log:logs,results:[]}}]);}
const secret={token:'FIXTURE_ONLY_TOKEN_1234567890',path:'fixture-secret-unused.json',redact:C.redactor(['FIXTURE_ONLY_TOKEN_1234567890'])};
module.exports={guard,main,session,tmp,save,reports,world,frame,secret};
