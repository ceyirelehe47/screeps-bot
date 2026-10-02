import { executeTreasuryFencedTerminalCargo } from "@/runtime/treasuryTerminalCargo";
import {
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} from "@/runtime/energyPickupReservation";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { isReceiverLink } from "@/runtime/linkControl";
import { getProtoStorageContainer, getProtoControllerLinkContainer } from "@/runtime/roomPlannerConstruction";
import { getTickContextService } from "@/runtime/runtimeServices";
import { isSpawnActive } from "@/runtime/tickContext";
import { getPowerCreepRoomEnergyPolicy } from "@/runtime/powerCreepControl";
import { isPowerSpawnProcessingEnabledForRoom } from "@/runtime/powerSpawnControl";
import { moveToTarget } from "@/roles/shared";
import { isPositionAllowedForCreep, shouldRestrictToSafeZone } from "@/runtime/safeZoneHelpers";

interface MoveToTargetOptions {
  swampCost?: number;
  plainCost?: number;
  reusePath?: number;
  maxRooms?: number;
  ignoreCreeps?: boolean;
}

interface EnergyStoreTargetOptions {
  excludeIds?: string[];
  includeTerminal?: boolean;
  includeStorage?: boolean;
  roomName?: string;
}

export type EnergyPickupTarget = Resource | AnyStoreStructure | Tombstone | Ruin;

export interface PickupResult {
  picked: boolean;
  outOfRange: boolean;
}

export function isDroppedResourceTarget(target: EnergyPickupTarget): target is Resource {
  return (target as Resource).amount !== undefined;
}

function updateClosestTarget<T extends { pos: RoomPosition }>(
  creep: Creep,
  current: T | null,
  candidate: T,
): T {
  if (!current) {
    return candidate;
  }

  return creep.pos.getRangeTo(candidate.pos) < creep.pos.getRangeTo(current.pos) ? candidate : current;
}

export function getEnergyStoreTarget(creep: Creep, options: EnergyStoreTargetOptions = {}): AnyStoreStructure | null {
  return measureCreepDecision(() => {
    const excludeSet = new Set(options.excludeIds || []);
    const includeTerminal = options.includeTerminal ?? true;
    const includeStorage = options.includeStorage ?? true;
    const roomName = options.roomName ?? creep.room.name;
    const roomContext = getTickContextService().getRoomContext(roomName);
    const targetRoom = Game.rooms[roomName] || (creep.room.name === roomName ? creep.room : null);
    const myStructures = roomContext?.getMyStructures() || [];
    const powerCreepPolicy = getPowerCreepRoomEnergyPolicy(roomName);

    let bestSpawnOrExtension: AnyStoreStructure | null = null;
    let bestTower: AnyStoreStructure | null = null;
    let bestPowerSpawn: AnyStoreStructure | null = null;
    let bestLab: AnyStoreStructure | null = null;

    for (const structure of myStructures) {
      if (excludeSet.has(structure.id)) {
        continue;
      }

      if (shouldRestrictToSafeZone(creep) && !isPositionAllowedForCreep(creep, structure.pos)) {
        continue;
      }

      if (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) {
        if (structure.structureType === STRUCTURE_SPAWN && powerCreepPolicy.suppressSpawnSupply) {
          continue;
        }
        if (structure.structureType === STRUCTURE_EXTENSION && powerCreepPolicy.suppressExtensionSupply) {
          continue;
        }
        const target = structure as StructureSpawn | StructureExtension;
        if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          bestSpawnOrExtension = updateClosestTarget(creep, bestSpawnOrExtension, target);
        }
        continue;
      }

      if (structure.structureType === STRUCTURE_TOWER) {
        const tower = structure as StructureTower;
        const used = tower.store.getUsedCapacity(RESOURCE_ENERGY);
        const capacity = tower.store.getCapacity(RESOURCE_ENERGY);
        if (capacity > 0 && tower.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && used <= capacity * 0.6) {
          bestTower = updateClosestTarget(creep, bestTower, tower);
        }
        continue;
      }

      if (structure.structureType === STRUCTURE_POWER_SPAWN) {
        if (
          powerCreepPolicy.managePowerSpawnSupply ||
          isPowerSpawnProcessingEnabledForRoom(roomName)
        ) {
          continue;
        }
        const powerSpawn = structure as StructurePowerSpawn;
        if (powerSpawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          bestPowerSpawn = updateClosestTarget(creep, bestPowerSpawn, powerSpawn);
        }
        continue;
      }

      if (structure.structureType === STRUCTURE_LAB) {
        const lab = structure as StructureLab;
        if (lab.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          bestLab = updateClosestTarget(creep, bestLab, lab);
        }
      }
    }

    const roomSpawns = getTickContextService().getSpawnsByRoom(roomName);
    const activeSpawns = roomSpawns.filter(isSpawnActive);
    const noIdleActiveSpawn = roomSpawns.length > 0 &&
      activeSpawns.every((spawn) => !!spawn.spawning);

    // With Spawn evidence but no active idle Spawn, empty extensions cannot
    // enable an immediate spawn action. Do not let that prefill hide a Tower
    // at its critical threshold or an unmanaged PowerSpawn's direct supply.
    if (noIdleActiveSpawn && bestTower) {
      return bestTower;
    }
    if (noIdleActiveSpawn && bestPowerSpawn) {
      return bestPowerSpawn;
    }

    if (bestSpawnOrExtension) {
      return bestSpawnOrExtension;
    }

    if (bestTower) {
      return bestTower;
    }

    if (bestPowerSpawn) {
      return bestPowerSpawn;
    }

    if (bestLab) {
      return bestLab;
    }

    if (includeStorage && targetRoom?.storage && !excludeSet.has(targetRoom.storage.id) &&
      (!shouldRestrictToSafeZone(creep) || isPositionAllowedForCreep(creep, targetRoom.storage.pos))) {
      return targetRoom.storage;
    }

    if (includeTerminal && targetRoom?.terminal && !excludeSet.has(targetRoom.terminal.id) &&
      (!shouldRestrictToSafeZone(creep) || isPositionAllowedForCreep(creep, targetRoom.terminal.pos))) {
      return targetRoom.terminal;
    }

    const protoStorageContainer = targetRoom ? getProtoStorageContainer(targetRoom) : null;
    if (protoStorageContainer && !excludeSet.has(protoStorageContainer.id) &&
        (!shouldRestrictToSafeZone(creep) || isPositionAllowedForCreep(creep, protoStorageContainer.pos)) &&
        protoStorageContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      return protoStorageContainer;
    }

    const protoControllerContainer = targetRoom ? getProtoControllerLinkContainer(targetRoom) : null;
    if (protoControllerContainer && !excludeSet.has(protoControllerContainer.id) &&
        (!shouldRestrictToSafeZone(creep) || isPositionAllowedForCreep(creep, protoControllerContainer.pos)) &&
        protoControllerContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      return protoControllerContainer;
    }

    return null;
  });
}

