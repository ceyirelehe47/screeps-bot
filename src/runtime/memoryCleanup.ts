import { pruneDeadCreepMovementState } from "@/movement/creepState";
import { pruneDeadCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getOwnedRoomWorkforceConfigIdentity } from "@/runtime/roomWorkforceIdentity";
import { isOwnedManagedRoom } from "@/runtime/roomTypes";
import { cleanupCarrierTaskBoard } from "@/runtime/carrierTaskBoard";
import { cleanupPickupReservationStore } from "@/runtime/energyPickupReservation";
import { cleanupResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { cleanupLogisticsControlStore } from "@/runtime/logistics/logisticsControl";
import { pruneLinkNetworkRuntime } from "@/runtime/linkNetworkMemory";
import { cleanupWorkerTaskBoard } from "@/runtime/workerTaskPool";
import {
  gcProductionReservations,
  migrateResourceReservationsForTypedOwner,
} from "@/runtime/resourceReservation";
import { cleanupTerminalBootstrapRecoveryRuntime } from "@/runtime/terminalBootstrapRecovery";
import { releaseWarTaskOwner } from "@/runtime/warControl";
import { isRoleName } from "@/types/roleCatalog";

const CLEANUP_INTERVAL = 17;
const ROOM_PLANNER_TTL = 50000;
const INTER_SHARD_PORTAL_TTL = 10000;
const INTER_SHARD_REMOTE_TTL = 500;
const INTER_SHARD_CLAIM_TTL = 5000;
const INTER_SHARD_ROOM_STATE_TTL = 5000;
const CROSS_SHARD_COLONIZATION_TTL = 5000;
const RESOURCE_CONTROL_TERMINAL_TASK_TTL = 200;
const CARRIER_TASK_BOARD_TTL = 500;

function getOwnedRoomNameSet(): Set<string> {
  return new Set(getTickContextService().getMyRooms().map((room) => room.name));
}

function getColonizationTargetRoomNameSet(): Set<string> {
  const colonization = Memory.data?.colonization;
  if (!colonization) {
    return new Set();
  }

  return new Set(Object.keys(colonization));
}

interface CreepConfigReferenceSnapshot {
  readonly configNames: ReadonlySet<string>;
  readonly spawningCreepNames: ReadonlySet<string>;
}

function createCreepConfigReferenceSnapshot(): CreepConfigReferenceSnapshot {
  const configNames = new Set<string>();
  const spawningCreepNames = new Set<string>();

  for (const creep of Object.values(Game.creeps)) {
    if (creep.memory.configName) {
      configNames.add(creep.memory.configName);
    }
  }

  for (const spawn of Object.values(Game.spawns)) {
    const spawningName = spawn.spawning?.name;
    if (!spawningName) {
      continue;
    }

    spawningCreepNames.add(spawningName);
    const configName = Game.creeps[spawningName]?.memory.configName
      ?? Memory.creeps?.[spawningName]?.configName;
    if (configName) {
      configNames.add(configName);
    }
  }

  return { configNames, spawningCreepNames };
}

function cleanupDeadCreepMemory(spawningCreepNames: ReadonlySet<string>): number {
  if (!Memory.creeps) {
    return 0;
  }

  let removed = 0;

  for (const creepName of Object.keys(Memory.creeps)) {
    if (!Game.creeps[creepName] && !spawningCreepNames.has(creepName)) {
      delete Memory.creeps[creepName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupDeadSpawnMemory(): number {
  if (!Memory.spawns) {
    return 0;
  }

  let removed = 0;

  for (const spawnName of Object.keys(Memory.spawns)) {
    if (!Game.spawns[spawnName]) {
      delete Memory.spawns[spawnName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupSpawnQueueMemory(): number {
  let trimmed = 0;
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();

  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      const queue = spawn.memory.spawnList;
      if (!queue || queue.length === 0) {
        continue;
      }

      const validQueue = queue.filter((configName) => !!creepConfigs.get(configName));
      if (validQueue.length !== queue.length) {
        spawn.memory.spawnList = validQueue;
        trimmed += queue.length - validQueue.length;
      }
    }
  }

  return trimmed;
}

function cleanupUnknownRoleConfigMemory(): number {
  const configStore = getMemoryService().getCreepConfigStore();
  let removed = 0;
  for (const [configName, config] of Object.entries(configStore)) {
    if (!isRoleName(config.role)) {
      delete configStore[configName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupManagedCreepConfigs(referencedConfigNames: ReadonlySet<string>): number {
  const configStore = getMemoryService().getCreepConfigStore();
  const managedRoomNames = new Set(
    getTickContextService()
      .getMyRooms()
      .filter((room) => isOwnedManagedRoom(room.name))
      .map((room) => room.name),
  );
  const retirements: Array<readonly [string, (typeof configStore)[string]]> = [];

  for (const [configName, config] of Object.entries(configStore)) {
    const identity = getOwnedRoomWorkforceConfigIdentity(configName, config);
    if (!identity || managedRoomNames.has(identity.roomName)) {
      continue;
    }

    retirements.push([configName, config]);
  }

  if (retirements.length === 0) {
    return 0;
  }

  const retiringConfigNames = new Set(retirements.map(([configName]) => configName));
  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (!queue?.some((configName) => retiringConfigNames.has(configName))) {
      continue;
    }

    spawn.memory.spawnList = queue.filter((configName) => !retiringConfigNames.has(configName));
  }

  let removed = 0;
  for (const [configName, config] of retirements) {
    if (referencedConfigNames.has(configName)) {
      delete config.roomName;
    } else {
      delete configStore[configName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupRoomPlannerMemory(ownedRooms: Set<string>, colonizationTargets: Set<string>): number {
  if (!Memory.data?.roomPlanner) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, data] of Object.entries(Memory.data.roomPlanner)) {
    const staleByRoom = !ownedRooms.has(roomName) && !colonizationTargets.has(roomName);
    const staleByTime = Game.time - data.savedAt > ROOM_PLANNER_TTL;

    if (staleByRoom || staleByTime) {
      delete Memory.data.roomPlanner[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupRoomPlannerBuildRuntimeMemory(ownedRooms: Set<string>): number {
  const roomPlannerBuildRooms = Memory.runtime?.roomPlannerBuild?.rooms;
  if (!roomPlannerBuildRooms) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(roomPlannerBuildRooms)) {
    if (!ownedRooms.has(roomName)) {
      delete roomPlannerBuildRooms[roomName];
      removed += 1;
    }
  }

  if (Object.keys(roomPlannerBuildRooms).length === 0 && Memory.runtime?.roomPlannerBuild) {
    delete Memory.runtime.roomPlannerBuild;
  }

  return removed;
}

function cleanupTowerEmergencyMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.towerEmergencyRamparts) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.towerEmergencyRamparts)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.towerEmergencyRamparts[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupResourceControlMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.resourceControl) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.resourceControl.rooms)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.resourceControl.rooms[roomName];
      removed += 1;
    }
  }

  const synthesisBindings = Memory.runtime.resourceControl.synthesisBindings;
  if (synthesisBindings) {
    for (const [key, binding] of Object.entries(synthesisBindings)) {
      const targetRoomName = key.split(":", 1)[0];
      const donorRoomName = binding.fromRoomName;
      const expired = binding.expiresAt < Game.time;
      if (expired || !ownedRooms.has(targetRoomName) || !ownedRooms.has(donorRoomName)) {
        delete synthesisBindings[key];
        removed += 1;
      }
    }
  }

  const logistics = (
    Memory.runtime.resourceControl as unknown as { logistics?: unknown }
  ).logistics;

  if (
    Object.keys(Memory.runtime.resourceControl.rooms).length === 0 &&
    (!synthesisBindings || Object.keys(synthesisBindings).length === 0) &&
    logistics === undefined
  ) {
    delete Memory.runtime.resourceControl;
  }

  return removed;
}

function cleanupSynthesisControlMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.synthesisControl) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.synthesisControl.rooms)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.synthesisControl.rooms[roomName];
      removed += 1;
    }
  }

  for (const [key, binding] of Object.entries(Memory.runtime.synthesisControl.bindings)) {
    const targetRoomName = key.split(":", 1)[0];
    const donorRoomName = binding.fromRoomName;
    const expired = binding.expiresAt < Game.time;
    if (expired || !ownedRooms.has(targetRoomName) || !ownedRooms.has(donorRoomName)) {
      delete Memory.runtime.synthesisControl.bindings[key];
      removed += 1;
    }
  }

  if (
    Object.keys(Memory.runtime.synthesisControl.rooms).length === 0 &&
    Object.keys(Memory.runtime.synthesisControl.bindings).length === 0
  ) {
    delete Memory.runtime.synthesisControl;
  }

  return removed;
}

function cleanupPowerBankBoostMemory(): number {
  const runtime = Memory.runtime;
  if (!runtime) {
    return 0;
  }

  const activeTaskIds = new Set(Object.keys(Memory.data?.powerBankHarvest || {}));
  for (const config of Object.values(Memory.data?.creepConfigs || {})) {
    for (const arg of config.args || []) {
      if (typeof arg === "string") activeTaskIds.add(arg);
    }
  }
  for (const task of Object.values(Memory.data?.war || {})) {
    if (task.activeGeneration?.boostTaskId) activeTaskIds.add(task.activeGeneration.boostTaskId);
  }
  let removed = 0;

  if (runtime.powerBankBoost) {
    for (const taskId of Object.keys(runtime.powerBankBoost)) {
      if (activeTaskIds.has(taskId)) {
        continue;
      }
      delete runtime.powerBankBoost[taskId];
      removed += 1;
    }

    if (Object.keys(runtime.powerBankBoost).length === 0) {
      delete runtime.powerBankBoost;
    }
  }

  const synthesisRooms = runtime.synthesisControl?.rooms;
  if (!synthesisRooms) {
    return removed;
  }

  for (const roomState of Object.values(synthesisRooms)) {
    const pause = roomState.boostPause;
    if (!pause) continue;
    const activePauseTaskIds = (pause.taskIds || [pause.taskId]).filter((taskId) => activeTaskIds.has(taskId));
    if (activePauseTaskIds.length > 0) {
      pause.taskId = activePauseTaskIds[0];
      pause.taskIds = activePauseTaskIds;
    } else {
      delete roomState.boostPause;
      removed += 1;
    }
  }

  return removed;
}

function cleanupSpawnPlannerMemory(ownedRooms: Set<string>): number {
  const commutes = Memory.runtime?.spawnPlanner?.sourceWorkerCommutes;
  if (!commutes) {
    return 0;
  }

  let removed = 0;
  for (const [cacheKey, cache] of Object.entries(commutes)) {
    const roomName = cacheKey.split(":", 1)[0];
    const expired = Game.time - cache.updatedAt > 1000;
    if (!ownedRooms.has(roomName) || expired) {
      delete commutes[cacheKey];
      removed += 1;
    }
  }

  if (Object.keys(commutes).length === 0 && Memory.runtime?.spawnPlanner) {
    delete Memory.runtime.spawnPlanner;
  }

  return removed;
}

function cleanupIllegalStructureCleanupMemory(ownedRooms: Set<string>): number {
  const rooms = Memory.runtime?.illegalStructureCleanup?.rooms;
  if (!rooms) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(rooms)) {
    if (!ownedRooms.has(roomName)) {
      delete rooms[roomName];
      removed += 1;
    }
  }

  if (Object.keys(rooms).length === 0 && Memory.runtime?.illegalStructureCleanup) {
    delete Memory.runtime.illegalStructureCleanup;
  }

  return removed;
}

function cleanupWarMemory(ownedRooms: Set<string>): number {
  if (!Memory.data?.war) {
    return 0;
  }

  let removed = 0;
  for (const [targetRoom, task] of Object.entries(Memory.data.war)) {
    const sourceRoomOwned = ownedRooms.has(task.sourceRoom);
    const terminalDone = task.status === "done" || task.status === "failed";
    const terminalAnchor = task.completedAt ?? task.statusSince ?? task.createdAt;
    const expiredTerminal = terminalDone && Game.time - terminalAnchor > 200;
    if (!sourceRoomOwned || expiredTerminal) {
      const result = releaseWarTaskOwner(targetRoom);
      if (typeof result !== "string" && result.removedTask) removed += 1;
    }
  }

  return removed;
}

function cleanupInterShardPortalMemory(): number {
  if (!Memory.data?.interShardPortals) {
    return 0;
  }

  let removed = 0;
  for (const [portalId, portal] of Object.entries(Memory.data.interShardPortals)) {
    const stale = Game.time - portal.lastSeenAt > INTER_SHARD_PORTAL_TTL;
    const decayed = typeof portal.ticksToDecay === "number" && portal.ticksToDecay <= 0;
    if (stale || decayed) {
      delete Memory.data.interShardPortals[portalId];
      removed += 1;
    }
  }

  return removed;
}

function cleanupCrossShardRuntimeMemory(): number {
  const crossShard = Memory.runtime?.crossShard;
  if (!crossShard) {
    return 0;
  }

  const remotes = crossShard.remotes || {};
  const claims = crossShard.claims || {};
  const rooms = crossShard.rooms || {};

  let removed = 0;
  for (const [shard, remote] of Object.entries(remotes)) {
    if (Game.time - remote.updatedAt > INTER_SHARD_REMOTE_TTL) {
      delete remotes[shard];
      removed += 1;
    }
  }

  for (const [roomName, claim] of Object.entries(claims)) {
    if (Game.time - claim.updatedAt > INTER_SHARD_CLAIM_TTL) {
      delete claims[roomName];
      removed += 1;
    }
  }

  for (const [roomName, summary] of Object.entries(rooms)) {
    if (Game.time - summary.updatedAt > INTER_SHARD_ROOM_STATE_TTL) {
      delete rooms[roomName];
      removed += 1;
    }
  }

  return removed;
}

function cleanupCrossShardColonizationMemory(ownedRooms: Set<string>): number {
  const store = Memory.data?.crossShardColonization;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const [taskId, task] of Object.entries(store)) {
    const sourceRoomLost = !!task.sourceRoom && !ownedRooms.has(task.sourceRoom);
    const staleTerminal =
      (task.status === "blocked" ||
        task.status === "failed" ||
        task.status === "claimed" ||
        task.status === "completed") &&
      Game.time - task.updatedAt > CROSS_SHARD_COLONIZATION_TTL;
    const malformed = !task.targetShard || !task.targetRoom;
    if (sourceRoomLost || staleTerminal || malformed) {
      delete store[taskId];
      removed += 1;
    }
  }

  return removed;
}

function cleanupResourceControlTaskMemory(ownedRooms: Set<string>): number {
  return cleanupResourceTransferTaskStore(
    ownedRooms,
    RESOURCE_CONTROL_TERMINAL_TASK_TTL,
  );
}

function cleanupCarrierTaskBoardMemory(ownedRooms: Set<string>): number {
  return cleanupCarrierTaskBoard(ownedRooms, CARRIER_TASK_BOARD_TTL);
}

function cleanupWorkerTaskBoardMemory(ownedRooms: Set<string>): number {
  return cleanupWorkerTaskBoard(ownedRooms);
}

function cleanupTowerCombatMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.towerCombat) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.towerCombat)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.towerCombat[roomName];
      removed += 1;
    }
  }

  if (Object.keys(Memory.runtime.towerCombat).length === 0) {
    delete Memory.runtime.towerCombat;
  }

  return removed;
}

