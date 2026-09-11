'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
try{
 const m=JSON.parse(fs.readFileSync(path.join(root,'INTEGRITY.json'),'utf8'));
 for(const x of m.files){
  const p=path.resolve(root,x.path);if(!p.startsWith(root+path.sep)||path.isAbsolute(x.path))throw Error('bad path');
  const b=fs.readFileSync(p);if(b.length!==x.bytes||crypto.createHash('sha256').update(b).digest('hex')!==x.sha256)throw Error('changed file');
 }
 console.log(JSON.stringify({status:'PACKAGE_FILES_VERIFIED',files:m.files.length,gameActions:0}));
}catch{console.error('PACKAGE_INTEGRITY_FAILED');process.exitCode=1;}
