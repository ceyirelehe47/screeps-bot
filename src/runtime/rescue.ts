import { ensureConfigStore, getBodyCost, getLiveCreepsByConfig, isConfigSpawning as hasSpawningConfig, removeQueuedSpawnConfig } from "@/runtime/spawnHelpers";
import { spawnProfiles } from "@/config/spawnProfiles";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { isDefenseMode } from "@/runtime/defenseMode";

type RescueStatus = "bootstrapping" | "managed";

interface RescueTask {
  targetRoom: string;
  sourceRoom: string;
  status: RescueStatus;
  flagName: string;
  routeRooms?: string[];
  createdAt: number;
  updatedAt: number;
}

const RESCUE_WORKER_COUNT = 3;

function hasRescueProductionCapability(spawn: StructureSpawn): boolean {
  const minimumRequiredEnergyCapacity = Math.max(
    getBodyCost(spawnProfiles.colonizerHarvester(spawn.room)),
    getBodyCost([WORK, CARRY, MOVE]),
  );
  return spawn.isActive() && spawn.room.energyCapacityAvailable >= minimumRequiredEnergyCapacity;
}

function ensureRescueStore(): Record<string, RescueTask> {
  const data = getMemoryService().ensureData();
  if (!data.rescue) {
    data.rescue = {};
  }
  return data.rescue;
}

function getOwnedSpawnRooms(): string[] {
  const tickContext = getTickContextService();
  const roomNames = new Set<string>();
  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (hasRescueProductionCapability(spawn)) {
        if (isDefenseMode(spawn.room.name)) {
          continue;
        }
        roomNames.add(spawn.room.name);
      }
    }
  }
  return [...roomNames];
}

function selectSourceRoom(targetRoom: string, preferredRoom?: string): string | null {
  const ownedSpawnRooms = getOwnedSpawnRooms();
  if (ownedSpawnRooms.length === 0) return null;

  if (preferredRoom && ownedSpawnRooms.includes(preferredRoom)) {
    return preferredRoom;
  }

  let bestRoom: string | null = null;
  let minDistance = Infinity;

  for (const roomName of ownedSpawnRooms) {
    const distance = Game.map.getRoomLinearDistance(roomName, targetRoom);
    if (distance < minDistance) {
      minDistance = distance;
      bestRoom = roomName;
    }
  }

  return bestRoom;
}

function getPreferredSourceFromFlagName(flagName: string): string | undefined {
  if (!flagName.startsWith("RESCUE_")) return undefined;
  const suffix = flagName.slice(7).trim();
  return suffix.length > 0 ? suffix : undefined;
}

function getRescueFlags(): Flag[] {
  return Object.values(Game.flags).filter(
    (flag) => flag.name === "RESCUE" || flag.name.startsWith("RESCUE_"),
  );
}

function getTaskConfigName(task: RescueTask, role: "harvester" | "worker", indexOrSourceId: string): string {
  return `${task.sourceRoom}:rescue:${task.targetRoom}:${role}:${indexOrSourceId}`;
}

function getTaskConfigNames(task: RescueTask): string[] {
  const prefix = `${task.sourceRoom}:rescue:${task.targetRoom}:`;
  return Object.keys(getCreepConfigService().list(prefix));
}

function isConfigSpawning(configName: string): boolean { const context = getTickContextService(); return context.getMyRooms().some(room => hasSpawningConfig(configName, context.getSpawnsByRoom(room.name))); }

function upsertConfig(configName: string, config: import("@/types/system").CreepConfig): void {
  getCreepConfigService().set(configName, config);
}

function removeQueuedConfig(task: RescueTask, configName: string): void { removeQueuedSpawnConfig(getTickContextService().getSpawnsByRoom(task.sourceRoom), configName); }

function ensureRescueHarvester(task: RescueTask, sourceId: Id<Source>): void {
  const configName = getTaskConfigName(task, "harvester", sourceId);
  const encodedRoute = task.routeRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerHarvester",
    args: [task.targetRoom, sourceId, encodedRoute],
    roomName: task.sourceRoom,
  });
}

function ensureRescueWorker(task: RescueTask, index: number): void {
  const configName = getTaskConfigName(task, "worker", String(index));
  const encodedRoute = task.routeRooms?.join("|") || "";
  upsertConfig(configName, {
    role: "colonizerWorker",
    args: [task.targetRoom, encodedRoute],
    roomName: task.sourceRoom,
  });
}

function cleanupRescueConfigs(task: RescueTask): boolean {
  const configNames = getTaskConfigNames(task);
  const store = ensureConfigStore();
  let removedAll = true;

  for (const configName of configNames) {
    removeQueuedConfig(task, configName);

    const config = store[configName];
    if (config?.roomName) {
      getCreepConfigService().detachSpawn(configName);
    }

    if (isConfigSpawning(configName)) {
      removedAll = false;
      continue;
    }

    const liveCount = getLiveCreepsByConfig(configName).length;
    if (liveCount > 0) {
      removedAll = false;
      continue;
    }

    if (store[configName]) {
      getCreepConfigService().remove(configName);
    }
  }

  return removedAll;
}

