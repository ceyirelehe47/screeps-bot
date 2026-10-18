import { retireCreep } from "@/runtime/retirement";
import { runIsolatedRoutineRoomOperation } from "@/runtime/runtimeIsolation";
import { replaceSpawnQueue } from "@/runtime/spawnRequests";
import { getCreepConfigService, getTickContextService, getMemoryService } from "@/runtime/runtimeServices";

import { HUB_UPGRADER_BODY } from "@/config/spawnProfiles";
import { releaseBoostLabs } from "@/runtime/powerBankBoost";

import { RCL8_UPGRADER_MAINTENANCE_BODY, isDedicatedUpgraderControllerRunnable, shouldMaintainDedicatedUpgrader } from "@/runtime/upgraderPolicy";
import { type CreepConfig } from "@/types/system";

export { HUB_UPGRADER_BODY };

export const UPGRADER_COUNT = 1;

export interface ManualUpgraderResult {
  ok: true;
  roomName: string;
  active: boolean;
  configName: string;
  creepNames: string[];
  boosted: boolean;
  createdAt?: number;
}

function getBoostTaskId(roomName: string): string {
  return `upgrader:${roomName}`;
}

function getConfigName(roomName: string, index = 0): string {
  return `${roomName}:upgrader:${index}`;
}

function isManagedUpgraderConfigName(configName: string): boolean {
  return configName.includes(":upgrader:") || configName.includes(":hubUpgrader:");
}

function isManagedUpgraderConfig(configName: string, config?: CreepConfig): boolean {
  return isManagedUpgraderConfigName(configName) || config?.role === "upgrader" || config?.role === "hubUpgrader";
}

function getManualUpgraderStore(): NonNullable<NonNullable<Memory["data"]>["manualUpgraders"]> {
  const data = getMemoryService().ensureData();
  data.manualUpgraders = data.manualUpgraders || {};
  return data.manualUpgraders;
}

function getConfigRoomName(config: CreepConfig): string | undefined {
  return config.roomName || config.args[0];
}

function getManagedConfigEntries(): Array<[string, CreepConfig]> {
  return Object.entries(getCreepConfigService().readStore())
    .filter(([configName, config]) => isManagedUpgraderConfig(configName, config));
}

function cleanupSpawnedAndQueuedUpgraders(keptConfigNames: ReadonlySet<string>): void {
  const configs = getCreepConfigService().readStore();
  for (const spawn of Object.values(Game.spawns)) {
    const queue = spawn.memory.spawnList;
    if (queue?.length) {
      replaceSpawnQueue(spawn, queue.filter((configName) =>
        !isManagedUpgraderConfig(configName, configs[configName]) || keptConfigNames.has(configName)
      ));
    }

    if (!spawn.spawning) continue;
    const spawningConfigName = Memory.creeps?.[spawn.spawning.name]?.configName;
    if (
      spawningConfigName &&
      isManagedUpgraderConfig(spawningConfigName, configs[spawningConfigName]) &&
      !keptConfigNames.has(spawningConfigName)
    ) {
      spawn.spawning.cancel();
    }
  }
}

function isRcl8MaintenanceBody(body: readonly BodyPartConstant[] | undefined): boolean {
  return body?.length === RCL8_UPGRADER_MAINTENANCE_BODY.length &&
    body.every((part, index) => part === RCL8_UPGRADER_MAINTENANCE_BODY[index]);
}

function getRetiringRcl8MaintenanceConfigNames(): Set<string> {
  const configNames = new Set<string>();
  for (const [configName, config] of getManagedConfigEntries()) {
    const roomName = getConfigRoomName(config);
    if (
      roomName &&
      configName === getConfigName(roomName) &&
      config.role === "upgrader" &&
      Memory.data?.manualUpgraders?.[roomName]?.maintenance === true &&
      isRcl8MaintenanceBody(config.body)
    ) {
      configNames.add(configName);
    }
  }
  return configNames;
}

