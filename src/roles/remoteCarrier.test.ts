import { remoteCarrierRole, isInvaderSalvageRoomClear } from "@/roles/remoteCarrier";
import { moveToTargetRoom } from "@/roles/shared";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";

jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));
jest.mock("@/movement/routing", () => {
  class Matrix {
    cells = new Map<string, number>();
    get(x: number, y: number): number { return this.cells.get(`${x}:${y}`) ?? 0; }
    set(x: number, y: number, cost: number): void { this.cells.set(`${x}:${y}`, cost); }
    clone(): Matrix { const value = new Matrix(); value.cells = new Map(this.cells); return value; }
  }
  return { getCachedStaticTravelMatrix: jest.fn(() => new Matrix()) };
});

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  Game.time += 1;
  Game.rooms = {};
  Game.creeps = {};
  Memory.runtime = undefined;
  Memory.data = undefined;
  clearMarketActionArbiterForTest();
  clearMarketSaleExposureReservationsForTest();
  (Game as Game & { map: GameMap }).map = {
    getRoomLinearDistance: jest.fn(() => 1),
    findRoute: jest.fn(() => [{ room: "W4N5", exit: FIND_EXIT_LEFT }] as ReturnType<GameMap["findRoute"]>),
  } as unknown as GameMap;
  (global as typeof global & { RoomPosition: typeof RoomPosition }).RoomPosition = class RoomPositionMock {
    public constructor(
      public x: number,
      public y: number,
      public roomName: string,
    ) {}
  } as typeof RoomPosition;
  (global as typeof global & { PathFinder: typeof PathFinder }).PathFinder = {
    search: jest.fn(() => ({
      path: Array.from({ length: 42 }, (_, index) => ({ x: index % 50, y: 25, roomName: "W5N5" })),
      ops: 42,
      cost: 42,
      incomplete: false,
    })),
  } as unknown as typeof PathFinder;
});

function createStore(resources: Partial<Record<ResourceConstant, number>>, capacity = 800): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: (resource?: ResourceConstant) => {
      if (resource === undefined) {
        return Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
      }

      return resources[resource] || 0;
    },
    getFreeCapacity: () => capacity - Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0),
  } as unknown as StoreDefinition;
}



