import { getHostileTowers as activeTowers, getHostileTowerThreats as towerThreats, getRefillableHostileTowers as refillableTowers, towerAttackPowerAt as towerPowerAt, type TowerThreat } from "@/runtime/combatTowerThreat";
import { clearMovementState, moveToTarget } from "@/roles/shared";
import { isWalkableStructure } from "@/movement/common";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { requestCombatObservation } from "@/runtime/powerBankObserver";

export interface TowerDrainPairState {
  targetRoom: string;
  phase: "approach" | "draining" | "retreating" | "recovering" | "breaching";
  retreatRoom?: string;
  exitDirection?: DirectionConstant;
  attackerEntry?: { x: number; y: number };
  healerEntry?: { x: number; y: number };
  blocker?: string;
  towerEnergy?: number;
  attackerDamage?: number;
  healerDamage?: number;
  enteredAt?: number;
  healingPower?: number;
}

const MOVE_OPTIONS = { plainCost: 2, swampCost: 8, reusePath: 0, maxRooms: 1, ignoreCreeps: false, avoidExitTiles: false } as const;
const RETREAT_RATIO = 0.75;
// 退路预算至少保留1000HP，并按可能受损后的真实MOVE/HEAL重算。
const DAMAGE_RESERVE = 1000;

type DrainMemory = CreepMemory & { _warTowerDrain?: TowerDrainPairState };

function plainOnlyMatrix(roomName: string, matrix: CostMatrix): CostMatrix {
  const visible = Game.rooms[roomName];
  if (visible && refillableTowers(visible).length === 0) return matrix;
  const terrain = Game.map.getRoomTerrain(roomName);
  // 道路覆盖沼泽后按道路疲劳结算，不能把现成通道一起封掉。
  const roads = new Set(Game.rooms[roomName]?.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_ROAD).map((s) => s.pos.x * 50 + s.pos.y) ?? []);
  for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) if (terrain.get(x, y) === TERRAIN_MASK_SWAMP && !roads.has(x * 50 + y)) matrix.set(x, y, 0xff);
  return matrix;
}

function roomCoordinate(roomName: string): { x: number; y: number } | null {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return null;
  return {
    x: match[1] === "E" ? Number(match[2]) : -Number(match[2]) - 1,
    y: match[3] === "S" ? Number(match[4]) : -Number(match[4]) - 1,
  };
}

/** 跨边界的 49/0 两格实际相邻，不能直接拿单房坐标的 range 比较。 */
export function towerDrainPairRange(left: RoomPosition, right: RoomPosition): number {
  const a = roomCoordinate(left.roomName);
  const b = roomCoordinate(right.roomName);
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x * 50 + left.x - b.x * 50 - right.x), Math.abs(a.y * 50 + left.y - b.y * 50 - right.y));
}

function directionToRoom(from: string, to: string): DirectionConstant | undefined {
  const a = roomCoordinate(from); const b = roomCoordinate(to);
  if (!a || !b) return undefined;
  const candidate = a.x === b.x && a.y - 1 === b.y ? TOP : a.x + 1 === b.x && a.y === b.y ? RIGHT
    : a.x === b.x && a.y + 1 === b.y ? BOTTOM : a.x - 1 === b.x && a.y === b.y ? LEFT : undefined;
  if (!candidate || Game.map.describeExits(from)?.[candidate] !== to || Game.map.describeExits(to)?.[opposite(candidate)] !== from) return undefined;
  return candidate;
}

function opposite(direction: DirectionConstant): DirectionConstant {
  return (((direction + 3) % 8) + 1) as DirectionConstant;
}

