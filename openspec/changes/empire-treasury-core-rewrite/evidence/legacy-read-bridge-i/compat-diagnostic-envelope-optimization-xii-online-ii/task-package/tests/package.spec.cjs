'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const ROOT=path.resolve(__dirname,'..'),U=require('../tools/util.cjs'),K=require('../runtime/policy.cjs');
test('resolved package integrity is complete',()=>assert.equal(U.verifyPackage().status,'PACKAGE_INTEGRITY_VERIFIED'));
test('XII baselines are pinned',()=>{assert.equal(K.COMPAT,'91b9a99226a7a135a0e75b8a1d0db255eefe2200');assert.equal(K.REFACTOR,'0c742a1534ebd64af9e483fcd6313c5d156ff6e1');});
test('XII protocol retains four fixed points',()=>{const p=K.profileFor(1000);assert.equal(K.COUNT,4);assert.deepEqual(K.dueTicks(p),[1200,1300,1400,1500]);});
test('XII protocol retains fixed scope and budget',()=>{const p=K.profileFor(1000);assert.deepEqual(p.rooms,['E3N59','E4N58']);assert.deepEqual(p.resources,['energy','H']);assert.equal(p.maxSampleCpu,2);assert.equal(p.reserveCpu,5);});
test('XII evidence path is distinct and versioned',()=>assert.match(K.EVIDENCE,/diagnostic-envelope-optimization-xii-online-ii$/));
test('materialization record pins archived XI package',()=>{const m=require('../MATERIALIZATION.json');assert.equal(m.baseCommit,K.REFACTOR);assert.match(m.basePath,/compat-hotpath-optimization-xi-online-i\/task-package$/);});
