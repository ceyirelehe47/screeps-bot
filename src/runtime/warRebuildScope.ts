/** 已登记的旧被动建筑不再是补剿目标；生产/防御设施仍须清除。 */
export function isRebuildStructureRelevant(structure: Structure, ignoredIds?: readonly string[]): boolean {
  return !ignoredIds?.includes(structure.id) || [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_INVADER_CORE]
    .some(type => structure.structureType === type);
}

export function getCreepRebuildIgnoredStructures(creep: Creep): readonly string[] | undefined {
  const task = Memory.data?.war?.[creep.room.name];
  return task && creep.memory.configName?.startsWith(`${task.sourceRoom}:war:${task.targetRoom}:`)
    ? task.rebuildIgnoreStructureIds : undefined;
}

/** 共享巡逻与清场判据一致：中性墙只可作为实际目标的必要破障。 */
export function canUseNeutralWallsAsWarObjectives(creep: Creep): boolean {
  const task = Memory.data?.war?.[creep.room.name];
  return !task?.sharedSquadWatchId
    || !creep.memory.configName?.startsWith(`${task.sourceRoom}:war:${task.targetRoom}:`);
}
