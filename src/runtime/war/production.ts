import { cancelSpawning, invalidateWarSpawnQueues, queuedSpawns, spawningForConfig } from "./spawnIndex";
import { getSquadPolicy } from "./squadPolicy/index";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import { clearMovementState } from "@/roles/shared";
import type { CreepConfig } from "@/types/system";
import { CONTROLLER_ATTACKER_QUEUE_INTERVAL, T3_ATTACKER_BOOSTS, T3_BOOST_PARTS, T3_DUO_BOOST_AMOUNTS, T3_HEALER_BOOSTS } from "./constants";
import type { WarGenerationState, WarRole, WarStatus, WarTask, WarTaskAssetReleaseOptions, WarTaskAssetReleaseResult } from "./store";
import { ensureConfigStore, getConfigName, getControllerAttackConfigName, getGenerationBoostTaskId, getGenerationConfigName, getLegacyWarBoostTaskId, getLiveCreepsByConfig, getTaskConfigNames, isPatrolTask, sameArray } from "./store";
import { getHealerCount, getMeleeCount, getRoleArgs, getRoleBody, isDuoTask, isT3DuoTask, isTowerDrainDuoTask } from "./squadPolicy/index";
import { onWarEntry, setTaskStatus } from "./fsm";

export function upsertWarConfig(store: Record<string, CreepConfig>, name: string, next: CreepConfig): void {
  const old = store[name];
  if (old && old.role === next.role && old.roomName === next.roomName && sameArray(old.args, next.args)
    && (old.body === next.body || sameArray(old.body, next.body ?? []))
    && (old.spawnOnce === next.spawnOnce || JSON.stringify(old.spawnOnce) === JSON.stringify(next.spawnOnce))) return;
  store[name] = next;
}

export function getSpawnsForRoom(roomName: string): StructureSpawn[] {
  return getTickContextService().getSpawnsByRoom(roomName);
}

export function isConfigQueuedInSpawns(spawns: StructureSpawn[], configName: string): boolean {
  return queuedSpawns(configName).some(spawn => spawns.includes(spawn));
}

export function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

export function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  return [...spawns].sort((left, right) => {
    const loadDiff = getSpawnQueueLoad(left) - getSpawnQueueLoad(right);
    if (loadDiff !== 0) return loadDiff;
    return left.name.localeCompare(right.name);
  })[0];
}

export function getCombatPartnerConfigName(task: WarTask, role: WarRole, index: number): string {
  if (getSquadPolicy(task).duo) {
    const generation = ensureActiveGeneration(task);
    return role === "meleeAttacker"
      ? generation.configNames.healer
      : generation.configNames.meleeAttacker;
  }

  if (role === "meleeAttacker") {
    return index < getHealerCount(task) ? getConfigName(task, "healer", index) : "";
  }
  return index < getMeleeCount(task) ? getConfigName(task, "meleeAttacker", index) : "";
}

export function resetWarCreepTargetState(creep: Creep): void {
  clearMovementState(creep);
  delete creep.memory._warBreachTargetId;
  delete creep.memory._warBreachResumeUntil;
  delete creep.memory._warCounterstrike;
  delete creep.memory._warCounterstrikeSuppressedTargetIds;
  delete creep.memory._warQueued;
  delete creep.memory._warTowerDrain;
}

export function synchronizeGenerationRoleArgs(task: WarTask, resetTargets: boolean): void {
  const generation = task.activeGeneration;
  if (!generation) return;

  const encodedRoute = task.routeRooms?.join("|") || "";
  const version = JSON.stringify([task.targetRoom, encodedRoute, task.squad, task.tactic, task.boostTier, generation.id, generation.configNames,
    getGenerationCreeps(generation).map(creep => creep.name)]);
  if (!resetTargets && generation.argsVersion === version) return;
  const store = ensureConfigStore();
  for (const role of ["meleeAttacker", "healer"] as const) {
    const configName = generation.configNames[role];
    const partnerConfigName = role === "meleeAttacker"
      ? generation.configNames.healer
      : generation.configNames.meleeAttacker;
    const args = getRoleArgs(task, role, encodedRoute, generation.boostTaskId, partnerConfigName);
    if (store[configName]) {
      if (!sameArray(store[configName].args, args)) store[configName].args = args;
    }
    for (const creep of getLiveCreepsByConfig(configName)) {
      if (creep.memory.roleArgs?.[1] !== undefined && creep.memory.roleArgs[1] !== encodedRoute) clearMovementState(creep);
      if (!sameArray(creep.memory.roleArgs, args)) creep.memory.roleArgs = [...args];
      if (resetTargets) resetWarCreepTargetState(creep);
    }
  }
  generation.argsVersion = version;
}