function range(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function borderTile(direction: DirectionConstant, coordinate: number): { x: number; y: number } {
  if (direction === LEFT) return { x: 0, y: coordinate };
  if (direction === RIGHT) return { x: 49, y: coordinate };
  if (direction === TOP) return { x: coordinate, y: 0 };
  return { x: coordinate, y: 49 };
}

function outsideTile(tile: { x: number; y: number }, direction: DirectionConstant, interior = false): { x: number; y: number } {
  if (direction === LEFT) return { x: interior ? 48 : 49, y: tile.y };
  if (direction === RIGHT) return { x: interior ? 1 : 0, y: tile.y };
  if (direction === TOP) return { x: tile.x, y: interior ? 48 : 49 };
  return { x: tile.x, y: interior ? 1 : 0 };
}

function damageAt(towers: StructureTower[], tile: { x: number; y: number }): number {
  return towers.reduce((sum, tower) => sum + (tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST ? towerPowerAt(tower, tile) : 0), 0);
}

const UNREACHABLE = 0xffff;

function exitPaths(room: Room, state: TowerDrainPairState, entry: { x: number; y: number }, towers: StructureTower[]) {
  const distances = new Uint16Array(2500).fill(UNREACHABLE);
  const next = new Uint16Array(2500).fill(UNREACHABLE);
  const worstDamage = new Float64Array(2500);
  const tileDamage = new Float64Array(2500).fill(-1);
  const peaks = towers.map(() => new Float64Array(2500));
  const perTower = towers.map(() => new Float64Array(2500).fill(-1));
  const blocked = new Uint8Array(2500);
  const terrain = Game.map.getRoomTerrain(room.name);
  const roads = new Set(room.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_ROAD).map((s) => s.pos.x * 50 + s.pos.y));
  const allowSwamps = towers.length === 0;
  const index = (x: number, y: number): number => x * 50 + y;
  const damage = (x: number, y: number): number => {
    const at = index(x, y);
    if (tileDamage[at] < 0) tileDamage[at] = towers.reduce((sum, tower, i) => {
      perTower[i][at] = towerPowerAt(tower, { x, y });
      return sum + perTower[i][at];
    }, 0);
    return tileDamage[at];
  };
  for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
    const atExit = x === 0 || x === 49 || y === 0 || y === 49;
    const onReturnSide = state.exitDirection === LEFT ? x === 0 : state.exitDirection === RIGHT ? x === 49 : state.exitDirection === TOP ? y === 0 : y === 49;
    if ((terrain.get(x, y) !== 0 && !(terrain.get(x, y) === TERRAIN_MASK_SWAMP && (allowSwamps || roads.has(index(x, y))))) || (atExit && (!onReturnSide || x === 0 && y === 0 || x === 49 && y === 49 || x === 0 && y === 49 || x === 49 && y === 0))) blocked[index(x, y)] = 1;
  }
  for (const structure of room.find(FIND_STRUCTURES)) if (!isWalkableStructure(structure)) blocked[index(structure.pos.x, structure.pos.y)] = 1;
  for (const natural of [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS), ...room.find(FIND_DEPOSITS)]) blocked[index(natural.pos.x, natural.pos.y)] = 1;
  for (const hostile of room.find(FIND_HOSTILE_CREEPS)) blocked[index(hostile.pos.x, hostile.pos.y)] = 1;
  const queue = new Uint16Array(2500);
  const start = index(entry.x, entry.y);
  if (blocked[start]) return { distances, next, worstDamage, peaks };
  let read = 0;
  let write = 1;
  queue[0] = start;
  distances[start] = 0;
  worstDamage[start] = damage(entry.x, entry.y);
  for (let i = 0; i < towers.length; i++) peaks[i][start] = perTower[i][start];
  while (read < write) {
    const current = queue[read++];
    const x = Math.floor(current / 50);
    const y = current % 50;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx > 49 || y + dy < 0 || y + dy > 49) continue;
      const candidate = index(x + dx, y + dy);
      if (blocked[candidate]) continue;
      if (distances[candidate] !== UNREACHABLE && distances[candidate] !== distances[current] + 1) continue;
      const worst = Math.max(worstDamage[current], damage(x + dx, y + dy));
      if (distances[candidate] === UNREACHABLE) {
        distances[candidate] = distances[current] + 1;
        worstDamage[candidate] = worst;
        next[candidate] = current;
        for (let i = 0; i < towers.length; i++) peaks[i][candidate] = Math.max(peaks[i][current], perTower[i][candidate]);
        queue[write++] = candidate;
      } else if (worst < worstDamage[candidate]) {
        worstDamage[candidate] = worst;
        next[candidate] = current;
        for (let i = 0; i < towers.length; i++) peaks[i][candidate] = Math.max(peaks[i][current], perTower[i][candidate]);
      }
    }
  }
  return { distances, next, worstDamage, peaks };
}

/** 两条BFS退路逐格仍在近身治疗距离内才抵扣治疗；不假定绕墙后还能治疗。 */
function createLinkedExitProof(redPaths: ReturnType<typeof exitPaths>, greenPaths: ReturnType<typeof exitPaths>) {
  const cache = new Map<number, boolean>();
  return (redAt: number, greenAt: number): boolean => {
    const visited: number[] = [];
    let linked = false;
    for (let steps = 0; steps < 2500; steps++) {
      const key = redAt * 2500 + greenAt;
      const known = cache.get(key); if (known !== undefined) { linked = known; break; }
      visited.push(key);
      if (Math.max(Math.abs(Math.floor(redAt / 50) - Math.floor(greenAt / 50)), Math.abs(redAt % 50 - greenAt % 50)) > 1) break;
      const r = redPaths.distances[redAt]; const g = greenPaths.distances[greenAt];
      if (r === UNREACHABLE || g === UNREACHABLE) break;
      if (r === 0 || g === 0) { linked = Math.max(r, g) <= 1; break; }
      redAt = redPaths.next[redAt]; greenAt = greenPaths.next[greenAt];
    }
    for (const key of visited) cache.set(key, linked);
    return linked;
  };
}

