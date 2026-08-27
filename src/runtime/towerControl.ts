import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getRoomDefenseCoordination, getTowerFocusFront, setTowerFocusFront } from "@/runtime/defenseCoordination";
import { chooseBoundaryBurstEngagement, chooseInsideBurstTarget } from "@/runtime/hostilePriorities";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import { getBoundaryRamparts } from "@/runtime/safeZoneHelpers";

const TOWER_MIN_REPAIR_ENERGY = 400;
const TOWER_MIN_EMERGENCY_REPAIR_ENERGY = 200;
const RAMPART_EMERGENCY_TRIGGER_HITS = 3000;
const RAMPART_EMERGENCY_TARGET_HITS = 6000;
const TOWER_FOCUS_STALL_HITS_DELTA = 40;
const TOWER_FOCUS_STALL_TICKS = 2;
const TOWER_SPREAD_PROBE_DURATION = 3;

interface TowerCombatRoomState {
  focusTargetId?: string;
  lastFocusHits?: number;
  stalledTicks?: number;
  spreadUntil?: number;
}

interface TowerCombatAnalysis {
  totalTowerAttackByHostileId: Map<Id<Creep>, number>;
  incomingHealByHostileId: Map<Id<Creep>, number>;
  towerAttackByTowerId: Map<Id<StructureTower>, Map<Id<Creep>, number>>;
}

function ensureTowerCombatRoomState(roomName: string): TowerCombatRoomState {
  const runtime = getMemoryService().ensureRuntime();
  runtime.towerCombat = runtime.towerCombat || {};
  runtime.towerCombat[roomName] = runtime.towerCombat[roomName] || {};
  return runtime.towerCombat[roomName];
}

function getTowerAttackPowerByRange(range: number): number {
  if (range <= TOWER_OPTIMAL_RANGE) {
    return TOWER_POWER_ATTACK;
  }

  if (range >= TOWER_FALLOFF_RANGE) {
    return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF));
  }

  const falloffRange = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE;
  const beyondOptimal = range - TOWER_OPTIMAL_RANGE;
  const falloffRatio = beyondOptimal / falloffRange;
  const power = TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF * falloffRatio);
  return Math.floor(power);
}

function getHealPartPower(part: BodyPartDefinition, ranged: boolean): number {
  if (part.type !== HEAL || part.hits <= 0) {
    return 0;
  }

  const base = ranged ? RANGED_HEAL_POWER : HEAL_POWER;
  if (!part.boost) {
    return base;
  }

  const boostEntry = (BOOSTS[HEAL] as Record<string, { heal?: number; rangedHeal?: number } | undefined> | undefined)?.[
    part.boost
  ];
  if (!boostEntry) {
    return base;
  }

  const multiplier = ranged ? boostEntry.rangedHeal : boostEntry.heal;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) {
    return base;
  }

  return Math.floor(base * multiplier);
}

function getCreepHealPowerAtRange(creep: Creep, rangeToTarget: number): number {
  if (rangeToTarget > 3) {
    return 0;
  }

  const ranged = rangeToTarget > 1;
  return creep.body.reduce((sum, part) => sum + getHealPartPower(part, ranged), 0);
}

/**
 * Simulates the Screeps engine's _applyDamage algorithm.
 * Damage flows through body parts left-to-right; boosted TOUGH parts
 * absorb raw damage at a reduced rate (e.g. XGHO2 => damageRatio 0.3).
 */
export function calcEffectiveDamage(creep: Creep, rawDamage: number): number {
  if (rawDamage <= 0) return 0;

  if (!creep.body.some((p) => !!p.boost)) {
    return rawDamage;
  }

  let damageReduce = 0;
  let damageEffective = rawDamage;

  for (const part of creep.body) {
    if (damageEffective <= 0) break;

    let damageRatio = 1;
    if (part.boost && part.hits > 0) {
      const typeBoosts = (BOOSTS as Record<string, Record<string, { damage?: number } | undefined>>)?.[part.type];
      const entry = typeBoosts?.[part.boost];
      if (entry?.damage !== undefined) {
        damageRatio = entry.damage;
      }
    }

    const bodyPartHitsEffective = part.hits / damageRatio;
    const absorbed = Math.min(bodyPartHitsEffective, damageEffective);
    damageReduce += absorbed * (1 - damageRatio);
    damageEffective -= absorbed;
  }

  return rawDamage - Math.round(damageReduce);
}

