'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function git(repo,...args){return cp.execFileSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','-C',repo,...args],{encoding:null,stdio:['ignore','pipe','pipe']});}
const text=(repo,...args)=>git(repo,...args).toString('utf8').trim();
function integrity(root){
 const files={};
 function walk(dir,rel=''){
  for(const name of fs.readdirSync(dir).sort()){
   const next=rel?rel+'/'+name:name,file=path.join(dir,name),st=fs.lstatSync(file);
   if(st.isSymbolicLink())throw new Error('fixture symlink forbidden');
   if(st.isDirectory())walk(file,next);
   else if(next!=='INTEGRITY.json'){const bytes=fs.readFileSync(file);files[next]={bytes:bytes.length,sha256:sha(bytes)};}
  }
 }
 walk(root);fs.writeFileSync(path.join(root,'INTEGRITY.json'),JSON.stringify({kind:'package-integrity/v1',files},null,2)+'\n');
}
function init(repo,branch){fs.mkdirSync(repo);git(repo,'init','-b',branch);git(repo,'config','user.name','FC1 Fixture');git(repo,'config','user.email','fc1-fixture@example.invalid');}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fc1-admission-flow-')),pkg=path.join(root,'executor'),repo=path.join(root,'compat');
 fs.cpSync(ROOT,pkg,{recursive:true});
 const p=JSON.parse(fs.readFileSync(path.join(pkg,'policy.json'),'utf8'));
 init(repo,p.compatBranch);fs.mkdirSync(path.join(repo,'src/runtime'),{recursive:true});
 fs.writeFileSync(path.join(repo,'src/runtime/treasuryCompatConfig.ts'),'export const config = "OFF";\n');
 fs.writeFileSync(path.join(repo,'before.txt'),'base\n');git(repo,'add','.');git(repo,'commit','-m','fixture-base');
 p.implementationBase=text(repo,'rev-parse','HEAD');
 fs.writeFileSync(path.join(repo,'before.txt'),'after\n');fs.writeFileSync(path.join(repo,'new.txt'),'new\n');
 const runtime=`export const FULL_COST_EXPERIMENT = "${p.runtimeEmitterId}";\n`;
 fs.writeFileSync(path.join(repo,'src/runtime/treasuryCompatRuntime.ts'),runtime);
 git(repo,'add','.');git(repo,'commit','-m',p.sourceMessage);
 p.compatBase=p.implementationHead=text(repo,'rev-parse','HEAD');p.compatBaseTree=text(repo,'rev-parse','HEAD^{tree}');
 const files={};for(const name of ['before.txt','new.txt','src/runtime/treasuryCompatRuntime.ts']){const bytes=fs.readFileSync(path.join(repo,name));files[name]={after:{bytes:bytes.length,sha256:sha(bytes)}};}
 fs.writeFileSync(path.join(pkg,'source-manifest.json'),JSON.stringify({expectedSourceTree:p.compatBaseTree,runtimeEmitterId:p.runtimeEmitterId,files},null,2)+'\n');
 fs.writeFileSync(path.join(pkg,'policy.json'),JSON.stringify(p,null,2)+'\n');integrity(pkg);
 return {root,pkg,repo,p,mod:name=>require(path.join(pkg,name)),close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
module.exports={fixture};
