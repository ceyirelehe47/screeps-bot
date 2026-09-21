'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const POLICY=require('../policy.json');
const {performance}=require('node:perf_hooks');
class Failure extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new Failure(code);};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const code=e=>e instanceof Failure?e.code:'LOCAL_OPERATION_FAILED';
function bytes(p,max=20*1048576){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>max)fail('UNSAFE_INPUT_FILE');return fs.readFileSync(p);}
function json(p){try{return JSON.parse(bytes(p).toString('utf8'));}catch(e){if(e instanceof Failure)throw e;fail('JSON_INPUT_UNREADABLE');}}
function durable(p,x){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(x,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function append(p,x){const fd=fs.openSync(p,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(x)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function options(names,flags=[]){const out={};for(let i=2;i<process.argv.length;i++){const a=process.argv[i];if(!a.startsWith('--')||Object.hasOwn(out,a.slice(2)))fail('INVALID_ARGUMENT');const k=a.slice(2);if(flags.includes(k))out[k]=true;else if(names.includes(k)&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))out[k]=process.argv[++i];else fail('INVALID_ARGUMENT');}return out;}
function requireArgs(o,keys){for(const k of keys)if(!o[k])fail('MISSING_ARGUMENT');}
function environment(){if(Number(process.versions.node.split('.')[0])!==22)fail('NODE22_REQUIRED');for(const n of ['NODE_OPTIONS','NODE_PATH','DEST','DEPLOY_ALLOW_DIRTY','NODE_TLS_REJECT_UNAUTHORIZED'])if(process.env[n])fail('UNSAFE_ENVIRONMENT');}
function redactor(token){const forms=[token,encodeURIComponent(token),token.slice(0,8),token.slice(0,16),Buffer.from(token).toString('base64')].filter(x=>x.length>=8).sort((a,b)=>b.length-a.length);return text=>{let s=String(text);for(const f of forms)s=s.split(f).join('<REDACTED>');return s.replace(/((?:x-token|authorization|access_token|token)\s*[=:]\s*["']?)[^\s"',;}]+/gi,'$1<REDACTED>');};}
function loadSecret(p){const s=json(p)?.main;if(!obj(s)||typeof s.token!=='string'||s.token.length<16||/[\s\r\n]/.test(s.token)||s.hostname!=='screeps.com'||s.branch!=='default'||(s.protocol!==undefined&&s.protocol!=='https')||(s.port!==undefined&&s.port!==443)||(s.path!==undefined&&s.path!=='/'))fail('CREDENTIAL_TARGET_INVALID');return {token:s.token,redact:redactor(s.token)};}
function list(root){const files=[];function walk(dir){for(const n of fs.readdirSync(dir).sort()){const f=path.join(dir,n),s=fs.lstatSync(f);if(s.isSymbolicLink())fail('SYMLINK_FORBIDDEN');if(s.isDirectory())walk(f);else if(s.isFile())files.push(path.relative(root,f).split(path.sep).join('/'));else fail('SPECIAL_FILE_FORBIDDEN');}}walk(root);return files;}
function verifyPackage(){const root=path.resolve(__dirname,'..'),m=json(path.join(root,'INTEGRITY.json'));const files=list(root).filter(n=>n!=='INTEGRITY.json');if(!same(files.sort(),Object.keys(m.files).sort()))fail('PACKAGE_FILE_SET_CHANGED');for(const n of files){const b=bytes(path.join(root,n));if(b.length!==m.files[n].bytes||sha(b)!==m.files[n].sha256)fail('PACKAGE_BYTES_CHANGED');}return {status:'PACKAGE_INTEGRITY_VERIFIED',files:files.length,fingerprint:sha(bytes(path.join(root,'INTEGRITY.json')))};}
async function cli(fn){try{environment();await fn();}catch(e){console.error(JSON.stringify({status:'STOP',error:code(e)}));process.exitCode=1;}}
module.exports={POLICY,Failure,fail,obj,sha,blob,same,pause,code,bytes,json,durable,append,options,requireArgs,environment,redactor,loadSecret,list,verifyPackage,cli};

function optional(dir,name){const p=path.join(dir,name);return fs.existsSync(p)?json(p):null;}
function atomic(p,x){const tmp=p+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';durable(tmp,x);try{for(let i=0;;i++){try{fs.renameSync(tmp,p);break;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||i===5)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20*(i+1));}}}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
async function lock(dir,name,fn,waitMs=180000){const p=path.join(dir,name+'.lock'),end=performance.now()+waitMs;let fd;
 while(fd===undefined){try{fd=fs.openSync(p,'wx',0o600);}catch(e){if(e.code!=='EEXIST')fail('LOCK_IO');const st=fs.statSync(p);let owner;try{owner=json(p);}catch{}if(owner?.authorizationId===POLICY.authorizationId&&!alive(owner.pid)){const now=fs.statSync(p);if(now.ino===st.ino&&now.mtimeMs===st.mtimeMs){fs.unlinkSync(p);continue;}}if(performance.now()>=end)fail('ACTION_BUSY');await pause(100);}}
 try{fs.writeFileSync(fd,JSON.stringify({authorizationId:POLICY.authorizationId,pid:process.pid}));fs.fsyncSync(fd);return await fn();}finally{fs.closeSync(fd);fs.unlinkSync(p);}}
function jsonl(p){if(!fs.existsSync(p))return [];const text=bytes(p,64*1048576).toString('utf8');if(text&&!text.endsWith('\n'))fail('TRUNCATED_JSONL');return text.trimEnd().split('\n').filter(Boolean).map(x=>JSON.parse(x));}
function event(dir,kind,x={}){append(path.join(dir,'actions.jsonl'),{atMs:Date.now(),runId:POLICY.parentRunId,kind,...x});}
Object.assign(module.exports,{optional,atomic,alive,lock,jsonl,event});
