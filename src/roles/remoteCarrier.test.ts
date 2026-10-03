import { remoteCarrierRole, isInvaderSalvageRoomClear, isInvaderSalvagePositionSafe } from "@/roles/remoteCarrier";
import { moveToTargetRoom } from "@/roles/shared";
import { clearRoleLifecycleCacheForTest, mountCreep } from "@/mount/mountCreep";
import { requestCombatObservation } from "@/runtime/powerBankObserver";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";

jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));
jest.mock("@/roles", () => ({ roleRegistry: { remoteCarrier: (...args: string[]) =>
  jest.requireActual("@/roles/remoteCarrier").remoteCarrierRole(...args) } }));
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
  clearMovementState: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(global, { Creep: class CreepMock {} });
  Game.time += 1;
  Game.rooms = {};
  Game.creeps = {};
  Memory.runtime = undefined;
  Memory.data = undefined;
  clearMarketActionArbiterForTest();
  clearMarketSaleExposureReservationsForTest();
  clearRoleLifecycleCacheForTest();
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
    find: jest.fn(() => []),
    storage: {
      pos: { x: storageX, y: storageY, roomName: name } as RoomPosition,
      store: createStore({}, 100000),
    } as StructureStorage,
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

describe("remoteCarrierRole", () => {

  function salvageFixture(objects: { drops?: Resource[]; tombstones?: Tombstone[]; structures?: Structure[]; hostiles?: Creep[]; escorts?: Creep[]; homeRoomName?: string } = {}) {
    const home = createHomeRoom(objects.homeRoomName ?? "W1N1");
    const room = {
      name: "W5N5",
      find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? objects.structures ?? []
        : type === FIND_DROPPED_RESOURCES ? objects.drops ?? []
          : type === FIND_TOMBSTONES ? objects.tombstones ?? []
            : type === FIND_HOSTILE_CREEPS ? objects.hostiles ?? []
              : type === FIND_MY_CREEPS ? objects.escorts ?? [] : []),
    } as unknown as Room;
    Game.rooms[room.name] = room;
    const configName = `${home.name}:haul:W5N5:carrier:HAUL_${home.name}_INVADER_W5N5`;
    Memory.data = { creepConfigs: { [configName]: { role: "remoteCarrier", args: ["W5N5", "44,17", "invaderSalvage"], roomName: home.name } } };
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

  it.each(["keeper", "lair"] as const)("无 escort 的安全位可取货，%s 距离 5 仍逐只拒绝", (kind) => {
    const position = (x: number, y: number) => ({ x, y, roomName: "W5N5",
      getRangeTo: (other: RoomPosition) => Math.max(Math.abs(x - other.x), Math.abs(y - other.y)) } as RoomPosition);
    const hazards = [10, 20, 30, 40].map((x) => position(x, 10));
    const hostiles = kind === "keeper" ? hazards.map((pos) => ({ owner: { username: "Source Keeper" }, pos } as Creep)) : [];
    const structures = kind === "lair" ? hazards.map((pos) => ({ structureType: STRUCTURE_KEEPER_LAIR, pos } as StructureKeeperLair)) : [];
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 16) } as Resource;
    const world = salvageFixture({ drops: [drop], hostiles, structures, escorts: [] });
    Object.assign(world.creep, { pos: position(44, 17) });
    world.role.source(world.creep);
    expect(world.creep.pickup).toHaveBeenCalledWith(drop);
    for (const hazard of hazards) {
      Game.time += 1;
      (world.creep.pickup as jest.Mock).mockClear();
      Object.assign(drop, { pos: position(hazard.x, hazard.y + 5) });
      expect(isInvaderSalvagePositionSafe(world.room, drop.pos)).toBe(false);
      world.role.source(world.creep);
      expect(world.creep.pickup).not.toHaveBeenCalled();
      expect(world.creep.move).not.toHaveBeenCalled();
    }
    expect(isInvaderSalvagePositionSafe(world.room, position(44, 16))).toBe(true);
    Game.time += 1;
    (world.creep.pickup as jest.Mock).mockClear();
    Object.assign(drop, { pos: position(44, 16) });
    Object.assign(world.creep, { pos: position(40, 15) });
    Game.map.getRoomStatus = jest.fn(() => ({ status: "normal" as const, timestamp: null }));
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: true, path: [], ops: 1, cost: 1 });
    world.role.source(world.creep);
    expect(world.creep.pickup).not.toHaveBeenCalled();
    world.resources.energy = 50;
    expect(world.role.source(world.creep)).toBe(true);
    expect(world.creep.suicide).not.toHaveBeenCalled();
    const currentRoom = Game.rooms[world.room.name];
    delete Game.rooms[world.room.name];
    expect(isInvaderSalvagePositionSafe(currentRoom, position(44, 16))).toBe(false);
  });

  it.each(["jump", "wrong_goal", "unsafe_middle", "incomplete"] as const)("INVADER 完整路径的 %s 证据失败时不发布一步", (failure) => {
    const position = (x: number, y: number) => new RoomPosition(x, y, "W5N5");
    const keeper = { owner: { username: "Source Keeper" }, pos: position(40, 10) } as Creep;
    const lair = { structureType: STRUCTURE_KEEPER_LAIR, pos: position(30, 10) } as StructureKeeperLair;
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    const world = salvageFixture({ drops: [drop], hostiles: [keeper], structures: [lair] });
    Object.assign(world.creep, { pos: position(44, 19), pickup: jest.fn(() => ERR_NOT_IN_RANGE) });
    Game.map.getRoomStatus = jest.fn(() => ({ status: "normal" as const, timestamp: null }));
    const path = failure === "jump" ? [position(44, 17)]
      : failure === "wrong_goal" ? [position(44, 20)]
        : failure === "unsafe_middle" ? [position(44, 18), position(43, 17), position(43, 16), position(43, 15), position(44, 16)]
          : [position(44, 18)];
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: failure === "incomplete", path, ops: 1, cost: 1 });
    world.role.source(world.creep);
    expect(world.creep.move).not.toHaveBeenCalled();
    expect(PathFinder.search).toHaveBeenCalledWith(world.creep.pos, { pos: drop.pos, range: 1 },
      expect.objectContaining({ maxOps: 6_000, maxRooms: 16 }));
  });

  it("INVADER 未知未来房间仅为几何路径，跨房下一步需 fresh 视野再放行", () => {
    const position = (x: number, roomName: string) => new RoomPosition(x, 18, roomName);
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource;
    const world = salvageFixture({ drops: [drop], homeRoomName: "W3N5" });
    Object.assign(world.creep, { room: world.home, pos: position(2, "W3N5") });
    Game.map.getRoomStatus = jest.fn(() => ({ status: "normal" as const, timestamp: null }));
    const frontierPath = [...Array.from({ length: 50 }, (_, index) => position(49 - index, "W4N5")),
      ...Array.from({ length: 6 }, (_, index) => position(49 - index, "W5N5"))];
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: false,
      path: [position(1, "W3N5"), position(0, "W3N5"), ...frontierPath], ops: 1, cost: 1 });
    world.role.source(world.creep);
    expect(world.creep.move).toHaveBeenCalledWith(LEFT);
    expect(Game.rooms.W4N5).toBeUndefined();
    Game.time += 1;
    (world.creep.move as jest.Mock).mockClear();
    Object.assign(world.creep, { pos: position(0, "W3N5") });
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: false, path: frontierPath, ops: 1, cost: 1 });
    world.role.source(world.creep);
    expect(world.creep.move).not.toHaveBeenCalled();
    expect(requestCombatObservation).toHaveBeenCalledWith("W4N5");
    Game.time += 1;
    Game.rooms.W4N5 = { name: "W4N5", find: jest.fn(() => []) } as unknown as Room;
    world.role.source(world.creep);
    expect(world.creep.move).toHaveBeenCalledWith(LEFT);
    for (const hazard of ["keeper", "lair", "core"] as const) {
      Game.time += 1;
      (world.creep.move as jest.Mock).mockClear();
      Game.rooms.W4N5 = { name: "W4N5", find: jest.fn((type: FindConstant) => {
        if (type === FIND_HOSTILE_CREEPS && hazard === "keeper") {
          return [{ owner: { username: "Source Keeper" }, pos: position(49, "W4N5") }];
        }
        if (type === FIND_STRUCTURES && hazard !== "keeper") {
          return [{ structureType: hazard === "lair" ? STRUCTURE_KEEPER_LAIR : STRUCTURE_INVADER_CORE,
            pos: position(49, "W4N5") }];
        }
        return [];
      }) } as unknown as Room;
      world.role.source(world.creep);
      expect(world.creep.move).not.toHaveBeenCalled();
    }
  });

  it("INVADER 无 escort 的 mounted 安全走近、次 tick 取货、跨房返仓与卸货闭环", () => {
    const position = (x: number, y: number, roomName = "W5N5") => new RoomPosition(x, y, roomName);
    const keeper = { owner: { username: "Source Keeper" }, pos: position(40, 10) } as Creep;
    const lair = { structureType: STRUCTURE_KEEPER_LAIR, pos: position(30, 10) } as StructureKeeperLair;
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    const world = salvageFixture({ drops: [drop], hostiles: [keeper], structures: [lair], homeRoomName: "W4N5" });
    Object.assign(world.home.storage!, { pos: position(1, 18, world.home.name) });
    Object.assign(world.creep, { pos: position(44, 19), memory: { ...world.creep.memory, ready: true, working: false },
      pickup: jest.fn() });
    // RoomPosition mock 的实际坐标决定 intent 返回；OK 后 Store 仍等下一 tick。
    (world.creep.pickup as jest.Mock).mockImplementation(() =>
      Math.max(Math.abs(world.creep.pos.x - drop.pos.x), Math.abs(world.creep.pos.y - drop.pos.y)) <= 1 ? OK : ERR_NOT_IN_RANGE);
    Game.map.getRoomStatus = jest.fn(() => ({ status: "normal" as const, timestamp: null }));
    (PathFinder.search as jest.Mock).mockImplementation((origin: RoomPosition, goal: { pos: RoomPosition }) => {
      const path = goal.pos.roomName === "W5N5" ? [position(44, 18)]
        : [...Array.from({ length: 49 - origin.x }, (_, index) => position(origin.x + index + 1, 18)),
          ...Array.from({ length: 6 }, (_, index) => position(index, 18, "W4N5"))];
      return { incomplete: false, path, ops: 1, cost: 1 };
    });
    mountCreep();
    const work = (): void => { Creep.prototype.work.call(world.creep); };
    work();
    expect(world.creep.move).toHaveBeenLastCalledWith(TOP);
    Game.time += 1;
    Object.assign(world.creep, { pos: position(44, 18) });
    work();
    expect(world.creep.pickup).toHaveBeenCalledTimes(2);
    expect(world.creep.store.getUsedCapacity()).toBe(0);
    work();
    expect(world.creep.pickup).toHaveBeenCalledTimes(2);
    Game.time += 1;
    world.resources.energy = 50;
    Object.assign(drop, { amount: 0 });
    work();
    expect(world.creep.memory.working).toBe(true);
    expect(world.creep.move).toHaveBeenLastCalledWith(RIGHT);
    for (let x = 45; x <= 49; x += 1) {
      Game.time += 1;
      Object.assign(world.creep, { pos: position(x, 18) });
      work();
      expect(world.creep.move).toHaveBeenLastCalledWith(RIGHT);
    }
    Game.time += 1;
    Object.assign(world.creep, { room: world.home, pos: position(0, 18, world.home.name) });
    work();
    expect(world.creep.transfer).toHaveBeenCalledTimes(1);
    expect(world.creep.store.getUsedCapacity()).toBe(50);
    work();
    expect(world.creep.transfer).toHaveBeenCalledTimes(1);
    Game.time += 1;
    world.resources.energy = 0;
    work();
    expect(world.creep.memory.working).toBe(false);
    expect(world.creep.suicide).not.toHaveBeenCalled();
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
