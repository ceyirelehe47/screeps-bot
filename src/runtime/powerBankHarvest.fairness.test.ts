import { createMockLab, createMockPowerBank, createMockStore, MockPos } from "@mock/powerBank";

jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn() }));
jest.mock("@/movement/roomTopologyRevision", () => ({ getRoomTopologyRevision: () => "stable" }));
jest.mock("@/runtime/powerBankObserver", () => ({
  hasPowerBankObserverCoverage: () => true,
  requestPowerBankObservation: jest.fn(() => true),
  getPowerBankRoomThreat: (room: Room) => room.find(FIND_HOSTILE_CREEPS).length > 0,
}));

class ClearMatrix {
  get(): number { return 0; }
  set(): void {}
  clone(): ClearMatrix { return new ClearMatrix(); }
}

function coordinates(name: string): { x: number; y: number } {
  const match = /^([EW])(\d+)([NS])(\d+)$/.exec(name)!;
  return { x: match[1] === "E" ? Number(match[2]) : -Number(match[2]) - 1,
    y: match[3] === "S" ? Number(match[4]) : -Number(match[4]) - 1 };
}

function position(x: number, y: number): RoomPosition {
  const rx = Math.floor(x / 50), ry = Math.floor(y / 50);
  return new RoomPosition(x - rx * 50, y - ry * 50,
    `${rx >= 0 ? `E${rx}` : `W${-rx - 1}`}${ry >= 0 ? `S${ry}` : `N${-ry - 1}`}`);
}

function nativePath(origin: RoomPosition, goal: RoomPosition): RoomPosition[] {
  const a = coordinates(origin.roomName), b = coordinates(goal.roomName);
  let x = a.x * 50 + origin.x, y = a.y * 50 + origin.y;
  const gx = b.x * 50 + goal.x, gy = b.y * 50 + goal.y;
  const path: RoomPosition[] = [];
  while (Math.max(Math.abs(x - gx), Math.abs(y - gy)) > 1 ||
    (path[path.length - 1] ?? origin).roomName !== goal.roomName) {
    x += Math.sign(gx - x); y += Math.sign(gy - y); path.push(position(x, y));
    if (path.length > 300) throw new Error("fixture path too long");
  }
  return path;
}

function world() {
  jest.resetModules();
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
  Object.assign(global, { RoomPosition: MockPos });
  Game.time = 1000; Game.rooms = {}; Game.spawns = {}; Game.creeps = {}; Game.powerCreeps = {};
  Game.getObjectById = () => null;
  Memory.creeps = {}; Memory.cfg = {}; Memory.runtime = {};
  Memory.data = { powerBankHarvest: {}, powerBankHarvestHistory: [], creepConfigs: {} };
  const sourceName = "E6N59";
  const labs = [0, 1].map(i => createMockLab({ id: `lab-${i}`, roomName: sourceName, store: { energy: 3000 } }));
  const stock = createMockStore({ energy: 280_000, XGHO2: 5000, XUH2O: 5000 }, 1_000_000);
  const source = {
    name: sourceName, controller: { my: true, level: 8 }, energyCapacityAvailable: 12900,
    storage: { pos: new RoomPosition(20, 20, sourceName), store: stock },
    terminal: { pos: new RoomPosition(21, 20, sourceName), store: createMockStore({}, 300_000) },
    find: (type: FindConstant) => type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES ? labs : [],
  } as unknown as Room;
  Game.rooms[sourceName] = source;
  for (let i = 0; i < 3; i++) {
    const name = `spawn-${i}`;
    Game.spawns[name] = { name, room: source, memory: { spawnList: [] }, spawning: null,
      pos: new RoomPosition(11 + i, 10, sourceName), isActive: () => true } as unknown as StructureSpawn;
  }
  let threat = false;
  const targets: Array<{ task: PowerBankHarvestTask; bank: StructurePowerBank; room: Room }> = [];
  for (let i = 0; i < 9; i++) {
    const target = i === 8 ? "E6N60" : `W${i + 1}N50`;
    const bank = createMockPowerBank({ id: `bank-${i}`, roomName: target, x: 12, y: 32, power: 6307 });
    const room = { name: target, find: (type: FindConstant) => type === FIND_STRUCTURES ? [bank] :
      type === FIND_HOSTILE_CREEPS && target === "E6N60" && threat ? [{}] : [] } as unknown as Room;
    Game.rooms[target] = room;
    const task: PowerBankHarvestTask = {
      id: bank.id, bankId: bank.id, targetRoom: target, sourceRoom: "", status: "discovered",
      bankPos: { x: 12, y: 32 }, hits: bank.hits, power: bank.power, ticksToDecay: 5000, freeTiles: 3,
      discoveredTick: Game.time, lastSeenTick: Game.time, bankExpiresAt: Game.time + 5000,
      haulerIds: [], boostLabs: [], compoundTransferTaskIds: [],
    };
    Memory.data.powerBankHarvest![task.id] = task;
    targets.push({ task, bank, room });
  }
  Game.map = {
    ...Game.map, getWorldSize: () => 200, getRoomLinearDistance: () => 1,
    getRoomStatus: () => ({ status: "normal", timestamp: null }),
    getRoomTerrain: () => ({ get: () => 0 }),
    findRoute: (_from: string | Room, to: string | Room) => [{ exit: TOP, room: typeof to === "string" ? to : to.name }],
  } as unknown as GameMap;
  const calls: Array<{ tick: number; room: string; sourceX: number; plainCost: number }> = [];
  const search = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition; range: number }, options: {
    maxOps: number; plainCost: number; roomCallback: (roomName: string) => CostMatrix | false;
  }) => {
    expect(options.maxOps).toBe(6000);
    calls.push({ tick: Game.time, room: goal.pos.roomName, sourceX: origin.x, plainCost: options.plainCost });
    const incomplete = origin.roomName !== "E6N60" && goal.pos.roomName !== "E6N60";
    const path = incomplete ? [] : nativePath(origin, goal.pos);
    for (const name of new Set([origin.roomName, ...path.map(p => p.roomName)])) {
      expect(options.roomCallback(name)).not.toBe(false);
    }
    return { path, incomplete, ops: incomplete ? 6000 : path.length, cost: path.length };
  });
  Object.assign(global, { PathFinder: { CostMatrix: ClearMatrix, search } });
  const loadHarvest = () => {
    (jest.requireMock("@/movement/routing") as { getCachedStaticTravelMatrix: jest.Mock })
      .getCachedStaticTravelMatrix.mockImplementation(() => new ClearMatrix());
    return (require("@/runtime/powerBankHarvest") as typeof import("@/runtime/powerBankHarvest")).runPowerBankHarvest;
  };
  let harvest = loadHarvest();
  const target = targets[8];
  const runTick = (visible = Game.time % 2 === 0) => {
    for (const entry of targets) entry.bank.ticksToDecay = 6000 - Game.time;
    if (visible) Game.rooms.E6N60 = target.room; else delete Game.rooms.E6N60;
    const before = calls.length;
    harvest();
    const fresh = calls.slice(before);
    expect(fresh.length).toBeLessThanOrEqual(3);
    expect(fresh.filter(c => c.plainCost === 2 && c.room !== sourceName).length).toBeLessThanOrEqual(1);
    Game.time += 1;
  };
  return { target: target.task, calls, targets, stock, runTick,
    threaten: () => { threat = true; },
    reload: () => {
      jest.resetModules();
      delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
      harvest = loadHarvest();
    },
  };
}

