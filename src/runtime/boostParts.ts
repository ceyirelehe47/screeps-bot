/** 准备需求与实际执行共用：已带任何强化或损坏的部件都不能再次 boost。 */
const BOOST_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [RESOURCE_CATALYZED_GHODIUM_ACID]: WORK,
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: TOUGH,
  [RESOURCE_CATALYZED_UTRIUM_ACID]: ATTACK,
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: HEAL,
  [RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE]: MOVE,
};

export function getBoostPartType(compound: ResourceConstant): BodyPartConstant | undefined {
  return BOOST_PARTS[compound];
}

export function countBoostableParts(body: readonly BodyPartDefinition[], compound: ResourceConstant): number {
  const type = getBoostPartType(compound);
  return type ? body.filter(part => part.type === type && part.hits > 0 && !part.boost).length : 0;
}
