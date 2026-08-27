/**
 * 静态 CostMatrix 障碍语义回归测试：自建矩阵必须完整复刻引擎默认矩阵的
 * 静态障碍（costCallback / roomCallback 返回新矩阵后引擎不会补回）——
 * Source / Mineral / Deposit / Controller / Portal / 不可通行结构 / 工地，
 * 同时保证 Portal 显式目标豁免、跨 tick 缓存复用后障碍不丢失、动态 creep
 * 消失后格子恢复正确静态成本、Deposit 出现/消失触发重建。
 */
import {
  clearRoomBaseCostMatrixCacheForTest,
  getRoomBaseCostMatrixBuildCountForTest,
  moveToTarget,
} from "@/movement/pathing";
import { buildStaticRoomCostMatrix } from "@/movement/staticRoomMatrix";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoomTopologyRevisionCacheForTest } from "@/movement/roomTopologyRevision";
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

const ROOM_NAME = "W1N1";

function makeNatural<T>(x: number, y: number): T {
  return { pos: new MockRoomPosition(x, y, ROOM_NAME) } as unknown as T;
}

interface StructureLike {
  structureType: string;
  pos: RoomPosition;
  my?: boolean;
  isPublic?: boolean;
}

function makeStructure(
  structureType: string,
  x: number,
  y: number,
  extra: Partial<StructureLike> = {},
): Structure<StructureConstant> {
  return { structureType, pos: new MockRoomPosition(x, y, ROOM_NAME), ...extra } as unknown as Structure<StructureConstant>;
}

function makeSite(structureType: string, x: number, y: number): ConstructionSite {
  return {
    structureType,
    pos: new MockRoomPosition(x, y, ROOM_NAME),
    my: true,
  } as unknown as ConstructionSite;
}

interface StaticHarness {
  room: Room;
  structures: Structure<StructureConstant>[];
  sites: ConstructionSite[];
  sources: Source[];
  minerals: Mineral[];
  deposits: Deposit[];
  creeps: Creep[];
  hostileCreeps: Creep[];
  hostilePowerCreeps: PowerCreep[];
}

function setupStaticRoom(): StaticHarness {
  const structures: Structure<StructureConstant>[] = [];
  const sites: ConstructionSite[] = [];
  const sources: Source[] = [];
  const minerals: Mineral[] = [];
  const deposits: Deposit[] = [];
  const creeps: Creep[] = [];
  const hostileCreeps: Creep[] = [];
  const hostilePowerCreeps: PowerCreep[] = [];
  const room = createRoom(ROOM_NAME, creeps);

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
        return sites;
      case FIND_SOURCES:
        return sources;
      case FIND_MINERALS:
        return minerals;
      case FIND_DEPOSITS:
        return deposits;
      default:
        return [];
    }
  }) as unknown as Room["find"];

  return { room, structures, sites, sources, minerals, deposits, creeps, hostileCreeps, hostilePowerCreeps };
}

function wireFindPathCapture(creep: Creep): () => RealCostMatrix | undefined {
  let captured: RealCostMatrix | undefined;
  (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
    (
      _target: unknown,
      opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix },
    ) => {
      captured = opts.costCallback?.(ROOM_NAME, new RealCostMatrix() as unknown as CostMatrix) as unknown as RealCostMatrix;
      return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
    },
  );
  return () => captured;
}