function createTowerCombatAnalysis(towers: StructureTower[], hostiles: Creep[]): TowerCombatAnalysis {
  const totalTowerAttackByHostileId = new Map<Id<Creep>, number>();
  const incomingHealByHostileId = new Map<Id<Creep>, number>();
  const towerAttackByTowerId = new Map<Id<StructureTower>, Map<Id<Creep>, number>>();

  for (const tower of towers) {
    const damageByHostileId = new Map<Id<Creep>, number>();
    for (const hostile of hostiles) {
      const damage = getTowerAttackPowerByRange(tower.pos.getRangeTo(hostile.pos));
      damageByHostileId.set(hostile.id, damage);
      totalTowerAttackByHostileId.set(hostile.id, (totalTowerAttackByHostileId.get(hostile.id) || 0) + damage);
    }
    towerAttackByTowerId.set(tower.id, damageByHostileId);
  }

  for (const hostile of hostiles) {
    const rawTotal = totalTowerAttackByHostileId.get(hostile.id) || 0;
    const effectiveTotal = calcEffectiveDamage(hostile, rawTotal);
    totalTowerAttackByHostileId.set(hostile.id, effectiveTotal);

    const effectiveRatio = rawTotal > 0 ? effectiveTotal / rawTotal : 1;
    for (const tower of towers) {
      const towerDamage = towerAttackByTowerId.get(tower.id);
      const rawDamage = towerDamage?.get(hostile.id);
      if (rawDamage !== undefined) {
        towerDamage!.set(hostile.id, Math.round(rawDamage * effectiveRatio));
      }
    }
  }

  for (const target of hostiles) {
    let totalHeal = 0;
    for (const hostile of hostiles) {
      totalHeal += getCreepHealPowerAtRange(hostile, hostile.pos.getRangeTo(target.pos));
    }
    incomingHealByHostileId.set(target.id, totalHeal);
  }

  return {
    totalTowerAttackByHostileId,
    incomingHealByHostileId,
    towerAttackByTowerId,
  };
}

function chooseFocusTarget(hostiles: Creep[], analysis: TowerCombatAnalysis): Creep | null {
  let best: Creep | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const hostile of hostiles) {
    const totalDamage = analysis.totalTowerAttackByHostileId.get(hostile.id) || 0;
    const heal = analysis.incomingHealByHostileId.get(hostile.id) || 0;
    const net = totalDamage - heal;
    if (net <= 0) {
      continue;
    }

    const score = net * 1000 - hostile.hits * 0.2;
    if (score > bestScore) {
      best = hostile;
      bestScore = score;
    }
  }

  return best;
}

function assignSpreadTargets(
  towers: StructureTower[],
  hostiles: Creep[],
  analysis: TowerCombatAnalysis,
): Map<Id<StructureTower>, Creep> {
  const assignments = new Map<Id<StructureTower>, Creep>();
  const appliedPressure: Record<string, number> = {};
  const assignedTargetIds = new Set<string>();

  const sortedTowers = [...towers].sort((left, right) => left.id.localeCompare(right.id));
  for (const tower of sortedTowers) {
    let best: Creep | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const candidatePool = hostiles.filter((hostile) => !assignedTargetIds.has(hostile.id));
    const candidates = candidatePool.length > 0 ? candidatePool : hostiles;
    const towerDamageByHostileId = analysis.towerAttackByTowerId.get(tower.id);

    for (const hostile of candidates) {
      const range = tower.pos.getRangeTo(hostile.pos);
      const damage = towerDamageByHostileId?.get(hostile.id) || 0;
      const heal = analysis.incomingHealByHostileId.get(hostile.id) || 0;
      const currentPressure = appliedPressure[hostile.id] || 0;
      const projectedNet = damage - Math.max(0, heal - currentPressure);
      const finishingBonus = hostile.hits <= damage * 1.2 ? 120 : 0;
      const score = projectedNet * 1000 + finishingBonus - range * 2 - hostile.hits * 0.02;

      if (score > bestScore) {
        best = hostile;
        bestScore = score;
      }
    }

    if (!best) {
      continue;
    }

    assignments.set(tower.id, best);
    assignedTargetIds.add(best.id);
    appliedPressure[best.id] = (appliedPressure[best.id] || 0) + (towerDamageByHostileId?.get(best.id) || 0);
  }

  return assignments;
}

