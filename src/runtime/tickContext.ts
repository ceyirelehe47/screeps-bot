// isActive() reads the immutable tick-start snapshot, so it is stable for the
// whole tick; memoizing avoids redundant JS->native calls from the spawn
// planner's per-config spawn filters and mountSpawn's work loop.
let spawnActiveCacheTick = -1;
const spawnActiveCache = new Map<Id<StructureSpawn>, boolean>();

/**
 * Backward-compatible spawn active check.
 * Treats spawn as active if `isActive` is not present (mock environment).
 */
export function isSpawnActive(spawn: StructureSpawn): boolean {
  const tick = Game.time;
  if (spawnActiveCacheTick !== tick) {
    spawnActiveCache.clear();
    spawnActiveCacheTick = tick;
  }

  const cached = spawnActiveCache.get(spawn.id);
  if (cached !== undefined) {
    return cached;
  }

  const active = typeof spawn.isActive !== "function" || spawn.isActive();
  spawnActiveCache.set(spawn.id, active);
  return active;
}

// Test-only reset of the per-tick isSpawnActive cache; not a runtime API.
export function clearSpawnActiveCacheForTest(): void {
  spawnActiveCache.clear();
  spawnActiveCacheTick = -1;
}

export interface RoomTickContext {
  room: Room;
  getStructures(): Structure<StructureConstant>[];
  getMyStructures(): Structure<StructureConstant>[];
  /** 单趟扫描构建的按 structureType 索引（惰性；同 tick 内所有 typed getter 共享）。 */
  getStructuresByType(structureType: StructureConstant): Structure<StructureConstant>[];
  getMyStructuresByType(structureType: StructureConstant): Structure<StructureConstant>[];
  getMyCreeps(): Creep[];
  getConstructionSites(): ConstructionSite[];
  getSources(): Source[];
  getMinerals(): Mineral[];
  getHostileCreeps(): Creep[];
  getHostilePowerCreeps(): PowerCreep[];
  getHostileStructures(): Structure<StructureConstant>[];
  getTowers(): StructureTower[];
  getLinks(): StructureLink[];
  getLabs(): StructureLab[];
  getRamparts(): StructureRampart[];
  getContainers(): StructureContainer[];
  getDroppedEnergyResources(): Resource[];
  getEnergyTombstones(): Tombstone[];
  getEnergyRuins(): Ruin[];
}

export interface TickContextService {
  getTick(): number;
  getMyRooms(): Room[];
  /** 本 tick 的全部 spawn/creep 快照，避免主循环与各模块重复 Object.values。 */
  getAllSpawns(): StructureSpawn[];
  getAllCreeps(): Creep[];
  getPrimarySpawnByRoom(roomName: string): StructureSpawn | undefined;
  getSpawnsByRoom(roomName: string): StructureSpawn[];
  getCreepsByConfigName(configName: string): Creep[];
  getCreepsByRole(role: string): Creep[];
  getCreepsByRoom(roomName: string): Creep[];
  getRoomContext(room: Room | string): RoomTickContext | null;
}

interface TickContextSnapshot {
  tick: number;
  myRooms?: Room[];
  allSpawns?: StructureSpawn[];
  allCreeps?: Creep[];
  spawnsByRoom?: Map<string, StructureSpawn[]>;
  primarySpawnByRoom?: Map<string, StructureSpawn>;
  creepsByConfigName?: Map<string, Creep[]>;
  creepsByRole?: Map<string, Creep[]>;
  creepsByRoom?: Map<string, Creep[]>;
  roomContexts?: Map<string, RoomTickContext>;
}

const EMPTY_STRUCTURES: Structure<StructureConstant>[] = [];

