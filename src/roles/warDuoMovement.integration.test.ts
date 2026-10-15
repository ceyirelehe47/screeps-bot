import { healerRole } from "@/roles/healer";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearRoutingCachesForTest } from "@/movement/routing";
import { clearRoomTopologyRevisionCacheForTest } from "@/movement/roomTopologyRevision";
import { clearTrafficNaturalObstacleCacheForTest } from "@/movement/traffic";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";
import { RealCostMatrix, resetRuntimeServices } from "@mock/movement";

// 此文件不 mock roles/shared/routing/pathing/traffic。网格 A* 仅适配测试环境的
// PathFinder 与 RoomPosition.findPathTo；它不是官方引擎，不能证明跨房/疲劳模型。
// 搜索读取真实业务 roomCallback/costCallback 矩阵，0xfe 可通行、0xff 阻挡。
const ROOM = "E3N57";
const RED_CONFIG = "E1N57:war:E3N57:meleeAttacker:0";
const GREEN_CONFIG = "E1N57:war:E3N57:healer:0";
const OFFSETS: Array<readonly [number, number]> = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
type Order = "leader-first" | "healer-first";
type Goal = { pos: RoomPosition; range: number };
interface SearchOptions {
  plainCost?: number;
  swampCost?: number;
  maxOps?: number;
  roomCallback?: (roomName: string) => CostMatrix | false | undefined;
}
interface SearchRecord { path: RoomPosition[]; origin: RoomPosition; goal: Goal; matrix: CostMatrix; incomplete: boolean }
let world: DuoWorld;
let nextScenarioTick = 2000;

class GridPosition extends MockPos {
  public getRangeTo(target: any, y?: number): number {
    const point = typeof target === "number" ? { x: target, y: y ?? this.y } : target.pos ?? target;
    return point.roomName && point.roomName !== this.roomName ? Infinity : Math.max(Math.abs(this.x - point.x), Math.abs(this.y - point.y));
  }

  public getDirectionTo(target: any, y?: number): DirectionConstant | null {
    return super.getDirectionTo(typeof target === "number" ? { x: target, y: y ?? this.y } : target);
  }

  public isEqualTo(target: any, y?: number): boolean {
    return super.isEqualTo(typeof target === "number" ? { x: target, y: y ?? this.y } : target.pos ?? target);
  }

  public findPathTo(target: RoomPosition | { pos: RoomPosition } | number, optionsOrY: FindPathOpts | number = {}, numericOptions: FindPathOpts = {}): PathStep[] {
    world.findPathCalls += 1;
    const options = typeof target === "number" ? numericOptions : optionsOrY as FindPathOpts;
    const goal = typeof target === "number" ? position(target, optionsOrY as number) : "pos" in target ? target.pos : target;
    const fallback = new RealCostMatrix() as unknown as CostMatrix;
    // 模拟 findPathTo 的原生 fallback；真实 pathing 回调会返回自己的矩阵，
    // 其中动态实体按业务规则为 0xfe（允许 traffic 处理让位），不能偷偷忽略。
    for (const structure of world.structures) fallback.set(structure.pos.x, structure.pos.y, 0xff);
    if (!options.ignoreCreeps) for (const creep of Object.values(Game.creeps)) {
      if (!this.isEqualTo(creep.pos)) fallback.set(creep.pos.x, creep.pos.y, 0xff);
    }
    const callbackMatrix = options.costCallback?.(ROOM, fallback);
    const matrix = callbackMatrix || fallback;
    const result = gridSearch(this as unknown as RoomPosition, { pos: goal, range: options.range ?? 1 }, {
      plainCost: options.plainCost, swampCost: options.swampCost, maxOps: options.maxOps,
      roomCallback: () => matrix,
    });
    let previous: RoomPosition = this as unknown as RoomPosition;
    return result.path.map(pos => {
      const step = { x: pos.x, y: pos.y, dx: pos.x - previous.x, dy: pos.y - previous.y,
        direction: previous.getDirectionTo(pos) };
      previous = pos;
      return step;
    });
  }

  public findInRange<T extends { pos: RoomPosition }>(targets: T[] | FindConstant, range: number): T[] {
    const values = Array.isArray(targets) ? targets : world.room.find(targets) as unknown as T[];
    return values.filter(target => this.getRangeTo(target) <= range);
  }

  public lookFor(type?: LookConstant): unknown[] {
    if (type === LOOK_STRUCTURES) return world.structures.filter(value => this.isEqualTo(value.pos));
    if (type === LOOK_CREEPS) return Object.values(Game.creeps).filter(value => this.isEqualTo(value.pos));
    return [];
  }
}

