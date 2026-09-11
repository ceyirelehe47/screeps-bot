#!/usr/bin/env node
'use strict';
const C=require('./common.cjs');const {client}=require('./transport.cjs');
// Do not guess a particular undocumented countdown property. Retain only actual
// scalar timing/rate-limit fields; no raw response, credential or URL is emitted.
function timingFields(value,depth=0,prefix='') {
  const out={};if(!C.obj(value)||depth>2)return out;
  for(const [k,v] of Object.entries(value)) {
    if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k))continue;
    if(/limit|expire|duration|timer|countdown|ttl/i.test(k) && (typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v)))) out[prefix+k]=v;
    else if(C.obj(v))Object.assign(out,timingFields(v,depth+1,prefix+k+'.'));
  }
  return out;
}
async function main(argv){
  const o=C.options(argv,['secret']);C.required(o,'secret');const secret=C.loadSecret(o.secret);
  const r=await client(secret).queryToken();const fields=timingFields(r);
  console.log(secret.redact(JSON.stringify({status:'TOKEN_QUERY_RESPONDED',queriedAt:new Date().toISOString(),fields,
    countdownInterpretation:'inspect actual returned timing fields; HTTP 200 alone does not prove exemption',
    actualFieldCount:Object.keys(fields).length})));
}
module.exports={timingFields};if(require.main===module)C.entrypoint(()=>main(process.argv.slice(2)));
