import type { WarTask } from "./store";

const WING = ["breacher", "escort", "breacher", "escort"] as const;
const BATTERY = ["ranger", "escort", "ranger", "escort"] as const;
export const SIEGE_SLOTS = [...BATTERY, ...WING, ...BATTERY] as const;
export function siegeSlots(task: WarTask) {
  return SIEGE_SLOTS.slice(0, (task.siegeWingCount ?? 2) * WING.length);
}
export type SiegeJob = (typeof SIEGE_SLOTS)[number];

const armor = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
const mobility = RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE;
const ranged = RESOURCE_CATALYZED_KEANIUM_ALKALIDE;
const demolition = RESOURCE_CATALYZED_ZYNTHIUM_ACID;
const medicine = RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE;
export const SIEGE_BOOSTS = {
  ranger: [mobility, armor, ranged, demolition],
  breacher: [mobility, armor, ranged, demolition],
  escort: [mobility, armor, ranged, medicine],
};

const parts = (type: BodyPartConstant, count: number) => Array<BodyPartConstant>(count).fill(type);
export const SIEGE_BODIES = {
  ranger: [...parts(TOUGH, 18), WORK, ...parts(RANGED_ATTACK, 21), ...parts(MOVE, 10)],
  breacher: [...parts(TOUGH, 22), ...parts(WORK, 17), ...parts(RANGED_ATTACK, 1), ...parts(MOVE, 10)],
  escort: [...parts(TOUGH, 18), ...parts(RANGED_ATTACK, 1), ...parts(HEAL, 21), ...parts(MOVE, 10)],
};

export function siegeConfigName(task: Pick<WarTask, "sourceRoom" | "targetRoom">, index: number): string {
  return `${task.sourceRoom}:war:${task.targetRoom}:siegeUnit:${index}`;
}

/** 出生槽属于生产计划；战斗槽只发给实际到达集结点的士兵。途中损失可用同类到场者补足。 */
export function assembleSiegeWings(task: WarTask, units: Creep[], staging: string): void {
  const wings = (task.siegeWings ??= {});
  for (const unit of units) {
    if (unit.room.name === task.targetRoom && unit.memory._siegeSlot === undefined) {
      const prior = Number(unit.memory.roleArgs?.[5]);
      if (Number.isInteger(prior) && wings[Math.floor(prior / 4)]) unit.memory._siegeSlot = prior;
    }
  }
  const waiting = units
    .filter((c) => !c.spawning && c.memory.ready && c.memory._siegeSlot === undefined && c.room.name === staging)
    .sort((a, b) => (b.ticksToLive ?? 0) - (a.ticksToLive ?? 0));
  const drill = (c: Creep) => c.getActiveBodyparts(WORK) > 0;
  const assign = (unit: Creep, index: number) => {
    unit.memory._siegeSlot = index;
    waiting.splice(waiting.indexOf(unit), 1);
  };
  for (let wing = 0; wing < (task.siegeWingCount ?? 2); wing++) {
    const start = wing * 4;
    const live = units.filter((c) => c.memory._siegeSlot !== undefined && Math.floor(c.memory._siegeSlot / 4) === wing);
    if (wings[wing] && live.length) {
      for (let i = start; i < start + 4; i++) {
        if (live.some((c) => c.memory._siegeSlot === i)) continue;
        const replacement = waiting.find((c) => drill(c) === (SIEGE_SLOTS[i] !== "escort"));
        if (replacement) assign(replacement, i);
      }
      continue;
    }
    if (wings[wing]) {
      delete wings[wing];
      if (task.siegeAnchors) delete task.siegeAnchors[wing];
      if (task.siegeFormationOrder) delete task.siegeFormationOrder[wing];
      if (task.siegeBreach) delete task.siegeBreach[wing];
      if (task.siegeStrike) delete task.siegeStrike[wing];
      if (task.siegeFront) delete task.siegeFront[wing];
    }
    const drills = waiting.filter(drill),
      medics = waiting.filter((c) => !drill(c));
    if (waiting.length < 4 || !drills.length || medics.length < 2) continue;
    // 持续战争按两拆两医投入，避免先派三医导致另一翼只有一名治疗。
    if (task.oneShot === false && drills.length < 2) continue;
    const shortSince = (task.siegeShortSince ??= {});
    const drillEnRoute = units.some((c) => drill(c) && c.memory._siegeSlot === undefined && c.room.name !== staging);
    if (drills.length === 1 && drillEnRoute) {
      shortSince[wing] ??= Game.time;
      if (Game.time - shortSince[wing] < 100) continue;
    }
    delete shortSince[wing];
    const squad = [drills[0], medics[0], drills[1] ?? medics[2], medics[1]];
    if (!squad[2]) continue;
    squad.forEach((unit, i) => assign(unit, start + i));
    wings[wing] = true;
  }
}
