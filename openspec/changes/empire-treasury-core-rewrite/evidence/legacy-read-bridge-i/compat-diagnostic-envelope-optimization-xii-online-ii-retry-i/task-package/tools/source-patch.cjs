'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const FIXED=Object.freeze([
 'docs/treasury-compat-diagnostic-envelope-optimization-xii.md',
 'scripts/build-treasury-compat-loader.cjs',
 'scripts/lib/treasury-compat-envelope.cjs',
 'src/runtime/treasuryCompatCpu.ts',
 'src/runtime/treasuryCompatRead.ts',
 'test/treasury-compat/envelope-optimization.spec.cjs',
 'test/treasury-compat/fixtures/reader-before-envelope-optimization-xii.ts.txt',
 'test/treasury-compat/fixtures/cpu-before-envelope-optimization-xii.ts.txt',
]);
const GENERATED=Object.freeze(['docs/treasury-compat-loader-optimization.json','docs/treasury-compat-source-manifest.json']);
const ATTRIBUTION='test/treasury-compat/attribution.spec.cjs';
const PATHS=Object.freeze([...FIXED,...GENERATED,ATTRIBUTION].sort());
const NEW=Object.freeze([
 'docs/treasury-compat-diagnostic-envelope-optimization-xii.md',
 'scripts/lib/treasury-compat-envelope.cjs',
 'test/treasury-compat/envelope-optimization.spec.cjs',
 'test/treasury-compat/fixtures/reader-before-envelope-optimization-xii.ts.txt',
 'test/treasury-compat/fixtures/cpu-before-envelope-optimization-xii.ts.txt',
]);
const BASE=Object.freeze({
 'scripts/build-treasury-compat-loader.cjs':{bytes:13342,sha256:'7e40a07d5510106f124041a5f222552810c835978521c8d57d0ab2179b4eb61f',blob:'3b0bb31a8af2070cce10df6c0563efb78f618263'},
 'src/runtime/treasuryCompatCpu.ts':{bytes:6724,sha256:'e7dead62745052c278163281a524d765ef109df9556060a283dac35590fa042c',blob:'076cc6b1a02518b0ff0e4f503e09e74b8c47464e'},
 'src/runtime/treasuryCompatRead.ts':{bytes:21631,sha256:'9e454bde732a08ba1880cae02ada391219054c70cb54aff600d7a8bde667bd2f',blob:'fe92498f5e76d860e4fef98d842df3c2e8fc48ad'},
 'test/treasury-compat/attribution.spec.cjs':{bytes:15300,sha256:'261b9ab186dcbd91d95129671800f6cd46015ea7f679b2efbaa560caa9e9c46a',blob:'5fdd60bb03f491bc090929025ac20cc94af0dff2'},
 'docs/treasury-compat-loader-optimization.json':{bytes:8849,sha256:'5b7a39f882086933b1e4ca51531b530475c77a62b5eb696c7e734717e5d01708',blob:'93ac1cd17cd4c31282c01882ef5e8f4231e5e66c'},
 'docs/treasury-compat-source-manifest.json':{bytes:8283,sha256:'fa117d613bb42ccbfd77d337f304e96ef743591a8661899ed30d6fc3040bfbdb',blob:'4cb8fc7599a0d6b202307b6ac14381046b1f8edf'},
});
const BEFORE=`test('IX first and later samples each retain only their own primitive attribution snapshot', () => {
  const s = A.diagnosticScene(); s.observer.run(); const first = H.json(s.report().cpuProfile.attribution);
  s.memory.data.resourceControl.tasks.x = S.task(); s.game.time = 200; s.cpuValue = 0.1; s.observer.run();
  assert.equal(s.report().cpuProfile.attribution.work.commitmentTaskRecords, 1);
  assert.equal(first.work.commitmentTaskRecords, 0); assert.equal(s.report().previousCpuProfile.attribution.work.commitmentTaskRecords, 0);
});`;
const AFTER=`test('XII first and later samples retain prefix attribution without duplicating it into completion', () => {
  const s = A.diagnosticScene(); s.observer.run(); const first = H.json(s.report().cpuProfile.attribution);
  s.memory.data.resourceControl.tasks.x = S.task(); s.game.time = 200; s.cpuValue = 0.1; s.observer.run();
  const tail = s.report().previousCpuProfile;
  assert.equal(s.report().cpuProfile.attribution.work.commitmentTaskRecords, 1);
  assert.equal(first.work.commitmentTaskRecords, 0); assert.equal(tail.completion, 'tail_only');
  assert.equal(tail.attribution, undefined); assert.deepEqual(Object.keys(tail.phases).sort(), ['emit','retention','serializationAndSize']);
});`;
const lf=b=>Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');
function identity(b){b=lf(b);return {bytes:b.length,sha256:sha(b),blob:blob(b)};}
function checkIdentity(b,x,code){const i=identity(b);if(i.bytes!==x.bytes||i.sha256!==x.sha256||i.blob!==x.blob){const e=new Error(code);e.code=code;throw e;}return i;}
function payload(rel){return lf(fs.readFileSync(path.join(ROOT,'source/implementation',rel)));}
function expectedAttribution(b){const s=lf(b).toString('utf8'),n=s.split(BEFORE).length-1;if(n!==1){const e=new Error('ATTRIBUTION_XII_TRANSFORM_COUNT');e.code='ATTRIBUTION_XII_TRANSFORM_COUNT';throw e;}return Buffer.from(s.replace(BEFORE,AFTER));}
function verifyBaseline(repo){for(const[rel,x]of Object.entries(BASE))checkIdentity(fs.readFileSync(path.join(repo,rel)),x,'SOURCE_BASELINE_CHANGED');for(const rel of NEW)if(fs.existsSync(path.join(repo,rel))){const e=new Error('IMPLEMENTATION_PATH_ALREADY_EXISTS');e.code='IMPLEMENTATION_PATH_ALREADY_EXISTS';throw e;}return true;}
function writeFixed(repo){for(const rel of FIXED){const out=path.join(repo,rel);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,payload(rel));}return FIXED;}
function write(repo){verifyBaseline(repo);writeFixed(repo);fs.writeFileSync(path.join(repo,ATTRIBUTION),expectedAttribution(fs.readFileSync(path.join(repo,ATTRIBUTION))));return PATHS;}
function expectedFixed(){return Object.fromEntries(FIXED.map(rel=>[rel,identity(payload(rel))]));}
module.exports={ROOT,FIXED,GENERATED,ATTRIBUTION,PATHS,NEW,BASE,BEFORE,AFTER,lf,sha,blob,identity,checkIdentity,payload,expectedAttribution,verifyBaseline,writeFixed,write,expectedFixed};