/** 每次调用创建身体/塔快照；同tick补能、疲劳、堵路仍重新读取。 */
export function constrainTowerDrainBreachPath(creep: Creep, roomName: string, matrix: CostMatrix): CostMatrix {
  const state = (creep.memory as DrainMemory)._warTowerDrain;
  const room = Game.rooms[roomName];
  if (!state || state.phase !== "breaching" || state.targetRoom !== roomName || !state.attackerEntry || !room) return matrix;
  plainOnlyMatrix(roomName, matrix);
  const partner = Object.values(Game.creeps).find((candidate) => candidate.memory.configName === creep.memory._warPartnerConfigName && !candidate.memory._warDetached);
  if (!partner) return matrix;
  const attacker = creep.memory.role === "meleeAttacker" ? creep : partner;
  const healer = creep.memory.role === "healer" ? creep : partner;
  const threats = towerThreats(room).filter((threat) => Number.isFinite(threat.refillAt));
  const redPaths = exitPaths(room, state, state.attackerEntry, threats.map((threat) => threat.tower));
  const greenPaths = exitPaths(room, state, state.healerEntry ?? state.attackerEntry, threats.map((threat) => threat.tower));
  const evaluate = createPairExitEvaluator(attacker, healer, threats);
  const linkedExit = createLinkedExitProof(redPaths, greenPaths);
  const heal = bodyModel(healer).heal(healer.hits);
  for (let x = 1; x < 49; x++) for (let y = 1; y < 49; y++) {
    const at = x * 50 + y;
    const redSteps = redPaths.distances[at];
    if (redSteps === UNREACHABLE) { matrix.set(x, y, 0xff); continue; }
    let greenSteps = 0;
    const peak = threats.map((_, i) => redPaths.peaks[i][at]);
    let greenReachable = false;
    let linked = true;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const gx = x + dx; const gy = y + dy;
      if (gx < 0 || gx > 49 || gy < 0 || gy > 49) continue;
      const greenAt = gx * 50 + gy;
      if (greenPaths.distances[greenAt] === UNREACHABLE) continue;
      greenReachable = true;
      linked = linked && linkedExit(at, greenAt);
      greenSteps = Math.max(greenSteps, greenPaths.distances[greenAt]);
      for (let i = 0; i < threats.length; i++) peak[i] = Math.max(peak[i], greenPaths.peaks[i][greenAt]);
    }
    const incoming = threats.reduce((sum, threat, i) => sum + (threat.live ? peak[i] : 0), 0);
    if (!greenReachable || (incoming > 0 && incoming >= heal) || !evaluate(redSteps, greenSteps, peak, linked)) matrix.set(x, y, 0xff);
  }
  return matrix;
}

/** 通用moveTo在出口会先moveOffExit再执行costCallback；新模式首步必须直接受本门约束。 */
export function moveTowerDrainBorderAttack(creep: Creep, target: RoomPosition, workRange: number): ScreepsReturnCode | undefined {
  const state = (creep.memory as DrainMemory)._warTowerDrain;
  if (!state || state.phase !== "breaching" || creep.room.name !== state.targetRoom || target.roomName !== state.targetRoom || !(creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49)) return undefined;
  if (range(creep.pos, target) <= workRange) return OK;
  if (creep.fatigue > 0) return ERR_TIRED;
  const costs = new Map<number, number>();
  const matrix = { set: (x: number, y: number, value: number) => costs.set(x * 50 + y, value), get: (x: number, y: number) => costs.get(x * 50 + y) ?? 0 } as unknown as CostMatrix;
  constrainTowerDrainBreachPath(creep, state.targetRoom, matrix);
  let selected: { x: number; y: number } | undefined;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const tile = { x: creep.pos.x + dx, y: creep.pos.y + dy };
    if ((!dx && !dy) || tile.x < 1 || tile.x > 48 || tile.y < 1 || tile.y > 48 || matrix.get(tile.x, tile.y) === 0xff || !walkable(state.targetRoom, tile, Game.rooms[state.targetRoom])) continue;
    if (!selected || range(tile, target) < range(selected, target)) selected = tile;
  }
  if (!selected) return ERR_NO_PATH;
  const direction = creep.pos.getDirectionTo(new RoomPosition(selected.x, selected.y, state.targetRoom));
  if (!direction) return ERR_NO_PATH;
  clearMovementState(creep);
  return measureCreepIntent(() => creep.move(direction));
}

