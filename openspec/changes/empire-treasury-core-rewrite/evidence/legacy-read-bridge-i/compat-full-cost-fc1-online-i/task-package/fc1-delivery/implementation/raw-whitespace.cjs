'use strict';
/** Raw text is evidence, not source formatting. Every exact exception is pinned
 * before manifest generation; all other paths keep the native whitespace gate. */
const fs=require('node:fs'),path=require('node:path'),C=require('../runtime/common.cjs');
const PROOF='RAW-LOG-PRESERVATION.json';
const isRaw=n=>/\.(?:stdout|stderr|tap|jsonl)$/.test(n);
function badLines(bytes){const lines=bytes.toString('utf8').split('\n'),out=[];for(let i=0;i<lines.length;i++){
 const line=lines[i].replace(/\r$/,'');if(/[\t ]+$/.test(line))out.push({line:i+1,type:'trailing-whitespace'});
 }return out;}
function createProof(root){const rows=[];for(const n of C.list(root)){if(!isRaw(n))continue;const b=C.bytes(path.join(root,n),64*1048576),bad=badLines(b);if(bad.length)rows.push({path:n,bytes:b.length,sha256:C.sha(b),gitBlob:C.blob(b),findings:bad});}
 const proof={kind:'raw-log-preservation/v1',policy:'Preserve raw bytes. Exact SHA-bound raw-log paths only; source/config/docs are not exempt.',files:rows};C.durable(path.join(root,PROOF),proof);return proof;}
function checkStaged(repo,prefix){const R=require('./repository.cjs'),raw=R.git(repo,['show',':'+prefix+'/'+PROOF]),proof=JSON.parse(raw);if(proof.kind!=='raw-log-preservation/v1'||!Array.isArray(proof.files))C.fail('RAW_PROOF_INVALID');
 const all=R.git(repo,['diff','--cached','--name-only','-z']).toString('utf8').split('\0').filter(Boolean);if(all.some(n=>!n.startsWith(prefix+'/')))C.fail('EVIDENCE_SCOPE_CHANGED');
 const seen=new Set(),exclude=[];for(const x of proof.files){if(typeof x.path!=='string'||x.path.startsWith('/')||x.path.split('/').some(p=>!p||p==='.'||p==='..')||x.path.includes('\\')||!isRaw(x.path)||seen.has(x.path))C.fail('RAW_EXCEPTION_PATH_INVALID');seen.add(x.path);const n=prefix+'/'+x.path,b=R.git(repo,['show',':'+n]);if(b.length!==x.bytes||C.sha(b)!==x.sha256||C.blob(b)!==x.gitBlob||!C.same(badLines(b),x.findings)||!x.findings.length)C.fail('RAW_EXCEPTION_BYTES_CHANGED');exclude.push(':(top,exclude,literal)'+n);}
 // Native check still covers every unlisted raw file and every source-like file.
 R.git(repo,['diff','--cached','--check','--','.',...exclude]);return {status:'RAW_BYTES_AND_REMAINING_WHITESPACE_VERIFIED',exceptions:proof.files};}
module.exports={PROOF,isRaw,badLines,createProof,checkStaged};
