'use strict';
const crypto=require('node:crypto');
const C=require('../runtime/common.cjs');
const hash=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const guard={computeModulesHash:m=>hash(JSON.stringify(m)),diffRemoteModules:(a,b)=>{const ak=Object.keys(a).sort(),bk=Object.keys(b).sort(),missing=ak.filter(k=>!Object.hasOwn(b,k)),extra=bk.filter(k=>!Object.hasOwn(a,k)),changed=ak.filter(k=>Object.hasOwn(b,k)&&JSON.stringify(a[k])!==JSON.stringify(b[k]));return{match:!missing.length&&!extra.length&&!changed.length,missing,extra,changed};}};
const build=()=>({commit:C.PRODUCTION_BASE,tree:C.PRODUCTION_TREE,dirty:'folded_out',deployBranch:'default',tag:'fixture'});
const digest=(bytes=4494463,sha='37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b',h='84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf')=>({algorithm:'deployGuard.computeModulesHash/NUL-v1',hash:h,files:[{name:'main',kind:'text',bytes,sha256:sha}]});
const sample=(text='same',d=digest(),b=build(),at=1)=>({modules:{main:text},digest:d,build:b,capturedAtMs:at});
module.exports={C,guard,build,digest,sample};