function createRoomTickContext(room: Room): RoomTickContext {
  let structures: Structure<StructureConstant>[] | undefined;
  let myStructures: Structure<StructureConstant>[] | undefined;
  let structuresByType: Map<StructureConstant, Structure<StructureConstant>[]> | undefined;
  let myStructuresByType: Map<StructureConstant, Structure<StructureConstant>[]> | undefined;
  let myCreeps: Creep[] | undefined;
  let constructionSites: ConstructionSite[] | undefined;
  let sources: Source[] | undefined;
  let minerals: Mineral[] | undefined;
  let hostileCreeps: Creep[] | undefined;
  let hostilePowerCreeps: PowerCreep[] | undefined;
  let hostileStructures: Structure<StructureConstant>[] | undefined;
  let towers: StructureTower[] | undefined;
  let links: StructureLink[] | undefined;
  let labs: StructureLab[] | undefined;
  let ramparts: StructureRampart[] | undefined;
  let containers: StructureContainer[] | undefined;
  let droppedEnergyResources: Resource[] | undefined;
  let energyTombstones: Tombstone[] | undefined;
  let energyRuins: Ruin[] | undefined;

  function ensureStructuresByType(): Map<StructureConstant, Structure<StructureConstant>[]> {
    if (!structuresByType) {
      structuresByType = new Map();
      for (const structure of this.getStructures()) {
        const bucket = structuresByType.get(structure.structureType);
        if (bucket) {
          bucket.push(structure);
        } else {
          structuresByType.set(structure.structureType, [structure]);
        }
      }
    }
    return structuresByType;
  }

  function ensureMyStructuresByType(): Map<StructureConstant, Structure<StructureConstant>[]> {
    if (!myStructuresByType) {
      myStructuresByType = new Map();
      for (const structure of this.getMyStructures()) {
        const bucket = myStructuresByType.get(structure.structureType);
        if (bucket) {
          bucket.push(structure);
        } else {
          myStructuresByType.set(structure.structureType, [structure]);
        }
      }
    }
    return myStructuresByType;
  }

  return {
    room,
    getStructures(): Structure<StructureConstant>[] {
      if (!structures) {
        structures = room.find(FIND_STRUCTURES);
      }
      return structures;
    },
    getMyStructures(): Structure<StructureConstant>[] {
      if (!myStructures) {
        myStructures = room.find(FIND_MY_STRUCTURES);
      }
      return myStructures;
    },
    getStructuresByType(structureType: StructureConstant): Structure<StructureConstant>[] {
      return ensureStructuresByType.call(this).get(structureType) || EMPTY_STRUCTURES;
    },
    getMyStructuresByType(structureType: StructureConstant): Structure<StructureConstant>[] {
      return ensureMyStructuresByType.call(this).get(structureType) || EMPTY_STRUCTURES;
    },
    getMyCreeps(): Creep[] {
      if (!myCreeps) {
        myCreeps = room.find(FIND_MY_CREEPS);
      }
      return myCreeps;
    },
    getConstructionSites(): ConstructionSite[] {
      if (!constructionSites) {
        constructionSites = room.find(FIND_CONSTRUCTION_SITES);
      }
      return constructionSites;
    },
    getSources(): Source[] {
      if (!sources) {
        sources = room.find(FIND_SOURCES);
      }
      return sources;
    },
    getMinerals(): Mineral[] {
      if (!minerals) {
        minerals = room.find(FIND_MINERALS);
      }
      return minerals;
    },
    getHostileCreeps(): Creep[] {
      if (!hostileCreeps) {
        hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
      }
      return hostileCreeps;
    },
    getHostilePowerCreeps(): PowerCreep[] {
      if (!hostilePowerCreeps) {
        hostilePowerCreeps = room.find(FIND_HOSTILE_POWER_CREEPS);
      }
      return hostilePowerCreeps;
    },
    getHostileStructures(): Structure<StructureConstant>[] {
      if (!hostileStructures) {
        hostileStructures = room.find(FIND_HOSTILE_STRUCTURES) as Structure<StructureConstant>[];
      }
      return hostileStructures;
    },
    getTowers(): StructureTower[] {
      if (!towers) {
        towers = ensureMyStructuresByType.call(this).get(STRUCTURE_TOWER) as StructureTower[] | undefined;
        towers = towers ?? (EMPTY_STRUCTURES as unknown as StructureTower[]);
      }
      return towers;
    },
    getLinks(): StructureLink[] {
      if (!links) {
        links = ensureMyStructuresByType.call(this).get(STRUCTURE_LINK) as StructureLink[] | undefined;
        links = links ?? (EMPTY_STRUCTURES as unknown as StructureLink[]);
      }
      return links;
    },
    getLabs(): StructureLab[] {
      if (!labs) {
        labs = ensureMyStructuresByType.call(this).get(STRUCTURE_LAB) as StructureLab[] | undefined;
        labs = labs ?? (EMPTY_STRUCTURES as unknown as StructureLab[]);
      }
      return labs;
    },
    getRamparts(): StructureRampart[] {
      if (!ramparts) {
        ramparts = ensureMyStructuresByType.call(this).get(STRUCTURE_RAMPART) as StructureRampart[] | undefined;
        ramparts = ramparts ?? (EMPTY_STRUCTURES as unknown as StructureRampart[]);
      }
      return ramparts;
    },
    getContainers(): StructureContainer[] {
      if (!containers) {
        containers = ensureStructuresByType.call(this).get(STRUCTURE_CONTAINER) as StructureContainer[] | undefined;
        containers = containers ?? (EMPTY_STRUCTURES as unknown as StructureContainer[]);
      }
      return containers;
    },
    getDroppedEnergyResources(): Resource[] {
      if (!droppedEnergyResources) {
        droppedEnergyResources = room.find(FIND_DROPPED_RESOURCES, {
          filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
        });
      }
      return droppedEnergyResources;
    },
    getEnergyTombstones(): Tombstone[] {
      if (!energyTombstones) {
        energyTombstones = room.find(FIND_TOMBSTONES, {
          filter: (tombstone) => tombstone.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
        });
      }
      return energyTombstones;
    },
    getEnergyRuins(): Ruin[] {
      if (!energyRuins) {
        energyRuins = room.find(FIND_RUINS, {
          filter: (ruin) => ruin.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
        });
      }
      return energyRuins;
    },
  };
}

