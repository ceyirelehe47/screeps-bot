#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {createRequire}=require('node:module');
const C=require('./common.cjs');const P=require('./protocol.cjs');const {inspectProfile}=require('./check-profile.cjs');
function main(argv) {
  const o=C.options(argv,['repo','preflight','run']);C.required(o,'repo','preflight','run');
  const repo=path.resolve(o.repo),g=C.assertCandidate(repo),pre=C.readJson(path.join(o.preflight,'preflight.json'),32768);
  if(pre.status!=='PREFLIGHT_VERIFIED_NOT_DEPLOYED'||Date.now()-pre.atMs>15*60*1000||pre.atMs>Date.now()+1000)C.fail('PREFLIGHT_NOT_FRESH');
  const backup=P.validateSnapshot(C.readJson(path.join(o.preflight,'backup.json')),g.guard);
  if(backup.capturedAtMs!==pre.atMs||P.buildIdentity(backup.modules.main).commit!==C.PRODUCTION_BASE)C.fail('BACKUP_PROVENANCE_MISMATCH');
  const ts=createRequire(path.join(repo,'package.json'))('typescript');
  const profile=inspectProfile(repo,'on',pre.observedTick,ts).profile;
  if(!Array.isArray(pre.ownedRooms)||profile.rooms.some(r=>!['E3N59','E4N58'].includes(r)||!pre.ownedRooms.includes(r)))C.fail('ROOM_SCOPE_NOT_APPROVED');
  const modules=Object.create(null);
  for(const f of fs.readdirSync(path.join(repo,'dist'))) {
    if(f.endsWith('.map.js'))continue;
    if(f.endsWith('.js'))modules[f.slice(0,-3)]=fs.readFileSync(path.join(repo,'dist',f),'utf8');
    else if(f.endsWith('.wasm'))modules[f]={binary:fs.readFileSync(path.join(repo,'dist',f)).toString('base64')};
  }
  const build=P.confirmBuild(modules,g.head,g.tree),candidate=P.makeSnapshot(modules,g.guard);
  // Recheck tree after reading files. The operator must keep this tree exclusive.
  if(C.assertCandidate(repo).head!==g.head)C.fail('CANDIDATE_MOVED');
  fs.mkdirSync(o.run,{recursive:false,mode:0o700});
  C.writeNew(path.join(o.run,'backup.json'),backup);C.writeNew(path.join(o.run,'candidate.json'),candidate);
  const s={kind:'compat-online-run-v1',runId:crypto.randomBytes(16).toString('hex'),...C.EXPECTED,
    preparedAtMs:Date.now(),wallLimitMs:5400000,profile,profileHead:g.head,profileTree:g.tree,build,
    backupFileSha256:C.sha256(fs.readFileSync(path.join(o.run,'backup.json'))),
    candidateFileSha256:C.sha256(fs.readFileSync(path.join(o.run,'candidate.json')))};
  C.writeNew(path.join(o.run,'session.json'),s);
  console.log(JSON.stringify({status:'SESSION_PREPARED_NOT_DEPLOYED',runId:s.runId,profileHead:s.profileHead,
    originalHash:backup.digest.hash,candidateHash:candidate.digest.hash,dueTicks:Array.from({length:12},(_,i)=>profile.startTick+i*100)}));
}
module.exports={main};if(require.main===module)C.entrypoint(async()=>main(process.argv.slice(2)));
