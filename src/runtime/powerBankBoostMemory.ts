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
