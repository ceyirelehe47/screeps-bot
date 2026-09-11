#!/usr/bin/env node
'use strict';
const path=require('node:path');const C=require('./common.cjs');const {loadSession}=require('./session.cjs');
function main(argv){const o=C.options(argv,['repo','run']);C.required(o,'repo','run');const s=loadSession(o.run,C.loadGuard(o.repo));
  C.atomicJson(path.join(o.run,'closing.json'),{runId:s.runId,atMs:Date.now(),reason:'operator_requested'});
  console.log(JSON.stringify({status:'CLOSE_REQUESTED_NOT_CONFIRMED',runId:s.runId}));}
if(require.main===module)C.entrypoint(async()=>main(process.argv.slice(2)));
