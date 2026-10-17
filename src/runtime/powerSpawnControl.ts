import {
  listCarrierTasksByRoom,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTask,
  type CarrierTaskDraft,
  type CarrierTaskStep,
  type CarrierStructureKind,
} from "@/runtime/carrierTaskBoard";
import { createCarrierTaskStep } from "@/runtime/carrierTaskHelpers";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { resolveRoomEnergyPolicyForRoom } from "@/runtime/roomEnergyPolicy";
import { runPowerDistribution } from "@/runtime/powerDistribution";

export const POWER_SPAWN_CARRIER_TASK_PRODUCER = "powerSpawnControl";
export const POWER_SPAWN_SUPPLY_PRIORITY = 150;
export const POWER_SPAWN_LOW_WATER_RATIO = 0.2;
export const POWER_SPAWN_HIGH_WATER_RATIO = 0.9;

type SupplySource = StructureStorage | StructureTerminal;

function getOwnedPowerSpawn(room: Room): StructurePowerSpawn | null {
  return room.find(FIND_MY_STRUCTURES).find(
    (structure): structure is StructurePowerSpawn => structure.structureType === STRUCTURE_POWER_SPAWN
      && (typeof structure.isActive !== "function" || structure.isActive()),
  ) || null;
}

function getSourceAmount(source: SupplySource, resource: ResourceConstant, roomName: string): number {
  if (source.structureType === STRUCTURE_TERMINAL) {
    return getTerminalAmountOutsideMarketSaleExposure(source, resource, roomName);
  }
  return source.store.getUsedCapacity(resource);
}

function findSupplySource(
  room: Room,
  resource: ResourceConstant,
  preference: "storage" | "terminal",
): { source: SupplySource; amount: number; kind: CarrierStructureKind } | null {
  const candidates: Array<SupplySource | undefined> = preference === "storage"
    ? [room.storage, room.terminal]
    : [room.terminal, room.storage];

  for (const source of candidates) {
    if (!source) {
      continue;
    }
    const policy = resolveRoomEnergyPolicyForRoom(room.name);
    const reserve = resource === RESOURCE_ENERGY
      ? (source.structureType === STRUCTURE_STORAGE ? policy.energyFloor : policy.terminalEnergyReserve) : 0;
    const amount = Math.max(0, getSourceAmount(source, resource, room.name) - reserve);
    if (amount <= 0) {
      continue;
    }
    return {
      source,
      amount,
      kind: source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
    };
  }
  return null;
}

function getExistingPowerSpawnTask(roomName: string): CarrierTask | null {
  return listCarrierTasksByRoom(roomName).find(
    (task) => task.producer === POWER_SPAWN_CARRIER_TASK_PRODUCER && task.type === "power_spawn_supply",
  ) || null;
}

function shouldPublishResourceStep(
  powerSpawn: StructurePowerSpawn,
  resource: ResourceConstant,
  existingTask: CarrierTask | null,
): boolean {
  const capacity = powerSpawn.store.getCapacity(resource) || 0;
  if (capacity <= 0) {
    return false;
  }
  const used = (powerSpawn.store.getUsedCapacity(resource) ?? 0);
  const hadStep = !!existingTask?.steps.some((step) => step.resource === resource);
  if (hadStep) {
    return used < Math.ceil(capacity * POWER_SPAWN_HIGH_WATER_RATIO);
  }
  return used < Math.ceil(capacity * POWER_SPAWN_LOW_WATER_RATIO);
}

function createSupplyStep(
  room: Room,
  powerSpawn: StructurePowerSpawn,
  resource: ResourceConstant,
  preference: "storage" | "terminal",
): CarrierTaskStep | null {
  const capacity = powerSpawn.store.getCapacity(resource) || 0;
  const missing = capacity - (powerSpawn.store.getUsedCapacity(resource) ?? 0);
  if (missing <= 0) {
    return null;
  }
  const source = findSupplySource(room, resource, preference);
  if (!source) {
    return null;
  }

  return createCarrierTaskStep({
    producer: POWER_SPAWN_CARRIER_TASK_PRODUCER,
    roomName: room.name,
    resource,
    fromKind: source.kind,
    toKind: "power_spawn",
    fromId: source.source.id,
    toId: powerSpawn.id,
    amount: Math.min(missing, source.amount),
  });
}

function buildSupplyDraft(room: Room, powerSpawn: StructurePowerSpawn): CarrierTaskDraft | null {
  const existingTask = getExistingPowerSpawnTask(room.name);
  const steps: CarrierTaskStep[] = [];

  if (shouldPublishResourceStep(powerSpawn, RESOURCE_POWER, existingTask)) {
    const powerStep = createSupplyStep(room, powerSpawn, RESOURCE_POWER, "terminal");
    if (powerStep) {
      steps.push(powerStep);
    }
  }
  if (shouldPublishResourceStep(powerSpawn, RESOURCE_ENERGY, existingTask)) {
    const energyStep = createSupplyStep(room, powerSpawn, RESOURCE_ENERGY, "storage");
    if (energyStep) {
      steps.push(energyStep);
    }
  }

  if (steps.length === 0) {
    return null;
  }
  return {
    id: `${POWER_SPAWN_CARRIER_TASK_PRODUCER}:power_spawn_supply:${room.name}`,
    type: "power_spawn_supply",
    priority: POWER_SPAWN_SUPPLY_PRIORITY,
    steps,
  };
}

function runRoomPowerSpawnControl(room: Room, powerSpawn: StructurePowerSpawn): void {
  if (
    powerSpawn.store.getUsedCapacity(RESOURCE_POWER) >= 1 &&
    powerSpawn.store.getUsedCapacity(RESOURCE_ENERGY) >= POWER_SPAWN_ENERGY_RATIO
  ) {
    powerSpawn.processPower();
  }

  const draft = buildSupplyDraft(room, powerSpawn);
  replaceCarrierTasksForProducerRoom(
    POWER_SPAWN_CARRIER_TASK_PRODUCER,
    room.name,
    draft ? [draft] : [],
  );
}

export function isPowerSpawnProcessingEnabledForRoom(roomName: string): boolean {
  const room = Game.rooms[roomName];
  return !!room?.controller?.my && !isRoomInReserveMode(roomName);
}

export function runPowerSpawnControl(): void {
  const validRoomNames = new Set<string>();
  const processors = new Map<string, StructurePowerSpawn>();
  const rooms = Object.values(Game.rooms).sort((left, right) => left.name.localeCompare(right.name));
  for (const room of rooms) {
    if (!isPowerSpawnProcessingEnabledForRoom(room.name)) {
      continue;
    }
    const powerSpawn = getOwnedPowerSpawn(room);
    if (!powerSpawn) {
      continue;
    }
    validRoomNames.add(room.name);
    processors.set(room.name, powerSpawn);
    runRoomPowerSpawnControl(room, powerSpawn);
  }
  pruneCarrierTasksForProducer(POWER_SPAWN_CARRIER_TASK_PRODUCER, validRoomNames);
  runPowerDistribution(rooms, processors);
}