function position(x: number, y: number): RoomPosition {
  return new GridPosition(x, y, ROOM) as unknown as RoomPosition;
}

/** 小型确定性 A*，每条返回路径均由 terrain + 调用者矩阵计算，无预设成功路径。 */
function gridSearch(origin: RoomPosition, goal: Goal, options: SearchOptions = {}): PathFinderPath {
  const supplied = options.roomCallback?.(ROOM);
  if (origin.roomName !== ROOM || goal.pos.roomName !== ROOM || supplied === false) {
    return { path: [], ops: 0, cost: 0, incomplete: true };
  }
  const matrix = supplied ?? new RealCostMatrix() as unknown as CostMatrix;
  const key = (x: number, y: number): number => y * 50 + x;
  const distance = (x: number, y: number): number => Math.max(0, Math.max(Math.abs(x - goal.pos.x), Math.abs(y - goal.pos.y)) - goal.range);
  const start = key(origin.x, origin.y);
  const costs = new Map<number, number>([[start, 0]]);
  const previous = new Map<number, number>();
  const open = new Set<number>([start]);
  const closed = new Set<number>();
  let best = start;
  let found = false;
  let ops = 0;
  while (open.size > 0 && ops < (options.maxOps ?? 2500)) {
    let current = -1;
    let priority = Infinity;
    for (const candidate of open) {
      const score = costs.get(candidate)! + distance(candidate % 50, Math.floor(candidate / 50));
      if (score < priority) { current = candidate; priority = score; }
    }
    open.delete(current); closed.add(current); ops += 1;
    const x = current % 50, y = Math.floor(current / 50);
    if (distance(x, y) < distance(best % 50, Math.floor(best / 50))) best = current;
    if (distance(x, y) === 0) { best = current; found = true; break; }
    for (const [dx, dy] of OFFSETS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49 || world.terrain(nx, ny) === TERRAIN_MASK_WALL || matrix.get(nx, ny) === 0xff) continue;
      const next = key(nx, ny);
      if (closed.has(next)) continue;
      const cellCost = matrix.get(nx, ny) || (world.terrain(nx, ny) === TERRAIN_MASK_SWAMP ? options.swampCost ?? 10 : options.plainCost ?? 2);
      const nextCost = costs.get(current)! + cellCost;
      if (nextCost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, nextCost); previous.set(next, current); open.add(next);
    }
  }
  const path: RoomPosition[] = [];
  for (let cell = best; cell !== start; cell = previous.get(cell)!) {
    path.push(position(cell % 50, Math.floor(cell / 50)));
  }
  path.reverse();
  world.searches.push({ origin, goal, path, matrix, incomplete: !found });
  return { path, ops, cost: costs.get(best) ?? 0, incomplete: !found };
}

class DuoWorld {
  public readonly structures: Structure[] = [];
  public readonly room: Room;
  public readonly red: Creep;
  public readonly green: Creep;
  public readonly core: Structure;
  public readonly searches: SearchRecord[] = [];
  public readonly frames: Array<{ red: RoomPosition; green: RoomPosition }> = [];
  public findPathCalls = 0;
  public successfulHeals = 0;
  private pending = new Map<Creep, DirectionConstant>();
  private attacks: Array<{ target: Structure; damage: number }> = [];
  private heals: Creep[] = [];

  public terrain(x: number, y: number): number {
    return x < 10 || x > 28 || y < 16 || y > 26 ? TERRAIN_MASK_WALL : 0;
  }

