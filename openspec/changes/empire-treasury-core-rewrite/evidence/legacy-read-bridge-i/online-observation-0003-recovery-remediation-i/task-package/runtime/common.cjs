'use strict';
const fs=require('node:fs'),path=require('node:path');
const B=require('../vendor/0003/common.cjs');
const code=e=>e instanceof B.Failure&&/^[A-Z0-9_]{1,96}$/.test(e.code)?e.code:'LOCAL_OPERATION_FAILED';
function bytes(p,max=24*1048576){
 try{const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.size>max)B.fail('INPUT_FILE_INVALID');return fs.readFileSync(p);}
 catch(e){if(e instanceof B.Failure)throw e;B.fail('INPUT_FILE_UNREADABLE');}
}
function json(p,max){try{return JSON.parse(bytes(p,max));}catch(e){if(e instanceof B.Failure)throw e;B.fail('INPUT_JSON_INVALID');}}
function durable(p,value){
 let fd;try{fd=fs.openSync(p,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}
 catch(e){if(e instanceof B.Failure)throw e;B.fail(e.code==='EEXIST'?'ARTIFACT_ALREADY_EXISTS':'ARTIFACT_WRITE_FAILED');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
 return value;
}
function log(p,value){const fd=fs.openSync(p,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify({atMs:Date.now(),...value})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function mkdirNew(p){if(fs.existsSync(p))B.fail('OUTPUT_ALREADY_EXISTS');fs.mkdirSync(p,{recursive:false,mode:0o700});}
function list(dir,prefix=''){const a=[];for(const n of fs.readdirSync(dir).sort()){
 const p=path.join(dir,n),st=fs.lstatSync(p);if(st.isSymbolicLink())B.fail('SYMLINK_NOT_ALLOWED');
 if(st.isDirectory())a.push(...list(p,prefix+n+'/'));else if(st.isFile())a.push(prefix+n);else B.fail('SPECIAL_FILE_NOT_ALLOWED');}return a.sort();}
function resolveReal(p){p=path.resolve(p);if(fs.existsSync(p))return fs.realpathSync(p);return path.join(resolveReal(path.dirname(p)),path.basename(p));}
function inside(child,parent){const rel=path.relative(resolveReal(parent),resolveReal(child));return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
function disjoint(a,b){if(inside(a,b)||inside(b,a))B.fail('PATHS_MUST_BE_DISJOINT');}
async function main(fn){try{await fn();}catch(e){process.stderr.write(JSON.stringify({error:code(e)})+'\n');process.exitCode=1;}}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
module.exports={...B,code,bytes,json,durable,log,mkdirNew,list,resolveReal,inside,disjoint,main,same};
