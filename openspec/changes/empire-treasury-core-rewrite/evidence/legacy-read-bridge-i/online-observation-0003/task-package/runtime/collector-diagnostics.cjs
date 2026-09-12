'use strict';
const crypto=require('node:crypto');
const C=require('./common.cjs');
const MAX_MESSAGE_BYTES=1024;
const MAX_STACK_BYTES=4096;
const SAFE_STOP_REASONS=new Set(['probe_complete','operator_stop']);
function truncateUtf8(value,maxBytes) {
  let text=String(value??'');
  if(Buffer.byteLength(text)<=maxBytes)return {text,truncated:false};
  while(text.length&&Buffer.byteLength(text)>maxBytes)text=text.slice(0,Math.max(0,text.length-Math.max(1,Math.ceil(text.length/8))));
  return {text,truncated:true};
}
function sanitized(value,redact,maxBytes) {return truncateUtf8(redact(String(value??'')),maxBytes);}
function hashText(value) {return typeof value==='string'&&value.length?crypto.createHash('sha256').update(value).digest('hex'):null;}
function safeCode(value) {return (typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value))||Number.isSafeInteger(value)?value:null;}
function errorObject(value) {
  if(value&&typeof value==='object'&&value.error&&typeof value.error==='object')return value.error;
  return value&&typeof value==='object'?value:{};
}
function safeError(value,redact) {
  const source=errorObject(value),cause=source.cause&&typeof source.cause==='object'?source.cause:{};
  const message=sanitized(typeof source.message==='string'?source.message:'',redact,MAX_MESSAGE_BYTES);
  const stack=sanitized(typeof source.stack==='string'?source.stack:'',redact,MAX_STACK_BYTES);
  return {eventType:value&&typeof value.type==='string'&&value.type.length<=128?value.type:null,
    name:typeof source.name==='string'&&source.name.length<=128?source.name:null,
    code:safeCode(source.code),causeName:typeof cause.name==='string'&&cause.name.length<=128?cause.name:null,
    causeCode:safeCode(cause.code),errno:safeCode(cause.errno??source.errno),
    syscall:typeof (cause.syscall??source.syscall)==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(cause.syscall??source.syscall)
      ?(cause.syscall??source.syscall):null,
    messageBytes:Buffer.byteLength(message.text),messageSha256:hashText(message.text),
    stackBytes:Buffer.byteLength(stack.text),stackSha256:hashText(stack.text),
    messageTruncated:message.truncated,stackTruncated:stack.truncated,
    redactionChanged:message.text!==(typeof source.message==='string'?source.message:'')
      ||stack.text!==(typeof source.stack==='string'?source.stack:'')};
}
function safeClose(value,redact) {
  const code=Number.isSafeInteger(value?.code)&&value.code>=0&&value.code<=65535?value.code:null;
  const reason=sanitized(typeof value?.reason==='string'?value.reason:'',redact,MAX_MESSAGE_BYTES);
  return {code,reason:reason.text,reasonTruncated:reason.truncated,
    wasClean:typeof value?.wasClean==='boolean'?value.wasClean:null};
}
function publicError(detail) {return detail?{...detail}:null;}
function auditPrivate(file,data,redact) {C.audit(file,{kind:'collector-private-diagnostic',...data},redact);}
function validStopRequest(value,runId) {return value&&value.runId===runId&&SAFE_STOP_REASONS.has(value.reason)
  &&Number.isSafeInteger(value.requestedAtMs)&&value.requestedAtMs>=0;}
module.exports={MAX_MESSAGE_BYTES,MAX_STACK_BYTES,SAFE_STOP_REASONS,truncateUtf8,safeError,safeClose,
  publicError,auditPrivate,validStopRequest};
