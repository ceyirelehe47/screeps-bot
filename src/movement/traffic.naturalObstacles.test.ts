/**
 * 交通让位候选的完整不可通行对象测试。
 *
 * 覆盖：
 * - pushBlockingCreep / moveOffExit 绝不把 creep 推上 Portal、Source、
 *   Mineral、Deposit、Controller；
 * - Road、Container 与可通行 Rampart 仍是合法让位候选；
 * - 全部候选被自然障碍占据时 fail closed（ERR_NO_PATH）。
 *
 * 注意：主动跨 shard 进入 Portal 由 crossShardTravel 经 allowPortalTarget
 * 显式控制，其覆盖见 staticRoomMatrix.test.ts 的 Portal 豁免用例。
 */
import { clearTrafficNaturalObstacleCacheForTest, moveOffExit, pushBlockingCreep } from "@/movement/traffic";

jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
}));

import { getTickContextService } from "@/runtime/runtimeServices";

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getDirectionTo(target: RoomPosition): DirectionConstant {
    const dx = Math.sign(target.x - this.x);
    const dy = Math.sign(target.y - this.y);
    if (dx === 0 && dy === -1) return TOP;
    if (dx === 1 && dy === -1) return TOP_RIGHT;
    if (dx === 1 && dy === 0) return RIGHT;
    if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
    if (dx === 0 && dy === 1) return BOTTOM;
    if (dx === -1 && dy === 1) return BOTTOM_LEFT;
    if (dx === -1 && dy === 0) return LEFT;
    return TOP_LEFT;
  }
}

function makeCreep(name: string, x: number, y: number, roomName = "W1N1") {
  const pos = new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
  return {
    name,
    pos,
    room: { name: roomName } as Room,
    move: jest.fn(() => OK),
    memory: {},
  } as unknown as Creep;
}

function makeStructure(
  structureType: StructureConstant,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): Structure<StructureConstant> {
  return {
    structureType,
    pos: new MockRoomPosition(x, y, "W1N1") as unknown as RoomPosition,
    ...extra,
  } as Structure<StructureConstant>;
}

function makeNatural(x: number, y: number): { pos: RoomPosition } {
  return { pos: new MockRoomPosition(x, y, "W1N1") as unknown as RoomPosition };
}

interface RoomContextSeed {
  creeps?: Creep[];
  structures?: Structure<StructureConstant>[];
  sources?: Array<{ pos: RoomPosition }>;
  minerals?: Array<{ pos: RoomPosition }>;
  deposits?: Array<{ pos: RoomPosition }>;
  controllerPos?: RoomPosition;
}

function setupRoomContext(seed: RoomContextSeed = {}): void {
  (getTickContextService as jest.Mock).mockReturnValue({
    getRoomContext: jest.fn(() => ({
      room: {
        name: "W1N1",
        controller: seed.controllerPos ? { my: true, pos: seed.controllerPos } : undefined,
      },
      getMyCreeps: jest.fn(() => seed.creeps ?? []),
      getStructures: jest.fn(() => seed.structures ?? []),
      getConstructionSites: jest.fn(() => []),
      getSources: jest.fn(() => seed.sources ?? []),
      getMinerals: jest.fn(() => seed.minerals ?? []),
      getDeposits: jest.fn(() => seed.deposits ?? []),
    })),
  });
}

function setupTerrain(walls: Array<[number, number]>): void {
  const wallSet = new Set(walls.map(([x, y]) => y * 50 + x));
  Object.assign(Game, {
    map: {
      getRoomTerrain: jest.fn(() => ({
        get: (x: number, y: number) => (wallSet.has(y * 50 + x) ? TERRAIN_MASK_WALL : 0),
      })),
    },
  });
}

