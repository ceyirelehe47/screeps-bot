import {
  getSourceContainerPositionsForRoom,
  getProtoControllerLinkContainer,
  runRoomPlannerConstruction,
} from "@/runtime/roomPlannerConstruction";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  RoomPosition: typeof MockRoomPosition;
};

type PlannedPos = { x: number; y: number };

type MockSite = ConstructionSite & {
  pos: { x: number; y: number; roomName: string };
};

type MockStructure = Structure<StructureConstant> & {
  my: boolean;
  pos: { x: number; y: number; roomName: string };
};

type MockRoom = Room & {
  __structures: MockStructure[];
  __sites: MockSite[];
  __sources: Source[];
  __minerals: Mineral[];
  __siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }>;
};

class MockRoomPosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}

  public lookFor(type: LookConstant): Array<Structure<StructureConstant> | ConstructionSite> {
    const room = Game.rooms[this.roomName] as MockRoom | undefined;
    if (!room) {
      return [];
    }

    if (type === LOOK_STRUCTURES) {
      return room.__structures.filter((structure) => structure.pos.x === this.x && structure.pos.y === this.y);
    }

    if (type === LOOK_CONSTRUCTION_SITES) {
      return room.__sites.filter((site) => site.pos.x === this.x && site.pos.y === this.y);
    }

    return [];
  }

  public getRangeTo(target: { x: number; y: number }): number {
    return Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y));
  }

  public findClosestByRange<T extends { pos: { x: number; y: number } }>(targets: T[]): T | null {
    let best: T | null = null;
    let bestRange = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const range = this.getRangeTo(target.pos);
      if (range < bestRange) {
        best = target;
        bestRange = range;
      }
    }

    return best;
  }

  public findPathTo(target: { x: number; y: number }): Array<{ x: number; y: number }> {
    const steps = Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y));
    return Array.from({ length: steps }, (_, index) => ({
      x: this.x + Math.sign(target.x - this.x) * (index + 1),
      y: this.y + Math.sign(target.y - this.y) * (index + 1),
    }));
  }

  public findInRange(
    type: FindConstant,
    range: number,
    opts?: { filter?: (value: any) => boolean },
  ): Array<Source | Mineral | Structure<StructureConstant> | ConstructionSite> {
    const room = Game.rooms[this.roomName] as MockRoom | undefined;
    if (!room) {
      return [];
    }

    const isWithinRange = (x: number, y: number): boolean =>
      Math.max(Math.abs(x - this.x), Math.abs(y - this.y)) <= range;

    if (type === FIND_SOURCES) {
      const results = room.find(FIND_SOURCES).filter((source) => isWithinRange(source.pos.x, source.pos.y));
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    if (type === FIND_MINERALS) {
      const results = room.find(FIND_MINERALS).filter((mineral) => isWithinRange(mineral.pos.x, mineral.pos.y));
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    if (type === FIND_MY_STRUCTURES) {
      const results = room.__structures.filter(
        (structure) => structure.my && isWithinRange(structure.pos.x, structure.pos.y),
      );
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    if (type === FIND_CONSTRUCTION_SITES) {
      const results = room.__sites.filter((site) => isWithinRange(site.pos.x, site.pos.y));
      return opts?.filter ? results.filter((value) => opts.filter?.(value)) : results;
    }

    return [];
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}


function createSource(room: Room, x: number, y: number): Source {
  return {
    id: `source:${room.name}:${x}:${y}`,
    room,
    pos: new MockRoomPosition(x, y, room.name) as RoomPosition,
  } as Source;
}



function createRoom(options: {
  name?: string;
  level?: number;
  structures?: MockStructure[];
  sources?: Source[];
  minerals?: Mineral[];
} = {}): MockRoom {
  const name = options.name ?? "W1N1";
  const structures = [...(options.structures ?? [])];
  const sources = [...(options.sources ?? [])];
  const minerals = [...(options.minerals ?? [])];
  const sites: MockSite[] = [];
  const siteAttempts: Array<{ x: number; y: number; structureType: BuildableStructureConstant }> = [];

  const room = {
    name,
    controller: {
      my: true,
      level: options.level ?? 6,
      pos: new MockRoomPosition(25, 25, name),
    } as StructureController,
    __structures: structures,
    __sites: sites,
    __sources: sources,
    __minerals: minerals,
    __siteAttempts: siteAttempts,
    find(type: FindConstant, opts?: { filter?: (value: any) => boolean }) {
      let results: unknown[] = [];

      if (type === FIND_STRUCTURES) {
        results = this.__structures;
      } else if (type === FIND_CONSTRUCTION_SITES) {
        results = this.__sites;
      } else if (type === FIND_SOURCES) {
        results = this.__sources;
      } else if (type === FIND_MINERALS) {
        results = this.__minerals;
      }

      if (opts?.filter) {
        return results.filter((value) => opts.filter?.(value));
      }

      return results;
    },
    createConstructionSite(x: number, y: number, structureType: BuildableStructureConstant) {
      this.__siteAttempts.push({ x, y, structureType });

      const site = {
        id: `${structureType}:${x}:${y}:${this.__sites.length}`,
        my: true,
        remove: jest.fn(() => OK),
        structureType,
        pos: new MockRoomPosition(x, y, this.name),
        room: this,
      } as unknown as MockSite;

      this.__sites.push(site);
      (Game.constructionSites as Record<string, ConstructionSite>)[site.id] = site;
      return OK;
    },
  } as MockRoom;

  room.__structures = structures;
  room.__sites = sites;
  room.__sources = sources;
  room.__minerals = minerals;
  room.__siteAttempts = siteAttempts;
  return room;
}

function setRoomPlannerLayout(roomName: string, layout: Partial<Record<string, PlannedPos[]>>): void {
  const clonedLayout = Object.fromEntries(
    Object.entries(layout).map(([structureType, positions]) => [
      structureType,
      (positions ?? []).map((pos) => ({ ...pos })),
    ]),
  );

  Memory.data = {
    ...Memory.data,
    roomPlanner: {
      ...(Memory.data?.roomPlanner ?? {}),
      [roomName]: {
        layout: clonedLayout,
        timestamp: "2026-03-12T00:00:00.000Z",
        savedAt: Game.time,
      },
    },
  } as Memory["data"];
}

function createRemoteMiningTask(
  sourceRoom: string,
  targetRoom: string,
  containerPositions: Record<string, { x: number; y: number; roomName: string }>,
): import("@/runtime/remoteMining").RemoteMiningTask {
  return {
    sourceRoom,
    targetRoom,
    status: "active",
    sourceIds: Object.keys(containerPositions),
    assignedAt: Game.time,
    updatedAt: Game.time,
    containerPositions,
  };
}

describe("getSourceContainerPositionsForRoom", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 100;
    Game.rooms = {} as Game["rooms"];
    Memory.data = {} as Memory["data"];
  });

  it("控制器容器保留至控制器 link 实际获得建设名额", () => {
    const room = createRoom({ level: 4 });
    Game.rooms[room.name] = room;
    Game.constructionSites = {};
    Game.map = { describeExits: () => ({}) } as unknown as Game["map"];
    Memory.cfg = { roomPlannerBuild: { enabled: true } };
    Memory.runtime = {};
    const original = (global as RuntimeGlobal).RoomPosition;
    Object.assign(global, { RoomPosition: MockRoomPosition });
    const structure = (type: StructureConstant, x: number, y: number) => ({ id: `${type}:${x}:${y}`, my: true,
      structureType: type, pos: new MockRoomPosition(x, y, room.name), room }) as unknown as MockStructure;
    const container = structure(STRUCTURE_CONTAINER, 25, 24) as unknown as StructureContainer;
    container.destroy = jest.fn(() => { room.__structures = room.__structures.filter(item => item !== container as unknown as MockStructure); return OK; });
    const storage = structure(STRUCTURE_STORAGE, 10, 10) as unknown as StructureStorage;
    room.storage = storage;
    room.__structures.push(structure(STRUCTURE_SPAWN, 11, 10), storage as unknown as MockStructure, container as unknown as MockStructure);
    setRoomPlannerLayout(room.name, { link: [{ x: 25, y: 24 }] });
    try {
      runRoomPlannerConstruction();
      expect(container.destroy).not.toHaveBeenCalled();
      expect(getProtoControllerLinkContainer(room)).toBe(container);
      room.controller.level = 5; Game.time += 100; resetRuntimeServices();
      runRoomPlannerConstruction();
      expect(container.destroy).toHaveBeenCalledTimes(1);
      expect(room.__siteAttempts).toContainEqual({ x: 25, y: 24, structureType: STRUCTURE_LINK });
    } finally { Object.assign(global, { RoomPosition: original }); }
  });

  it("deduplicates remote mining container positions with planned source container positions", () => {
    const room = createRoom({ name: "W2N2" });
    room.controller.my = false;
    const source = createSource(room, 11, 10);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, { [STRUCTURE_CONTAINER]: [{ x: 12, y: 10 }] });
    Memory.data = {
      ...Memory.data,
      remoteMining: {
        [room.name]: createRemoteMiningTask("W1N1", room.name, {
          source1: { x: 12, y: 10, roomName: room.name },
          source2: { x: 20, y: 20, roomName: room.name },
        }),
      },
    } as Memory["data"];

    expect(getSourceContainerPositionsForRoom(room.name)).toEqual([
      { x: 12, y: 10 },
      { x: 20, y: 20 },
    ]);
  });

  it("returns defensive copies so callers cannot mutate the cached array", () => {
    const room = createRoom({ name: "W2N4" });
    const source = createSource(room, 11, 10);
    room.__sources.push(source);
    Game.rooms[room.name] = room;
    setRoomPlannerLayout(room.name, { [STRUCTURE_CONTAINER]: [{ x: 12, y: 10 }] });

    const first = getSourceContainerPositionsForRoom(room.name);
    first.pop();
    first.push({ x: 99, y: 99 });

    const second = getSourceContainerPositionsForRoom(room.name);
    expect(second).toEqual([{ x: 12, y: 10 }]);
  });
});
