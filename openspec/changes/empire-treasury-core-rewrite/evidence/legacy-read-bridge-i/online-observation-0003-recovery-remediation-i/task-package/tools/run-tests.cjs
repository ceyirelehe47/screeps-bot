'use strict';
const path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process');const C=require('../runtime/common.cjs'),U=require('./util.cjs');
function runTests(out){
 U.verifyPackage();C.disjoint(out,U.ROOT);C.mkdirNew(out);
 const spec=C.json(path.join(U.ROOT,'references/test-contract.json'));
 const files=C.list(path.join(U.ROOT,'tests')).filter(n=>n.endsWith('.spec.cjs')).map(n=>'tests/'+n).sort();
 if(!C.same(files,spec.files))C.fail('TEST_FILE_SET_MISMATCH');
 const r=cp.spawnSync(process.execPath,['--test',...files],{cwd:U.ROOT,encoding:'utf8',timeout:180000,maxBuffer:16*1048576,windowsHide:true});
 fs.writeFileSync(path.join(out,'tests.tap'),r.stdout||'',{flag:'wx'});fs.writeFileSync(path.join(out,'tests.stderr'),r.stderr||'',{flag:'wx'});
 C.durable(path.join(out,'tests.exit.json'),{code:r.status,signal:r.signal,error:r.error?'TEST_PROCESS_FAILED':null});
 const num=k=>Number((r.stdout||'').match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1]??-1);
 const ok=r.status===0&&!r.error&&num('tests')===spec.tests&&num('pass')===spec.tests&&['fail','cancelled','skipped','todo'].every(k=>num(k)===0);
 const summary={status:ok?'RECOVERY_0003_IMPLEMENTATION_TESTS_VERIFIED':'RECOVERY_0003_IMPLEMENTATION_TESTS_FAILED',tests:num('tests'),passed:num('pass'),failed:num('fail'),
  skipped:num('skipped'),todo:num('todo'),cancelled:num('cancelled'),platform:process.platform,node:process.version,
  packageFingerprint:C.sha256(C.bytes(path.join(U.ROOT,'INTEGRITY.json'))),testFiles:files};
 C.durable(path.join(out,'summary.json'),summary);if(!ok)C.fail('FIXED_IMPLEMENTATION_TESTS_FAILED');return summary;
}
module.exports={runTests};if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['out']);C.required(o,'out');console.log(JSON.stringify(runTests(o.out)));});
