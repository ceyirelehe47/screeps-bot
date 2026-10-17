import { resolveRoomEnergyPolicy } from "@/runtime/roomEnergyPolicy";

function getAutoReserveFlagName(roomName: string): string {
  return `RESERVE_${roomName}`;
}

function isAtPosition(flag: Flag, pos: RoomPosition): boolean {
  return flag.pos.roomName === pos.roomName && flag.pos.x === pos.x && flag.pos.y === pos.y;
}

function shouldManageRoom(room: Room): room is Room & { storage: StructureStorage } {
  return !!room.controller?.my && room.controller.level >= 4 && !!room.storage;
}

export function runAutoReserveFlags(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!shouldManageRoom(room)) {
      continue;
    }

    const flagName = getAutoReserveFlagName(room.name);
    const flag = Game.flags[flagName];
    const raw = Memory.cfg?.resourceControl?.rooms?.[room.name];
    const level = room.controller?.level ?? 0;
    const scale = level >= 8 ? 1 : level >= 7 ? 0.5 : level >= 6 ? 0.25 : 0.1;
    const policy = resolveRoomEnergyPolicy({ energyFloor: 120_000 * scale, energyTarget: 200_000 * scale, ...raw });
    const storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
    const hasCriticalConstruction = room.find(FIND_MY_CONSTRUCTION_SITES).some(site =>
      site.structureType === STRUCTURE_SPAWN || site.structureType === STRUCTURE_STORAGE ||
      site.structureType === STRUCTURE_TOWER || site.structureType === STRUCTURE_EXTENSION);
    if (hasCriticalConstruction) {
      if (flag) flag.remove();
      continue;
    }

    if (storageEnergy < policy.energyFloor) {
      if (flag) {
        if (!isAtPosition(flag, room.storage.pos)) {
          flag.setPosition(room.storage.pos);
        }
        continue;
      }

      const createdFlagName = room.createFlag(room.storage.pos, flagName);
      if (createdFlagName === flagName) {
        console.log(`[reserve] ${room.name} entered reserve mode at ${storageEnergy} energy`);
      }
      continue;
    }

    if (flag && storageEnergy >= policy.energyTarget) {
      flag.remove();
      console.log(`[reserve] ${room.name} cleared reserve mode at ${storageEnergy} energy`);
    }
  }
}
