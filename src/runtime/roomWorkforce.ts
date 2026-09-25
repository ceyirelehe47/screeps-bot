import { hasSourceAdjacentLink } from "@/runtime/sourceLink";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { peekWorkerTasksByRoom } from "@/runtime/workerTaskPool";
import { formatRoomWorkforceConfigName } from "@/runtime/roomWorkforceIdentity";
import { shouldPauseNativeMineralHarvest } from "@/runtime/mineralHarvestPolicy";

const DEFAULT_WORKER_MAX = 8;
const DEFAULT_WORKER_BASE = 1;

type SourceWorkerRole = "harvester" | "miner";
export type WorkerConstructionTier = 0 | 1 | 2 | 3;

export type ConstructionTierEffect =
  | { readonly kind: "preserve" }
  | { readonly kind: "set"; readonly value: WorkerConstructionTier };

export type ManagedWorkforceConfigSpec =
  | {
      readonly kind: "source";
      readonly configName: string;
      readonly role: SourceWorkerRole;
      readonly args: readonly [Id<Source>];
      readonly source: Source;
      readonly deprecatedConfigName: string;
    }
  | {
      readonly kind: "mineral";
      readonly configName: string;
      readonly role: "mineralHarvester";
      readonly args: readonly [Id<Mineral>];
      readonly mineralId: Id<Mineral>;
    }
  | {
      readonly kind: "carrier";
      readonly configName: string;
      readonly role: "carrier";
      readonly args: readonly [];
      readonly slot: number;
    }
  | {
      readonly kind: "worker";
      readonly configName: string;
      readonly role: "worker";
      readonly args: readonly [];
      readonly slot: number;
    };

export interface RoomWorkforceInventory {
  readonly roomName: string;
  readonly reserveMode: boolean;
  readonly constructionTierEffect: ConstructionTierEffect;
  readonly configs: readonly ManagedWorkforceConfigSpec[];
}

interface WorkerCountDecision {
  readonly count: number;
  readonly constructionTierEffect: Extract<ConstructionTierEffect, { kind: "set" }>;
}

function isMineralEligibleForHarvest(mineral: Mineral): boolean {
  if (mineral.mineralAmount <= 0) {
    return false;
  }

  const structures = mineral.pos.findInRange(FIND_STRUCTURES, 1);
  const hasExtractor = structures.some((structure) => structure.structureType === STRUCTURE_EXTRACTOR);
  const hasContainer = structures.some((structure) => structure.structureType === STRUCTURE_CONTAINER);
  return hasExtractor && hasContainer;
}

