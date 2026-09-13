'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const C=require('./common.cjs'),K=require('./policy.cjs');
const LOCK=require('../references/source-lock.json');
function load(text,name,ts,imports={}){
 const r=ts.transpileModule(text,{fileName:name,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}});
 if((r.diagnostics||[]).some(d=>d.category===ts.DiagnosticCategory.Error))C.fail('PROFILE_TYPESCRIPT_TRANSPILE_FAILED');
 const exports={};new vm.Script(r.outputText,{filename:name}).runInNewContext({exports,require:k=>{if(!Object.hasOwn(imports,k))C.fail('PROFILE_RUNTIME_IMPORT_UNEXPECTED');return imports[k];}},{timeout:1000});return exports;
}
function verifyFrozen(repo){for(const[n,x]of Object.entries(LOCK)){if(n===K.CONFIG)continue;const b=fs.readFileSync(path.join(repo,n));
 if(C.blob(b)!==x.blob)C.fail('FROZEN_SOURCE_CHANGED',{path:n});}return true;}
function validateProfileLead(cfg,t){if(!Number.isSafeInteger(t)||t<0)C.fail('OBSERVED_TICK_INVALID');if(cfg.startTick<t+100)C.fail('PROFILE_WINDOW_EXPIRED');return t+100;}
function inspectProfile(repo,mode,t,ts){
 if(!['on','off'].includes(mode))C.fail('PROFILE_MODE_INVALID');verifyFrozen(repo);
 const read=n=>fs.readFileSync(path.join(repo,'src/runtime',n),'utf8');
 const cpu=load(read('treasuryCompatCpu.ts'),'treasuryCompatCpu.ts',ts);
 const api=load(read('treasuryCompatRead.ts'),'treasuryCompatRead.ts',ts,{'./treasuryCompatCpu':cpu});
 const bytes=read('treasuryCompatConfig.ts'),cfg=load(bytes,'treasuryCompatConfig.ts',ts).TREASURY_COMPAT_CONFIG;
 if(mode==='on'){K.validProfile(cfg);if(!api.validCompatConfig(cfg))C.fail('PROFILE_ENABLED_INVALID');validateProfileLead(cfg,t);}
 else if(C.blob(Buffer.from(bytes))!==LOCK[K.CONFIG].blob)C.fail('PROFILE_NOT_DEFAULT_OFF');
 return {mode,status:'PROFILE_SOURCE_VALIDATED_ONLY',configSha256:C.sha256(bytes),profile:cfg,dueTicks:mode==='on'?K.dueTicks(cfg):[],deploymentAuthorized:false};
}
module.exports={load,verifyFrozen,inspectProfile,validateProfileLead};