function walkable(roomName: string, tile: { x: number; y: number }, room: Room | undefined): boolean {
  const terrain = Game.map.getRoomTerrain(roomName).get(tile.x, tile.y);
  if (terrain !== 0 && !(terrain === TERRAIN_MASK_SWAMP && room && (refillableTowers(room).length === 0 || room.find(FIND_STRUCTURES).some((s) => s.structureType === STRUCTURE_ROAD && s.pos.x === tile.x && s.pos.y === tile.y)))) return false;
  if (!room) return true;
  const blocked = room.find(FIND_STRUCTURES).some((structure) => structure.pos.x === tile.x && structure.pos.y === tile.y && !isWalkableStructure(structure));
  const natural = [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS), ...room.find(FIND_DEPOSITS)].some((s) => s.pos.x === tile.x && s.pos.y === tile.y);
  return !blocked && !natural && !room.find(FIND_HOSTILE_CREEPS).some((creep) => creep.pos.x === tile.x && creep.pos.y === tile.y);
}

function chooseEntry(state: TowerDrainPairState, attacker: Creep, healer: Creep, room: Room): boolean {
  if (!state.retreatRoom || !state.exitDirection) return false;
  const outside = Game.rooms[state.retreatRoom];
  const towers = refillableTowers(room);
  let best: { attacker: { x: number; y: number }; healer: { x: number; y: number }; score: number } | undefined;
  for (let coordinate = 1; coordinate < 48; coordinate++) {
    const red = borderTile(state.exitDirection, coordinate);
    const green = borderTile(state.exitDirection, coordinate + 1);
    if (![red, green].every((tile) => walkable(room.name, tile, room)
      && walkable(state.retreatRoom!, outsideTile(tile, state.exitDirection!), outside)
      && walkable(state.retreatRoom!, outsideTile(tile, state.exitDirection!, true), outside))) continue;
    const worst = Math.max(towers.reduce((sum, tower) => sum + towerPowerAt(tower, red), 0), towers.reduce((sum, tower) => sum + towerPowerAt(tower, green), 0));
    const travel = attacker.room.name === state.retreatRoom && healer.room.name === state.retreatRoom
      ? range(attacker.pos, outsideTile(red, state.exitDirection, true)) + range(healer.pos, outsideTile(green, state.exitDirection, true)) : 0;
    const score = worst * 1000 + travel;
    if (!best || score < best.score) best = { attacker: red, healer: green, score };
  }
  if (!best) return false;
  state.attackerEntry = best.attacker;
  state.healerEntry = best.healer;
  return true;
}

function move(creep: Creep, tile: { x: number; y: number }, roomName: string): void {
  if (creep.room.name !== roomName || range(creep.pos, tile) === 0 || creep.fatigue > 0) return;
  clearMovementState(creep);
  moveToTarget(creep, new RoomPosition(tile.x, tile.y, roomName), 0, MOVE_OPTIONS);
}

function moveAcross(creep: Creep, direction: DirectionConstant): void {
  if (creep.fatigue > 0 || creep.getActiveBodyparts(MOVE) <= 0) return;
  clearMovementState(creep);
  measureCreepIntent(() => creep.move(direction));
}

/** Engine按hits从身体尾端回填；部分存活的HEAL/MOVE仍完整生效。 */
function bodyModel(creep: Creep) {
  const moves = new Float64Array(creep.body.length + 1);
  const heals = new Float64Array(creep.body.length + 1);
  for (let living = 1; living <= creep.body.length; living++) {
    const part = creep.body[creep.body.length - living];
    const boost = part.boost ? (BOOSTS[part.type] as Record<string, { fatigue?: number; heal?: number }>)[part.boost] : undefined;
    moves[living] = moves[living - 1] + (part.type === MOVE && part.hits > 0 ? boost?.fatigue ?? 1 : 0);
    heals[living] = heals[living - 1] + (part.type === HEAL && part.hits > 0 ? HEAL_POWER * (boost?.heal ?? 1) : 0);
  }
  const weight = creep.body.filter((part) => part.type !== MOVE && part.type !== CARRY).length;
  const alive = (hits: number): number => Math.max(0, Math.min(creep.body.length, Math.ceil(hits / 100)));
  return { moves: (hits: number) => moves[alive(hits)], heal: (hits: number) => heals[alive(hits)],
    cadence: (hits: number) => moves[alive(hits)] > 0 ? Math.max(1, Math.ceil(weight / moves[alive(hits)])) : Infinity };
}

/**
 * 总缺血S的保守递推：等长身体、近身治疗较伤者，至少治疗min(H,S/2)。
 * 每座塔一轮只可攻击一个成员，按两条已知退路上的较高伤害计入S。
 * 将S全压到任一成员，取得MOVE/HEAL下界；最后两轮跨房不抵扣治疗。
 */
