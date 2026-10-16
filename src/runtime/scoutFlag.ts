import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

function getScoutFlags(): Flag[] {
  return Object.values(Game.flags).filter(
    (flag) => flag.name === "SCOUT" || flag.name.startsWith("SCOUT_"),
  );
}

function getConfigName(flagName: string): string {
  return `scout:flag:${flagName}`;
}

function selectNearestSourceRoom(targetRoom: string): string | null {
  const tickContext = getTickContextService();
  let bestRoom: string | null = null;
  let minDistance = Infinity;

  for (const room of tickContext.getMyRooms()) {
    const spawns = tickContext.getSpawnsByRoom(room.name);
    if (spawns.length === 0) continue;

    const distance = Game.map.getRoomLinearDistance(room.name, targetRoom);
    if (distance < minDistance) {
      minDistance = distance;
      bestRoom = room.name;
    }
  }

  return bestRoom;
}

function upsertScoutConfig(flag: Flag): void {
  const targetRoom = flag.pos.roomName;
  const sourceRoom = selectNearestSourceRoom(targetRoom);
  if (!sourceRoom) return;

  const configName = getConfigName(flag.name);
  const store = getMemoryService().getCreepConfigStore();
  const existing = store[configName] as CreepConfig | undefined;

  const config: CreepConfig = {
    role: "flagScout",
    args: [targetRoom, String(flag.pos.x), String(flag.pos.y)],
    roomName: sourceRoom,
  };

  if (!existing) {
    store[configName] = config;
    console.log(`[scout] started: flag=${flag.name} target=${targetRoom} source=${sourceRoom}`);
    return;
  }

  // Update source room if a closer room has become available
  if (existing.roomName !== sourceRoom) {
    existing.roomName = sourceRoom;
  }

  // Sync position if flag was moved
  existing.args = config.args;
}

function removeScoutConfig(flagName: string): void {
  const configName = getConfigName(flagName);
  const store = getMemoryService().getCreepConfigStore();
  const config = store[configName];
  if (!config) return;

  // Stop spawning: clear roomName so the spawn system won't re-queue it
  const wasActive = !!config.roomName;
  delete config.roomName;
  for (const spawn of Object.values(Game.spawns)) {
    if (spawn.memory.spawnList) spawn.memory.spawnList = spawn.memory.spawnList.filter(name => name !== configName);
  }

  // Remove if no live creep is using this config
  const tickContext = getTickContextService();
  const liveCreeps = tickContext.getCreepsByConfigName(configName);
  if (liveCreeps.length === 0) {
    delete store[configName];
  }

  if (wasActive) console.log(`[scout] cancelled: flag=${flagName}`);
}

export function runScoutByFlag(): void {
  const activeFlags = new Set(getScoutFlags().map((f) => f.name));

  // Remove configs for flags that no longer exist
  const store = getMemoryService().getCreepConfigStore();
  for (const configName of Object.keys(store)) {
    if (!configName.startsWith("scout:flag:")) continue;
    const flagName = configName.slice("scout:flag:".length);
    if (!activeFlags.has(flagName)) {
      removeScoutConfig(flagName);
    }
  }

  // Upsert configs for active flags
  for (const flag of getScoutFlags()) {
    upsertScoutConfig(flag);
  }
}
