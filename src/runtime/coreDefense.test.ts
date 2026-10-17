jest.mock("@/runtime/runtimeServices", () => ({ getTickContextService: () => ({
  getMyRooms: () => Object.values(Game.rooms), getRoomContext: () => undefined,
}), getMemoryService: () => ({ ensureRuntime: () => Memory.runtime ??= {} }) }));
import { runCoreDefense } from "@/runtime/coreDefense";

function scenario() {
  Game.time = 123;
  const ramparts = new Map<string, StructureRampart>();
  const structures: Structure[] = [];
  const hostiles: Creep[] = [];
  const nukes: Nuke[] = [];
  class Pos {
    constructor(public x: number, public y: number, public roomName = "W1N1") {}
    getRangeTo(pos: { pos?: RoomPosition; x?: number; y?: number }) {
      const p = pos.pos ?? pos;
      return Math.max(Math.abs(this.x - p.x!), Math.abs(this.y - p.y!));
    }
    lookFor() { const r = ramparts.get(`${this.x}:${this.y}`); return r ? [r] : []; }
  }
  Object.assign(global, { RoomPosition: Pos });
  const room = { name: "W1N1", memory: {}, controller: { my: true, pos: new Pos(25, 25), safeModeAvailable: 1,
    activateSafeMode: jest.fn(() => OK) }, find: (kind: FindConstant) => kind === FIND_MY_STRUCTURES ? structures
      : kind === FIND_HOSTILE_CREEPS ? hostiles : kind === FIND_NUKES ? nukes : [] } as unknown as Room;
  Game.rooms = { W1N1: room };
  Memory.data = {};
  const tower = { id: "tower", pos: new Pos(20, 20), structureType: STRUCTURE_TOWER, hits: 3000 } as unknown as StructureTower;
  structures.push(tower);
  const rampart = { my: true, pos: tower.pos, structureType: STRUCTURE_RAMPART, hits: 1000, ticksToDecay: 20 } as StructureRampart;
  ramparts.set("20:20", rampart);
  const hostile = { pos: new Pos(20, 21), getActiveBodyparts: (type: BodyPartConstant) => type === ATTACK ? 1 : 0 } as unknown as Creep;
  hostiles.push(hostile);
  const step = () => { Game.time += 1; runCoreDefense(); };
  return { room, tower, rampart, ramparts, hostiles, hostile, nukes, Pos, step, structures };
}

it("核心 rampart 被摧毁后仍触发 safe mode", () => {
  const w = scenario(); runCoreDefense(); w.ramparts.clear(); w.step();
  expect(w.room.controller!.activateSafeMode).toHaveBeenCalledTimes(1);
});
it("结构自己的衰减点不误报，低血 rampart 自然消失也不误报", () => {
  const w = scenario(); w.rampart.ticksToDecay = 1; runCoreDefense();
  w.rampart.hits -= RAMPART_DECAY_AMOUNT; w.rampart.ticksToDecay = RAMPART_DECAY_TIME; w.step();
  expect(w.room.controller!.activateSafeMode).not.toHaveBeenCalled();
  const low = scenario(); low.rampart.hits = 100; low.rampart.ticksToDecay = 1; runCoreDefense(); low.ramparts.clear(); low.step();
  expect(low.room.controller!.activateSafeMode).not.toHaveBeenCalled();
});
it("塔受伤可以触发，无规划数据时仍覆盖真实核心", () => {
  const w = scenario(); runCoreDefense(); w.tower.hits -= 100; w.step();
  expect(w.room.controller!.activateSafeMode).toHaveBeenCalledTimes(1);
});
it("相邻敌 CLAIM 在 attackController 禁止 safe mode 前触发", () => {
  const w = scenario(); w.hostiles.length = 0;
  w.hostiles.push({ pos: new w.Pos(24, 25), getActiveBodyparts: (type: BodyPartConstant) => type === CLAIM ? 1 : 0 } as unknown as Creep);
  runCoreDefense(); expect(w.room.controller!.activateSafeMode).toHaveBeenCalledTimes(1);
});
it("落地后 Nuke 对象消失仍排除核伤害", () => {
  const w = scenario(); w.nukes.push({ pos: w.tower.pos, timeToLand: 1 } as Nuke); runCoreDefense();
  w.nukes.length = 0; w.rampart.hits -= 100; w.tower.hits -= 100; w.step();
  expect(w.room.controller!.activateSafeMode).not.toHaveBeenCalled();
});


it("没有规划快照的裸塔一 tick 内被摧毁仍触发", () => {
  const w = scenario(); w.ramparts.clear(); runCoreDefense(); w.structures.length = 0; w.step();
  expect(w.room.controller!.activateSafeMode).toHaveBeenCalledTimes(1);
});

it("前房读取失败不阻断后房 safe mode，下一 tick 继续尝试故障房", () => {
  const w = scenario();
  const failed = { name: "W0N0", find: jest.fn(() => { throw new Error("bad-room"); }) } as unknown as Room;
  Game.rooms = { W0N0: failed, W1N1: w.room };
  w.hostiles.length = 0;
  w.hostiles.push({ pos: new w.Pos(24, 25), getActiveBodyparts: (type: BodyPartConstant) => type === CLAIM ? 1 : 0 } as unknown as Creep);
  expect(() => runCoreDefense()).not.toThrow();
  expect(w.room.controller!.activateSafeMode).toHaveBeenCalledTimes(1);
  w.step(); expect(failed.find).toHaveBeenCalledTimes(2);
});