export function hasTaskWarActivity(task: WarTask): boolean {
  const spawns = getSpawnsForRoom(task.sourceRoom);
  return getTaskConfigNames(task).some((configName) =>
    getLiveCreepsByConfig(configName).length > 0
    || isConfigQueuedInSpawns(spawns, configName)
    || isConfigSpawning(configName)
  );
}

export function isConfigSpawning(configName: string): boolean {
  return spawningForConfig(configName).length > 0;
}

export function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  const config = ensureConfigStore()[configName];
  if (toFront) {
    const next = [configName, ...queue.filter((name) => name !== configName)];
    if (!sameArray(queue, next)) { spawn.memory.spawnList = next; invalidateWarSpawnQueues(); }
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName); invalidateWarSpawnQueues();
    if (config?.spawnOnce && config.spawnOnce.queuedAt === undefined) {
      config.spawnOnce.queuedAt = Game.time;
    }
  }
}

export function shouldQueueWarConfig(config: CreepConfig | undefined): boolean {
  return config?.spawnOnce?.queuedAt === undefined;
}

export function removeQueuedConfig(task: WarTask, configName: string): void {
  for (const spawn of getTickContextService().getSpawnsByRoom(task.sourceRoom)) {
    if (spawn.memory.spawnList?.includes(configName)) {
      spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName); invalidateWarSpawnQueues();
    }
  }
}

export function removeQueuedConfigByName(configName: string): number {
  let removed = 0;
  for (const spawn of queuedSpawns(configName)) {
    const queue = spawn.memory.spawnList ?? [];
    const next = queue.filter(name => name !== configName);
    if (next.length !== queue.length) { spawn.memory.spawnList = next; invalidateWarSpawnQueues(); removed += queue.length - next.length; }
  }
  return removed;
}

export function collectSpawningForConfigs(configNames: ReadonlySet<string>): Spawning[] {
  return [...new Set([...configNames].flatMap(name => spawningForConfig(name)))];
}

export function detachWarTaskCreeps(task: WarTask, configNames: ReadonlySet<string>, suicide: boolean): { detachedCreeps: number; suicidedCreeps: number } {
  const detachedNames = new Set<string>(); let suicided = 0;
  for (const configName of configNames) {
    const actors = getLiveCreepsByConfig(configName);
    for (const creep of actors) {
      if (suicide && creep.suicide() === OK) suicided++;
      creep.memory._warDetached = true;
      delete creep.memory._warPartnerConfigName; delete creep.memory.configName;
      detachedNames.add(creep.name);
    }
    for (const name of task.members?.[configName]?.creepNames ?? []) {
      const memory = Memory.creeps?.[name];
      if (!memory || memory.configName !== configName) continue;
      memory._warDetached = true; delete memory._warPartnerConfigName; delete memory.configName; detachedNames.add(name);
    }
  }
  return { detachedCreeps: detachedNames.size, suicidedCreeps: suicided };
}

export function removeConfigWhenIdle(configName: string): void {
  if (getLiveCreepsByConfig(configName).length > 0 || isConfigSpawning(configName)) {
    return;
  }

  const store = ensureConfigStore();
  if (store[configName]) {
    delete store[configName];
  }
}

export function removeConfig(configName: string): number {
  const store = ensureConfigStore();
  if (!store[configName]) {
    return 0;
  }

  delete store[configName];
  return 1;
}

export function createGeneration(task: WarTask, id: number): WarGenerationState {
  return {
    id,
    phase: getSquadPolicy(task).parallel ? "assembling" : "preparing",
    createdAt: Game.time,
    boostTaskId: getGenerationBoostTaskId(task, id),
    configNames: {
      meleeAttacker: getGenerationConfigName(task, id, "meleeAttacker"),
      healer: getGenerationConfigName(task, id, "healer"),
    },
  };
}

export function hasConfigActivity(task: WarTask, configName: string): boolean {
  const spawns = getSpawnsForRoom(task.sourceRoom);
  return getLiveCreepsByConfig(configName).length > 0
    || isConfigQueuedInSpawns(spawns, configName)
    || isConfigSpawning(configName);
}

