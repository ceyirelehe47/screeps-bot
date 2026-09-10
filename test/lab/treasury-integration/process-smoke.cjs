#!/usr/bin/env node
'use strict';
// Explicit smoke test of the REAL OS adapter, not Screeps. Creates only its own
// temporary launcher and six idle children, then terminates that exact tree.
// The calling verifier remains outside the target tree. No port is opened.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const scope = require('../terminal-transfer/tools/process-scope.cjs');
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-owned-process-smoke') throw new Error('usage: node process-smoke.cjs --run-owned-process-smoke');
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-owned-smoke-'));
  const worker = path.join(rootDir,'worker.cjs'), launcher = path.join(rootDir,'launcher.cjs');
  fs.writeFileSync(worker,'setInterval(()=>{},1000);\n');
  fs.writeFileSync(launcher,`const {spawn}=require('node:child_process');\nconst children=Array.from({length:6},()=>spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:'ignore',windowsHide:true}));\nconsole.log(JSON.stringify({root:process.pid,pids:children.map(p=>p.pid)}));\nsetInterval(()=>{},1000);\n`);
  const child = spawn(process.execPath,[launcher],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let targets=[], owner, succeeded=false;
  const audit = event=>process.stdout.write(JSON.stringify(event)+'\n');
  try {
    const ready = await new Promise((resolve,reject)=>{
      let text='';const timer=setTimeout(()=>reject(new Error('own launcher readiness timeout')),5000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.stdout.on('data',chunk=>{text+=chunk;const end=text.indexOf('\n');if(end>=0){clearTimeout(timer);try{resolve(JSON.parse(text.slice(0,end)));}catch(e){reject(e);}}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('own launcher exited early '+code));});
    });
    owner=await scope.captureLauncher(child.pid,rootDir);
    targets=await scope.inspectProcesses([ready.root,...ready.pids]);
    if(targets.length!==7)throw new Error('seven live owned processes not observed');
    audit({kind:'smoke-before',platform:process.platform,owner,targets});
    const result=await scope.terminateLauncher(owner,audit);
    const after=await scope.inspectProcesses(targets.map(p=>p.pid));
    if(after.some(p=>targets.some(t=>scope.identityMatches(t,p))))throw new Error('owned survivor after termination');
    if(!result.terminated||result.observedPids.length!==7||result.auditErrors.length)throw new Error('incomplete termination proof');
    succeeded=true;
    audit({kind:'smoke-result',status:'PASS',platform:process.platform,result});
  } finally {
    // Failure cleanup is test-local only. Never discover or kill unrelated
    // processes; PID reuse is checked against the captured identity.
    if(!succeeded) {
      if(!owner && child.pid){try{owner=await scope.captureLauncher(child.pid,rootDir);}catch{}}
      if(owner && process.platform==='win32') {
        try{const p=await scope.inspectProcess(owner.pid);if(scope.identityMatches(owner,p))execFileSync('taskkill.exe',['/PID',String(owner.pid),'/T','/F'],{timeout:5000,windowsHide:true});}catch{}
      }
      for(const t of targets.concat(owner?[owner]:[])) {
        try{const p=await scope.inspectProcess(t.pid);if(scope.identityMatches(t,p))process.kill(t.pid,'SIGKILL');}catch{}
      }
    }
    fs.rmSync(rootDir,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(error=>{console.error(String(error));process.exitCode=1;});
module.exports={main};
