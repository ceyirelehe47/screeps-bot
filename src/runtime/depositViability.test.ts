import { assessDepositViability, predictDepositHarvest } from "@/runtime/depositViability";

function input() {
  return { currentTick: 100, expiresAt: 10_000, queueDelay: 100, spawnTime: 120,
    outboundTravelTicks: 100, returnTravelTicks: 100, bornTtl: 1_500, bodyEnergy: 2_500,
    lastCooldown: 0, cooldown: 0, workParts: 10, capacity: 500, maxCooldown: 80,
    minExpectedAmount: 200, minUnitsPerEnergy: 0.08 };
}
describe("Deposit 保守冷却与出生时间预算", () => {
  it("增长后的冷却不能按 lastCooldown 恒定计算", () => {
    const result = predictDepositHarvest({ lastCooldown: 30, cooldown: 0, workParts: 10,
      capacity: 500, harvestBudget: 1_200, maxCooldown: 80 });
    expect(result.expectedAmount).toBeLessThan(400);
    expect(result.nextCooldown).toBeGreaterThan(30);
  });
  it("首次旅程量和能量效率均满足才投入", () => {
    const result = assessDepositViability(input());
    expect(result.viable).toBe(true);
    expect(result.expectedAmount).toBeGreaterThanOrEqual(200);
    expect(result.unitsPerEnergy).toBeGreaterThanOrEqual(0.08);
  });
  it("出生前排队影响Deposit期限但不从creepTTL重复扣除", () => {
    const baseline = assessDepositViability(input());
    const delayed = assessDepositViability({ ...input(), queueDelay: 900 });
    expect(delayed.expectedAmount).toBe(baseline.expectedAmount);
    expect(delayed.viable).toBe(true);
    expect(assessDepositViability({ ...input(), expiresAt: 500, queueDelay: 900 }).viable).toBe(false);
  });
  it("必须预留完整满载返回和动作余量", () => {
    const result = assessDepositViability({ ...input(), returnTravelTicks: 1_400 });
    expect(result.reasons).toContain("insufficient_return_ttl");
    expect(result.viable).toBe(false);
  });
  it("高冷却和不合法数值不会投产", () => {
    expect(assessDepositViability({ ...input(), lastCooldown: 81 }).viable).toBe(false);
    expect(assessDepositViability({ ...input(), outboundTravelTicks: NaN }).viable).toBe(false);
  });
});
