const ts=require('typescript'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../files');
const files=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.ts'))files.push(f);}}walk(root);
const diagnostics=[];
for(const f of files){const r=ts.transpileModule(fs.readFileSync(f,'utf8'),{fileName:f,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}});diagnostics.push(...(r.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')));}
const ast=ts.createSourceFile('main.ts',fs.readFileSync(path.join(root,'src/main.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='gameLoop');
const actual=fn.body.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='cpuProfiler.measure').map(n=>[n.expression.arguments[0].text,ts.isIdentifier(n.expression.arguments[1])?n.expression.arguments[1].text:'<inline>']);
const testAst=ts.createSourceFile('main.test.ts',fs.readFileSync(path.join(root,'src/main.test.ts'),'utf8'),ts.ScriptTarget.Latest,true);let expected;
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(testAst)==='canonicalTickPhases'){let x=n.initializer;while(ts.isAsExpression(x))x=x.expression;expected=x.elements.map(e=>e.elements.map(v=>v.text));}ts.forEachChild(n,visit);}visit(testAst);
const match=JSON.stringify(expected)===JSON.stringify(actual);console.log(JSON.stringify({compiler:ts.version,syntaxFileCount:files.length,diagnostics,phaseCount:actual.length,exactPhaseContractMatch:match,scope:'syntax + AST only; not full Jest/typecheck'},null,2));process.exitCode=diagnostics.length||!match?1:0;
