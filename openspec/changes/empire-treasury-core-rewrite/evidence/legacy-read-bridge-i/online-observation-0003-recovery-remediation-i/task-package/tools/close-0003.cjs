'use strict';
const path=require('node:path');const C=require('../runtime/common.cjs'),U=require('./util.cjs'),I=require('../runtime/input.cjs');
const {createClient}=require('../runtime/transport.cjs'),{close0003}=require('../runtime/closure.cjs'),{verifyClosure}=require('../runtime/verify-closure.cjs');
async function run(o){
 U.verifyPackage();if(Number(process.versions.node.split('.')[0])!==22)C.fail('NODE22_REQUIRED');U.heads(o.refactor,o.compat);U.verifySource(o.source);
 if(process.env.NODE_OPTIONS||process.env.DEST||process.env.DEPLOY_ALLOW_DIRTY)C.fail('UNSAFE_EXECUTION_ENVIRONMENT');
 for(const p of [o.source,o['prior-run'],o.out,U.ROOT])for(const r of [o.refactor,o.compat])C.disjoint(p,r);
 C.disjoint(o.out,o.source);C.disjoint(o.out,o['prior-run']);C.disjoint(o.out,U.ROOT);C.disjoint(o.out,o.secret);C.disjoint(o.out,o.tests);
 const tests=C.json(path.join(o.tests,'summary.json')),spec=C.json(path.join(U.ROOT,'references/test-contract.json'));
 if(tests.status!=='RECOVERY_0003_IMPLEMENTATION_TESTS_VERIFIED'||tests.tests!==spec.tests||tests.failed!==0||tests.skipped!==0
  ||tests.packageFingerprint!==C.sha256(C.bytes(path.join(U.ROOT,'INTEGRITY.json'))))C.fail('FIXED_TEST_GATE_MISSING');
 const s=I.loadInput(o.source,o['prior-run']),secret=C.loadSecret(o.secret);
 let cancelled=false;const signal=()=>{cancelled=true;};process.once('SIGINT',signal);process.once('SIGTERM',signal);
 let r;
 try{r=await close0003({api:createClient(secret),s,prior:o['prior-run'],out:o.out,executeRecovery:!!o['execute-recovery'],
   exclusiveTarget:!!o['exclusive-target'],priorWorkersStopped:!!o['prior-workers-stopped'],secret,isCancelled:()=>cancelled});
 }finally{process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
 U.verifySource(o.source);U.verifyPackage();const v=verifyClosure(o.out,s);
 C.durable(path.join(o.out,'CLOSURE-VERIFICATION.json'),v);return {result:r,verification:v};
}
module.exports={run};if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['refactor','compat','source','prior-run','secret','out','tests'],['execute-recovery','exclusive-target','prior-workers-stopped']);
 C.required(o,'refactor','compat','source','prior-run','secret','out','tests');const r=await run(o);console.log(JSON.stringify(r.verification));
 if(r.verification.status!=='RECOVERY_CLOSURE_VERIFIED')process.exitCode=2;
}).finally(()=>{
 // The entrypoint has settled on success OR failure; never interrupt an in-flight restore.
 // Bound only a stranded WebSocket close handshake after HTTP work has finished.
 setTimeout(()=>process.exit(process.exitCode||0),1000).unref();});
