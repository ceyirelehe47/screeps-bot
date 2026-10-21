import { createMockLab, createMockPowerBank, createMockStore, MockPos } from "@mock/powerBank";

jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn() }));
jest.mock("@/movement/roomTopologyRevision", () => ({ getRoomTopologyRevision: jest.fn(() => "stable") }));

class ClearMatrix {
  get(): number { return 0; }
  set(): void {}
  clone(): ClearMatrix { return new ClearMatrix(); }
}

interface NativeCall {
  tick: number;
  origin: RoomPosition;
  goal: RoomPosition;
  plainCost: number;
  incomplete: boolean;
}

interface NativeSearchOptions {
  plainCost?: number;
  maxOps?: number;
  roomCallback?: (roomName: string) => CostMatrix | false;
}

interface Scenario {
  task: PowerBankHarvestTask;
  calls: NativeCall[];
  search: jest.Mock;
  runTick(): void;
  runUntilSelected(maximumTicks?: number): void;
  dropCompounds(): void;
  setThreat(): void;
  setRoute(source: string, rooms: string[]): void;
}

const TARGET = "E0N57";
const SHORT_SOURCE = "E1N57";
const NEAR_SOURCE = "W1N57";
const FAR_SOURCE = "E5N59";

function coordinates(roomName: string): { x: number; y: number } {
  const match = /^([EW])(\d+)([NS])(\d+)$/.exec(roomName)!;
  return { x: match[1] === "E" ? Number(match[2]) : -Number(match[2]) - 1,
    y: match[3] === "S" ? Number(match[4]) : -Number(match[4]) - 1 };
}

function tilePosition(x: number, y: number): RoomPosition {
  const roomX = Math.floor(x / 50);
  const roomY = Math.floor(y / 50);
  const roomName = `${roomX >= 0 ? `E${roomX}` : `W${-roomX - 1}`}${roomY >= 0 ? `S${roomY}` : `N${-roomY - 1}`}`;
  return new RoomPosition(x - roomX * 50, y - roomY * 50, roomName);
}

/** 测试 native 返回实际连续格路径，不伪造 ready 或持久化测量成功标记。 */
function nativePath(origin: RoomPosition, goal: RoomPosition, range: number): RoomPosition[] {
  const start = coordinates(origin.roomName);
  const end = coordinates(goal.roomName);
  let x = start.x * 50 + origin.x;
  let y = start.y * 50 + origin.y;
  const goalX = end.x * 50 + goal.x;
  const goalY = end.y * 50 + goal.y;
  const path: RoomPosition[] = [];
  while (Math.max(Math.abs(x - goalX), Math.abs(y - goalY)) > range ||
    (path[path.length - 1] ?? origin).roomName !== goal.roomName) {
    x += Math.sign(goalX - x);
    y += Math.sign(goalY - y);
    path.push(tilePosition(x, y));
    if (path.length > 1_000) throw new Error("fixture route too long");
  }
  return path;
}

function ownedRoom(roomName: string): Room {
  const labs = [0, 1].map((index) => createMockLab({
    id: `${roomName}:lab:${index}`, roomName, store: { energy: 3_000 },
  }));
  const room = {
    name: roomName,
    controller: { my: true, level: 8 },
    energyAvailable: 12_000,
    energyCapacityAvailable: 12_000,
  } as unknown as Room;
  const storage = {
    id: `${roomName}:storage`, structureType: STRUCTURE_STORAGE, room,
    pos: new RoomPosition(20, 20, roomName),
    store: createMockStore({ energy: 50_000, XGHO2: 5_000, XUH2O: 5_000, XLHO2: 5_000 }, 1_000_000),
  } as unknown as StructureStorage;
  const terminal = {
    id: `${roomName}:terminal`, structureType: STRUCTURE_TERMINAL, room,
    pos: new RoomPosition(21, 20, roomName), store: createMockStore({}, 300_000), cooldown: 0,
  } as unknown as StructureTerminal;
  const structures: Structure[] = [storage, terminal, ...labs];
  Object.assign(room, { storage, terminal,
    find: jest.fn((type: FindConstant, options?: { filter?: (structure: Structure) => boolean }) => {
      if (type !== FIND_STRUCTURES && type !== FIND_MY_STRUCTURES) return [];
      return options?.filter ? structures.filter(options.filter) : structures;
    }),
  });
  for (let index = 0; index < 3; index += 1) {
    const name = `${roomName}:spawn:${index}`;
    Game.spawns[name] = {
      id: name, name, room, pos: new RoomPosition(11 + index, 10, roomName),
      memory: { spawnList: [] }, spawning: null, isActive: () => true,
    } as unknown as StructureSpawn;
  }
  return room;
}

