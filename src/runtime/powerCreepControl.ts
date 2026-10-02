import { executeTreasuryFencedTerminalCargo } from "@/runtime/treasuryTerminalCargo";
import type {
  PowerCreepRoomCapability,
  PowerCreepRoomEnergyPolicy,
  PowerCreepTask,
  PowerCreepTaskType,
} from "@/runtime/powerCreepTypes";
import { ensureCreepMovementState } from "@/movement/creepState";
import { moveToTarget } from "@/movement/pathing";

export const POWER_CREEP_RENEW_TTL = 200;
export const POWER_CREEP_OPS_HIGH_WATER_RATIO = 0.9;
export const POWER_CREEP_OPS_RETAIN_RATIO = 0.5;

const TASK_PRIORITY: Record<PowerCreepTaskType, number> = {
  renew: 1_000,
  enable_room: 950,
  deposit_ops: 900,
  operate_storage: 400,
  regen_source: 300,
  operate_extension: 300,
  generate_ops: 300,
};

const POWER_TASKS: Partial<Record<PowerCreepTaskType, PowerConstant>> = {
  operate_storage: PWR_OPERATE_STORAGE,
  regen_source: PWR_REGEN_SOURCE,
  operate_extension: PWR_OPERATE_EXTENSION,
  generate_ops: PWR_GENERATE_OPS,
};

let capabilityCacheTick = -1;
let capabilityCache: Record<string, PowerCreepRoomCapability> = {};

function getOwnedPowerSpawn(room: Room | undefined): StructurePowerSpawn | null {
  if (!room?.controller?.my) {
    return null;
  }

  return room.find(FIND_MY_STRUCTURES).find(
    (structure): structure is StructurePowerSpawn => structure.structureType === STRUCTURE_POWER_SPAWN,
  ) || null;
}

function isPowerCreepHostRoom(room: Room | undefined): room is Room {
  return !!room?.controller?.my && !!getOwnedPowerSpawn(room);
}

export function resolvePowerCreepHomeRoomName(powerCreep: PowerCreep): string | null {
  if (powerCreep.memory.homeRoom) {
    return powerCreep.memory.homeRoom;
  }

  const roomMatchingName = Game.rooms[powerCreep.name];
  if (isPowerCreepHostRoom(roomMatchingName)) {
    powerCreep.memory.homeRoom = roomMatchingName.name;
    capabilityCacheTick = -1;
    return roomMatchingName.name;
  }

  return null;
}

function getPowerLevel(powerCreep: PowerCreep, power: PowerConstant): number {
  return powerCreep.powers[power]?.level || 0;
}

function getPowerCooldown(powerCreep: PowerCreep, power: PowerConstant): number | undefined {
  return powerCreep.powers[power]?.cooldown;
}

function isPowerReady(powerCreep: PowerCreep, power: PowerConstant): boolean {
  return getPowerLevel(powerCreep, power) > 0 && getPowerCooldown(powerCreep, power) === 0;
}

function getPowerOpsCost(powerCreep: PowerCreep, power: PowerConstant): number {
  const level = getPowerLevel(powerCreep, power);
  if (level <= 0) {
    return 0;
  }

  const configured = (POWER_INFO[power] as { ops?: number | number[] } | undefined)?.ops;
  if (Array.isArray(configured)) {
    return configured[level - 1] || 0;
  }
  return configured || 0;
}

function getGenerateOpsAmount(powerCreep: PowerCreep): number {
  const level = getPowerLevel(powerCreep, PWR_GENERATE_OPS);
  if (level <= 0) {
    return 0;
  }
  return POWER_INFO[PWR_GENERATE_OPS].effect[level - 1] || 0;
}

function getActivePowerEffect(
  target: RoomObject | undefined | null,
  power: PowerConstant,
): RoomObjectEffect | null {
  return target?.effects?.find(
    (effect) => effect.effect === power && effect.ticksRemaining > 0,
  ) || null;
}

function hasActivePowerEffect(target: RoomObject | undefined | null, power: PowerConstant): boolean {
  return !!getActivePowerEffect(target, power);
}

function hasStrongerActivePowerEffect(
  powerCreep: PowerCreep,
  target: RoomObject | undefined | null,
  power: PowerConstant,
): boolean {
  const powerLevel = getPowerLevel(powerCreep, power);
  return !!target?.effects?.some(
    (effect) => effect.effect === power &&
      effect.ticksRemaining > 0 &&
      effect.level > powerLevel,
  );
}

