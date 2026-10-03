type PowerBankCombatRuntimeMemory = CreepMemory & {
  taskId?: string;
  pairGeneration?: number;
};

type RuntimeReinforcementState = PowerBankReinforcementState & {
  generation?: number;
  combatReady?: boolean;
};

type RuntimePowerBankTask = PowerBankHarvestTask & {
  activeGeneration?: number;
  combatReady?: boolean;
  routeRooms?: string[];
  avoidRooms?: string[];
  reinforcement?: RuntimeReinforcementState;
};

export interface PowerBankPairContext {
  task: RuntimePowerBankTask;
  attacker: Creep;
  healer: Creep;
  generation?: number;
  stage: PowerBankHarvestStatus | PowerBankReinforcementStage;
  combatReady: boolean;
  reinforcement: boolean;
}

function findCreepById(id: string): Creep | null {
  const object = typeof Game.getObjectById === "function" ? Game.getObjectById(id as Id<Creep>) : null;
  if (object && "body" in object && "memory" in object) {
    return object as Creep;
  }

  for (const creep of Object.values(Game.creeps)) {
    if (creep.id === id) return creep;
  }
  return null;
}

export function getPowerBankTaskForCreep(creep: Creep): RuntimePowerBankTask | null {
  const taskId = (creep.memory as PowerBankCombatRuntimeMemory).taskId;
  if (!taskId) return null;
  return (Memory.data?.powerBankHarvest?.[taskId] as RuntimePowerBankTask | undefined) ?? null;
}

function hasMatchingGeneration(creep: Creep, generation: number | undefined): boolean {
  if (generation === undefined) return true;
  return (creep.memory as PowerBankCombatRuntimeMemory).pairGeneration === generation;
}

function hasMatchingTask(creep: Creep, task: RuntimePowerBankTask): boolean {
  return (creep.memory as PowerBankCombatRuntimeMemory).taskId === task.id;
}

function legacyReadiness(task: RuntimePowerBankTask): boolean {
  return task.combatReady !== false && task.attackerReady !== false && task.healerReady !== false;
}

/**
 * Resolves only the pair whose task-owned member ID and generation match the
 * running creep. Config-name or same-task fallbacks are intentionally avoided:
 * they can bind a freshly spawned replacement or another generation.
 */
export function resolvePowerBankPair(creep: Creep, task: RuntimePowerBankTask): PowerBankPairContext | null {
  const role = creep.memory.role;
  if (role !== "powerBankAttacker" && role !== "powerBankHealer") return null;
  if (!hasMatchingTask(creep, task)) return null;

  const memory = creep.memory as PowerBankCombatRuntimeMemory;
  const reinforcement = task.reinforcement;
  const selfIdKey = role === "powerBankAttacker" ? "attackerId" : "healerId";
  const selfIsReinforcement = !!reinforcement && (
    (memory.pairGeneration !== undefined && reinforcement.generation === memory.pairGeneration) ||
    reinforcement[selfIdKey] === creep.id
  );

  let attackerId: string | undefined;
  let healerId: string | undefined;
  let generation: number | undefined;
  let stage: PowerBankHarvestStatus | PowerBankReinforcementStage;
  let combatReady: boolean;

  if (selfIsReinforcement && reinforcement) {
    attackerId = reinforcement.attackerId;
    healerId = reinforcement.healerId;
    generation = reinforcement.generation;
    stage = reinforcement.stage;
    combatReady = generation === undefined
      ? reinforcement.combatReady !== false && reinforcement.attackerReady !== false && reinforcement.healerReady !== false
      : reinforcement.combatReady === true;
  } else {
    attackerId = task.attackerId;
    healerId = task.healerId;
    generation = task.activeGeneration;
    stage = task.status;
    combatReady = generation === undefined ? legacyReadiness(task) : task.combatReady === true;
  }

  const expectedSelfId = role === "powerBankAttacker" ? attackerId : healerId;
  if (!expectedSelfId || expectedSelfId !== creep.id || !attackerId || !healerId) return null;
  if (!hasMatchingGeneration(creep, generation)) return null;

  const attacker = role === "powerBankAttacker" ? creep : findCreepById(attackerId);
  const healer = role === "powerBankHealer" ? creep : findCreepById(healerId);
  if (!attacker || !healer) return null;
  if (attacker.memory.role !== "powerBankAttacker" || healer.memory.role !== "powerBankHealer") return null;
  if (!hasMatchingTask(attacker, task) || !hasMatchingTask(healer, task)) return null;
  if (!hasMatchingGeneration(attacker, generation) || !hasMatchingGeneration(healer, generation)) return null;

  return {
    task,
    attacker,
    healer,
    generation,
    stage,
    combatReady,
    reinforcement: selfIsReinforcement,
  };
}

