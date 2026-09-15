'use strict';
const assert=require('node:assert/strict');

function fail(code){const e=new Error(code);e.code=code;throw e;}
function typescript(){const p=process.env.CPU_DIAG_TS_MODULE;if(!p)fail('TYPESCRIPT_PATH_REQUIRED');return require(p);}
function callName(ts,expression){
 if(ts.isIdentifier(expression))return expression.text;
 if(ts.isPropertyAccessExpression(expression))return expression.name.text;
 if(ts.isElementAccessExpression(expression)&&expression.argumentExpression&&ts.isStringLiteralLike(expression.argumentExpression))return expression.argumentExpression.text;
 return null;
}
function containsRetryCall(ts,node){let found=false;(function visit(n){if(found)return;if(ts.isCallExpression(n)&&callName(ts,n.expression)==='readWithRetry'){found=true;return;}ts.forEachChild(n,visit);})(node);return found;}
function assertWriteRetrySeparation(actionsText,readRetryText){
 assert.equal(typeof actionsText,'string');assert.equal(typeof readRetryText,'string');assert.match(readRetryText,/\breadWithRetry\b/);
 const ts=typescript(),source=ts.createSourceFile('runtime/actions.cjs',actionsText,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),retryWrappers=new Set(),writes=[];let retryCalls=0;
 (function collect(node){
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&containsRetryCall(ts,node.initializer))retryWrappers.add(node.name.text);
  ts.forEachChild(node,collect);
 })(source);
 (function visit(node){
  if(ts.isCallExpression(node)){
   const name=callName(ts,node.expression);
   if(name==='readWithRetry')retryCalls++;
   if(name==='setCode'){
    writes.push(node);
    for(let p=node.parent;p;p=p.parent){
     if(ts.isCallExpression(p)){
      const ancestorName=callName(ts,p.expression);
      if(ancestorName==='readWithRetry'||retryWrappers.has(ancestorName))fail('WRITE_INSIDE_READ_RETRY');
     }
    }
   }
  }
  ts.forEachChild(node,visit);
 })(source);
 assert.equal(writes.length,2,'candidate and restore must remain the only setCode calls');
 assert.ok(retryCalls>=1,'read-only retry must remain present for GET-like observations');
 const writeTexts=writes.map(x=>x.getText(source));
 assert.equal(writeTexts.filter(x=>/s\.candidate\.modules/.test(x)).length,1,'candidate write identity changed');
 assert.equal(writeTexts.filter(x=>/s\.backup\.modules/.test(x)).length,1,'restore write identity changed');
 return Object.freeze({writes:writes.length,retryCalls,retryWrappers:Object.freeze([...retryWrappers].sort())});
}
module.exports={assertWriteRetrySeparation,callName,containsRetryCall};
