'use strict';
const path=require('node:path'),C=require('../runtime/common.cjs'),S=require('../runtime/window-selection.cjs');
function analyze(dir,verification){
 const root=path.join(dir,'window-selection'),start=C.optional(root,'start.json'),result=C.optional(root,'result.json');
 let verified=null,error=null;if(start){try{verified=S.verifySelection(dir);}catch(e){error=C.code(e);}}
 return {kind:'XV-retry-I-window-selection-analysis/v1',runId:C.POLICY.parentRunId,
   capture:verification.status,closure:verification.closure,selection:start?result:null,
   independentVerification:verified,error,sourceImplementationRevision:'XV',newSourceCommits:0,
   interpretation:'Only unbound read-only proposals may be reconsidered. Every calibration and rejection is retained. The first revalidated admissible proposal is selected. No second ON window, POST retry or wall extension is authorized.'};
}
module.exports={analyze};