function rebuildCapabilityCache(): void {
  const next: Record<string, PowerCreepRoomCapability> = {};
  for (const powerCreep of Object.values(Game.powerCreeps || {})) {
    const homeRoom = resolvePowerCreepHomeRoomName(powerCreep);
    const operateExtensionLevel = getPowerLevel(powerCreep, PWR_OPERATE_EXTENSION);
    const regenSourceLevel = getPowerLevel(powerCreep, PWR_REGEN_SOURCE);
    if (!homeRoom || (operateExtensionLevel <= 0 && regenSourceLevel <= 0)) {
      continue;
    }

    const existing = next[homeRoom];
    if (existing) {
      existing.powerCreepNames.push(powerCreep.name);
      existing.operateExtensionLevel = Math.max(existing.operateExtensionLevel, operateExtensionLevel);
      existing.regenSourceLevel = Math.max(existing.regenSourceLevel, regenSourceLevel);
      continue;
    }

    next[homeRoom] = {
      roomName: homeRoom,
      powerCreepNames: [powerCreep.name],
      operateExtensionLevel,
      regenSourceLevel,
    };
  }

  for (const capability of Object.values(next)) {
    capability.powerCreepNames.sort();
  }
  capabilityCache = next;
  capabilityCacheTick = Game.time;
}

function ensureCapabilityCache(): Record<string, PowerCreepRoomCapability> {
  if (capabilityCacheTick !== Game.time) {
    rebuildCapabilityCache();
  }
  return capabilityCache;
}

export function listOperateExtensionRoomCapabilities(): PowerCreepRoomCapability[] {
  return Object.values(ensureCapabilityCache())
    .filter((capability) => capability.operateExtensionLevel > 0)
    .sort((left, right) => left.roomName.localeCompare(right.roomName));
}

export function getRegenSourceLevelForRoom(roomName: string): number {
  return ensureCapabilityCache()[roomName]?.regenSourceLevel || 0;
}

function isOperateExtensionControlHealthy(roomName: string, capability: PowerCreepRoomCapability): boolean {
  const room = Game.rooms[roomName];
  if (!room?.controller?.isPowerEnabled) {
    return false;
  }

  return capability.powerCreepNames.some((name) => {
    const powerCreep = Game.powerCreeps[name];
    return !!powerCreep &&
      getPowerLevel(powerCreep, PWR_OPERATE_EXTENSION) > 0 &&
      powerCreep.ticksToLive != null &&
      powerCreep.room?.name === roomName &&
      powerCreep.memory.lastControlTick !== undefined &&
      powerCreep.memory.lastControlTick >= Game.time - 1;
  });
}

export function getPowerCreepRoomEnergyPolicy(roomName: string): PowerCreepRoomEnergyPolicy {
  const capability = ensureCapabilityCache()[roomName];
  if (!capability || capability.operateExtensionLevel <= 0) {
    return {
      suppressSpawnSupply: false,
      suppressExtensionSupply: false,
      managePowerSpawnSupply: false,
    };
  }

  return {
    suppressSpawnSupply: true,
    suppressExtensionSupply: isOperateExtensionControlHealthy(roomName, capability),
    managePowerSpawnSupply: true,
  };
}

function ensureTaskQueue(powerCreep: PowerCreep): PowerCreepTask[] {
  if (!Array.isArray(powerCreep.memory.tasks)) {
    powerCreep.memory.tasks = [];
  }
  return powerCreep.memory.tasks;
}

export function listPowerCreepTasks(powerCreep: PowerCreep): PowerCreepTask[] {
  return [...ensureTaskQueue(powerCreep)].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return left.createdAt - right.createdAt;
  });
}

export function enqueuePowerCreepTask(
  powerCreep: PowerCreep,
  type: PowerCreepTaskType,
  targetId?: string,
): boolean {
  const queue = ensureTaskQueue(powerCreep);
  const id = type;
  const existing = queue.find((task) => task.id === id);
  if (existing) {
    if (targetId) {
      existing.targetId = targetId;
    }
    return false;
  }

  queue.push({
    id,
    type,
    priority: TASK_PRIORITY[type],
    createdAt: Game.time,
    targetId,
  });
  return true;
}