export function getEligibleMineralIds(room: Room): Id<Mineral>[] {
  return room
    .find(FIND_MINERALS)
    .filter((mineral) =>
      isMineralEligibleForHarvest(mineral) &&
      !shouldPauseNativeMineralHarvest(room, mineral.mineralType),
    )
    .map((mineral) => mineral.id);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function hasNormalRepairTask(room: Room): boolean {
  const tasks = peekWorkerTasksByRoom(room.name);
  if (Object.keys(tasks).length === 0) {
    return false;
  }

  return Object.values(tasks).some((task) => task.type === "repair" && task.repairMode === "normal" && task.status === "active");
}

function getConstructionTierWithHysteresis(
  previousTier: RoomMemory["workerConstructionTier"],
  constructionCount: number,
): WorkerConstructionTier {
  let tier: WorkerConstructionTier;
  if (previousTier === undefined) {
    if (constructionCount >= 15) {
      tier = 3;
    } else if (constructionCount >= 6) {
      tier = 2;
    } else if (constructionCount >= 1) {
      tier = 1;
    } else {
      tier = 0;
    }
  } else {
    tier = previousTier;
  }

  if (tier < 1 && constructionCount >= 1) {
    tier = 1;
  }
  if (tier >= 1 && constructionCount <= 0) {
    tier = 0;
  }

  if (tier < 2 && constructionCount >= 6) {
    tier = 2;
  }
  if (tier >= 2 && constructionCount <= 4) {
    tier = 1;
  }

  if (tier < 3 && constructionCount >= 15) {
    tier = 3;
  }
  if (tier >= 3 && constructionCount <= 12) {
    tier = 2;
  }

  return tier;
}

export function getWorkerCap(): number {
  const configured = Memory.cfg?.worker?.maxPerRoom;
  const cap = typeof configured === "number" ? configured : DEFAULT_WORKER_MAX;
  return clamp(cap, 1, 10);
}

function getDesiredWorkerCountDecision(room: Room): WorkerCountDecision {
  const cap = getWorkerCap();
  const rcl = room.controller?.level ?? 1;
  if (rcl >= 8) {
    return {
      count: 1,
      constructionTierEffect: { kind: "set", value: 0 },
    };
  }

  let desired = rcl < 4 ? 6 - rcl : DEFAULT_WORKER_BASE;

  const constructionCount = room.find(FIND_CONSTRUCTION_SITES).length;
  const constructionTier = getConstructionTierWithHysteresis(
    room.memory.workerConstructionTier,
    constructionCount,
  );
  desired += constructionTier;

  if (hasNormalRepairTask(room)) {
    desired += 1;
  }

  return {
    count: clamp(desired, 1, cap),
    constructionTierEffect: { kind: "set", value: constructionTier },
  };
}

export function applyRoomWorkforceConstructionTierEffect(
  room: Room,
  effect: ConstructionTierEffect,
): void {
  if (effect.kind === "set") {
    room.memory.workerConstructionTier = effect.value;
  }
}

export function getDesiredWorkerCount(room: Room): number {
  const decision = getDesiredWorkerCountDecision(room);
  applyRoomWorkforceConstructionTierEffect(room, decision.constructionTierEffect);
  return decision.count;
}

export function buildRoomWorkforceInventory(room: Room): RoomWorkforceInventory {
  const configs: ManagedWorkforceConfigSpec[] = [];

  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    const role: SourceWorkerRole = hasSourceAdjacentLink(source) ? "miner" : "harvester";
    const deprecatedRole: SourceWorkerRole = role === "miner" ? "harvester" : "miner";
    configs.push({
      kind: "source",
      configName: formatRoomWorkforceConfigName(room.name, role, source.id),
      role,
      args: [source.id],
      source,
      deprecatedConfigName: formatRoomWorkforceConfigName(room.name, deprecatedRole, source.id),
    });
  }

  const mineralIds = getEligibleMineralIds(room);
  for (const mineralId of mineralIds) {
    configs.push({
      kind: "mineral",
      configName: formatRoomWorkforceConfigName(room.name, "mineralHarvester", mineralId),
      role: "mineralHarvester",
      args: [mineralId],
      mineralId,
    });
  }

  const carrierCount = (room.controller?.level ?? 0) <= 4 ? 2 : 1;
  for (let i = 0; i < carrierCount; i++) {
    configs.push({
      kind: "carrier",
      configName: formatRoomWorkforceConfigName(room.name, "carrier", i),
      role: "carrier",
      args: [],
      slot: i,
    });
  }

  const reserveMode = isRoomInReserveMode(room.name);
  let constructionTierEffect: ConstructionTierEffect = { kind: "preserve" };
  if (!reserveMode) {
    const workerDecision = getDesiredWorkerCountDecision(room);
    constructionTierEffect = workerDecision.constructionTierEffect;
    for (let i = 0; i < workerDecision.count; i++) {
      configs.push({
        kind: "worker",
        configName: formatRoomWorkforceConfigName(room.name, "worker", i),
        role: "worker",
        args: [],
        slot: i,
      });
    }
  }

  return {
    roomName: room.name,
    reserveMode,
    constructionTierEffect,
    configs,
  };
}
