import { replaceSpawnQueue } from "@/runtime/spawnRequests";
import { selectLeastLoadedSpawn as selectSpawnByLoad } from "@/runtime/spawnHelpers";
import { isSpawnActive } from "@/runtime/tickContext";

export interface SpawnQueueOwnershipOptions {
  knownConfigNames: ReadonlySet<string>;
  spawningConfigNames: ReadonlySet<string>;
}

interface QueueOccurrence {
  spawn: StructureSpawn;
  index: number;
}

interface OwnershipRequest {
  configName: string;
  occurrences: QueueOccurrence[];
  eligibleOwners: QueueOccurrence[];
  requestedIndex: number;
}

interface QueueMigration {
  configName: string;
  source: QueueOccurrence;
}

interface QueuePlacement {
  configName: string;
  target: StructureSpawn;
  requestedIndex: number;
  sourceSpawnName: string;
  order: number;
}

type QueueSnapshot = Map<StructureSpawn, string[]>;

function compareOccurrence(left: QueueOccurrence, right: QueueOccurrence): number {
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.spawn.name.localeCompare(right.spawn.name);
}

function getQueueSnapshot(spawns: StructureSpawn[]): QueueSnapshot {
  return new Map(spawns.map((spawn) => [spawn, [...(spawn.memory.spawnList ?? [])]]));
}

function getOccurrencesByConfig(snapshot: QueueSnapshot): Map<string, QueueOccurrence[]> {
  const result = new Map<string, QueueOccurrence[]>();
  for (const [spawn, queue] of snapshot) {
    for (const [index, configName] of queue.entries()) {
      const occurrences = result.get(configName) ?? [];
      occurrences.push({ spawn, index });
      result.set(configName, occurrences);
    }
  }
  return result;
}

function selectLeastLoadedSpawn(
  spawns: StructureSpawn[],
  plannedLoads: ReadonlyMap<StructureSpawn, number>,
): StructureSpawn {
  return selectSpawnByLoad(spawns, spawn => plannedLoads.get(spawn) ?? 0)!;
}

function rebuildQueues(
  spawns: StructureSpawn[],
  snapshot: QueueSnapshot,
  removedConfigNames: ReadonlySet<string>,
  placements: QueuePlacement[],
): void {
  const placementsBySpawn = new Map<StructureSpawn, QueuePlacement[]>();
  for (const placement of placements) {
    const targetPlacements = placementsBySpawn.get(placement.target) ?? [];
    targetPlacements.push(placement);
    placementsBySpawn.set(placement.target, targetPlacements);
  }

  for (const spawn of spawns) {
    const tokens: Array<{
      configName: string;
      index: number;
      kind: "placement" | "existing";
      sourceSpawnName: string;
      order: number;
    }> = [];

    for (const [index, configName] of (snapshot.get(spawn) ?? []).entries()) {
      if (!removedConfigNames.has(configName)) {
        tokens.push({
          configName,
          index,
          kind: "existing",
          sourceSpawnName: spawn.name,
          order: index,
        });
      }
    }

    for (const placement of placementsBySpawn.get(spawn) ?? []) {
      tokens.push({
        configName: placement.configName,
        index: placement.requestedIndex,
        kind: "placement",
        sourceSpawnName: placement.sourceSpawnName,
        order: placement.order,
      });
    }

    tokens.sort((left, right) => {
      if (left.index !== right.index) {
        return left.index - right.index;
      }
      if (left.kind !== right.kind) {
        return left.kind === "placement" ? -1 : 1;
      }
      const sourceDiff = left.sourceSpawnName.localeCompare(right.sourceSpawnName);
      if (sourceDiff !== 0) {
        return sourceDiff;
      }
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.configName.localeCompare(right.configName);
    });
    replaceSpawnQueue(spawn, tokens.map((token) => token.configName));
  }
}

/**
 * Canonicalizes one room's persisted Spawn queues immediately before spawnWork.
 * A configName is one logical production request, so it can have at most one
 * queue owner even though a room may have several Spawn structures.
 */