describe("static room cost matrix", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomTopologyRevisionCacheForTest();
    clearRoomBaseCostMatrixCacheForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    Memory.data = undefined;
    setupRoomPositionGlobal();
    setupPathFinderGlobal(RealCostMatrix as unknown as new () => CostMatrix);
    setDefaultMapMocks();
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("复刻引擎默认静态障碍：wall/Source/Mineral/Deposit/Controller/不可走结构与工地/Portal 阻挡，road=1，公共 rampart 可走", () => {
    (Game.map.getRoomTerrain as unknown) = jest.fn(() => ({
      get: (x: number, y: number) => (x === 3 && y === 3 ? TERRAIN_MASK_WALL : 0),
    })) as unknown as GameMap["getRoomTerrain"];

    const matrix = buildStaticRoomCostMatrix(ROOM_NAME, {
      structures: [
        makeStructure(STRUCTURE_ROAD, 10, 10),
        makeStructure(STRUCTURE_PORTAL, 20, 20),
        makeStructure(STRUCTURE_RAMPART, 30, 30, { my: false, isPublic: true }),
        makeStructure(STRUCTURE_RAMPART, 31, 31, { my: false, isPublic: false }),
        makeStructure(STRUCTURE_SPAWN, 40, 40),
      ],
      constructionSites: [makeSite(STRUCTURE_EXTENSION, 41, 41)],
      sources: [makeNatural<Source>(5, 5)],
      minerals: [makeNatural<Mineral>(6, 6)],
      deposits: [makeNatural<Deposit>(7, 7)],
      controller: { my: true, pos: new MockRoomPosition(8, 8, ROOM_NAME) } as unknown as StructureController,
    }) as unknown as RealCostMatrix;

    expect(matrix.get(3, 3)).toBe(0xff);
    expect(matrix.get(5, 5)).toBe(0xff);
    expect(matrix.get(6, 6)).toBe(0xff);
    expect(matrix.get(7, 7)).toBe(0xff);
    expect(matrix.get(8, 8)).toBe(0xff);
    expect(matrix.get(20, 20)).toBe(0xff);
    expect(matrix.get(40, 40)).toBe(0xff);
    expect(matrix.get(41, 41)).toBe(0xff);
    expect(matrix.get(10, 10)).toBe(1);
    expect(matrix.get(30, 30)).toBe(0);
    expect(matrix.get(31, 31)).toBe(0xff);
    expect(matrix.get(12, 12)).toBe(0);
  });

  it("Portal 默认阻挡，显式 allowPortalTarget 时目标格恢复可进入且不重建静态缓存", () => {
    const harness = setupStaticRoom();
    harness.structures.push(makeStructure(STRUCTURE_PORTAL, 15, 10));
    const creep = createCreep("traveler", "worker", 10, 10, harness.room);
    harness.creeps.push(creep);
    Game.creeps[creep.name] = creep;
    const getCaptured = wireFindPathCapture(creep);

    const portalPos = new MockRoomPosition(15, 10, ROOM_NAME) as unknown as RoomPosition;
    moveToTarget(creep, portalPos, 0, { reusePath: 0 });
    expect(getCaptured()?.get(15, 10)).toBe(0xff);

    const buildsAfterFirst = getRoomBaseCostMatrixBuildCountForTest();
    moveToTarget(creep, portalPos, 0, { reusePath: 0, allowPortalTarget: true });
    expect(getCaptured()?.get(15, 10)).toBe(0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(buildsAfterFirst);
  });

  it("跨 tick 复用缓存矩阵后 Source/Portal 静态障碍仍存在", () => {
    const harness = setupStaticRoom();
    harness.structures.push(makeStructure(STRUCTURE_PORTAL, 20, 20));
    harness.sources.push(makeNatural<Source>(12, 10));
    const creep = createCreep("mover", "worker", 10, 10, harness.room);
    harness.creeps.push(creep);
    Game.creeps[creep.name] = creep;
    const getCaptured = wireFindPathCapture(creep);

    const target = new MockRoomPosition(15, 10, ROOM_NAME) as unknown as RoomPosition;
    moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(getCaptured()?.get(12, 10)).toBe(0xff);
    expect(getCaptured()?.get(20, 20)).toBe(0xff);
    const buildsAfterFirstTick = getRoomBaseCostMatrixBuildCountForTest();

    Game.time += 1;
    moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(buildsAfterFirstTick);
    expect(getCaptured()?.get(12, 10)).toBe(0xff);
    expect(getCaptured()?.get(20, 20)).toBe(0xff);
  });

  it("动态 creep 消失后格子恢复为正确的静态成本且不触发重建", () => {
    const harness = setupStaticRoom();
    harness.structures.push(makeStructure(STRUCTURE_ROAD, 12, 10));
    const creep = createCreep("mover", "worker", 10, 10, harness.room);
    const blocker = createCreep("blocker", "worker", 12, 10, harness.room);
    harness.creeps.push(creep, blocker);
    Game.creeps[creep.name] = creep;
    Game.creeps[blocker.name] = blocker;
    const getCaptured = wireFindPathCapture(creep);

    const target = new MockRoomPosition(15, 10, ROOM_NAME) as unknown as RoomPosition;
    moveToTarget(creep, target, 1, { ignoreCreeps: false, reusePath: 0 });
    expect(getCaptured()?.get(12, 10)).toBe(0xfe);
    const buildsAfterFirstTick = getRoomBaseCostMatrixBuildCountForTest();

    Game.time += 1;
    harness.creeps.pop();
    delete Game.creeps[blocker.name];
    moveToTarget(creep, target, 1, { ignoreCreeps: true, reusePath: 0 });
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(buildsAfterFirstTick);
    expect(getCaptured()?.get(12, 10)).toBe(1);
  });

  it("Deposit 出现/消失改变拓扑指纹并触发矩阵重建", () => {
    const harness = setupStaticRoom();
    const creep = createCreep("mover", "worker", 10, 10, harness.room);
    harness.creeps.push(creep);
    Game.creeps[creep.name] = creep;
    const getCaptured = wireFindPathCapture(creep);

    const target = new MockRoomPosition(15, 10, ROOM_NAME) as unknown as RoomPosition;
    moveToTarget(creep, target, 1, { reusePath: 0 });
    const initialBuilds = getRoomBaseCostMatrixBuildCountForTest();
    expect(getCaptured()?.get(7, 7)).toBe(0);

    Game.time += 1;
    harness.deposits.push(makeNatural<Deposit>(7, 7));
    moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(initialBuilds + 1);
    expect(getCaptured()?.get(7, 7)).toBe(0xff);

    Game.time += 1;
    harness.deposits.pop();
    moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(initialBuilds + 2);
    expect(getCaptured()?.get(7, 7)).toBe(0);
  });
});
