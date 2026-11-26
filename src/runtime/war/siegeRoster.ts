import type { WarTask } from "./store";

export const SIEGE_SLOTS = ["breacher", "escort", "escort", "escort", "breacher", "escort", "escort", "escort"] as const;
export type SiegeJob = typeof SIEGE_SLOTS[number];

const armor = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
const mobility = RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE;
const ranged = RESOURCE_CATALYZED_KEANIUM_ALKALIDE;
const demolition = RESOURCE_CATALYZED_ZYNTHIUM_ACID;
const medicine = RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE;
export const SIEGE_BOOSTS = {
  breacher: [mobility, armor, ranged, demolition],
  escort: [mobility, armor, ranged, medicine],
};

const parts = (type: BodyPartConstant, count: number) => Array<BodyPartConstant>(count).fill(type);
export const SIEGE_BODIES = {
  breacher: [...parts(TOUGH, 12), ...parts(WORK, 24), ...parts(RANGED_ATTACK, 4), ...parts(MOVE, 10)],
  escort: [...parts(TOUGH, 13), ...parts(RANGED_ATTACK, 12), ...parts(HEAL, 15), ...parts(MOVE, 10)],
};

export function siegeConfigName(task: Pick<WarTask, "sourceRoom" | "targetRoom">, index: number): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:siegeUnit:${index}`;
}
