import {
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
  type CarrierTaskStep,
} from "@/runtime/carrierTaskBoard";
import { getTickContextService } from "@/runtime/runtimeServices";
import { shouldPauseNativeMineralHarvest } from "@/runtime/mineralHarvestPolicy";

const MINERAL_EXTRACTION_CARRIER_TASK_PRODUCER = "mineralExtraction";
const MINERAL_EXTRACTION_SAMPLE_INTERVAL = 10;
const MINERAL_HAUL_THRESHOLD = 700;
const MINERAL_HAUL_PRIORITY = 91;

function getAdjacentMineralContainer(mineral: Mineral): StructureContainer | null {
  const containers = mineral.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
  }) as StructureContainer[];
  return containers[0] ?? null;
}

function hasExtractor(mineral: Mineral): boolean {
  const structures = mineral.pos.lookFor(LOOK_STRUCTURES);
  return structures.some((structure) => structure.structureType === STRUCTURE_EXTRACTOR);
}

function resolveMineralDeliveryTarget(
  room: Room,
  resource: ResourceConstant,
): StructureTerminal | StructureStorage | null {
  if (room.terminal && room.terminal.store.getFreeCapacity(resource) > 0) {
    return room.terminal;
  }

  if (room.storage && room.storage.store.getFreeCapacity(resource) > 0) {
    return room.storage;
  }

  return null;
}

function createTaskStep(resource: ResourceConstant, container: StructureContainer, target: StructureTerminal | StructureStorage): CarrierTaskStep {
  return {
    id: `${resource}:${container.id}->${target.id}`,
    resource,
    fromKind: "container",
    toKind: target.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
    fromId: container.id,
    toId: target.id,
    amount: container.store.getUsedCapacity(resource),
  };
}

function createRoomTasks(room: Room): CarrierTaskDraft[] {
  if (!room.controller?.my) {
    return [];
  }

  const minerals = room.find(FIND_MINERALS);
  if (minerals.length === 0) {
    return [];
  }

  const tasks: CarrierTaskDraft[] = [];
  for (const mineral of minerals) {
    const resource = mineral.mineralType;
    if (shouldPauseNativeMineralHarvest(room, resource)) continue;
    const container = getAdjacentMineralContainer(mineral);
    if (!container || !hasExtractor(mineral)) {
      continue;
    }

    const amount = container.store.getUsedCapacity(resource);
    if (amount <= MINERAL_HAUL_THRESHOLD) {
      continue;
    }

    const target = resolveMineralDeliveryTarget(room, resource);
    if (!target) {
      continue;
    }

    tasks.push({
      id: `mineral:mineral_haul:${room.name}:${mineral.id}`,
      type: "mineral_haul",
      priority: MINERAL_HAUL_PRIORITY,
      steps: [createTaskStep(resource, container, target)],
    });
  }

  return tasks;
}

export function runMineralExtraction(): void {
  const rooms = getTickContextService().getMyRooms();
  const validRoomNames = new Set(rooms.map((room) => room.name));

  if (Game.time % MINERAL_EXTRACTION_SAMPLE_INTERVAL !== 0) {
    pruneCarrierTasksForProducer(MINERAL_EXTRACTION_CARRIER_TASK_PRODUCER, validRoomNames);
    return;
  }

  for (const room of rooms) {
    replaceCarrierTasksForProducerRoom(
      MINERAL_EXTRACTION_CARRIER_TASK_PRODUCER,
      room.name,
      createRoomTasks(room),
    );
  }

  pruneCarrierTasksForProducer(MINERAL_EXTRACTION_CARRIER_TASK_PRODUCER, validRoomNames);
}
