#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
try{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'INTEGRITY.json'),'utf8'));
 let count=0;
 for(const row of manifest.files){
  if(!row.path || row.path.includes('\\') || row.path.split('/').includes('..') || path.isAbsolute(row.path))throw Error('unsafe manifest path');
  const p=path.join(root,row.path),real=fs.realpathSync(p);
  if(!real.startsWith(fs.realpathSync(root)+path.sep) || fs.lstatSync(p).isSymbolicLink())throw Error('unsafe package link');
  const b=fs.readFileSync(p),digest=crypto.createHash('sha256').update(b).digest('hex');
  if(b.length!==row.bytes||digest!==row.sha256)throw Error('package identity mismatch: '+row.path);
  count++;
 }
 console.log(JSON.stringify({status:'PACKAGE_BYTES_MATCH_MANIFEST',files:count}));
}catch(e){console.error('PACKAGE_REFUSED: '+e.message);process.exitCode=1;}
