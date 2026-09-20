'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const V=require('../runtime/verify-run.cjs'),M=require('../tools/compare.cjs');
test('empty retry run is explicitly NOT_DEPLOYED',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'retry-empty-'));try{const r=V.verifyRun(d);assert.equal(r.status,'NOT_DEPLOYED');assert.equal(r.captureVerified,false);assert.equal(r.rawReports,0);}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('empty retry comparison is inconclusive rather than a zero-performance claim',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'retry-compare-'));try{const r=M.makeComparison(d);assert.equal(r.status,'ENVELOPE_XII_RETRY_COMPARISON_INCONCLUSIVE');assert.equal(r.current.reports.raw,0);}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('closure restoration policy is session-backup based',()=>{const s=fs.readFileSync(path.join(__dirname,'../runtime/verify-run.cjs'),'utf8');assert.match(s,/s\.backupDigest/);assert.match(s,/s\.backupBuild/);});