export function createTickContextService(): TickContextService {
  let snapshot: TickContextSnapshot = {
    tick: -1,
  };

  function ensureCurrentTick(): TickContextSnapshot {
    if (snapshot.tick !== Game.time) {
      snapshot = {
        tick: Game.time,
      };
    }
    return snapshot;
  }

  function ensureMyRooms(current: TickContextSnapshot): Room[] {
    if (!current.myRooms) {
      current.myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
    }
    return current.myRooms;
  }

  function ensureAllSpawns(current: TickContextSnapshot): StructureSpawn[] {
    if (!current.allSpawns) {
      current.allSpawns = Object.values(Game.spawns);
    }
    return current.allSpawns;
  }

  function ensureAllCreeps(current: TickContextSnapshot): Creep[] {
    if (!current.allCreeps) {
      current.allCreeps = Object.values(Game.creeps);
    }
    return current.allCreeps;
  }

  function ensureSpawnIndexes(current: TickContextSnapshot): void {
    if (current.spawnsByRoom && current.primarySpawnByRoom) {
      return;
    }

    const spawnsByRoom = new Map<string, StructureSpawn[]>();
    const primarySpawnByRoom = new Map<string, StructureSpawn>();

    for (const spawn of Object.values(Game.spawns)) {
      const roomSpawns = spawnsByRoom.get(spawn.room.name);
      if (roomSpawns) {
        roomSpawns.push(spawn);
      } else {
        spawnsByRoom.set(spawn.room.name, [spawn]);
      }

      if (!primarySpawnByRoom.has(spawn.room.name) || !isSpawnActive(primarySpawnByRoom.get(spawn.room.name)!)) {
        if (isSpawnActive(spawn) || !primarySpawnByRoom.has(spawn.room.name)) {
          primarySpawnByRoom.set(spawn.room.name, spawn);
        }
      }
    }

    current.spawnsByRoom = spawnsByRoom;
    current.primarySpawnByRoom = primarySpawnByRoom;
  }

  function ensureCreepIndexes(current: TickContextSnapshot): void {
    if (current.creepsByConfigName && current.creepsByRole && current.creepsByRoom) {
      return;
    }

    const creepsByConfigName = new Map<string, Creep[]>();
    const creepsByRole = new Map<string, Creep[]>();
    const creepsByRoom = new Map<string, Creep[]>();

    for (const creep of Object.values(Game.creeps)) {
      const configName = creep.memory.configName;
      if (typeof configName === "string") {
        const byConfig = creepsByConfigName.get(configName);
        if (byConfig) {
          byConfig.push(creep);
        } else {
          creepsByConfigName.set(configName, [creep]);
        }
      }

      const byRole = creepsByRole.get(creep.memory.role);
      if (byRole) {
        byRole.push(creep);
      } else {
        creepsByRole.set(creep.memory.role, [creep]);
      }

      const byRoom = creepsByRoom.get(creep.room.name);
      if (byRoom) {
        byRoom.push(creep);
      } else {
        creepsByRoom.set(creep.room.name, [creep]);
      }
    }

    current.creepsByConfigName = creepsByConfigName;
    current.creepsByRole = creepsByRole;
    current.creepsByRoom = creepsByRoom;
  }

  return {
    getTick(): number {
      return ensureCurrentTick().tick;
    },

    getMyRooms(): Room[] {
      const current = ensureCurrentTick();
      return ensureMyRooms(current);
    },

    getAllSpawns(): StructureSpawn[] {
      const current = ensureCurrentTick();
      return ensureAllSpawns(current);
    },

    getAllCreeps(): Creep[] {
      const current = ensureCurrentTick();
      return ensureAllCreeps(current);
    },

    getPrimarySpawnByRoom(roomName: string): StructureSpawn | undefined {
      const current = ensureCurrentTick();
      ensureSpawnIndexes(current);
      return current.primarySpawnByRoom?.get(roomName);
    },

    getSpawnsByRoom(roomName: string): StructureSpawn[] {
      const current = ensureCurrentTick();
      ensureSpawnIndexes(current);
      return current.spawnsByRoom?.get(roomName) || [];
    },

    getCreepsByConfigName(configName: string): Creep[] {
      const current = ensureCurrentTick();
      ensureCreepIndexes(current);
      return current.creepsByConfigName?.get(configName) || [];
    },

    getCreepsByRole(role: string): Creep[] {
      const current = ensureCurrentTick();
      ensureCreepIndexes(current);
      return current.creepsByRole?.get(role) || [];
    },

    getCreepsByRoom(roomName: string): Creep[] {
      const current = ensureCurrentTick();
      ensureCreepIndexes(current);
      return current.creepsByRoom?.get(roomName) || [];
    },

    getRoomContext(room: Room | string): RoomTickContext | null {
      const current = ensureCurrentTick();
      const roomName = typeof room === "string" ? room : room.name;
      const resolvedRoom = typeof room === "string" ? Game.rooms[room] : room;
      if (!resolvedRoom) {
        return null;
      }

      if (!current.roomContexts) {
        current.roomContexts = new Map<string, RoomTickContext>();
      }

      const existing = current.roomContexts.get(roomName);
      if (existing) {
        return existing;
      }

      const context = createRoomTickContext(resolvedRoom);
      current.roomContexts.set(roomName, context);
      return context;
    },
  };
}