function ensureEmergencyRampartStore(roomName: string): Record<string, number> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.towerEmergencyRamparts = runtime.towerEmergencyRamparts || {};
  runtime.towerEmergencyRamparts[roomName] = runtime.towerEmergencyRamparts[roomName] || {};
  return runtime.towerEmergencyRamparts[roomName];
}

function collectEmergencyRamparts(room: Room): StructureRampart[] {
  const store = ensureEmergencyRampartStore(room.name);
  const roomContext = getTickContextService().getRoomContext(room);

  const ramparts = roomContext?.getRamparts() || [];
  const rampartById = new Map(ramparts.map((rampart) => [rampart.id, rampart]));

  for (const [rampartId] of Object.entries(store)) {
    const rampart = rampartById.get(rampartId as Id<StructureRampart>);
    if (!rampart || rampart.hits >= RAMPART_EMERGENCY_TARGET_HITS) {
      delete store[rampartId];
    }
  }

  for (const rampart of ramparts) {
    if (rampart.hits < RAMPART_EMERGENCY_TRIGGER_HITS) {
      store[rampart.id] = Game.time;
    }
  }

  return Object.keys(store)
    .map((rampartId) => rampartById.get(rampartId as Id<StructureRampart>) || null)
    .filter((rampart): rampart is StructureRampart => !!rampart && rampart.hits < RAMPART_EMERGENCY_TARGET_HITS);
}

function runTowerPeaceFlow(
  tower: StructureTower,
  emergencyRamparts: StructureRampart[],
  woundedCreeps: Creep[],
  damagedStructures: Structure<StructureConstant>[],
): void {
  const wounded = woundedCreeps.length > 0 ? tower.pos.findClosestByRange(woundedCreeps) : null;
  if (wounded) {
    const code = tower.heal(wounded);
    if (code === OK) {
      recordFixedCpuAction("towerControl");
    }
    return;
  }

  if (emergencyRamparts.length > 0 && tower.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_MIN_EMERGENCY_REPAIR_ENERGY) {
    const emergencyRampart = tower.pos.findClosestByRange(emergencyRamparts);
    if (emergencyRampart) {
      const code = tower.repair(emergencyRampart);
      if (code === OK) {
        recordFixedCpuAction("towerControl");
      }
      return;
    }
  }

  if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_MIN_REPAIR_ENERGY) {
    return;
  }

  const damaged = damagedStructures.length > 0 ? tower.pos.findClosestByRange(damagedStructures) : null;

  if (damaged) {
    const code = tower.repair(damaged);
    if (code === OK) {
      recordFixedCpuAction("towerControl");
    }
  }
}

function isAllHostilesImmune(analysis: TowerCombatAnalysis, hostiles: Creep[]): boolean {
  return hostiles.every(
    (hostile) =>
      (analysis.totalTowerAttackByHostileId.get(hostile.id) || 0) <=
      (analysis.incomingHealByHostileId.get(hostile.id) || 0),
  );
}

export function canTowersHandleHostiles(room: Room, hostiles: Creep[]): boolean {
  if (hostiles.length === 0) {
    return true;
  }

  const towers = (getTickContextService().getRoomContext(room)?.getTowers() || []).filter(
    (tower) => tower.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  );
  if (towers.length === 0) {
    return false;
  }

  const analysis = createTowerCombatAnalysis(towers, hostiles);
  return hostiles.every(
    (hostile) =>
      (analysis.totalTowerAttackByHostileId.get(hostile.id) || 0) >
      (analysis.incomingHealByHostileId.get(hostile.id) || 0),
  );
}

function isDefenderOnRampart(room: Room): boolean {
  const defenders = room.find(FIND_MY_CREEPS, {
    filter: (creep) => creep.memory.role === "homeDefender",
  });

  for (const defender of defenders) {
    const onRampart = defender.pos
      .lookFor(LOOK_STRUCTURES)
      .some((s) => s.structureType === STRUCTURE_RAMPART && (s as StructureRampart).my);
    if (onRampart) return true;
  }

  return false;
}

function getHomeDefenders(room: Room): Creep[] {
  return room.find(FIND_MY_CREEPS, {
    filter: (creep) => creep.memory.role === "homeDefender",
  });
}

function getParticipatingDefenderBurstDamage(room: Room, target: Creep): number {
  return getHomeDefenders(room)
    .filter((creep) => creep.pos.getRangeTo(target.pos) <= 1)
    .reduce((sum, creep) => sum + creep.getActiveBodyparts(ATTACK) * ATTACK_POWER, 0);
}

