'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const packaged=fs.existsSync(path.join(__dirname,'../implementation/treasury-compat-read-path-r1.cjs'));
const Q=require(packaged?'../implementation/treasury-compat-read-path-r1.cjs':'../../scripts/lib/treasury-compat-read-path-r1.cjs');
const before=fs.readFileSync(path.join(__dirname,packaged?'../fixtures/core-XV.ts.txt':'fixtures/core-before-read-path-r1.ts.txt'),'utf8');
const after=fs.readFileSync(path.join(__dirname,packaged?'../fixtures/core-R1.expected.ts.txt':'../../src/runtime/treasuryCompatReadCore.generated.ts'),'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const blob=s=>crypto.createHash('sha1').update(Buffer.from('blob '+Buffer.byteLength(s)+'\0')).update(s).digest('hex');
const normalize=x=>JSON.parse(JSON.stringify(x));
function script(s){
  const imp='import type { CompatReadBuilders } from "./treasuryCompatTypes";';
  const exp='export function createCompatibilityReadCore(): CompatReadBuilders {';
  assert.equal(s.split(imp).length,2);assert.equal(s.split(exp).length,2);
  // Only the two exact type-only TS wrapper forms are removed. Runtime bodies
  // are the full pinned/generated JavaScript, not substitute mock algorithms.
  return new vm.Script(s.replace(imp,'').replace(exp,'function createCompatibilityReadCore() {')+'\nmodule.exports={createCompatibilityReadCore};',{filename:'read-core-runtime.js'});
}
const scripts=[script(before),script(after)];
const rooms=['E3N59','E4N58','W1N1','constructor','__proto__','x\0y'];
const resources=['energy','H','O','Z','X','H2O'];
const metrics=(original,record)=>class TrackedMap extends original{constructor(...args){super(...args);record.maps++;}};
function store(amounts,capacity=1000000,freeOverride){
  const o={...amounts};
  Object.defineProperties(o,{getUsedCapacity:{value(r){return r===undefined?Object.values(amounts).filter(x=>typeof x==='number'&&x>0).reduce((a,b)=>a+b,0):(amounts[r]||0);}},getFreeCapacity:{value(){return freeOverride??capacity-this.getUsedCapacity();}},getCapacity:{value(){return capacity;}}});return o;
}
function world(spec={}){
  const counters={maps:0,find:0,holder:0};
  const roomMap=Object.create(null);
  const names=spec.rooms||rooms.slice(0,3);
  for(let i=0;i<names.length;i++){
    const name=names[i],r={name,controller:{my:true}};
    if(!spec.missingStorage)r.storage={id:'storage-'+i,my:true,isActive:()=>true,store:store({energy:10000+i,H:200,O:3},spec.capacity??1000000,spec.free)};
    if(!spec.missingTerminal)r.terminal={id:'terminal-'+i,my:true,isActive:()=>true,cooldown:0,store:store({energy:3000,H:i},300000)};
    r.find=()=>{counters.find++;throw Error('room.find prohibited');};roomMap[name]=r;
  }
  const Memory={cfg:{resourceControl:{capacityBalancing:{automaticTaskNoProgressTtl:5000,sourceDepletedGraceTicks:100,receiverCapacityDemandCoverageGraceTicks:500}}},runtime:{treasuryWorldSequence:17}};
  const Game={time:spec.tick??10000,rooms:roomMap,getObjectById(id){counters.holder++;return id==='a'.repeat(24)?{room:{name:names[0]}}:null;}};
  return {Memory,Game,RESOURCES_ALL:spec.catalog||resources.slice(),counters};
}
function load(which,spec){const host=world(spec),sandbox={...host,module:{exports:{}},Map:metrics(Map,host.counters),console:{log(){throw Error('unexpected log');}}};vm.createContext(sandbox);scripts[which].runInContext(sandbox,{timeout:2000});return {host,sandbox,create:sandbox.module.exports.createCompatibilityReadCore};}
function task(overrides={}){return {id:'t',status:'pending',resource:'energy',fromRoomName:'E3N59',toRoomName:'E4N58',amount:100,remainingAmount:70,origin:'manual',reason:'manual-transfer',createdAt:1,updatedAt:100,lastProgressAt:9999,...overrides};}
function reservation(overrides={}){return {roomName:'E3N59',resource:'H',holderId:'a'.repeat(24),amount:60,expiresAt:10000,...overrides};}
function ownTable(entries){const out=Object.create(null);entries.forEach((v,i)=>{out[String(i)]=v;});return out;}
function observe(env,names=Object.keys(env.host.Game.rooms),options={}){return env.create().buildObservation({scope:'market-fresh',epochSeq:1,rooms:names.map(n=>env.host.Game.rooms[n]),...options});}
function queried(index,ns=rooms,rs=resources){
  const out={builtAtTick:index.builtAtTick,revision:index.revision,completeness:index.completeness,rows:[],receivers:[],routes:[],reservations:index.reservationSnapshot()};
  for(const n of ns){for(const r of rs){out.rows.push([n,r,index.outgoing(n,r),index.pendingOutgoing(n,r),index.pendingOutgoing(n,r,'manual'),index.incoming(n,r),index.pendingIncoming(n,r),index.reservedProduction(n,r),index.commitmentCompleteness(n,r)]);}
    out.receivers.push([index.incomingTaskCount(n),index.outgoingTaskCount(n),index.receiverCommitments(n)]);
  }
  for(const origin of ['manual','automatic'])out.routes.push(index.findMergeableTaskId('energy','E3N59','E4N58',origin,'manual-transfer'));
  out.metrics=index.metrics;return normalize(out);
}
function pair(factory,opts={}){
  const outputs=[];
  for(let which=0;which<2;which++){
    const env=load(which,opts),obs=observe(env),input=factory(),trace=[];
    const pre=JSON.stringify(env.host.Memory);let cp=0;
    const diagnostics=opts.diagnostics===false?undefined:{boundary(x){trace.push(['boundary',x??null]);},work(x){trace.push(['work',normalize(x)]);},taskBoundary(name,ordinal){trace.push(['pending',name,ordinal]);}};
    const index=env.create().buildCommitments({tick:env.host.Game.time,tasks:input.tasks||{},reservations:input.reservations||{},observation:obs,compatDiagnostics:diagnostics,capacityDelta:()=>cp,strictCapacityDelta:()=>cp/2,...input.extra});
    const first=queried(index);cp=8;const second=index.receiverCommitments('E4N58');
    assert.equal(JSON.stringify(env.host.Memory),pre,'reader mutated Memory');assert.equal(env.host.counters.find,0);
    outputs.push(normalize({first,second,trace}));
  }
  assert.deepEqual(outputs[1],outputs[0]);return outputs[1];
}

test('authentic XV Git object and complete source fixture',()=>{assert.equal(Buffer.byteLength(before),70443);assert.equal(blob(before),'614e97c72a54cef8385ae6fd0a1a9c756dcb564d');});
test('fixed candidate bytes and complete forward transform',()=>{assert.equal(Q.coreTransform(before),after);assert.equal(hash(after),'4d95104a44554f40065f65501c506f176653f3cb44c4fba0bcd0409cd5830f08');});
test('exact reverse transform preserves all predecessor bytes',()=>assert.equal(Q.coreRestore(after),before));
test('double application is rejected',()=>assert.throws(()=>Q.coreTransform(after),/READ_PATH_R1_ANCHOR/));
test('tampered predecessor is rejected rather than patched approximately',()=>assert.throws(()=>Q.coreTransform(before.replace('metrics.pendingTaskRecords += 1;','metrics.pendingTaskRecords += 2;')),/READ_PATH_R1_ANCHOR/));
test('tampered candidate cannot satisfy inverse provenance',()=>assert.throws(()=>Q.coreRestore(after.replace('taskScopeCount += 1;','taskScopeCount += 2;')),/READ_PATH_R1_ANCHOR/));
test('both complete runtime bodies parse and export only two builders',()=>{for(let i=0;i<2;i++){const e=load(i);assert.deepEqual(Object.keys(e.create()).sort(),['buildCommitments','buildObservation']);}});
test('zero task and zero reservation retain complete zero indexes',()=>pair(()=>({})));
test('single manual transfer and active owner reservation',()=>pair(()=>({tasks:{t:task()},reservations:{r:reservation()}})));
test('all canonical task statuses still undergo full validation',()=>pair(()=>({tasks:ownTable(['pending','done','cancelled','failed'].map((status,i)=>task({id:'s'+i,status})))})));
test('unknown status fails closed rather than looking non-pending',()=>{const r=pair(()=>({tasks:{bad:task({status:'pendng'})}}));assert.equal(r.first.completeness.complete,false);});
test('manual and automatic health and receiver predicates retain meaning',()=>pair(()=>({tasks:ownTable(['manual','automatic'].flatMap(origin=>[undefined,'source_depleted','receiver_capacity','insufficient_terminal_resource_or_fee'].flatMap(blockedReason=>[99,100,499,500,5001].map(age=>task({origin,blockedReason,blockedSince:10000-age,lastProgressAt:10000-age})))))})));
test('first-route-wins retains an undefined id and does not overwrite it',()=>{const r=pair(()=>({tasks:{first:task({id:undefined}),second:task({id:'later'})}}));assert.equal(r.first.routes[0],null);});
test('self-route aliases share the correct eager scope and room buckets',()=>pair(()=>({tasks:ownTable([task({toRoomName:'E3N59'}),task({fromRoomName:'E4N58',toRoomName:'E4N58'}),task()])})));
test('null-prototype scope and room dictionaries preserve hostile names',()=>pair(()=>({tasks:ownTable(rooms.flatMap((fromRoomName,i)=>resources.map(resource=>task({fromRoomName,toRoomName:rooms[(i+1)%rooms.length],resource}))))}),{rooms}));
test('safe-integer aggregation overflow retains partial update order',()=>pair(()=>({tasks:ownTable([task({amount:Number.MAX_SAFE_INTEGER,remainingAmount:Number.MAX_SAFE_INTEGER}),task(),task({fromRoomName:'W1N1',toRoomName:'W1N1',amount:Number.MAX_SAFE_INTEGER,remainingAmount:Number.MAX_SAFE_INTEGER}),task({fromRoomName:'W1N1',toRoomName:'W1N1'})])})));
test('damaged task fields and global/scope incompleteness agree',()=>pair(()=>({tasks:ownTable([null,[],42,task({resource:'not-a-resource'}),task({fromRoomName:''}),task({toRoomName:''}),task({amount:-1}),task({remainingAmount:NaN}),task({amount:0,remainingAmount:1}),task({origin:'unknown'}),task({updatedAt:Infinity}),task({blockedReason:'unknown'}),task({blockedSince:-1})])})));
test('all non-pending malformed records still cause incompleteness',()=>pair(()=>({tasks:ownTable(['done','cancelled','failed'].map(status=>task({status,amount:-1})))})));
test('zero-amount pending records remain visible in counts and routes',()=>pair(()=>({tasks:ownTable([task({amount:0,remainingAmount:0}),task({id:'other',resource:'H',amount:0,remainingAmount:0})])})));
test('reservation expiry is strictly earlier than the current tick',()=>pair(()=>({reservations:ownTable([9999,10000,10001].map(expiresAt=>reservation({expiresAt})))})));
test('unresolved and missing owners remain fully committed',()=>{const r=pair(()=>({reservations:ownTable(['missing','task:1','contract:2','b'.repeat(24),'synthesis:missing'].map(holderId=>reservation({holderId})))}));assert.equal(r.first.metrics.activeReservationRecords,5);});
test('typed identity namespace and kind self-exclusion are preserved',()=>{for(let i=0;i<2;i++){const e=load(i),obs=observe(e),idx=e.create().buildCommitments({tick:10000,tasks:{},observation:obs,reservations:ownTable(['game-object','logical-service','task','contract','legacy-unresolved'].map(kind=>reservation({owner:{kind,id:'same',...(kind==='logical-service'?{namespace:'n'}:{})}})))});assert.equal(idx.reservedProduction('E3N59','H'),300);assert.equal(idx.reservedProduction('E3N59','H',{kind:'task',id:'same'}),240);assert.equal(idx.reservedProduction('E3N59','H',{kind:'logical-service',id:'same',namespace:'different'}),300);}});
test('reservation integer overflow and invalid identity fail closed',()=>pair(()=>({reservations:ownTable([reservation({amount:Number.MAX_SAFE_INTEGER}),reservation(),reservation({owner:{kind:'logical-service',id:'x'}}),reservation({owner:{kind:'task',id:'x',namespace:'bad'}}),reservation({resource:'bad'}),null])})));
test('nonempty maximum-size task and reservation paths are both tested offline',()=>pair(()=>({tasks:ownTable(Array.from({length:256},(_,i)=>task({id:String(i),resource:resources[i%resources.length],fromRoomName:rooms[i%rooms.length],toRoomName:rooms[(i+1)%rooms.length]}))),reservations:ownTable(Array.from({length:256},(_,i)=>reservation({resource:resources[i%resources.length],roomName:rooms[i%rooms.length],holderId:'task:'+i,amount:i})))})));
test('callbacks retain options receiver, order, and expiration behavior',()=>{const outputs=[];for(let which=0;which<2;which++){const e=load(which),calls=[],options={tick:10000,tasks:{},reservations:ownTable([reservation({expiresAt:9999}),reservation({holderId:'missing'})]),observation:observe(e),onExpiredExcluded(){assert.equal(this,options);calls.push('expired');},onMissingOwnerCommitted(){assert.equal(this,options);calls.push('missing');}};const idx=e.create().buildCommitments(options);outputs.push({calls,snapshot:queried(idx)});}assert.deepEqual(outputs[1],outputs[0]);});
test('detached and rebound public query methods keep their originating state',()=>{for(let which=0;which<2;which++){const e=load(which),b=e.create(),obs=observe(e);const a=b.buildCommitments({tick:10000,observation:obs,tasks:{t:task()},reservations:{}}),z=b.buildCommitments({tick:10000,observation:obs,tasks:{},reservations:{}}),out=a.outgoing,inc=a.incoming;assert.equal(out('E3N59','energy'),70);assert.equal(out.call(z,'E3N59','energy'),70);assert.equal(inc.call(null,'E4N58','energy'),70);assert.equal(z.metrics.indexQueries,0);assert.equal(a.metrics.indexQueries,3);}});
test('delta callbacks retain unbound strict this and remain dynamic',()=>{for(let which=0;which<2;which++){const e=load(which);let d=3;const callback=function(){assert.equal(this,undefined);return d;};const idx=e.create().buildCommitments({tick:10000,observation:observe(e),tasks:{},reservations:{},capacityDelta:callback,strictCapacityDelta:callback});const a=idx.receiverCommitments('E3N59');d=19;const b=idx.receiverCommitments('E3N59');assert.equal(a.projectedStorageHeadroom-b.projectedStorageHeadroom,16);}});
test('snapshot indexes do not reread task data after construction',()=>{for(let which=0;which<2;which++){const e=load(which),t=task(),tasks={t},idx=e.create().buildCommitments({tick:10000,observation:observe(e),tasks,reservations:{}});t.remainingAmount=1;delete tasks.t;assert.equal(idx.outgoing('E3N59','energy'),70);assert.equal(idx.incoming('E4N58','energy'),70);}});
test('alternating reader instances capture a fresh resource catalog',()=>{for(let which=0;which<2;which++){const e=load(which),old=e.create();e.sandbox.RESOURCES_ALL=['H'];const newer=e.create(),obs=observe(e);const args={tick:10000,observation:obs,tasks:{t:task()},reservations:{}};assert.equal(newer.buildCommitments(args).completeness.complete,false);assert.equal(old.buildCommitments(args).completeness.complete,true);}});
test('nested builders cannot replace the outer input context',()=>{for(let which=0;which<2;which++){const e=load(which),outer=e.create(),obs=observe(e);let nested=false;const index=outer.buildCommitments({tick:10000,observation:obs,tasks:{t:task()},reservations:{},compatDiagnostics:{boundary(name){if(name==='commitmentTasks'&&!nested){nested=true;e.sandbox.RESOURCES_ALL=['H'];assert.equal(e.create().buildCommitments({tick:10000,observation:obs,tasks:{t:task()},reservations:{}}).completeness.complete,false);}},work(){}}});assert.equal(index.outgoing('E3N59','energy'),70);assert.equal(index.completeness.complete,true);}});
test('observation APIs, missing locations, sparse resources, freezing and query order',()=>{const out=[];for(let which=0;which<2;which++){const e=load(which),obs=observe(e);const rows=[];for(const n of rooms){rows.push([n,obs.hasRoom(n),obs.locationExists(n,'storage'),obs.location(n,'terminal'),obs.amount(n,'storage','energy'),obs.roomAmount(n,'H'),obs.roomResources(n),obs.usedCapacity(n,'storage'),obs.freeCapacity(n,'terminal')]);}assert.ok(Object.isFrozen(obs.data)&&Object.isFrozen(obs.data.rooms)&&Object.isFrozen(obs.data.epoch));assert.ok(Object.isFrozen(obs.location('E3N59','storage').amounts));out.push(normalize([obs.roomNames(),obs.empireTotal('H'),obs.empireResources(),rows]));}assert.deepEqual(out[1],out[0]);});
test('observation memo arrays stay private to each snapshot',()=>{for(let which=0;which<2;which++){const e=load(which),a=observe(e),b=observe(e);const ar=a.roomResources('E3N59'),br=b.roomResources('E3N59');assert.equal(ar,a.roomResources('E3N59'));assert.notEqual(ar,br);assert.equal(a.empireResources(),a.empireResources());assert.notEqual(a.empireResources(),b.empireResources());assert.ok(Object.isFrozen(ar));}});
test('detached observation methods ignore unrelated public receivers',()=>{for(let which=0;which<2;which++){const e=load(which),obs=observe(e),location=obs.location,amount=obs.amount,has=obs.hasRoom;assert.equal(location.call({},'E3N59','storage'),obs.location('E3N59','storage'));assert.equal(amount('E3N59','storage','energy'),10000);assert.equal(has.call(null,'E3N59'),true);}});
test('observation remains stale by Game.time and never rereads Store on query',()=>{for(let which=0;which<2;which++){const e=load(which),obs=observe(e);e.host.Game.rooms.E3N59.storage.store.energy=0;e.host.Game.rooms.E3N59.storage.store=null;e.host.Game.time++;assert.equal(obs.amount('E3N59','storage','energy'),10000);assert.equal(obs.isStale(),true);}});
test('duplicate room ordering and last-room-wins lookup remain unchanged',()=>{const out=[];for(let which=0;which<2;which++){const e=load(which),r=e.host.Game.rooms.E3N59,copy={...r,storage:{...r.storage,store:store({energy:17})}};const obs=e.create().buildObservation({scope:'market-fresh',epochSeq:3,rooms:[r,copy]});out.push(normalize([obs.roomNames(),obs.roomAmount(r.name,'energy'),obs.empireTotal('energy')]));}assert.deepEqual(out[1],out[0]);});
test('over-capacity signed free and absent Store remain physical observations',()=>{for(const opts of [{capacity:100,free:-10103},{missingStorage:true},{missingTerminal:true},{missingStorage:true,missingTerminal:true}]){const out=[];for(let which=0;which<2;which++){const e=load(which,opts);out.push(normalize(observe(e).data));}assert.deepEqual(out[1],out[0]);}});
test('Store scanning callback order remains before empire folding',()=>{const out=[];for(let which=0;which<2;which++){const e=load(which),calls=[];const options={scope:'market-fresh',epochSeq:1,rooms:Object.values(e.host.Game.rooms),onStoreScanned(n){assert.equal(this,options);calls.push(n);}};const obs=e.create().buildObservation(options);out.push(normalize([calls,obs.data]));}assert.deepEqual(out[1],out[0]);});
test('complete projection executes all four rows and sixteen index queries',()=>{for(let which=0;which<2;which++){const e=load(which),idx=e.create().buildCommitments({tick:10000,observation:observe(e),tasks:{t:task()},reservations:{r:reservation()}}),rows=[];for(const n of ['E3N59','E4N58'])for(const r of ['energy','H'])rows.push([n,r,idx.outgoing(n,r),idx.incoming(n,r),idx.reservedProduction(n,r),idx.commitmentCompleteness(n,r)]);assert.equal(rows.length,4);assert.equal(idx.metrics.indexQueries,16);}});
test('diagnostics disabled retains full business semantics',()=>pair(()=>({tasks:{t:task()},reservations:{r:reservation()}}),{diagnostics:false}));
test('query views no longer contain build-local method definitions',()=>{const start=after.indexOf('function buildTreasuryCommitmentIndex('),end=after.indexOf('\n},\n"src/runtime/treasury/holderResolution.ts"',start),body=after.slice(start,end);assert.ok(!body.includes('        outgoing(roomName, resource) {'));assert.ok(!body.includes('const recordInvalid ='));assert.ok(body.includes('Object.keys(options.tasks)')&&body.includes('Object.keys(options.reservations)'));assert.ok(after.includes('compatCommitmentQueriesR1.outgoing.bind(state)'));});
test('instrumented allocation count removes exactly two Map constructions per empty eager index',()=>{const counts=[];for(let which=0;which<2;which++){const e=load(which),b=e.create(),obs=observe(e),old=e.host.counters.maps;b.buildCommitments({tick:10000,observation:obs,tasks:{},reservations:{}});counts.push(e.host.counters.maps-old);}assert.equal(counts[0]-counts[1],2);});
test('512 seeded mixed-input differential scenarios across full index APIs',()=>{let seed=0x93a70c;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};for(let round=0;round<512;round++){const tasks=[],reservations=[];for(let j=0,n=Math.floor(rand()*30);j<n;j++){const r=()=>Math.floor(rand()*6);tasks.push(task({id:'r'+round+'-'+j,status:['pending','pending','pending','done','failed','bad'][r()],origin:rand()<.5?'manual':'automatic',resource:resources[r()],fromRoomName:rooms[r()],toRoomName:rooms[r()],amount:1000,remainingAmount:Math.floor(rand()*1001),blockedReason:[undefined,'source_depleted','receiver_capacity'][Math.floor(rand()*3)],blockedSince:10000-Math.floor(rand()*1000),lastProgressAt:10000-Math.floor(rand()*6000)}));}for(let j=0,n=Math.floor(rand()*12);j<n;j++)reservations.push(reservation({roomName:rooms[Math.floor(rand()*6)],resource:resources[Math.floor(rand()*6)],amount:Math.floor(rand()*1000),holderId:rand()<.5?'task:'+j:'a'.repeat(24),expiresAt:9998+Math.floor(rand()*5)}));pair(()=>({tasks:structuredClone(ownTable(tasks)),reservations:structuredClone(ownTable(reservations))}),{diagnostics:round%2===0});}});

test('room-count queries preserve native Map key types without implicit string coercion',()=>{for(let which=0;which<2;which++){const e=load(which),b=e.create(),idx=b.buildCommitments({tick:10000,observation:observe(e),tasks:{t:task({fromRoomName:'1',toRoomName:'1'})},reservations:{}});assert.equal(idx.incomingTaskCount('1'),1);for(const q of [1,new String('1'),{toString(){return '1';}},null,undefined,Symbol('1')]){assert.equal(idx.incomingTaskCount(q),0);assert.equal(idx.outgoingTaskCount(q),0);}assert.equal(idx.receiverCommitments(1).healthyIncomingTaskCount,0);}});
