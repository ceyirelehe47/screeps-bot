import {
  POWER_BANK_BODY_TIERS,
  POWER_BANK_BOOST_REQUIREMENTS,
} from "@/runtime/powerBankConstants";

export const ATTACK_POWER = 30;
export const HEAL_POWER = 12;
export const CREEP_SPAWN_TIME = 3;
export const POWER_BANK_HIT_BACK = 0.5;
export const POWER_BANK_ROOM_TRAVEL_TICKS = 50;
export const POWER_BANK_ATTACKER_COUNT = 1;
/** 给协同、绕行及攻击空档留余量；不能预设第二支战斗队接班才能完成。 */
export const POWER_BANK_COMBAT_TTL_MARGIN = 100;

const TOUGH_HITS = 100;
const DEFAULT_BOOST_PREP_TIME = 20;
const DEFAULT_RENEWAL_TIME = 50;
const DROPPED_POWER_DECAY_TICKS = 1000;

type BoostEffect = {
  attack?: number;
  heal?: number;
  damage?: number;
};

type BoostTable = Partial<
  Record<BodyPartConstant, Partial<Record<ResourceConstant, BoostEffect>>>
>;

function getBoostEffect(
  part: BodyPartConstant,
  compound: ResourceConstant,
): BoostEffect | undefined {
  return (BOOSTS as unknown as BoostTable)[part]?.[compound];
}

function getBoostMultiplier(
  part: BodyPartConstant,
  compound: ResourceConstant,
  effect: keyof BoostEffect,
  fallback: number,
): number {
  const multiplier = getBoostEffect(part, compound)?.[effect];
  return typeof multiplier === "number" ? multiplier : fallback;
}

// Kept as public compatibility constants; tier profiles below derive their
// actual effects from POWER_BANK_BOOST_REQUIREMENTS and BOOSTS.
export const BOOST_ATTACK_MULTIPLIER = getBoostMultiplier(
  ATTACK,
  RESOURCE_CATALYZED_UTRIUM_ACID,
  "attack",
  4,
);
export const BOOST_HEAL_MULTIPLIER = getBoostMultiplier(
  HEAL,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  "heal",
  4,
);
export const BOOST_TOUGH_DAMAGE_FACTOR = getBoostMultiplier(
  TOUGH,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  "damage",
  0.3,
);

export type PowerBankTier = 6 | 7 | 8;
export type TierKind = "rcl6" | "rcl7" | "rcl8";
export type PowerBankSquadRole = "attacker" | "healer";

export interface DerivedBoostRequirement {
  role: PowerBankSquadRole;
  compound: ResourceConstant;
  part: BodyPartConstant;
  partCount: number;
  amount: number;
}

export interface PowerBankRoleProfile {
  body: readonly BodyPartConstant[];
  cost: number;
  spawnTime: number;
  toughParts: number;
  attackParts: number;
  healParts: number;
  boostRequirements: readonly DerivedBoostRequirement[];
}

export interface PowerBankTierProfile {
  tier: PowerBankTier;
  attacker: PowerBankRoleProfile;
  healer: PowerBankRoleProfile;
  requiredCompounds: ReadonlyMap<ResourceConstant, number>;
  dpsPerAttacker: number;
  healerHPS: number;
  toughDamageFactor: number;
}

function countBodyPart(body: readonly BodyPartConstant[], part: BodyPartConstant): number {
  return body.reduce((count, current) => count + (current === part ? 1 : 0), 0);
}

function bodyCost(body: readonly BodyPartConstant[]): number {
  return body.reduce((cost, part) => cost + BODYPART_COST[part], 0);
}

function findBoostedPart(
  body: readonly BodyPartConstant[],
  compound: ResourceConstant,
): BodyPartConstant | null {
  for (const part of new Set(body)) {
    if (getBoostEffect(part, compound)) return part;
  }
  return null;
}

function deriveRoleProfile(
  role: PowerBankSquadRole,
  body: readonly BodyPartConstant[],
  compounds: readonly ResourceConstant[],
): PowerBankRoleProfile {
  const boostRequirements: DerivedBoostRequirement[] = [];

  for (const compound of compounds) {
    const part = findBoostedPart(body, compound);
    if (!part) continue;
    const partCount = countBodyPart(body, part);
    if (partCount <= 0) continue;
    boostRequirements.push({
      role,
      compound,
      part,
      partCount,
      amount: partCount * LAB_BOOST_MINERAL,
    });
  }

  return {
    body,
    cost: bodyCost(body),
    spawnTime: body.length * CREEP_SPAWN_TIME,
    toughParts: countBodyPart(body, TOUGH),
    attackParts: countBodyPart(body, ATTACK),
    healParts: countBodyPart(body, HEAL),
    boostRequirements,
  };
}

