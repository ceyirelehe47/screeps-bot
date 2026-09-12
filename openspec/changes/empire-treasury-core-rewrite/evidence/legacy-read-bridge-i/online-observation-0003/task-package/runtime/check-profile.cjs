'use strict';
/** Formal rollout profile validation. Control-plane probes use probe-session.cjs and do not call this file. */
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const C=require('./common.cjs');
const BRIDGE_SHA='a9849e430b4238177653ed10cea085f13af402010e4c414312c64306a966d713';

function load(text,name,ts) {
  const result=ts.transpileModule(text,{fileName:name,reportDiagnostics:true,
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019}});
  if((result.diagnostics||[]).some(d=>d.category===ts.DiagnosticCategory.Error))C.fail('PROFILE_TYPESCRIPT_TRANSPILE_FAILED');
  const exports={};
  new vm.Script(result.outputText,{filename:name}).runInNewContext({exports,
    require(){C.fail('PROFILE_RUNTIME_IMPORT_UNEXPECTED');}}, {timeout:1000});
  return exports;
}

function validateProfileLead(cfg,observedTick) {
  if(!Number.isSafeInteger(observedTick)||observedTick<0)C.fail('OBSERVED_TICK_INVALID');
  const requiredStartTickMinimum=observedTick+100;
  if(cfg.startTick<requiredStartTickMinimum)C.fail('PROFILE_WINDOW_EXPIRED',{
    observedTick,startTick:cfg.startTick,endTick:cfg.endTick,requiredStartTickMinimum,
  });
  return requiredStartTickMinimum;
}

function inspectProfile(repo,mode,observedTick,ts) {
  if(!['off','on'].includes(mode))C.fail('PROFILE_MODE_INVALID');
  const bridge=fs.readFileSync(path.join(repo,'src/runtime/treasuryCompatRead.ts'));
  if(C.sha256(bridge)!==BRIDGE_SHA)C.fail('BRIDGE_SOURCE_CHANGED');
  const configBytes=fs.readFileSync(path.join(repo,'src/runtime/treasuryCompatConfig.ts'));
  const api=load(bridge.toString('utf8'),'treasuryCompatRead.ts',ts);
  const cfg=load(configBytes.toString('utf8'),'treasuryCompatConfig.ts',ts).TREASURY_COMPAT_CONFIG;
  if(!cfg||typeof cfg!=='object')C.fail('PROFILE_CONFIG_MISSING');
  if(cfg.intervalTicks!==100||cfg.minBucket!==2000||cfg.maxSampleCpu!==2||cfg.reserveCpu!==5||cfg.maxLogBytes!==16384)
    C.fail('PROFILE_LIMITS_CHANGED');
  if(JSON.stringify(cfg.resources)!==JSON.stringify(['energy','H']))C.fail('PROFILE_RESOURCES_CHANGED');
  let dueTicks=[];
  if(mode==='off') {
    if(cfg.enabled!==false||cfg.shardName!==''||!Array.isArray(cfg.rooms)||cfg.rooms.length!==0
      ||cfg.startTick!==0||cfg.endTick!==0)C.fail('PROFILE_NOT_DEFAULT_OFF');
  } else {
    if(cfg.enabled!==true||!api.validCompatConfig(cfg))C.fail('PROFILE_ENABLED_INVALID');
    if(cfg.shardName!=='shard1')C.fail('PROFILE_SHARD_INVALID');
    if(cfg.startTick%100!==0||cfg.endTick!==cfg.startTick+1100)C.fail('PROFILE_SLOT_COUNT_INVALID');
    validateProfileLead(cfg,observedTick);
    dueTicks=Array.from({length:12},(_,index)=>cfg.startTick+index*100);
  }
  return {status:'PROFILE_SOURCE_VALIDATED_ONLY',mode,configSha256:C.sha256(configBytes),profile:cfg,
    dueTicks,observedTick:mode==='on'?observedTick:null,liveTickIndependentlyVerified:false,
    deploymentAuthorized:false,fullTypecheckPerformed:false};
}

async function main(args) {
  if(![4,6].includes(args.length)||args[0]!=='--repo'||args[2]!=='--mode'
    ||(args.length===6&&args[4]!=='--observed-tick'))C.fail('PROFILE_CLI_USAGE_INVALID');
  const repo=path.resolve(args[1]);
  const ts=createRequire(path.join(repo,'package.json'))('typescript');
  if(args.length===6&&!/^\d+$/.test(args[5]))C.fail('PROFILE_CLI_TICK_INVALID');
  console.log(JSON.stringify(inspectProfile(repo,args[3],args.length===6?Number(args[5]):undefined,ts),null,2));
}

module.exports={BRIDGE_SHA,load,validateProfileLead,inspectProfile,main};
if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