function cleanupDefenseCoordinationMemory(ownedRooms: Set<string>): number {
  if (!Memory.runtime?.defenseCoordination) {
    return 0;
  }

  let removed = 0;
  for (const roomName of Object.keys(Memory.runtime.defenseCoordination)) {
    if (!ownedRooms.has(roomName)) {
      delete Memory.runtime.defenseCoordination[roomName];
      removed += 1;
    }
  }

  if (Object.keys(Memory.runtime.defenseCoordination).length === 0) {
    delete Memory.runtime.defenseCoordination;
  }

  return removed;
}

function cleanupRescueMemory(ownedRooms: Set<string>): number {
  const store = Memory.data?.rescue;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const [targetRoom, task] of Object.entries(store)) {
    if (!ownedRooms.has(task.sourceRoom)) {
      delete store[targetRoom];
      removed += 1;
    }
  }

  if (Object.keys(store).length === 0 && Memory.data) {
    delete Memory.data.rescue;
  }

  return removed;
}

const HUB_RUNTIME_ARRAY_CAP = 20;
const HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP = 100;

function cleanupHubRuntimeMemory(ownedRooms: Set<string>): number {
  const rt = Memory.runtime?.hub;
  if (!rt) return 0;

  const cfg = Memory.cfg?.hub;
  if (!cfg?.enabled || !cfg.hubRoomName) return 0;

  const hubRoom = Game.rooms[cfg.hubRoomName];
  const roomLost = !hubRoom || !hubRoom.controller?.my;

  if (roomLost) {
    rt.status = "blocked";
    rt.activeProduct = "";
    rt.updatedAt = Game.time;
  }

  if (rt.lastPlanActions && rt.lastPlanActions.length > HUB_RUNTIME_ARRAY_CAP) {
    rt.lastPlanActions = rt.lastPlanActions.slice(-HUB_RUNTIME_ARRAY_CAP);
  }

  if (rt.missingResources && rt.missingResources.length > HUB_RUNTIME_ARRAY_CAP) {
    rt.missingResources = rt.missingResources.slice(0, HUB_RUNTIME_ARRAY_CAP);
  }

  const ds = rt.distributedSynthesis;
  if (ds) {
    if (ds.dispatchAssignments && ds.dispatchAssignments.length > HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP) {
      ds.dispatchAssignments = ds.dispatchAssignments.slice(-HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP);
    }
    if (ds.routeDecisions && ds.routeDecisions.length > HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP) {
      ds.routeDecisions = ds.routeDecisions.slice(-HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP);
    }
    if (ds.progressEdges && ds.progressEdges.length > HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP) {
      ds.progressEdges = ds.progressEdges.slice(-HUB_DISTRIBUTED_SYNTHESIS_ARRAY_CAP);
    }
    if (ds.roomCapabilities) {
      for (const roomName of Object.keys(ds.roomCapabilities)) {
        if (!ownedRooms.has(roomName)) {
          delete ds.roomCapabilities[roomName];
        }
      }
    }
  }

  return roomLost ? 1 : 0;
}