export function ensureActiveGeneration(task: WarTask): WarGenerationState {
  if (task.activeGeneration) return task.activeGeneration;

  const legacyConfigNames = {
    meleeAttacker: getConfigName(task, "meleeAttacker", 0),
    healer: getConfigName(task, "healer", 0),
  };
  const hasLegacyActivity = Object.values(legacyConfigNames).some((configName) =>
    hasConfigActivity(task, configName)
  );

  if (hasLegacyActivity) {
    const liveLegacyCreeps = Object.values(legacyConfigNames).flatMap((configName) =>
      getLiveCreepsByConfig(configName)
    );
    const deployed = liveLegacyCreeps.some((creep) => creep.room.name !== task.sourceRoom);
    task.generationCounter = Math.max(task.generationCounter ?? 0, 0);
    task.activeGeneration = {
      id: 0,
      phase: deployed ? "deployed" : "assembling",
      createdAt: Game.time,
      boostTaskId: getLegacyWarBoostTaskId(task),
      boostGateOpenedAt: getSquadPolicy(task).needsBoost ? Game.time : undefined,
      deployedAt: deployed ? Game.time : undefined,
      configNames: legacyConfigNames,
    };
    return task.activeGeneration;
  }

  for (const configName of Object.values(legacyConfigNames)) {
    removeConfigWhenIdle(configName);
  }
  const nextId = Math.max(task.generationCounter ?? 0, 0) + 1;
  task.generationCounter = nextId;
  task.activeGeneration = createGeneration(task, nextId);
  return task.activeGeneration;
}

export function getCombatConfigName(task: WarTask, role: WarRole, index: number): string {
  if (getSquadPolicy(task).duo) {
    return ensureActiveGeneration(task).configNames[role];
  }
  return getConfigName(task, role, index);
}

export function getControllerAttackBody(sourceRoomName: string): BodyPartConstant[] {
  const roomCapacity = Game.rooms[sourceRoomName]?.energyCapacityAvailable ?? 0;
  const spawnCapacity = getSpawnsForRoom(sourceRoomName).reduce(
    (maximum, spawn) => Math.max(maximum, spawn.room.energyCapacityAvailable ?? 0),
    0,
  );
  const energyCapacity = Math.max(roomCapacity, spawnCapacity);
  const pairCost = BODYPART_COST[CLAIM] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(25, Math.floor(energyCapacity / pairCost)));
  return [
    ...Array(pairCount).fill(CLAIM),
    ...Array(pairCount).fill(MOVE),
  ];
}

export function inferControllerAttackerQueuedAt(creep: Creep): number | undefined {
  if (creep.ticksToLive === undefined) return undefined;
  const livedTicks = Math.max(0, CREEP_CLAIM_LIFE_TIME - creep.ticksToLive);
  return Game.time - livedTicks - creep.body.length * CREEP_SPAWN_TIME;
}

