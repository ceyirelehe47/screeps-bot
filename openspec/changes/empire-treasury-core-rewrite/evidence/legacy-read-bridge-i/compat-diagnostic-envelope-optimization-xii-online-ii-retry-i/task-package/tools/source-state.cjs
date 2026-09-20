'use strict';
function failure(code){const e=new Error(code);e.code=code;throw e;}
function selectLocalSource({current,base,currentTree,expectedTree,supersededTree,verifyBaseline,verifyHead,verifySuperseded}){
 if([current,base,currentTree,expectedTree].some(x=>typeof x!=='string')||typeof verifyBaseline!=='function'||typeof verifyHead!=='function'||typeof verifySuperseded!=='function')failure('SOURCE_STATE_ARGUMENT_INVALID');
 if(current===base)return {localState:'base',source:verifyBaseline()};
 if(currentTree===expectedTree)return {localState:'already-applied',source:verifyHead()};
 if(typeof supersededTree==='string'&&currentTree===supersededTree)return {localState:'superseded-applied',source:verifySuperseded()};
 failure('LOCAL_SOURCE_STATE_UNRECOGNIZED');
}
module.exports={selectLocalSource};
