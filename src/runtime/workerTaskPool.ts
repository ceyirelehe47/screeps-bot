import type { WorkerTask } from "@/types/system";
import {
  getPlannedControllerLinkPos,
  getPlannedStoragePos,
  getSourceContainerPositionsForRoom,
} from "@/runtime/roomPlannerConstruction";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { measureCreepDecision } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { isInsideSafeZone } from "@/runtime/safeZoneHelpers";
import {
  promoteLegacyWorkerDispatchBinding,
  readWorkerDispatchBinding,
} from "@/runtime/dispatchOwnership/actorBinding";
import {
  createWorkerDispatchRef,
  equalDispatchRefs,
  type WorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";
import { workerSlotClaimPort } from "@/runtime/dispatchOwnership/workerSlot";

const TASK_REFRESH_INTERVAL = 3;
const unreachableTasks = new Map<string, { roomName: string; retryAt: Map<string, number> }>();

/** 无路是单个 worker 的短期事实，不阻止其它 worker 接手。 */
export function deferUnreachableWorkerTask(creep: Creep, task: WorkerTask): void {
  let entry = unreachableTasks.get(creep.name);
  if (!entry || entry.roomName !== task.roomName) {
    entry = { roomName: task.roomName, retryAt: new Map() };
  }
  if (entry.retryAt.size >= 16) entry.retryAt.delete(entry.retryAt.keys().next().value!);
  entry.retryAt.set(task.id, Game.time + 50);
  if (unreachableTasks.size >= 128) unreachableTasks.delete(unreachableTasks.keys().next().value!);
  unreachableTasks.set(creep.name, entry);
  releaseWorkerTask(creep);
}
const RAMPART_EMERGENCY_TARGET_HITS = 6000;
const RAMPART_NORMAL_REPAIR_PRIORITY = 320;
type PlannedLayout = { [structureType: string]: { x: number; y: number }[] };
type StructureWithOptionalOwner = Structure<StructureConstant> & {
  my?: boolean;
  owner?: { username: string };
};

type WorkerTaskBoardStore = Record<string, Record<string, WorkerTask>>;

export type WorkerTaskSnapshot = Readonly<Omit<WorkerTask, "assignedCreeps">> & {
  readonly assignedCreeps: readonly string[];
};

export type WorkerTaskRoomSnapshot = Readonly<Record<string, WorkerTaskSnapshot>>;
export type WorkerTaskBoardSnapshot = Readonly<Record<string, WorkerTaskRoomSnapshot>>;

type RuntimeGlobalWithWorkerTasks = typeof global & {
  __workerTaskBoard?: WorkerTaskBoardStore;
};

const runtimeGlobal: RuntimeGlobalWithWorkerTasks = global;
const EMPTY_WORKER_TASK_STORE = Object.freeze({}) as Record<string, WorkerTask>;

function ownDataValue<T>(target: object | undefined, key: string): T | undefined {
  if (!target) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && "value" in descriptor
      ? descriptor.value as T
      : undefined;
  } catch {
    return undefined;
  }
}

function ensureWorkerTaskBoard(): WorkerTaskBoardStore {
  if (!runtimeGlobal.__workerTaskBoard) {
    runtimeGlobal.__workerTaskBoard = {};
  }

  return runtimeGlobal.__workerTaskBoard;
}

function ensureRoomTaskStore(roomName: string): Record<string, WorkerTask> {
  const board = ensureWorkerTaskBoard();
  const existing = board[roomName];
  if (existing) {
    return existing;
  }

  board[roomName] = {};
  return board[roomName];
}

export function getWorkerTasksByRoom(roomName: string): Record<string, WorkerTask> {
  return ensureRoomTaskStore(roomName);
}

