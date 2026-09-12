'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const M=require('../../tools/materialize-pinned-evidence.cjs');

function git(repo,args){return cp.execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();}
function makeRepo(){
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'pin-repo-'));git(repo,['init']);git(repo,['config','user.email','test@example.invalid']);git(repo,['config','user.name','test']);
  const root=path.join(repo,'evidence','probe-run'),run=path.join(root,'run');fs.mkdirSync(run,{recursive:true});
  const required=['prepare.stderr','prepare.stdout','secret-scan.json'];for(const name of required)fs.writeFileSync(path.join(root,name),name==='prepare.stderr'?'':'{}\n');
  const runNames=['probe-session.json','guard-probe.jsonl','guard-probe-result.json','collector-result.json','heartbeat.json',
    'online-state-verification.json','verify-joint-probe.exit.txt','verify-joint-probe.stderr','verify-joint-probe.stdout'];
  for(const name of runNames)fs.writeFileSync(path.join(run,name),name.endsWith('.json')?'{}\n':'');
  for(let i=0;i<18;i++)fs.writeFileSync(path.join(run,`filler-${String(i).padStart(2,'0')}.txt`),String(i));
  git(repo,['add','.']);git(repo,['commit','-m','fixture']);
  const commit=git(repo,['rev-parse','HEAD']),probeRunTree=git(repo,['rev-parse',`${commit}:evidence/probe-run`]),runTree=git(repo,['rev-parse',`${commit}:evidence/probe-run/run`]);
  const listing=git(repo,['ls-tree','-r',commit,'--','evidence/probe-run']).split(/\r?\n/);
  const critical={};for(const line of listing){const [meta,file]=line.split('\t');const blob=meta.split(' ')[2],relative=file.slice('evidence/probe-run/'.length);if(['run/guard-probe.jsonl','run/guard-probe-result.json'].includes(relative))critical[relative]=blob;}
  return {repo,policy:{sourceCommit:commit,probeRunPath:'evidence/probe-run',probeRunTree,runTree,criticalBlobs:critical}};
}

test('materializer copies the exact pinned Git tree and writes a hash manifest',()=>{
  const x=makeRepo(),out=path.join(os.tmpdir(),`materialized-${Date.now()}-${Math.random()}`);try{
    const result=M.materialize(x.repo,out,x.policy);assert.equal(result.files,30);assert.equal(result.probeRunTree,x.policy.probeRunTree);
    assert.ok(fs.existsSync(path.join(out,'source','run','guard-probe.jsonl')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out,'SOURCE-EVIDENCE-MANIFEST.json'))).entries.length,30);
  }finally{fs.rmSync(x.repo,{recursive:true,force:true});fs.rmSync(out,{recursive:true,force:true});}
});

test('materializer rejects a tree identity mismatch before creating output',()=>{
  const x=makeRepo(),out=path.join(os.tmpdir(),`materialized-${Date.now()}-${Math.random()}`);try{
    assert.throws(()=>M.materialize(x.repo,out,{...x.policy,probeRunTree:'0'.repeat(40)}),error=>error.code==='PINNED_EVIDENCE_TREE_MISMATCH');
    assert.equal(fs.existsSync(out),false);
  }finally{fs.rmSync(x.repo,{recursive:true,force:true});fs.rmSync(out,{recursive:true,force:true});}
});

test('ls-tree parser rejects malformed records',()=>{assert.throws(()=>M.parseLsTree(Buffer.from('bad\0')),error=>error.code==='GIT_LS_TREE_INVALID');});
