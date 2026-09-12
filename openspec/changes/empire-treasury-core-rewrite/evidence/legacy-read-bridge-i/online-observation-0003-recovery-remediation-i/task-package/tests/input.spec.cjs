'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../runtime/common.cjs'),I=require('../runtime/input.cjs'),F=require('./fixture.cjs');
function setup(){const root=F.root(),prior=path.join(root,'prior'),source=path.join(root,'source'),s=F.session();F.priorFiles(prior,s);fs.mkdirSync(source);fs.cpSync(prior,path.join(source,'run'),{recursive:true});
 const policy={runId:s.runId,profileHead:s.profileHead,originalDigest:s.backupDigest,backupFileSha256:s.backupFileSha256,candidateFileSha256:s.candidateFileSha256};
 return {root,prior,source,s,policy,load:()=>I.loadInput(source,prior,policy),clean:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('pinned receipts and exact snapshot bytes load without consulting an expired window',()=>{const x=setup();try{assert.equal(x.load().runId,x.s.runId);}finally{x.clean();}});
test('changed backup snapshot bytes reject before any network is available',()=>{const x=setup();try{fs.appendFileSync(path.join(x.prior,'backup.json'),' ');assert.throws(x.load,{code:'SNAPSHOT_BYTES_CHANGED'});}finally{x.clean();}});
test('changed candidate snapshot bytes reject before any network is available',()=>{const x=setup();try{fs.appendFileSync(path.join(x.prior,'candidate.json'),' ');assert.throws(x.load,{code:'SNAPSHOT_BYTES_CHANGED'});}finally{x.clean();}});
test('wrong original run receipts cannot be substituted',()=>{const x=setup();try{fs.appendFileSync(path.join(x.prior,'upload-attempt.json'),' ');assert.throws(x.load,{code:'PRIOR_RUN_RECEIPT_MISMATCH'});}finally{x.clean();}});
test('backup and candidate swap is rejected',()=>{const x=setup();try{const a=C.bytes(path.join(x.prior,'backup.json')),b=C.bytes(path.join(x.prior,'candidate.json'));fs.writeFileSync(path.join(x.prior,'backup.json'),b);fs.writeFileSync(path.join(x.prior,'candidate.json'),a);assert.throws(x.load,{code:'SNAPSHOT_BYTES_CHANGED'});}finally{x.clean();}});
test('missing original backup never triggers a bank-of-old-snapshots fallback',()=>{const x=setup();try{fs.unlinkSync(path.join(x.prior,'backup.json'));assert.throws(x.load,{code:'INPUT_FILE_UNREADABLE'});}finally{x.clean();}});
test('misused credential path does not leak that path or token text',()=>assert.throws(()=>C.loadSecret(F.secret.token),e=>{assert.ok(!e.message.includes(F.secret.token));return true;}));
test('nested output and source paths are rejected',()=>{const x=setup();try{assert.throws(()=>C.disjoint(x.prior,path.join(x.prior,'new')),{code:'PATHS_MUST_BE_DISJOINT'});}finally{x.clean();}});
