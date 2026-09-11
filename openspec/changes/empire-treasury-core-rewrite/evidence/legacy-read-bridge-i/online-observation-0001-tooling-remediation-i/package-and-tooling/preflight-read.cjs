#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');
const C=require('./common.cjs');const {client}=require('./transport.cjs');const {preflight}=require('./operations.cjs');
async function main(argv) {
  const o=C.options(argv,['repo','secret','out']);C.required(o,'repo','secret','out');
  const secret=C.loadSecret(o.secret),guard=C.loadGuard(o.repo);
  const result=await preflight(client(secret),guard);
  // Do not create a usable backup until ALL reads and identity checks succeeded.
  fs.mkdirSync(o.out,{recursive:false,mode:0o700});
  C.writeNew(path.join(o.out,'backup.json'),result.snapshot);
  const summary={status:'PREFLIGHT_VERIFIED_NOT_DEPLOYED',...C.EXPECTED,atMs:result.snapshot.capturedAtMs,
    observedTick:result.observedTick,ownedRooms:result.ownedRooms,build:result.build,digest:result.snapshot.digest};
  C.writeNew(path.join(o.out,'preflight.json'),summary);
  console.log(secret.redact(JSON.stringify(summary)));
}
module.exports={main};if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