function getRoleBoostMultiplier(
  profile: PowerBankRoleProfile,
  part: BodyPartConstant,
  effect: keyof BoostEffect,
  defaultValue: number,
): number {
  const multipliers = profile.boostRequirements
    .filter((requirement) => requirement.part === part)
    .map((requirement) => getBoostEffect(part, requirement.compound)?.[effect])
    .filter((value): value is number => typeof value === "number");
  if (multipliers.length === 0) return defaultValue;
  return effect === "damage" ? Math.min(...multipliers) : Math.max(...multipliers);
}

/** Derive the combat profile from the exact bodies and boost requirements used at runtime. */
export function derivePowerBankTierProfile(tier: number): PowerBankTierProfile | null {
  if (tier !== 6 && tier !== 7 && tier !== 8) return null;

  const bodies = POWER_BANK_BODY_TIERS[tier];
  const requirements = POWER_BANK_BOOST_REQUIREMENTS[tier];
  if (!bodies || !requirements) return null;

  const attacker = deriveRoleProfile("attacker", bodies.attacker, requirements.attacker);
  const healer = deriveRoleProfile("healer", bodies.healer, requirements.healer);
  const allBoostRequirements = [
    ...attacker.boostRequirements,
    ...healer.boostRequirements,
  ];
  const requiredCompounds = new Map<ResourceConstant, number>();
  for (const requirement of allBoostRequirements) {
    requiredCompounds.set(
      requirement.compound,
      (requiredCompounds.get(requirement.compound) ?? 0) + requirement.amount,
    );
  }

  const attackMultiplier = getRoleBoostMultiplier(attacker, ATTACK, "attack", 1);
  const healMultiplier = getRoleBoostMultiplier(healer, HEAL, "heal", 1);
  const toughDamageFactor = getRoleBoostMultiplier(attacker, TOUGH, "damage", 1);

  return {
    tier,
    attacker,
    healer,
    requiredCompounds,
    dpsPerAttacker: computeBoostedDPS(attacker.attackParts, attackMultiplier),
    healerHPS: computeHealerHPS(healer.healParts, healMultiplier),
    toughDamageFactor,
  };
}

const TIER_ORDER: Array<{ kind: TierKind; tier: PowerBankTier }> = [
  { kind: "rcl8", tier: 8 },
  { kind: "rcl7", tier: 7 },
  { kind: "rcl6", tier: 6 },
];

export function selectBodyTier(
  energyCapacity: number,
): { attackerTier: TierKind; healerTier: TierKind } | null {
  for (const candidate of TIER_ORDER) {
    const profile = derivePowerBankTierProfile(candidate.tier);
    if (
      profile &&
      energyCapacity >= profile.attacker.cost &&
      energyCapacity >= profile.healer.cost
    ) {
      return { attackerTier: candidate.kind, healerTier: candidate.kind };
    }
  }
  return null;
}

function tierKindToNumber(tier: TierKind): PowerBankTier {
  return Number(tier.slice(3)) as PowerBankTier;
}

export function computeBoostedDPS(attackCount: number, boostMultiplier: number): number {
  return attackCount * ATTACK_POWER * boostMultiplier;
}

export function computeHealerHPS(healCount: number, boostMultiplier: number): number {
  return healCount * HEAL_POWER * boostMultiplier;
}

export function computeHitbackDPS(dps: number): number {
  return dps * POWER_BANK_HIT_BACK;
}

export function computeTOUGHSustainability(
  toughCount: number,
  toughBoostReduction: number,
  hitbackDPS: number,
  healerHPS: number,
  estimatedTTK = 5000,
): { ticksUntilTOUGHBreaks: number; sustainable: boolean } {
  const toughTotalHP = toughCount * TOUGH_HITS;
  const effectiveDPSPerTick = Math.max(0, hitbackDPS * toughBoostReduction - healerHPS);

  const ticksUntilTOUGHBreaks =
    effectiveDPSPerTick > 0 ? toughTotalHP / effectiveDPSPerTick : Infinity;

  return {
    ticksUntilTOUGHBreaks,
    sustainable: ticksUntilTOUGHBreaks > estimatedTTK,
  };
}

/**
 * `freeTiles` is only a capacity limit. It must not implicitly create attackers;
 * callers must opt into more than the currently planned single attacker.
 */