function cleanupManagedUpgraders(
  keptConfigNames: ReadonlySet<string>,
  retiringRcl8MaintenanceConfigNames: ReadonlySet<string>,
): void {
  const configs = getCreepConfigService().readStore();
  const entries = getManagedConfigEntries().filter(([configName]) => !keptConfigNames.has(configName));
  const roomNames = new Set(
    entries
      .map(([, config]) => getConfigRoomName(config))
      .filter((roomName): roomName is string => !!roomName),
  );

  for (const taskId of Object.keys(Memory.runtime?.powerBankBoost || {})) {
    const roomName = taskId.startsWith("upgrader:")
      ? taskId.slice("upgrader:".length)
      : taskId.startsWith("hubUpgrade:")
        ? taskId.slice("hubUpgrade:".length)
        : undefined;
    if (roomName && !keptConfigNames.has(getConfigName(roomName))) {
      roomNames.add(roomName);
    }
  }

  cleanupSpawnedAndQueuedUpgraders(keptConfigNames);
  for (const creep of getTickContextService().getAllCreeps()) {
    const configName = creep.memory.configName;
    const isKept = !!configName && keptConfigNames.has(configName);
    const isRetiringRcl8Maintenance = !!configName &&
      retiringRcl8MaintenanceConfigNames.has(configName);
    if (
      (creep.memory.role === "upgrader" || creep.memory.role === "hubUpgrader" || (configName && isManagedUpgraderConfigName(configName))) &&
      !isKept &&
      isRetiringRcl8Maintenance
    ) {
      retireCreep(creep, { owner: "workforce", mode: "suicide" });
    }
  }
  for (const [configName] of entries) {
    getCreepConfigService().remove(configName);
  }
  for (const roomName of roomNames) {
    releaseBoostLabs(getBoostTaskId(roomName), roomName);
    releaseBoostLabs(`hubUpgrade:${roomName}`, roomName);
  }
}

function isEligibleUpgraderRoom(roomName: string): boolean {
  const controller = Game.rooms[roomName]?.controller;
  if (!controller) return false;
  return shouldMaintainDedicatedUpgrader(
    controller,
    !!Memory.data?.manualUpgraders?.[roomName],
  );
}

function ensureEligibleRoomUpgraderTasks(): { active: string[]; retained: string[] } {
  const tasks = getManualUpgraderStore();
  const configs = getCreepConfigService().readStore();
  const eligibleRoomNames: string[] = [];

  const failedRooms = new Set<string>();
  for (const room of Object.values(Game.rooms)) {
    const completed = runIsolatedRoutineRoomOperation("hubUpgradeEligibility", room.name, () => {
    const controller = room.controller;
    if (!controller?.my || !shouldMaintainDedicatedUpgrader(controller, !!tasks[room.name])) {
      return true;
    }

    const roomName = room.name;
    eligibleRoomNames.push(roomName);
    const existing = tasks[roomName];
    if (!existing) {
      tasks[roomName] = {
        createdAt: Game.time,
        updatedAt: Game.time,
        maintenance: true,
      };
    } else if (
      existing.maintenance !== true &&
      isDedicatedUpgraderControllerRunnable(controller)
    ) {
      const config = configs[getConfigName(roomName)];
      if (
        config?.role === "upgrader" &&
        config.roomName === roomName &&
        isRcl8MaintenanceBody(config.body)
      ) {
        existing.maintenance = true;
        existing.updatedAt = Game.time;
      }
    }
    return true;
    });
    if (!completed) failedRooms.add(room.name);
  }

  const eligibleRoomSet = new Set([...eligibleRoomNames, ...failedRooms]);
  for (const roomName of Object.keys(tasks)) {
    if (!eligibleRoomSet.has(roomName)) {
      delete tasks[roomName];
    }
  }

  return { active: eligibleRoomNames, retained: [...eligibleRoomSet] };
}

