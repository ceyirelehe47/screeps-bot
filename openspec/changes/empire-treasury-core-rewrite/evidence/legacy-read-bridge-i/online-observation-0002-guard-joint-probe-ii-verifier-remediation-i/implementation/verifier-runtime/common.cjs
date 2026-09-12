'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const EXPECTED=Object.freeze({
  server:'https://screeps.com',
  username:'forster',
  userId:'634fe406347a7b69b28aeccb',
  branch:'default',
  shard:'shard1',
});
const ORIGINAL_DIGEST=Object.freeze({
  algorithm:'deployGuard.computeModulesHash/NUL-v1',
  hash:'84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf',
  files:Object.freeze([
    Object.freeze({
      name:'main',kind:'text',bytes:4494463,
      sha256:'37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b',
    }),
  ]),
});
const PRODUCTION_BASE='06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c';
const PRODUCTION_TREE='929fa9557b1a36135a5ef1605231be1d16e87366';

class Failure extends Error {
  constructor(code,details={}){super(code);this.name='Failure';this.code=code;this.details=details;}
}
function fail(code,details){throw new Failure(code,details);}
const obj=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const clone=value=>JSON.parse(JSON.stringify(value));
const exact=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const safeTime=value=>Number.isSafeInteger(value)&&value>=0;
function strictIncreasing(values){
  if(!Array.isArray(values))return false;
  for(let index=1;index<values.length;index++)if(!(values[index]>values[index-1]))return false;
  return true;
}
function nondecreasing(values){
  if(!Array.isArray(values))return false;
  for(let index=1;index<values.length;index++)if(values[index]<values[index-1])return false;
  return true;
}
function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}
function sha256File(file){return sha256(fs.readFileSync(file));}
function options(argv,names,flags=[]){
  const out={};
  for(let index=0;index<argv.length;index++){
    const raw=argv[index];
    if(typeof raw!=='string'||!raw.startsWith('--'))fail('INVALID_ARGUMENTS');
    const key=raw.slice(2);
    if(!key||own(out,key))fail('INVALID_ARGUMENTS');
    if(flags.includes(key)){out[key]=true;continue;}
    if(!names.includes(key)||index+1>=argv.length||argv[index+1].startsWith('--'))fail('INVALID_ARGUMENTS');
    out[key]=argv[++index];
  }
  return out;
}
function required(value,...keys){for(const key of keys)if(!value[key])fail('MISSING_ARGUMENT',{key});}
function readJson(file,maxBytes=20*1024*1024){
  try{
    const stat=fs.statSync(file);
    if(!stat.isFile()||stat.size>maxBytes)fail('FILE_INVALID_OR_TOO_LARGE',{file:path.basename(file)});
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }catch(error){if(error instanceof Failure)throw error;fail('LOCAL_JSON_UNREADABLE',{file:path.basename(file)});}
}
function writeNew(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
}
function safeFailure(error){return error instanceof Failure?{error:error.code,...error.details}:{error:'UNEXPECTED_LOCAL_FAILURE'};}
function entrypoint(fn){Promise.resolve().then(fn).catch(error=>{process.stderr.write(JSON.stringify(safeFailure(error))+'\n');process.exitCode=1;});}

module.exports={
  EXPECTED,ORIGINAL_DIGEST,PRODUCTION_BASE,PRODUCTION_TREE,
  Failure,fail,obj,own,clone,exact,safeTime,strictIncreasing,nondecreasing,
  sha256,sha256File,options,required,readJson,writeNew,safeFailure,entrypoint,
};
