'use strict';
const path=require('node:path');const U=require('./util.cjs'),C=require('../runtime/common.cjs'),R=require('../runtime/replay.cjs');
function replaySource(source,out){const before=U.verifySource(source);const pub=C.json(path.join(source,'run/public-session.json'));
 const r=R.replay(C.bytes(path.join(source,'run/console.jsonl')).toString('utf8'),pub);
 if(r.rawBridgeReports!==1||r.completeBridgeReports!==0||r.receivedTicks[0]!==73646500||r.decodingFailures.length)C.fail('PINNED_REPLAY_EXPECTATION_MISMATCH');
 C.mkdirNew(out);C.durable(path.join(out,'replay.json'),{...r,source:before});
 C.durable(path.join(out,'CPU-EVIDENCE.json'),{status:'CPU_BUDGET_GAP_RECORDED_NOT_REPAIRED',reports:r.cpuFindings,
  sourceModified:false,budgetModified:false,productionOptimizationImplemented:false,
  unknowns:['cold-start versus steady-state contribution','observation builder versus reader-loading cost','full cost including serialization and emit'],
  conclusion:'One partial first report does not establish a safe higher CPU budget; no new engine experiment authorized.'});
 U.verifySource(source);return r;
}
module.exports={replaySource};if(require.main===module)C.main(async()=>{const o=C.options(process.argv.slice(2),['source','out']);C.required(o,'source','out');U.verifyPackage();C.disjoint(o.source,o.out);C.disjoint(o.out,U.ROOT);
 const r=replaySource(o.source,o.out);console.log(JSON.stringify({status:r.status,rawBridgeReports:r.rawBridgeReports,completeBridgeReports:r.completeBridgeReports,receivedTicks:r.receivedTicks}));});
