'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),P=require('../PACKAGE.json');
function fail(code){const e=new Error(code);e.code=code;throw e;}
function check(ok,code){if(!ok)fail(code);}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function read(file,max=32*1048576){const s=fs.lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&s.size<=max,'UNSAFE_FILE');return fs.readFileSync(file);}
const json=f=>JSON.parse(read(f).toString('utf8'));
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
const durable=(f,x)=>write(f,JSON.stringify(x,null,2)+'\n');
function safePath(n){check(typeof n==='string'&&n.length>0&&n.length<400&&!n.includes('\\')&&!n.includes(':')&&!n.includes('\0')&&!n.startsWith('/')&&!n.endsWith('/'),'UNSAFE_RELATIVE_PATH');const parts=n.split('/');check(parts.every(x=>x!==''&&x!=='.'&&x!=='..'&&!/[. ]$/.test(x)&&!/[\x00-\x1f<>"|?*]/.test(x)&&!(/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(x))),'UNSAFE_RELATIVE_PATH');return n;}
function list(root){const a=[];function walk(dir,rel=''){for(const n of fs.readdirSync(dir).sort()){const r=rel?rel+'/'+n:n;safePath(r);const s=fs.lstatSync(path.join(dir,n));check(!s.isSymbolicLink(),'SYMLINK_FORBIDDEN');if(s.isDirectory())walk(path.join(dir,n),r);else{check(s.isFile(),'SPECIAL_FILE_FORBIDDEN');a.push(r);}}}walk(root);return a.sort();}
function verify(root=ROOT){const raw=read(path.join(root,'INTEGRITY.json')),m=JSON.parse(raw),names=list(root).filter(n=>n!=='INTEGRITY.json');check(m.kind==='package-integrity/v1'&&m.files&&same(names,Object.keys(m.files).sort()),'PACKAGE_FILE_SET_CHANGED');for(const n of names){safePath(n);const b=read(path.join(root,n)),v=m.files[n];check(b.length===v.bytes&&sha(b)===v.sha256,'PACKAGE_BYTES_CHANGED:'+n);}return {files:names.length,fingerprint:sha(raw)};}
function seal(root){const files={};for(const n of list(root).filter(n=>n!=='INTEGRITY.json')){const b=read(path.join(root,n));files[n]={bytes:b.length,sha256:sha(b)};}const f=path.join(root,'INTEGRITY.json');if(fs.existsSync(f))fs.unlinkSync(f);durable(f,{kind:'package-integrity/v1',files});return verify(root);}
function git(repo,args,{allowFailure=false}={}){const r=cp.spawnSync('git',['-c','core.autocrlf=false','-c','core.eol=lf','-C',repo,...args],{encoding:null,maxBuffer:64*1048576,timeout:120000,stdio:['ignore','pipe','pipe']});if(allowFailure&&r.status!==0)return null;check(!r.error&&r.status===0,'GIT_OPERATION_FAILED');return r.stdout;}
const text=(r,a)=>git(r,a).toString('utf8').trim();
const head=r=>text(r,['rev-parse','HEAD']);
const tree=(r,h='HEAD')=>text(r,['rev-parse',h+'^{tree}']);
const clean=r=>check(git(r,['status','--porcelain=v1','-z','--untracked-files=all']).length===0,'WORKTREE_NOT_CLEAN');
function origin(repo){const url=text(repo,['remote','get-url','origin']);check(/^(https:\/\/github\.com\/ceyirelehe47\/screeps-bot(?:\.git)?|git@github\.com:ceyirelehe47\/screeps-bot(?:\.git)?)$/.test(url),'WRONG_REPOSITORY_ORIGIN');}
function remote(repo,branch){const r=text(repo,['ls-remote','--exit-code','origin','refs/heads/'+branch]).split(/\s+/);check(/^[a-f0-9]{40}$/.test(r[0]),'REMOTE_UNREADABLE');return r[0];}
function baseline(repo,branch,commit,{network=true}={}){clean(repo);check(text(repo,['branch','--show-current'])===branch&&head(repo)===commit,'BASELINE_CHANGED');if(network){origin(repo);check(remote(repo,branch)===commit,'REMOTE_BASE_CHANGED');}}
function real(p){p=path.resolve(p);return fs.existsSync(p)?fs.realpathSync(p):path.join(real(path.dirname(p)),path.basename(p));}
function outside(file,dir){const r=path.relative(real(dir),real(file));check(r!==''&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'DIRECTORY_NOT_ISOLATED');}
function env(){check(process.versions.node.split('.')[0]==='22','NODE22_REQUIRED');for(const n of ['NODE_OPTIONS','NODE_PATH','DEST','DEPLOY_ALLOW_DIRTY','NODE_TLS_REJECT_UNAUTHORIZED','FC1_TS_PATH'])check(!process.env[n],'UNSAFE_ENVIRONMENT');}
function args(names,flags=[]){const out={};for(let i=2;i<process.argv.length;i++){const a=process.argv[i];check(a.startsWith('--')&&!Object.hasOwn(out,a.slice(2)),'INVALID_ARGUMENT');const n=a.slice(2);if(flags.includes(n))out[n]=true;else{check(names.includes(n)&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'),'INVALID_ARGUMENT');out[n]=process.argv[++i];}}return out;}
const required=(o,keys)=>keys.forEach(k=>check(o[k],'MISSING_ARGUMENT:'+k));
function command(cwd,args,out,name,{allowFailure=false,timeout=1200000}={}){fs.mkdirSync(out,{recursive:true});const r=cp.spawnSync(process.execPath,args,{cwd,encoding:'utf8',maxBuffer:64*1048576,timeout,windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',DEST:'',DEPLOY_ALLOW_DIRTY:'',NODE_TLS_REJECT_UNAUTHORIZED:'',FC1_TS_PATH:''}});write(path.join(out,name+'.stdout'),r.stdout||'');write(path.join(out,name+'.stderr'),r.stderr||'');durable(path.join(out,name+'.exit.json'),{exit:r.status,signal:r.signal,error:r.error?.code||null});if(!allowFailure)check(!r.error&&r.status===0,'COMMAND_FAILED:'+name);return r;}
async function cli(fn){try{env();console.log(JSON.stringify(await fn()));}catch(e){console.error(JSON.stringify({status:'STOP',code:typeof e.code==='string'?e.code:'LOCAL_OPERATION_FAILED',phase:typeof e.phase==='string'?e.phase:null}));process.exitCode=1;}}
module.exports={fs,path,cp,ROOT,P,fail,check,sha,blob,same,read,json,write,durable,safePath,list,verify,seal,git,text,head,tree,clean,origin,remote,baseline,outside,env,args,required,command,cli};
