export function doesCreepBodyMatch(
  creep: Creep,
  expectedBody: readonly BodyPartConstant[],
): boolean {
  return Array.isArray(creep.body) &&
    creep.body.length === expectedBody.length &&
    creep.body.every((part, index) => part.type === expectedBody[index]);
}

export function hasMatchingCreepBody(
  creeps: readonly Creep[],
  expectedBody: readonly BodyPartConstant[],
): boolean {
  return creeps.some((creep) => doesCreepBodyMatch(creep, expectedBody));
}

function isCreepInRangeTo(creep: Creep, target: RoomObject): boolean {
  return !!creep.pos && typeof creep.pos.inRangeTo === "function" && creep.pos.inRangeTo(target, 1);
}

/** 只计算交接候选；退役 intent 由任务 owner 提交。出生中或尚未到岗的替补不能触发交接。 */
export function getHandoffRetirements(
  incumbents: readonly Creep[],
  replacements: readonly Creep[],
  source: Source,
): readonly Creep[] {
  const atSource = incumbents.filter(creep => !creep.spawning && isCreepInRangeTo(creep, source));
  const ready = replacements.some(creep => !creep.spawning && (
    isCreepInRangeTo(creep, source) || atSource.some(incumbent => isCreepInRangeTo(creep, incumbent))
  ));
  return ready ? incumbents : [];
}

export function getMismatchedMinerRetirements(
  creeps: readonly Creep[],
  source: Source,
  expectedBody: readonly BodyPartConstant[],
): readonly Creep[] {
  return getHandoffRetirements(
    creeps.filter(creep => !doesCreepBodyMatch(creep, expectedBody)),
    creeps.filter(creep => doesCreepBodyMatch(creep, expectedBody)),
    source,
  );
}
