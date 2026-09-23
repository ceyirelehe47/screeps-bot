'use strict';
const C=require('./common.cjs');
function run(out){out=C.path.resolve(out);C.outside(out,C.ROOT);C.check(!C.fs.existsSync(out),'TEST_OUTPUT_EXISTS');const proof=C.verify();C.fs.mkdirSync(out);
 const specs=C.fs.readdirSync(C.path.join(C.ROOT,'tests')).filter(n=>n.endsWith('.spec.cjs')).sort().map(n=>C.path.join(C.ROOT,'tests',n));
 const r=C.command(C.ROOT,['--test','--test-concurrency=1',...specs],out,'package-tests');
 const count=k=>Number((r.stdout.match(new RegExp('^# '+k+' (\\d+)\\r?$','m'))||[])[1]);
 C.check(count('tests')===C.P.packageTests&&count('pass')===C.P.packageTests&&['fail','cancelled','skipped','todo'].every(k=>count(k)===0),'PACKAGE_TEST_COUNT_CHANGED');
 const files=C.list(C.ROOT).filter(n=>n.endsWith('.cjs'));for(let i=0;i<files.length;i++)C.command(C.ROOT,['--check',C.path.join(C.ROOT,files[i])],out,'syntax-'+String(i).padStart(2,'0'));
 const result={status:'R1_V2_PACKAGE_TESTS_VERIFIED',tests:C.P.packageTests,passed:C.P.packageTests,failed:0,coreTests:43,v1ToolTests:59,repairTests:C.P.repairTests,seededMixedCases:512,syntaxFiles:files.length,packageFingerprint:proof.fingerprint,node:process.versions.node,engineCpuMeasurement:false};C.durable(C.path.join(out,'result.json'),result);return result;
}
module.exports={run};if(require.main===module)C.cli(()=>{const o=C.args(['out']);C.required(o,['out']);return run(o.out);});