function defineSnapshotProperty(
  target: object,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneWorkerSnapshotValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) {
    return existing;
  }

  let snapshot: object;
  if (Array.isArray(value)) {
    snapshot = new Array(value.length);
  } else if (typeof value === "function") {
    snapshot = function workerSnapshotFunction(): undefined {
      return undefined;
    };
  } else {
    const prototype = Object.getPrototypeOf(source);
    if (prototype === null) {
      snapshot = Object.create(null) as object;
    } else if (prototype === Object.prototype) {
      snapshot = {};
    } else {
      snapshot = Object.create(Object.freeze({})) as object;
    }
  }
  seen.set(source, snapshot);

  for (const key of Object.keys(source)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      defineSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    if (!descriptor || !("value" in descriptor)) {
      defineSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    let clonedValue: unknown;
    try {
      clonedValue = cloneWorkerSnapshotValue(descriptor.value, seen);
    } catch {
      clonedValue = undefined;
    }
    defineSnapshotProperty(snapshot, key, clonedValue);
  }

  return snapshot;
}

function cloneWorkerTaskRoomForSnapshot(
  tasks: Readonly<Record<string, WorkerTask>>,
): WorkerTaskRoomSnapshot {
  return cloneWorkerSnapshotValue(tasks) as WorkerTaskRoomSnapshot;
}

/** Returns an isolated full-board snapshot without creating the private heap store. */
export function peekWorkerTaskBoard(): WorkerTaskBoardSnapshot {
  const board = runtimeGlobal.__workerTaskBoard;
  if (!board) {
    return {};
  }

  return cloneWorkerSnapshotValue(board) as WorkerTaskBoardSnapshot;
}

/** Returns one isolated room snapshot without creating the board or an empty room store. */
export function peekWorkerTaskRoomSnapshot(roomName: string): WorkerTaskRoomSnapshot {
  const tasks = runtimeGlobal.__workerTaskBoard?.[roomName];
  return tasks ? cloneWorkerTaskRoomForSnapshot(tasks) : {};
}

export function peekWorkerTasksByRoom(roomName: string): Readonly<Record<string, WorkerTask>> {
  return runtimeGlobal.__workerTaskBoard?.[roomName] ?? EMPTY_WORKER_TASK_STORE;
}

function getAssignedWorkerRoomName(creep: Creep): string {
  const configName = creep.memory.configName;
  if (!configName) {
    return creep.room.name;
  }

   const config = getCreepConfigService().get(configName);
   if (config?.role === "colonizerWorker" || config?.role === "crossShardColonizerWorker") {
     return creep.room.name;
   }

   return config?.roomName || creep.room.name;
}

function createTaskRef(task: WorkerTask): WorkerDispatchRef | undefined {
  return createWorkerDispatchRef(task.roomName, task.id);
}

function peekWorkerTaskByRef(ref: WorkerDispatchRef): WorkerTask | undefined {
  const roomTasks = ownDataValue<Record<string, WorkerTask>>(
    runtimeGlobal.__workerTaskBoard,
    ref.scope.roomName,
  );
  const task = ownDataValue<WorkerTask>(roomTasks, ref.localId);
  return task && task.id === ref.localId && task.roomName === ref.scope.roomName
    ? task
    : undefined;
}

function promoteLegacyWorkerBinding(
  creepName: string,
  assignedRoomName: string,
): WorkerDispatchRef | undefined {
  return promoteLegacyWorkerDispatchBinding(
    creepName,
    assignedRoomName,
    (roomName, localId) => {
      const roomTasks = ownDataValue<Record<string, WorkerTask>>(
        runtimeGlobal.__workerTaskBoard,
        roomName,
      );
      const task = ownDataValue<WorkerTask>(roomTasks, localId);
      if (!task || task.id !== localId || task.roomName !== roomName) return [];
      const ref = createTaskRef(task);
      return ref ? [ref] : [];
    },
  );
}

function getBuildPriority(structureType: BuildableStructureConstant | StructureConstant): number {
  if (structureType === STRUCTURE_SPAWN) {
    return 900;
  }
  if (structureType === STRUCTURE_EXTENSION) {
    return 850;
  }
  if (structureType === STRUCTURE_TOWER) {
    return 800;
  }
  return 500;
}

function clampAssignees(task: WorkerTask): void {
  const ref = createTaskRef(task);
  if (!ref) return;

  if (Array.isArray(task.assignedCreeps)) {
    for (const creepName of task.assignedCreeps) {
      const creep = ownDataValue<Creep>(Game.creeps, creepName);
      if (
        !creep
        || getAssignedWorkerRoomName(creep) !== task.roomName
        || readWorkerDispatchBinding(creepName)
      ) {
        continue;
      }
      promoteLegacyWorkerBinding(creepName, task.roomName);
    }
  }

  workerSlotClaimPort.clamp(ref, task);
}

