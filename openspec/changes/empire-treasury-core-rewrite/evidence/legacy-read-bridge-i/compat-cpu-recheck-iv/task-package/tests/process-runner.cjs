'use strict';
const path=require('node:path');const root=process.env.CPU_DIAG_FIXTURE_ROOT;
const C=require('../runtime/common.cjs'),F=require('./fixture.cjs'),S=require('../runtime/store.cjs'),{apiWorld}=require('./process-fixture.cjs');
const {execute}=require('../runtime/driver.cjs'),{verifyRun}=require('../runtime/verify-run.cjs');
(async()=>{const w=C.readJson(path.join(root,'fake-world.json')),s=w.s;
 const result=await execute({repo:root,run:path.join(root,'run'),secret:F.secret,s,guard:F.guard,api:apiWorld(root)});
 S.newRecord(path.join(root,'run'),'source-closed.json',{status:'SOURCE_DEFAULT_OFF_RESTORED',profileHead:s.profileHead,closedHead:'d'.repeat(40),sameTreeAsCompatBase:true});
 if(w.tamper){
  const fs=require('node:fs'),run=path.join(root,'run');
  if(w.tamper==='profile'){const file=path.join(run,'console.jsonl'),a=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(JSON.parse);let changed=false;
   for(const x of a){if(x.kind!=='ws-frame'||changed)continue;const frame=JSON.parse(x.text);if(!Array.isArray(frame[1]?.messages?.log))continue;
    frame[1].messages.log=frame[1].messages.log.map(t=>{const d=require('../runtime/decoder.cjs').parseBridge(t);if(d.kind==='bridge'&&!changed){changed=true;d.report.cpuProfile.phases.legacyInputs+=1;return JSON.stringify(d.report);}return t;});x.text=JSON.stringify(frame);}
   fs.writeFileSync(file,a.map(JSON.stringify).join('\n')+'\n');
  }else if(w.tamper==='runtime-footer'){const file=path.join(run,'recovery-worker/runtime-console.jsonl'),a=fs.readFileSync(file,'utf8').trimEnd().split('\n');a.push(a.at(-1));fs.writeFileSync(file,a.join('\n')+'\n');}
  else if(w.tamper==='postflight'){const file=path.join(run,'recovery-worker/code-after-runtime.json'),r=C.readJson(file);r.digest.hash='e'.repeat(64);fs.writeFileSync(file,JSON.stringify(r)+'\n');}
  else if(w.tamper==='write-boundary'){const file=path.join(run,'actions.jsonl'),a=fs.readFileSync(file,'utf8').trimEnd().split('\n').map(JSON.parse);a.push(a.find(x=>x.kind==='code-write-boundary'&&x.action==='candidate'));fs.writeFileSync(file,a.map(JSON.stringify).join('\n')+'\n');}
 }
 const verified=verifyRun(path.join(root,'run'));const comparison=require('../tools/compare.cjs').makeComparison(path.join(root,'run'));C.durable(path.join(root,'test-result.json'),{result,verified,comparison});
})().catch(e=>{console.error(e);process.exitCode=1;});