  public constructor(public readonly order: Order) {
    world = this;
    Object.assign(global, { RoomPosition: GridPosition, PathFinder: { CostMatrix: RealCostMatrix, search: gridSearch } });
    Game.time = nextScenarioTick;
    nextScenarioTick += 100;
    Game.creeps = {}; Game.powerCreeps = {}; Game.spawns = {};
    Memory.cfg = {}; Memory.runtime = {}; Memory.data = {}; Memory.creeps = {};
    const terrain = { get: (x: number, y: number) => this.terrain(x, y) } as RoomTerrain;
    this.room = { name: ROOM, getTerrain: () => terrain,
      lookAt: (x: number, y: number) => [
        { type: LOOK_TERRAIN, terrain: this.terrain(x, y) === TERRAIN_MASK_WALL ? "wall" : "plain" },
        ...this.structures.filter(value => value.pos.x === x && value.pos.y === y)
          .map(structure => ({ type: LOOK_STRUCTURES, structure })),
        ...Object.values(Game.creeps).filter(value => value.pos.x === x && value.pos.y === y)
          .map(creep => ({ type: LOOK_CREEPS, creep })),
      ],
      find: (kind: FindConstant, options?: { filter?: (value: any) => boolean }) => {
        let values: any[] = [];
        if (kind === FIND_STRUCTURES) values = this.structures;
        if (kind === FIND_HOSTILE_STRUCTURES) values = this.structures.filter(value => value.structureType !== STRUCTURE_WALL);
        if (kind === FIND_CREEPS || kind === FIND_MY_CREEPS) values = Object.values(Game.creeps);
        return options?.filter ? values.filter(options.filter) : values;
      },
    } as unknown as Room;
    Game.rooms = { [ROOM]: this.room };
    Game.map = { ...Game.map, getRoomTerrain: () => terrain, getRoomStatus: () => ({ status: "normal", timestamp: null }),
      describeExits: () => null, getWorldSize: () => 200 } as GameMap;
    this.core = this.structure("core", STRUCTURE_SPAWN, 24, 20);
    // 唯一通道在 (17,23)；上下不能从地图边缘绕过，必须走弯道。
    for (let y = 16; y <= 26; y += 1) if (y !== 23) this.structure(`wall-${y}`, STRUCTURE_WALL, 17, y);
    this.red = this.creep("red", "meleeAttacker", 13, 20, RED_CONFIG, GREEN_CONFIG);
    this.green = this.creep("green", "healer", 12, 20, GREEN_CONFIG, RED_CONFIG);
    Game.creeps = order === "leader-first" ? { red: this.red, green: this.green } : { green: this.green, red: this.red };
    Game.getObjectById = ((id: string) => this.structures.find(value => value.id === id) ?? Object.values(Game.creeps).find(value => value.id === id) ?? null) as typeof Game.getObjectById;
    registerRuntimeServices();
  }

  private structure(id: string, structureType: StructureConstant, x: number, y: number): Structure {
    const structure = { id, structureType, pos: position(x, y), room: this.room, hits: 1_000_000, hitsMax: 1_000_000 } as Structure;
    this.structures.push(structure);
    return structure;
  }

  private creep(name: string, role: string, x: number, y: number, configName = "", partner = ""): Creep {
    const creep = createMockPowerBankCreep(role, { name, roomName: ROOM, x, y,
      memory: { configName, _warPartnerConfigName: partner }, hits: 3900, hitsMax: 4000 });
    creep.pos = position(x, y); creep.room = this.room;
    creep.move = jest.fn((direction: DirectionConstant) => {
      if (creep.fatigue > 0) return ERR_TIRED;
      if (!OFFSETS[direction - 1]) return ERR_INVALID_ARGS;
      this.pending.set(creep, direction);
      return OK;
    }) as unknown as Creep["move"];
    creep.cancelOrder = jest.fn((method: string) => { if (method === "move") this.pending.delete(creep); return OK; }) as unknown as Creep["cancelOrder"];
    creep.attack = jest.fn((target: Structure) => {
      if (creep.pos.getRangeTo(target.pos) > 1) return ERR_NOT_IN_RANGE;
      this.attacks.push({ target, damage: ATTACK_POWER }); return OK;
    }) as unknown as Creep["attack"];
    const heal = (target: Creep, range: number): ScreepsReturnCode => {
      if (creep.pos.getRangeTo(target.pos) > range) return ERR_NOT_IN_RANGE;
      this.heals.push(target); return OK;
    };
    creep.heal = jest.fn((target: Creep) => heal(target, 1)) as unknown as Creep["heal"];
    creep.rangedHeal = jest.fn((target: Creep) => heal(target, 3)) as unknown as Creep["rangedHeal"];
    return creep;
  }

  public addBlocker(): void {
    const blocker = this.creep("blocker", "worker", 17, 23);
    blocker.fatigue = 100; // 不能被 traffic 的被动让位推开。
    Game.creeps.blocker = blocker;
  }

  public step(): void {
    const redRole = meleeAttackerRole(ROOM, "", "", "", GREEN_CONFIG);
    const greenRole = healerRole(ROOM, "", "", "", RED_CONFIG);
    if (this.order === "leader-first") { redRole.target(this.red); greenRole.target(this.green); }
    else { greenRole.target(this.green); redRole.target(this.red); }
    this.settle();
    this.frames.push({ red: this.red.pos, green: this.green.pos });
    Game.time += 1;
  }