function getTargetEnergyAmount(target: EnergyPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function getPreferredEnergyPickupCandidates(creep: Creep): EnergyPickupTarget[] {
  return measureCreepDecision(() => {
    const roomContext = getTickContextService().getRoomContext(creep.room);
    const dropped = roomContext?.getDroppedEnergyResources() || [];
    const structures = roomContext?.getStructures() || [];
    const protoStorageContainer = getProtoStorageContainer(creep.room);
    const structureCandidates = structures.filter(
      (structure): structure is AnyStoreStructure =>
        (structure.structureType === STRUCTURE_CONTAINER ||
          structure.structureType === STRUCTURE_STORAGE ||
          (structure.structureType === STRUCTURE_LINK && isReceiverLink(structure as StructureLink))) &&
        structure.id !== protoStorageContainer?.id &&
        (structure as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
    );
    const tombstones = roomContext?.getEnergyTombstones() || [];
    const ruins = roomContext?.getEnergyRuins() || [];

    const candidates: EnergyPickupTarget[] = [...dropped, ...structureCandidates, ...tombstones, ...ruins];
    if (candidates.length === 0) {
      return [];
    }

    const filtered = shouldRestrictToSafeZone(creep)
      ? candidates.filter((target) => isPositionAllowedForCreep(creep, target.pos))
      : candidates;

    const threshold = creep.store.getCapacity(RESOURCE_ENERGY) ?? 0;
    const scored = filtered
      .map((target) => ({
        target,
        amount: getTargetEnergyAmount(target),
        distance: creep.pos.getRangeTo(target.pos),
      }))
      .filter((entry) => entry.amount > 0);

    const hasRichCandidate = scored.some((entry) => entry.amount >= threshold);
    return scored
      .filter((entry) => !hasRichCandidate || entry.amount >= threshold)
      .sort((left, right) => left.distance - right.distance)
      .map((entry) => entry.target);
  });
}

export function getPreferredEnergyPickupTarget(creep: Creep): EnergyPickupTarget | null {
  const candidates = getPreferredEnergyPickupCandidates(creep);
  return candidates.length > 0 ? candidates[0] : null;
}

export function pickupEnergyFromPreferredTarget(
  creep: Creep,
  moveOptions: MoveToTargetOptions = {},
): PickupResult {
  const desiredAmount = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

  let sourceTarget = getReservedPickupTarget(creep) as EnergyPickupTarget | null;
  if (sourceTarget && shouldRestrictToSafeZone(creep) && !isPositionAllowedForCreep(creep, sourceTarget.pos)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (sourceTarget && !reservePickupTarget(creep, sourceTarget, desiredAmount)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (!sourceTarget) {
    const candidates = getPreferredEnergyPickupCandidates(creep);
    for (const candidate of candidates) {
      if (reservePickupTarget(creep, candidate, desiredAmount)) {
        sourceTarget = candidate;
        break;
      }
    }
  }

  if (!sourceTarget) {
    return { picked: false, outOfRange: false };
  }

  if (isDroppedResourceTarget(sourceTarget)) {
    const pickupCode = measureCreepIntent(() => creep.pickup(sourceTarget));
    if (pickupCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget, 1, moveOptions);
      return { picked: false, outOfRange: true };
    }

    if (pickupCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    if (pickupCode === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      releasePickupReservation(creep, sourceTarget.id);
    }

    return { picked: pickupCode === OK, outOfRange: false };
  }

  const withdrawCode = measureCreepIntent(() => executeTreasuryFencedTerminalCargo(sourceTarget, () => creep.withdraw(sourceTarget, RESOURCE_ENERGY)));
  if (withdrawCode === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, sourceTarget, 1, moveOptions);
    return { picked: false, outOfRange: true };
  }

  if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
    releasePickupReservation(creep, sourceTarget.id);
    return { picked: false, outOfRange: false };
  }

  if (withdrawCode === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    releasePickupReservation(creep, sourceTarget.id);
  }

  return { picked: withdrawCode === OK, outOfRange: false };
}