it("前八任务反复 incomplete、E6N60 隔 tick 可见，三个 Spawn 均完整测路后准入", () => {
  const w = world();
  for (let i = 0; i < 80 && w.target.status === "discovered"; i++) w.runTick();
  expect(w.target).toMatchObject({ status: "preparing_boosts", sourceRoom: "E6N59" });
  expect(w.target.admissionLastMeasuredAt).toBeGreaterThanOrEqual(1000);
  expect(w.calls.filter(c => c.room === "E6N60" && c.plainCost === 2).map(c => c.sourceX).sort()).toEqual([11, 12, 13]);
});

it("没有视野不会消耗或丢失等待优先级，恢复视野后首先获得名额", () => {
  const w = world();
  for (let i = 0; i < 12; i++) w.runTick(false);
  expect(w.target.admissionLastMeasuredAt).toBeUndefined();
  expect(w.target.blocker).toBe("target_not_visible");
  const before = w.calls.length;
  w.runTick(true);
  expect(w.calls.slice(before).some(c => c.room === "E6N60")).toBe(true);
  expect(w.target.admissionLastMeasuredAt).toBe(Game.time - 1);
});

it("global reset 后保留公平次序，但重新收集原生路径证据", () => {
  const w = world();
  for (let i = 0; i < 9; i++) w.runTick(true);
  const timestamps = w.targets.map(t => t.task.admissionLastMeasuredAt);
  expect(timestamps.every(t => t !== undefined)).toBe(true);
  w.reload();
  expect(w.targets.map(t => t.task.admissionLastMeasuredAt)).toEqual(timestamps);
  for (let i = 0; i < 80 && w.target.status === "discovered"; i++) w.runTick();
  expect(w.target.status).toBe("preparing_boosts");
  expect(w.calls.filter(c => c.room === "E6N60" && c.plainCost === 2).length).toBeGreaterThanOrEqual(4);
});

it("公平名额与已有部分测量不能绕过新鲜威胁门", () => {
  const w = world();
  for (let i = 0; i < 9; i++) w.runTick(true);
  expect(w.target.admissionLastMeasuredAt).toBeDefined();
  w.threaten();
  const before = w.calls.filter(c => c.room === "E6N60").length;
  for (let i = 0; i < 12; i++) w.runTick(true);
  expect(w.target).toMatchObject({ status: "discovered", blocker: "target_combat_threat", sourceRoom: "" });
  expect(w.calls.filter(c => c.room === "E6N60").length).toBe(before);
});

it("部分路径就绪后资源耗尽仍禁止来源准入", () => {
  const w = world();
  for (let i = 0; i < 9; i++) w.runTick(true);
  w.stock.XGHO2 = 0; w.stock.XUH2O = 0;
  for (let i = 0; i < 12 && w.target.status === "discovered"; i++) w.runTick(true);
  expect(w.target.status).toBe("failed");
  expect(w.target.sourceRoom).toBe("");
  expect(w.target.failReason).toContain("insufficient_boost_compound");
});
