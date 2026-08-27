/**
 * routing 跨房矩阵障碍回归测试：跨房 roomCallback 与单房移动共用同一套
 * 静态障碍语义（Source / Deposit / Portal / road 成本），且 ignoreCreeps=false
 * 时在 clone 上叠加全部动态障碍——己方/敌方普通 creep 与己方/敌方 PowerCreep。
 */
import { clearRoutingCachesForTest, moveToTargetRoom } from "@/movement/routing";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoomTopologyRevisionCacheForTest } from "@/movement/roomTopologyRevision";
import { clearRoomBaseCostMatrixCacheForTest } from "@/movement/pathing";
import {
  MockRoomPosition,
  RealCostMatrix,
  createCreep,
  createRoom,
  resetRuntimeServices,
  setDefaultMapMocks,
  setupPathFinderGlobal,
  setupRoomPositionGlobal,
} from "@mock/movement";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

interface RoutingHarness {
  room: Room;
  structures: Structure<StructureConstant>[];
  sources: Source[];
  deposits: Deposit[];
  creeps: Creep[];
  hostileCreeps: Creep[];
  hostilePowerCreeps: PowerCreep[];
  getCapturedMatrix: () => RealCostMatrix | undefined;
}

function setupRoutingRoom(): RoutingHarness {
  const structures: Structure<StructureConstant>[] = [];
  const sources: Source[] = [];
  const deposits: Deposit[] = [];
  const creeps: Creep[] = [];
  const hostileCreeps: Creep[] = [];
  const hostilePowerCreeps: PowerCreep[] = [];
  const room = createRoom("W1N1", creeps);
  // mock controller 没有 pos，直接去掉避免 controller 区域逻辑读取失败；
  // controller 障碍语义已在 staticRoomMatrix.test.ts 直接覆盖。
  delete (room as { controller?: unknown }).controller;
  room.findExitTo = jest.fn(() => RIGHT) as unknown as Room["findExitTo"];

  room.find = jest.fn((findConstant: number) => {
    switch (findConstant) {
      case FIND_STRUCTURES:
      case FIND_MY_STRUCTURES:
        return structures;
      case FIND_MY_CREEPS:
        return creeps;
      case FIND_HOSTILE_CREEPS:
        return hostileCreeps;
      case FIND_HOSTILE_POWER_CREEPS:
        return hostilePowerCreeps;
      case FIND_CONSTRUCTION_SITES:
        return [];
      case FIND_SOURCES:
        return sources;
      case FIND_MINERALS:
        return [];
      case FIND_DEPOSITS:
        return deposits;
      default:
        return [];
    }
  }) as unknown as Room["find"];

  let capturedMatrix: RealCostMatrix | undefined;
  const pathFinderGlobal = (global as unknown as { PathFinder: { search: jest.Mock } }).PathFinder;
  pathFinderGlobal.search = jest.fn(
    (
      _origin: RoomPosition,
      _goal: { pos: RoomPosition; range: number },
      opts: { roomCallback?: (roomName: string) => boolean | CostMatrix },
    ) => {
      capturedMatrix = opts.roomCallback?.("W1N1") as unknown as RealCostMatrix | undefined;
      return { path: [], incomplete: true, ops: 0, cost: 0 };
    },
  );

  return { room, structures, sources, deposits, creeps, hostileCreeps, hostilePowerCreeps, getCapturedMatrix: () => capturedMatrix };
}

describe("routing multi-room matrix obstacles", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomTopologyRevisionCacheForTest();
    clearRoomBaseCostMatrixCacheForTest();
    clearRoutingCachesForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    Memory.data = undefined;
    setupRoomPositionGlobal();
    setupPathFinderGlobal(RealCostMatrix as unknown as new () => CostMatrix);
    setDefaultMapMocks();
    Object.assign(Game.map, {
      findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
      describeExits: jest.fn((roomName: string) => {
        if (roomName === "W1N1") {
          return { [RIGHT]: "W1N2" };
        }
        if (roomName === "W1N2") {
          return { [LEFT]: "W1N1" };
        }
        return null;
      }),
    });
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("ignoreCreeps=false 时跨房矩阵叠加己方/敌方 creep 与两类 PowerCreep", () => {
    const harness = setupRoutingRoom();
    const creep = createCreep("traveler", "worker", 10, 10, harness.room);
    const friendly = createCreep("friendly", "worker", 14, 10, harness.room);
    harness.creeps.push(creep, friendly);
    Game.creeps[creep.name] = creep;
    Game.creeps[friendly.name] = friendly;
    harness.hostileCreeps.push({
      name: "hostile-creep",
      pos: new MockRoomPosition(11, 10, "W1N1"),
    } as unknown as Creep);
    harness.hostilePowerCreeps.push({
      name: "hostile-power",
      pos: new MockRoomPosition(12, 10, "W1N1"),
    } as unknown as PowerCreep);
    Game.powerCreeps = {
      "my-power": {
        name: "my-power",
        pos: new MockRoomPosition(13, 10, "W1N1"),
        ticksToLive: 1_000,
        room: harness.room,
      } as unknown as PowerCreep,
    };

    moveToTargetRoom(creep, "W1N2", undefined, { ignoreCreeps: false });

    const matrix = harness.getCapturedMatrix();
    expect(matrix?.get(11, 10)).toBe(0xfe);
    expect(matrix?.get(12, 10)).toBe(0xfe);
    expect(matrix?.get(13, 10)).toBe(0xfe);
    expect(matrix?.get(14, 10)).toBe(0xfe);
    // 寻路者自身不叠加动态障碍。
    expect(matrix?.get(10, 10)).toBe(0);
  });

  it("跨房矩阵复用共用静态层：Source/Deposit/Portal 阻挡，road 成本 1", () => {
    const harness = setupRoutingRoom();
    harness.sources.push({ pos: new MockRoomPosition(11, 10, "W1N1") } as unknown as Source);
    harness.deposits.push({ pos: new MockRoomPosition(12, 10, "W1N1") } as unknown as Deposit);
    harness.structures.push({
      structureType: STRUCTURE_PORTAL,
      pos: new MockRoomPosition(13, 10, "W1N1"),
    } as unknown as StructurePortal);
    harness.structures.push({
      structureType: STRUCTURE_ROAD,
      pos: new MockRoomPosition(14, 10, "W1N1"),
    } as unknown as StructureRoad);
    const creep = createCreep("traveler", "worker", 10, 10, harness.room);
    harness.creeps.push(creep);
    Game.creeps[creep.name] = creep;

    moveToTargetRoom(creep, "W1N2", undefined, { ignoreCreeps: true });

    const matrix = harness.getCapturedMatrix();
    expect(matrix?.get(11, 10)).toBe(0xff);
    expect(matrix?.get(12, 10)).toBe(0xff);
    expect(matrix?.get(13, 10)).toBe(0xff);
    expect(matrix?.get(14, 10)).toBe(1);
  });
});