  /** 帧末一起结算：墙/地形、重复落点、静止实体阻挡；允许合法跟随空出的格。 */
  private settle(): void {
    const moves = new Map<Creep, RoomPosition>();
    for (const [creep, direction] of this.pending) {
      const [dx, dy] = OFFSETS[direction - 1];
      const next = position(creep.pos.x + dx, creep.pos.y + dy);
      // 本场景的结构只有墙与敌方 Spawn，全部物理阻挡；没有道路/公共 Rampart。
      if (this.terrain(next.x, next.y) === TERRAIN_MASK_WALL || this.structures.some(value => value.pos.isEqualTo(next))) continue;
      moves.set(creep, next);
    }
    const conflicts = [...moves].filter(([creep, next]) => [...moves].some(([other, target]) => other !== creep && next.isEqualTo(target)))
      .map(([creep]) => creep);
    for (const creep of conflicts) moves.delete(creep);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [creep, next] of moves) {
        const occupant = Object.values(Game.creeps).find(other => other !== creep && other.pos.isEqualTo(next));
        if (occupant && !moves.has(occupant)) { moves.delete(creep); changed = true; }
      }
    }
    for (const [creep, next] of moves) creep.pos = next;
    for (const { target, damage } of this.attacks) target.hits -= damage;
    for (const target of this.heals) { target.hits = Math.min(target.hitsMax, target.hits + HEAL_POWER); this.successfulHeals += 1; }
    this.pending.clear(); this.attacks = []; this.heals = [];
    const occupied = Object.values(Game.creeps).map(creep => `${creep.pos.x}:${creep.pos.y}`);
    expect(new Set(occupied).size).toBe(occupied.length);
  }
}

function verifyFrame(w: DuoWorld): void {
  expect(w.red.pos.isNearTo(w.green.pos)).toBe(true);
  for (const creep of [w.red, w.green]) {
    expect(w.terrain(creep.pos.x, creep.pos.y)).not.toBe(TERRAIN_MASK_WALL);
    expect(w.structures.some(value => value.pos.isEqualTo(creep.pos))).toBe(false);
  }
  // 允许有目的的弯道；不允许 A→B→A 的相邻 tick 无故折返。
  if (w.frames.length >= 3) for (const name of ["red", "green"] as const) {
    const [a, b, c] = w.frames.slice(-3).map(frame => frame[name]);
    if (!a.isEqualTo(b)) expect(c.isEqualTo(a)).toBe(false);
  }
}

describe("war duo 真实角色与共享移动的多 tick 集成", () => {
  beforeEach(() => {
    resetRuntimeServices(); clearCreepMovementStateForTest(); clearRoutingCachesForTest();
    clearRoomTopologyRevisionCacheForTest(); clearTrafficNaturalObstacleCacheForTest(); clearMovementAnalyticsForTest();
  });

  it.each(["leader-first", "healer-first"] as const)("%s 从弯通道抵达核心，绿持续贴随且墙血量不变", order => {
    const w = new DuoWorld(order);
    for (let tick = 0; tick < 25 && w.red.pos.getRangeTo(w.core.pos) > 1; tick += 1) { w.step(); verifyFrame(w); }
    expect(w.frames.length).toBeGreaterThanOrEqual(5);
    expect(w.red.pos.getRangeTo(w.core.pos)).toBeLessThanOrEqual(1);
    expect(w.frames.some(frame => frame.red.x === 17 && frame.red.y === 23)).toBe(true);
    expect(w.findPathCalls).toBeGreaterThan(0);
    expect(w.successfulHeals).toBeGreaterThanOrEqual(5);
    expect(w.structures.filter(value => value.structureType === STRUCTURE_WALL).every(value => value.hits === 1_000_000)).toBe(true);
    expect(w.searches.every(search => {
      let previous = search.origin;
      return search.path.every(pos => { const valid = previous.getRangeTo(pos) === 1 && search.matrix.get(pos.x, pos.y) !== 0xff; previous = pos; return valid; });
    })).toBe(true);
  });

  it.each(["leader-first", "healer-first"] as const)("%s 通道被实体占位两 tick 时等待，解除后沿真实路径继续", order => {
    const w = new DuoWorld(order);
    for (let tick = 0; tick < 15 && w.red.pos.x < 16; tick += 1) { w.step(); verifyFrame(w); }
    expect(w.red.pos.x).toBe(16);
    w.addBlocker();
    const held = { red: w.red.pos, green: w.green.pos };
    for (let tick = 0; tick < 2; tick += 1) {
      w.step(); verifyFrame(w);
      expect(w.red.pos.isEqualTo(held.red)).toBe(true);
      expect(w.green.pos.isEqualTo(held.green)).toBe(true);
    }
    delete Game.creeps.blocker;
    for (let tick = 0; tick < 25 && w.red.pos.getRangeTo(w.core.pos) > 1; tick += 1) { w.step(); verifyFrame(w); }
    expect(w.red.pos.getRangeTo(w.core.pos)).toBeLessThanOrEqual(1);
    expect(w.structures.filter(value => value.structureType === STRUCTURE_WALL).every(value => value.hits === 1_000_000)).toBe(true);
  });
});
