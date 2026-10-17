import { appendFileSync } from "node:fs";
import { healerRole } from "@/roles/healer";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { towerDrainPairRange } from "@/roles/towerDrainPair";
import { clearWarGeometryForTest } from "@/roles/warGeometry";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearRoutingCachesForTest } from "@/movement/routing";
import { clearRoomTopologyRevisionCacheForTest } from "@/movement/roomTopologyRevision";
import { clearTrafficNaturalObstacleCacheForTest } from "@/movement/traffic";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";
import { RealCostMatrix, resetRuntimeServices } from "@mock/movement";

// 此文件不 mock roles/shared/routing/pathing/traffic。网格 A* 仅适配测试环境的
// PathFinder 与 RoomPosition.findPathTo；双房只模拟北边界移动→迁房，不生成疲劳或塔伤。
// 它不是官方引擎；塔伤/退路约束由真实业务门计算，不能据此证明完整引擎战斗模型。
// 搜索读取真实业务 roomCallback/costCallback 矩阵，0xfe 可通行、0xff 阻挡。
const ROOM = "E3N57";
const RETREAT = "E3N58";
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
interface EntryGeometry { left: number; right: number; wallY: number; coreX: number; coreY: number; alternateLeft?: number; alternateRight?: number }
interface DrainScenario { geometry: EntryGeometry; openGap?: boolean; towerEnergy?: number }
interface DuoFrame {
  tick: number; red: RoomPosition; green: RoomPosition;
  drain?: { phase: string; blocker?: string; pending?: true; entry?: { x: number; y: number }; healerEntry?: { x: number; y: number } };
  intents: Array<{ name: string; direction: DirectionConstant }>;
  fatigue: { red: number; green: number }; blockers: number;
  objectiveKey: string; obstacleKey: string;
}
let world: DuoWorld;
let nextScenarioTick = 2000;
let matrixConstructions = 0;
class CountingCostMatrix extends RealCostMatrix {
  constructor() { super(); matrixConstructions++; }
  public clone(): CountingCostMatrix { const copy = new CountingCostMatrix(); for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) copy.set(x, y, this.get(x, y)); return copy; }
}


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
    if (world.red?.pos === this as unknown as RoomPosition) world.redFindPathCalls += 1;
    const options = typeof target === "number" ? numericOptions : optionsOrY as FindPathOpts;
    const goal = typeof target === "number" ? position(target, optionsOrY as number, this.roomName) : "pos" in target ? target.pos : target;
    const fallback = new RealCostMatrix() as unknown as CostMatrix;
    // 模拟 findPathTo 的原生 fallback；真实 pathing 回调会返回自己的矩阵，
    // 其中动态实体按业务规则为 0xfe（允许 traffic 处理让位），不能偷偷忽略。
    for (const structure of world.structures.filter(value => value.pos.roomName === this.roomName)) fallback.set(structure.pos.x, structure.pos.y, 0xff);
    if (!options.ignoreCreeps) for (const creep of Object.values(Game.creeps)) {
      if (creep.pos.roomName === this.roomName && !this.isEqualTo(creep.pos)) fallback.set(creep.pos.x, creep.pos.y, 0xff);
    }
    const callbackMatrix = options.costCallback?.(this.roomName, fallback);
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
    const values = Array.isArray(targets) ? targets : Game.rooms[this.roomName].find(targets) as unknown as T[];
    return values.filter(target => this.getRangeTo(target) <= range);
  }

  public lookFor(type?: LookConstant): unknown[] {
    if (type === LOOK_STRUCTURES) return world.structures.filter(value => this.isEqualTo(value.pos));
    if (type === LOOK_CREEPS) return Object.values(Game.creeps).filter(value => this.isEqualTo(value.pos));
    return [];
  }
}

function position(x: number, y: number, roomName = ROOM): RoomPosition {
  return new GridPosition(x, y, roomName) as unknown as RoomPosition;
}

