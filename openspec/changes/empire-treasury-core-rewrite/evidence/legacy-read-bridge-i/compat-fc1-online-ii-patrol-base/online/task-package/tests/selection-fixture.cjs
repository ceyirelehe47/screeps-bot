'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../runtime/common.cjs'),ROOT=path.resolve(__dirname,'..');
function fixture({rateMs=4500,startTick=73876223,latencyMs=1400,policy={},hook=null}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xv-selector-')),pkg=path.join(root,'pkg'),dir=path.join(root,'run');
 fs.cpSync(ROOT,pkg,{recursive:true});fs.mkdirSync(dir);
 const p=JSON.parse(fs.readFileSync(path.join(pkg,'policy.json')));
 const text=`const BUILD_COMMIT = "${'b'.repeat(40)}";\nconst BUILD_TREE = "${'c'.repeat(40)}";\nconst BUILD_DEPLOY_BRANCH = "default";\nconst BUILD_TAG = "selector-test";\n`;
 const backup={main:text},digest=require('../runtime/identity.cjs').digest(backup);
 p.backupDigest=digest;p.backupBuild={commit:'b'.repeat(40),tree:'c'.repeat(40),deployBranch:'default',tag:'selector-test'};
 for(const[k,v]of Object.entries(policy))p[k]=typeof v==='object'?{...p[k],...v}:v;
 fs.writeFileSync(path.join(pkg,'policy.json'),JSON.stringify(p,null,2)+'\n');
 const mod=n=>require(path.join(pkg,n)),CC=mod('runtime/common.cjs');
 const files={};for(const n of CC.list(pkg).filter(n=>n!=='INTEGRITY.json')){const b=fs.readFileSync(path.join(pkg,n));files[n]={bytes:b.length,sha256:CC.sha(b)};}
 fs.writeFileSync(path.join(pkg,'INTEGRITY.json'),JSON.stringify({kind:'package-integrity/v1',files},null,2)+'\n');
 const c={id:crypto.randomBytes(16).toString('hex'),now:0,offset:1700000000000,
   mono(){return this.now;},wall(){return this.offset+this.now;},async pause(ms){this.now+=ms;}};
 let current=backup,timeCalls=0,writes=0;const calls=[];
 const request=async(name,ms,value)=>{const call={name,ms,at:c.now,index:calls.length+1};calls.push(call);
   if(hook)await hook({call,c,C:CC,setCurrent:x=>{current=x;}});
   if(latencyMs>ms){c.now+=ms;throw new CC.Failure('HTTP_DEADLINE');}
   c.now+=latencyMs;return typeof value==='function'?value():value;};
 const api={me:ms=>request('me',ms,()=>({ok:1,_id:p.expected.userId,username:p.expected.username})),
   branches:ms=>request('branches',ms,()=>({ok:1,list:[{branch:p.expected.branch,activeWorld:true}]})),
   code:ms=>request('code',ms,()=>({ok:1,modules:current})),
   overview:ms=>request('overview',ms,()=>({ok:1,shards:{[p.expected.shard]:{rooms:p.rooms}}})),
   time:ms=>{timeCalls++;return request('time',ms,()=>({ok:1,time:startTick+Math.floor(c.now/rateMs)}));},
   upload:async()=>{writes++;throw Error('WRITE_FORBIDDEN_IN_SELECTOR');},restore:async()=>{writes++;throw Error('WRITE_FORBIDDEN_IN_SELECTOR');}};
 const selector=mod('runtime/window-selection.cjs');
 return {root,pkg,dir,p,c,api,calls,mod,C:CC,selector,get writes(){return writes;},get timeCalls(){return timeCalls;},
   run:()=>selector.select(api,dir,{c,pause:ms=>c.pause(ms)}),close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
module.exports={fixture};