export function startUpgrader(roomName: string): ManualUpgraderResult | string {
  const controller = Game.rooms[roomName]?.controller;
  if (!controller?.my) {
    return `ERR_UPGRADER_REQUIRES_OWNED_ROOM:${roomName}`;
  }
  if (controller.level !== 8) {
    return `ERR_UPGRADER_MAINTENANCE_ONLY_AT_RCL8:${roomName}`;
  }
  const hasExistingTask = !!Memory.data?.manualUpgraders?.[roomName];
  if (!shouldMaintainDedicatedUpgrader(controller, hasExistingTask)) {
    return `ERR_UPGRADER_NOT_REQUIRED_AT_RCL8:${roomName}`;
  }

  const tasks = getManualUpgraderStore();
  const existing = tasks[roomName];
  tasks[roomName] = {
    createdAt: existing?.createdAt ?? Game.time,
    updatedAt: Game.time,
    maintenance: true,
  };
  runHubUpgradeControl();
  return getUpgraderStatus(roomName) as ManualUpgraderResult;
}

export function stopUpgrader(roomName: string): ManualUpgraderResult | string {
  const tasks = getManualUpgraderStore();
  if (!tasks[roomName]) {
    return `ERR_NO_UPGRADER_TASK:${roomName}`;
  }
  if (isEligibleUpgraderRoom(roomName)) {
    return `ERR_UPGRADER_REQUIRED_FOR_OWNED_ROOM:${roomName}`;
  }

  delete tasks[roomName];
  runHubUpgradeControl();
  return `ERR_NO_UPGRADER_TASK:${roomName}`;
}

export function getUpgraderStatus(roomName?: string): ManualUpgraderResult[] | ManualUpgraderResult | string {
  const tasks = getManualUpgraderStore();
  const roomNames = roomName ? [roomName] : Object.keys(tasks);
  const statuses = roomNames.map((name): ManualUpgraderResult => {
    const configName = getConfigName(name);
    const config = getCreepConfigService().readStore()[configName];
    return {
      ok: true,
      roomName: name,
      active: isEligibleUpgraderRoom(name),
      configName,
      creepNames: getTickContextService().getAllCreeps()
        .filter((creep) => creep.memory.configName === configName)
        .map((creep) => creep.name),
      boosted: config?.args[1] === getBoostTaskId(name),
      createdAt: tasks[name]?.createdAt,
    };
  });

  if (!roomName) return statuses;
  return statuses[0] || `ERR_NO_UPGRADER_TASK:${roomName}`;
}

export function runHubUpgradeControl(): void {
  const retiringRcl8MaintenanceConfigNames = getRetiringRcl8MaintenanceConfigNames();
  const eligibility = ensureEligibleRoomUpgraderTasks();
  const activeRoomNames = eligibility.active;
  const keptConfigNames = new Set(eligibility.retained.map((roomName) => getConfigName(roomName)));
  cleanupManagedUpgraders(keptConfigNames, retiringRcl8MaintenanceConfigNames);

  const configs = getCreepConfigService().readStore();
  for (const roomName of activeRoomNames) {
    runIsolatedRoutineRoomOperation("hubUpgradeControl", roomName, () => {
    const configName = getConfigName(roomName);
    const boostTaskId = getBoostTaskId(roomName);

    const previous = configs[configName];
    if (previous?.role !== "upgrader" || previous.roomName !== roomName || previous.args.join("|") !== roomName ||
        previous.body?.join("|") !== RCL8_UPGRADER_MAINTENANCE_BODY.join("|")) {
      getCreepConfigService().set(configName, { role: "upgrader", args: [roomName], roomName, body: [...RCL8_UPGRADER_MAINTENANCE_BODY] });
    }
    if (Memory.runtime?.powerBankBoost?.[boostTaskId]) releaseBoostLabs(boostTaskId, roomName);
    if (Memory.runtime?.powerBankBoost?.[`hubUpgrade:${roomName}`]) releaseBoostLabs(`hubUpgrade:${roomName}`, roomName);
    });
  }
}
