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
  };
}

function completeCombatOrigins(world: Scenario, room: string): number[] {
  return world.calls.filter((call) => call.origin.roomName === room && call.goal.roomName === TARGET &&
    call.plainCost === 2 && !call.incomplete).map((call) => call.origin.x);
}

describe("PB 来源准入使用真实有界 PF 缓存", () => {
  it("原生路径即使能穿过中转有主房，也不授予来源生产许可", () => {
    const world = scenario((origin, goal) => origin.roomName !== NEAR_SOURCE && goal.roomName === TARGET);
    Game.rooms.W0N57 = { name: "W0N57", controller: { my: false, owner: { username: "enemy" } }, find: jest.fn(() => []) } as unknown as Room;
    world.runUntilSelected(6);
    expect(world.task.status).toBe("discovered");
    expect(completeCombatOrigins(world, NEAR_SOURCE)).toEqual([]);
  });

  it("首个短 source 永远 incomplete，真实五 tick 负缓存给其它三 Spawn 来源留下测量机会", () => {
    const world = scenario((origin, goal) => origin.roomName === SHORT_SOURCE && goal.roomName === TARGET);
    world.runUntilSelected();
    expect(world.task).toMatchObject({ status: "preparing_boosts", sourceRoom: NEAR_SOURCE });
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
      world.runUntilSelected();
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
});
