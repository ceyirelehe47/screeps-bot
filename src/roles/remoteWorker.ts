import { shelterRemoteMiningCivilian } from "@/roles/remoteMiningCivilian";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { getRemoteInfrastructureWork } from "@/runtime/remoteMining";
import { moveOffExit } from "@/movement/traffic";

import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTS = { plainCost: 2, swampCost: 10, profile: "travel" as const, reusePath: 10 };

function idleInsideRoom(creep: Creep): void {
  clearMovementState(creep);
  if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
    moveOffExit(creep);
  }
}

function getCarriedEnergy(creep: Creep): number {
  return creep.store.getUsedCapacity(RESOURCE_ENERGY);
}

function isEmpty(creep: Creep): boolean {
  return getCarriedEnergy(creep) === 0;
}

function isFull(creep: Creep): boolean {
  return creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0;
}

function clearRepairTarget(creep: Creep): void {
  delete creep.memory._remoteWorkerRepairTargetId;
}

function repairStructure(creep: Creep, target: Structure): void {
  creep.memory._remoteWorkerRepairTargetId = target.id;
  if (creep.pos.getRangeTo(target.pos) <= 3) {
    creep.repair(target);
  } else {
    moveToTarget(creep, target, 3);
  }
}

function findRemoteSourceIds(targetRoom: string): string[] {
  return Memory.data?.remoteMining?.[targetRoom]?.sourceIds ?? [];
}

function findSourceContainersInRoom(room: Room, sourceIds: string[]): StructureContainer[] {
  const sourcePositions: RoomPosition[] = [];
  for (const sid of sourceIds) {
    const source = Game.getObjectById(sid as Id<Source>);
    if (source) sourcePositions.push(source.pos);
  }

  return room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER &&
      sourcePositions.some((sp) => sp.getRangeTo(s.pos) <= 2),
  });
}

function findDroppedEnergyInRoom(room: Room, sourceIds: string[]): Resource[] {
  const sourcePositions: RoomPosition[] = [];
  for (const sid of sourceIds) {
    const source = Game.getObjectById(sid as Id<Source>);
    if (source) sourcePositions.push(source.pos);
  }

  return room.find(FIND_DROPPED_RESOURCES, {
    filter: (r): r is Resource =>
      r.resourceType === RESOURCE_ENERGY &&
      r.amount > 0 &&
      sourcePositions.some((sp) => sp.getRangeTo(r.pos) <= 2),
  });
}

type RemoteEnergyCandidate =
  | { kind: "container"; target: StructureContainer; energy: number; pos: RoomPosition }
  | { kind: "dropped"; target: Resource; energy: number; pos: RoomPosition };

function findRemoteEnergyCandidates(room: Room, sourceIds: string[]): RemoteEnergyCandidate[] {
  const containers = findSourceContainersInRoom(room, sourceIds)
    .map((container): RemoteEnergyCandidate => ({
      kind: "container",
      target: container,
      energy: container.store.getUsedCapacity(RESOURCE_ENERGY),
      pos: container.pos,
    }))
    .filter((candidate) => candidate.energy > 0);

  const droppedEnergy = findDroppedEnergyInRoom(room, sourceIds)
    .map((resource): RemoteEnergyCandidate => ({
      kind: "dropped",
      target: resource,
      energy: resource.amount,
      pos: resource.pos,
    }));

  return [...containers, ...droppedEnergy];
}

function compareRemoteEnergyCandidates(creep: Creep, a: RemoteEnergyCandidate, b: RemoteEnergyCandidate): number {
  const byEnergy = b.energy - a.energy;
  if (byEnergy !== 0) return byEnergy;
  return creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos);
}

export const remoteWorkerRole: RoleFactory = (targetRoom: string) => {
  return {
    source: (creep): boolean => {
      if (shelterRemoteMiningCivilian(creep, targetRoom)) return false;
      clearRepairTarget(creep);

      if (isFull(creep)) {
        return true;
      }

      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, TRAVEL_OPTS);
        return false;
      }

      if (!isEmpty(creep)) {
        return true;
      }

      const sourceIds = findRemoteSourceIds(targetRoom);
      const candidates = findRemoteEnergyCandidates(creep.room, sourceIds)
        .sort((a, b) => compareRemoteEnergyCandidates(creep, a, b));
      if (candidates.length > 0) {
        const candidate = candidates[0];
        const code = candidate.kind === "container"
          ? creep.withdraw(candidate.target, RESOURCE_ENERGY)
          : creep.pickup(candidate.target);
        if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, candidate.target, 1);
        return false;
      }

      idleInsideRoom(creep);
      return false;
    },

    target: (creep): boolean => {
      if (shelterRemoteMiningCivilian(creep, targetRoom)) return false;
      if (creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, undefined, TRAVEL_OPTS);
        return false;
      }

      if (isEmpty(creep)) {
        clearRepairTarget(creep);
        return true;
      }

      const { sites, damaged } = getRemoteInfrastructureWork(creep.room);
      const tracked = damaged.find(structure => structure.id === creep.memory._remoteWorkerRepairTargetId);
      if (tracked) {
        repairStructure(creep, tracked);
        return false;
      }
      clearRepairTarget(creep);

      // 容器先建，保障矿点收能。其余施工前先救急，随后补齐普通磨损。
      const weakest = damaged.sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
      const containerSite = sites.find(site => site.structureType === STRUCTURE_CONTAINER);
      if (!containerSite && weakest && weakest.hits < weakest.hitsMax * 0.30) {
        repairStructure(creep, weakest);
        return false;
      }

      const site = containerSite ?? sites.sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos))[0];
      if (site) {
        if (creep.pos.getRangeTo(site.pos) <= 3) {
          creep.build(site);
        } else {
          moveToTarget(creep, site, 3);
        }
        return false;
      }

      if (weakest) {
        repairStructure(creep, weakest);
        return false;
      }

      idleInsideRoom(creep);
      return false;
    },
  };
};
