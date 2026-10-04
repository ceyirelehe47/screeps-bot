import type { RoleName } from "@/types/system";
import {
  POWER_BANK_BODY_RCL6,
  POWER_BANK_BODY_RCL7,
  POWER_BANK_BODY_RCL8,
} from "@/runtime/powerBankConstants";
import { buildStandardCarrierBody } from "@/runtime/carrierBodyPolicy";
import { getRegenSourceLevelForRoom } from "@/runtime/powerCreepControl";
import { DEPOSIT_BODY } from "@/runtime/depositViability";

type SpawnBodyGenerator = (room: Room) => BodyPartConstant[];

const MAX_BODY_SIZE = 50;

export const HUB_UPGRADER_BODY: BodyPartConstant[] = [
  ...Array(15).fill(WORK),
  ...Array(5).fill(CARRY),
  ...Array(10).fill(MOVE),
];

function clampByCapacity(parts: BodyPartConstant[], room: Room): BodyPartConstant[] {
  const result: BodyPartConstant[] = [];
  let total = 0;

  for (const part of parts) {
    if (result.length >= MAX_BODY_SIZE) {
      break;
    }
    const cost = BODYPART_COST[part];
    if (total + cost > room.energyCapacityAvailable) {
      break;
    }
    total += cost;
    result.push(part);
  }

  return result.length > 0 ? result : [WORK, CARRY, MOVE];
}

function oneOneOneBody(room: Room): BodyPartConstant[] {
  const tripletCost = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  // 按完整组限制体型，避免 50 节截断把最后一组的 MOVE 切掉。
  const tripletCount = Math.max(1, Math.min(
    Math.floor(MAX_BODY_SIZE / 3),
    Math.floor(room.energyCapacityAvailable / tripletCost),
  ));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < tripletCount; i++) {
    parts.push(WORK, CARRY, MOVE);
  }

  return clampByCapacity(parts, room);
}

function twoToOneWorkMoveBody(room: Room): BodyPartConstant[] {
  const unitCost = BODYPART_COST[WORK] * 2 + BODYPART_COST[MOVE];
  const maxUnitsByBodySize = Math.floor(MAX_BODY_SIZE / 3);
  const unitCount = Math.max(
    1,
    Math.min(
      maxUnitsByBodySize,
      Math.floor(room.energyCapacityAvailable / unitCost),
    ),
  );
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < unitCount; i++) {
    parts.push(WORK, WORK, MOVE);
  }

  return clampByCapacity(parts, room);
}

const FIXED_MINER_BODY: BodyPartConstant[] = [WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE];
const BASE_LINK_MINER_WORK_PARTS = 6;
const LINK_MINER_CARRY_PARTS = 8;
const LINK_MINER_NON_MOVE_PARTS_PER_MOVE = 2;
const COLONIZER_HARVESTER_BODY: BodyPartConstant[] = [
  WORK,
  WORK,
  WORK,
  WORK,
  WORK,
  MOVE,
  MOVE,
  MOVE,
  MOVE,
  MOVE,
];

export function getHarvesterBody(room: Room): BodyPartConstant[] {
  const fixedBodyCost = FIXED_MINER_BODY.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  if (room.energyCapacityAvailable >= fixedBodyCost) {
    return [...FIXED_MINER_BODY];
  }

  return twoToOneWorkMoveBody(room);
}

export function getLinkMinerWorkPartsForRegenSourceLevel(level: number): number {
  const normalizedLevel = Math.max(0, Math.min(
    POWER_INFO[PWR_REGEN_SOURCE].effect.length,
    Math.floor(level),
  ));
  if (normalizedLevel <= 0) {
    return BASE_LINK_MINER_WORK_PARTS;
  }

  const sourceEnergyPerTick = SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME;
  const regenEnergyPerTick = POWER_INFO[PWR_REGEN_SOURCE].effect[normalizedLevel - 1]
    / POWER_INFO[PWR_REGEN_SOURCE].period;
  return Math.max(
    BASE_LINK_MINER_WORK_PARTS,
    Math.ceil((sourceEnergyPerTick + regenEnergyPerTick) / HARVEST_POWER),
  );
}