export function ensureControllerAttackConfig(task: WarTask): void {
  if (Object.values(Memory.cfg?.warRebuildWatch ?? {}).some(watch => watch.sharedSquad
    && watch.sourceRoom === task.sourceRoom && watch.targetRooms.includes(task.targetRoom))) return;
  const configName = getControllerAttackConfigName(task);
  const encodedRoute = task.routeRooms?.join("|") || "";
  const store = ensureConfigStore();
  const existing = store[configName];
  const liveCreeps = getLiveCreepsByConfig(configName);
  const existingQueuedAt = existing?.spawnOnce?.queuedAt;
  if (
    existingQueuedAt !== undefined
    && (task.controllerAttackerLastQueuedAt === undefined || existingQueuedAt > task.controllerAttackerLastQueuedAt)
  ) {
    task.controllerAttackerLastQueuedAt = existingQueuedAt;
  }
  if (task.controllerAttackerLastQueuedAt === undefined) {
    const inferredQueuedAt = liveCreeps
      .map(inferControllerAttackerQueuedAt)
      .filter((tick): tick is number => tick !== undefined)
      .reduce<number | undefined>((earliest, tick) => earliest === undefined ? tick : Math.min(earliest, tick), undefined);
    task.controllerAttackerLastQueuedAt = inferredQueuedAt;
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  const queued = isConfigQueuedInSpawns(spawns, configName);
  const spawning = isConfigSpawning(configName);
  const active = liveCreeps.length > 0 || queued || spawning;
  const targetController = Game.rooms[task.targetRoom]?.controller;
  if (!active && targetController && (targetController.upgradeBlocked ?? 0) <= 0) {
    task.controllerAttackerLastQueuedAt = undefined;
  }

  const lastQueuedAt = task.controllerAttackerLastQueuedAt;
  const queueDue = lastQueuedAt === undefined || Game.time - lastQueuedAt >= CONTROLLER_ATTACKER_QUEUE_INTERVAL;

  upsertWarConfig(store, configName, {
    role: "claimer",
    args: [task.targetRoom, encodedRoute, "attack"],
    roomName: task.sourceRoom,
    body: getControllerAttackBody(task.sourceRoom),
    spawnOnce: queueDue && !active ? {} : { queuedAt: lastQueuedAt },
  });

  if (
    spawns.length === 0
    || active
    || !queueDue
  ) {
    return;
  }

  const spawn = selectLeastLoadedSpawn(spawns);
  if (spawn) {
    enqueueConfig(spawn, configName, true);
    task.controllerAttackerLastQueuedAt = Game.time;
  }
}

export function clearControllerAttackConfig(task: WarTask): void {
  const configName = getControllerAttackConfigName(task);
  removeQueuedConfig(task, configName);
  removeConfig(configName);
}

export function combatConfigCurrent(task: WarTask, role: WarRole, index: number, route: string, generation: WarGenerationState | undefined, current: CreepConfig | undefined): boolean {
  if (!current || current.role !== role || current.roomName !== task.sourceRoom) return false;
  const policy = getSquadPolicy(task); const args = current.args;
  if (!Array.isArray(args)) return false;
  const tactic = policy.parallel ? "towerDrainDuo" : task.tactic;
  const expectedLength = tactic ? 6 : 5;
  const boosts = role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS;
  if (args.length !== expectedLength || args[0] !== task.targetRoom || args[1] !== route
    || args[2] !== (policy.needsBoost ? generation?.boostTaskId ?? getLegacyWarBoostTaskId(task) : "")
    || args[3] !== (policy.needsBoost ? boosts.join("|") : "")
    || args[4] !== getCombatPartnerConfigName(task, role, index) || tactic && args[5] !== tactic) return false;
  const body = policy.bodies[role];
  return (body ? sameArray(current.body, body) : current.body === undefined)
    && (!!current.spawnOnce === (task.oneShot === true || policy.parallel));
}

export function ensureCombatConfigs(task: WarTask): void {
  const store = ensureConfigStore();
  const encodedRoute = task.routeRooms?.join("|") || "";
  const generation = getSquadPolicy(task).duo ? ensureActiveGeneration(task) : undefined;
  if (generation?.phase === "deployed") return;

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getCombatConfigName(task, "meleeAttacker", i);
    const existing = store[configName];
    if (combatConfigCurrent(task, "meleeAttacker", i, encodedRoute, generation, existing)) continue;
    upsertWarConfig(store, configName, {
      role: "meleeAttacker",
      args: getRoleArgs(
        task,
        "meleeAttacker",
        encodedRoute,
        generation?.boostTaskId,
        getCombatPartnerConfigName(task, "meleeAttacker", i),
      ),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "meleeAttacker"),
      spawnOnce: task.oneShot || getSquadPolicy(task).parallel ? (existing?.spawnOnce ?? {}) : undefined,
    });
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getCombatConfigName(task, "healer", i);
    const existing = store[configName];
    if (combatConfigCurrent(task, "healer", i, encodedRoute, generation, existing)) continue;
    upsertWarConfig(store, configName, {
      role: "healer",
      args: getRoleArgs(
        task,
        "healer",
        encodedRoute,
        generation?.boostTaskId,
        getCombatPartnerConfigName(task, "healer", i),
      ),
      roomName: task.sourceRoom,
      body: getRoleBody(task, "healer"),
      spawnOnce: task.oneShot || getSquadPolicy(task).parallel ? (existing?.spawnOnce ?? {}) : undefined,
    });
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    return;
  }

  for (let i = 0; i < getMeleeCount(task); i++) {
    const configName = getCombatConfigName(task, "meleeAttacker", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning && shouldQueueWarConfig(store[configName])) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }

  for (let i = 0; i < getHealerCount(task); i++) {
    const configName = getCombatConfigName(task, "healer", i);
    const hasLive = getLiveCreepsByConfig(configName).length > 0;
    const queued = isConfigQueuedInSpawns(spawns, configName);
    const spawning = isConfigSpawning(configName);
    if (!hasLive && !queued && !spawning && shouldQueueWarConfig(store[configName])) {
      const targetSpawn = selectLeastLoadedSpawn(spawns);
      if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
    }
  }
}

export function getGenerationCreeps(generation: WarGenerationState): Creep[] {
  return Object.values(generation.configNames).flatMap((configName) =>
    getLiveCreepsByConfig(configName)
  );
}