export function computeTimeToKill(
  bankHits: number,
  dpsPerAttacker: number,
  freeTiles: number,
  attackerCount = POWER_BANK_ATTACKER_COUNT,
): number {
  const activeAttackers = Math.min(
    Math.max(0, Math.floor(freeTiles)),
    Math.max(0, Math.floor(attackerCount)),
  );
  if (activeAttackers === 0 || dpsPerAttacker <= 0) return Infinity;
  return Math.ceil(bankHits / (dpsPerAttacker * activeAttackers));
}

export function computeHaulerCount(power: number, haulerCapacity: number): number {
  if (power <= 0) return 0;
  if (haulerCapacity <= 0) return Infinity;
  return Math.ceil(power / haulerCapacity);
}

export function computeHaulerDepartureTick(
  ttk: number,
  haulTravelTime: number,
  currentTick: number,
  haulerBatchSpawnTime = 0,
): number {
  if (!Number.isFinite(ttk) || !Number.isFinite(haulerBatchSpawnTime)) return Infinity;
  return currentTick + Math.max(0, ttk - haulTravelTime - haulerBatchSpawnTime);
}

function computeHaulerSpawnTime(haulerCapacity: number): number {
  const carryParts = Math.max(1, Math.ceil(haulerCapacity / CARRY_CAPACITY));
  return carryParts * 2 * CREEP_SPAWN_TIME;
}

export function computeHaulerBatchSpawnTime(
  haulerCount: number,
  haulerCapacity: number,
  spawnCount: number,
): number {
  if (haulerCount === 0) return 0;
  if (!Number.isFinite(haulerCount) || spawnCount <= 0) return Infinity;
  const batches = Math.ceil(haulerCount / Math.floor(spawnCount));
  return batches * computeHaulerSpawnTime(haulerCapacity);
}

/** Earliest tick offset at which both attacker and healer have finished spawning. */
export function computeCombatPairSpawnTime(
  attackerSpawnTime: number,
  healerSpawnTime: number,
  spawnReadyIn: readonly number[],
): number {
  if (spawnReadyIn.length === 0) return Infinity;

  const ready = spawnReadyIn.map((ticks) => Math.max(0, ticks));
  let earliestCompletion = Infinity;
  for (let attackerSpawn = 0; attackerSpawn < ready.length; attackerSpawn += 1) {
    for (let healerSpawn = 0; healerSpawn < ready.length; healerSpawn += 1) {
      const completion =
        attackerSpawn === healerSpawn
          ? ready[attackerSpawn] + attackerSpawnTime + healerSpawnTime
          : Math.max(
              ready[attackerSpawn] + attackerSpawnTime,
              ready[healerSpawn] + healerSpawnTime,
            );
      earliestCompletion = Math.min(earliestCompletion, completion);
    }
  }
  return earliestCompletion;
}

function resolveSpawnReadyIn(params: {
  spawnCount?: number;
  spawnQueueTicks?: number;
  spawnReadyIn?: readonly number[];
}): number[] {
  if (params.spawnReadyIn) {
    return params.spawnReadyIn.map((ticks) => Math.max(0, ticks));
  }
  const spawnCount = Math.max(0, Math.floor(params.spawnCount ?? 1));
  return Array.from(
    { length: spawnCount },
    () => Math.max(0, params.spawnQueueTicks ?? 0),
  );
}

export interface PowerBankTimelineInput {
  profile: PowerBankTierProfile;
  currentTick: number;
  bankHits: number;
  bankPower: number;
  freeTiles: number;
  routeDistance: number;
  /** 完整寻路所得时间；旧任务缺项时仍按房间跳数估算。 */
  combatTravelTicks?: number;
  haulerOutboundTravelTicks?: number;
  /** 满载返回来源房接收结构的名义时间，不适用于备用接收房。 */
  haulerReturnTravelTicks?: number;
  haulerCapacity: number;
  attackerCount?: number;
  spawnCount?: number;
  /** Common fallback queue delay when per-Spawn readiness is unavailable. */
  spawnQueueTicks?: number;
  /** Per-Spawn ticks until it can start a PowerBank creep. */
  spawnReadyIn?: readonly number[];
  renewalTime?: number;
  boostPrepTime?: number;
}

export interface PowerBankTimelinePlan {
  attackerCount: number;
  spawnCount: number;
  pairSpawnTime: number;
  renewalTime: number;
  boostPrepTime: number;
  travelTime: number;
  haulerOutboundTravelTime: number;
  haulerReturnTravelTime: number;
  ttk: number;
  combatReadyTick: number;
  combatArrivalTick: number;
  killTick: number;
  haulerCount: number;
  haulerBatchSpawnTime: number;
  haulerSpawnStartTick: number;
  haulerArrivalTick: number;
  timeBudget: number;
}