function upsertTask(roomName: string, task: WorkerTask): void {
  const tasks = ensureRoomTaskStore(roomName);
  const current = tasks[task.id];

  if (!current) {
    tasks[task.id] = task;
    return;
  }

  current.type = task.type;
  current.targetId = task.targetId;
  current.priority = task.priority;
  current.requiredWork = task.requiredWork;
  current.repairTargetHits = task.repairTargetHits;
  current.repairMode = task.repairMode;
  current.maxAssignees = task.maxAssignees;
  current.status = task.status;
  current.updatedAt = task.updatedAt;
  clampAssignees(current);
}

function createBuildTask(site: ConstructionSite): WorkerTask {
  const remaining = Math.max(0, site.progressTotal - site.progress);
  const maxAssignees = Math.max(1, Math.min(3, Math.ceil(remaining / 2000)));

  return {
    id: `build:${site.id}`,
    type: "build",
    targetId: site.id,
    roomName: site.pos.roomName,
    priority: getBuildPriority(site.structureType),
    requiredWork: remaining,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

function createUpgradeTask(room: Room): WorkerTask | null {
  const controller = room.controller;
  if (!controller || !controller.my || controller.level >= 8) {
    return null;
  }

  const support = Memory.cfg?.colonizationSupport?.[room.name];
  const includeColonizationSupport = support?.enabled === true && controller.level < 6 &&
    Memory.runtime?.colonizationSupport?.[room.name]?.status !== "complete";
  const liveWorkers = getTickContextService().getCreepsByRoom(room.name).filter((creep) => {
    const configName = creep.memory.configName;
    if (typeof configName !== "string") return false;
    if (configName.startsWith(`${room.name}:worker:`)) return true;
    return includeColonizationSupport && creep.memory.role === "colonizerWorker" &&
      configName.startsWith(`${support!.sourceRoom}:colonize:${room.name}:worker:`);
  }).length;
  const maxAssignees = Math.max(1, liveWorkers);

  return {
    id: `upgrade:${controller.id}`,
    type: "upgrade",
    targetId: controller.id,
    roomName: room.name,
    priority: 300,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

function createRampartRepairTask(rampart: StructureRampart, previousTarget?: number): WorkerTask {
  const targetHits = Math.min(rampart.hitsMax, previousTarget ?? rampart.hits + 50_000);
  const remaining = Math.max(0, targetHits - rampart.hits);
  const priority = RAMPART_NORMAL_REPAIR_PRIORITY;
  const repairMode: "normal" = "normal";
  const maxAssignees = 1;

  return {
    id: `repair:${rampart.id}`,
    type: "repair",
    targetId: rampart.id,
    roomName: rampart.room.name,
    priority,
    requiredWork: remaining,
    repairTargetHits: targetHits,
    repairMode,
    assignedCreeps: [],
    maxAssignees,
    status: "active",
    updatedAt: Game.time,
  };
}

function getPlannedPositionKey(structureType: string, x: number, y: number): string {
  return `${structureType}:${x}:${y}`;
}

function getPlannedStructurePositionKeys(layout: PlannedLayout): Set<string> {
  const planned = new Set<string>();
  for (const [structureType, positions] of Object.entries(layout)) {
    for (const pos of positions) {
      planned.add(getPlannedPositionKey(structureType, pos.x, pos.y));
    }
  }

  return planned;
}

function ensureIllegalStructureCleanupMemory(): { rooms: Record<string, { completedAt: number; layoutSavedAt: number }> } {
  Memory.runtime = Memory.runtime || {};
  if (!Memory.runtime.illegalStructureCleanup) {
    Memory.runtime.illegalStructureCleanup = { rooms: {} };
  }

  return Memory.runtime.illegalStructureCleanup;
}

function isIllegalStructureCleanupComplete(roomName: string, layoutSavedAt: number): boolean {
  return Memory.runtime?.illegalStructureCleanup?.rooms?.[roomName]?.layoutSavedAt === layoutSavedAt;
}

function markIllegalStructureCleanupComplete(roomName: string, layoutSavedAt: number): void {
  ensureIllegalStructureCleanupMemory().rooms[roomName] = {
    completedAt: Game.time,
    layoutSavedAt,
  };
}

function getProtectedContainerPositionKeys(room: Room): Set<string> {
  const protectedKeys = new Set<string>();

  for (const pos of getSourceContainerPositionsForRoom(room.name)) {
    protectedKeys.add(getPlannedPositionKey(STRUCTURE_CONTAINER, pos.x, pos.y));
  }

  const storagePos = getPlannedStoragePos(room);
  if (storagePos) {
    protectedKeys.add(getPlannedPositionKey(STRUCTURE_CONTAINER, storagePos.x, storagePos.y));
  }

  const controllerLinkPos = getPlannedControllerLinkPos(room);
  if (controllerLinkPos) {
    protectedKeys.add(getPlannedPositionKey(STRUCTURE_CONTAINER, controllerLinkPos.x, controllerLinkPos.y));
  }

  return protectedKeys;
}

function isIllegalStructureCandidate(
  structure: StructureWithOptionalOwner,
  plannedPositions: Set<string>,
  protectedContainerPositions: Set<string>,
): boolean {
  if (structure.my === true || structure.owner !== undefined) {
    return false;
  }

  if (structure.structureType === STRUCTURE_CONTROLLER) {
    return false;
  }

  if (
    structure.structureType === STRUCTURE_CONTAINER &&
    protectedContainerPositions.has(getPlannedPositionKey(STRUCTURE_CONTAINER, structure.pos.x, structure.pos.y))
  ) {
    return false;
  }

  return !plannedPositions.has(getPlannedPositionKey(structure.structureType, structure.pos.x, structure.pos.y));
}

function destroyIllegalStructures(room: Room): void {
  const roomContext = getTickContextService().getRoomContext(room);
  const layoutData = Memory.data?.roomPlanner?.[room.name];
  if (!roomContext || !layoutData || roomContext.getTowers().length === 0) {
    return;
  }

  if (isIllegalStructureCleanupComplete(room.name, layoutData.savedAt)) {
    return;
  }

  const plannedPositions = getPlannedStructurePositionKeys(layoutData.layout);
  const protectedContainerPositions = getProtectedContainerPositionKeys(room);
  const candidates = roomContext
    .getStructures()
    .filter((structure) => isIllegalStructureCandidate(structure, plannedPositions, protectedContainerPositions));

  if (candidates.length === 0) {
    markIllegalStructureCleanupComplete(room.name, layoutData.savedAt);
    return;
  }

  let allDestroyed = true;
  for (const structure of candidates) {
    const destroyCode = structure.destroy();
    if (destroyCode !== OK && destroyCode !== ERR_INVALID_TARGET) {
      allDestroyed = false;
    }
  }

  if (allDestroyed) {
    markIllegalStructureCleanupComplete(room.name, layoutData.savedAt);
  }
}

function cleanupStaleTasks(roomName: string): void {
  const tasks = ensureRoomTaskStore(roomName);
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.updatedAt !== Game.time) {
      clampAssignees(task);
      const ref = createTaskRef(task);
      if (ref) workerSlotClaimPort.releaseTask(ref, task);
      delete tasks[taskId];
      continue;
    }

    clampAssignees(task);
  }
}

export function refreshWorkerTasks(): void {
  if (Game.time % TASK_REFRESH_INTERVAL !== 0) {
    return;
  }

  const rooms = getTickContextService().getMyRooms();
  for (const room of rooms) {
    const roomContext = getTickContextService().getRoomContext(room);
    const tasks = ensureRoomTaskStore(room.name);
    const activeAssignedNormalRepairTask = Object.values(tasks).find(
      (task) =>
        task.type === "repair" &&
        task.repairMode === "normal" &&
        task.status === "active" &&
        (Game.getObjectById(task.targetId as Id<StructureRampart>)?.hits ?? Infinity) < (task.repairTargetHits ?? 0) &&
        task.assignedCreeps.some((name) => !!ownDataValue<Creep>(Game.creeps, name)),
    );
    for (const task of Object.values(tasks)) {
      task.updatedAt = -1;
    }

    const sites = roomContext?.getConstructionSites() || [];
    for (const site of sites) {
      upsertTask(room.name, createBuildTask(site));
    }

    const weakRamparts = (roomContext?.getRamparts() || []).filter((rampart) => rampart.hits < rampart.hitsMax);
    const normalRepairCandidates: StructureRampart[] = [];

    for (const rampart of weakRamparts) {
      if (rampart.hits < RAMPART_EMERGENCY_TARGET_HITS) {
        continue;
      }

      normalRepairCandidates.push(rampart);
    }

    if (normalRepairCandidates.length > 0) {
      let selectedNormalRampart = activeAssignedNormalRepairTask
        ? normalRepairCandidates.find((rampart) => rampart.id === activeAssignedNormalRepairTask.targetId) || null
        : null;

      if (!selectedNormalRampart) {
        selectedNormalRampart = normalRepairCandidates.reduce((minRampart, rampart) =>
          rampart.hits < minRampart.hits ? rampart : minRampart,
        );
      }

      const previousTarget = activeAssignedNormalRepairTask?.targetId === selectedNormalRampart.id &&
        activeAssignedNormalRepairTask.repairTargetHits !== undefined &&
        selectedNormalRampart.hits < activeAssignedNormalRepairTask.repairTargetHits
        ? activeAssignedNormalRepairTask.repairTargetHits : undefined;
      upsertTask(room.name, createRampartRepairTask(selectedNormalRampart, previousTarget));
    }
    destroyIllegalStructures(room);

    const upgradeTask = createUpgradeTask(room);
    if (upgradeTask) {
      upsertTask(room.name, upgradeTask);
    }

    cleanupStaleTasks(room.name);
  }
}

function getTaskTarget(task: WorkerTask): RoomObject | null {
  if (task.type === "build") {
    return Game.getObjectById(task.targetId as Id<ConstructionSite>);
  }

  if (task.type === "upgrade") {
    const controller = Game.getObjectById(task.targetId as Id<StructureController>);
    return controller && controller.level < 8 ? controller : null;
  }

  if (task.type === "repair") {
    return Game.getObjectById(task.targetId as Id<StructureRampart>);
  }

  if (task.type === "dismantle") {
    return Game.getObjectById(task.targetId as Id<Structure<StructureConstant>>);
  }

  return null;
}

function scoreTask(creep: Creep, task: WorkerTask): number {
  const target = getTaskTarget(task);
  if (!target) {
    return Number.NEGATIVE_INFINITY;
  }

  const distance = creep.pos.getRangeTo(target.pos);
  const assignedPenalty = task.assignedCreeps.length * 120;

  return task.priority * 1000 - distance * 15 - assignedPenalty;
}

export function isWorkerTaskSafeForCreep(creep: Creep, task: WorkerTask): boolean {
  const assignedRoomName = getAssignedWorkerRoomName(creep);
  if (!isDefenseMode(assignedRoomName)) {
    return true;
  }

  const safeZone = getSafeZone(assignedRoomName);
  if (safeZone.size === 0) {
    return true;
  }

  const target = getTaskTarget(task);
  if (!target) {
    return false;
  }

  return target.pos.roomName === assignedRoomName && isInsideSafeZone(target.pos, safeZone);
}

export function releaseWorkerTask(creep: Creep): void {
  const assignedRoomName = getAssignedWorkerRoomName(creep);
  const ref = readWorkerDispatchBinding(creep.name)
    ?? promoteLegacyWorkerBinding(creep.name, assignedRoomName);
  if (!ref) return;
  workerSlotClaimPort.release(creep.name, ref, peekWorkerTaskByRef(ref));
}

export function assignWorkerTask(creep: Creep): WorkerTask | null {
  return measureCreepDecision(() => {
    const assignedRoomName = getAssignedWorkerRoomName(creep);
    const entry = unreachableTasks.get(creep.name);
    const retryAt = entry?.roomName === assignedRoomName ? entry.retryAt : undefined;
    if (retryAt) {
      for (const [id, expiry] of retryAt) {
        if (expiry <= Game.time || expiry > Game.time + 50) retryAt.delete(id);
      }
    }
    if (!retryAt?.size) unreachableTasks.delete(creep.name);
    const roomTasks = peekWorkerTasksByRoom(assignedRoomName);
    if (Object.keys(roomTasks).length === 0) {
      releaseWorkerTask(creep);
      return null;
    }

    const inDefenseMode = isDefenseMode(assignedRoomName);
    const safeZone = inDefenseMode ? getSafeZone(assignedRoomName) : null;

    let currentRef = readWorkerDispatchBinding(creep.name)
      ?? promoteLegacyWorkerBinding(creep.name, assignedRoomName);
    if (currentRef) {
      if (currentRef.scope.roomName !== assignedRoomName) {
        workerSlotClaimPort.release(
          creep.name,
          currentRef,
          peekWorkerTaskByRef(currentRef),
        );
        currentRef = undefined;
      }
    }

    if (currentRef) {
      const current = ownDataValue<WorkerTask>(roomTasks, currentRef.localId);
      if (current && current.status === "active" && !retryAt?.has(current.id)) {
        const currentTarget = getTaskTarget(current);
        if (inDefenseMode && safeZone && safeZone.size > 0 && currentTarget && !isInsideSafeZone(currentTarget.pos, safeZone)) {
          releaseWorkerTask(creep);
        } else {
          clampAssignees(current);
          const currentTaskRef = createTaskRef(current);
          if (
            currentTarget
            && currentTaskRef
            && equalDispatchRefs(currentRef, currentTaskRef)
            && workerSlotClaimPort.reconcile(creep.name, currentRef, current)
          ) {
            return current;
          }
        }
      }

      releaseWorkerTask(creep);
    }

    const candidates = Object.values(roomTasks).filter((task) => {
      if (task.status !== "active" || retryAt?.has(task.id)) {
        return false;
      }

      clampAssignees(task);
      if (task.assignedCreeps.length >= task.maxAssignees) {
        return false;
      }

      const target = getTaskTarget(task);
      if (!target) {
        return false;
      }

      if (inDefenseMode && safeZone && safeZone.size > 0 && !isInsideSafeZone(target.pos, safeZone)) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    let best: WorkerTask | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const task of candidates) {
      const score = scoreTask(creep, task);
      if (score > bestScore) {
        bestScore = score;
        best = task;
      }
    }

    if (!best) {
      return null;
    }

    const bestRef = createTaskRef(best);
    return bestRef && workerSlotClaimPort.acquire(creep.name, bestRef, best)
      ? best
      : null;
  });
}

export function getWorkerTaskTarget(task: WorkerTask): RoomObject | null {
  return getTaskTarget(task);
}

export function completeWorkerTaskIfDone(task: WorkerTask): boolean {
  if (task.type === "build") {
    const site = Game.getObjectById(task.targetId as Id<ConstructionSite>);
    return !site;
  }

  if (task.type === "upgrade") {
    const controller = Game.getObjectById(task.targetId as Id<StructureController>);
    return !controller || !controller.my || controller.level >= 8;
  }

  if (task.type === "repair") {
    const rampart = Game.getObjectById(task.targetId as Id<StructureRampart>);
    if (!rampart) {
      return true;
    }

    const targetHits = task.repairTargetHits ?? RAMPART_EMERGENCY_TARGET_HITS;
    return rampart.hits >= targetHits;
  }

  if (task.type === "dismantle") {
    return !Game.getObjectById(task.targetId as Id<Structure<StructureConstant>>);
  }

  return false;
}

export function cleanupWorkerTaskBoard(ownedRooms: Set<string>): number {
  const board = ensureWorkerTaskBoard();
  let removed = 0;

  for (const roomName of Object.keys(board)) {
    if (ownedRooms.has(roomName)) {
      continue;
    }

    for (const task of Object.values(board[roomName])) {
      clampAssignees(task);
      const ref = createTaskRef(task);
      if (ref) workerSlotClaimPort.releaseTask(ref, task);
    }
    delete board[roomName];
    removed += 1;
  }

  return removed;
}

export function clearWorkerTaskBoardForTest(): void {
  delete runtimeGlobal.__workerTaskBoard;
  unreachableTasks.clear();
}

export function getAssignedWorkerTaskId(creepName: string): string | undefined {
  const taskId = ownDataValue<unknown>(getCreepAssignmentState(creepName), "taskId");
  return typeof taskId === "string" ? taskId : undefined;
}