function removePowerCreepTask(powerCreep: PowerCreep, taskId: string): void {
  powerCreep.memory.tasks = ensureTaskQueue(powerCreep).filter((task) => task.id !== taskId);
}

function getTaskTarget(task: PowerCreepTask): RoomObject | null {
  if (!task.targetId) {
    return null;
  }
  return (Game.getObjectById(task.targetId as Id<AnyStructure>) as unknown as RoomObject | null) || null;
}

function getHomeRoom(powerCreep: PowerCreep): Room | null {
  const roomName = resolvePowerCreepHomeRoomName(powerCreep);
  return roomName ? Game.rooms[roomName] || null : null;
}

function refreshSourceRotation(powerCreep: PowerCreep, room: Room): Source[] {
  const sources = room.find(FIND_SOURCES).sort((left, right) => left.id.localeCompare(right.id));
  const sourceIds = sources.map((source) => source.id);
  const previous = powerCreep.memory.regenSourceIds || [];
  const changed = previous.length !== sourceIds.length || previous.some((id, index) => id !== sourceIds[index]);
  if (changed) {
    powerCreep.memory.regenSourceIds = sourceIds;
    powerCreep.memory.nextRegenSourceIndex = 0;
    removePowerCreepTask(powerCreep, "regen_source");
  }
  return sources;
}

