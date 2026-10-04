import { remoteCarrierRole, isInvaderSalvageRoomClear, isInvaderSalvagePositionSafe } from "@/roles/remoteCarrier";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
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

  it("INVADER 走近资源委托共用寻路，禁区策略拒绝Keeper与巢穴附近下一步", () => {
    const position = (x: number, y: number, roomName = "W5N5") => new RoomPosition(x, y, roomName);
    const keeper = { owner: { username: "Source Keeper" }, pos: position(40, 10) } as Creep;
    const lair = { structureType: STRUCTURE_KEEPER_LAIR, pos: position(30, 10) } as StructureKeeperLair;
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    const world = salvageFixture({ drops: [drop], hostiles: [keeper], structures: [lair] });
    Object.assign(world.creep, { pos: position(44, 19), pickup: jest.fn(() => ERR_NOT_IN_RANGE) });
    world.role.source(world.creep);
    expect(moveToTarget).toHaveBeenCalledWith(world.creep, drop.pos, 1, expect.objectContaining({ costCallback: expect.any(Function), canMoveStep: expect.any(Function) }));
    const options = (moveToTarget as jest.Mock).mock.calls[0][3];
    expect(options.canMoveStep(position(44, 18))).toBe(true);
    expect(options.canMoveStep(position(40, 15))).toBe(false);
    expect(options.canMoveStep(position(30, 15))).toBe(false);
    const costs = new Map<string, number>();
    const matrix = { set: (x: number, y: number, value: number) => costs.set(`${x}:${y}`, value) };
    options.costCallback("W5N5", matrix);
    expect(costs.get("40:15")).toBe(255); expect(costs.get("30:15")).toBe(255);
    expect(PathFinder.search).not.toHaveBeenCalled();
    expect(world.creep.move).not.toHaveBeenCalled();
  });

  it("INVADER 跨房委托共用路由，未知或危险下一房没有放行许可", () => {
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource;
    const world = salvageFixture({ drops: [drop], homeRoomName: "W4N5" });
    Object.assign(world.creep, { room: world.home, pos: new RoomPosition(48, 18, "W4N5") });
    world.role.source(world.creep);
    expect(moveToTargetRoom).toHaveBeenCalledWith(world.creep, "W5N5", undefined, expect.objectContaining({ canMoveStep: expect.any(Function) }));
    const options = (moveToTargetRoom as jest.Mock).mock.calls[0][3];
    expect(options.canMoveStep(new RoomPosition(0, 18, "W3N5"))).toBe(false);
    expect(requestCombatObservation).toHaveBeenCalledWith("W3N5");
    expect(options.canMoveStep(new RoomPosition(0, 18, "W5N5"))).toBe(true);
    const previous = world.room.find;
    world.room.find = jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? [{ structureType: STRUCTURE_INVADER_CORE, pos: drop.pos }] : [] ) as Room["find"];
    expect(options.canMoveStep(new RoomPosition(0, 18, "W5N5"))).toBe(true);
    world.room.find = previous;
    expect(PathFinder.search).not.toHaveBeenCalled();
  });

  it("目标与下一房交替可见时逐房放行，不要求两房同帧可见或清空通路", () => {
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource;
    const world = salvageFixture({ drops: [drop] });
    const transit = { name: "W4N5", find: jest.fn(() => []) } as unknown as Room;
    Game.rooms[transit.name] = transit; Object.assign(world.creep, { room: transit, pos: new RoomPosition(1, 21, transit.name) });
    expect(world.role.source(world.creep)).toBe(false);
    const next = { name: "W3N5", find: jest.fn(() => []) } as unknown as Room;
    const entry = new RoomPosition(49, 21, next.name);
    const first = (moveToTargetRoom as jest.Mock).mock.calls[0][3];
    expect(first.canMoveStep(entry)).toBe(false);
    expect(requestCombatObservation).toHaveBeenCalledWith(next.name);
    Game.time++; delete Game.rooms[world.room.name]; Game.rooms[next.name] = next;
    world.role.source(world.creep);
    expect(moveToTargetRoom).toHaveBeenCalledTimes(2);
    expect(moveToTargetRoom).toHaveBeenCalledWith(world.creep, world.room.name, undefined, expect.any(Object));
    const second = (moveToTargetRoom as jest.Mock).mock.calls[1][3];
    expect(second.canMoveStep(entry)).toBe(true);
    expect(second.canMoveStep(new RoomPosition(0, 21, world.room.name))).toBe(false);
    next.find = jest.fn((type: FindConstant) => type === FIND_HOSTILE_CREEPS
      ? [{ owner: { username: "Invader" }, getActiveBodyparts: () => 1 }] : []) as Room["find"];
    expect(second.canMoveStep(entry)).toBe(false);
    expect(clearMovementState).not.toHaveBeenCalled();
    expect(world.creep.withdraw).not.toHaveBeenCalled();
  });

  it("三个回收成员轮转使用两次寻路预算，固定执行顺序不会饿死第三只", () => {
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource;
    const world = salvageFixture({ drops: [drop] });
    world.creep.pickup = jest.fn(() => ERR_NOT_IN_RANGE);
    const actors = ["a", "b", "c"].map((name) => ({ ...world.creep, name, memory: { ...world.creep.memory }, pickup: jest.fn(() => ERR_NOT_IN_RANGE) } as Creep));
    Game.creeps = Object.fromEntries(actors.map((creep) => [creep.name, creep]));
    const calls = new Map<string, number>();
    for (let frame = 0; frame < 3; frame++) {
      Game.time++; (moveToTarget as jest.Mock).mockClear();
      for (const actor of actors) world.role.source(actor);
      expect(moveToTarget).toHaveBeenCalledTimes(2);
      for (const [actor] of (moveToTarget as jest.Mock).mock.calls) calls.set(actor.name, (calls.get(actor.name) ?? 0) + 1);
    }
    expect([...calls.values()]).toEqual([2, 2, 2]);
  });

  it("已确认过路房有敌塔时失去视野仍绕行，fresh 清空后解除，未知房不被误禁", () => {
    const world = salvageFixture({ drops: [{ amount: 50, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource] });
    Object.assign(world.creep, { room: world.home, pos: new RoomPosition(10, 10, world.home.name) });
    const unsafe = { name: "W4N5", find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? [{ structureType: STRUCTURE_TOWER, my: false }] : []) } as unknown as Room;
    Game.rooms[unsafe.name] = unsafe;
    world.role.source(world.creep);
    const first = (moveToTargetRoom as jest.Mock).mock.calls[0][3];
    expect(first.avoidRooms).toContain(unsafe.name);
    expect(first.avoidRooms).not.toContain("W3N5");
    expect(first.routeRoomCost).toEqual(expect.any(Function));
    Game.time++; delete Game.rooms[unsafe.name];
    world.role.source(world.creep);
    expect((moveToTargetRoom as jest.Mock).mock.calls[1][3].avoidRooms).toContain(unsafe.name);
    Game.time++; unsafe.find = jest.fn(() => []) as Room["find"]; Game.rooms[unsafe.name] = unsafe;
    world.role.source(world.creep);
    expect((moveToTargetRoom as jest.Mock).mock.calls[2][3].avoidRooms).not.toContain(unsafe.name);
    expect(clearMovementState).not.toHaveBeenCalled();
  });

  it("Observer 缺视野暂停生产配置后，已出发成员仍沿受管任务前进，不反复返家", () => {
    const world = salvageFixture();
    const configName = world.creep.memory.configName!;
    const flagName = "HAUL_W1N1_INVADER_W5N5";
    Game.flags = { [flagName]: { name: flagName } as Flag };
    Memory.data!.flagHauling = { [flagName]: { flagName, sourceRoom: world.home.name, targetRoom: world.room.name,
      targetX: 44, targetY: 17, createdAt: Game.time, updatedAt: Game.time } };
    delete Memory.data!.creepConfigs![configName].roomName;
    delete Game.rooms[world.room.name];
    Object.assign(world.creep, { room: world.home, pos: new RoomPosition(10, 10, world.home.name) });
    expect(world.role.source(world.creep)).toBe(false);
    expect(moveToTargetRoom).toHaveBeenCalledWith(world.creep, world.room.name, undefined, expect.any(Object));
    Game.time++; Game.flags = {};
    expect(world.role.source(world.creep)).toBe(false);
    expect(moveToTargetRoom).toHaveBeenCalledTimes(1);
  });

  it("单 Core 过路房可用，并移除上一版本留下的整房禁行记录", () => {
    const world = salvageFixture({ drops: [{ amount: 239, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource] });
    Object.assign(world.creep, { room: world.home, pos: new RoomPosition(10, 10, world.home.name) });
    Game.rooms.W4N5 = { name: "W4N5", controller: { reservation: { username: "Invader" } },
      find: (type: FindConstant) => type === FIND_STRUCTURES ? [{ structureType: STRUCTURE_INVADER_CORE }] : [] } as unknown as Room;
    Memory.runtime = { invaderSalvageDangerRooms: { W4N5: Game.time + 500 } };
    world.role.source(world.creep);
    const options = (moveToTargetRoom as jest.Mock).mock.calls[0][3];
    expect(options.avoidRooms).not.toContain("W4N5");
    expect(options.routeRoomCost("W4N5")).toBe(1);
  });

  it("Keeper 房允许规划但仍受位置禁区限制；敌方所有权失去视野继续绕行", () => {
    const world = salvageFixture({ drops: [{ amount: 50, resourceType: RESOURCE_ENERGY, pos: new RoomPosition(44, 17, "W5N5") } as Resource] });
    Object.assign(world.creep, { room: world.home, pos: new RoomPosition(10, 10, world.home.name) });
    const keeper = { owner: { username: "Source Keeper" }, pos: new RoomPosition(45, 20, "W4N5"), getActiveBodyparts: () => 1 } as unknown as Creep;
    const transit = { name: "W4N5", find: jest.fn((type: FindConstant) => type === FIND_HOSTILE_CREEPS ? [keeper] : []) } as unknown as Room;
    const owned = { name: "W3N5", controller: { owner: { username: "enemy" }, my: false }, find: jest.fn(() => []) } as unknown as Room;
    Game.rooms[transit.name] = transit; Game.rooms[owned.name] = owned;
    world.role.source(world.creep);
    const options = (moveToTargetRoom as jest.Mock).mock.calls[0][3];
    expect(options.avoidRooms).not.toContain(transit.name);
    expect(options.avoidRooms).toContain(owned.name);
    expect(options.canMoveStep(new RoomPosition(49, 20, transit.name))).toBe(false);
    expect(options.canMoveStep(new RoomPosition(49, 30, transit.name))).toBe(true);
    expect(options.canMoveStep(new RoomPosition(49, 30, owned.name))).toBe(false);
    Game.map.describeExits = jest.fn(() => ({ [LEFT]: transit.name }));
    const costs = new Map<string, number>();
    options.costCallback(world.home.name, { set: (x: number, y: number, cost: number) => costs.set(`${x}:${y}`, cost) });
    expect(costs.get("0:20")).toBe(255);
    expect(costs.get("0:30")).toBeUndefined();
    Game.time++; delete Game.rooms[owned.name]; world.role.source(world.creep);
    expect((moveToTargetRoom as jest.Mock).mock.calls[1][3].avoidRooms).toContain(owned.name);
    Game.time += 501; delete Game.rooms[transit.name];
    Memory.runtime!.invaderSalvageDangerRooms = { W2N5: Game.time - 1 };
    world.role.source(world.creep);
    expect((moveToTargetRoom as jest.Mock).mock.calls[2][3].avoidRooms).not.toContain("W2N5");
  });

  it("INVADER mounted走近、取货、归仓卸货使用同一移动入口与真实Store相位", () => {
    const position = (x: number, y: number, roomName = "W5N5") => new RoomPosition(x, y, roomName);
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    const world = salvageFixture({ drops: [drop], homeRoomName: "W4N5" });
    Object.assign(world.home.storage!, { pos: position(1, 18, "W4N5") });
    Object.assign(world.creep, { pos: position(44, 19), memory: { ...world.creep.memory, ready: true, working: false } });
    (world.creep.pickup as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);
    mountCreep();
    const work = (): void => { Creep.prototype.work.call(world.creep); };
    work();
    expect(moveToTarget).toHaveBeenCalledWith(world.creep, drop.pos, 1, expect.any(Object));
    Game.time += 1; Object.assign(world.creep, { pos: position(44, 18) });
    (world.creep.pickup as jest.Mock).mockReturnValue(OK);
    work(); work();
    expect(world.creep.pickup).toHaveBeenCalledTimes(2);
    expect(world.creep.store.getUsedCapacity()).toBe(0);
    Game.time += 1; world.resources.energy = 50; Object.assign(drop, { amount: 0 });
    work();
    expect(world.creep.memory.working).toBe(true);
    expect(moveToTargetRoom).toHaveBeenCalledWith(world.creep, "W4N5", undefined, expect.any(Object));
    Game.time += 1; Object.assign(world.creep, { room: world.home, pos: position(0, 18, "W4N5") });
    work(); work();
    expect(world.creep.transfer).toHaveBeenCalledTimes(1);
    expect(world.creep.store.getUsedCapacity()).toBe(50);
    Game.time += 1; world.resources.energy = 0; work();
    expect(world.creep.memory.working).toBe(false); expect(world.creep.suicide).not.toHaveBeenCalled();
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
