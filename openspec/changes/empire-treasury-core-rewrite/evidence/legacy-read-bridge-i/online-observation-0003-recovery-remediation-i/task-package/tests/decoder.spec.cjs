'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const D=require('../runtime/decoder.cjs'),F=require('./fixture.cjs');
const old=require('../vendor/0003/samples.cjs'),R=require('../runtime/replay.cjs');
for(const [name,encode]of Object.entries({raw:x=>x,named:x=>x.replace(/"/g,'&quot;'),decimal:x=>x.replace(/"/g,'&#34;'),hex:x=>x.replace(/"/g,'&#x22;'),upperHex:x=>x.replace(/"/g,'&#X22;')}))
 test('decoder handles '+name+' without inventing a complete sample',()=>{const p=D.parseBridge(encode(JSON.stringify(F.observedReport())));assert.equal(p.kind,'bridge');assert.equal(p.report.tick,73646500);assert.equal(old.sampleError(p.report,F.session().profile),'SAMPLE_NOT_COMPLETE');});
test('one pass does not recursively decode nested amp escapes',()=>assert.equal(D.decodeHtmlOnce('&amp;#x22;'),'&#x22;'));
test('raw JSON containing literal entities is not transformed',()=>{const x={kind:'treasury-legacy-read-bridge',note:'&#x22; &amp;'};assert.deepEqual(D.parseBridge(JSON.stringify(x)).report,x);});
test('supported named and decimal entities are decoded once',()=>assert.equal(D.decodeHtmlOnce('&lt;&gt;&amp;&apos;&#39;&#x1F600;'),"<>&''😀"));
for(const entity of ['&#0;','&#xD800;','&#1114112;','&#999999999999999;'])test('invalid scalar rejected: '+entity,()=>assert.throws(()=>D.decodeHtmlOnce(entity),{code:'CONSOLE_ENTITY_INVALID'}));
test('malformed bridge JSON is not repaired by extra decoding passes',()=>assert.equal(D.parseBridge('{&amp;#x22;kind&amp;#x22;:treasury-legacy-read-bridge}').kind,'invalid'));
test('nonbridge plain log is ignored',()=>assert.equal(D.parseBridge('ordinary console line').kind,'ignored'));
test('old decoder negative control reproduces hexadecimal parse failure',()=>assert.throws(()=>JSON.parse(old.decode(JSON.stringify(F.observedReport()).replace(/"/g,'&#x22;')))));
test('replay records receipt separately from qualified sample count',()=>{const s=F.session(),r=R.replay(F.firstFrame(s),s);assert.equal(r.rawBridgeReports,1);assert.equal(r.completeBridgeReports,0);assert.equal(r.missingRawTicks.length,11);assert.equal(r.missingCompleteTicks.length,12);assert.equal(r.cpuFindings[0].commitmentsStatus,'not_read_cpu_budget');assert.equal(r.cpuFindings[0].budgetChanged,false);});
test('wrong run evidence is rejected rather than silently counted',()=>assert.throws(()=>R.replay(F.firstFrame(F.session()),{...F.session(),runId:'other'}),{code:'SOURCE_RUN_ID_MISMATCH'}));
test('wrong shard frames do not contribute bridge reports',()=>{const s=F.session(),line=JSON.parse(F.firstFrame(s));const f=JSON.parse(line.text);f[1].shard='shard2';line.text=JSON.stringify(f);assert.equal(R.replay(JSON.stringify(line),s).rawBridgeReports,0);});