function cleanupNonOwnedRoomMemory(ownedRooms: Set<string>): number {
  if (!Memory.rooms) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, roomMemory] of Object.entries(Memory.rooms)) {
    if (ownedRooms.has(roomName)) {
      continue;
    }

    delete roomMemory.workerConstructionTier;
    delete roomMemory.coreRampartHits;

    if (Object.keys(roomMemory).length === 0) {
      delete Memory.rooms[roomName];
      removed += 1;
    }
  }

  return removed;
}

export function runMemoryCleanup(): void {
  if (Game.time % CLEANUP_INTERVAL !== 0) {
    return;
  }

  const creepConfigReferences = createCreepConfigReferenceSnapshot();
  cleanupDeadCreepMemory(creepConfigReferences.spawningCreepNames);
  pruneDeadCreepAssignmentState();
  pruneDeadCreepMovementState();
  cleanupDeadSpawnMemory();
  cleanupSpawnQueueMemory();
  cleanupUnknownRoleConfigMemory();
  cleanupManagedCreepConfigs(creepConfigReferences.configNames);
  const ownedRooms = getOwnedRoomNameSet();
  const colonizationTargets = getColonizationTargetRoomNameSet();
  cleanupSpawnPlannerMemory(ownedRooms);
  cleanupRoomPlannerMemory(ownedRooms, colonizationTargets);
  cleanupRoomPlannerBuildRuntimeMemory(ownedRooms);
  cleanupIllegalStructureCleanupMemory(ownedRooms);
  pruneLinkNetworkRuntime(ownedRooms);
  cleanupTowerEmergencyMemory(ownedRooms);
  cleanupResourceControlMemory(ownedRooms);
  cleanupSynthesisControlMemory(ownedRooms);
  cleanupPowerBankBoostMemory();
  cleanupPickupReservationStore(ownedRooms);
  cleanupTerminalBootstrapRecoveryRuntime();
  // reservation owner 版本化迁移（幂等：版本标记短路；mutation 上下文执行，
  // 迁移后 bump revision 使 commitment 索引按 typed 口径重建）。
  migrateResourceReservationsForTypedOwner();
  gcProductionReservations();
  cleanupWarMemory(ownedRooms);
  cleanupInterShardPortalMemory();
  cleanupCrossShardRuntimeMemory();
  cleanupCrossShardColonizationMemory(ownedRooms);
  cleanupRescueMemory(ownedRooms);
  cleanupResourceControlTaskMemory(ownedRooms);
  cleanupLogisticsControlStore(ownedRooms);
  cleanupWorkerTaskBoardMemory(ownedRooms);
  cleanupCarrierTaskBoardMemory(ownedRooms);
  cleanupTowerCombatMemory(ownedRooms);
  cleanupDefenseCoordinationMemory(ownedRooms);
  cleanupHubRuntimeMemory(ownedRooms);
  cleanupNonOwnedRoomMemory(ownedRooms);
}