export function reconcileSpawnQueueOwnership(
  spawns: StructureSpawn[],
  options: SpawnQueueOwnershipOptions,
): void {
  if (spawns.length === 0) {
    return;
  }

  const sortedSpawns = [...spawns].sort((left, right) => left.name.localeCompare(right.name));
  const activeSpawns = sortedSpawns.filter(isSpawnActive);
  const activeSet = new Set(activeSpawns);

  // Normalize each queue first. This establishes the immutable input generation
  // used by every owner decision below.
  for (const spawn of sortedSpawns) {
    const seen = new Set<string>();
    replaceSpawnQueue(spawn, (spawn.memory.spawnList ?? []).filter((configName) => {
      if (
        !options.knownConfigNames.has(configName) ||
        options.spawningConfigNames.has(configName) ||
        seen.has(configName)
      ) {
        return false;
      }
      seen.add(configName);
      return true;
    }));
  }

  const normalizedSnapshot = getQueueSnapshot(sortedSpawns);
  const occurrencesByConfig = getOccurrencesByConfig(normalizedSnapshot);
  const ownershipRequests: OwnershipRequest[] = [];
  const migrations: QueueMigration[] = [];

  for (const [configName, occurrences] of occurrencesByConfig) {
    const activeOccurrences = occurrences.filter((occurrence) => activeSet.has(occurrence.spawn));
    if (activeSpawns.length > 0 && activeOccurrences.length === 0) {
      migrations.push({
        configName,
        source: [...occurrences].sort(compareOccurrence)[0],
      });
      continue;
    }

    if (occurrences.length <= 1) {
      continue;
    }

    const eligibleOwners = activeSpawns.length > 0 ? activeOccurrences : occurrences;
    ownershipRequests.push({
      configName,
      occurrences,
      eligibleOwners,
      requestedIndex: Math.min(...occurrences.map((occurrence) => occurrence.index)),
    });
  }

  const duplicateConfigNames = new Set(ownershipRequests.map((request) => request.configName));
  const duplicatePlacements: QueuePlacement[] = [];
  const plannedOwnerLoads = new Map<StructureSpawn, number>();
  for (const spawn of activeSpawns) {
    const baseQueueLength = (normalizedSnapshot.get(spawn) ?? [])
      .filter((configName) => !duplicateConfigNames.has(configName)).length;
    plannedOwnerLoads.set(spawn, baseQueueLength + (spawn.spawning ? 1 : 0));
  }

  ownershipRequests.sort((left, right) => {
    if (left.requestedIndex !== right.requestedIndex) {
      return left.requestedIndex - right.requestedIndex;
    }
    return left.configName.localeCompare(right.configName);
  });
  for (const [order, request] of ownershipRequests.entries()) {
    const earliestOwnerIndex = Math.min(...request.eligibleOwners.map((occurrence) => occurrence.index));
    const earliestOwners = request.eligibleOwners
      .filter((occurrence) => occurrence.index === earliestOwnerIndex)
      .map((occurrence) => occurrence.spawn);
    const target = activeSpawns.length > 0
      ? selectLeastLoadedSpawn(earliestOwners, plannedOwnerLoads)
      : [...earliestOwners].sort((left, right) => left.name.localeCompare(right.name))[0];
    const canonicalSource = [...request.occurrences].sort(compareOccurrence)[0];

    duplicatePlacements.push({
      configName: request.configName,
      target,
      requestedIndex: request.requestedIndex,
      sourceSpawnName: canonicalSource.spawn.name,
      order,
    });
    if (activeSpawns.length > 0) {
      plannedOwnerLoads.set(target, (plannedOwnerLoads.get(target) ?? 0) + 1);
    }
  }

  const migrationPlacements: QueuePlacement[] = [];
  if (activeSpawns.length > 0) {
    migrations.sort((left, right) => {
      const occurrenceDiff = compareOccurrence(left.source, right.source);
      return occurrenceDiff !== 0
        ? occurrenceDiff
        : left.configName.localeCompare(right.configName);
    });

    // duplicate placements already contribute to plannedOwnerLoads. Reuse that
    // projection so migration targets can be chosen without publishing a half
    // normalized queue generation.
    const plannedMigrationLoads = new Map(plannedOwnerLoads);
    for (const [migrationOrder, migration] of migrations.entries()) {
      const target = selectLeastLoadedSpawn(activeSpawns, plannedMigrationLoads);
      migrationPlacements.push({
        configName: migration.configName,
        target,
        requestedIndex: migration.source.index,
        sourceSpawnName: migration.source.spawn.name,
        order: duplicatePlacements.length + migrationOrder,
      });
      plannedMigrationLoads.set(target, (plannedMigrationLoads.get(target) ?? 0) + 1);
    }
  }

  const removedConfigNames = new Set([
    ...duplicateConfigNames,
    ...migrations.map((migration) => migration.configName),
  ]);
  const placements = [...duplicatePlacements, ...migrationPlacements];
  if (placements.length > 0) {
    rebuildQueues(sortedSpawns, normalizedSnapshot, removedConfigNames, placements);
  }
}
