export interface BoostLabAssignment {
  labId: string;
  compound: ResourceConstant;
}

export interface BoostPrepMemory {
  labs: Record<string, BoostLabAssignment>;
  taskId: string;
  sourceRoomName: string;
}

export function ensurePowerBankBoostPrepStore(): Record<string, BoostPrepMemory> {
  const runtime = Memory.runtime;
  if (!runtime) return {};
  runtime.powerBankBoost = runtime.powerBankBoost || {};
  return runtime.powerBankBoost;
}

export function getPowerBankBoostPrep(taskId: string): BoostPrepMemory | undefined {
  const store = ensurePowerBankBoostPrepStore();
  return store[taskId];
}

export function getActivePowerBankBoostLabIds(sourceRoomName: string, excludeTaskId?: string): Set<string> {
  const store = ensurePowerBankBoostPrepStore();
  const labIds = new Set<string>();
  const defenseLab = Memory.cfg?.homeDefense?.rooms?.[sourceRoomName]?.boostLabId;
  if (defenseLab) labIds.add(defenseLab);
  for (const prep of Object.values(store)) {
    if (prep.sourceRoomName !== sourceRoomName) continue;
    if (excludeTaskId && prep.taskId === excludeTaskId) continue;
    for (const assignment of Object.values(prep.labs)) {
      labIds.add(assignment.labId);
    }
  }
  return labIds;
}

export function getAssignedPowerBankBoostLabId(
  taskId: string,
  compound: ResourceConstant,
): string | undefined {
  const prep = getPowerBankBoostPrep(taskId);
  if (!prep) return undefined;
  for (const assignment of Object.values(prep.labs)) {
    if (assignment.compound === compound) return assignment.labId;
  }
  return undefined;
}

export function cleanupPowerBankBoostMemory(activeTaskIds: ReadonlySet<string>): number {
  const runtime = Memory.runtime;
  if (!runtime) {
    return 0;
  }

  let removed = 0;

  if (runtime.powerBankBoost) {
    for (const taskId of Object.keys(runtime.powerBankBoost)) {
      if (activeTaskIds.has(taskId)) {
        continue;
      }
      delete runtime.powerBankBoost[taskId];
      removed += 1;
    }

    if (Object.keys(runtime.powerBankBoost).length === 0) {
      delete runtime.powerBankBoost;
    }
  }

  return removed;
}