export function getLinkMinerBodyForRegenSourceLevel(level: number): BodyPartConstant[] {
  const workParts = getLinkMinerWorkPartsForRegenSourceLevel(level);
  const moveParts = Math.ceil(
    (workParts + LINK_MINER_CARRY_PARTS) / LINK_MINER_NON_MOVE_PARTS_PER_MOVE,
  );

  return [
    ...Array<BodyPartConstant>(workParts).fill(WORK),
    ...Array<BodyPartConstant>(LINK_MINER_CARRY_PARTS).fill(CARRY),
    ...Array<BodyPartConstant>(moveParts).fill(MOVE),
  ];
}

export function getLinkMinerBody(room: Room): BodyPartConstant[] {
  return getLinkMinerBodyForRegenSourceLevel(getRegenSourceLevelForRoom(room.name));
}

function homeDefenderBody(room: Room): BodyPartConstant[] {
  const unitCost = BODYPART_COST[ATTACK] + BODYPART_COST[MOVE];
  const unitCount = Math.max(1, Math.min(25, Math.floor(room.energyCapacityAvailable / unitCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < unitCount; i++) {
    parts.push(ATTACK, MOVE);
  }

  return clampByCapacity(parts, room);
}

function meleeAttackBody(room: Room): BodyPartConstant[] {
  const unitCost = BODYPART_COST[TOUGH] + BODYPART_COST[ATTACK] + BODYPART_COST[MOVE] * 2;
  const unitCount = Math.max(1, Math.min(10, Math.floor(room.energyCapacityAvailable / unitCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < unitCount; i++) {
    parts.push(TOUGH, ATTACK, MOVE, MOVE);
  }

  return clampByCapacity(parts, room);
}

function healerBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[HEAL] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(8, Math.floor(room.energyCapacityAvailable / pairCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    parts.push(HEAL, MOVE);
  }

  return clampByCapacity(parts, room);
}

function powerBankScoutBody(): BodyPartConstant[] {
  return [MOVE];
}

function powerBankAttackerBody(room: Room): BodyPartConstant[] {
  const rcl = room.controller?.level ?? 0;
  if (rcl >= 8) return [...POWER_BANK_BODY_RCL8.attacker];
  if (rcl >= 7) return [...POWER_BANK_BODY_RCL7.attacker];
  return [...POWER_BANK_BODY_RCL6.attacker];
}

function powerBankHealerBody(room: Room): BodyPartConstant[] {
  const rcl = room.controller?.level ?? 0;
  if (rcl >= 8) return [...POWER_BANK_BODY_RCL8.healer];
  if (rcl >= 7) return [...POWER_BANK_BODY_RCL7.healer];
  return [...POWER_BANK_BODY_RCL6.healer];
}

function powerBankHaulerBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const pairCount = Math.max(1, Math.min(25, Math.floor(room.energyCapacityAvailable / pairCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    parts.push(CARRY, MOVE);
  }

  return clampByCapacity(parts, room);
}

function remoteDefenderBody(room: Room): BodyPartConstant[] {
  const capacity = room.energyCapacityAvailable;
  const rangedCost = BODYPART_COST[RANGED_ATTACK];
  const healCost = BODYPART_COST[HEAL];
  const moveCost = BODYPART_COST[MOVE];
  const minFull = rangedCost + healCost + moveCost * 2;

  if (capacity < minFull) {
    return [RANGED_ATTACK, MOVE];
  }

  let bestSlots = 0;
  for (let slots = 25; slots >= 2; slots--) {
    const healCount = Math.max(1, Math.round(slots * 0.3));
    const rangedCount = slots - healCount;
    if (rangedCount < 1) continue;
    const totalParts = rangedCount + healCount + slots;
    if (totalParts > MAX_BODY_SIZE) continue;
    const totalCost = rangedCount * rangedCost + healCount * healCost + slots * moveCost;
    if (totalCost <= capacity) {
      bestSlots = slots;
      break;
    }
  }

  if (bestSlots === 0) {
    return [RANGED_ATTACK, HEAL, MOVE, MOVE];
  }

  const healCount = Math.max(1, Math.round(bestSlots * 0.3));
  const rangedCount = bestSlots - healCount;

  const parts: BodyPartConstant[] = [];
  for (let i = 0; i < rangedCount; i++) parts.push(RANGED_ATTACK);
  for (let i = 0; i < healCount; i++) parts.push(HEAL);
  for (let i = 0; i < bestSlots; i++) parts.push(MOVE);

  return parts;
}

function remoteWorkerBody(room: Room): BodyPartConstant[] {
  const tripletCost = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
  const maxTriplets = 10;
  const tripletCount = Math.max(1, Math.min(maxTriplets, Math.floor(room.energyCapacityAvailable / tripletCost)));
  const parts: BodyPartConstant[] = [];

  for (let i = 0; i < tripletCount; i++) {
    parts.push(WORK, CARRY, MOVE);
  }

  return clampByCapacity(parts, room);
}

function remoteMiningCarrierBody(room: Room): BodyPartConstant[] {
  const capacity = room.energyCapacityAvailable;

  // Ratio: MOVE : non-MOVE = 1 : 2
  // non-MOVE = 1 WORK + remaining CARRY
  // For n non-MOVE parts, MOVE count = ceil(n / 2)
  let maxN = 2; // minimum useful: 1 WORK + 1 CARRY
  for (let n = 2; n <= 50; n++) {
    const moves = Math.ceil(n / 2);
    if (n + moves > MAX_BODY_SIZE) break;
    const cost = BODYPART_COST[WORK] + (n - 1) * BODYPART_COST[CARRY] + moves * BODYPART_COST[MOVE];
    if (cost > capacity) break;
    maxN = n;
  }

  const moves = Math.ceil(maxN / 2);
  const parts: BodyPartConstant[] = [WORK];
  for (let i = 1; i < maxN; i++) parts.push(CARRY);
  for (let i = 0; i < moves; i++) parts.push(MOVE);

  return clampByCapacity(parts, room);
}

function remoteMiningReserverBody(room: Room): BodyPartConstant[] {
  const pairCost = BODYPART_COST[CLAIM] + BODYPART_COST[MOVE];
  const maxPairs = Math.max(1, Math.min(3, Math.floor(room.energyCapacityAvailable / pairCost)));
  const parts: BodyPartConstant[] = [];
  for (let i = 0; i < maxPairs; i++) {
    parts.push(CLAIM, MOVE);
  }
  return clampByCapacity(parts, room);
}

export const spawnProfiles: Record<RoleName, SpawnBodyGenerator> = {
  harvester: (room) => getHarvesterBody(room),
  mineralHarvester: twoToOneWorkMoveBody,
  miner: getLinkMinerBody,
  carrier: (room) => buildStandardCarrierBody(room.energyCapacityAvailable),
  worker: oneOneOneBody,
  upgrader: () => [...HUB_UPGRADER_BODY],
  hubUpgrader: () => [...HUB_UPGRADER_BODY],
  scout: () => [MOVE],
  claimer: () => [CLAIM, MOVE],
  colonizerHarvester: () => [...COLONIZER_HARVESTER_BODY],
  colonizerWorker: oneOneOneBody,
  meleeAttacker: meleeAttackBody,
  healer: healerBody,
  homeDefender: homeDefenderBody,
  crossShardClaimer: () => [CLAIM, MOVE],
  crossShardColonizerHarvester: () => [...COLONIZER_HARVESTER_BODY],
  crossShardColonizerWorker: oneOneOneBody,
  flagScout: () => [MOVE],
  remoteCarrier: (room) => buildStandardCarrierBody(room.energyCapacityAvailable),
  remoteMiningCarrier: remoteMiningCarrierBody,
  remoteMiningReserver: remoteMiningReserverBody,
  powerBankScout: powerBankScoutBody,
  powerBankAttacker: powerBankAttackerBody,
  powerBankHealer: powerBankHealerBody,
  powerBankHauler: powerBankHaulerBody,
  depositHarvester: () => [...DEPOSIT_BODY],
  remoteWorker: remoteWorkerBody,
  remoteDefender: remoteDefenderBody,
};