/** 小型确定性 A*，每条返回路径均由 terrain + 调用者矩阵计算，无预设成功路径。 */
function gridSearch(origin: RoomPosition, goal: Goal, options: SearchOptions = {}): PathFinderPath {
  const supplied = options.roomCallback?.(origin.roomName);
  if (!Game.rooms[origin.roomName] || goal.pos.roomName !== origin.roomName || supplied === false) {
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
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49 || world.terrain(nx, ny, origin.roomName) === TERRAIN_MASK_WALL || matrix.get(nx, ny) === 0xff) continue;
      const next = key(nx, ny);
      if (closed.has(next)) continue;
      const cellCost = matrix.get(nx, ny) || (world.terrain(nx, ny, origin.roomName) === TERRAIN_MASK_SWAMP ? options.swampCost ?? 10 : options.plainCost ?? 2);
      const nextCost = costs.get(current)! + cellCost;
      if (nextCost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, nextCost); previous.set(next, current); open.add(next);
    }
  }
  const path: RoomPosition[] = [];
  for (let cell = best; cell !== start; cell = previous.get(cell)!) {
    path.push(position(cell % 50, Math.floor(cell / 50), origin.roomName));
  }
  path.reverse();
  world.searches.push({ origin, goal, path, matrix: matrix.clone(), incomplete: !found });
  return { path, ops, cost: costs.get(best) ?? 0, incomplete: !found };
}

class DuoWorld {
  public readonly structures: Structure[] = [];
  public readonly room: Room;
  public readonly red: Creep;
  public readonly green: Creep;
  public readonly core: Structure;
  public readonly searches: SearchRecord[] = [];
  public readonly frames: DuoFrame[] = [];
  public findPathCalls = 0;
  public redFindPathCalls = 0;
  public pathFinderCalls = 0;
  public terrainReads = 0;
  private pending = new Map<Creep, DirectionConstant>();
  private attacks: Array<{ target: Structure; damage: number }> = [];
  private heals: Creep[] = [];

  public terrain(x: number, y: number, roomName = ROOM): number {
    if (this.scenario) {
      const g = this.scenario.geometry;
      if (g.alternateLeft !== undefined && g.alternateRight !== undefined) {
        const inDeadEntry = x >= g.left && x <= g.right;
        const inOpenEntry = x >= g.alternateLeft && x <= g.alternateRight;
        if (roomName === RETREAT) return y === 48 && x >= g.alternateLeft && x <= g.right
          || y === 49 && (inDeadEntry || inOpenEntry) ? 0 : TERRAIN_MASK_WALL;
        if (y < g.wallY) return inDeadEntry || inOpenEntry ? 0 : TERRAIN_MASK_WALL;
        // 封住墙端的对角漏口；Screeps允许8邻移动，不能从袋侧斜跨到墙排之外。
        if (y === g.wallY && x === g.left - 1) return TERRAIN_MASK_WALL;
        return x < g.alternateLeft || x > g.right || y > g.coreY + 2 ? TERRAIN_MASK_WALL : 0;
      }
      return x < g.left || x > g.right || y < 0 || y > g.coreY + 2 ? TERRAIN_MASK_WALL : 0;
    }
    return x < 10 || x > 28 || y < 16 || y > 26 ? TERRAIN_MASK_WALL : 0;
  }

