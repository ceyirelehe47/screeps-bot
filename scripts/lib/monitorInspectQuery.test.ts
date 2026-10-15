import { runInNewContext } from "node:vm";

interface InspectOptions {
  rooms?: string[]; creeps?: string[]; creepPrefixes?: string[]; limit?: number; maxBytes?: number;
  requestId: string; shard: string; expectedTag?: string; mode?: "movement" | "pair" | "threats";
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PREFIX, buildInspectExpression, validateInspectSelectors, decodeInspectWire } = require("./monitorInspectQuery.cjs") as {
  PREFIX: string; buildInspectExpression(opts: InspectOptions): string;
  validateInspectSelectors(opts: InspectOptions): InspectOptions; decodeInspectWire(wire: unknown): any;
};
const BASE: InspectOptions = { requestId: "abcdef01-2345-6789-abcd-0123456789ab", shard: "shard1", expectedTag: "release-tag" };
const point = (x: number, y = 10) => ({ x, y, roomName: "E2N54" });
const creep = (name: string, x = 12) => ({ name, pos: point(x), hits: 3900, hitsMax: 4000, fatigue: 0, store: { energy: 50, power: 20 } });

function execute(options: Partial<InspectOptions> = {}, extra: Record<string, any> = {}) {
  const lines: string[] = [];
  const sandbox = { Game: { time: 500, shard: { name: "shard1" }, creeps: {}, rooms: {}, map: { describeExits: () => null } },
    Memory: { runtime: { lastDeployTag: "release-tag" }, creeps: {} }, global: {},
    ...extra, console: { log: (line: string) => lines.push(line) } };
  runInNewContext('"use strict";' + buildInspectExpression({ ...BASE, ...options }), sandbox, { timeout: 1000 });
  expect(lines).toHaveLength(1);
  expect(lines[0].startsWith(PREFIX)).toBe(true);
  const wire = JSON.parse(lines[0].slice(PREFIX.length));
  return { line: lines[0], wire, envelope: decodeInspectWire(wire), sandbox };
}

