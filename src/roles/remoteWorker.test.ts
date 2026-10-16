import { remoteWorkerRole } from "@/roles/remoteWorker";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";

jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

const HOME_ROOM = "W1N1";
const TARGET_ROOM = "W2N1";

beforeEach(() => {
  jest.clearAllMocks();
  Game.rooms = {};
  Game.time = 100;
  Game.getObjectById = jest.fn(() => null) as any;
  (Game as Game & { map: GameMap }).map = {
    getRoomLinearDistance: jest.fn(() => 1),
    findRoute: jest.fn(() => [{ room: "W1N2", exit: FIND_EXIT_RIGHT }] as ReturnType<GameMap["findRoute"]>),
  } as unknown as GameMap;
  (global as typeof global & { RoomPosition: typeof RoomPosition }).RoomPosition = class RoomPositionMock {
    public x: number;
    public y: number;
    public roomName: string;
    public constructor(x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    }
    public getRangeTo(target: any): number {
      const tx = target.x !== undefined ? target.x : (target.pos?.x ?? 0);
      const ty = target.y !== undefined ? target.y : (target.pos?.y ?? 0);
      return Math.max(Math.abs(this.x - tx), Math.abs(this.y - ty));
    }
  } as unknown as typeof RoomPosition;
  Memory.data = {
    remoteMining: {
      [TARGET_ROOM]: {
        sourceRoom: HOME_ROOM,
        targetRoom: TARGET_ROOM,
        status: "active",
        sourceIds: ["src-1"],
        assignedAt: 50,
        updatedAt: 50,
      },
    },
  };
});

function createStore(resources: Partial<Record<ResourceConstant, number>>, capacity = 2000): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: (resource?: ResourceConstant) => {
      if (resource === undefined) {
        return Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
      }
      return resources[resource] || 0;
    },
    getFreeCapacity: (resource?: ResourceConstant) => {
      if (resource === undefined) {
        return capacity - Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
      }
      return capacity - (resources[resource] || 0);
    },
  } as unknown as StoreDefinition;
}

function makePos(x: number, y: number, roomName: string): RoomPosition {
  return {
    x, y, roomName,
    getRangeTo: jest.fn((target: any) => {
      if (!target) return 0;
      const tx = target.x !== undefined ? target.x : (target.pos?.x ?? 0);
      const ty = target.y !== undefined ? target.y : (target.pos?.y ?? 0);
      return Math.max(Math.abs(x - tx), Math.abs(y - ty));
    }),
  } as unknown as RoomPosition;
}

function makeRoom(
  name: string,
  opts: {
    structures?: any[];
    constructionSites?: any[];
    storage?: any;
    terminal?: any;
  } = {},
): Room {
  const structures = opts.structures || [];
  const constructionSites = opts.constructionSites || [];
  return {
    name,
    controller: { level: 7 } as any,
    energyCapacityAvailable: 5600,
    storage: opts.storage || null,
    terminal: opts.terminal || null,
    find: jest.fn((type: FindConstant, opts2?: { filter?: (s: any) => boolean }) => {
      let raw: any[];
      if (type === FIND_STRUCTURES) raw = structures;
      else if (type === FIND_CONSTRUCTION_SITES) raw = constructionSites;
      else raw = [];
      if (opts2?.filter) return raw.filter(opts2.filter);
      return raw;
    }),
    getTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
  } as unknown as Room;
}

function makeCreep(opts: {
  room: Room;
  energy: number;
  capacity?: number;
  pos?: RoomPosition;
  memory?: any;
  name?: string;
  ticksToLive?: number;
}): Creep {
  const capacity = opts.capacity ?? 600;
  return {
    name: opts.name || "rw-1",
    room: opts.room,
    pos: opts.pos || makePos(25, 25, opts.room.name),
    memory: opts.memory || { configName: `${HOME_ROOM}:remoteMine:${TARGET_ROOM}:worker:0` },
    store: createStore({ [RESOURCE_ENERGY]: opts.energy }, capacity),
    withdraw: jest.fn(() => OK),
    pickup: jest.fn(() => OK),
    transfer: jest.fn(() => OK),
    repair: jest.fn(() => OK),
    build: jest.fn(() => OK),
    move: jest.fn(() => OK),
    suicide: jest.fn(() => OK),
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === WORK ? 5 : part === CARRY ? 5 : 5),
    ticksToLive: opts.ticksToLive,
  } as unknown as Creep;
}

// ─── SOURCE PHASE ────────────────────────────────────────────────────

describe("remoteWorkerRole - source phase", () => {

  it("clears stale movement state when no remote energy is available", () => {
    const remoteRoom = makeRoom(TARGET_ROOM);
    Game.rooms[TARGET_ROOM] = remoteRoom;
    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: makePos(27, 25, TARGET_ROOM), id: "src-1" };
      return null;
    });
    const creep = makeCreep({ room: remoteRoom, energy: 0 });

    const result = remoteWorkerRole(TARGET_ROOM).source?.(creep);

    expect(result).toBe(false);
    expect(clearMovementState).toHaveBeenCalledWith(creep);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.pickup).not.toHaveBeenCalled();
  });
});

// ─── TARGET PHASE: REPAIR SOURCE CONTAINERS ──────────────────────────

describe("remoteWorkerRole - repairs damaged source container", () => {

  it("keeps repairing the selected container when hit-ratio ordering reverses", () => {
    const sourcePos = makePos(27, 25, TARGET_ROOM);
    const selectedContainer = {
      id: "container-selected",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(26, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 50000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const otherContainer = {
      id: "container-other",
      structureType: STRUCTURE_CONTAINER,
      pos: makePos(28, 25, TARGET_ROOM),
      store: createStore({ [RESOURCE_ENERGY]: 0 }),
      hits: 60000,
      hitsMax: 250000,
    } as unknown as StructureContainer;
    const remoteRoom = makeRoom(TARGET_ROOM, { structures: [selectedContainer, otherContainer] });
    Game.rooms[TARGET_ROOM] = remoteRoom;

    (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
      if (id === "src-1") return { pos: sourcePos, id: "src-1" };
      return null;
    });

    const creep = makeCreep({ room: remoteRoom, energy: 600 });
    const role = remoteWorkerRole(TARGET_ROOM);

    role.target(creep);
    (selectedContainer as unknown as { hits: number }).hits = 80000;
    role.target(creep);

    expect(creep.repair).toHaveBeenNthCalledWith(1, selectedContainer);
    expect(creep.repair).toHaveBeenNthCalledWith(2, selectedContainer);
    expect(creep.repair).not.toHaveBeenCalledWith(otherContainer);
    expect(creep.memory._remoteWorkerRepairTargetId).toBe(selectedContainer.id);
  });
});


it("目标房没有建修任务时留在房内，避免空闲跨边界往返", () => {
  const room = makeRoom(TARGET_ROOM); Game.rooms[TARGET_ROOM] = room;
  const creep = makeCreep({ room, energy: 100 });
  Game.getObjectById = jest.fn(() => null) as Game["getObjectById"];
  expect(remoteWorkerRole(TARGET_ROOM).target(creep)).toBe(false);
  expect(moveToTargetRoom).not.toHaveBeenCalled();
  expect(clearMovementState).toHaveBeenCalledWith(creep);
});