function scenario(
  failure: (origin: RoomPosition, goal: RoomPosition) => boolean,
  distantFirst = false,
): Scenario {
  jest.resetModules();
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
  Object.assign(global, { RoomPosition: MockPos });
  Game.time = 1_000;
  Game.creeps = {};
  Game.powerCreeps = {};
  Game.spawns = {};
  Game.rooms = {};
  Memory.creeps = {};
  Memory.rooms = {};
  Memory.cfg = {};
  Memory.runtime = {};
  Memory.data = { powerBankHarvest: {}, powerBankHarvestHistory: [] };
  const sources = [SHORT_SOURCE, NEAR_SOURCE, FAR_SOURCE].map(ownedRoom);
  for (const room of sources) Game.rooms[room.name] = room;
  let threatened = false;
  const bank = createMockPowerBank({ id: "native-cache-bank", roomName: TARGET, ticksToDecay: 5_000 });
  Game.rooms[TARGET] = {
    name: TARGET,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_STRUCTURES) return [bank];
      if (type === FIND_HOSTILE_CREEPS && threatened) return [{ getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 1 : 0 }];
      return [];
    }),
  } as unknown as Room;
  const routes: Record<string, string[]> = {
    [SHORT_SOURCE]: distantFirst
      ? [SHORT_SOURCE, "E1N58", "E1N59", "E0N59", "W0N59", "W1N59", "W2N59", "W2N58", "W2N57", NEAR_SOURCE, "W0N57", TARGET]
      : [SHORT_SOURCE, TARGET],
    [NEAR_SOURCE]: [NEAR_SOURCE, "W0N57", TARGET],
    [FAR_SOURCE]: [FAR_SOURCE, "E4N59", "E3N59", "E2N59", "E1N59", "E0N59", "E0N58", TARGET],
  };
  Game.map = {
    ...Game.map,
    getRoomStatus: jest.fn(() => ({ status: "normal", timestamp: null })),
    getWorldSize: jest.fn(() => 200),
    getRoomLinearDistance: jest.fn(() => 2),
    getRoomTerrain: jest.fn(() => ({ get: () => 0 })),
    findRoute: jest.fn((from: string, to: string) => (routes[from] ?? [from, to]).slice(1)
      .map((room) => ({ room, exit: FIND_EXIT_LEFT }))),
  } as unknown as GameMap;
  const calls: NativeCall[] = [];
  const search = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition; range: number }, options: NativeSearchOptions) => {
    expect(options.maxOps).toBe(6_000);
    const incomplete = failure(origin, goal.pos);
    calls.push({ tick: Game.time, origin, goal: goal.pos, plainCost: options.plainCost!, incomplete });
    const path = incomplete ? [] : nativePath(origin, goal.pos, goal.range);
    // 原生搜索仍使用模块给出的安全走廊 callback；返回的每步还会再经过
    // REAL PF module 的逐步连续、静态障碍与同房 range 1 校验。
    for (const roomName of new Set([origin.roomName, ...path.map((step) => step.roomName)])) {
      if (options.roomCallback?.(roomName) === false) throw new Error(`fixture native escaped route: ${roomName}`);
    }
    return { path, incomplete, ops: incomplete ? 6_000 : path.length, cost: path.length };
  });
  Object.assign(global, { PathFinder: { CostMatrix: ClearMatrix, search } });
  (jest.requireMock("@/movement/routing") as { getCachedStaticTravelMatrix: jest.Mock })
    .getCachedStaticTravelMatrix.mockImplementation(() => new ClearMatrix());
  const services = require("@/runtime/runtimeServices") as typeof import("@/runtime/runtimeServices");
  services.registerRuntimeServices();
  const observer = require("@/runtime/powerBankObserver") as typeof import("@/runtime/powerBankObserver");
  jest.spyOn(observer, "hasPowerBankObserverCoverage").mockReturnValue(true);
  jest.spyOn(observer, "requestPowerBankObservation").mockReturnValue(true);
  const harvest = require("@/runtime/powerBankHarvest") as typeof import("@/runtime/powerBankHarvest");
  const task: PowerBankHarvestTask = {
    id: "native-cache-task", status: "discovered", sourceRoom: "", targetRoom: TARGET,
    bankId: bank.id, bankPos: { x: 25, y: 25 }, hits: 2_000_000, power: 5_000,
    ticksToDecay: 5_000, freeTiles: 8, discoveredTick: Game.time, lastSeenTick: Game.time,
    bankExpiresAt: Game.time + 5_000, haulerIds: [], boostLabs: [], compoundTransferTaskIds: [],
  };
  Memory.data!.powerBankHarvest![task.id] = task;
  const runTick = (): void => {
    const before = calls.length;
    harvest.runPowerBankHarvest();
    const fresh = calls.slice(before);
    expect(fresh.length).toBeLessThanOrEqual(3);
    expect(fresh.filter((call) => call.plainCost === 2 && call.goal.roomName === TARGET).length)
      .toBeLessThanOrEqual(1);
    Game.time += 1;
  };
  return {
    task, calls, search, runTick,
    runUntilSelected: (maximumTicks = 20) => {
      for (let tick = 0; tick < maximumTicks && task.status === "discovered"; tick += 1) runTick();
    },
    dropCompounds: () => {
      for (const room of sources) {
        for (const resource of [RESOURCE_CATALYZED_GHODIUM_ALKALIDE, RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]) {
          room.storage!.store[resource] = 0;
        }
      }
    },
    setThreat: () => { threatened = true; },
    setRoute: (source, rooms) => { routes[source] = rooms; },
  };
}

