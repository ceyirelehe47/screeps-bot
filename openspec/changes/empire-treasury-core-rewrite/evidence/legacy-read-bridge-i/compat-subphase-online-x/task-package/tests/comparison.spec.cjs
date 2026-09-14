'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('./reader-fixture.cjs'),M=require('../tools/compare.cjs'),W=require('../runtime/samples.cjs');
function reports(opts={}){const f=H.fixture({probeCost:.001,...opts}),p=H.profile(),v=H.loadReader().exports.createTreasuryCompatPreview(p,f.ports,{cpuDiagnostics:true});for(const t of [100,200,300,400]){f.setTime(t);v.run();}return{f,p,rows:f.logs.map(JSON.parse)};}
test('detail separates attribution from parent phases',()=>{const x=reports(),d=M.detail(x.rows[0],x.p);assert.equal(d.attribution.boundaries,12);assert.ok(d.parentPhases.observationBuild>=0);});
test('summary emits all nine subphase buckets',()=>{const x=reports(),s=M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.deepEqual(Object.keys(s.subphases),W.SUBPHASES);});
test('summary emits all primitive work keys',()=>{const x=reports(),s=M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.deepEqual(Object.keys(s.work),W.WORK_KEYS);});
test('observation ranking contains four regions',()=>{const x=reports(),s=M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.equal(s.observationRanking.length,4);});
test('commitment ranking contains four regions',()=>{const x=reports(),s=M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.equal(s.commitmentRanking.length,4);});
test('projection is reported separately from commitment builder regions',()=>{const x=reports(),s=M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.equal(s.projection.subphase,undefined);assert.equal(s.projection.count,4);});
test('complete report details retain four projection rows',()=>{const x=reports();for(const r of x.rows)assert.equal(M.detail(r,x.p).commitmentProjectionRows,4);});
test('partial report cannot become complete by index completeness alone',()=>{const x=reports({cost:{commitmentBuild:2.2}});for(const r of x.rows){const d=M.detail(r,x.p);assert.equal(d.completeSample,false);assert.notEqual(d.commitmentStatus,'read_complete');}});
test('work counters are descriptive and not CPU weights',()=>{const x=reports(),s=M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.equal(s.work.projectionIndexQueries.median,16);assert.ok(s.subphases.projectionRows.median>=0);});
test('empty run yields inconclusive attribution',()=>{const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),d=fs.mkdtempSync(path.join(os.tmpdir(),'subx-'));assert.equal(M.makeComparison(d).status,'SUBPHASE_X_ATTRIBUTION_INCONCLUSIVE');});
test('summarization does not mutate reports',()=>{const x=reports(),before=JSON.stringify(x.rows);M.summarize(x.rows.map(r=>M.detail(r,x.p)));assert.equal(JSON.stringify(x.rows),before);});
