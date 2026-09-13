'use strict';
const {fail,obj,own,sha256,clone,EXPECTED} = require('./common.cjs');
const ALGORITHM='deployGuard.computeModulesHash/NUL-v1';
function validateModules(m) {
  if(!obj(m)) fail('MODULES_NOT_OBJECT');
  const names=Object.keys(m);
  if(!names.length || names.length>256 || !own(m,'main') || typeof m.main!=='string' || !m.main.trim()) fail('MODULES_EMPTY_OR_MAIN_MISSING');
  let total=0;
  for(const n of names) {
    if(!n.length || n.length>128 || /[\0\r\n]/.test(n)) fail('MODULE_NAME_INVALID');
    const v=m[n];
    if(typeof v==='string') total+=Buffer.byteLength(v);
    else if(obj(v) && Object.keys(v).length===1 && own(v,'binary') && typeof v.binary==='string'
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.binary)
      && Buffer.from(v.binary,'base64').toString('base64')===v.binary) total+=Buffer.from(v.binary,'base64').length;
    else fail('MODULE_VALUE_INVALID');
  }
  if(total>16*1024*1024) fail('MODULE_SET_TOO_LARGE');
  return m;
}
function modulesFromResponse(r) {
  if(!obj(r)||r.ok!==1) fail('API_RESULT_NOT_SUCCESS');
  if(!own(r,'modules')) fail('MODULES_FIELD_MISSING');
  return validateModules(r.modules);
}
function activeBranch(r, expected=EXPECTED.branch) {
  if(!obj(r)||r.ok!==1||!Array.isArray(r.list)) fail('BRANCH_RESPONSE_INVALID');
  const names=new Set();
  for(const b of r.list) {
    if(!obj(b)||typeof b.branch!=='string'||!b.branch.length||names.has(b.branch)) fail('BRANCH_RESPONSE_INVALID');
    if(own(b,'activeWorld')&&typeof b.activeWorld!=='boolean') fail('BRANCH_RESPONSE_INVALID');
    names.add(b.branch);
  }
  const active=r.list.filter(b=>b.activeWorld===true);
  if(active.length!==1) fail('ACTIVE_WORLD_NOT_UNIQUE');
  if(active[0].branch!==expected) fail('ACTIVE_WORLD_CHANGED');
  return active[0].branch;
}
function account(r, expected=EXPECTED) {
  if(!obj(r)||r.ok!==1||r._id!==expected.userId||r.username!==expected.username) fail('ACCOUNT_MISMATCH_OR_UNREADABLE');
  return {_id:r._id, username:r.username};
}
function ownedRooms(r,shard=EXPECTED.shard) {
  const rooms=r?.shards?.[shard]?.rooms;
  if(!obj(r)||r.ok!==1||!Array.isArray(rooms)||rooms.some(n=>typeof n!=='string'||!/^[WE]\d{1,3}[NS]\d{1,3}$/.test(n)))fail('ROOM_OVERVIEW_UNREADABLE');
  return [...new Set(rooms)];
}
function describeModules(m, guard) {
  validateModules(m);
  return {algorithm:ALGORITHM, hash:guard.computeModulesHash(m), files:Object.keys(m).sort().map(name=>{
    const v=m[name], binary=typeof v!=='string', bytes=binary?Buffer.from(v.binary,'base64'):Buffer.from(v,'utf8');
    return {name,kind:binary?'binary':'text',bytes:bytes.length,sha256:sha256(bytes)};
  })};
}
function equalModules(a,b,guard) {
  validateModules(a);validateModules(b);
  // Canonical hash alone is insufficient if a text module starts with "bin:".
  // Require the canonical implementation's exact typed-content diff as well.
  const d=guard.diffRemoteModules(a,b);
  return d.match && d.missing.length===0 && d.extra.length===0 && d.changed.length===0;
}
function makeSnapshot(modules, guard, identity=EXPECTED, at=Date.now()) {
  return {kind:'compat-online-modules-v1', ...identity, capturedAtMs:at,
    modules:clone(validateModules(modules)), digest:describeModules(modules,guard)};
}
function validateSnapshot(s,guard,expected=EXPECTED) {
  if(!obj(s)||s.kind!=='compat-online-modules-v1'||!Number.isSafeInteger(s.capturedAtMs)||s.capturedAtMs<0) fail('SNAPSHOT_INVALID');
  for(const k of ['server','username','userId','branch','shard']) if(s[k]!==expected[k]) fail('SNAPSHOT_IDENTITY_MISMATCH');
  const d=describeModules(s.modules,guard);
  if(JSON.stringify(d)!==JSON.stringify(s.digest)) fail('SNAPSHOT_DIGEST_MISMATCH');
  return s;
}
function buildIdentity(text) {
  const get = name => {
    const matches=[...text.matchAll(new RegExp('const '+name+' = "([^"\\r\\n]*)"\\s*;', 'g'))];
    if(matches.length!==1) fail('BUILD_IDENTITY_NOT_UNIQUE');
    return matches[0][1];
  };
  // Rollup may fold BUILD_DIRTY into the BUILD_INFO literal. Never infer false
  // from absence: require the constant, the rollup-replace guard ternary, or
  // the exact metadata property. A ternary is trusted only when all three
  // literals agree; any disagreement stays "not_read" and fails closed.
  const dirtyConstants=[...text.matchAll(/const BUILD_DIRTY = "(true|false)"\s*;/g)];
  let dirty='not_read';
  if(dirtyConstants.length===1)dirty=dirtyConstants[0][1];
  else if(dirtyConstants.length===0){
    const ternary=[...text.matchAll(/const BUILD_DIRTY = typeof "(true|false)" !== "undefined" \? "(true|false)" : "(true|false)"/g)];
    if(ternary.length===1&&ternary[0][1]===ternary[0][2]&&ternary[0][2]===ternary[0][3])dirty=ternary[0][1];
    else{
      const blocks=[...text.matchAll(/const BUILD_INFO = \{([\s\S]*?)\n\};/g)];
      if(blocks.length===1){
        const d=blocks[0][1].match(/\bdirty:\s*(true|false)\s*,/);
        if(d)dirty=d[1];
        // Rollup drops unreferenced object properties: when the only BUILD_INFO
        // consumer reads tag/commit/tree/deployBranch/bundleHash, the "dirty"
        // declaration is folded out of the artifact entirely. Recognize exactly
        // that shape (and no stray BUILD_DIRTY token); anything else stays
        // "not_read" and fails closed in confirmBuild. The equivalent clean-tree
        // guarantee stays with assertCandidate's clean/detached checks around
        // the build, since the frozen builder cannot be changed here.
        else if(!text.includes('BUILD_DIRTY')&&/\bcommit: BUILD_COMMIT,/.test(blocks[0][1])
          &&/\btree: BUILD_TREE,/.test(blocks[0][1])&&/\bdeployBranch: BUILD_DEPLOY_BRANCH,/.test(blocks[0][1]))dirty='folded_out';
      }
    }
  }
  return {commit:get('BUILD_COMMIT'),tree:get('BUILD_TREE'),dirty,deployBranch:get('BUILD_DEPLOY_BRANCH'),tag:get('BUILD_TAG')};
}
function confirmBuild(m,head,tree,branch=EXPECTED.branch) {
  const x=buildIdentity(validateModules(m).main);
  if(x.commit!==head||x.tree!==tree||x.deployBranch!==branch||(x.dirty!=='false'&&x.dirty!=='folded_out')) fail('BUILD_SOURCE_OR_TARGET_MISMATCH');
  const match=m.main.match(/\n;globalThis\.__DEPLOY_BUNDLE_HASH__="([a-f0-9]{64})";\n$/);
  if(!match||sha256(m.main.slice(0,match.index))!==match[1]) fail('EMBEDDED_BUNDLE_HASH_MISMATCH');
  return {...x, embeddedBundleHash:match[1]};
}
module.exports={ALGORITHM,ownedRooms,validateModules,modulesFromResponse,activeBranch,account,describeModules,equalModules,makeSnapshot,validateSnapshot,buildIdentity,confirmBuild};