/**
 * Pure, side-effect-free squad timeline. Haulers cannot be requested before the
 * squad reaches ATTACKING, so very short fights correctly expose a late arrival.
 */
export function planPowerBankTimeline(
  params: PowerBankTimelineInput,
): PowerBankTimelinePlan {
  const spawnReadyIn = resolveSpawnReadyIn(params);
  const spawnCount = spawnReadyIn.length;
  const attackerCount = Math.max(
    0,
    Math.floor(params.attackerCount ?? POWER_BANK_ATTACKER_COUNT),
  );
  const pairSpawnTime = computeCombatPairSpawnTime(
    params.profile.attacker.spawnTime,
    params.profile.healer.spawnTime,
    spawnReadyIn,
  );
  const renewalTime = Math.max(0, params.renewalTime ?? DEFAULT_RENEWAL_TIME);
  const boostPrepTime = Math.max(0, params.boostPrepTime ?? DEFAULT_BOOST_PREP_TIME);
  const legacyTravelTime = Math.max(0, params.routeDistance) * POWER_BANK_ROOM_TRAVEL_TICKS;
  const measuredTravel = (value: number | undefined): number => value === undefined
    ? legacyTravelTime
    : Number.isFinite(value) && value >= 0 ? Math.ceil(value) : Infinity;
  const travelTime = measuredTravel(params.combatTravelTicks);
  const haulerOutboundTravelTime = measuredTravel(params.haulerOutboundTravelTicks);
  const haulerReturnTravelTime = measuredTravel(params.haulerReturnTravelTicks);
  const ttk = computeTimeToKill(
    params.bankHits,
    params.profile.dpsPerAttacker,
    params.freeTiles,
    attackerCount,
  );

  const combatReadyTick = params.currentTick + pairSpawnTime + renewalTime + boostPrepTime;
  const combatArrivalTick = combatReadyTick + travelTime;
  const killTick = combatArrivalTick + ttk;
  const haulerCount = computeHaulerCount(params.bankPower, params.haulerCapacity);
  const haulerBatchSpawnTime = computeHaulerBatchSpawnTime(
    haulerCount,
    params.haulerCapacity,
    spawnCount,
  );
  const idealHaulerSpawnStart = computeHaulerDepartureTick(
    killTick - params.currentTick,
    haulerOutboundTravelTime,
    params.currentTick,
    haulerBatchSpawnTime,
  );
  const haulerSpawnStartTick = Math.max(combatArrivalTick, idealHaulerSpawnStart);
  const haulerArrivalTick = haulerSpawnStartTick + haulerBatchSpawnTime + haulerOutboundTravelTime;
  const timeBudget = Math.max(killTick, haulerArrivalTick) - params.currentTick;

  return {
    attackerCount,
    spawnCount,
    pairSpawnTime,
    renewalTime,
    boostPrepTime,
    travelTime,
    haulerOutboundTravelTime,
    haulerReturnTravelTime,
    ttk,
    combatReadyTick,
    combatArrivalTick,
    killTick,
    haulerCount,
    haulerBatchSpawnTime,
    haulerSpawnStartTick,
    haulerArrivalTick,
    timeBudget,
  };
}

export interface TimeEstimates {
  ttk: number;
  dps: number;
  hitbackDPS: number;
  healerHPS: number;
  timeBudget: number;
  haulerCount: number;
  haulDepartTick: number;
}

export interface ViabilityInput {
  energyCapacity: number;
  bankHits: number;
  bankPower: number;
  ticksToDecay: number;
  freeTiles: number;
  routeDistance: number;
  combatTravelTicks?: number;
  haulerOutboundTravelTicks?: number;
  haulerReturnTravelTicks?: number;
  currentTick: number;
  hasCompounds: { xgho2: boolean; xuh2o: boolean; xlho2: boolean };
  isDefenseMode: boolean;
  haulerCapacity: number;
  spawnCount?: number;
  spawnQueueTicks?: number;
  spawnReadyIn?: readonly number[];
}

export interface ViabilityResult {
  viable: boolean;
  reasons: string[];
  estimates: TimeEstimates;
}

function hasCompound(
  available: ViabilityInput["hasCompounds"],
  compound: ResourceConstant,
): boolean {
  if (compound === RESOURCE_CATALYZED_GHODIUM_ALKALIDE) return available.xgho2;
  if (compound === RESOURCE_CATALYZED_UTRIUM_ACID) return available.xuh2o;
  if (compound === RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE) return available.xlho2;
  return false;
}