describe("traffic yield tiles with full natural obstacles", () => {
  beforeEach(() => {
    Game.powerCreeps = {};
    // 自然障碍索引按 tick 缓存；测试环境的 Game.time 会重置，必须显式清理。
    clearTrafficNaturalObstacleCacheForTest();
    Object.assign(global, { RoomPosition: MockRoomPosition });
    setupTerrain([]);
  });

  it("pushBlockingCreep never pushes a blocker onto a Portal", () => {
    const pusher = makeCreep("pusher", 9, 10);
    const blocker = makeCreep("blocker", 10, 10);
    // 除 Portal 格 (11,10) 与空地 (10,11) 外全是 terrain wall。
    setupTerrain([[9, 9], [10, 9], [11, 9], [9, 10], [9, 11], [11, 11]]);
    setupRoomContext({
      creeps: [pusher, blocker],
      structures: [makeStructure(STRUCTURE_PORTAL, 11, 10)],
    });

    const pushed = pushBlockingCreep(pusher, blocker);

    expect(pushed).toBe(true);
    expect(blocker.move).toHaveBeenCalledWith(BOTTOM);
    expect(blocker.move).not.toHaveBeenCalledWith(RIGHT);
  });

  it("moveOffExit never selects a Portal tile", () => {
    const creep = makeCreep("exit-blocked", 49, 25);
    setupRoomContext({ structures: [makeStructure(STRUCTURE_PORTAL, 48, 25)] });

    const result = moveOffExit(creep);

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(BOTTOM_LEFT);
    expect(creep.move).not.toHaveBeenCalledWith(LEFT);
  });

  it("moveOffExit fails closed when only Portal and natural obstacles surround the exit tile", () => {
    const creep = makeCreep("exit-blocked", 49, 25);
    setupRoomContext({
      structures: [makeStructure(STRUCTURE_PORTAL, 48, 25)],
      sources: [makeNatural(48, 24)],
      minerals: [makeNatural(48, 26)],
      controllerPos: new MockRoomPosition(47, 25, "W1N1") as unknown as RoomPosition,
    });

    const result = moveOffExit(creep);

    expect(result).toBe(ERR_NO_PATH);
    expect(creep.move).not.toHaveBeenCalled();
  });

  it("Source, Mineral, Deposit and Controller are never selected as yield targets", () => {
    const pusher = makeCreep("pusher", 9, 10);
    const blocker = makeCreep("blocker", 10, 10);
    // 8 个邻格：(10,11)=Source、(11,10)=Mineral、(9,10)=Deposit、(10,9)=
    // Controller，其余 4 角 terrain wall。
    setupTerrain([[9, 9], [11, 9], [9, 11], [11, 11]]);
    setupRoomContext({
      creeps: [pusher, blocker],
      sources: [makeNatural(10, 11)],
      minerals: [makeNatural(11, 10)],
      deposits: [makeNatural(9, 10)],
      controllerPos: new MockRoomPosition(10, 9, "W1N1") as unknown as RoomPosition,
    });

    const pushed = pushBlockingCreep(pusher, blocker);

    expect(pushed).toBe(false);
    expect(blocker.move).not.toHaveBeenCalled();
  });

  it("Road, Container and walkable rampart remain valid yield candidates", () => {
    const pusher = makeCreep("pusher", 9, 10);
    const blocker = makeCreep("blocker", 10, 10);
    setupTerrain([[9, 9], [10, 9], [11, 9], [9, 11], [11, 11]]);
    setupRoomContext({
      creeps: [pusher, blocker],
      structures: [
        makeStructure(STRUCTURE_ROAD, 10, 11),
        makeStructure(STRUCTURE_CONTAINER, 11, 10),
        makeStructure(STRUCTURE_RAMPART, 9, 10, { my: true, isPublic: false }),
      ],
    });

    const pushed = pushBlockingCreep(pusher, blocker);

    expect(pushed).toBe(true);
    expect(blocker.move).toHaveBeenCalled();
    const directions = (blocker.move as jest.Mock).mock.calls.map((call) => call[0]);
    expect(directions).toContain(LEFT);
    expect(directions.every((direction) => direction === LEFT || direction === BOTTOM || direction === RIGHT)).toBe(true);
  });
});