function hasOwnedSpawnInTargetRoom(task: RescueTask): boolean {
  return getTickContextService().getSpawnsByRoom(task.targetRoom).length > 0;
}

function computeRoute(task: RescueTask): string[] | null {
  const route = Game.map.findRoute(task.sourceRoom, task.targetRoom, {
    routeCallback: (roomName) => {
      if (roomName === task.sourceRoom || roomName === task.targetRoom) return 1;
      if (Game.map.getRoomStatus(roomName).status !== "normal") return Infinity;
      return 2;
    },
  });

  if (route === ERR_NO_PATH) return null;

  const routeRooms: string[] = [task.sourceRoom];
  for (const step of route) {
    if (step.room !== routeRooms[routeRooms.length - 1]) {
      routeRooms.push(step.room);
    }
  }

  if (routeRooms[routeRooms.length - 1] !== task.targetRoom) {
    routeRooms.push(task.targetRoom);
  }

  return routeRooms;
}

function processRescueTask(task: RescueTask): void {
  if (isDefenseMode(task.sourceRoom)) return;

  if (hasOwnedSpawnInTargetRoom(task)) {
    const targetRoomRcl = Game.rooms[task.targetRoom]?.controller?.level ?? 0;
    if (targetRoomRcl >= 3) {
      task.status = "managed";
      const cleaned = cleanupRescueConfigs(task);
      if (cleaned) {
        const store = ensureRescueStore();
        delete store[task.targetRoom];
        Game.flags[task.flagName]?.remove();
        console.log(`[rescue] complete: ${task.targetRoom} spawn rebuilt, rescue squad recalled`);
      }
      return;
    }
  }

  // Ensure route is computed once
  if (!task.routeRooms || task.routeRooms.length === 0) {
    const route = computeRoute(task);
    if (!route) {
      console.log(`[rescue] no route found from ${task.sourceRoom} to ${task.targetRoom}`);
      return;
    }
    task.routeRooms = route;
    console.log(`[rescue] route: ${route.join(" → ")}`);
  }

  // Always maintain workers: they travel first and provide vision
  for (let i = 0; i < RESCUE_WORKER_COUNT; i++) {
    ensureRescueWorker(task, i);
  }

  // Maintain harvesters once we have vision of the target room
  const targetRoom = Game.rooms[task.targetRoom];
  if (targetRoom) {
    const sources = targetRoom.find(FIND_SOURCES);
    for (const source of sources) {
      ensureRescueHarvester(task, source.id);
    }
  }
}

function upsertRescueTask(flag: Flag): boolean {
  const targetRoom = flag.pos.roomName;
  const preferredRoom = getPreferredSourceFromFlagName(flag.name);
  const previousSource = Memory.data?.rescue?.[targetRoom]?.sourceRoom;
  const sourceRoom = previousSource && Game.rooms[previousSource]?.controller?.my && getTickContextService().getSpawnsByRoom(previousSource).length > 0
    ? previousSource : selectSourceRoom(targetRoom, preferredRoom);

  if (!sourceRoom) return false;

  if (!Memory.data?.rescue?.[targetRoom] && getTickContextService().getSpawnsByRoom(targetRoom).length > 0) {
    console.log(`[rescue] flag ignored: ${flag.name} target=${targetRoom} reason=spawn_exists`);
    flag.remove();
    return true;
  }

  const store = ensureRescueStore();
  const existing = store[targetRoom];
  const now = Game.time;

  if (existing && existing.sourceRoom !== sourceRoom) {
    cleanupRescueConfigs(existing);
  }

  store[targetRoom] = {
    targetRoom,
    sourceRoom,
    status: existing?.status ?? "bootstrapping",
    flagName: flag.name,
    routeRooms: existing?.routeRooms,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (!existing) {
    console.log(`[rescue] started: flag=${flag.name} target=${targetRoom} source=${sourceRoom}`);
  }

  return true;
}

export function isRescueRoom(roomName: string): boolean {
  const task = Memory.data?.rescue?.[roomName];
  return !!task && !isDefenseMode(task.sourceRoom);
}

export function runRescueByFlag(): void {
  const flags = getRescueFlags();
  for (const flag of flags) {
    const scheduled = upsertRescueTask(flag);
    if (!scheduled && Game.time % 100 === 0) {
      console.log(`[rescue] flag pending: ${flag.name} room=${flag.pos.roomName} reason=no_source_room`);
    }
  }

  const store = ensureRescueStore();
  for (const task of Object.values(store)) {
    if (!Game.flags[task.flagName]) {
      cleanupRescueConfigs(task);
      delete store[task.targetRoom];
      console.log(`[rescue] cancelled: ${task.targetRoom} flag removed by player`);
      continue;
    }

    if (isDefenseMode(task.sourceRoom)) {
      cleanupRescueConfigs(task);
      task.updatedAt = Game.time;
      continue;
    }

    processRescueTask(task);
    task.updatedAt = Game.time;
  }
}
