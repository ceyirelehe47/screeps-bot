'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const C=require('./common.cjs'),K=require('./policy.cjs');
const BASE_LOCK=require('../references/source-lock-before-xii.json');
const SUPERSEDED_LOCK=require('../references/source-lock-superseded-v3.json');
const POST_LOCK=require('../references/source-lock.json');
function load(text,name,ts,imports={}){
 const r=ts.transpileModule(text,{fileName:name,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}});
 if((r.diagnostics||[]).some(d=>d.category===ts.DiagnosticCategory.Error))C.fail('PROFILE_TYPESCRIPT_TRANSPILE_FAILED');
 const exports={};new vm.Script(r.outputText,{filename:name}).runInNewContext({exports,require:k=>{if(!Object.hasOwn(imports,k))C.fail('PROFILE_RUNTIME_IMPORT_UNEXPECTED');return imports[k];}},{timeout:1000});return exports;
}
function verifyLock(repo,lock,code){for(const[n,x]of Object.entries(lock)){if(n===K.CONFIG)continue;let b;try{b=fs.readFileSync(path.join(repo,n));}catch{C.fail(code,{path:n});}
 if(b.length!==x.bytes||C.blob(b)!==x.blob||C.sha256(b)!==x.sha256)C.fail(code,{path:n});}return {status:code.replace('_CHANGED','_VERIFIED'),files:Object.keys(lock).length};}
function verifyBaselineFrozen(repo){return verifyLock(repo,BASE_LOCK,'BASELINE_FROZEN_SOURCE_CHANGED');}
function verifySupersededFrozen(repo){return verifyLock(repo,SUPERSEDED_LOCK,'SUPERSEDED_FROZEN_SOURCE_CHANGED');}
function verifyFrozen(repo){return verifyLock(repo,POST_LOCK,'FROZEN_SOURCE_CHANGED');}
function validateProfileLead(cfg,t){if(!Number.isSafeInteger(t)||t<0)C.fail('OBSERVED_TICK_INVALID');if(cfg.startTick<t+100)C.fail('PROFILE_WINDOW_EXPIRED');return t+100;}
function inspectProfile(repo,mode,t,ts){
 if(!['on','off'].includes(mode))C.fail('PROFILE_MODE_INVALID');verifyFrozen(repo);
 const read=n=>fs.readFileSync(path.join(repo,'src/runtime',n),'utf8');
 const cpu=load(read('treasuryCompatCpu.ts'),'treasuryCompatCpu.ts',ts);
 const api=load(read('treasuryCompatRead.ts'),'treasuryCompatRead.ts',ts,{'./treasuryCompatCpu':cpu});
 const bytes=read('treasuryCompatConfig.ts'),cfg=load(bytes,'treasuryCompatConfig.ts',ts).TREASURY_COMPAT_CONFIG;
 if(mode==='on'){K.validProfile(cfg);if(!api.validCompatConfig(cfg))C.fail('PROFILE_ENABLED_INVALID');validateProfileLead(cfg,t);}
 else if(C.blob(Buffer.from(bytes))!==POST_LOCK[K.CONFIG].blob)C.fail('PROFILE_NOT_DEFAULT_OFF');
 return {mode,status:'PROFILE_SOURCE_VALIDATED_ONLY',configSha256:C.sha256(bytes),profile:cfg,dueTicks:mode==='on'?K.dueTicks(cfg):[],deploymentAuthorized:false};
}
module.exports={BASE_LOCK,SUPERSEDED_LOCK,POST_LOCK,load,verifyLock,verifyBaselineFrozen,verifySupersededFrozen,verifyFrozen,inspectProfile,validateProfileLead};
