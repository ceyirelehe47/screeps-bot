import { upsertConfig } from "@/runtime/creepApi";
import { getLinkMinerBody } from "@/config/spawnProfiles";
import { isColonizationBootstrapRoom } from "@/runtime/colonization";
import {
  applyRoomWorkforceConstructionTierEffect,
  buildRoomWorkforceInventory,
} from "@/runtime/roomWorkforce";
import { isOwnedManagedRoom } from "@/runtime/roomTypes";
import { isRescueRoom } from "@/runtime/rescue";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import type { TickContextService } from "@/runtime/tickContext";
import { retireMismatchedMinersAfterHandoff } from "@/runtime/minerBodyPolicy";

function hasLiveCreepForConfig(configName: string, tickContext: TickContextService): boolean {
  return tickContext.getCreepsByConfigName(configName).length > 0;
}

function cleanupConfigsByPrefix(
  roomName: string,
  prefix: string,
  validConfigNames: Set<string>,
  tickContext: TickContextService,
  orphanInvalidLiveConfig = false,
): void {
  const creepConfigs = getCreepConfigService();
  const configs = creepConfigs.list(`${roomName}:${prefix}:`);
  for (const configName of Object.keys(configs)) {
    if (validConfigNames.has(configName)) continue;
    if (!hasLiveCreepForConfig(configName, tickContext)) {
      creepConfigs.remove(configName);
    } else if (orphanInvalidLiveConfig) {
      const config = creepConfigs.get(configName);
      if (config) delete config.roomName;
    }
  }
}

function cleanupSourceConfigs(roomName: string, validConfigNames: Set<string>, tickContext: TickContextService): void {
  cleanupConfigsByPrefix(roomName, "harvester", validConfigNames, tickContext);
  cleanupConfigsByPrefix(roomName, "miner", validConfigNames, tickContext);
  cleanupConfigsByPrefix(roomName, "mineralHarvester", validConfigNames, tickContext, true);
}

function cleanupWorkerConfigs(roomName: string, validConfigNames: Set<string>, tickContext: TickContextService): void {
  const creepConfigs = getCreepConfigService();
  const configs = creepConfigs.list(`${roomName}:worker:`);
  for (const configName of Object.keys(configs)) {
    if (validConfigNames.has(configName)) {
      continue;
    }

    const config = creepConfigs.get(configName);
    if (hasLiveCreepForConfig(configName, tickContext)) {
      if (config) {
        delete config.roomName;
      }
    } else {
      creepConfigs.remove(configName);
    }
  }

  for (const spawn of tickContext.getSpawnsByRoom(roomName)) {
    const queue = spawn.memory.spawnList;
    if (!queue?.some((configName) => configName.startsWith(`${roomName}:worker:`))) {
      continue;
    }

    spawn.memory.spawnList = queue.filter((configName) =>
      !configName.startsWith(`${roomName}:worker:`) || validConfigNames.has(configName),
    );
  }
}

function cleanupCarrierConfigs(roomName: string, validConfigNames: Set<string>): void {
  const creepConfigs = getCreepConfigService();
  const configs = creepConfigs.list(`${roomName}:carrier:`);
  for (const configName of Object.keys(configs)) {
    if (!validConfigNames.has(configName)) {
      creepConfigs.remove(configName);
    }
  }
}

function isSourceRoleConfigName(roomName: string, configName: string): boolean {
  return (
    configName.startsWith(`${roomName}:harvester:`) ||
    configName.startsWith(`${roomName}:miner:`) ||
    configName.startsWith(`${roomName}:mineralHarvester:`)
  );
}

function cleanupSourceRoleQueueEntries(
  roomName: string,
  validConfigNames: Set<string>,
  tickContext: TickContextService,
): void {
  for (const spawn of tickContext.getSpawnsByRoom(roomName)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) {
      continue;
    }

    spawn.memory.spawnList = queue.filter((configName) => {
      if (!isSourceRoleConfigName(roomName, configName)) {
        return true;
      }

      return validConfigNames.has(configName);
    });
  }
}

function orphanDeprecatedSourceConfig(configName: string): void {
  const config = getCreepConfigService().get(configName);
  if (!config) {
    return;
  }

  delete config.roomName;
}

function retireDeprecatedSourceWorkers(activeConfigName: string, deprecatedConfigName: string, tickContext: TickContextService): void {
  if (tickContext.getCreepsByConfigName(activeConfigName).length === 0) {
    return;
  }

  const deprecatedCreeps = tickContext.getCreepsByConfigName(deprecatedConfigName);
  if (deprecatedCreeps.length === 0) {
    getCreepConfigService().remove(deprecatedConfigName);
    return;
  }

  for (const creep of deprecatedCreeps) {
    creep.suicide();
  }
}

export function bootstrapRooms(): void {
  const tickContext = getTickContextService();
  const myRooms = tickContext.getMyRooms();

  for (const room of myRooms) {
    if (!isOwnedManagedRoom(room.name)) {
      continue;
    }

    const inventory = buildRoomWorkforceInventory(room);
    applyRoomWorkforceConstructionTierEffect(room, inventory.constructionTierEffect);
    const expectedConfigNames = new Set(inventory.configs.map((config) => config.configName));
    const isSupportedRoom = isColonizationBootstrapRoom(room.name) || isRescueRoom(room.name);

    for (const config of inventory.configs) {
      if (config.kind !== "source") {
        continue;
      }

      if (isSupportedRoom) {
        // Mother room is providing harvesters; remove from expected set so stale local configs get cleaned up
        expectedConfigNames.delete(config.configName);
      } else {
        upsertConfig(config.configName, config.role, [...config.args], inventory.roomName);
        if (config.role === "miner") {
          retireMismatchedMinersAfterHandoff(
            tickContext.getCreepsByConfigName(config.configName),
            config.source,
            getLinkMinerBody(room),
          );
        }
        orphanDeprecatedSourceConfig(config.deprecatedConfigName);
        retireDeprecatedSourceWorkers(config.configName, config.deprecatedConfigName, tickContext);
      }
    }

    for (const config of inventory.configs) {
      if (config.kind === "mineral") {
        upsertConfig(config.configName, config.role, [...config.args], inventory.roomName);
      }
    }

    cleanupSourceRoleQueueEntries(room.name, expectedConfigNames, tickContext);
    cleanupSourceConfigs(room.name, expectedConfigNames, tickContext);

    for (const config of inventory.configs) {
      if (config.kind === "carrier") {
        upsertConfig(config.configName, config.role, [...config.args], inventory.roomName);
      }
    }
    cleanupCarrierConfigs(room.name, expectedConfigNames);

    for (const config of inventory.configs) {
      if (config.kind === "worker") {
        upsertConfig(config.configName, config.role, [...config.args], inventory.roomName);
      }
    }

    cleanupWorkerConfigs(room.name, expectedConfigNames, tickContext);

    // In reserve mode, orphan any lingering worker configs that still have live creeps
    // so spawn planner does not prespawn replacements.
    if (inventory.reserveMode) {
      const creepConfigs = getCreepConfigService();
      for (const config of Object.values(creepConfigs.list(`${room.name}:worker:`))) {
        if (config.roomName) {
          delete config.roomName;
        }
      }
    }
  }
}