function completeCombatOrigins(world: Scenario, room: string): number[] {
  return world.calls.filter((call) => call.origin.roomName === room && call.goal.roomName === TARGET &&
    call.plainCost === 2 && !call.incomplete).map((call) => call.origin.x);
}

describe("PB 来源准入使用真实有界 PF 缓存", () => {
  it("按实际安全路线限制高速入口：E1N57绕行五跳才上高速时由近来源生产", () => {
    const world = scenario(() => false);
    world.setRoute(SHORT_SOURCE, [SHORT_SOURCE, "E2N57", "E2N58", "E3N58", "E3N59", "E3N60", TARGET]);
    world.runUntilSelected();
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE });
    expect(world.calls.some(call => call.origin.roomName === SHORT_SOURCE)).toBe(false);
  });

  it("只有远离高速的来源时不派新队，也不消耗原生测路预算", () => {
    const world = scenario(() => false);
    for (const source of [SHORT_SOURCE, NEAR_SOURCE, FAR_SOURCE]) {
      world.setRoute(source, [source, "E2N57", "E2N58", "E3N58", "E3N59", "E3N60", TARGET]);
    }
    world.runTick();
    expect(world.task).toMatchObject({ status: "failed", sourceRoom: "" });
    expect(world.task.failReason).toContain("highway_approach_too_long");
    expect(world.calls).toHaveLength(0);
  });

  it("原生路径即使能穿过中转有主房，也不授予来源生产许可", () => {
    const world = scenario((origin, goal) => origin.roomName !== NEAR_SOURCE && goal.roomName === TARGET);
    Game.rooms.W0N57 = { name: "W0N57", controller: { my: false, owner: { username: "enemy" } }, find: jest.fn(() => []) } as unknown as Room;
    world.runUntilSelected(6);
    expect(world.task.status).toBe("discovered");
    expect(completeCombatOrigins(world, NEAR_SOURCE)).toEqual([]);
  });

  it("首个短 source 永远 incomplete：先在首个 hold 窗口内等待近来源，窗口到期后才由远来源生产", () => {
    const world = scenario((origin, goal) => origin.roomName === SHORT_SOURCE && goal.roomName === TARGET);
    world.runUntilSelected(10);
    // 远来源已测完，但近来源首次非预算 pending 仍在等待窗口内：不静默放行。
    expect(world.task).toMatchObject({ status: "discovered", sourceRoom: "", blocker: "path_measurement_pending" });
    expect(world.task.lastSourceEvaluation?.reasons).toEqual(expect.arrayContaining([
      `${SHORT_SOURCE}:pending_path_incomplete`, `${NEAR_SOURCE}:waiting_for_nearer_${SHORT_SOURCE}`,
    ]));
    world.runUntilSelected(40);
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE });
    expect(Game.time - 1_000).toBeLessThanOrEqual(30);
    expect(completeCombatOrigins(world, NEAR_SOURCE).sort()).toEqual([11, 12, 13]);
    for (const x of [11, 12, 13]) {
      const ticks = world.calls.filter((call) => call.origin.roomName === SHORT_SOURCE &&
        call.origin.x === x && call.plainCost === 2).map((call) => call.tick);
      expect(ticks.length).toBeGreaterThan(0);
      for (let index = 1; index < ticks.length; index += 1) expect(ticks[index] - ticks[index - 1]).toBeGreaterThanOrEqual(5);
    }
  });

  it("W1N57 的实际两跳走廊优先；E1N57 十一跳和长期未测的 far 不否决已完整来源", () => {
    const world = scenario((origin, goal) => origin.roomName !== NEAR_SOURCE && goal.roomName === TARGET, true);
    world.runUntilSelected();
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE, routeDistance: 2 });
    expect(world.task.routeRooms).toEqual([NEAR_SOURCE, "W0N57", TARGET]);
    expect(completeCombatOrigins(world, NEAR_SOURCE).sort()).toEqual([11, 12, 13]);
    expect(world.calls.filter((call) => call.plainCost === 2 && call.origin.roomName !== NEAR_SOURCE)).toEqual([]);
    expect(world.task.combatTravelTicks).toBeGreaterThan(0);
    expect(world.task.haulerOutboundTravelTicks).toBeGreaterThan(0);
    expect(world.task.haulerReturnTravelTicks).toBeGreaterThan(0);
    expect(Game.time - 1_000).toBeLessThanOrEqual(4);
  });

  it("某一 Spawn 缺完整路径的 source 不可选择；所有来源 incomplete 时保持 discovered", () => {
    {
      const world = scenario((origin, goal) => origin.roomName === SHORT_SOURCE && origin.x === 11 && goal.roomName === TARGET);
      world.runUntilSelected(40);
      expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE });
      expect(completeCombatOrigins(world, SHORT_SOURCE).sort()).toEqual([12, 13]);
      expect(completeCombatOrigins(world, NEAR_SOURCE).sort()).toEqual([11, 12, 13]);
    }
    {
      const world = scenario(() => true);
      world.runUntilSelected();
      expect(world.task).toMatchObject({ status: "discovered", sourceRoom: "", blocker: "path_measurement_pending" });
      expect(world.calls.length).toBeGreaterThan(0);
      expect(world.calls.every((call) => call.incomplete)).toBe(true);
      const before = world.calls.length;
      world.task.bankExpiresAt = Game.time;
      world.runTick();
      expect(world.task).toMatchObject({ status: "failed", failReason: "bank_expired" });
      expect(world.calls).toHaveLength(before);
    }
  });

  it.each(["expiry", "resource", "threat"])("已缓存部分完整几何后，%s 新鲜门仍阻止投入", (gate) => {
    const world = scenario(() => false, true);
    world.runTick();
    world.runTick();
    expect(world.task.status).toBe("discovered");
    expect(completeCombatOrigins(world, NEAR_SOURCE).sort()).toEqual([11, 12]);
    const before = world.calls.length;
    if (gate === "expiry") world.task.bankExpiresAt = Game.time;
    if (gate === "resource") world.dropCompounds();
    if (gate === "threat") world.setThreat();
    world.runTick();
    expect(world.task.status).not.toBe("preparing_boosts");
    expect(world.task.sourceRoom).toBe("");
    expect(world.calls).toHaveLength(before);
    if (gate === "expiry") expect(world.task).toMatchObject({ status: "failed", failReason: "bank_expired" });
    if (gate === "resource") expect(world.task.failReason).toContain("insufficient_boost_compound");
    if (gate === "threat") expect(world.task).toMatchObject({ status: "discovered", blocker: "target_combat_threat" });
  });
  it("近来源暂时 path_incomplete 时不被已测完 ready 的远来源抢走；hold 内重测完成后选近来源", () => {
    const world = scenario(() => false);
    const base = world.search.getMockImplementation()!;
    // 前若干 tick 近来源原生返回坏路径（非预算、非 engine incomplete 的 5 tick 退避）。
    world.search.mockImplementation((origin: RoomPosition, goal: { pos: RoomPosition; range: number }, options: NativeSearchOptions) =>
      origin.roomName === SHORT_SOURCE && Game.time < 1_006
        ? { path: null, incomplete: false, ops: 1, cost: 0 }
        : base(origin, goal, options));
    world.runUntilSelected(40);
    // 远来源 W1N57 三个 Spawn 都已测出完整路径（cached ready），仍选更近的 E1N57。
    expect(completeCombatOrigins(world, NEAR_SOURCE).sort()).toEqual([11, 12, 13]);
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: SHORT_SOURCE });
    expect(world.task.sourcePendingHolds).toBeUndefined();
    expect(Game.time - 1_000).toBeLessThanOrEqual(26);
  });

  it("来源索引存在时按索引顺序准入：第一个完全合格者胜出，不测索引外来源", () => {
    const world = scenario(() => false);
    const index = require("@/runtime/powerBankSourceIndex") as typeof import("@/runtime/powerBankSourceIndex");
    jest.spyOn(index, "getPowerBankSourceIndexEntry").mockImplementation((room) => room === TARGET
      ? [{ room: NEAR_SOURCE, ticks: 60, level: 8 }, { room: SHORT_SOURCE, ticks: 80, level: 8 }]
      : undefined);
    jest.spyOn(index, "getPowerBankSourceIndexTicks").mockImplementation((_room, source) =>
      source === NEAR_SOURCE ? 60 : source === SHORT_SOURCE ? 80 : undefined);
    world.runUntilSelected();
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE });
    expect(world.task.lastSourceEvaluation).toMatchObject({ mode: "index", chosen: NEAR_SOURCE });
    expect(world.calls.some((call) => call.origin.roomName === SHORT_SOURCE || call.origin.roomName === FAR_SOURCE)).toBe(false);
  });

  it("索引来源全部不合格时记录 index_exhausted 并回退全量评估", () => {
    const world = scenario(() => false);
    const index = require("@/runtime/powerBankSourceIndex") as typeof import("@/runtime/powerBankSourceIndex");
    jest.spyOn(index, "getPowerBankSourceIndexEntry").mockImplementation((room) => room === TARGET
      ? [{ room: SHORT_SOURCE, ticks: 40, level: 8 }]
      : undefined);
    (Game.rooms[SHORT_SOURCE].storage!.store as unknown as Record<string, number>)[RESOURCE_CATALYZED_GHODIUM_ALKALIDE] = 0;
    world.runTick();
    expect(world.task.lastSourceEvaluation?.mode).toBe("all");
    expect(world.task.lastSourceEvaluation?.reasons).toEqual(expect.arrayContaining([
      `${SHORT_SOURCE}:insufficient_boost_compound`, "index_exhausted",
    ]));
    world.runUntilSelected();
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE });
  });

  it("静默跳过的来源写入拒绝原因，并经 powerBankStatus 输出", () => {
    const world = scenario(() => false);
    const policy = require("@/runtime/outboundMissionPolicy") as typeof import("@/runtime/outboundMissionPolicy");
    jest.spyOn(policy, "canStartOutboundMission").mockImplementation((room) => room !== SHORT_SOURCE);
    (Game.rooms[FAR_SOURCE].controller as { level: number }).level = 5;
    world.runTick();
    const reasons = world.task.lastSourceEvaluation?.reasons ?? [];
    expect(reasons).toEqual(expect.arrayContaining([
      `${SHORT_SOURCE}:outbound_blocked`, `${FAR_SOURCE}:rcl_below_min`, `${NEAR_SOURCE}:pending_budget`,
    ]));
    const status = require("@/runtime/powerBankStatus") as typeof import("@/runtime/powerBankStatus");
    const snapshot = status.powerBankStatusRaw().tasks.find((task) => task.taskId === world.task.id)!;
    expect(snapshot.sourceEvaluation).toMatchObject({ mode: "all", chosen: null, age: 1 });
    expect(snapshot.sourceEvaluation!.reasons).toContain(`${SHORT_SOURCE}:outbound_blocked`);
  });
});
