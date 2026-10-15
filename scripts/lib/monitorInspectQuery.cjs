// 固定只读 inspect 查询。选择器只能作为 JSON 数据进入模板，不能扩展查询语法。
const PREFIX = "CODEX_MONITOR_INSPECT:";
const SCHEMA = "codex-monitor-inspect/v1";
const DANGEROUS_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function validateInspectSelectors(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(opts))) {
    throw new Error("Inspect selectors must be a plain object");
  }
  const allowed = new Set(["rooms", "creeps", "creepPrefixes", "limit", "maxBytes", "requestId", "shard", "expectedTag", "mode"]);
  for (const key of Object.keys(opts)) if (!allowed.has(key)) throw new Error(`Unknown inspect selector: ${key}`);
  const list = (key, maximum, pattern) => {
    const values = opts[key] === undefined ? [] : opts[key];
    if (!Array.isArray(values) || values.length > maximum
      || values.some(value => typeof value !== "string" || !pattern.test(value) || DANGEROUS_NAMES.has(value))) {
      throw new Error(`Invalid inspect ${key}`);
    }
    return [...new Set(values)];
  };
  const rooms = list("rooms", 3, /^[EW]\d{1,6}[NS]\d{1,6}$/);
  const creeps = list("creeps", 4, /^[A-Za-z0-9:_-]{1,100}$/);
  const creepPrefixes = list("creepPrefixes", 4, /^[A-Za-z0-9:_-]{6,100}$/);
  const limit = opts.limit === undefined ? 8 : opts.limit;
  const maxBytes = opts.maxBytes === undefined ? 24000 : opts.maxBytes;
  const mode = opts.mode === undefined ? "movement" : opts.mode;
  if (!["movement", "pair", "threats"].includes(mode)) throw new Error("Invalid inspect mode");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error("Inspect limit must be 1..8");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > 24000) throw new Error("Inspect maxBytes must be 2048..24000");
  if (typeof opts.requestId !== "string" || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(opts.requestId)) {
    throw new Error("Inspect requestId must be a UUID");
  }
  if (typeof opts.shard !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(opts.shard) || DANGEROUS_NAMES.has(opts.shard)) {
    throw new Error("Invalid inspect shard");
  }
  if (opts.expectedTag !== undefined && (typeof opts.expectedTag !== "string" || opts.expectedTag.length < 1
    || opts.expectedTag.length > 160 || /[^\x20-\x7e]/.test(opts.expectedTag))) throw new Error("Invalid inspect expectedTag");
  return { rooms, creeps, creepPrefixes, limit, maxBytes, mode, requestId: opts.requestId, shard: opts.shard,
    ...(opts.expectedTag === undefined ? {} : { expectedTag: opts.expectedTag }) };
}

/**
 * wire v2：[2,id,actualShard,tick,actualTag,mode,[visited,creeps],rooms]。
 * unit：[name,[room,x,y],hits,hitsMax,fatigue,原生store]；creep：[unit,roleArgs前3项,working,detail]。
 * movement detail：[travel,path]；state：[targetRoom,stuckTicks,rawCursor,targetX,targetY,rawCursorSliceCandidates]。
 * pair detail：[phase,targetRoom,attackerEntry,healerEntry,retreatRoom,blocker]。
 * threats detail：0；room：[name,visible,controllerOwner,reservation,describeExits,hostiles?,structures?]。
 * hostile：[unit,ownerUsername]；structure：[type,pos,energy]。tag/shard由客户端核验实际值。
 */
