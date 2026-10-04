import { damageAfterTough, effectivePower, predictPowerBankFinishTicks, predictPowerBankRecovery, powerBankAttackSustainable } from "@/runtime/powerBankCapability";
import { createMockPowerBankCreep } from "@mock/powerBank";
import { POWER_BANK_BODY_TIERS } from "@/runtime/powerBankConstants";

function pair() {
  const attacker = createMockPowerBankCreep("powerBankAttacker", { body: POWER_BANK_BODY_TIERS[8].attacker.map(type => ({ type, hits: 100,
    boost: type === TOUGH ? RESOURCE_CATALYZED_GHODIUM_ALKALIDE : type === ATTACK ? RESOURCE_CATALYZED_UTRIUM_ACID : undefined })) });
  const healer = createMockPowerBankCreep("powerBankHealer");
  return { attacker, healer };
}

describe("PowerBank 当前能力与暂停恢复", () => {
  it("uses actual boosts and live front armor capacity, including partial TOUGH", () => {
    const { attacker, healer } = pair();
    expect(effectivePower(attacker.body, ATTACK)).toBe(1920);
    expect(damageAfterTough(attacker.body, 960)).toBe(288);
    expect(powerBankAttackSustainable(attacker, healer)).toBe(true);
    attacker.body.filter(p => p.type === TOUGH).forEach(p => { p.hits = 0; });
    expect(damageAfterTough(attacker.body, 960)).toBe(960);
    expect(powerBankAttackSustainable(attacker, healer)).toBe(false);
    expect(damageAfterTough([{ type: TOUGH, hits: 10, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE }], 100)).toBe(77);
    expect(damageAfterTough([{ type: ATTACK, hits: 100 }, { type: TOUGH, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE }], 50)).toBe(50);
  });

  it("includes recovered HEAL time in completion instead of pretending to keep attacking", () => {
    const { attacker, healer } = pair();
    healer.body.slice(0, 19).forEach(p => { p.hits = 0; });
    healer.hits = 3100;
    const recovery = predictPowerBankRecovery(attacker, healer);
    // 72,84,96,108,120,132,156,168,192,216,240,264的12轮自疗恢复到4948HP。
    expect(recovery.ticks).toBe(12);
    expect(recovery.attack).toBe(1920);
    expect(predictPowerBankFinishTicks(100_000, attacker, healer)).toBe(recovery.ticks + 53);
    expect(healer.hits).toBe(3100);
    expect(effectivePower(healer.body, HEAL)).toBe(72);
  });

  it("fails closed for no live healing and rereads same-tick body changes", () => {
    const { attacker, healer } = pair();
    expect(predictPowerBankFinishTicks(100_000, attacker, healer)).toBe(53);
    healer.body.filter(p => p.type === HEAL).forEach(p => { p.hits = 0; });
    healer.hits = 2500;
    expect(predictPowerBankFinishTicks(100_000, attacker, healer)).toBe(Infinity);
  });

  it.each([[TOUGH, 1], [ATTACK, 7]] as const)("当前治疗者用%s损毁后的%s轮恢复保留主队", (lost, ticks) => {
    const { attacker, healer } = pair();
    const firstLiving = attacker.body.findIndex(part => part.type === (lost === TOUGH ? ATTACK : MOVE));
    attacker.body.slice(0, firstLiving).forEach(part => { part.hits = 0; });
    attacker.hits = attacker.body.reduce((sum, part) => sum + part.hits, 0);
    expect(predictPowerBankRecovery(attacker, healer)).toEqual({ ticks, attack: 1920 });
    expect(predictPowerBankFinishTicks(100_000, attacker, healer)).toBe(ticks + 53);
    expect(attacker.body.filter(part => part.type === TOUGH).every(part => part.hits === 0)).toBe(true);
  });
});
