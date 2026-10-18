/**
 * Shared power bank test helpers for Jest.
 *
 * Provides reusable mocks for: power bank structures, combat creeps
 * (attacker/healer), hauler creeps, scout creeps, spawns, labs, stores,
 * dropped resources, body part hit state tracking.
 */

// ---------------------------------------------------------------------------
// Position helper (mirrors MockPos from towerControl.test.ts)
// ---------------------------------------------------------------------------

export class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const tp = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (tp.x ?? 0)), Math.abs(this.y - (tp.y ?? 0)));
  }

  public isEqualTo(target: { x: number; y: number; roomName?: string }): boolean {
    return this.x === target.x && this.y === target.y && (!target.roomName || this.roomName === target.roomName);
  }

  public inRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }, range: number): boolean {
    return this.getRangeTo(target) <= range;
  }

  public isNearTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): boolean {
    return this.getRangeTo(target) <= 1;
  }

  public getDirectionTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): DirectionConstant | null {
    const tp = "pos" in target && target.pos ? target.pos : target;
    const dx = (tp.x ?? 0) - this.x;
    const dy = (tp.y ?? 0) - this.y;
    if (dx === 0 && dy === 0) return null;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx >= 2 * ady) return dx > 0 ? RIGHT : LEFT;
    if (ady >= 2 * adx) return dy > 0 ? BOTTOM : TOP;
    if (dx > 0 && dy > 0) return BOTTOM_RIGHT;
    if (dx > 0 && dy < 0) return TOP_RIGHT;
    if (dx < 0 && dy > 0) return BOTTOM_LEFT;
    return TOP_LEFT;
  }

  public findClosestByRange<T extends { pos: { x: number; y: number } }>(targets: T[]): T | null {
    let best: T | null = null;
    let bestRange = Number.POSITIVE_INFINITY;
    for (const t of targets) {
      const r = this.getRangeTo(t);
      if (r < bestRange) {
        best = t;
        bestRange = r;
      }
    }
    return best;
  }

  public lookFor(): unknown[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export interface MockStoreConfig {
  resources?: Record<string, number>;
  capacity?: number;
}

export function createMockStore(resources: Record<string, number> = {}, capacity = 3000): StoreDefinition {
  // Keep the indexed resources and the capacity methods on one independent,
  // mutable backing object. Tests can therefore model a later tick by updating
  // `store[resource]`, without mutating the object passed by the caller.
  const backing: Record<string, number> = { ...resources };
  const used = (): number => Object.values(backing).reduce((sum, amount) => sum + amount, 0);

  Object.defineProperties(backing, {
    getCapacity: {
      value: jest.fn((_resource?: ResourceConstant) => capacity),
      enumerable: false,
      configurable: true,
      writable: true,
    },
    getFreeCapacity: {
      // This helper represents a shared-capacity store: every valid resource
      // sees the same remaining total capacity, including currently empty ones.
      value: jest.fn((_resource?: ResourceConstant) => Math.max(0, capacity - used())),
      enumerable: false,
      configurable: true,
      writable: true,
    },
    getUsedCapacity: {
      value: jest.fn((resource?: ResourceConstant) => {
        if (resource === undefined) return used();
        return backing[resource] ?? 0;
      }),
      enumerable: false,
      configurable: true,
      writable: true,
    },
  });

  return backing as unknown as StoreDefinition;
}

// ---------------------------------------------------------------------------
// Power bank structure
// ---------------------------------------------------------------------------

export interface MockPowerBankConfig {
  id?: string;
  x?: number;
  y?: number;
  roomName?: string;
  hits?: number;
  hitsMax?: number;
  power?: number;
  ticksToDecay?: number;
}

export function createMockPowerBank(overrides: Partial<MockPowerBankConfig> = {}): StructurePowerBank {
  const x = overrides.x ?? 25;
  const y = overrides.y ?? 25;
  const roomName = overrides.roomName ?? "W1N1";

  return {
    id: (overrides.id ?? "powerbank-0") as Id<StructurePowerBank>,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_POWER_BANK as StructureConstant,
    hits: overrides.hits ?? 2_000_000,
    hitsMax: overrides.hitsMax ?? 2_000_000,
    power: overrides.power ?? 5000,
    ticksToDecay: overrides.ticksToDecay ?? 5000,
    destroy: jest.fn(() => OK),
  } as unknown as StructurePowerBank;
}

// ---------------------------------------------------------------------------
// Dropped power resource
// ---------------------------------------------------------------------------

export interface MockDroppedResourceConfig {
  id?: string;
  x?: number;
  y?: number;
  roomName?: string;
  amount?: number;
}

export function createMockDroppedPower(overrides: Partial<MockDroppedResourceConfig> = {}): Resource {
  const x = overrides.x ?? 25;
  const y = overrides.y ?? 25;
  const roomName = overrides.roomName ?? "W1N1";

  return {
    id: (overrides.id ?? "dropped-power-0") as Id<Resource>,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    resourceType: RESOURCE_POWER as ResourceConstant,
    amount: overrides.amount ?? 5000,
  } as unknown as Resource;
}

// ---------------------------------------------------------------------------
// Lab
// ---------------------------------------------------------------------------

export interface MockLabConfig {
  id?: string;
  x?: number;
  y?: number;
  roomName?: string;
  mineralType?: MineralConstant | null;
  mineralAmount?: number;
  cooldown?: number;
  store?: Record<string, number>;
}

export function createMockLab(overrides: Partial<MockLabConfig> = {}): StructureLab {
  const x = overrides.x ?? 20;
  const y = overrides.y ?? 20;
  const roomName = overrides.roomName ?? "W1N1";
  const store = overrides.store ?? {};

  return {
    id: (overrides.id ?? "lab-0") as Id<StructureLab>,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_LAB as StructureConstant,
    mineralType: (overrides.mineralType ?? null) as MineralConstant | null,
    mineralAmount: overrides.mineralAmount ?? 0,
    cooldown: overrides.cooldown ?? 0,
    store: createMockStore(store),
    boostCreep: jest.fn((_creep: Creep, _bodyParts?: BodyPartConstant[]) => OK),
    runReaction: jest.fn((_lab1: StructureLab, _lab2: StructureLab) => OK),
  } as unknown as StructureLab;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface MockFactoryConfig {
  id?: string;
  x?: number;
  y?: number;
  roomName?: string;
  level?: number;
  cooldown?: number;
  store?: StoreDefinition;
  produce?: jest.Mock;
}

export function createMockFactory(overrides: Partial<MockFactoryConfig> = {}): StructureFactory {
  const x = overrides.x ?? 20;
  const y = overrides.y ?? 20;
  const roomName = overrides.roomName ?? "W1N1";

  return {
    id: (overrides.id ?? "factory-0") as Id<StructureFactory>,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_FACTORY as StructureConstant,
    level: overrides.level ?? 0,
    cooldown: overrides.cooldown ?? 0,
    store: overrides.store ?? createMockStore({}),
    produce: overrides.produce ?? jest.fn((_resource: ResourceConstant) => OK),
  } as unknown as StructureFactory;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface MockSpawnConfig {
  id?: string;
  x?: number;
  y?: number;
  roomName?: string;
  store?: Record<string, number>;
  spawning?: Spawning | null;
}

export function createMockSpawn(overrides: Partial<MockSpawnConfig> = {}): StructureSpawn {
  const x = overrides.x ?? 25;
  const y = overrides.y ?? 25;
  const roomName = overrides.roomName ?? "W1N1";

  return {
    id: (overrides.id ?? "spawn-0") as Id<StructureSpawn>,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_SPAWN as StructureConstant,
    store: createMockStore(overrides.store ?? { [RESOURCE_ENERGY]: 300 }),
    spawning: overrides.spawning ?? null,
    spawnCreep: jest.fn(() => OK),
    renewCreep: jest.fn((_creep: Creep) => OK),
  } as unknown as StructureSpawn;
}

// ---------------------------------------------------------------------------
// Combat / hauler / scout creep
// ---------------------------------------------------------------------------

export interface MockCreepConfig {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  roomName?: string;
  body?: Array<{ type: BodyPartConstant; hits: number; boost?: ResourceConstant }>;
  hits?: number;
  hitsMax?: number;
  fatigue?: number;
  store?: Record<string, number>;
  carryCapacity?: number;
  memory?: Partial<CreepMemory>;
}

/**
 * Create a mock creep suitable for power bank combat, hauling, or scouting.
 *
 * Defaults mirror each PowerBank role's body-part contract. Callers can still
 * override the complete body, including per-part boost metadata.
 */
export function createMockPowerBankCreep(role: string, overrides: Partial<MockCreepConfig> = {}): Creep {
  const x = overrides.x ?? 24;
  const y = overrides.y ?? 24;
  const roomName = overrides.roomName ?? "W1N1";
  const name = overrides.name ?? `${role}-0`;

  const makeParts = (type: BodyPartConstant, count: number): Array<{ type: BodyPartConstant; hits: number }> =>
    Array.from({ length: count }, () => ({ type, hits: 100 }));
  const normalizedRole = role.toLowerCase();
  const defaultBody = normalizedRole.includes("healer")
    ? [...makeParts(HEAL, 25), ...makeParts(MOVE, 25)]
    : normalizedRole.includes("hauler")
      ? [...makeParts(CARRY, 25), ...makeParts(MOVE, 25)]
      : normalizedRole.includes("scout")
        ? makeParts(MOVE, 1)
        : [
          ...makeParts(TOUGH, 1),
          ...makeParts(ATTACK, 19),
          ...makeParts(MOVE, 20),
        ];
  const body: Array<{ type: BodyPartConstant; hits: number; boost?: ResourceConstant }> =
    overrides.body ?? defaultBody;

  const hits = overrides.hits ?? body.reduce((s, p) => s + p.hits, 0);
  const hitsMax = overrides.hitsMax ?? hits;
  const storeRes = overrides.store ?? {};
  const room = { name: roomName } as Room;

  const creep = {
    id: (overrides.id ?? name) as Id<Creep>,
    name,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    room,
    body,
    hits,
    hitsMax,
    fatigue: overrides.fatigue ?? 0,
    store: createMockStore(storeRes, overrides.carryCapacity ?? 1600),
    memory: {
      role,
      ...overrides.memory,
    } as CreepMemory,
    owner: { username: "player" } as Owner,
    my: true,

    // Action mocks
    attack: jest.fn((_target: Creep | Structure) => OK),
    rangedAttack: jest.fn((_target: Creep | Structure) => OK),
    rangedMassAttack: jest.fn(() => OK),
    heal: jest.fn((_target: Creep) => OK),
    rangedHeal: jest.fn((_target: Creep) => OK),
    pickup: jest.fn((_resource: Resource) => OK),
    withdraw: jest.fn((_target: Structure | Tombstone | Ruin, _type: ResourceConstant, _amount?: number) => OK),
    transfer: jest.fn((_target: Structure | Creep, _type: ResourceConstant, _amount?: number) => OK),
    suicide: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    move: jest.fn((_direction: DirectionConstant) => OK),
    moveTo: jest.fn((_target: RoomPosition | { pos: RoomPosition }, _opts?: MoveToOpts) => OK),
    renewCreep: jest.fn((_spawn: StructureSpawn) => OK),
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((p) => p.type === part && p.hits > 0).length),
    say: jest.fn((_msg: string) => OK),
  } as unknown as Creep;

  return creep;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Advance `Game.time` by the given number of ticks. */
export function advanceGameTime(ticks: number): void {
  Game.time += ticks;
}

// ---------------------------------------------------------------------------
// Body part hit state helpers
// ---------------------------------------------------------------------------

/**
 * Set hit points on a specific body part index.
 *
 * Mutates `creep.body[partIndex].hits` and recalculates `creep.hits`.
 */
export function setBodyPartHits(creep: Creep, partIndex: number, hits: number): void {
  if (partIndex < 0 || partIndex >= creep.body.length) return;
  const oldHits = creep.body[partIndex].hits;
  creep.body[partIndex].hits = hits;
  creep.hits = creep.hits - oldHits + hits;
}

/**
 * Returns true when every TOUGH part on the creep has 0 hits (i.e. the
 * TOUGH layer is fully broken).
 */
export function isTOUGHLayerBroken(creep: Creep): boolean {
  const toughParts = creep.body.filter((p) => p.type === TOUGH);
  if (toughParts.length === 0) return false;
  return toughParts.every((p) => p.hits <= 0);
}
