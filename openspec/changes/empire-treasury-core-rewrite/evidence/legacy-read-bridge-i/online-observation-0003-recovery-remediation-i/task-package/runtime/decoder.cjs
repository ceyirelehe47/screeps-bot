'use strict';
const C=require('./common.cjs');
const named=Object.freeze({quot:'"',apos:"'",lt:'<',gt:'>',amp:'&'});
/** Decode one transport escape layer only. Never recursively decode newly produced '&'. */
function decodeHtmlOnce(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>1048576)C.fail('CONSOLE_TEXT_INVALID');
 return text.replace(/&(quot|apos|lt|gt|amp|#\d+|#[xX][0-9a-fA-F]+);/g,(_,v)=>{
  if(v[0]!=='#')return named[v];
  const hex=/^#[xX]/.test(v),digits=v.slice(hex?2:1);
  if(digits.length>8)C.fail('CONSOLE_ENTITY_INVALID');
  const n=Number.parseInt(digits,hex?16:10);
  if(!Number.isSafeInteger(n)||n<=0||n>0x10ffff||(n>=0xd800&&n<=0xdfff))C.fail('CONSOLE_ENTITY_INVALID');
  return String.fromCodePoint(n);
 });
}
function parseBridge(text){
 if(typeof text!=='string')return {kind:'ignored'};
 let value,encoding='raw-json';
 try{value=JSON.parse(text);}catch{
  if(!text.includes('treasury-legacy-read-bridge'))return {kind:'ignored'};
  try{value=JSON.parse(decodeHtmlOnce(text));encoding='html-entities-single-layer';}
  catch(e){return {kind:'invalid',error:e instanceof C.Failure?e.code:'BRIDGE_JSON_INVALID'};}
 }
 return value?.kind==='treasury-legacy-read-bridge'?{kind:'bridge',encoding,report:value}:{kind:'ignored'};
}
module.exports={decodeHtmlOnce,parseBridge};
