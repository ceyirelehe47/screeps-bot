import { volleysToBreakArmor } from "./towerControl";

function destroyer(): Creep {
  const body = [...Array.from({length:10}, () => ({type:TOUGH,hits:100,boost:RESOURCE_CATALYZED_GHODIUM_ALKALIDE})),
    ...Array.from({length:40}, () => ({type:ATTACK,hits:100}))];
  return {hits:5000,hitsMax:5000,body} as Creep;
}

it("可在敌治疗跟上后继续打穿前甲，同时跳过每 tick 已被充分预治疗的目标", () => {
  const target=destroyer();
  expect(volleysToBreakArmor(target,3200,0,1440)).toBeLessThanOrEqual(8);
  expect(volleysToBreakArmor(target,3200,1440,1440)).toBe(Infinity);
  expect(volleysToBreakArmor(target,1000,0,1440)).toBe(Infinity);
  expect(target.body[0].hits).toBe(100);
});
