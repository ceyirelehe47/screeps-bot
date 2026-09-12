'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const U=require('./util.cjs'),C=require('../runtime/common.cjs');
function run(out){
 U.verifyPackage();U.outside(out,U.ROOT);U.newDir(out);
 const files=fs.readdirSync(path.join(U.ROOT,'tests')).filter(x=>x.endsWith('.spec.cjs')).sort().map(x=>'tests/'+x);
 const expected=C.readJson(path.join(U.ROOT,'references/test-contract.json'));
 if(JSON.stringify(files)!==JSON.stringify(expected.files))C.fail('TEST_FILE_SET_CHANGED');
 const r=cp.spawnSync(process.execPath,['--test',...files],{cwd:U.ROOT,encoding:'utf8',timeout:180000,maxBuffer:16*1048576,windowsHide:true});
 fs.writeFileSync(path.join(out,'tests.tap'),r.stdout||'');fs.writeFileSync(path.join(out,'tests.stderr'),r.stderr||'');
 C.writeNew(path.join(out,'tests.exit.json'),{status:r.status,signal:r.signal,error:r.error?'CHILD_FAILURE':null});
 const number=n=>Number(r.stdout?.match(new RegExp('^# '+n+' (\\d+)$','m'))?.[1]);
 const ok=r.status===0&&number('tests')===expected.count&&number('pass')===expected.count&&number('fail')===0&&number('skipped')===0&&number('todo')===0&&number('cancelled')===0;
 const result={status:ok?'FORMAL_0003_TESTS_VERIFIED':'FORMAL_0003_TESTS_FAILED',tests:number('tests'),passed:number('pass'),failed:number('fail'),skipped:number('skipped'),todo:number('todo'),cancelled:number('cancelled'),
  platform:process.platform,node:process.version,packageFingerprint:C.sha256(fs.readFileSync(path.join(U.ROOT,'INTEGRITY.json'))),testFiles:files};
 C.writeNew(path.join(out,'summary.json'),result);if(!ok)C.fail('FORMAL_TESTS_FAILED');return result;
}
module.exports={run};if(require.main===module)U.cli(async()=>{const o=U.options(['out']);C.required(o,'out');console.log(JSON.stringify(run(path.resolve(o.out))));});
