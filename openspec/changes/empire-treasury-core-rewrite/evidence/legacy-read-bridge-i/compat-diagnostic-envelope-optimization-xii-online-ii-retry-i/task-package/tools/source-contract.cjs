'use strict';
/** Read-only source identity. The original v4 implementation manifest is the
 * single authority for changed paths; never reconstruct that list by hand.
 * Git trees/parents/message are checked independently of the manifest. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const SOURCE_HEAD='982ac514d06428ffd5cea1a38add774438d7bb6e';
const SOURCE_TREE='dcec716dfad41cb95e07bbed5988f1d5fde5c531';
const SOURCE_PARENT='91b9a99226a7a135a0e75b8a1d0db255eefe2200';
const SOURCE_MESSAGE='perf(compat): compact diagnostic envelope and bounded preview work';
const MANIFEST_SHA256='df0066d70414132d48c93399ac962ef3c80ada1a4a348122b5eb152db40146ae';
const MANIFEST_BLOB='b94574b9f8a5cd0b6b61842f9200d0f18a3843e7';
const MANIFEST_BYTES=6895;
function fail(code,details={}){const e=new Error(code);e.code=code;e.details=details;throw e;}
function parseManifest(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length!==MANIFEST_BYTES
  ||crypto.createHash('sha256').update(bytes).digest('hex')!==MANIFEST_SHA256
  ||crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')!==MANIFEST_BLOB)
  fail('ENVELOPE_XII_RETRY_SOURCE_MANIFEST_CHANGED');
 const m=JSON.parse(bytes.toString('utf8')),s=m.sourceImplementation;
 if(m.baselines?.compat!==SOURCE_PARENT||s?.commitMessage!==SOURCE_MESSAGE
  ||s.changedPaths!==11||s.newPaths!==5||s.defaultEnabled!==false||s.maxSampleCpu!==2
  ||!Array.isArray(s.paths)||s.paths.length!==11||new Set(s.paths).size!==11
  ||s.paths.some(p=>typeof p!=='string'||p.startsWith('/')||p.includes('\\')||p.split('/').some(x=>!x||x==='.'||x==='..')))
  fail('ENVELOPE_XII_RETRY_SOURCE_MANIFEST_INVALID');
 return Object.freeze({paths:Object.freeze([...s.paths].sort()),manifestSha256:MANIFEST_SHA256,manifestBlob:MANIFEST_BLOB});
}
const CONTRACT=parseManifest(fs.readFileSync(path.join(__dirname,'../references/implementation-lock.json')));
function assertScope(actual,expected=CONTRACT.paths){
 if(!Array.isArray(actual)||new Set(actual).size!==actual.length||actual.some(x=>typeof x!=='string'))
  fail('ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED');
 const a=[...actual].sort(),e=[...expected].sort();
 if(JSON.stringify(a)!==JSON.stringify(e))fail('ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED',{
  missing:e.filter(p=>!a.includes(p)),unexpected:a.filter(p=>!e.includes(p))});
 return a;
}
function git(repo,args){
 const r=cp.spawnSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','-C',repo,...args],
  {encoding:'utf8',timeout:30000,maxBuffer:8*1048576,windowsHide:true});
 if(r.status!==0||r.error)fail('GIT_OPERATION_FAILED');
 return r.stdout;
}
function verifyPinned(repo){
 const tree=git(repo,['rev-parse',SOURCE_HEAD+'^{tree}']).trim();
 if(tree!==SOURCE_TREE)fail('ENVELOPE_XII_RETRY_SOURCE_TREE_CHANGED');
 // %P checks the whole parent list, not merely a merge's first parent.
 if(git(repo,['show','-s','--format=%P',SOURCE_HEAD]).trim()!==SOURCE_PARENT)fail('ENVELOPE_XII_RETRY_SOURCE_PARENT_CHANGED');
 if(git(repo,['show','-s','--format=%s',SOURCE_HEAD]).trim()!==SOURCE_MESSAGE)fail('ENVELOPE_XII_RETRY_SOURCE_MESSAGE_CHANGED');
 const raw=git(repo,['diff','--no-renames','--name-only','-z',SOURCE_PARENT,SOURCE_HEAD]);
 if(!raw.endsWith('\0'))fail('ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED');
 const names=assertScope(raw.slice(0,-1).split('\0'));
 return {status:'ENVELOPE_XII_RETRY_SOURCE_OBJECT_VERIFIED',head:SOURCE_HEAD,tree,base:SOURCE_PARENT,
  changedPaths:names.length,paths:names,scopeAuthority:'archived-v4-implementation-lock',
  implementationFingerprint:MANIFEST_SHA256,implementationBlob:MANIFEST_BLOB};
}
module.exports={SOURCE_HEAD,SOURCE_TREE,SOURCE_PARENT,SOURCE_MESSAGE,MANIFEST_SHA256,MANIFEST_BLOB,MANIFEST_BYTES,
 CONTRACT,PATHS:CONTRACT.paths,parseManifest,assertScope,verifyPinned};