describe("monitor inspect 固定只读短查询", () => {
  test("拒绝表达式和注入选择器，常见联合请求满足官方1024限制，超长选择器发送前失败", () => {
    const invalid = [
      { expr: "Memory.cfg = {}" }, { expression: "console.log('arbitrary')" },
      { rooms: ["E2N54);Memory.cfg.x=1"] }, { creeps: ["red'];Memory.cfg.x=1;//"] },
      { creeps: ["__proto__"] }, { creeps: ["constructor"] }, { creepPrefixes: ["proto"] },
      { rooms: ["E1N1", "E2N2", "E3N3", "E4N4"] }, { creeps: ["a", "b", "c", "d", "e"] },
      { limit: 9 }, { maxBytes: 24001 }, { mode: "movement;Memory.cfg={}" }, { requestId: "uuid;Memory.cfg.x=1" },
    ];
    for (const value of invalid) expect(() => validateInspectSelectors({ ...BASE, ...value } as InspectOptions)).toThrow();
    for (const mode of ["movement", "pair", "threats"] as const) {
      const expression = buildInspectExpression({ ...BASE, mode, rooms: ["E3N53"], creepPrefixes: ["remoteCarrier-"] });
      expect(JSON.stringify(expression).length).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(expression, "utf8")).toBeLessThanOrEqual(1024);
    }
    expect(() => buildInspectExpression({ ...BASE, rooms: ["E2N54"], creepPrefixes: ["a".repeat(100)] })).toThrow(/1024/);
    const opts = { ...BASE, rooms: ["E2N54", "E2N54"] };
    expect(validateInspectSelectors(opts).rooms).toEqual(["E2N54"]);
    expect(opts.rooms).toHaveLength(2);
  });

  test("读取真实heap的movePath与travel segment候选，不改游标，不读原生creep.memory getter", () => {
    const red = creep("red:0");
    Object.defineProperty(red, "memory", { get: () => { throw new Error("native getter must not run"); } });
    Object.freeze(red.pos); Object.freeze(red.store); Object.freeze(red);
    const path = Object.freeze({ targetRoom: "E2N54", targetX: 20, targetY: 10, cursor: 0, stuckTicks: 2,
      steps: Object.freeze([point(11), point(12), point(13), point(14), point(15)].map(value => Object.freeze(value))) });
    const travel = Object.freeze({ targetRoom: "E1N54", stuckTicks: 4, multiRoomSegment: Object.freeze({
      cursor: 1, positions: Object.freeze([point(11), point(12), point(13), point(14), point(15)].map(value => Object.freeze(value))) }) });
    const heap = Object.freeze({ "red:0": Object.freeze({ movePathState: path, travelState: travel }) });
    const memory = Object.freeze({ runtime: Object.freeze({ lastDeployTag: "release-tag" }),
      creeps: Object.freeze({ "red:0": Object.freeze({ roleArgs: Object.freeze(["E2N54", 7, false, "not-returned"]), working: true, token: "must-not-leak",
        _warTowerDrain: Object.freeze({ phase: "breaching", targetRoom: "E2N54", attackerEntry: Object.freeze({ x: 0, y: 25 }),
          healerEntry: Object.freeze({ x: 0, y: 26 }), retreatRoom: "E1N54", blocker: "pair_fatigued" }) }) }) });
    const game = Object.freeze({ time: 500, shard: Object.freeze({ name: "shard1" }), creeps: Object.freeze({ "red:0": red }), rooms: Object.freeze({}) });
    const before = JSON.stringify({ heap, memory, game });
    const { envelope, line } = execute({ creeps: ["red:0"] }, { Game: game, Memory: memory, global: Object.freeze({ __creepMovementState: heap }) });
    const result = envelope.result.creeps[0];
    expect(result.pos).toEqual(point(12));
    expect(result.memory.roleArgs).toEqual(["E2N54", 7, false]);
    expect(result.memory.working).toBe(true);
    expect(result.cargo).toEqual({ store: { energy: 50, power: 20 }, used: 70 });
    // cursor=0仍保留原样；候选切片含当前位置，明确不伪装成恢复后实际next。
    expect(result.movement.movePathState).toMatchObject({ cursor: 0, stuckTicks: 2, targetX: 20, targetY: 10,
      nextBasis: "raw-cursor-slice", nextCandidates: [point(12), point(13), point(14)] });
    expect(result.movement.travelState).toMatchObject({ targetRoom: "E1N54", cursor: 1, stuckTicks: 4,
      nextCandidates: [point(13), point(14), point(15)] });
    expect(JSON.stringify({ heap, memory, game })).toBe(before);
    expect(line).not.toContain("must-not-leak");
    expect(line).not.toContain("not-returned");
    const pair = execute({ mode: "pair", creeps: ["red:0"] }, { Game: game, Memory: memory,
      global: new Proxy({}, { get: () => { throw new Error("pair must not read heap"); } }) }).envelope.result.creeps[0];
    expect(pair.pair).toEqual({ phase: "breaching", targetRoom: "E2N54", attackerEntry: point(0, 25), healerEntry: point(0, 26), retreatRoom: "E1N54", blocker: "pair_fatigued" });
    expect(JSON.stringify({ heap, memory, game })).toBe(before);
  });

  test("扫描与返回有界，使用真实Screeps常量区分友军/敌兵/塔；长路径仅读三个候选", () => {
    const late: Record<string, any> = {};
    for (let index = 0; index < 1010; index += 1) late[`other-${index}`] = creep(`other-${index}`);
    late["squad-late"] = creep("squad-late");
    const missed = execute({ creepPrefixes: ["squad-"] }, { Game: { time: 500, shard: { name: "shard1" }, creeps: late, rooms: {} } }).envelope.result;
    expect(missed.scan).toMatchObject({ scannedNames: 1000, scanLimitReached: true, matchedReturned: 0 });
    const inherited = Object.create({ "squad-inherited": creep("squad-inherited") });
    inherited["squad-own"] = creep("squad-own");
    expect(execute({ creepPrefixes: ["squad-"] }, { Game: { time: 500, shard: { name: "shard1" }, creeps: inherited, rooms: {} } }).envelope.result.creeps.map((value: any) => value.name)).toEqual(["squad-own"]);
    const squad: Record<string, any> = {};
    for (let index = 0; index < 10; index += 1) squad[`squad-${index}`] = creep(`squad-${index}`);
    let stepReads = 0;
    const steps = new Proxy(Array.from({ length: 10000 }, () => point(20)), { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) stepReads += 1;
      return Reflect.get(target, key, receiver);
    } });
    const hostile = { ...creep("invader"), owner: { username: "Invader" } };
    const enemy = { ...creep("enemy"), owner: { username: "Enemy" } };
    const own = { ...creep("friendly"), owner: { username: "Player" } };
    const tower = { structureType: STRUCTURE_TOWER, pos: point(25), hits: 3000, store: { energy: 500 } };
    const spawn = { structureType: STRUCTURE_SPAWN, pos: point(24), hits: 5000 };
    const room = { controller: { reservation: { username: "Lease", ticksToEnd: 123 } }, find: jest.fn((kind: FindConstant) => {
      if (kind === FIND_HOSTILE_CREEPS) return [hostile, enemy];
      if (kind === FIND_HOSTILE_STRUCTURES) return [tower, spawn];
      if (kind === FIND_CREEPS) return [own, hostile, enemy];
      if (kind === FIND_HOSTILE_SPAWNS) return [spawn];
      return [];
    }) };
    const other = { controller: { owner: { username: "Player" } }, find: jest.fn(() => []) };
    const map = { describeExits: jest.fn((name: string) => name === "E2N54" ? { [RIGHT]: "E3N54" }
      : name === "E3N54" ? { [LEFT]: "E2N54", [RIGHT]: "E4N54" } : { [LEFT]: "E3N54" }) };
    const result = execute({ creepPrefixes: ["squad-"], rooms: ["E2N54"] }, {
      Game: { time: 500, shard: { name: "shard1" }, creeps: squad, rooms: { E2N54: room }, map },
      global: { __creepMovementState: { "squad-0": { movePathState: { steps, cursor: 5000, stuckTicks: 0 } } } },
    }).envelope.result;
    expect(result.creeps).toHaveLength(8);
    expect(stepReads).toBe(3);
    const auto = execute({ rooms: ["E2N54", "E3N54", "E4N54"], creepPrefixes: ["absent-"] }, {
      Game: { time: 500, shard: { name: "shard1" }, creeps: { friendly: own }, rooms: { E2N54: room, E3N54: other }, map },
    }).envelope.result;
    expect(auto.creeps.map((value: any) => value.name)).toEqual(["friendly"]);
    expect(auto.rooms[0]).toMatchObject({ controller: { owner: null, reservation: { username: "Lease", ticksToEnd: 123 } }, exits: { [RIGHT]: "E3N54" } });
    expect(auto.rooms[1]).toMatchObject({ controller: { owner: "Player", reservation: null }, exits: { [LEFT]: "E2N54" } });
    expect(auto.rooms[2]).toMatchObject({ visible: false, controller: { owner: null, reservation: null }, exits: { [LEFT]: "E3N54" } });
    const threats = execute({ mode: "threats", rooms: ["E2N54"] }, {
      Game: { time: 500, shard: { name: "shard1" }, creeps: { friendly: own }, rooms: { E2N54: room }, map },
      global: new Proxy({}, { get: () => { throw new Error("threats must not read heap"); } }),
    }).envelope.result;
    expect(threats.creeps.map((value: any) => value.name)).toEqual(["friendly"]);
    expect(threats.rooms[0].hostiles.map((value: any) => [value.name, value.owner])).toEqual([["invader", "Invader"], ["enemy", "Enemy"]]);
    expect(threats.rooms[0].structures.map((value: any) => [value.type, value.energy])).toEqual([[STRUCTURE_TOWER, 500], [STRUCTURE_SPAWN, null]]);
    expect(room.find).toHaveBeenCalledWith(FIND_HOSTILE_CREEPS);
    expect(room.find).toHaveBeenCalledWith(FIND_HOSTILE_STRUCTURES);
    expect(threats.rooms[0].countsComplete).toBe(false);
  });

  test("输出UTF8保守上限含前缀，超限只发完整错误wire，decoder拒绝畸形wire", () => {
    const names: Record<string, any> = {}, saved: Record<string, any> = {};
    for (let index = 0; index < 8; index += 1) {
      names[`squad-${index}`] = creep(`squad-${index}`);
      saved[`squad-${index}`] = { roleArgs: Array.from({ length: 3 }, () => "中".repeat(160)) };
    }
    const { envelope, line } = execute({ creepPrefixes: ["squad-"], maxBytes: 2048 }, {
      Game: { time: 500, shard: { name: "shard1" }, creeps: names, rooms: {} },
      Memory: { runtime: { lastDeployTag: "release-tag" }, creeps: saved },
    });
    expect(envelope.result).toBeNull();
    expect(envelope.error.code).toBe("output-truncated");
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(2048);
    const injection = execute({ expectedTag: "\");Memory.cfg={bad:1};(\"" });
    expect(injection.envelope.deployTag).toBe("release-tag");
    expect(Object.prototype.hasOwnProperty.call(injection.sandbox.Memory, "cfg")).toBe(false);
    const base = [2, BASE.requestId, "shard1", 500, "release-tag", "movement"];
    const invalidStructure = ["road", ["E2N54", 20, 20], null];
    const invalidRoom = ["E2N54", true, null, null, {}, [], [invalidStructure]];
    for (const invalid of [[], [...base, [0, [[[], [], null, null]]], []], [2, BASE.requestId, "shard1", 500, "release-tag", "threats", [0, []], [invalidRoom]]]) {
      expect(() => decodeInspectWire(invalid)).toThrow(/Invalid/);
    }
    expect(() => decodeInspectWire([2, BASE.requestId, "shard1", 500, "x".repeat(161), "movement", [0, []], []])).toThrow(/Invalid/);
  });
});