export function isGenerationComplete(generation: WarGenerationState): boolean {
  return getLiveCreepsByConfig(generation.configNames.meleeAttacker).length > 0
    && getLiveCreepsByConfig(generation.configNames.healer).length > 0;
}

export function cleanupGenerationConfigs(task: WarTask, generation: WarGenerationState): void {
  for (const configName of Object.values(generation.configNames)) {
    removeQueuedConfig(task, configName);
    removeConfig(configName);
  }
}

export function reconcileGenerationLifecycle(task: WarTask): boolean {
  if (!getSquadPolicy(task).duo) return false;

  const generation = ensureActiveGeneration(task);
  const generationCreeps = getGenerationCreeps(generation);
  synchronizeGenerationRoleArgs(task, false);

  if (
    generation.phase === "assembling"
    && generationCreeps.some((creep) => creep.room.name !== task.sourceRoom)
  ) {
    generation.phase = "deployed";
    generation.deployedAt = Game.time;
    if (getSquadPolicy(task).needsBoost) {
      releaseBoostLabs(generation.boostTaskId, task.sourceRoom);
      task.boostLabs = [];
    }
    cleanupGenerationConfigs(task, generation);
  }

  // 每个耗塔 generation 的角色只生成一次。排队/生成中不是损失；
  // 已排队过而当前完全没有活动的角色，才表示本代在出发前耗尽。
  const exhaustedBeforeDeployment = getSquadPolicy(task).parallel
    && generation.phase === "assembling"
    && Object.values(generation.configNames).some((configName) =>
      ensureConfigStore()[configName]?.spawnOnce?.queuedAt !== undefined
      && !hasConfigActivity(task, configName)
    );
  if (!exhaustedBeforeDeployment && (generation.phase !== "deployed" || isGenerationComplete(generation))) {
    return false;
  }

  const generationConfigs = new Set(Object.values(generation.configNames));
  const unfinishedSpawns = getSquadPolicy(task).parallel ? collectSpawningForConfigs(generationConfigs) : [];
  detachWarTaskCreeps(task, generationConfigs, isPatrolTask(task));
  for (const spawn of unfinishedSpawns) cancelSpawning(spawn);
  cleanupGenerationConfigs(task, generation);

  if (task.oneShot) {
    transitionWarTaskTerminal(task, "failed", "generation_exhausted");
    return true;
  }

  const nextId = Math.max(task.generationCounter ?? generation.id, generation.id) + 1;
  task.generationCounter = nextId;
  task.activeGeneration = createGeneration(task, nextId);
  task.boostStatus = getSquadPolicy(task).needsBoost ? "preparing" : undefined;
  task.failReason = undefined;
  return true;
}

export function getGenerationRemainingBoostAmounts(
  task: WarTask,
  generation: WarGenerationState,
): Map<ResourceConstant, number> {
  const amounts = new Map<ResourceConstant, number>();
  const spawns = getSpawnsForRoom(task.sourceRoom);

  for (const role of ["meleeAttacker", "healer"] as const) {
    const configName = generation.configNames[role];
    const creep = getLiveCreepsByConfig(configName)[0];
    if (!creep && task.oneShot) {
      const config = ensureConfigStore()[configName];
      const active = isConfigQueuedInSpawns(spawns, configName) || isConfigSpawning(configName);
      if (!active && config?.spawnOnce?.queuedAt !== undefined) {
        continue;
      }
    }

    const body = creep?.body ?? (getRoleBody(task, role) ?? []).map((type) => ({
      type,
      hits: 100,
    } as BodyPartDefinition));
    const compounds = role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS;
    for (const compound of compounds) {
      const partType = T3_BOOST_PARTS[compound];
      if (!partType) continue;
      const partCount = body.filter((part) =>
        part.type === partType && part.hits > 0 && part.boost !== compound
      ).length;
      if (partCount <= 0) continue;
      amounts.set(compound, (amounts.get(compound) ?? 0) + partCount * LAB_BOOST_MINERAL);
    }
  }

  return amounts;
}

