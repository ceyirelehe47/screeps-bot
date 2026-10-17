import { ensureConfigStore } from "@/runtime/spawnHelpers";
import { isSpawnActive } from "@/runtime/tickContext";
import { buildStandardCarrierBody } from "@/runtime/carrierBodyPolicy";
import { getTickContextService } from "@/runtime/runtimeServices";


export interface SpawnMaxCarrierResult {
  ok: true;
  roomName: string;
  spawnName: string;
  configName: string;
  energyAvailable: number;
  bodyParts: number;
  pairCount: number;
  queueTop: string[];
}

function resolveSpawnByRoom(roomName: string): StructureSpawn | null {
  const spawns = getTickContextService().getSpawnsByRoom(roomName);
  if (spawns.length === 0) {
    return null;
  }

  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;
  return [...candidates].sort((left, right) => {
    const leftBusy = left.spawning ? 1 : 0;
    const rightBusy = right.spawning ? 1 : 0;
    if (leftBusy !== rightBusy) {
      return leftBusy - rightBusy;
    }

    const leftLoad = (left.memory.spawnList?.length ?? 0) + leftBusy;
    const rightLoad = (right.memory.spawnList?.length ?? 0) + rightBusy;
    if (leftLoad !== rightLoad) {
      return leftLoad - rightLoad;
    }

    return left.name.localeCompare(right.name);
  })[0];
}

function enqueueAtFront(spawn: StructureSpawn, configName: string): void {
  const queue = spawn.memory.spawnList || [];
  spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
}

export function spawnMaxCarrier(roomName: string): SpawnMaxCarrierResult | string {
  const spawn = resolveSpawnByRoom(roomName);
  if (!spawn) {
    return `ERR_NO_SPAWN:${roomName}`;
  }

  const energyAvailable = spawn.room.energyAvailable;
  if (energyAvailable < BODYPART_COST[CARRY] + BODYPART_COST[MOVE]) {
    return `ERR_NOT_ENOUGH_ENERGY:${energyAvailable}`;
  }

  const body = buildStandardCarrierBody(energyAvailable);
  const pairCount = body.length / 2;
  const configName = `${roomName}:manual:maxcarrier:${Game.time}`;

  ensureConfigStore()[configName] = {
    role: "carrier",
    args: [],
    roomName,
    body,
  };

  enqueueAtFront(spawn, configName);

  return {
    ok: true,
    roomName,
    spawnName: spawn.name,
    configName,
    energyAvailable,
    bodyParts: body.length,
    pairCount,
    queueTop: (spawn.memory.spawnList || []).slice(0, 5),
  };
}

export function spawnMaxCarrierRaw(roomName: string): SpawnMaxCarrierResult | string {
  return spawnMaxCarrier(roomName);
}