function chooseCoordinatedBurstTarget(
  room: Room,
  hostiles: Creep[],
  analysis: TowerCombatAnalysis,
): Creep | null {
  if (!isDefenderOnRampart(room)) {
    return null;
  }

  const safeZone = getSafeZone(room.name);
  if (safeZone.size === 0) {
    return null;
  }

  const insideHostiles = hostiles.filter((hostile) => safeZone.has(hostile.pos.x * 50 + hostile.pos.y));
  const preferredTarget = insideHostiles.length > 0
    ? chooseInsideBurstTarget(insideHostiles)
    : chooseBoundaryBurstEngagement(hostiles, getBoundaryRamparts(room, safeZone))?.hostile || null;

  if (!preferredTarget) {
    return null;
  }

  const totalTowerDamage = analysis.totalTowerAttackByHostileId.get(preferredTarget.id) || 0;
  const incomingHeal = analysis.incomingHealByHostileId.get(preferredTarget.id) || 0;
  const combinedBurst = totalTowerDamage + getParticipatingDefenderBurstDamage(room, preferredTarget);

  return combinedBurst > incomingHeal ? preferredTarget : null;
}

function runTowerCombat(room: Room, towers: StructureTower[], hostiles: Creep[], woundedCreeps: Creep[]): boolean {
  if (hostiles.length <= 0 || towers.length <= 0) {
    return false;
  }

  const attackTowers: StructureTower[] = [];
  for (const tower of towers) {
    if (woundedCreeps.length > 0) {
      const target = tower.pos.findClosestByRange(woundedCreeps);
      if (target) {
        const code = tower.heal(target);
        if (code === OK) {
          recordFixedCpuAction("towerControl");
        }
        continue;
      }
    }
    attackTowers.push(tower);
  }

  if (attackTowers.length === 0) {
    return true;
  }

  const coordinatedFront = getTowerFocusFront(room.name);
  const defaultFront = getRoomDefenseCoordination(room.name)?.fronts[0];
  const activeFront = coordinatedFront || defaultFront || null;
  const coordinatedHostiles = activeFront
    ? hostiles.filter((hostile) => activeFront.hostileIds.includes(hostile.id))
    : hostiles;
  const combatHostiles = coordinatedHostiles.length > 0 ? coordinatedHostiles : hostiles;
  setTowerFocusFront(room.name, activeFront?.id);

  const state = ensureTowerCombatRoomState(room.name);
  const analysis = createTowerCombatAnalysis(attackTowers, hostiles);
  const coordinatedBurstTarget = chooseCoordinatedBurstTarget(room, combatHostiles, analysis);

  if (!coordinatedBurstTarget && isAllHostilesImmune(analysis, combatHostiles)) {
    delete state.focusTargetId;
    delete state.lastFocusHits;
    delete state.stalledTicks;
    delete state.spreadUntil;
    return true;
  }

  const focusTarget = coordinatedBurstTarget || chooseFocusTarget(combatHostiles, analysis);
  if (!focusTarget) {
    delete state.focusTargetId;
    delete state.lastFocusHits;
    delete state.stalledTicks;
    delete state.spreadUntil;
    return true;
  }

  const focusTotalNet =
    (analysis.totalTowerAttackByHostileId.get(focusTarget.id) || 0) -
    (analysis.incomingHealByHostileId.get(focusTarget.id) || 0);
  const sameFocusAsLastTick = state.focusTargetId === focusTarget.id;
  const previousFocusHits = state.lastFocusHits;
  const focusDamageDelta =
    sameFocusAsLastTick && typeof previousFocusHits === "number" ? previousFocusHits - focusTarget.hits : TOWER_FOCUS_STALL_HITS_DELTA;

  if (sameFocusAsLastTick && focusDamageDelta < TOWER_FOCUS_STALL_HITS_DELTA) {
    state.stalledTicks = (state.stalledTicks || 0) + 1;
  } else {
    state.stalledTicks = 0;
  }

  const shouldForceSpread = (state.spreadUntil || 0) >= Game.time;
  const shouldProbeSpread = focusTotalNet <= 0 || (state.stalledTicks || 0) >= TOWER_FOCUS_STALL_TICKS;

  if (shouldProbeSpread) {
    state.spreadUntil = Game.time + TOWER_SPREAD_PROBE_DURATION;
  }

  const useSpread = shouldForceSpread || shouldProbeSpread;
  if (useSpread) {
    const spreadAssignments = assignSpreadTargets(attackTowers, combatHostiles, analysis);
    for (const tower of attackTowers) {
      const target = spreadAssignments.get(tower.id);
      if (target) {
        const code = tower.attack(target);
        if (code === OK) {
          recordFixedCpuAction("towerControl");
        }
      }
    }
  } else {
    for (const tower of attackTowers) {
      const code = tower.attack(focusTarget);
      if (code === OK) {
        recordFixedCpuAction("towerControl");
      }
    }
  }

  state.focusTargetId = focusTarget.id;
  state.lastFocusHits = focusTarget.hits;
  return true;
}