export function pairReadyForTravel(pair: PowerBankPairContext): boolean {
  return pair.combatReady;
}

export function pairReadyForCombat(pair: PowerBankPairContext): boolean {
  if (!pair.combatReady) return false;
  if (pair.attacker.room.name !== pair.healer.room.name) return false;
  if (!pair.attacker.pos.isNearTo(pair.healer.pos)) return false;
  if (pair.attacker.getActiveBodyparts(ATTACK) <= 0) return false;
  if (pair.attacker.getActiveBodyparts(TOUGH) <= 0) return false;
  if (pair.healer.getActiveBodyparts(HEAL) <= 0) return false;
  return true;
}

export function getPowerBankEncodedRoute(task: RuntimePowerBankTask, fallback?: string): string | undefined {
  const routeRooms = task.routeRooms;
  if (!Array.isArray(routeRooms) || routeRooms.length === 0) return fallback;
  const validRooms = routeRooms.filter((roomName): roomName is string => typeof roomName === "string" && roomName.length > 0);
  return validRooms.length > 0 ? validRooms.join("|") : fallback;
}

export function getPowerBankEncodedRouteBetween(
  task: Pick<RuntimePowerBankTask, "routeRooms"> | null | undefined,
  fromRoom: string,
  targetRoom: string,
  fallback?: string,
): string | undefined {
  const taskRouteRooms = task?.routeRooms;
  const routeRooms = Array.isArray(taskRouteRooms) && taskRouteRooms.length > 0
    ? taskRouteRooms
    : fallback?.split("|").filter((roomName) => roomName.length > 0) ?? [];
  if (routeRooms.length === 0) return undefined;

  const fromIndex = routeRooms.lastIndexOf(fromRoom);
  const targetIndex = routeRooms.lastIndexOf(targetRoom);
  if (fromIndex >= 0 && targetIndex >= 0) {
    const segment = fromIndex <= targetIndex
      ? routeRooms.slice(fromIndex, targetIndex + 1)
      : routeRooms.slice(targetIndex, fromIndex + 1).reverse();
    return segment.join("|");
  }

  // A creep outside the snapshot must recover dynamically toward the requested
  // room; replaying the whole forward route can send a follower farther away.
  return undefined;
}

export function getPowerBankNextRouteRoom(task: RuntimePowerBankTask, currentRoom: string): string {
  const routeRooms = task.routeRooms;
  if (!Array.isArray(routeRooms) || routeRooms.length === 0) return task.targetRoom;
  const currentIndex = routeRooms.lastIndexOf(currentRoom);
  if (currentIndex < 0 || currentIndex + 1 >= routeRooms.length) return task.targetRoom;
  return routeRooms[currentIndex + 1];
}

export function getPowerBankAvoidRooms(task: RuntimePowerBankTask): string[] {
  const avoidRooms = new Set<string>();
  if (Array.isArray(task.avoidRooms)) {
    for (const roomName of task.avoidRooms) {
      if (typeof roomName === "string" && roomName.length > 0) avoidRooms.add(roomName);
    }
  }

  // Compatibility for active tasks created before task-level route snapshots.
  const runtime = Memory.runtime;
  for (const [roomName, expiresAt] of Object.entries(runtime?.transitDangerRooms ?? {})) {
    if (typeof expiresAt === "number" && expiresAt > Game.time) avoidRooms.add(roomName);
  }
  for (const [roomName, dangerous] of Object.entries(runtime?.powerBankPermanentDangerRooms ?? {})) {
    if (dangerous) avoidRooms.add(roomName);
  }

  avoidRooms.delete(task.sourceRoom);
  avoidRooms.delete(task.targetRoom);
  return [...avoidRooms];
}
