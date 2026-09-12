'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const F=require('./fixture.cjs'),S=require('../runtime/store.cjs'),C=require('../runtime/common.cjs');
function trial(fn){const d=F.runDir(),s=F.makeSession(),old=C.ORIGINAL_DIGEST;C.ORIGINAL_DIGEST=s.backup.digest;try{F.saveSession(d,s);fn(d,s);}finally{C.ORIGINAL_DIGEST=old;fs.rmSync(d,{recursive:true,force:true});}}
test('full private session validates serialized snapshots, fresh binding and compiled identity',()=>trial(d=>assert.equal(S.loadRun(d,F.guard).profileHead,'a'.repeat(40))));
test('snapshot mutation is refused before a writer can load the run',()=>trial(d=>{fs.appendFileSync(path.join(d,'candidate.json'),' ');assert.throws(()=>S.loadRun(d,F.guard),{code:'SNAPSHOT_FILE_CHANGED'});}));
test('session cannot silently rebind the absolute tick window',()=>trial(d=>{const p=path.join(d,'session.json'),s=JSON.parse(fs.readFileSync(p));s.profile.startTick+=100;s.profile.endTick+=100;fs.writeFileSync(p,JSON.stringify(s));assert.throws(()=>S.loadRun(d,F.guard),{code:'WINDOW_BINDING_MISMATCH'});}));