  public constructor(public readonly order: Order, private readonly scenario?: DrainScenario) {
    clearWarGeometryForTest();
    world = this; matrixConstructions = 0;
    Object.assign(global, { RoomPosition: GridPosition, PathFinder: { CostMatrix: CountingCostMatrix, search: (...args: Parameters<typeof gridSearch>) => { this.pathFinderCalls++; return gridSearch(...args); } } });
    Game.time = nextScenarioTick;
    nextScenarioTick += 100;
    Game.creeps = {}; Game.powerCreeps = {}; Game.spawns = {};
    Memory.cfg = {}; Memory.runtime = {}; Memory.data = {}; Memory.creeps = {};
    const roomFor = (name: string): Room => ({ name, getTerrain: () => ({ get: (x: number, y: number) => { this.terrainReads++; return this.terrain(x, y, name); } }),
      lookAt: (x: number, y: number) => [
        { type: LOOK_TERRAIN, terrain: this.terrain(x, y, name) === TERRAIN_MASK_WALL ? "wall" : "plain" },
        ...this.structures.filter(value => value.pos.roomName === name && value.pos.x === x && value.pos.y === y)
          .map(structure => ({ type: LOOK_STRUCTURES, structure })),
        ...Object.values(Game.creeps).filter(value => value.pos.roomName === name && value.pos.x === x && value.pos.y === y)
          .map(creep => ({ type: LOOK_CREEPS, creep })),
      ],
      find: (kind: FindConstant, options?: { filter?: (value: any) => boolean }) => {
        let values: any[] = [];
        if (kind === FIND_STRUCTURES) values = this.structures.filter(value => value.pos.roomName === name);
        if (kind === FIND_HOSTILE_STRUCTURES) values = this.structures.filter(value => value.pos.roomName === name && value.structureType !== STRUCTURE_WALL);
        if (kind === FIND_CREEPS || kind === FIND_MY_CREEPS) values = Object.values(Game.creeps).filter(value => value.pos.roomName === name);
        return options?.filter ? values.filter(options.filter) : values;
      },
    } as unknown as Room);
    this.room = roomFor(ROOM);
    Game.rooms = { [ROOM]: this.room };
    if (scenario?.geometry.alternateLeft !== undefined) Game.rooms[RETREAT] = roomFor(RETREAT);
    Game.map = { ...Game.map, getRoomTerrain: (name: string) => ({ get: (x: number, y: number) => { this.terrainReads++; return this.terrain(x, y, name); } }), getRoomStatus: () => ({ status: "normal", timestamp: null }),
      describeExits: (name: string) => scenario ? name === ROOM ? { [TOP]: RETREAT } : name === RETREAT ? { [BOTTOM]: ROOM } : null : null,
      getWorldSize: () => 200 } as GameMap;
    if (scenario) {
      const g = scenario.geometry;
      const middle = Math.floor((g.left + g.right) / 2);
      this.core = this.structure("core", STRUCTURE_SPAWN, g.coreX, g.coreY);
      for (let x = g.left; x <= g.right; x += 1) {
        if (scenario.openGap && x === middle) continue;
        this.structure(`wall-${x}`, STRUCTURE_WALL, x, g.wallY).hits = 2 * 25 * ATTACK_POWER;
      }
      const tower = this.structure("tower", STRUCTURE_TOWER, g.left, g.wallY + 2) as StructureTower;
      tower.store = createMockStore({ [RESOURCE_ENERGY]: scenario.towerEnergy ?? 0 }, TOWER_CAPACITY) as unknown as StructureTower["store"];
      this.red = this.creep("red", "meleeAttacker", middle, g.wallY - 2, RED_CONFIG, GREEN_CONFIG);
      this.green = this.creep("green", "healer", middle + 1, g.wallY - 2, GREEN_CONFIG, RED_CONFIG);
      const drainState = { targetRoom: ROOM, phase: "breaching" as const, retreatRoom: RETREAT, exitDirection: TOP,
        attackerEntry: { x: middle, y: 0 }, healerEntry: { x: middle + 1, y: 0 } };
      for (const member of [this.red, this.green]) {
        member.hits = member.hitsMax = 5000;
        member.memory._warTowerDrain = { ...drainState };
      }
      // 共享巡逻不把中立墙当独立清场目标；墙仍是物理障碍，可作为核心路线的必要破障。
      Memory.data.war = { [ROOM]: { sourceRoom: "E1N57", targetRoom: ROOM, sharedSquadWatchId: "patrol",
        status: "clearing", reason: "manual", attempts: 1, createdAt: Game.time, updatedAt: Game.time } };
    } else {
      this.core = this.structure("core", STRUCTURE_SPAWN, 24, 20);
      // 唯一通道在 (17,23)；上下不能从地图边缘绕过，必须走弯道。
      for (let y = 16; y <= 26; y += 1) if (y !== 23) this.structure(`wall-${y}`, STRUCTURE_WALL, 17, y);
      this.red = this.creep("red", "meleeAttacker", 13, 20, RED_CONFIG, GREEN_CONFIG);
      this.green = this.creep("green", "healer", 12, 20, GREEN_CONFIG, RED_CONFIG);
    }
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
      ...(this.scenario ? { body: [...Array<BodyPartConstant>(25).fill(role === "healer" ? HEAL : ATTACK), ...Array<BodyPartConstant>(25).fill(MOVE)].map(type => ({ type, hits: 100 })) } : {}),
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
      this.attacks.push({ target, damage: creep.getActiveBodyparts(ATTACK) * ATTACK_POWER }); return OK;
    }) as unknown as Creep["attack"];
    const heal = (target: Creep, range: number): ScreepsReturnCode => {
      if (creep.pos.getRangeTo(target.pos) > range) return ERR_NOT_IN_RANGE;
      this.heals.push(target); return OK;
    };
    creep.heal = jest.fn((target: Creep) => heal(target, 1)) as unknown as Creep["heal"];
    creep.rangedHeal = jest.fn((target: Creep) => heal(target, 3)) as unknown as Creep["rangedHeal"];
    return creep;
  }

  public addRing(): void {
    for (let x = 21; x <= 27; x++) for (let y = 17; y <= 23; y++) {
      if ((x === 21 || x === 27 || y === 17 || y === 23) && !(x === 27 && y === 20)) this.structure(`ring-${x}-${y}`, STRUCTURE_WALL, x, y);
    }
  }
  public blockRingGap(): void {
    const blocker = this.creep("blocker-gap", "worker", 27, 20);
    blocker.fatigue = 100; Game.creeps[blocker.name] = blocker;
  }
  public addBlocker(): void {
    const blocker = this.creep("blocker", "worker", 17, 23);
    blocker.fatigue = 100; // 不能被 traffic 的被动让位推开。
    Game.creeps.blocker = blocker;
  }

  public blockAttackRow(): void {
    const g = this.scenario!.geometry;
    for (let x = g.left; x <= g.right; x += 1) {
      const name = `blocker-${x}`;
      const blocker = this.creep(name, "worker", x, g.wallY - 1);
      blocker.fatigue = 100;
      Game.creeps[name] = blocker;
    }
  }

  public removeBlockers(): void {
    for (const name of Object.keys(Game.creeps)) if (name.startsWith("blocker-")) delete Game.creeps[name];
  }

  public blockAlternativeStaging(): void {
    const g = this.scenario!.geometry;
    for (let x = g.alternateLeft!; x <= g.alternateRight!; x += 1) {
      const name = `blocker-${x}`;
      const blocker = this.creep(name, "worker", x, 48);
      blocker.pos = position(x, 48, RETREAT); blocker.room = Game.rooms[RETREAT]; blocker.fatigue = 100;
      Game.creeps[name] = blocker;
    }
  }

  public hasPhysicalCoreRouteFrom(origin: RoomPosition): boolean {
    const matrix = new RealCostMatrix() as unknown as CostMatrix;
    for (const structure of this.structures) if (structure.pos.roomName === origin.roomName) matrix.set(structure.pos.x, structure.pos.y, 0xff);
    return !gridSearch(origin, { pos: this.core.pos, range: 1 }, { maxOps: 2000, roomCallback: () => matrix }).incomplete;
  }

  public step(): void {
    const tactic = this.scenario ? "towerDrainDuo" : undefined;
    const redRole = meleeAttackerRole(ROOM, "", "", "", GREEN_CONFIG, tactic);
    const greenRole = healerRole(ROOM, "", "", "", RED_CONFIG, tactic);
    if (this.order === "leader-first") { redRole.target(this.red); greenRole.target(this.green); }
    else { greenRole.target(this.green); redRole.target(this.red); }
    const intents = [...this.pending].map(([creep, direction]) => ({ name: creep.name, direction }));
    this.settle();
    const state = this.red.memory._warTowerDrain as (NonNullable<CreepMemory["_warTowerDrain"]> & { reselectRequested?: true }) | undefined;
    this.frames.push({ tick: Game.time, red: this.red.pos, green: this.green.pos, intents,
      fatigue: { red: this.red.fatigue, green: this.green.fatigue }, blockers: Object.keys(Game.creeps).filter(name => name.startsWith("blocker-")).length, drain: state && {
      phase: state.phase, blocker: state.blocker, pending: state.reselectRequested, entry: state.attackerEntry, healerEntry: state.healerEntry,
    }, objectiveKey: JSON.stringify([state?.phase, state?.reselectRequested, state?.attackerEntry, state?.healerEntry, this.red.memory._warBreachTargetId ?? this.core.id]),
    obstacleKey: JSON.stringify([
      this.structures.map(value => [value.id, value.pos.roomName, value.pos.x, value.pos.y, value.structureType]),
      Object.values(Game.creeps).filter(value => value !== this.red && value !== this.green)
        .map(value => [value.name, value.pos.roomName, value.pos.x, value.pos.y, value.fatigue]),
    ]) });
    if (process.env.WAR_AB_TRACE) appendFileSync(process.env.WAR_AB_TRACE, JSON.stringify({
      test: expect.getState().currentTestName, frame: this.frames[this.frames.length - 1],
      attacks: (this.red.attack as jest.Mock).mock.calls.map(([target]: [Structure]) => target.id),
      searches: this.searches.length, pathFinderCalls: this.pathFinderCalls, findPathCalls: this.findPathCalls, matrices: matrixConstructions, terrainReads: this.terrainReads,
    }) + "\n");
    Game.time += 1;
  }

  /** 帧末一起结算：墙/地形、重复落点、静止实体阻挡；允许合法跟随空出的格。 */
  private settle(): void {
    const moves = new Map<Creep, RoomPosition>();
    for (const creep of Object.values(Game.creeps)) {
      const direction = this.pending.get(creep);
      const [dx, dy] = direction ? OFFSETS[direction - 1] : [0, 0];
      const rawX = creep.pos.x + dx, rawY = creep.pos.y + dy;
      // 原生任轴越界会忽略整条move，再按原坐标执行edge迁房；不能逐轴clamp后偷移另一轴。
      // https://github.com/screeps/engine/blob/a90d26fc9eb943147799e65d0bf9d4d0d79a2722/src/processor/intents/creeps/move.js#L24-L40
      // 无intent仍迁房：https://github.com/screeps/engine/blob/a90d26fc9eb943147799e65d0bf9d4d0d79a2722/src/processor/intents/creeps/tick.js#L45-L70
      const next = rawX < 0 || rawX > 49 || rawY < 0 || rawY > 49 ? creep.pos : position(rawX, rawY, creep.room.name);
      // 本场景只有墙、敌方 Spawn/Tower，全部物理阻挡；没有道路/公共 Rampart。
      if (this.terrain(next.x, next.y, next.roomName) === TERRAIN_MASK_WALL || this.structures.some(value => value.pos.isEqualTo(next))) continue;
      if (next.isEqualTo(creep.pos)) continue;
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
    for (const [creep, next] of moves) { creep.pos = next; creep.room = Game.rooms[next.roomName]; }
    // movement.execute(含撞墙/碰撞失败)全部结算后，再独立检查edge；失败或没有intent也会迁房。
    // https://github.com/screeps/engine/blob/a90d26fc9eb943147799e65d0bf9d4d0d79a2722/src/processor/intents/creeps/tick.js#L45-L70
    if (this.scenario?.geometry.alternateLeft !== undefined) for (const creep of Object.values(Game.creeps)) {
      if (creep.pos.roomName === ROOM && creep.pos.y === 0) creep.pos = position(creep.pos.x, 49, RETREAT);
      else if (creep.pos.roomName === RETREAT && creep.pos.y === 49) creep.pos = position(creep.pos.x, 0);
      creep.room = Game.rooms[creep.pos.roomName];
    }
    for (const { target, damage } of this.attacks) target.hits -= damage;
    for (let i = this.structures.length - 1; i >= 0; i -= 1) if (this.structures[i].hits <= 0) this.structures.splice(i, 1);
    for (const target of this.heals) target.hits = Math.min(target.hitsMax, target.hits + this.green.getActiveBodyparts(HEAL) * HEAL_POWER);
    this.pending.clear(); this.attacks = []; this.heals = [];
    const occupied = Object.values(Game.creeps).map(creep => `${creep.pos.roomName}:${creep.pos.x}:${creep.pos.y}`);
    expect(new Set(occupied).size).toBe(occupied.length);
  }
}