function createPairExitEvaluator(attacker: Creep, healer: Creep, threats: TowerThreat[]) {
  const red = bodyModel(attacker); const green = bodyModel(healer);
  const initial = attacker.hitsMax - attacker.hits + healer.hitsMax - healer.hits;
  const canHeal = attacker.room.name === healer.room.name && towerDrainPairRange(attacker.pos, healer.pos) <= 1 && attacker.hitsMax === healer.hitsMax;
  const cache = new Map<string, boolean>();
  return (redSteps: number, greenSteps: number, peak: number[], linked: boolean): boolean => {
    if (redSteps === UNREACHABLE || greenSteps === UNREACHABLE) return false;
    const key = `${redSteps}:${greenSteps}:${linked}:${peak.join(',')}`;
    const known = cache.get(key); if (known !== undefined) return known;
    const exposure = (redHits: number, greenHits: number): { horizon: number; crossWait: number } => {
      const cadence = Math.max(red.cadence(redHits), green.cadence(greenHits));
      const wait = Math.max(Math.ceil(attacker.fatigue / Math.max(1, 2 * red.moves(redHits))), Math.ceil(healer.fatigue / Math.max(1, 2 * green.moves(greenHits))));
      const crossWait = Math.max(2, 2 * cadence);
      return { horizon: wait + Math.max(redSteps, greenSteps) * cadence + crossWait, crossWait };
    };
    let { horizon, crossWait } = exposure(attacker.hits, healer.hits);
    let safe = false;
    for (let revision = 0; revision < 52 && horizon <= 1500; revision++) {
      let deficit = initial; let worst = initial; let failed = false;
      for (let tick = 0; tick < horizon; tick++) {
        const incoming = threats.reduce((sum, threat, i) => sum + (tick >= threat.refillAt ? peak[i] : 0), 0);
        const healing = canHeal && linked && tick < horizon - crossWait ? green.heal(Math.min(healer.hits, healer.hitsMax - worst)) : 0;
        deficit = Math.max(0, deficit - Math.min(healing, deficit / 2)) + incoming;
        worst = Math.max(worst, deficit);
        if (Math.min(attacker.hitsMax, healer.hitsMax) - worst <= DAMAGE_RESERVE) { failed = true; break; }
      }
      if (failed) break;
      const redHits = Math.min(attacker.hits, attacker.hitsMax - worst);
      const greenHits = Math.min(healer.hits, healer.hitsMax - worst);
      const nextExposure = exposure(redHits, greenHits);
      const next = nextExposure.horizon;
      if (next <= horizon) { safe = true; break; }
      horizon = next; crossWait = nextExposure.crossWait;
    }
    cache.set(key, safe); return safe;
  };
}

function pairExitSafe(attacker: Creep, healer: Creep, state: TowerDrainPairState): boolean {
  const room = Game.rooms[state.targetRoom];
  if (!room || !state.attackerEntry || !state.healerEntry) return false;
  const threats = towerThreats(room).filter((threat) => Number.isFinite(threat.refillAt));
  const redPaths = exitPaths(room, state, state.attackerEntry, threats.map((threat) => threat.tower));
  const greenPaths = exitPaths(room, state, state.healerEntry, threats.map((threat) => threat.tower));
  const redAt = (attacker.room.name === state.targetRoom ? attacker.pos : state.attackerEntry);
  const greenAt = (healer.room.name === state.targetRoom ? healer.pos : state.healerEntry);
  const r = redAt.x * 50 + redAt.y; const g = greenAt.x * 50 + greenAt.y;
  return createPairExitEvaluator(attacker, healer, threats)(redPaths.distances[r], greenPaths.distances[g], threats.map((_, i) => Math.max(redPaths.peaks[i][r], greenPaths.peaks[i][g])), createLinkedExitProof(redPaths, greenPaths)(r, g));
}

function healPair(healer: Creep, attacker: Creep): void {
  const sameRoom = healer.room.name === attacker.room.name;
  const target = healer.hits < healer.hitsMax && (!sameRoom || healer.hits / healer.hitsMax <= attacker.hits / attacker.hitsMax) ? healer : attacker;
  if (target === healer) {
    measureCreepIntent(() => healer.heal(healer));
  } else if (sameRoom && range(healer.pos, attacker.pos) <= 1) {
    measureCreepIntent(() => healer.heal(attacker));
  } else if (sameRoom && range(healer.pos, attacker.pos) <= 3) {
    measureCreepIntent(() => healer.rangedHeal(attacker));
  }
}

