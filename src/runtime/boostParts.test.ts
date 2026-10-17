import { countBoostableParts } from "@/runtime/boostParts";

it.each([
  [WORK, RESOURCE_CATALYZED_GHODIUM_ACID], [TOUGH, RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
  [ATTACK, RESOURCE_CATALYZED_UTRIUM_ACID], [HEAL, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE],
  [MOVE, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE],
] as const)("需求与执行只统计未强化且存活的 %s 部件", (type, compound) => {
  const body = [
    { type, hits: 100 }, { type, hits: 100, boost: compound },
    { type, hits: 100, boost: RESOURCE_UTRIUM_HYDRIDE }, { type, hits: 0 }, { type: CARRY, hits: 100 },
  ] as BodyPartDefinition[];
  expect(countBoostableParts(body, compound)).toBe(1);
});