/** 绿已到自己的集结格，交换让红穿过，再回原目标；双方整体更接近固定集结目标。 */
function isPurposefulSourceStageYield(name: "red" | "green", recent: DuoFrame[]): boolean {
  if (name !== "green" || !recent.every(frame => frame.red.roomName === RETREAT && frame.green.roomName === RETREAT
    && frame.drain?.phase === "approach" && !frame.drain?.pending)) return false;
  const [first, middle, last] = recent;
  const redEntry = first.drain?.entry, greenEntry = first.drain?.healerEntry;
  if (!redEntry || !greenEntry) return false;
  const redStage = position(redEntry.x, 48, RETREAT), greenStage = position(greenEntry.x, 48, RETREAT);
  const redDistances = recent.map(frame => frame.red.getRangeTo(redStage));
  const totalDistance = (frame: DuoFrame): number => frame.red.getRangeTo(redStage) + frame.green.getRangeTo(greenStage);
  return first.green.isEqualTo(greenStage) && last.green.isEqualTo(greenStage)
    && middle.red.isEqualTo(first.green) && middle.green.isEqualTo(first.red)
    && redDistances[0] > redDistances[1] && redDistances[1] > redDistances[2]
    && totalDistance(last) < totalDistance(first);
}

function verifyFrame(w: DuoWorld): void {
  expect(towerDrainPairRange(w.red.pos, w.green.pos)).toBeLessThanOrEqual(1);
  for (const creep of [w.red, w.green]) {
    expect(w.terrain(creep.pos.x, creep.pos.y, creep.pos.roomName)).not.toBe(TERRAIN_MASK_WALL);
    expect(w.structures.some(value => value.pos.isEqualTo(creep.pos))).toBe(false);
  }
  // 只在三帧目标和物理阻挡都稳定时判无故折返；插入/解除阻挡或重选入口可有单次调整。
  if (w.frames.length >= 3) for (const name of ["red", "green"] as const) {
    const recent = w.frames.slice(-3);
    const [a, b, c] = recent.map(frame => frame[name]);
    if (recent.every(frame => frame.objectiveKey === recent[0].objectiveKey && frame.obstacleKey === recent[0].obstacleKey)
      && !a.isEqualTo(b) && c.isEqualTo(a)) {
      expect(isPurposefulSourceStageYield(name, recent) ? null : { name, frames: w.frames.slice(-4) }).toBeNull();
    }
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
    expect(w.pathFinderCalls).toBeGreaterThan(0);
    expect(w.structures.filter(value => value.structureType === STRUCTURE_WALL).every(value => value.hits === 1_000_000)).toBe(true);
    expect(w.searches.every(search => {
      let previous = search.origin;
      return search.path.every(pos => { const valid = previous.getRangeTo(pos) === 1 && search.matrix.get(pos.x, pos.y) !== 0xff; previous = pos; return valid; });
    })).toBe(true);
  });

  it.each(["leader-first", "healer-first"] as const)("%s 通过环墙远端单格洞口；占位解除后继续且不重复findPathTo", order => {
    const w = new DuoWorld(order); w.addRing(); w.blockRingGap();
    for (let tick = 0; tick < 35 && w.red.pos.getRangeTo(position(27, 20)) > 1; tick++) { w.step(); verifyFrame(w); }
    for (let tick = 0; tick < 2; tick++) { w.step(); verifyFrame(w); }
    expect(w.red.pos.getRangeTo(w.core.pos)).toBeGreaterThan(1);
    expect(w.structures.filter(s => s.structureType === STRUCTURE_WALL).every(s => s.hits === 1_000_000)).toBe(true);
    w.removeBlockers();
    for (let tick = 0; tick < 40 && w.red.pos.getRangeTo(w.core.pos) > 1; tick++) { w.step(); verifyFrame(w); }
    expect(w.red.pos.getRangeTo(w.core.pos)).toBeLessThanOrEqual(1);
    expect(w.frames.some(frame => frame.red.x === 27 && frame.red.y === 20)).toBe(true);
    expect(w.redFindPathCalls).toBe(0);
    expect(w.structures.filter(s => s.structureType === STRUCTURE_WALL).every(s => s.hits === 1_000_000)).toBe(true);
  });

  it.each(["leader-first", "healer-first"] as const)("%s 动态实体不降低敌方rampart硬阻挡，仍通过真实洞口", order => {
    const w = new DuoWorld(order);
    const barrier = w.structures.find(value => value.pos.x === 17 && value.pos.y === 20)!;
    (barrier as unknown as { structureType: StructureConstant }).structureType = STRUCTURE_RAMPART;
    const enemy = { name: "enemy-power", pos: barrier.pos, room: w.room } as PowerCreep;
    const originalFind = w.room.find;
    w.room.find = ((kind: FindConstant, options?: unknown) => kind === FIND_HOSTILE_POWER_CREEPS
      ? [enemy] : originalFind(kind, options as never)) as Room["find"];
    for (let tick = 0; tick < 30 && w.red.pos.getRangeTo(w.core.pos) > 1; tick++) { w.step(); verifyFrame(w); }
    expect(w.red.pos.getRangeTo(w.core.pos)).toBeLessThanOrEqual(1);
    const openSearch = w.searches.find(search => search.goal.pos.isEqualTo(w.core.pos));
    expect(openSearch).toBeDefined();
    expect(openSearch!.matrix.get(17, 20)).toBe(0xff);
    expect(w.frames.some(frame => frame.red.x === 17 && frame.red.y === 23)).toBe(true);
    expect(barrier.hits).toBe(1_000_000);
    expect(w.redFindPathCalls).toBe(0);
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

  it.each([
    { order: "leader-first" as const, geometry: { left: 12, right: 16, wallY: 3, coreX: 13, coreY: 9 } },
    { order: "healer-first" as const, geometry: { left: 12, right: 16, wallY: 3, coreX: 13, coreY: 9 } },
    { order: "leader-first" as const, geometry: { left: 31, right: 37, wallY: 4, coreX: 36, coreY: 12 } },
    { order: "healer-first" as const, geometry: { left: 31, right: 37, wallY: 4, coreX: 36, coreY: 12 } },
  ].flatMap(scenario => [false, true].map(openGap => ({ ...scenario, openGap }))))("$order towerDrain 必要突破与开放缺口使用真实安全门（入口 $geometry.left，缺口 $openGap）", ({ order, geometry, openGap }) => {
    // 活塔当前伤害超过治疗时，真实门必须先撤退；突破规划不能授予移动/攻击许可。
    const unsafe = new DuoWorld(order, { geometry, towerEnergy: TOWER_CAPACITY });
    const unsafeWalls = unsafe.structures.filter(value => value.structureType === STRUCTURE_WALL);
    const beforeY = unsafe.red.pos.y;
    unsafe.step();
    expect(unsafe.red.memory._warTowerDrain?.phase).toBe("retreating");
    expect(unsafe.red.pos.y).toBeLessThanOrEqual(beforeY);
    expect(unsafeWalls.every(value => value.hits === 2 * 25 * ATTACK_POWER)).toBe(true);

    // 同一物理几何分别封闭/留缺口；不预置 path 或 _warBreachTargetId。
    {
      const w = new DuoWorld(order, { geometry, openGap });
      const walls = w.structures.filter(value => value.structureType === STRUCTURE_WALL);
      if (!openGap) {
        w.blockAttackRow();
        for (let tick = 0; tick < 2; tick += 1) {
          w.step(); verifyFrame(w);
          expect(w.red.memory._warTowerDrain?.phase).toBe("breaching");
          expect(w.red.pos.y).toBeLessThan(geometry.wallY - 1);
          expect(w.green.pos.y).toBeLessThan(geometry.wallY - 1);
          expect(walls.every(value => value.hits === 2 * 25 * ATTACK_POWER)).toBe(true);
        }
        w.removeBlockers();
      }
      for (let tick = 0; tick < 24 && w.red.pos.getRangeTo(w.core.pos) > 1; tick += 1) {
        w.step(); verifyFrame(w);
        expect(w.red.memory._warTowerDrain?.phase).toBe("breaching");
      }
      expect(w.red.pos.getRangeTo(w.core.pos)).toBeLessThanOrEqual(1);
      const destroyed = walls.filter(value => value.hits <= 0);
      expect(destroyed).toHaveLength(openGap ? 0 : 1);
      expect(walls.filter(value => value.hits > 0).every(value => value.hits === 2 * 25 * ATTACK_POWER)).toBe(true);
      const firstOpenSearch = w.searches.find(search => search.goal.pos.isEqualTo(w.core.pos));
      expect(firstOpenSearch).toBeDefined();
      if (openGap) expect(firstOpenSearch!.matrix.get(geometry.coreX, geometry.coreY - 1)).toBeLessThan(0xff);
      else expect(firstOpenSearch!.matrix.get(geometry.coreX, geometry.coreY - 1)).toBe(0xff);
      // 墙消失后重新按当前世界证明开放路，不能沿用墙后仍为255的旧安全矩阵。
      expect(w.searches.some(search => !search.incomplete && search.goal.pos.isEqualTo(w.core.pos)
        && search.matrix.get(geometry.coreX, geometry.coreY - 1) < 0xff)).toBe(true);
    }
  });

  it.each([
    { order: "leader-first" as const, geometry: { left: 24, right: 28, wallY: 3, alternateLeft: 12, alternateRight: 16, coreX: 13, coreY: 9 } },
    { order: "healer-first" as const, geometry: { left: 24, right: 28, wallY: 3, alternateLeft: 12, alternateRight: 16, coreX: 13, coreY: 9 } },
    { order: "leader-first" as const, geometry: { left: 35, right: 41, wallY: 4, alternateLeft: 22, alternateRight: 26, coreX: 25, coreY: 12 } },
    { order: "healer-first" as const, geometry: { left: 35, right: 41, wallY: 4, alternateLeft: 22, alternateRight: 26, coreX: 25, coreY: 12 } },
  ])("$order towerDrain 从死袋安全退回邻房改走开放入口（旧入口 $geometry.left）", ({ order, geometry }) => {
    const w = new DuoWorld(order, { geometry });
    expect(w.hasPhysicalCoreRouteFrom(w.red.pos)).toBe(false);
    expect(w.hasPhysicalCoreRouteFrom(w.green.pos)).toBe(false);
    expect(w.hasPhysicalCoreRouteFrom(position(geometry.alternateLeft + 1, 1))).toBe(true);
    const walls = w.structures.filter(value => value.structureType === STRUCTURE_WALL);
    const oldEntryX = w.red.memory._warTowerDrain!.attackerEntry!.x;
    const initial = { red: w.red.pos, green: w.green.pos };
    w.green.fatigue = 100;
    for (let tick = 0; tick < 2; tick += 1) {
      w.step(); verifyFrame(w);
      expect(w.red.pos.isEqualTo(initial.red)).toBe(true);
      expect(w.green.pos.isEqualTo(initial.green)).toBe(true);
    }
    w.green.fatigue = 0;
    let returnedTogether = false;
    let blockingTicks = 0;
    const blockedFrames: DuoFrame[] = [];
    let blockedAlternative = false;
    let outsideFatigueTicks = 0;
    let outsideFatigueTested = false;
    let outsideHold: { red: RoomPosition; green: RoomPosition } | undefined;
    let reenteredThroughOpenEntry = false;
    for (let tick = 0; tick < 65 && !(w.red.room.name === ROOM && w.red.pos.getRangeTo(w.core.pos) <= 1); tick += 1) {
      const bothOutside = w.red.room.name === RETREAT && w.green.room.name === RETREAT;
      if (bothOutside) returnedTogether = true;
      if (bothOutside && w.red.pos.y === 48 && w.green.pos.y === 48 && !outsideFatigueTested && outsideFatigueTicks === 0) {
        w.green.fatigue = 100; outsideFatigueTicks = 2;
        outsideHold = { red: w.red.pos, green: w.green.pos };
      }
      if (bothOutside && outsideFatigueTested && !blockedAlternative && blockingTicks === 0
        && w.red.pos.x > geometry.alternateRight && w.red.pos.x <= geometry.alternateRight + 2) {
        w.blockAlternativeStaging(); blockingTicks = 6;
      }
      // 尚未一起撤回邻房，旧退路坐标必须保留，不能直接改成袋外入口。
      if (!returnedTogether) expect(w.red.memory._warTowerDrain!.attackerEntry!.x).toBe(oldEntryX);
      w.step(); verifyFrame(w);
      if (outsideFatigueTicks > 0) {
        expect(w.red.pos.isEqualTo(outsideHold!.red)).toBe(true);
        expect(w.green.pos.isEqualTo(outsideHold!.green)).toBe(true);
        outsideFatigueTicks -= 1;
        if (outsideFatigueTicks === 0) { w.green.fatigue = 0; outsideFatigueTested = true; }
      }
      if (blockingTicks > 0) {
        blockedFrames.push(w.frames[w.frames.length - 1]);
        expect(w.red.room.name).toBe(RETREAT);
        expect(w.green.room.name).toBe(RETREAT);
        expect(w.red.pos.x).toBeGreaterThan(geometry.alternateRight);
        blockingTicks -= 1;
        if (blockingTicks === 0) { w.removeBlockers(); blockedAlternative = true; }
      }
      if (returnedTogether && w.red.room.name === ROOM) {
        reenteredThroughOpenEntry = true;
        expect(w.red.memory._warTowerDrain!.attackerEntry!.x).toBeGreaterThanOrEqual(geometry.alternateLeft);
        expect(w.red.memory._warTowerDrain!.attackerEntry!.x).toBeLessThanOrEqual(geometry.alternateRight);
      }
      expect(walls.every(value => value.hits === 2 * 25 * ATTACK_POWER)).toBe(true);
    }
    expect({ returnedTogether, frames: returnedTogether ? [] : w.frames }).toEqual({ returnedTogether: true, frames: [] });
    expect(outsideFatigueTested).toBe(true);
    expect(blockedAlternative).toBe(true);
    expect(blockedFrames).toHaveLength(6);
    // 初次遇阻可让位一次；持续同一阻挡时不得ABAB换位，至少最后三帧实际稳定等待。
    const swaps = blockedFrames.slice(1).filter((frame, index) => frame.red.isEqualTo(blockedFrames[index].green)
      && frame.green.isEqualTo(blockedFrames[index].red));
    expect(swaps.length).toBeLessThanOrEqual(1);
    const tail = blockedFrames.slice(-3);
    expect(tail.every(frame => frame.red.isEqualTo(tail[0].red) && frame.green.isEqualTo(tail[0].green))).toBe(true);
    expect(reenteredThroughOpenEntry).toBe(true);
    expect(w.red.room.name).toBe(ROOM);
    expect(w.red.pos.getRangeTo(w.core.pos)).toBeLessThanOrEqual(1);
    expect(walls.every(value => value.hits === 2 * 25 * ATTACK_POWER)).toBe(true);
  });
});