function createHomeRoom(name: string, storageX = 10, storageY = 20): Room {
  const room = {
    name,
    storage: {
      pos: { x: storageX, y: storageY, roomName: name } as RoomPosition,
      store: createStore({}, 100000),
    } as StructureStorage,
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

describe("remoteCarrierRole", () => {

  function salvageFixture(objects: { drops?: Resource[]; tombstones?: Tombstone[]; structures?: Structure[]; hostiles?: Creep[]; escorts?: Creep[] } = {}) {
    const home = createHomeRoom("W1N1");
    const room = {
      name: "W5N5",
      find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? objects.structures ?? []
        : type === FIND_DROPPED_RESOURCES ? objects.drops ?? []
          : type === FIND_TOMBSTONES ? objects.tombstones ?? []
            : type === FIND_HOSTILE_CREEPS ? objects.hostiles ?? []
              : type === FIND_MY_CREEPS ? objects.escorts ?? [] : []),
    } as unknown as Room;
    Game.rooms[room.name] = room;
    const configName = "W1N1:haul:W5N5:carrier:HAUL_W1N1_INVADER_W5N5";
    Memory.data = { creepConfigs: { [configName]: { role: "remoteCarrier", args: ["W5N5", "44,17", "invaderSalvage"], roomName: "W1N1" } } };
    const resources: Partial<Record<ResourceConstant, number>> = { energy: 0, XUH2O: 0 };
    const creep = {
      name: "salvage-carrier", room, pos: { x: 20, y: 20, roomName: room.name },
      memory: { role: "remoteCarrier", configName }, store: createStore(resources),
      withdraw: jest.fn(() => OK), pickup: jest.fn(() => OK), transfer: jest.fn(() => OK),
      move: jest.fn(() => OK), suicide: jest.fn(),
    } as unknown as Creep;
    Game.creeps[creep.name] = creep;
    return { home, room, creep, resources, role: remoteCarrierRole("W5N5", "44,17", "invaderSalvage") };
  }

  it("INVADER 拾取掉落与墓碑全部资源，取货/归仓只按次 tick Store 完成", () => {
    const drops = [{ amount: 50, resourceType: RESOURCE_CATALYZED_UTRIUM_ACID,
      pos: { x: 21, y: 20, roomName: "W5N5" } } as Resource];
    const tombResources = { energy: 100 };
    const tombstones = [{ store: createStore(tombResources), pos: { x: 22, y: 20, roomName: "W5N5" } } as Tombstone];
    const world = salvageFixture({ drops, tombstones });
    Object.assign(world.creep, {
      pickup: jest.fn(() => { world.resources.XUH2O = drops[0].amount; Object.assign(drops[0], { amount: 0 }); return OK; }),
      withdraw: jest.fn(() => { world.resources.energy = 100; tombResources.energy = 0; return OK; }),
      transfer: jest.fn((_target: AnyStoreStructure, resource: ResourceConstant) => { world.resources[resource] = 0; return OK; }),
    });
    Object.assign(world.creep.pos, { getRangeTo: () => 1 });
    expect(world.role.source(world.creep)).toBe(false);
    expect(world.creep.pickup).toHaveBeenCalledWith(drops[0]);
    world.role.source(world.creep);
    expect(world.creep.pickup).toHaveBeenCalledTimes(1);
    Game.time += 1;
    expect(world.role.source(world.creep)).toBe(false);
    expect(world.creep.withdraw).toHaveBeenCalledWith(tombstones[0], RESOURCE_ENERGY);
    Game.time += 1;
    expect(world.role.source(world.creep)).toBe(true);
    Object.assign(world.creep, { room: world.home });
    expect(world.role.target(world.creep)).toBe(false);
    expect(world.role.target(world.creep)).toBe(false);
    expect(world.creep.transfer).toHaveBeenCalledTimes(1);
    Game.time += 1;
    expect(world.role.target(world.creep)).toBe(false);
    Game.time += 1;
    expect(world.role.target(world.creep)).toBe(true);
    expect(world.creep.suicide).not.toHaveBeenCalled();
  });

  it("缺视野、残余 core/敌塔或非 Keeper 战斗时不取货，已有货只切返程", () => {
    for (const threat of ["vision", "core", "tower", "combat"] as const) {
      const structures = threat === "core" ? [{ structureType: STRUCTURE_INVADER_CORE } as Structure]
        : threat === "tower" ? [{ structureType: STRUCTURE_TOWER, my: false } as unknown as Structure] : [];
      const hostiles = threat === "combat" ? [{ owner: { username: "Invader" }, getActiveBodyparts: () => 1 } as unknown as Creep] : [];
      const world = salvageFixture({ structures, hostiles });
      if (threat === "vision") delete Game.rooms[world.room.name];
      expect(isInvaderSalvageRoomClear(Game.rooms[world.room.name])).toBe(false);
      world.role.source(world.creep);
      expect(world.creep.withdraw).not.toHaveBeenCalled();
      expect(world.creep.pickup).not.toHaveBeenCalled();
      world.resources.energy = 100;
      expect(world.role.source(world.creep)).toBe(true);
      expect(world.creep.suicide).not.toHaveBeenCalled();
    }
  });

  it("四只 Keeper 必须逐只避开，缺近距战斗 escort 不取货且下一步不得进入半径 6", () => {
    const position = (x: number, y: number) => ({ x, y, roomName: "W5N5",
      getRangeTo: (other: RoomPosition) => Math.max(Math.abs(x - other.x), Math.abs(y - other.y)) } as RoomPosition);
    const hostiles = [10, 20, 30, 40].map((x) => ({ owner: { username: "Source Keeper" }, pos: position(x, 10) } as Creep));
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    const world = salvageFixture({ drops: [drop], hostiles, escorts: [] });
    world.role.source(world.creep);
    expect(world.creep.pickup).not.toHaveBeenCalled();
    const escort = { pos: position(44, 17), getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 25 : 0 } as Creep;
    (world.room.find as jest.Mock).mockImplementation((type: FindConstant) => type === FIND_HOSTILE_CREEPS ? hostiles
      : type === FIND_MY_CREEPS ? [escort] : type === FIND_DROPPED_RESOURCES ? [drop] : []);
    Object.assign(world.creep, { pos: position(44, 16), pickup: jest.fn(() => ERR_NOT_IN_RANGE) });
    Object.assign(Game.map, { getRoomStatus: jest.fn(() => ({ status: "normal" })) });
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: false, path: [position(43, 15)], ops: 1, cost: 1 });
    world.role.source(world.creep);
    expect(world.creep.pickup).toHaveBeenCalledWith(drop);
    // (43,15) 距第四只 Keeper (40,10) 为 5，其余三只远离也不能豁免。
    expect(world.creep.move).not.toHaveBeenCalled();
    Object.assign(world.creep, { pos: position(43, 15), pickup: jest.fn(() => OK) });
    world.role.source(world.creep);
    expect(world.creep.pickup).not.toHaveBeenCalled();
    Game.time += 1;
    Object.assign(world.creep, { pos: position(44, 19), pickup: jest.fn(() => ERR_NOT_IN_RANGE) });
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: false, path: [position(44, 18)], ops: 1, cost: 1 });
    world.role.source(world.creep);
    expect(world.creep.move).toHaveBeenCalledWith(TOP);
    world.role.source(world.creep);
    expect(PathFinder.search).toHaveBeenCalledTimes(3); // 前 tick 两次拒绝，本 tick 安全一步且同 tick 不重发。
  });

  it("leaves home when lifetime can cover a round trip plus buffer", () => {
    const home = createHomeRoom("W1N1", 11, 20);
    const creep = {
      name: "remote-carrier-1",
      ticksToLive: 134,
      room: home,
      memory: { configName: "W1N1:haul:W5N7:carrier:HAUL" },
      store: createStore({}, 800),
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    const prepared = remoteCarrierRole("W5N7").prepare?.(creep);

    expect(creep.suicide).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W5N7", undefined, { travelRange: 3, reusePath: 10 });
    expect(prepared).toBe(false);
  });

  it("does not suicide while returning with carried resources", () => {
    const creep = {
      name: "remote-carrier-1",
      ticksToLive: 1,
      room: { name: "W5N5" } as Room,
      memory: { configName: "W1N1:haul:W5N5:carrier:HAUL" },
      store: createStore({ [RESOURCE_CATALYZED_UTRIUM_ACID]: 800 }, 800),
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    const delivered = remoteCarrierRole("W5N5").target?.(creep);

    expect(creep.suicide).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { travelRange: 3, reusePath: 10 });
    expect(delivered).toBe(false);
  });
});