export function assessViability(params: ViabilityInput): ViabilityResult {
  const reasons: string[] = [];

  if (params.isDefenseMode) {
    reasons.push("defense_mode_active");
  }

  const selectedTier = selectBodyTier(params.energyCapacity);
  if (!selectedTier) {
    reasons.push("insufficient_energy_capacity");
  }

  const tier = selectedTier ? tierKindToNumber(selectedTier.attackerTier) : 6;
  const profile = derivePowerBankTierProfile(tier);
  if (!profile) {
    throw new Error(`Missing PowerBank tier profile for RCL ${tier}`);
  }

  const missingCompound = [...profile.requiredCompounds.keys()].some(
    (compound) => !hasCompound(params.hasCompounds, compound),
  );
  if (missingCompound) {
    reasons.push("insufficient_boost_compound");
  }

  if (params.freeTiles === 0) {
    reasons.push("no_free_adjacent_tiles");
  }

  const spawnReadyIn = resolveSpawnReadyIn(params);
  if (spawnReadyIn.length === 0) {
    reasons.push("no_active_spawn");
  }

  const dps = profile.dpsPerAttacker * POWER_BANK_ATTACKER_COUNT;
  const hitbackDPS = computeHitbackDPS(dps);
  const healerHPS = profile.healerHPS;
  const timeline = planPowerBankTimeline({
    profile,
    currentTick: params.currentTick,
    bankHits: params.bankHits,
    bankPower: params.bankPower,
    freeTiles: params.freeTiles,
    routeDistance: params.routeDistance,
    combatTravelTicks: params.combatTravelTicks,
    haulerOutboundTravelTicks: params.haulerOutboundTravelTicks,
    haulerReturnTravelTicks: params.haulerReturnTravelTicks,
    haulerCapacity: params.haulerCapacity,
    attackerCount: POWER_BANK_ATTACKER_COUNT,
    spawnCount: params.spawnCount,
    spawnQueueTicks: params.spawnQueueTicks,
    spawnReadyIn: params.spawnReadyIn,
  });

  if (!Number.isFinite(timeline.ttk)) {
    reasons.push("cannot_reach_bank");
  }
  if (
    !Number.isFinite(timeline.travelTime) ||
    !Number.isFinite(timeline.haulerOutboundTravelTime) ||
    !Number.isFinite(timeline.haulerReturnTravelTime)
  ) {
    reasons.push("invalid_travel_time");
  }
  const firstMemberReadyLowerBound = Math.min(...spawnReadyIn) + Math.min(profile.attacker.spawnTime, profile.healer.spawnTime);
  const memberAssemblyWait = Math.max(0, timeline.pairSpawnTime - firstMemberReadyLowerBound);
  if (memberAssemblyWait + timeline.travelTime + timeline.ttk + timeline.boostPrepTime + POWER_BANK_COMBAT_TTL_MARGIN >= CREEP_LIFE_TIME) {
    reasons.push("insufficient_combat_ttl");
  }
  if (
    timeline.haulerOutboundTravelTime + timeline.haulerReturnTravelTime + 50 >= CREEP_LIFE_TIME
  ) {
    reasons.push("insufficient_hauler_ttl");
  }

  if (selectedTier) {
    const sustainability = computeTOUGHSustainability(
      profile.attacker.toughParts,
      profile.toughDamageFactor,
      hitbackDPS,
      healerHPS,
      timeline.ttk,
    );
    if (!sustainability.sustainable) {
      reasons.push("tough_layer_unsustainable");
    }
  }

  const bankDespawnTick = params.currentTick + params.ticksToDecay;
  if (Number.isFinite(timeline.killTick) && timeline.killTick > bankDespawnTick) {
    reasons.push("decay_too_soon");
  }
  if (
    Number.isFinite(timeline.haulerArrivalTick) &&
    Number.isFinite(timeline.killTick) &&
    timeline.haulerArrivalTick > timeline.killTick + DROPPED_POWER_DECAY_TICKS
  ) {
    reasons.push("insufficient_hauler_timing");
  }

  return {
    viable: reasons.length === 0,
    reasons,
    estimates: {
      ttk: timeline.ttk,
      dps,
      hitbackDPS,
      healerHPS,
      timeBudget: timeline.timeBudget,
      haulerCount: timeline.haulerCount,
      haulDepartTick: timeline.haulerSpawnStartTick,
    },
  };
}
