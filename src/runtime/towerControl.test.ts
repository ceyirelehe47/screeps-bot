import { runTowerControl } from "@/runtime/towerControl";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }

  public findClosestByRange<T extends { pos: { x: number; y: number } }>(targets: T[]): T | null {
    let closest: T | null = null;
    let closestRange = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const range = this.getRangeTo(target);
      if (range < closestRange) {
        closest = target;
        closestRange = range;
      }
    }

    return closest;
  }

  public lookFor(): never[] {
    return [];
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(energy: number): StoreDefinition {
  return {
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? 1000 : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY || resource === undefined ? Math.max(0, 1000 - energy) : 0,
    ),
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? energy : 0)),
  } as unknown as StoreDefinition;
}

function createBody(type: BodyPartConstant, count: number): BodyPartDefinition[] {
  return Array.from({ length: count }, () => ({ type, hits: 100 }) as BodyPartDefinition);
}

function createHostile(
  roomName: string,
  id: string,
  x: number,
  y: number,
  options: {
    hits?: number;
    body?: BodyPartDefinition[];
  } = {},
): Creep {
  const body = options.body ?? createBody(MOVE, 1);
  const hits = options.hits ?? body.length * 100;
  return {
    id: id as Id<Creep>,
    owner: {
      username: "Enemy",
    } as Owner,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    body,
    hits,
    hitsMax: hits,
  } as Creep;
}

function createTower(roomName: string, id: string, x: number, y: number, energy = 1000): StructureTower {
  return {
    id: id as Id<StructureTower>,
    structureType: STRUCTURE_TOWER,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    store: createStore(energy),
    attack: jest.fn(() => OK),
    heal: jest.fn(() => OK),
    repair: jest.fn(() => OK),
  } as unknown as StructureTower;
}

function createRoom(
  name: string,
  options: {
    towers: StructureTower[];
    hostiles?: Creep[];
    myCreeps?: Creep[];
    structures?: Structure<StructureConstant>[];
  },
): Room {
  const towers = options.towers;
  const hostiles = options.hostiles ?? [];
  const myCreeps = options.myCreeps ?? [];
  const structures = options.structures ?? towers;

  return {
    name,
    controller: {
      my: true,
    } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === FIND_MY_STRUCTURES) {
        return towers;
      }

      if (type === FIND_MY_CREEPS) {
        return myCreeps;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      return [];
    },
  } as Room;
}

describe("runTowerControl", () => {
  beforeEach(() => {
    resetRuntimeServices();
    jest.clearAllMocks();
    Game.time = 1;
    Memory.runtime = {};
  });

  it("keeps towers focused on the same target during periodic probe ticks when focus damage is still positive", () => {
    Game.time = 7;

    const roomName = "W1N1";
    const focusTarget = createHostile(roomName, "hostile-focus", 11, 10, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const otherTarget = createHostile(roomName, "hostile-other", 25, 25, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [focusTarget, otherTarget],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerB.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerA.attack).not.toHaveBeenCalledWith(otherTarget);
    expect(towerB.attack).not.toHaveBeenCalledWith(otherTarget);
  });

  it("does not waste tower energy when every hostile is immune to tower damage", () => {
    const roomName = "W1N2";
    const healerA = createHostile(roomName, "hostile-a", 30, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const healerB = createHostile(roomName, "hostile-b", 31, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [healerA, healerB],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).not.toHaveBeenCalled();
    expect(towerB.attack).not.toHaveBeenCalled();
  });
});


it("战斗中只用一座塔治疗，其余塔继续攻击", () => {
  const name = "W1N3";
  const towers = [createTower(name, "a", 10, 10), createTower(name, "b", 11, 10), createTower(name, "c", 12, 10)];
  const hostile = createHostile(name, "enemy", 13, 10);
  const ally = { pos: new MockPos(10, 11, name), hits: 99, hitsMax: 100 } as unknown as Creep;
  const room = createRoom(name, { towers, hostiles: [hostile], myCreeps: [ally] });
  Game.rooms[name] = room;
  runTowerControl();
  expect(towers.filter(t => (t.heal as jest.Mock).mock.calls.length)).toHaveLength(1);
  expect(towers.filter(t => (t.attack as jest.Mock).mock.calls.length)).toHaveLength(2);
});


it("敌方治疗超过塔伤害时仍修应急 rampart", () => {
  const name = "W1N4";
  const tower = createTower(name, "tower", 10, 10);
  const hostile = createHostile(name, "healer", 30, 30, { body: createBody(HEAL, 50), hits: 5000 });
  const rampart = { id: "rampart", structureType: STRUCTURE_RAMPART, my: true,
    pos: new MockPos(11, 10, name), hits: 1000, hitsMax: 100000 } as unknown as StructureRampart;
  const room = createRoom(name, { towers: [tower], hostiles: [hostile], structures: [tower, rampart] });
  const nativeFind = room.find;
  room.find = jest.fn((kind: FindConstant) => kind === FIND_MY_STRUCTURES ? [tower, rampart] : nativeFind(kind)) as Room["find"];
  Game.rooms[name] = room;
  runTowerControl();
  expect(tower.attack).not.toHaveBeenCalled();
  expect(tower.repair).toHaveBeenCalledWith(rampart);
});
