/** Deposit 冷却使用官方累计产量模型；lastCooldown 只能反推累计量上界。 */
export const DEPOSIT_BODY: readonly BodyPartConstant[] = Object.freeze([
  ...Array<BodyPartConstant>(10).fill(WORK),
  ...Array<BodyPartConstant>(10).fill(CARRY),
  ...Array<BodyPartConstant>(20).fill(MOVE),
]);
export const DEPOSIT_RETURN_BUFFER = 50;

export interface DepositEconomicsInput {
  lastCooldown: number;
  cooldown: number;
  workParts: number;
  capacity: number;
  harvestBudget: number;
  maxCooldown: number;
}

export interface DepositEconomicsEstimate {
  expectedAmount: number;
  harvestTicks: number;
  nextCooldown: number;
}

function constants(): { multiply: number; power: number; harvestPower: number } {
  // 测试/旧运行时缺全局常量时沿用官方常量；不从 lastCooldown 推断增长系数。
  return {
    multiply: typeof DEPOSIT_EXHAUST_MULTIPLY === "number" ? DEPOSIT_EXHAUST_MULTIPLY : 0.001,
    power: typeof DEPOSIT_EXHAUST_POW === "number" ? DEPOSIT_EXHAUST_POW : 1.2,
    harvestPower: typeof HARVEST_DEPOSIT_POWER === "number" ? HARVEST_DEPOSIT_POWER : 1,
  };
}

export function predictDepositHarvest(input: DepositEconomicsInput): DepositEconomicsEstimate {
  const invalid = { expectedAmount: 0, harvestTicks: 0, nextCooldown: Infinity };
  if (![input.lastCooldown, input.cooldown, input.workParts, input.capacity, input.harvestBudget, input.maxCooldown]
    .every((v) => Number.isSafeInteger(v) && v >= 0) || input.workParts === 0 || input.workParts > 50 ||
    input.harvestBudget > CREEP_LIFE_TIME || input.capacity > 2_500) return invalid;
  const { multiply, power, harvestPower } = constants();
  if (![multiply, power, harvestPower].every((v) => Number.isFinite(v) && v > 0)) return invalid;
  // floor/ceil 边界均用 +1 保守覆盖，禁止把 lastCooldown 当成后续恒定冷却。
  const totalUpper = Math.pow((input.lastCooldown + 1) / multiply, 1 / power);
  const perHarvest = input.workParts * harvestPower;
  let expectedAmount = 0;
  let harvestTicks = 0;
  let wait = input.cooldown;
  let nextCooldown = input.lastCooldown;
  while (expectedAmount < input.capacity) {
    const amount = Math.min(perHarvest, input.capacity - expectedAmount);
    const futureCooldown = Math.ceil(multiply * Math.pow(totalUpper + expectedAmount + amount, power)) + 1;
    if (futureCooldown > input.maxCooldown || harvestTicks + wait + 1 > input.harvestBudget) break;
    harvestTicks += wait + 1;
    expectedAmount += amount;
    nextCooldown = futureCooldown;
    wait = futureCooldown;
  }
  return { expectedAmount, harvestTicks, nextCooldown };
}

export interface DepositViabilityInput extends Omit<DepositEconomicsInput, "harvestBudget"> {
  currentTick: number;
  expiresAt: number;
  queueDelay: number;
  spawnTime: number;
  outboundTravelTicks: number;
  returnTravelTicks: number;
  bornTtl: number;
  bodyEnergy: number;
  minExpectedAmount: number;
  minUnitsPerEnergy: number;
}

export function assessDepositViability(input: DepositViabilityInput): DepositEconomicsEstimate & {
  viable: boolean; reasons: string[]; unitsPerEnergy: number;
} {
  const reasons: string[] = [];
  const times = [input.currentTick, input.expiresAt, input.queueDelay, input.spawnTime,
    input.outboundTravelTicks, input.returnTravelTicks, input.bornTtl];
  if (!times.every((v) => Number.isSafeInteger(v) && v >= 0) || !Number.isFinite(input.bodyEnergy) ||
    input.bodyEnergy <= 0 || !Number.isFinite(input.minUnitsPerEnergy) || input.minUnitsPerEnergy < 0 ||
    !Number.isSafeInteger(input.minExpectedAmount) || input.minExpectedAmount < 1) reasons.push("invalid_economics");
  // 出生前等待只影响 Deposit 到期；不能再从出生后的 creep TTL 扣一次。
  const decayBudget = input.expiresAt - input.currentTick - input.queueDelay - input.spawnTime - input.outboundTravelTicks - 1;
  const lifeBudget = input.bornTtl - input.outboundTravelTicks - input.returnTravelTicks - DEPOSIT_RETURN_BUFFER - 1;
  const harvestBudget = Math.max(0, Math.min(CREEP_LIFE_TIME, Math.floor(decayBudget), Math.floor(lifeBudget)));
  const estimate = predictDepositHarvest({ ...input, harvestBudget });
  const unitsPerEnergy = estimate.expectedAmount / input.bodyEnergy;
  if (decayBudget <= 0) reasons.push("deposit_expires_before_harvest");
  if (lifeBudget <= 0) reasons.push("insufficient_return_ttl");
  if (input.lastCooldown > input.maxCooldown) reasons.push("cooldown_too_high");
  if (estimate.expectedAmount < input.minExpectedAmount) reasons.push("insufficient_expected_amount");
  if (unitsPerEnergy < input.minUnitsPerEnergy) reasons.push("insufficient_units_per_energy");
  return { ...estimate, unitsPerEnergy, viable: reasons.length === 0, reasons };
}