export function runTowerControl(): void {
  const tickContext = getTickContextService();
  const rooms = tickContext.getMyRooms();
  for (const room of rooms) {
    const roomContext = tickContext.getRoomContext(room);
    const hostiles = roomContext?.getHostileCreeps() || [];
    const towers = roomContext?.getTowers() || [];
    // 没有 Tower 的房间立即跳过：应急路障 store 与受损扫描都只服务于 Tower。
    if (towers.length === 0) {
      continue;
    }
    const emergencyRamparts = collectEmergencyRamparts(room);
    const woundedCreeps = (roomContext?.getMyCreeps() || []).filter((creep) => creep.hits < creep.hitsMax);
    // 普通受损结构扫描按房间 hash 错峰节流（战斗路径不消费该列表）；
    // 缓存命中时逐 id 现场解析，目标被摧毁/修满立即从候选中消失，
    // 候选全部耗尽时立即重扫，新损伤最迟在下一个扫描点被发现。
    const damagedStructures = getTowerDamagedStructures(room, roomContext);

    if (runTowerCombat(room, towers, hostiles, woundedCreeps)) {
      continue;
    }

    setTowerFocusFront(room.name, undefined);
    const state = ensureTowerCombatRoomState(room.name);
    delete state.focusTargetId;
    delete state.lastFocusHits;
    delete state.stalledTicks;
    delete state.spreadUntil;

    for (const tower of towers) {
      runTowerPeaceFlow(tower, emergencyRamparts, woundedCreeps, damagedStructures);
    }
  }
}

interface TowerDamagedScanCacheEntry {
  structureIds: Id<Structure>[];
}

const TOWER_DAMAGED_SCAN_INTERVAL = 10;
const towerDamagedScanCache = new Map<string, TowerDamagedScanCacheEntry>();

export function clearTowerDamagedScanCacheForTest(): void {
  towerDamagedScanCache.clear();
}

function isTowerRepairableDamaged(structure: Structure<StructureConstant>): boolean {
  return (
    structure.hits < structure.hitsMax &&
    structure.structureType !== STRUCTURE_WALL &&
    structure.structureType !== STRUCTURE_RAMPART
  );
}

function stableRoomNameHash(roomName: string): number {
  let hash = 0;
  for (let index = 0; index < roomName.length; index += 1) {
    hash = (hash * 31 + roomName.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function resolveDamagedStructuresByIds(structureIds: Id<Structure>[]): Structure<StructureConstant>[] {
  const resolved: Structure<StructureConstant>[] = [];
  for (const structureId of structureIds) {
    const structure = Game.getObjectById?.(structureId);
    if (structure && isTowerRepairableDamaged(structure)) {
      resolved.push(structure);
    }
  }
  return resolved;
}

function getTowerDamagedStructures(
  room: Room,
  roomContext: ReturnType<ReturnType<typeof getTickContextService>["getRoomContext"]>,
): Structure<StructureConstant>[] {
  const interval = TOWER_DAMAGED_SCAN_INTERVAL;
  const scanPhase = stableRoomNameHash(room.name) % interval;
  const due = Game.time % interval === scanPhase;
  const cached = towerDamagedScanCache.get(room.name);

  if (cached && !due) {
    const resolved = resolveDamagedStructuresByIds(cached.structureIds);
    if (resolved.length > 0 || cached.structureIds.length === 0) {
      return resolved;
    }
    // 缓存候选全部修满/失效：立即重扫而非等到下一个扫描点。
  }

  const damaged = (roomContext?.getStructures() || []).filter(isTowerRepairableDamaged);
  towerDamagedScanCache.set(room.name, { structureIds: damaged.map((structure) => structure.id) });
  return damaged;
}