function publish(state: TowerDrainPairState, attacker: Creep, healer?: Creep): void {
  (attacker.memory as DrainMemory)._warTowerDrain = state;
  if (healer) (healer.memory as DrainMemory)._warTowerDrain = { ...state };
}

function withdraw(creep: Creep, state: TowerDrainPairState, entry: { x: number; y: number } | undefined): void {
  if (!entry || !state.retreatRoom || !state.exitDirection) { state.blocker = "missing_exit"; return; }
  if (creep.room.name === state.targetRoom) {
    const partner = Object.values(Game.creeps).find((actor) => actor.memory.configName === creep.memory._warPartnerConfigName);
    if (partner?.room.name === state.targetRoom && towerDrainPairRange(creep.pos, partner.pos) <= 1 && (creep.fatigue > 0 || partner.fatigue > 0)) return;
    if (!walkable(state.targetRoom, entry, Game.rooms[state.targetRoom])) { state.blocker = "exit_blocked"; return; }
    if (range(creep.pos, entry) === 0) moveAcross(creep, state.exitDirection);
    else advanceAlongExit(creep, state, entry);
  } else if (creep.room.name === state.retreatRoom) {
    move(creep, outsideTile(entry, state.exitDirection, true), state.retreatRoom);
  } else state.blocker = "unexpected_retreat_room";
}

function advanceAlongExit(creep: Creep, state: TowerDrainPairState, entry: { x: number; y: number }): void {
  const room = Game.rooms[state.targetRoom];
  if (!room) { state.blocker = "missing_exit_vision"; return; }
  const paths = exitPaths(room, state, entry, refillableTowers(room));
  const next = paths.next[creep.pos.x * 50 + creep.pos.y];
  if (next === UNREACHABLE) { state.blocker = "exit_no_path"; return; }
  const direction = creep.pos.getDirectionTo(new RoomPosition(Math.floor(next / 50), next % 50, room.name));
  if (direction) moveAcross(creep, direction);
}

function leaveBreachExit(creep: Creep, attacker: Creep, healer: Creep, state: TowerDrainPairState): boolean {
  const atEdge = (member: Creep): boolean => member.pos.x === 0 || member.pos.x === 49 || member.pos.y === 0 || member.pos.y === 49;
  if (!atEdge(attacker) && !atEdge(healer)) return false;
  const inward = opposite(state.exitDirection!);
  const deltas: Record<number, [number, number]> = { 1: [0, -1], 2: [1, -1], 3: [1, 0], 4: [1, 1], 5: [0, 1], 6: [-1, 1], 7: [-1, 0], 8: [-1, -1] };
  const costs = new Map<number, number>();
  const matrix = { set: (x: number, y: number, value: number) => costs.set(x * 50 + y, value), get: (x: number, y: number) => costs.get(x * 50 + y) ?? 0 } as unknown as CostMatrix;
  constrainTowerDrainBreachPath(attacker, state.targetRoom, matrix);
  for (const direction of [inward, ((inward + 6) % 8 + 1) as DirectionConstant, (inward % 8 + 1) as DirectionConstant]) {
    const [dx, dy] = deltas[direction];
    const destinations = [attacker, healer].map((member) => ({ x: member.pos.x + dx, y: member.pos.y + dy }));
    if (!destinations.every((tile) => tile.x >= 1 && tile.x <= 48 && tile.y >= 1 && tile.y <= 48
      && matrix.get(tile.x, tile.y) !== 0xff && walkable(state.targetRoom, tile, Game.rooms[state.targetRoom]))) continue;
    // 两个role读取同一帧位置，首步一起离开边缘；绿追红旧0/49会被Engine自动送回邻房。
    moveAcross(creep, direction);
    state.blocker = undefined;
    return true;
  }
  state.blocker = "exit_inward_blocked";
  return true;
}

/**
 * 新模式独立在原 formation/破墙逻辑之前消费本 tick。
 * fresh 视野、塔能量、双方身体与体力每次重读；此前空塔不是继续破墙的证据。
 */
