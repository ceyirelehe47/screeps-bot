import { appendRuntimeEvent } from "@/runtime/runtimeEvents";
import { getAcceptedSpawnReceipts } from "@/runtime/spawnRequests";
import { isDue } from "@/runtime/cadence";
import { replaceSpawnQueue } from "@/runtime/spawnRequests";
import { cleanupPowerBankRoomIntel } from "@/runtime/powerBankIntelCleanup";
import { pruneDeadCreepMovementState } from "@/movement/creepState";
import { pruneDeadCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { getOwnedRoomWorkforceConfigIdentity } from "@/runtime/roomWorkforceIdentity";
import { isOwnedManagedRoom } from "@/runtime/roomTypes";
import { cleanupCarrierTaskBoard } from "@/runtime/carrierTaskBoard";
import { cleanupPickupReservationStore } from "@/runtime/energyPickupReservation";
import { cleanupResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { cleanupLogisticsControlStore } from "@/runtime/logistics/logisticsControl";
import { pruneLinkNetworkRuntime } from "@/runtime/linkNetworkMemory";
import { cleanupWorkerTaskBoard } from "@/runtime/workerTaskPool";
import { gcProductionReservations } from "@/runtime/resourceReservation";
import { cleanupTerminalBootstrapRecoveryRuntime } from "@/runtime/terminalBootstrapRecovery";
import { isRoleName } from "@/types/roleCatalog";
import { runRegisteredMemoryGc } from "@/runtime/memoryGcRegistry";

const CLEANUP_INTERVAL = 17;
const RESOURCE_CONTROL_TERMINAL_TASK_TTL = 200;
const CARRIER_TASK_BOARD_TTL = 500;

function getOwnedRoomNameSet(): Set<string> {
  return new Set(getTickContextService().getMyRooms().map((room) => room.name));
}


interface CreepConfigReferenceSnapshot {
  readonly configNames: ReadonlySet<string>;
  readonly spawningCreepNames: ReadonlySet<string>;
}

function createCreepConfigReferenceSnapshot(): CreepConfigReferenceSnapshot {
  const configNames = new Set<string>();
  const spawningCreepNames = new Set<string>();

  for (const creep of getTickContextService().getAllCreeps()) {
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

  for (const receipt of getAcceptedSpawnReceipts()) { configNames.add(receipt.configName); spawningCreepNames.add(receipt.creepName); }
  return { configNames, spawningCreepNames };
}

function cleanupDeadCreepMemory(spawningCreepNames: ReadonlySet<string>): number {
  if (!Memory.creeps) {
    return 0;
  }

  let removed = 0;

  for (const creepName of Object.keys(Memory.creeps)) {
    if (!Game.creeps[creepName] && !spawningCreepNames.has(creepName)) {
      appendRuntimeEvent({ owner: "creep", id: creepName, kind: "death", from: Memory.creeps[creepName].role });
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
        replaceSpawnQueue(spawn, validQueue);
        trimmed += queue.length - validQueue.length;
      }
    }
  }

  return trimmed;
}

function cleanupUnknownRoleConfigMemory(): number {
  const configStore = getCreepConfigService().readStore();
  let removed = 0;
  for (const [configName, config] of Object.entries(configStore)) {
    if (!isRoleName(config.role)) {
      getCreepConfigService().remove(configName);
      removed += 1;
    }
  }

  return removed;
}

function cleanupManagedCreepConfigs(referencedConfigNames: ReadonlySet<string>): number {
  const configStore = getCreepConfigService().readStore();
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

    replaceSpawnQueue(spawn, queue.filter((configName) => !retiringConfigNames.has(configName)));
  }

  let removed = 0;
  for (const [configName, config] of retirements) {
    if (referencedConfigNames.has(configName)) {
      getCreepConfigService().detachSpawn(configName);
    } else {
      getCreepConfigService().remove(configName);
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
    delete roomMemory.coreDefenseSnapshot;

    if (Object.keys(roomMemory).length === 0) {
      delete Memory.rooms[roomName];
      removed += 1;
    }
  }

  return removed;
}

export function runMemoryCleanup(): void {
  if (!isDue("memory.cleanup", CLEANUP_INTERVAL)) {
    return;
  }

  // 旧 CPU profiler 已无写入方；保留 cpuMonitor.health 及当前遥测投影。
  if (Memory.analytics) delete (Memory.analytics as ScreepsMemoryAnalytics & { moduleCpu?: unknown }).moduleCpu;
  const creepConfigReferences = createCreepConfigReferenceSnapshot();
  cleanupDeadCreepMemory(creepConfigReferences.spawningCreepNames);
  pruneDeadCreepAssignmentState();
  pruneDeadCreepMovementState();
  cleanupDeadSpawnMemory();
  cleanupSpawnQueueMemory();
  cleanupUnknownRoleConfigMemory();
  cleanupManagedCreepConfigs(creepConfigReferences.configNames);
  const ownedRooms = getOwnedRoomNameSet();
  pruneLinkNetworkRuntime(ownedRooms);
  cleanupPowerBankRoomIntel();
  cleanupPickupReservationStore(ownedRooms);
  cleanupTerminalBootstrapRecoveryRuntime();
  gcProductionReservations();
  runRegisteredMemoryGc({ ownedRooms });
  cleanupResourceControlTaskMemory(ownedRooms);
  cleanupLogisticsControlStore(ownedRooms);
  cleanupWorkerTaskBoardMemory(ownedRooms);
  cleanupCarrierTaskBoardMemory(ownedRooms);
  cleanupNonOwnedRoomMemory(ownedRooms);
}
