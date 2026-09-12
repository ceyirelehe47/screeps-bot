'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const C=require('../runtime/common.cjs');

test('atomicJson repeatedly replaces an existing artifact without leaving temp files',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-atomic-'));const file=path.join(dir,'heartbeat.json');
  try{
    C.atomicJson(file,{n:0});
    for(let n=1;n<=200;n++)C.atomicJson(file,{n});
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{n:200});
    assert.deepEqual(fs.readdirSync(dir),['heartbeat.json']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('atomicJson preserves create-once JSON shape across replacement',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-atomic-shape-'));const file=path.join(dir,'ready.json');
  try{
    C.atomicJson(file,{runId:'a'.repeat(32),state:'ready'});
    C.atomicJson(file,{runId:'a'.repeat(32),state:'closing'});
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(value.runId,'a'.repeat(32));assert.equal(value.state,'closing');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