export function prepareCombatSquad(task: WarTask): boolean {
  if (getSquadPolicy(task).parallel) {
    const generation = ensureActiveGeneration(task);
    if (generation.phase === "preparing") generation.phase = "assembling";
    if (task.boostTier !== undefined) delete task.boostTier;
    if (task.boostStatus !== undefined) delete task.boostStatus;
    if (task.boostLabs !== undefined) delete task.boostLabs;
    return true;
  }
  if (!getSquadPolicy(task).needsBoost) return true;

  const generation = ensureActiveGeneration(task);
  if (generation.phase === "deployed") return true;
  if (generation.boostGateOpenedAt !== undefined) {
    const remainingAmounts = getGenerationRemainingBoostAmounts(task, generation);
    const result = prepareBoosts(
      generation.boostTaskId,
      task.sourceRoom,
      0,
      remainingAmounts,
      { requireLabEnergy: true },
    );
    if (!sameArray(task.boostLabs, result.labs)) task.boostLabs = result.labs;
    if (task.boostStatus !== result.status) task.boostStatus = result.status;
    if (task.failReason !== result.reason) task.failReason = result.reason;
    if (result.status === "failed" && result.reason === "insufficient_labs") {
      task.boostStatus = "preparing";
    }
    return true;
  }

  const result = prepareBoosts(
    generation.boostTaskId,
    task.sourceRoom,
    0,
    T3_DUO_BOOST_AMOUNTS,
    { requireLabEnergy: true },
  );
  if (!sameArray(task.boostLabs, result.labs)) task.boostLabs = result.labs;
  if (task.boostStatus !== result.status) task.boostStatus = result.status;
  if (task.failReason !== result.reason) task.failReason = result.reason;

  if (result.status === "failed" && result.reason === "insufficient_labs") {
    task.boostStatus = "preparing";
    return false;
  }

  if (result.status === "failed") {
    transitionWarTaskTerminal(task, "failed", result.reason);
    return false;
  }

  if (result.status === "preparing") {
    return false;
  }

  generation.boostGateOpenedAt = Game.time;
  generation.phase = "assembling";
  return true;
}

export function releaseWarBoosts(task: WarTask): void {
  if (!getSquadPolicy(task).needsBoost) return;
  releaseBoostLabs(
    task.activeGeneration?.boostTaskId ?? getLegacyWarBoostTaskId(task),
    task.sourceRoom,
  );
  task.boostLabs = [];
}

export function releaseWarTaskAssets(
  task: WarTask,
  options: WarTaskAssetReleaseOptions = {},
): WarTaskAssetReleaseResult {
  const configNames = new Set(getTaskConfigNames(task));
  const spawning = collectSpawningForConfigs(configNames);
  let removedQueuedTasks = 0;
  let removedConfigs = 0;
  for (const configName of configNames) {
    removedQueuedTasks += removeQueuedConfigByName(configName);
  }

  const detached = detachWarTaskCreeps(task, configNames, options.suicide === true);
  let cancelledSpawns = 0;
  for (const spawnState of spawning) {
    if (cancelSpawning(spawnState) === OK) cancelledSpawns += 1;
  }
  for (const configName of configNames) {
    removedConfigs += removeConfig(configName);
  }

  const releasedBoosts = getSquadPolicy(task).needsBoost;
  releaseWarBoosts(task);
  if (
    typeof task.assetsReleasedAt !== "number"
    || !Number.isFinite(task.assetsReleasedAt)
    || task.assetsReleasedAt < 0
  ) {
    task.assetsReleasedAt = Game.time;
  }
  return {
    removedConfigs,
    removedQueuedTasks,
    cancelledSpawns,
    detachedCreeps: detached.detachedCreeps,
    suicidedCreeps: detached.suicidedCreeps,
    releasedBoosts,
  };
}

export function transitionWarTaskTerminal(
  task: WarTask,
  status: Extract<WarStatus, "done" | "failed">,
  failReason?: string | null,
): WarTaskAssetReleaseResult {
  setTaskStatus(task, status);
  task.completedAt ??= Game.time;
  if (failReason === null) {
    task.failReason = undefined;
  } else if (failReason !== undefined) {
    task.failReason = failReason;
  }
  let result: WarTaskAssetReleaseResult = { removedConfigs: 0, removedQueuedTasks: 0, cancelledSpawns: 0, detachedCreeps: 0, suicidedCreeps: 0, releasedBoosts: false };
  onWarEntry(task, "terminal_release", () => { result = releaseWarTaskAssets(task); });
  return result;
}

export function disableTaskProduction(task: WarTask): void {
  for (const configName of getTaskConfigNames(task)) {
    removeQueuedConfig(task, configName);
    removeConfig(configName);
  }
}

export function getQueuedConfigs(task: WarTask): string[] {
  return getTaskConfigNames(task).filter(name => queuedSpawns(name).some(spawn => spawn.room.name === task.sourceRoom));
}