function buildInspectExpression(opts) {
  const v = validateInspectSelectors(opts);
  const literalList = values => `[${values.map(value => `'${value}'`).join(",")}]`;
  const matches = [];
  if (v.rooms.length) matches.push("R.includes(c.pos.roomName)");
  if (v.creeps.length) matches.push(`${literalList(v.creeps)}.includes(k)`);
  if (v.creepPrefixes.length) matches.push(`${literalList(v.creepPrefixes)}.some(p=>k.startsWith(p))`);
  const match = matches.join("||") || "false";
  const maximumCharacters = Math.floor((v.maxBytes - PREFIX.length) / 3);
  const movement = "f=x=>x&&[x.targetRoom,x.stuckTicks,(x=x.multiRoomSegment||x).cursor,x.targetX,x.targetY,(x.steps||x.positions)?.slice(x.cursor+1,x.cursor+4).map(p)],";
  const pair = "d=x=>x&&[x.phase,x.targetRoom,p(x.attackerEntry),p(x.healerEntry),x.retreatRoom,x.blocker],";
  const helpers = v.mode === "movement" ? movement : v.mode === "pair" ? pair : "";
  const heap = v.mode === "movement" ? ",h=global.__creepMovementState?.[k]" : "";
  const detail = v.mode === "movement" ? "[f(h?.travelState),f(h?.movePathState)]" : v.mode === "pair" ? "d(m?._warTowerDrain)" : "0";
  // @screeps/common: 103=FIND_HOSTILE_CREEPS,109=FIND_HOSTILE_STRUCTURES；测试独立对照公共全局常量。
  const threats = v.mode === "threats" ? ",g?.find(103).slice(0,8).map(x=>[u(x),x.owner.username]),g?.find(109).slice(0,128).filter(x=>/tower|spawn|invaderCore/.test(x.structureType)).slice(0,8).map(x=>[x.structureType,p(x.pos),x.store?.energy])" : "";
  // UTF8 每个 JSON UTF16 code unit 至多3字节（代理对合计4字节）；超限不发送部分结果。
  const expression = `(()=>{let G=Game,R=${literalList(v.rooms)},p=x=>x&&[x.roomName,x.x,x.y],u=x=>[x.name,p(x.pos),x.hits,x.hitsMax,x.fatigue,x.store],${helpers}C=[],i=0,g;for(let k in G.creeps){if(++i>1e3||C.length==${v.limit})break;if(!{}.hasOwnProperty.call(G.creeps,k))continue;let c=G.creeps[k];if(!(${match}))continue;let m=Memory.creeps?.[k]${heap};C.push([u(c),m?.roleArgs?.slice(0,3),m?.working,${detail}])}let a=[2,'${v.requestId}',G.shard.name,G.time,Memory.runtime?.lastDeployTag,'${v.mode}',[i,C],R.map(n=>[n,!!(g=G.rooms[n]),g?.controller?.owner?.username,g?.controller?.reservation,G.map.describeExits(n)${threats}])],s=JSON.stringify(a);if(s.length>${maximumCharacters}){a[4]=null;a[6]=a[7]=0;s=JSON.stringify(a)}console.log('${PREFIX}'+s)})()`;
  if (JSON.stringify(expression).length > 1024 || Buffer.byteLength(expression, "utf8") > 1024) throw new Error("Inspect selectors exceed the official 1024-character console expression limit; shorten selectors");
  return expression;
}