function isTaskObsolete(powerCreep: PowerCreep, task: PowerCreepTask, room: Room): boolean {
  switch (task.type) {
    case "enable_room":
      return !!room.controller?.isPowerEnabled;
    case "renew":
      return powerCreep.ticksToLive == null || powerCreep.ticksToLive >= POWER_CREEP_RENEW_TTL;
    case "deposit_ops": {
      const capacity = powerCreep.store.getCapacity() || 0;
      return powerCreep.store.getUsedCapacity(RESOURCE_OPS) <= Math.floor(capacity * POWER_CREEP_OPS_RETAIN_RATIO);
    }
    case "operate_storage": {
      const target = getTaskTarget(task);
      if (!powerCreep.powers[PWR_OPERATE_STORAGE] || !target) {
        return true;
      }
      return hasActivePowerEffect(target, PWR_OPERATE_STORAGE) &&
        getPowerCooldown(powerCreep, PWR_OPERATE_STORAGE) !== 0;
    }
    case "regen_source":
      return !powerCreep.powers[PWR_REGEN_SOURCE] || !getTaskTarget(task);
    case "operate_extension": {
      if (!powerCreep.powers[PWR_OPERATE_EXTENSION] || getPowerCooldown(powerCreep, PWR_OPERATE_EXTENSION)! > 0) {
        return true;
      }
      return !room.find(FIND_MY_STRUCTURES).some(
        (structure) => structure.structureType === STRUCTURE_EXTENSION &&
          (structure as StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      );
    }
    case "generate_ops":
      return !powerCreep.powers[PWR_GENERATE_OPS] || getPowerCooldown(powerCreep, PWR_GENERATE_OPS)! > 0;
    default:
      return false;
  }
}

function pruneObsoleteTasks(powerCreep: PowerCreep, room: Room): void {
  powerCreep.memory.tasks = ensureTaskQueue(powerCreep).filter(
    (task) => !isTaskObsolete(powerCreep, task, room),
  );
}

function scheduleLifecycleTasks(powerCreep: PowerCreep, room: Room, powerSpawn: StructurePowerSpawn | null): void {
  if (room.controller && !room.controller.isPowerEnabled) {
    enqueuePowerCreepTask(powerCreep, "enable_room", room.controller.id);
  }
  if (powerSpawn && powerCreep.ticksToLive != null && powerCreep.ticksToLive < POWER_CREEP_RENEW_TTL) {
    enqueuePowerCreepTask(powerCreep, "renew", powerSpawn.id);
  }
}

function scheduleOpsTasks(powerCreep: PowerCreep, room: Room): void {
  if (isPowerReady(powerCreep, PWR_GENERATE_OPS)) {
    enqueuePowerCreepTask(powerCreep, "generate_ops");
  }

  const capacity = powerCreep.store.getCapacity() || 0;
  const used = powerCreep.store.getUsedCapacity(RESOURCE_OPS);
  const free = powerCreep.store.getFreeCapacity();
  const nextGenerateAmount = getGenerateOpsAmount(powerCreep);
  const shouldDeposit = capacity > 0 && used > Math.floor(capacity * POWER_CREEP_OPS_RETAIN_RATIO) &&
    (used >= Math.ceil(capacity * POWER_CREEP_OPS_HIGH_WATER_RATIO) || free < nextGenerateAmount);
  if (shouldDeposit && room.storage) {
    enqueuePowerCreepTask(powerCreep, "deposit_ops", room.storage.id);
  }
}

function scheduleOperateStorage(powerCreep: PowerCreep, room: Room): void {
  if (!room.storage || getPowerLevel(powerCreep, PWR_OPERATE_STORAGE) <= 0) {
    return;
  }
  const hasEffect = hasActivePowerEffect(room.storage, PWR_OPERATE_STORAGE);
  if (!hasEffect || getPowerCooldown(powerCreep, PWR_OPERATE_STORAGE) === 0) {
    enqueuePowerCreepTask(powerCreep, "operate_storage", room.storage.id);
  }
}

function scheduleRegenSource(powerCreep: PowerCreep, room: Room): void {
  if (!isPowerReady(powerCreep, PWR_REGEN_SOURCE)) {
    return;
  }

  const sources = refreshSourceRotation(powerCreep, room);
  if (sources.length < 2) {
    return;
  }
  const index = (powerCreep.memory.nextRegenSourceIndex || 0) % sources.length;
  const source = sources[index];
  enqueuePowerCreepTask(powerCreep, "regen_source", source.id);
}

function getOperateExtensionTarget(room: Room): StructureStorage | StructureTerminal | StructureContainer | null {
  if (room.storage && room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    return room.storage;
  }
  if (room.terminal && room.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    return room.terminal;
  }
  return room.find(FIND_STRUCTURES).find(
    (structure): structure is StructureContainer => structure.structureType === STRUCTURE_CONTAINER &&
      structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  ) || null;
}

function scheduleOperateExtension(powerCreep: PowerCreep, room: Room): void {
  if (!isPowerReady(powerCreep, PWR_OPERATE_EXTENSION)) {
    return;
  }

  const needsEnergy = room.find(FIND_MY_STRUCTURES).some(
    (structure) => structure.structureType === STRUCTURE_EXTENSION &&
      (structure as StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  );
  if (!needsEnergy) {
    return;
  }
  const target = getOperateExtensionTarget(room);
  if (target) {
    enqueuePowerCreepTask(powerCreep, "operate_extension", target.id);
  }
}

function isTaskRunnable(powerCreep: PowerCreep, task: PowerCreepTask): boolean {
  if (task.type === "renew" || task.type === "enable_room") {
    return !!getTaskTarget(task);
  }
  if (task.type === "deposit_ops") {
    const target = getTaskTarget(task) as StructureStorage | null;
    return !!target && target.store.getFreeCapacity(RESOURCE_OPS) > 0 &&
      powerCreep.store.getUsedCapacity(RESOURCE_OPS) > 0;
  }

  const power = POWER_TASKS[task.type];
  if (!power || !isPowerReady(powerCreep, power)) {
    return false;
  }
  if (power === PWR_GENERATE_OPS) {
    return powerCreep.store.getFreeCapacity() >= getGenerateOpsAmount(powerCreep);
  }
  const target = getTaskTarget(task);
  if (!target || hasStrongerActivePowerEffect(powerCreep, target, power)) {
    return false;
  }
  return powerCreep.store.getUsedCapacity(RESOURCE_OPS) >= getPowerOpsCost(powerCreep, power);
}

function selectRunnableTask(powerCreep: PowerCreep): PowerCreepTask | null {
  return listPowerCreepTasks(powerCreep).find(
    (task) => isTaskRunnable(powerCreep, task),
  ) || null;
}

function getTaskRange(task: PowerCreepTask): 1 | 2 | 3 {
  const power = POWER_TASKS[task.type];
  const range = power === undefined
    ? 1
    : (POWER_INFO[power] as { range?: number } | undefined)?.range;
  return range === 2 || range === 3 ? range : 1;
}

function movePowerCreepToTarget(
  powerCreep: PowerCreep,
  target: RoomObject,
  range: 1 | 2 | 3,
): void {
  if (powerCreep.room?.name !== target.pos.roomName) {
    powerCreep.moveTo(target, { reusePath: 5, range });
    return;
  }
  moveToTarget(powerCreep, target, range, { reusePath: 5, ignoreCreeps: true });
}

function moveToTaskTarget(powerCreep: PowerCreep, task: PowerCreepTask, target: RoomObject | null): void {
  if (!target) {
    return;
  }
  movePowerCreepToTarget(powerCreep, target, getTaskRange(task));
}

function prepositionForTask(powerCreep: PowerCreep, task: PowerCreepTask): void {
  const target = getTaskTarget(task);
  if (!target) {
    return;
  }
  const range = getTaskRange(task);
  if (powerCreep.pos.getRangeTo(target.pos) > range) {
    movePowerCreepToTarget(powerCreep, target, range);
  } else {
    delete ensureCreepMovementState(powerCreep).movePathState;
  }
}

function syncPowerTaskWorkAnchor(powerCreep: PowerCreep, task: PowerCreepTask | undefined): void {
  const movementState = ensureCreepMovementState(powerCreep);
  const target = task ? getTaskTarget(task) : null;
  if (!target) {
    delete movementState.workAnchor;
    return;
  }
  const range = getTaskRange(task);
  movementState.workAnchor = {
    x: target.pos.x,
    y: target.pos.y,
    roomName: target.pos.roomName,
    range,
  };
}

function finishSuccessfulTask(powerCreep: PowerCreep, task: PowerCreepTask): void {
  if (task.type === "regen_source") {
    const sourceCount = powerCreep.memory.regenSourceIds?.length || 0;
    if (sourceCount > 0) {
      powerCreep.memory.nextRegenSourceIndex = ((powerCreep.memory.nextRegenSourceIndex || 0) + 1) % sourceCount;
    }
  }
  const movementState = ensureCreepMovementState(powerCreep);
  delete movementState.movePathState;
  if (task.type === "operate_storage" || task.type === "regen_source") {
    delete movementState.workAnchor;
  }
  removePowerCreepTask(powerCreep, task.id);
}

function handleTaskResult(
  powerCreep: PowerCreep,
  task: PowerCreepTask,
  target: RoomObject | null,
  result: ScreepsReturnCode,
): void {
  if (result === OK) {
    finishSuccessfulTask(powerCreep, task);
    return;
  }
  if (result === ERR_NOT_IN_RANGE) {
    moveToTaskTarget(powerCreep, task, target);
    return;
  }
  if (result === ERR_INVALID_TARGET || result === ERR_NOT_FOUND) {
    removePowerCreepTask(powerCreep, task.id);
  }
}

function executeTask(powerCreep: PowerCreep, task: PowerCreepTask): void {
  const target = getTaskTarget(task);
  if (target && powerCreep.pos.getRangeTo(target.pos) <= getTaskRange(task)) {
    delete ensureCreepMovementState(powerCreep).movePathState;
  }
  let result: ScreepsReturnCode;

  switch (task.type) {
    case "enable_room":
      result = powerCreep.enableRoom(target as StructureController);
      break;
    case "renew":
      result = powerCreep.renew(target as StructurePowerSpawn);
      break;
    case "deposit_ops": {
      const capacity = powerCreep.store.getCapacity() || 0;
      const desiredAmount = powerCreep.store.getUsedCapacity(RESOURCE_OPS) -
        Math.floor(capacity * POWER_CREEP_OPS_RETAIN_RATIO);
      const availableCapacity = (target as StructureStorage | null)?.store.getFreeCapacity(RESOURCE_OPS) || 0;
      const amount = Math.min(desiredAmount, availableCapacity);
      if (amount <= 0) {
        return;
      }
      result = powerCreep.transfer(target as StructureStorage, RESOURCE_OPS, amount);
      break;
    }
    case "generate_ops":
      result = powerCreep.usePower(PWR_GENERATE_OPS);
      break;
    case "operate_storage":
      result = powerCreep.usePower(PWR_OPERATE_STORAGE, target || undefined);
      break;
    case "regen_source":
      result = powerCreep.usePower(PWR_REGEN_SOURCE, target || undefined);
      break;
    case "operate_extension":
      result = executeTreasuryFencedTerminalCargo(target, () => powerCreep.usePower(PWR_OPERATE_EXTENSION, target || undefined));
      break;
    default:
      return;
  }

  handleTaskResult(powerCreep, task, target, result);
}

function trySpawnPowerCreep(powerCreep: PowerCreep, room: Room): void {
  const currentShardName = Game.shard?.name;
  if (powerCreep.shard && currentShardName && powerCreep.shard !== currentShardName) {
    return;
  }
  if (powerCreep.spawnCooldownTime !== undefined && powerCreep.spawnCooldownTime > Date.now()) {
    return;
  }
  const powerSpawn = getOwnedPowerSpawn(room);
  if (powerSpawn) {
    powerCreep.spawn(powerSpawn);
  }
}

function runPowerCreep(powerCreep: PowerCreep): void {
  // spawn 让位指令优先：powerCreep 的任务逻辑（movePowerCreepToTarget）
  // 会覆盖 spawn 侧的直接 move，本 tick 让出出生位一步并跳过任务行为。
  // 指令带 tick，过期即忽略并清除。
  const spawnYield = powerCreep.memory._spawnYield;
  if (spawnYield) {
    delete powerCreep.memory._spawnYield;
    if (Game.time - spawnYield.tick >= 0 && Game.time - spawnYield.tick <= 2) {
      powerCreep.move(spawnYield.dir);
      return;
    }
  }
  const homeRoomName = resolvePowerCreepHomeRoomName(powerCreep);
  if (!homeRoomName) {
    return;
  }
  const room = Game.rooms[homeRoomName];
  if (!room) {
    return;
  }

  // Live Screeps may expose null or NaN for an unspawned Power Creep even
  // though the community type currently models only undefined. This check
  // must stay ahead of room/pos guards because unspawned PCs expose neither.
  const ticksToLive = powerCreep.ticksToLive;
  if (ticksToLive == null || !Number.isFinite(ticksToLive)) {
    trySpawnPowerCreep(powerCreep, room);
    return;
  }

  // Power Creep 在跨 shard 或出生/消失的边界 tick 里，可能仍报告寿命，
  // 但尚未暴露当前 shard 的 room/pos。此时不能执行本地任务，否则任何
  // 距离判断都会中断整个主循环。
  if (!powerCreep.room || !powerCreep.pos) {
    return;
  }

  powerCreep.memory.lastControlTick = Game.time;
  const powerSpawn = getOwnedPowerSpawn(room);
  pruneObsoleteTasks(powerCreep, room);
  scheduleLifecycleTasks(powerCreep, room, powerSpawn);
  scheduleOpsTasks(powerCreep, room);
  scheduleOperateStorage(powerCreep, room);
  scheduleRegenSource(powerCreep, room);
  scheduleOperateExtension(powerCreep, room);

  const storageMaintenance = listPowerCreepTasks(powerCreep).find(
    (candidate) => candidate.type === "operate_storage",
  );
  const regenSourceMaintenance = storageMaintenance
    ? undefined
    : listPowerCreepTasks(powerCreep).find(
      (candidate) => candidate.type === "regen_source" && !isTaskRunnable(powerCreep, candidate),
    );
  const task = selectRunnableTask(powerCreep);
  const prepositionTask = storageMaintenance && (!task || task.type === "generate_ops")
    ? storageMaintenance
    : regenSourceMaintenance && (!task || task.type === "generate_ops")
      ? regenSourceMaintenance
      : undefined;
  const activeMaintenanceTask = task?.type === "operate_storage" || task?.type === "regen_source"
    ? task
    : undefined;
  syncPowerTaskWorkAnchor(powerCreep, activeMaintenanceTask || prepositionTask);
  if (prepositionTask) {
    prepositionForTask(powerCreep, prepositionTask);
  }
  if (!storageMaintenance && !prepositionTask && !task) {
    delete ensureCreepMovementState(powerCreep).movePathState;
  }
  if (task) {
    executeTask(powerCreep, task);
  }
}

export function runPowerCreepControl(): void {
  capabilityCacheTick = -1;
  for (const powerCreep of Object.values(Game.powerCreeps || {})) {
    runPowerCreep(powerCreep);
  }
  capabilityCacheTick = -1;
  ensureCapabilityCache();
}

export function resetPowerCreepControlCacheForTest(): void {
  capabilityCacheTick = -1;
  capabilityCache = {};
}
