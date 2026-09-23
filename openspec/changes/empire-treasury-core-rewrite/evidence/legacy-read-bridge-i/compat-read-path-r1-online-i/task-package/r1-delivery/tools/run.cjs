'use strict';
const C=require('./common.cjs'),Prepare=require('./prepare.cjs'),M=require('./milestone.cjs');const{fs,path,P}=C;
async function run(o){
 C.verify();C.required(o,['compat','refactor','work','prior-work']);
 C.check(!!o.execute!==!!o['offline-only'],'SELECT_EXACTLY_ONE_MODE');
 if(o.execute){C.required(o,['secret']);C.check(o['exclusive-target']&&o['prior-workers-stopped'],'EXCLUSIVE_EXECUTION_FACTS_REQUIRED');}
 for(const n of ['compat','refactor','work','prior-work','secret'])if(o[n])o[n]=path.resolve(o[n]);
 let phase='package-self-tests';
 try{
  C.outside(o.work,o.compat);C.outside(o.work,o.refactor);C.outside(o.work,C.ROOT);C.outside(o.work,o['prior-work']);C.outside(o['prior-work'],o.work);
  C.check(!fs.existsSync(o.work),'WORK_DIR_ALREADY_EXISTS');
  C.command(C.ROOT,[path.join(C.ROOT,'tools/run-tests.cjs'),'--out',o.work+'.package-self-tests'],o.work+'.bootstrap-logs','self-tests');
  phase='prepare';
  const p=Prepare.prepare(o),executor=p.executor,logs=path.join(o.work,'commands');
  const cmd=(name,args,options)=>C.command(executor,[path.join(executor,'tools',name+'.cjs'),...args],logs,name,options);
  phase='executor-tools';cmd('run-tests',['--out',path.join(o.work,'tool-tests')]);
  phase='full-offline-gates';cmd('build',['--compat',o.compat,'--out',path.join(o.work,'offline-checks')]);
  const offline=C.json(path.join(o.work,'offline-checks/result.json'));
  C.check(offline.status==='READ_XV_RETRY_OFFLINE_VERIFIED'&&offline.source.head===p.source.head&&offline.source.tree===p.source.tree&&offline.compiler==='5.9.3'&&offline.repositoryNodeTests===P.repositoryNodeTests,'OFFLINE_PROOF_MISMATCH');
  // No Screeps command, token read or deployment before all real dependency gates.
  phase='publish-default-off-source';C.baseline(o.refactor,P.refactorBranch,P.refactorBase);C.clean(o.compat);
  C.check(C.head(o.compat)===p.source.head&&C.tree(o.compat)===p.source.tree&&C.remote(o.compat,P.compatBranch)===P.compatBase,'SOURCE_PUBLISH_BASE_CHANGED');
  C.git(o.compat,['push','origin','HEAD:refs/heads/'+P.compatBranch]);C.check(C.remote(o.compat,P.compatBranch)===p.source.head,'SOURCE_PUSH_UNCONFIRMED');
  C.durable(path.join(o.work,'source-published.json'),{source:p.source,at:new Date().toISOString(),defaultOff:true});
  if(o['offline-only']){const result={status:'R1_OFFLINE_VERIFIED_SOURCE_PUBLISHED',source:p.source,onlineAttempted:false,performanceGatePassed:false};C.durable(path.join(o.work,'RESULT.json'),result);return result;}
  phase='pre-online-reuse-check';cmd('apply',['--compat',o.compat,'--refactor',o.refactor,'--out',path.join(o.work,'source-reuse.json')]);
  phase='single-online-trial';const observation=cmd('observe',['--compat',o.compat,'--refactor',o.refactor,'--work',path.join(o.work,'live'),'--offline',path.join(o.work,'offline-checks'),'--tests',path.join(o.work,'tool-tests'),'--secret',o.secret,'--execute','--exclusive-target','--prior-workers-stopped'],{allowFailure:true,timeout:0});
  // Exit 2 is an experiment result, not permission to retry. Inherited runtime
  // owns close/recovery. This driver never implements or repeats a setCode call.
  const dir=path.join(o.work,'live/run');C.check(fs.existsSync(dir),'OBSERVE_DID_NOT_CREATE_RUN');
  phase='independent-verification';cmd('verify',['--compat',o.compat,'--run',dir,'--out',path.join(o.work,'FINAL-VERIFICATION.json')]);
  const v=C.json(path.join(o.work,'FINAL-VERIFICATION.json'));
  C.check(!v.issues?.includes('RESIDUAL_PROCESS')&&!v.issues?.includes('RESIDUAL_LOCK'),'EXPERIMENT_STILL_RUNNING');
  if(v.closure!=='RESTORED_BYTES_AND_RUNTIME_VERIFIED'&&fs.existsSync(path.join(dir,'session.json'))){
   phase='read-only-reconciliation';cmd('reconcile',['--run',dir,'--secret',o.secret,'--out',path.join(dir,'R1-READONLY-RECONCILIATION.json')],{allowFailure:true});
  }
  phase='milestone';const milestone=M.fromRun(executor,dir,v);C.durable(path.join(dir,'R1-MILESTONE.json'),milestone);
  const audit=path.join(dir,'r1-preparation');fs.mkdirSync(audit);
  for(const name of ['source-preparation.json','prepared.json','source-published.json','R1-REPAIR.json','PRIOR-ATTEMPT.json'])C.write(path.join(audit,name),C.read(path.join(o.work,name)));
  fs.cpSync(path.join(o.work,'source-checks'),path.join(audit,'source-checks'),{recursive:true,errorOnExist:true,force:false});
  fs.cpSync(path.join(o.work,'prior-attempt-files'),path.join(audit,'prior-attempt-files'),{recursive:true,errorOnExist:true,force:false});
  fs.cpSync(o.work+'.package-self-tests',path.join(audit,'package-self-tests'),{recursive:true,errorOnExist:true,force:false});
  phase='archive-and-push';const archiveArgs=['--compat',o.compat,'--refactor',o.refactor,'--work',o.work,'--secret',o.secret,'--push'];cmd('archive',archiveArgs);
  const result={status:'R1_DELIVERED',source:p.source,compatHead:C.head(o.compat),refactorHead:C.head(o.refactor),milestone:milestone.milestone,
   businessGatePassed:milestone.businessGatePassed===true,completeBusinessSamples:milestone.completeBusinessSamples||0,recovery:milestone.recoveryStatus,
   observationExit:observation.status,inheritedToolTests:P.inheritedToolTests,repositoryNodeTests:P.repositoryNodeTests,
   evidencePath:P.evidencePath,nextAction:milestone.nextAction};
  C.durable(path.join(o.work,'RESULT.json'),result);return result;
 }catch(e){
  if(e&&typeof e==='object')e.phase=phase;
  if(fs.existsSync(o.work)){const f=path.join(o.work,'STOP.json');if(!fs.existsSync(f))C.durable(f,{status:'STOP',phase,code:typeof e.code==='string'?e.code:'LOCAL_OPERATION_FAILED',at:new Date().toISOString(),
   automaticRetryAuthorized:false,instruction:'Preserve all files and current source state. Do not repair the package, edit tests, reset/rebase, clear experiment markers, or start another upload. If observe began, inspect its worker/collector and recovery evidence before any other action.'});}
  throw e;
 }
}
module.exports={run};
if(require.main===module)C.cli(()=>{const o=C.args(['compat','refactor','work','prior-work','secret'],['execute','offline-only','exclusive-target','prior-workers-stopped']);return run(o);});
