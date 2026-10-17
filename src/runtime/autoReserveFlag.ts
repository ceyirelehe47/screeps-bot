import { recordAutomaticReserveFlag } from "@/runtime/roomReserve";
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

    if (storageEnergy < policy.energyFloor) {
      if (flag) {
        if (!isAtPosition(flag, room.storage.pos)) {
          if (flag.setPosition(room.storage.pos) === OK) recordAutomaticReserveFlag(flagName, room.name);
        }
        continue;
      }

      const createdFlagName = room.createFlag(room.storage.pos, flagName);
      if (createdFlagName === flagName) {
        recordAutomaticReserveFlag(flagName, room.name);
        console.log(`[reserve] ${room.name} entered reserve mode at ${storageEnergy} energy`);
      }
      continue;
    }

    if (flag && storageEnergy >= policy.energyTarget) {
      if (flag.remove() === OK) {
        recordAutomaticReserveFlag(flagName, null);
        console.log(`[reserve] ${room.name} cleared reserve mode at ${storageEnergy} energy`);
      }
    }
  }
}
