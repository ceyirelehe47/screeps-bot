const ts=require('typescript'); const path=require('node:path');const fs=require('node:fs');
const root=path.resolve(__dirname,'../files');
const files=['src/config/treasuryReadOnly.ts','src/runtime/treasury/readOnlyObservation.ts','src/runtime/treasuryReadOnlyRuntime.ts'].map(f=>path.join(root,f));
const options={target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,strict:true,noEmit:true,baseUrl:root,paths:{'@/*':['src/*']},lib:['lib.es2020.d.ts'],types:[]};
const program=ts.createProgram([...files,path.join(__dirname,'typecheck-context.d.ts')],options);
const ds=ts.getPreEmitDiagnostics(program);console.log(JSON.stringify({compiler:ts.version,scope:'new three modules + selected local declarations only; not full project types',diagnostics:ds.map(d=>({file:d.file?.fileName,start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))},null,2));process.exitCode=ds.length?1:0;
