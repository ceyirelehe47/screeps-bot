'use strict';
/** R1-v2 is a forward-only, test-only repair of the stopped R1 source commit.
 * It does not create an experiment identity, clear a marker, or write Screeps.
 * All source identities come from authenticated Git objects and the v1 recipe.
 */
const C=require('./common.cjs'),N=require('./integration.cjs');
const FIX=require('../implementation/repair-patches.json');
const {fs,path,P,ROOT}=C;
const additions={
 'scripts/lib/treasury-compat-read-path-r1.cjs':'implementation/treasury-compat-read-path-r1.cjs',
 'test/treasury-compat/read-path-r1.spec.cjs':'tests/read-path-r1.spec.cjs',
 'test/treasury-compat/fixtures/core-before-read-path-r1.ts.txt':'fixtures/core-XV.ts.txt'
};
function exists(p){try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function diff(repo,a,b){return C.git(repo,['diff','--name-only','-z',a,b]).toString('utf8').split('\0').filter(Boolean).sort();}
function object(repo,ref,file){C.safePath(file);return C.git(repo,['show',ref+':'+file]);}
function lineage(repo,h,parent,message,paths){
 C.check(/^[a-f0-9]{40}$/.test(h)&&/^[a-f0-9]{40}$/.test(parent),'INVALID_SOURCE_SHA');
 C.check(C.text(repo,['show','-s','--format=%P',h])===parent,'SOURCE_PARENT_CHANGED');
 C.check(C.text(repo,['show','-s','--format=%s',h])===message,'SOURCE_MESSAGE_CHANGED');
 C.check(C.same(diff(repo,parent,h),paths),'SOURCE_CHANGE_SCOPE_MISMATCH');
 for(const file of paths){const entry=C.git(repo,['ls-tree',h,'--',file]).toString('utf8');C.check(entry.startsWith('100644 blob ')&&entry.trimEnd().endsWith('\t'+file),'SOURCE_MODE_CHANGED');}
}
function authorizationUnused(repo){
 const common=path.resolve(repo,C.text(repo,['rev-parse','--git-common-dir']));
 const folder=path.join(common,'treasury-experiments');
 if(exists(folder))C.check(fs.lstatSync(folder).isDirectory()&&!fs.lstatSync(folder).isSymbolicLink(),'EXPERIMENT_STATE_UNSAFE');
 const marker=path.join(folder,P.authorizationId+'.json');
 C.check(!exists(marker),'R1_AUTHORIZATION_ALREADY_CONSUMED');
 return {authorizationId:P.authorizationId,marker,unused:true};
}
function priorAttempt(directory){
 directory=fs.realpathSync(directory);
 C.check(fs.lstatSync(directory).isDirectory(),'PRIOR_WORK_NOT_DIRECTORY');
 C.check(!exists(path.join(directory,'live')),'PRIOR_OBSERVE_MAY_HAVE_STARTED');
 for(const n of ['candidate-attempt.json','restore-attempt.json','RESULT.json','source-published.json'])C.check(!exists(path.join(directory,n)),'PRIOR_PHASE_NOT_OFFLINE_STOP');
 const stop=C.json(path.join(directory,'STOP.json'));
 C.check(stop.status==='STOP'&&stop.phase==='full-offline-gates'&&stop.code==='COMMAND_FAILED:build'&&stop.automaticRetryAuthorized===false,'PRIOR_STOP_CHANGED');
 const prepared=C.json(path.join(directory,'prepared.json'));
 const preparation=C.json(path.join(directory,'source-preparation.json'));
 C.check(prepared.status==='R1_PREPARED'&&preparation.status==='R1_FIXED_SOURCE_COMMITTED_NOT_YET_PUBLISHED','PRIOR_PREPARATION_INVALID');
 C.check(C.same(prepared.source,preparation.source)&&preparation.receipt?.package?.fingerprint===P.priorPackageFingerprint,'PRIOR_SOURCE_OR_PACKAGE_CHANGED');
 const delivered=path.join(directory,'executor','r1-delivery');
 C.check(C.verify(delivered).fingerprint===P.priorPackageFingerprint,'PRIOR_DELIVERY_CHANGED');
 C.check(C.verify(path.join(directory,'executor')).fingerprint===prepared.executorFingerprint,'PRIOR_EXECUTOR_CHANGED');
 const tool=C.json(path.join(directory,'tool-tests','result.json'));
 C.check(tool.packageFingerprint===prepared.executorFingerprint&&tool.tests===165&&tool.passed===165&&tool.failed===0,'PRIOR_TOOL_TESTS_INVALID');
 const tap=C.read(path.join(directory,'offline-checks','repository-node.stdout')).toString('utf8');
 const count=k=>Number((tap.match(new RegExp('^# '+k+' (\\d+)\\r?$','m'))||[])[1]);
 C.check(count('tests')===467&&count('pass')===465&&count('fail')===2&&['skipped','todo','cancelled'].every(k=>count(k)===0),'PRIOR_FAILURE_SET_CHANGED');
 const labels=[
 'IX transform exactly restores the committed Build VII core prefix',
 'hotpath XI self routes avoid one duplicate scope lookup per task'
 ];
 const failures=tap.split(/\r?\n/).filter(s=>/^not ok \d+ - /.test(s));
 C.check(failures.length===2&&labels.every(label=>failures.some(s=>s.endsWith(' - '+label))),'PRIOR_FAILED_TESTS_CHANGED');
 const selected=['STOP.json','prepared.json','source-preparation.json','commands/build.exit.json',
  'commands/build.stdout','commands/build.stderr','offline-checks/repository-node.exit.json',
  'offline-checks/repository-node.stdout','offline-checks/repository-node.stderr','tool-tests/result.json'];
 const files={};for(const n of selected){const b=C.read(path.join(directory,n));files[n]={bytes:b.length,sha256:C.sha(b)};}
 return {directory,stop,source:prepared.source,manifest:preparation.manifest,packageFingerprint:P.priorPackageFingerprint,
  executorFingerprint:prepared.executorFingerprint,files,onlineEvidence:'observe directory absent; offline stop verified; runtime state not queried'};
}
function verifyExistingR1(repo,prior){
 C.clean(repo);const original=prior.source,h=original?.head;
 C.check(original?.base===P.compatBase&&original?.paths===P.sourcePaths.length&&C.tree(repo,h)===original.tree,'PRIOR_SOURCE_IDENTITY_CHANGED');
 lineage(repo,h,P.compatBase,P.sourceMessage,P.sourcePaths);
 const m=prior.manifest;
 C.check(m?.kind==='read-path-R1-source/v1'&&m.base===P.compatBase&&m.baseTree===P.compatBaseTree&&m.expectedSourceTree===original.tree&&C.same(Object.keys(m.files).sort(),P.sourcePaths),'PRIOR_SOURCE_MANIFEST_CHANGED');
 for(const n of P.sourcePaths){
  const b=object(repo,h,n),a=C.git(repo,['show',P.compatBase+':'+n],{allowFailure:true});
  const id=x=>x?{bytes:x.length,sha256:C.sha(x),blob:C.blob(x)}:null;
  C.check(C.same(id(a),m.files[n].before)&&C.same(id(b),m.files[n].after),'PRIOR_MANIFEST_BYTES_CHANGED:'+n);
 }
 // The old receipt is not by itself authoritative. Independently reconstruct
 // patched authoring files from the fixed XV blobs and all added v1 payloads.
 for(const file of Object.keys(N.PATCHES))C.check(object(repo,h,file).equals(N.patch(file,object(repo,P.compatBase,file))),'R1_RECIPE_MISMATCH:'+file);
 const oldIntegrity=C.json(path.join(ROOT,'references/r1-v1-INTEGRITY.json'));
 C.check(C.sha(C.read(path.join(ROOT,'references/r1-v1-INTEGRITY.json')))===P.priorPackageFingerprint,'V1_PROVENANCE_CHANGED');
 for(const[file,payload]of Object.entries(additions)){
  const b=C.read(path.join(ROOT,payload)),expected=oldIntegrity.files[payload];
  C.check(expected&&b.length===expected.bytes&&C.sha(b)===expected.sha256,'V1_SOURCE_PAYLOAD_CHANGED');
  C.check(object(repo,h,file).equals(b),'R1_ADDITION_CHANGED:'+file);
 }
 N.verifyCurrentCore(object(repo,h,P.corePath));
 const current=C.head(repo);
 if(current!==h){
  lineage(repo,current,h,P.repairMessage,P.repairSourcePaths);
  for(const file of P.repairSourcePaths)C.check(object(repo,current,file).equals(repairPatch(file,object(repo,h,file))),'EXISTING_REPAIR_CHANGED');
 }
 C.check(object(repo,current,P.corePath).equals(object(repo,h,P.corePath)),'R1_RUNTIME_CHANGED');
 C.check(object(repo,current,P.configPath).equals(object(repo,P.compatBase,P.configPath)),'CONFIG_NOT_DEFAULT_OFF');
 return {original,head:current,alreadyRepaired:current!==h};
}
function repairPatch(file,bytes){
 const r=FIX[file];C.check(r&&C.blob(bytes)===r.beforeBlob,'REPAIR_BASE_CHANGED:'+file);
 const out=Buffer.from(N.rewrite(bytes.toString('utf8'),r.changes));
 C.check(Buffer.from(N.rewrite(out.toString('utf8'),r.changes,true)).equals(bytes),'REPAIR_NOT_REVERSIBLE');
 return out;
}
function commitRepair(repo,candidate){
 C.clean(repo);C.check(C.head(repo)===candidate.head,'SOURCE_HEAD_MOVED');
 const original=candidate.original;
 if(!candidate.alreadyRepaired){
  const replacements={};
  for(const file of P.repairSourcePaths)replacements[file]=repairPatch(file,object(repo,original.head,file));
  // All anchors authenticated before the first file is changed.
  for(const[file,b]of Object.entries(replacements))fs.writeFileSync(path.join(repo,file),b);
  C.git(repo,['add','--',...P.repairSourcePaths]);C.git(repo,['diff','--cached','--check']);
  const staged=C.git(repo,['diff','--cached','--name-only','-z']).toString('utf8').split('\0').filter(Boolean).sort();
  C.check(C.same(staged,P.repairSourcePaths),'REPAIR_STAGED_SCOPE_CHANGED');
  C.git(repo,['commit','-m',P.repairMessage]);
 }
 C.clean(repo);const h=C.head(repo);lineage(repo,h,original.head,P.repairMessage,P.repairSourcePaths);
 for(const file of P.repairSourcePaths)C.check(object(repo,h,file).equals(repairPatch(file,object(repo,original.head,file))),'REPAIR_OUTPUT_CHANGED');
 C.check(object(repo,h,P.corePath).equals(object(repo,original.head,P.corePath)),'R1_RUNTIME_CHANGED');
 return {head:h,tree:C.tree(repo),base:original.head,paths:P.repairSourcePaths.length,repaired:true,originalR1Head:original.head};
}
function manifest(repo,source){
 const files={};for(const n of P.repairSourcePaths){const a=object(repo,source.base,n),b=object(repo,source.head,n);const id=x=>({bytes:x.length,sha256:C.sha(x),blob:C.blob(x)});files[n]={before:id(a),after:id(b)};}
 return {kind:'read-path-R1-v2-source/v1',base:source.base,baseTree:C.tree(repo,source.base),expectedSourceTree:source.tree,files};
}
module.exports={FIX,exists,diff,object,lineage,authorizationUnused,priorAttempt,verifyExistingR1,repairPatch,commitRepair,manifest};
