import { getSafeZone } from "@/runtime/safeZone";
import { isDefenseMode, isOffensiveWarCreep } from "@/runtime/defenseMode";
import { getTickContextService } from "@/runtime/runtimeServices";

const DEFENSE_MODE_RUNTIME_EXEMPT_ROLES = new Set<CreepMemory["role"]>(["harvester", "miner"]);

export function isInsideSafeZone(pos: RoomPosition, safeZone: Set<number>): boolean {
  return safeZone.has(pos.x * 50 + pos.y);
}

export function getCreepDefenseRoomName(creep: Creep): string {
  const configName = creep.memory.configName;
  if (!configName) {
    return creep.room.name;
  }

  return configName.split(":")[0] || creep.room.name;
}

export function createSafeZoneCostCallback(safeZone: Set<number>): (roomName: string, matrix: CostMatrix) => CostMatrix {
  return (_roomName: string, matrix: CostMatrix): CostMatrix => {
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        if (!safeZone.has(x * 50 + y)) {
          matrix.set(x, y, 255);
        }
      }
    }
    return matrix;
  };
}

export function getBoundaryRamparts(room: Room, safeZone: Set<number>): StructureRampart[] {
  const roomContext = getTickContextService().getRoomContext?.(room);
  const ramparts =
    roomContext?.getRamparts() ||
    (room.find(FIND_MY_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_RAMPART,
    }) as StructureRampart[]);

  return ramparts.filter((s): s is StructureRampart => {
      if (s.structureType !== STRUCTURE_RAMPART) return false;
      if (!safeZone.has(s.pos.x * 50 + s.pos.y)) return false;
      const { x, y } = s.pos;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
          if (!safeZone.has(nx * 50 + ny)) return true;
        }
      }
      return false;
    });
}

export function shouldRestrictToSafeZone(creep: Creep): boolean {
  if (isOffensiveWarCreep(creep)) return false;
  if (DEFENSE_MODE_RUNTIME_EXEMPT_ROLES.has(creep.memory.role)) return false;
  const roomName = getCreepDefenseRoomName(creep);
  // 老家受袭不能冻结仍在外房的回程单位；进入老家后再约束房内移动。
  if (creep.room.name !== roomName) return false;
  if (!isDefenseMode(roomName)) return false;
  return getSafeZone(roomName).size > 0;
}

export function isPositionAllowedForCreep(creep: Creep, pos: RoomPosition): boolean {
  if (!shouldRestrictToSafeZone(creep)) {
    return true;
  }

  const roomName = getCreepDefenseRoomName(creep);
  if (pos.roomName !== roomName) {
    return false;
  }

  return isInsideSafeZone(pos, getSafeZone(roomName));
}