export function runTowerDrainPair(creep: Creep, targetRoom: string, partnerConfigName: string): boolean {
  requestCombatObservation(targetRoom);
  const red = creep.memory.role === "meleeAttacker";
  const partner = Object.values(Game.creeps).find((candidate) => candidate.memory.configName === partnerConfigName && candidate.memory.role === (red ? "healer" : "meleeAttacker") && !candidate.memory._warDetached && !candidate.spawning);
  const attacker = red ? creep : partner;
  const healer = red ? partner : creep;
  let state = (attacker?.memory as DrainMemory | undefined)?._warTowerDrain ?? (creep.memory as DrainMemory)._warTowerDrain;
  if (!state || state.targetRoom !== targetRoom) state = { targetRoom, phase: "approach" };
  if (!attacker || !healer || attacker.memory._warDetached || healer.memory._warDetached || partner?.memory._warPartnerConfigName !== creep.memory.configName) {
    state.phase = "retreating";
    state.blocker = "partner_missing";
    (creep.memory as DrainMemory)._warTowerDrain = state;
    if (!red && creep.hits < creep.hitsMax) measureCreepIntent(() => creep.heal(creep));
    withdraw(creep, state, red ? state.attackerEntry : state.healerEntry);
    return true;
  }
  const room = Game.rooms[targetRoom];
  if (room?.controller?.my) { state.blocker = "target_owned"; publish(state, attacker, healer); return true; }
  if (creep === healer) healPair(healer, attacker);
  if (state.retreatRoom && directionToRoom(targetRoom, state.retreatRoom) === undefined) {
    delete state.retreatRoom; delete state.exitDirection; delete state.attackerEntry; delete state.healerEntry;
    state.phase = "approach"; state.blocker = undefined;
  }
  const outsideMember = [attacker, healer].find((member) => member.room.name !== targetRoom && directionToRoom(targetRoom, member.room.name));
  if (!state.retreatRoom && outsideMember) {
    state.retreatRoom = outsideMember.room.name;
    state.exitDirection = directionToRoom(targetRoom, state.retreatRoom);
  }
  if (!state.retreatRoom && attacker.room.name !== targetRoom) {
    // 尚在路上：原双人 travel 继续负责途经房。
    state.phase = "approach"; state.blocker = undefined;
    publish(state, attacker, healer);
    return false;
  }
  if (!state.retreatRoom || !state.exitDirection) { state.blocker = "missing_exit"; publish(state, attacker, healer); return true; }
  const bothOutside = attacker.room.name === state.retreatRoom && healer.room.name === state.retreatRoom;
  const bothInside = attacker.room.name === targetRoom && healer.room.name === targetRoom;
  const memberInside = attacker.room.name === targetRoom || healer.room.name === targetRoom;
  if (memberInside) state.enteredAt ??= Game.time;
  if (!bothOutside && !memberInside && state.enteredAt === undefined) {
    // 红先到最后邻房时，绿仍须沿原 route 追上，不能因已记退房房间而停在前一房。
    state.phase = "approach";
    publish(state, attacker, healer);
    return false;
  }
  if (room && (!state.attackerEntry || !state.healerEntry)) chooseEntry(state, attacker, healer, room);
  if (!state.attackerEntry || !state.healerEntry) { state.blocker = room ? "no_safe_exit" : "target_not_visible"; publish(state, attacker, healer); return true; }
  // 单人跨房成功或被挡后先全队退回1/48重排；补跨会与另一人的边缘自动退出互换房间。
  if (memberInside && !bothInside) state.phase = "retreating";
  const towers = room ? activeTowers(room) : [];
  state.towerEnergy = towers.reduce((sum, tower) => sum + tower.store.getUsedCapacity(RESOURCE_ENERGY), 0);
  state.attackerDamage = room ? damageAt(towers, attacker.room.name === targetRoom ? attacker.pos : state.attackerEntry) : undefined;
  state.healerDamage = room ? damageAt(towers, healer.room.name === targetRoom ? healer.pos : state.healerEntry) : undefined;
  const unsafe = attacker.getActiveBodyparts(MOVE) <= 0 || healer.getActiveBodyparts(MOVE) <= 0 || healer.getActiveBodyparts(HEAL) <= 0
    || attacker.hits <= attacker.hitsMax * RETREAT_RATIO
    || !pairExitSafe(attacker, healer, state);
  if (!bothOutside && (unsafe || !room)) state.phase = "retreating";
  if (bothInside && !unsafe && (attacker.fatigue > 0 || healer.fatigue > 0) && state.phase !== "retreating") {
    state.blocker = "pair_fatigued";
    publish(state, attacker, healer);
    return true;
  }
  if (state.phase === "retreating" || state.phase === "recovering") {
    state.phase = bothOutside ? "recovering" : "retreating";
    const recovered = bothOutside && attacker.hits === attacker.hitsMax && healer.hits === healer.hitsMax && attacker.getActiveBodyparts(MOVE) >= 25 && healer.getActiveBodyparts(MOVE) >= 25 && healer.getActiveBodyparts(HEAL) >= 25 && attacker.fatigue === 0 && healer.fatigue === 0;
    if (!recovered) {
      state.blocker = unsafe ? "healing_or_body" : undefined;
      withdraw(creep, state, creep === attacker ? state.attackerEntry : state.healerEntry);
      publish(state, attacker, healer);
      return true;
    }
    state.phase = "approach";
  }
  if (!room) { state.blocker = "target_not_visible"; withdraw(creep, state, creep === attacker ? state.attackerEntry : state.healerEntry); publish(state, attacker, healer); return true; }
  const canFire = towers.some((tower) => tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST);
  state.healingPower = bodyModel(healer).heal(healer.hits);
  const canAdvance = !canFire || Math.max(state.attackerDamage ?? Infinity, state.healerDamage ?? Infinity) < state.healingPower;
  if (canAdvance && bothInside && !unsafe) {
    state.phase = "breaching";
    if (towerDrainPairRange(attacker.pos, healer.pos) > 1) {
      state.blocker = "pair_regrouping";
      publish(state, attacker, healer);
      if (creep === healer) {
        const borderMove = moveTowerDrainBorderAttack(healer, attacker.pos, 1);
        if (borderMove === undefined) moveToTarget(healer, attacker, 1, { ...MOVE_OPTIONS, costCallback: (roomName, matrix) => constrainTowerDrainBreachPath(healer, roomName, plainOnlyMatrix(roomName, matrix)) });
      }
      publish(state, attacker, healer);
      return true;
    }
    if (leaveBreachExit(creep, attacker, healer, state)) { publish(state, attacker, healer); return true; }
    state.blocker = undefined;
    publish(state, attacker, healer);
    return false;
  }
  if (state.phase === "breaching" && !canAdvance) state.phase = "retreating";
  if (state.phase === "retreating") {
    withdraw(creep, state, creep === attacker ? state.attackerEntry : state.healerEntry);
    publish(state, attacker, healer);
    return true;
  }
  const entry = creep === attacker ? state.attackerEntry : state.healerEntry;
  if (bothOutside) {
    if (![state.attackerEntry, state.healerEntry].every((tile) => walkable(targetRoom, tile, room)
      && walkable(state.retreatRoom!, outsideTile(tile, state.exitDirection!), Game.rooms[state.retreatRoom!])
      && walkable(state.retreatRoom!, outsideTile(tile, state.exitDirection!, true), Game.rooms[state.retreatRoom!]))) {
      if (!chooseEntry(state, attacker, healer, room)) { state.blocker = "no_safe_exit"; publish(state, attacker, healer); return true; }
      // 新入口的动态伤害要下一次按新坐标完整重算；本次不发送穿房意图。
      state.blocker = "entry_reselected";
      publish(state, attacker, healer);
      return true;
    }
    // 入房也预留两轮受击；没有 fresh 目标视野时绝不盲穿出口。
    const potential = refillableTowers(room);
    const admissionDamage = Math.max(potential.reduce((sum, tower) => sum + towerPowerAt(tower, state.attackerEntry!), 0), potential.reduce((sum, tower) => sum + towerPowerAt(tower, state.healerEntry!), 0));
    if (attacker.hits < attacker.hitsMax || healer.hits < healer.hitsMax || attacker.getActiveBodyparts(ATTACK) < 25 || attacker.getActiveBodyparts(MOVE) < 25 || healer.getActiveBodyparts(HEAL) < 25 || healer.getActiveBodyparts(MOVE) < 25 || admissionDamage * 2 + DAMAGE_RESERVE >= Math.min(attacker.hits, healer.hits) || attacker.fatigue > 0 || healer.fatigue > 0) {
      state.blocker = "entry_damage_or_healing";
      state.phase = "recovering";
      // source0/49也会自动迁房；拒绝再入时先回source1/48，不能假称边界hold能留在原房。
      withdraw(creep, state, entry);
      publish(state, attacker, healer);
      return true;
    }
    const redOutside = outsideTile(state.attackerEntry, state.exitDirection, true);
    const greenOutside = outsideTile(state.healerEntry, state.exitDirection, true);
    const ready = range(attacker.pos, redOutside) === 0 && range(healer.pos, greenOutside) === 0;
    if (ready) { state.phase = "draining"; moveAcross(creep, opposite(state.exitDirection)); }
    else move(creep, outsideTile(entry, state.exitDirection, true), state.retreatRoom);
  } else if (creep.room.name === targetRoom) {
    state.phase = "draining";
    if (range(creep.pos, entry) > 0) advanceAlongExit(creep, state, entry);
  } else if (creep.room.name === state.retreatRoom && towerDrainPairRange(attacker.pos, healer.pos) <= 2 && creep.fatigue === 0) {
    if (range(creep.pos, outsideTile(entry, state.exitDirection)) === 0) moveAcross(creep, opposite(state.exitDirection));
    else move(creep, outsideTile(entry, state.exitDirection), state.retreatRoom);
  }
  state.blocker = undefined;
  publish(state, attacker, healer);
  return true;
}
