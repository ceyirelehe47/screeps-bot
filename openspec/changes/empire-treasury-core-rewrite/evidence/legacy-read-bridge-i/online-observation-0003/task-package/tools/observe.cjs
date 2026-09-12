'use strict';
/** Single foreground command: fresh binding immediately followed by execution.
 * Independent recovery worker survives parent exit. No automatic second window. */
const path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),S=require('../runtime/store.cjs');
const {prepare}=require('./prepare.cjs'),{execute}=require('../runtime/driver.cjs'),{client}=require('../runtime/transport.cjs');
const {closeSource}=require('./close-source.cjs'),{verifyRun}=require('../runtime/verify-run.cjs');
async function observe(o){
 U.verifyPackage();if(!o.execute||!o['exclusive-target'])C.fail('EXPLICIT_EXCLUSIVE_EXECUTION_REQUIRED');
 await prepare(o);const run=path.join(path.resolve(o.work),'run');
 try{const guard=C.loadGuard(o.compat),s=S.loadRun(run,guard),secret={...C.loadSecret(o.secret),path:path.resolve(o.secret)};
  await execute({repo:o.compat,run,secret,s,guard,api:client(secret)});
 }finally{closeSource(o.compat,run);}
 let result;try{result=verifyRun(run);}catch(e){result={status:'ONLINE_COMPAT_READ_INCONCLUSIVE',closure:'ONLINE_CLOSE_UNCONFIRMED',observed:false,issues:[e?.code||'EVIDENCE_PARSE_OR_VALIDATION_FAILED']};}
 S.newRecord(run,'observation-verification.json',result);return result;
}
module.exports={observe};if(require.main===module)U.cli(async()=>{const o=U.options(['refactor','compat','offline','tests','work','secret'],['execute','exclusive-target']);C.required(o,'refactor','compat','offline','tests','work','secret');
 const r=await observe(o);console.log(JSON.stringify(r));if(!r.observed)process.exitCode=2;});