function decodeInspectWire(wire) {
  const invalid = () => { throw new Error("Invalid monitor inspect wire"); };
  const list = (value, maximum) => { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; };
  const text = (value, nullable = false) => {
    if (value == null && nullable) return null;
    if (typeof value !== "string" || value.length > 160) invalid();
    return value;
  };
  const numeric = (value, nullable = false) => {
    if (value == null && nullable) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) invalid();
    return value;
  };
  const roomName = (value, nullable = false) => {
    const name = text(value, nullable);
    if (name != null && !/^[EW]\d+[NS]\d+$/.test(name)) invalid();
    return name;
  };
  const position = (value, fallbackRoom = null) => {
    if (!Array.isArray(value) || value.length !== 3) invalid();
    const name = roomName(value[0], true) || fallbackRoom;
    const x = numeric(value[1]), y = numeric(value[2]);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 49 || y < 0 || y > 49) invalid();
    return { roomName: name, x, y };
  };
  const cargo = value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100) invalid();
    const resources = {};
    let used = 0;
    for (const [key, amount] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(key) || DANGEROUS_NAMES.has(key) || !Number.isSafeInteger(amount) || amount < 0) invalid();
      resources[key] = amount; used += amount;
    }
    if (!Number.isSafeInteger(used)) invalid();
    return { store: resources, used };
  };
  const unit = value => {
    if (!Array.isArray(value) || value.length !== 6) invalid();
    const result = { name: text(value[0]), pos: position(value[1]), hits: numeric(value[2]), hitsMax: numeric(value[3]), fatigue: numeric(value[4]), cargo: cargo(value[5]) };
    if (!result.name || !result.pos.roomName || result.hits < 0 || result.hitsMax < result.hits || result.fatigue < 0) invalid();
    return result;
  };
  const state = (value, currentRoom) => {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length !== 6) invalid();
    const stuckTicks = numeric(value[1], true), cursor = numeric(value[2], true);
    if (cursor != null && !Number.isInteger(cursor) || stuckTicks != null && (stuckTicks < 0 || !Number.isInteger(stuckTicks))) invalid();
    return { targetRoom: roomName(value[0], true), cursor, stuckTicks, targetX: numeric(value[3], true), targetY: numeric(value[4], true),
      nextBasis: "raw-cursor-slice", nextCandidates: value[5] == null ? [] : list(value[5], 3).map(next => position(next, currentRoom)) };
  };
  if (!Array.isArray(wire) || wire.length !== 8 || wire[0] !== 2 || !["movement", "pair", "threats"].includes(wire[5])) invalid();
  const mode = wire[5];
  const envelope = { schema: SCHEMA, requestId: text(wire[1]), shard: text(wire[2]), tick: numeric(wire[3]), deployTag: text(wire[4], true), result: null };
  if (!Number.isInteger(envelope.tick) || envelope.tick < 0) invalid();
  if (wire[6] === 0 && wire[7] === 0) {
    envelope.error = { code: "output-truncated", message: "Snapshot exceeded maxBytes; no partial result emitted" };
    return envelope;
  }
  if (!Array.isArray(wire[6]) || wire[6].length !== 2 || !Number.isInteger(wire[6][0]) || wire[6][0] < 0 || wire[6][0] > 1001) invalid();
  const visited = wire[6][0];
  const creeps = list(wire[6][1], 8).map(value => {
    if (!Array.isArray(value) || value.length !== 4) invalid();
    const base = unit(value[0]);
    if (value[2] != null && typeof value[2] !== "boolean") invalid();
    const result = { ...base, memory: { roleArgs: value[1] == null ? null : list(value[1], 3).map(arg => {
      if (arg == null || typeof arg === "boolean") return arg;
      if (typeof arg === "number") return numeric(arg);
      return text(arg);
    }), working: value[2] == null ? null : value[2] } };
    const detail = value[3];
    if (mode === "movement") {
      if (!Array.isArray(detail) || detail.length !== 2) invalid();
      result.movement = { travelState: state(detail[0], base.pos.roomName), movePathState: state(detail[1], base.pos.roomName) };
    } else if (mode === "pair") {
      if (detail == null) result.pair = null;
      else {
        if (!Array.isArray(detail) || detail.length !== 6) invalid();
        const target = roomName(detail[1], true);
        result.pair = { phase: text(detail[0], true), targetRoom: target,
          attackerEntry: detail[2] == null ? null : position(detail[2], target), healerEntry: detail[3] == null ? null : position(detail[3], target),
          retreatRoom: roomName(detail[4], true), blocker: text(detail[5], true) };
      }
    } else if (detail !== 0) invalid();
    return result;
  });
  const rooms = list(wire[7], 3).map(value => {
    if (!Array.isArray(value) || value.length !== (mode === "threats" ? 7 : 5) || typeof value[1] !== "boolean") invalid();
    const name = roomName(value[0]);
    const reservation = value[3];
    if (reservation != null && (typeof reservation !== "object" || Array.isArray(reservation))) invalid();
    const exits = {};
    if (value[4] != null) {
      if (typeof value[4] !== "object" || Array.isArray(value[4]) || Object.keys(value[4]).length > 4) invalid();
      for (const [direction, target] of Object.entries(value[4])) {
        if (!["1", "3", "5", "7"].includes(direction)) invalid();
        exits[direction] = roomName(target);
      }
    }
    const result = { name, visible: value[1], controller: { owner: text(value[2], true), reservation: reservation == null ? null
      : { username: text(reservation.username), ticksToEnd: numeric(reservation.ticksToEnd) } }, exits };
    if (mode === "threats") {
      result.hostiles = value[5] == null ? [] : list(value[5], 8).map(hostile => {
        if (!Array.isArray(hostile) || hostile.length !== 2) invalid();
        return { ...unit(hostile[0]), owner: text(hostile[1]) };
      });
      result.structures = value[6] == null ? [] : list(value[6], 8).map(structure => {
        if (!Array.isArray(structure) || structure.length !== 3 || !["tower", "spawn", "invaderCore"].includes(structure[0])) invalid();
        return { type: structure[0], pos: position(structure[1]), energy: numeric(structure[2], true) };
      });
      result.countsComplete = false; result.structureScanLimit = 128;
    }
    return result;
  });
  envelope.result = { mode, scan: { scannedNames: Math.min(visited, 1000), scanLimitReached: visited > 1000,
    matchedReturned: creeps.length, selectionCompleteness: "unknown-without-request-limit" }, creeps, rooms,
    limitations: ["房间内自有creep与名字/前缀按OR选择，达到limit时不保证explicit优先。", "路径候选仅是原始 cursor+1..+3 的切片，不执行寻路或恢复算法。", "角色参数仅截取现有 Memory.roleArgs 前3项，不代表配置层完整任务。", "敌情摘要是有界前缀，不能用返回数组长度推断完整敌情数量。"] };
  return envelope;
}

module.exports = { PREFIX, SCHEMA, validateInspectSelectors, buildInspectExpression, decodeInspectWire };
