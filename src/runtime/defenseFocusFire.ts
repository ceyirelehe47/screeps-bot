/**
 * Defense Focus-Fire Coordination Sidecar——房间级协同集火规划器。
 *
 * 【协同缺陷背景】Tower 与主防 Creep 各自独立评分选目标导致伤害分裂，
 * 被敌方治疗分别抵消。本模块是纯函数 planner（不调用任何 Game 写 API）：
 * 每房间每 tick 由调用方（homeDefense）采集一次快照并生成唯一 engagement
 * plan；最终执行仍由 towerControl 与 homeDefender 的既有动作入口完成。
 *
 * 【Remediation II 预算修正】
 * A. 紧急治疗仲裁先行：emergencyHealByTowerId 先于攻击预算确定，治疗塔
 *    从攻击 actor 集合移除——目标选择/净伤害/击杀可行性只使用剩余真实
 *    攻击 actor（旧实现先按全部塔评分再扣治疗塔，目标选择使用了不存在
 *    的攻击火力）。
 * B/C. 击杀预算含敌方本 tick 治疗：killBudget = ceil((hits + incomingHeal)
 *    × KILL_OVERKILL_MARGIN)；只有 primary 累计**已分配**有效伤害达到预算
 *    后，后续 actor 才分火——负责跨越阈值的 actor 恒分配给 primary（旧
 *    实现在 focusAssigned + damage >= threshold 时把跨越者 spill，primary
 *    永远达不到阈值）。
 * D. 统一 TOUGH/boost 有效伤害模型：顺序伤害模拟（与 Screeps 引擎
 *    _applyDamage 同算法——伤害按 body 顺序消耗部件、boosted TOUGH 按
 *    damage ratio 折算吸收）对 Tower 与 Defender 输出一视同仁；Defender-
 *    only 且目标带 boosted TOUGH 时不再默认 ratio=1（旧实现只对塔伤害乘
 *    固定比例、防御者原始伤害直接相加）。
 * E. Secondary 按剩余 actor 重新计算：每次 spill 时用**尚未分配**的 actor
 *    集合对候选重新做顺序模拟评分（目标特定有效伤害/射程/TOUGH/敌方治
 *    疗全部重算）——不得用"全军火力表"完成 spill，也不得把已分配 actor
 *    再次计入 secondary 预算。
 * F. 不可击杀场景保持共享压制：没有 net>0 候选时仍产生确定性共享
 *    primary（killExpected=false 的 pressure 语义），Tower 与 Defender 消费
 *    同一目标，不因"敌方治疗暂时覆盖输出"回退独立评分。fallback 仅用于
 *    无 hostile / 无可参与 actor 的场景。
 * G. Planner 预算与执行层一致：防御者只计"本 tick 确实会发出的动作"的伤害
 *    （ATTACK：贴身才计，需要移动计 0；RANGED_ATTACK：仅纯远程防御者在
 *    ≤3 距离 rangedAttack 计入——执行层 homeDefender 按同一
 *    defenderEngagementMode 语义执行，共享判定单一语义源）。
 *
 * 确定性：候选/actor 全部按稳定 id（slot）字典序，评分平手以 id 决胜；
 * 同快照（任意来源顺序）产生同一 plan。
 */

import { getMemoryService } from "@/runtime/runtimeServices";

/** 保守击杀裕度：作用于含敌方本 tick 治疗的保守击杀预算。 */
export const FOCUS_FIRE_KILL_OVERKILL_MARGIN = 1.15;
/** 重伤阈值：hp 缺口达到 hitsMax 的该比例才允许占用塔紧急治疗。 */
export const FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO = 0.35;
/** 紧急治疗塔数上限：不超过攻击塔数量的一半（向上取整，至少 1）。 */
export const FOCUS_FIRE_EMERGENCY_HEAL_TOWER_CAP_RATIO = 0.5;
/** 主防 Creep 的远程攻击射程（RANGED_ATTACK）。 */
const DEFENDER_RANGED_RANGE = 3;
/** 主防 Creep 的近战攻击射程（ATTACK）。 */
const DEFENDER_MELEE_RANGE = 1;
/** Tower 一次攻击/治疗的能量成本（低于该值的塔不可参与）。 */
const TOWER_ACTION_ENERGY_COST = 10;

export interface FocusFireHostileSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 当前 hits。 */
  readonly hits: number;
  readonly hitsMax: number;
  /**
   * TOUGH/boost 顺序伤害模拟档案：身体部件按序 {hits, damageRatio}
   * （boosted TOUGH ratio<1，其余 1）——planner 与 Screeps 引擎
   * _applyDamage 同算法逐 actor 消耗，不再使用固定比例近似。
   */
  readonly toughProfile: ReadonlyArray<{ readonly hits: number; readonly ratio: number }>;
  /** 敌方 range-aware 治疗总量（同族 heal，含 boost；采集时一次算好）。 */
  readonly incomingHeal: number;
  /** 威胁权重（body 组成；采集时由既有 threat 语义计算）。 */
  readonly threat: number;
}

export interface FocusFireTowerSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 当前能量（低于 TOWER_ACTION_ENERGY_COST 的塔不参与攻击/治疗分配）。 */
  readonly energy: number;
}

export interface FocusFireDefenderSnapshot {
  readonly id: string;
  /** 防御者槽位（与 defenseCoordination 的 defenderAssignments 键一致）。 */
  readonly slot: string;
  readonly role: "primary" | "secondary";
  readonly x: number;
  readonly y: number;
  /** 近战单 tick 输出（getActiveBodyparts(ATTACK) × ATTACK_POWER，含 boost 由采集方计）。 */
  readonly meleeDamage: number;
  /** 远程单 tick 输出（getActiveBodyparts(RANGED_ATTACK) × RANGED_ATTACK_POWER，含 boost）。 */
  readonly rangedDamage: number;
}

export interface FocusFireWoundedSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly hits: number;
  readonly hitsMax: number;
}

export interface FocusFireRoomInput {
  readonly roomName: string;
  readonly hostiles: readonly FocusFireHostileSnapshot[];
  readonly towers: readonly FocusFireTowerSnapshot[];
  readonly defenders: readonly FocusFireDefenderSnapshot[];
  readonly wounded: readonly FocusFireWoundedSnapshot[];
}

export interface FocusFireEngagementPlan {
  readonly roomName: string;
  readonly plannedAtTick: number;
  /** 联合预算下的共享主目标（pressure 模式也非 null；null = 真正无 plan）。 */
  readonly focusTargetId: string | null;
  /** 主目标是否在联合预算内可击杀（false = 共享战略压制目标）。 */
  readonly killExpected: boolean;
  /** 主目标累计分配的联合**有效**伤害（顺序 TOUGH 模拟、仅实际分配 actor）。 */
  readonly focusAssignedDamage: number;
  /** 主目标的敌方治疗总量（预算对照）。 */
  readonly focusExpectedHeal: number;
  /** towerId → hostileId（过量伤害控制后的分火结果；治疗塔不出现）。 */
  readonly towerAssignments: Readonly<Record<string, string>>;
  /** 防御者 slot → hostileId。 */
  readonly defenderAssignments: Readonly<Record<string, string>>;
  /** towerId → 重伤 creep id（紧急治疗仲裁；这些塔不参与攻击）。 */
  readonly emergencyHealByTowerId: Readonly<Record<string, string>>;
  readonly fallbackReason?: "no-hostile" | "no-attack-actor";
}

function chebyshevRange(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

/** Tower 攻击距离衰减（与 towerControl.getTowerAttackPowerByRange 同式）。 */
function towerAttackPowerAtRange(range: number): number {
  if (range <= TOWER_OPTIMAL_RANGE) {
    return TOWER_POWER_ATTACK;
  }
  if (range >= TOWER_FALLOFF_RANGE) {
    return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF));
  }
  const falloffRange = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE;
  const beyondOptimal = range - TOWER_OPTIMAL_RANGE;
  return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF * (beyondOptimal / falloffRange)));
}

/** Tower 治疗距离衰减（与攻击同一衰减曲线）。 */
function towerHealPowerAtRange(range: number): number {
  if (range <= TOWER_OPTIMAL_RANGE) {
    return TOWER_POWER_HEAL;
  }
  if (range >= TOWER_FALLOFF_RANGE) {
    return Math.floor(TOWER_POWER_HEAL * (1 - TOWER_FALLOFF));
  }
  const falloffRange = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE;
  const beyondOptimal = range - TOWER_OPTIMAL_RANGE;
  return Math.floor(TOWER_POWER_HEAL * (1 - TOWER_FALLOFF * (beyondOptimal / falloffRange)));
}

// ── 顺序 TOUGH/boost 有效伤害模型（单一语义源，planner 内全部预算共用） ────

/** 可变模拟状态：部件按 body 顺序剩余 hits 与 damage ratio。 */
type ToughSimState = { hits: number; ratio: number }[];

function freshToughSimState(profile: ReadonlyArray<{ readonly hits: number; readonly ratio: number }>): ToughSimState {
  return profile.map((part) => ({ hits: part.hits, ratio: part.ratio }));
}

/**
 * 顺序伤害模拟（Screeps _applyDamage 同算法）：raw 伤害按部件顺序消耗，
 * boosted 部件（ratio<1）每吸收 1 点 raw 只扣 ratio 点 hits 并把
 * (1-ratio) 记为无效化。返回本次 raw 的**有效**伤害（浮点——汇总处再取整，
 * 与逐次调用聚合结果一致）。
 */
function applyRawDamage(state: ToughSimState, rawDamage: number): number {
  if (rawDamage <= 0) return 0;
  let remaining = rawDamage;
  let reduce = 0;
  for (const part of state) {
    if (remaining <= 0) break;
    if (part.hits <= 0) continue;
    const absorbableRaw = part.hits / part.ratio;
    const absorbed = Math.min(absorbableRaw, remaining);
    part.hits -= absorbed * part.ratio;
    reduce += absorbed * (1 - part.ratio);
    remaining -= absorbed;
  }
  return rawDamage - reduce;
}

/** 攻击 actor 的统一视图（塔 / 防御者——预算计算不区分来源）。 */
interface AttackActor {
  readonly kind: "tower" | "defender";
  readonly id: string;
  readonly sortKey: string;
  readonly x: number;
  readonly y: number;
  /** 本 tick 可对目标发出的 raw 伤害（塔按能量门槛 + 距离衰减；防御者按共享可执行语义）。 */
  readonly rawDamageTo: (target: { x: number; y: number }) => number;
}

function towerAttackActorOf(tower: FocusFireTowerSnapshot): AttackActor {
  return {
    kind: "tower",
    id: tower.id,
    sortKey: tower.id,
    x: tower.x,
    y: tower.y,
    rawDamageTo: (target) => (tower.energy >= TOWER_ACTION_ENERGY_COST
      ? towerAttackPowerAtRange(chebyshevRange(tower, target))
      : 0),
  };
}

/**
 * 【G 单一语义源】防御者本 tick 可执行伤害：贴身（≤1）→ attack()（melee，
 * 与 RANGED 互斥且优先）；纯远程（无 ATTACK 部件）且 ≤3 → rangedAttack()；
 * 其余（含需要移动的混合编队近战意图）→ 0。执行层 homeDefender 的
 * defenderEngagementMode 使用同一判定。
 */
export function executableDefenderDamage(
  defender: { readonly x: number; readonly y: number; readonly meleeDamage: number; readonly rangedDamage: number },
  target: { readonly x: number; readonly y: number },
): number {
  const range = chebyshevRange(defender, target);
  if (range <= DEFENDER_MELEE_RANGE && defender.meleeDamage > 0) return defender.meleeDamage;
  if (defender.meleeDamage === 0 && range <= DEFENDER_RANGED_RANGE) return defender.rangedDamage;
  return 0;
}

export type DefenderEngagementMode = "attack" | "ranged_attack" | "approach";

/** 执行层与 planner 共享的防御者接敌模式判定（见 executableDefenderDamage）。 */
export function defenderEngagementMode(
  defender: { readonly x: number; readonly y: number; readonly meleeDamage: number; readonly rangedDamage: number },
  target: { readonly x: number; readonly y: number },
): DefenderEngagementMode {
  const range = chebyshevRange(defender, target);
  if (range <= DEFENDER_MELEE_RANGE && defender.meleeDamage > 0) return "attack";
  if (defender.meleeDamage === 0 && defender.rangedDamage > 0 && range <= DEFENDER_RANGED_RANGE) return "ranged_attack";
  return "approach";
}

function defenderAttackActorOf(defender: FocusFireDefenderSnapshot): AttackActor {
  return {
    kind: "defender",
    id: defender.slot,
    sortKey: defender.slot,
    x: defender.x,
    y: defender.y,
    rawDamageTo: (target) => executableDefenderDamage(defender, target),
  };
}

/** 一组 actor 对单个目标的顺序模拟总有效伤害（fresh 状态）。 */
function effectiveDamageOfActors(
  actors: readonly AttackActor[],
  target: FocusFireHostileSnapshot,
): number {
  const state = freshToughSimState(target.toughProfile);
  let total = 0;
  for (const actor of actors) {
    total += applyRawDamage(state, actor.rawDamageTo(target));
  }
  return total;
}

/** 目标评分（净伤害优先、残血加成、威胁决胜——全部确定性）。 */
function scoreOf(target: FocusFireHostileSnapshot, effective: number): number {
  const net = effective - target.incomingHeal;
  return net * 1000 - target.hits * 0.2 + target.threat - (target.hits < target.hitsMax ? 50 : 0);
}

/** 候选排序键：可击杀（net>0）严格优先，其次评分，最后 id 字典序决胜。 */
function candidateOrderKey(target: FocusFireHostileSnapshot, effective: number): [number, number, string] {
  const net = effective - target.incomingHeal;
  return [net > 0 ? 1 : 0, scoreOf(target, effective), target.id];
}

/** 紧急治疗仲裁：重伤缺口排序（缺口大者优先，id 字典序决胜），限量占用塔。 */
function planEmergencyHeal(
  input: FocusFireRoomInput,
  towerIdsByEnergy: readonly string[],
): Record<string, string> {
  const assignments: Record<string, string> = {};
  const emergencyCap = Math.max(1, Math.ceil(towerIdsByEnergy.length * FOCUS_FIRE_EMERGENCY_HEAL_TOWER_CAP_RATIO));
  const towersById = new Map(input.towers.map((tower) => [tower.id, tower]!));
  const wounded = [...input.wounded]
    .map((creep) => ({ creep, missing: creep.hitsMax - creep.hits }))
    .filter((entry) => entry.missing >= Math.max(1, Math.floor(entry.creep.hitsMax * FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO)))
    .sort((left, right) => right.missing - left.missing || left.creep.id.localeCompare(right.creep.id));
  if (wounded.length === 0 || towerIdsByEnergy.length === 0) {
    return assignments;
  }
  // 塔按 id 稳定排序依次指派（就近留给执行层校验，规划层保持确定性）。
  const availableTowers = [...towerIdsByEnergy].sort((left, right) => left.localeCompare(right));
  let towerIndex = 0;
  for (const entry of wounded) {
    let remaining = entry.missing;
    while (remaining > 0 && towerIndex < availableTowers.length && Object.keys(assignments).length < emergencyCap) {
      const towerId = availableTowers[towerIndex];
      const tower = towersById.get(towerId)!;
      const healPerTick = towerHealPowerAtRange(chebyshevRange(tower, entry.creep));
      if (healPerTick <= 0) {
        towerIndex += 1;
        continue;
      }
      // 同一塔本 tick 只服务一个重伤目标（不跨目标拆分）。
      assignments[towerId] = entry.creep.id;
      remaining -= healPerTick;
      towerIndex += 1;
    }
  }
  return assignments;
}

/** 仅测试/诊断观测：planner 调用计数（消费方不得重复触发全房间重评分）。 */
const plannerStats = { invocations: 0 };
export function readFocusFirePlannerStatsForTest(): { readonly invocations: number } {
  return plannerStats;
}

/**
 * 每房间每 tick 的唯一 engagement plan（纯函数——确定性输入输出）。
 * 顺序：紧急治疗仲裁（A）→ 攻击 actor 集合（剔除治疗塔）→ 顺序 TOUGH 模拟
 * 评分选 primary（F：无 net>0 也产生 pressure 共享目标）→ 含治疗击杀预算
 * （C）逐 actor 分配（B：跨越者恒留 primary）→ spill 按剩余 actor 重评
 * secondary（E）。
 */
export function planRoomEngagement(input: FocusFireRoomInput, tick: number): FocusFireEngagementPlan {
  plannerStats.invocations += 1;
  // 【A】紧急治疗仲裁先于一切攻击预算。
  const emergencyHealByTowerId = planEmergencyHeal(
    input,
    input.towers.filter((tower) => tower.energy >= TOWER_ACTION_ENERGY_COST).map((tower) => tower.id),
  );
  const healTowerIds = new Set(Object.keys(emergencyHealByTowerId));

  const hostilesById = new Map(input.hostiles.map((hostile) => [hostile.id, hostile]!));
  // 攻击 actor：能量足够的非治疗塔 + 全部防御者（伤害按共享可执行语义）。
  const attackTowers = [...input.towers]
    .filter((tower) => tower.energy >= TOWER_ACTION_ENERGY_COST && !healTowerIds.has(tower.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(towerAttackActorOf);
  const attackDefenders = [...input.defenders]
    .sort((left, right) => left.slot.localeCompare(right.slot))
    .map(defenderAttackActorOf);
  const actors = [...attackTowers, ...attackDefenders];

  if (input.hostiles.length === 0) {
    return {
      roomName: input.roomName,
      plannedAtTick: tick,
      focusTargetId: null,
      killExpected: false,
      focusAssignedDamage: 0,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      emergencyHealByTowerId,
      fallbackReason: "no-hostile",
    };
  }
  if (actors.length === 0) {
    // 没有任何可参与的攻击 actor（塔全部低能量/被治疗占用、无防御者）——
    // 治疗仲裁仍交付，攻击面 fallback。
    return {
      roomName: input.roomName,
      plannedAtTick: tick,
      focusTargetId: null,
      killExpected: false,
      focusAssignedDamage: 0,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      emergencyHealByTowerId,
      fallbackReason: "no-attack-actor",
    };
  }

  // 评分：全部攻击 actor 的顺序模拟有效伤害（per hostile，fresh 状态）。
  const effectiveByHostileId = new Map<string, number>();
  for (const hostile of input.hostiles) {
    effectiveByHostileId.set(hostile.id, effectiveDamageOfActors(actors, hostile));
  }
  // 【F】可击杀（net>0）严格优先；全部 net<=0 时仍取最高分为共享压制目标。
  const primary = [...input.hostiles].sort((left, right) => {
    const leftKey = candidateOrderKey(left, effectiveByHostileId.get(left.id) ?? 0);
    const rightKey = candidateOrderKey(right, effectiveByHostileId.get(right.id) ?? 0);
    return rightKey[0] - leftKey[0] || rightKey[1] - leftKey[1] || leftKey[2].localeCompare(rightKey[2]);
  })[0]!;
  const primaryEffective = effectiveByHostileId.get(primary.id) ?? 0;
  const killExpected = primaryEffective - primary.incomingHeal > 0;

  // 【C】击杀预算含敌方本 tick 治疗：primary 累计有效伤害 < hits+heal 期间
  // 绝不分火；预算 ceil((hits+heal)×margin) 达成后的后续 actor 才 spill。
  const killBudget = killExpected
    ? Math.ceil((primary.hits + primary.incomingHeal) * FOCUS_FIRE_KILL_OVERKILL_MARGIN)
    : Number.POSITIVE_INFINITY;

  const towerAssignments: Record<string, string> = {};
  const defenderAssignments: Record<string, string> = {};
  const primarySim = freshToughSimState(primary.toughProfile);
  let focusAssignedDamage = 0;

  // 逐 actor 分配（顺序确定性：塔按 id、防御者按 slot）。
  for (let index = 0; index < actors.length; index++) {
    const actor = actors[index];
    const remainingActors = actors.slice(index);
    const shouldSpill = killExpected && focusAssignedDamage >= killBudget && input.hostiles.length > 1;
    let assignedId = primary.id;
    if (shouldSpill) {
      // 【E】secondary 用**剩余未分配** actor 重新做顺序模拟评分（目标特定
      // 有效伤害/TOUGH/治疗全部重算；已分配 actor 不再计入任何预算）。
      const secondary = [...input.hostiles]
        .filter((hostile) => hostile.id !== primary.id)
        .sort((left, right) => {
          const leftKey = candidateOrderKey(left, effectiveDamageOfActors(remainingActors, left));
          const rightKey = candidateOrderKey(right, effectiveDamageOfActors(remainingActors, right));
          return rightKey[0] - leftKey[0] || rightKey[1] - leftKey[1] || leftKey[2].localeCompare(rightKey[2]);
        })[0]!;
      assignedId = secondary.id;
    }
    if (actor.kind === "tower") {
      towerAssignments[actor.id] = assignedId;
    } else {
      defenderAssignments[actor.id] = assignedId;
    }
    if (assignedId === primary.id) {
      // 【B】跨越阈值的 actor 分配给 primary 并计入累计（只有实际分配给
      // primary 的有效伤害才累计）。
      const target = hostilesById.get(primary.id)!;
      focusAssignedDamage += applyRawDamage(primarySim, actor.rawDamageTo(target));
    }
  }

  return {
    roomName: input.roomName,
    plannedAtTick: tick,
    focusTargetId: primary.id,
    killExpected,
    focusAssignedDamage: Math.round(focusAssignedDamage),
    focusExpectedHeal: primary.incomingHeal,
    towerAssignments,
    defenderAssignments,
    emergencyHealByTowerId,
  };
}

// ── 持久 store（Memory.runtime.defenseEngagement——独立于 Treasury 分支） ──

interface RuntimeMemoryWithEngagement {
  defenseEngagement?: Record<string, FocusFireEngagementPlan>;
}

export function writeRoomEngagementPlan(plan: FocusFireEngagementPlan): void {
  const runtime = getMemoryService().ensureRuntime() as unknown as RuntimeMemoryWithEngagement;
  runtime.defenseEngagement = runtime.defenseEngagement || {};
  runtime.defenseEngagement[plan.roomName] = plan;
}

/**
 * 消费侧读取：plan 必须是本 tick 的（fresh），否则返回 null（消费方回退
 * 既有独立逻辑——每房间每 tick 由 homeDefense 重写一次，失效即一次回退，
 * 不存在重复 replan 循环）。
 */
export function readRoomEngagementPlan(roomName: string): FocusFireEngagementPlan | null {
  const plan = (Memory.runtime as RuntimeMemoryWithEngagement | undefined)?.defenseEngagement?.[roomName];
  return plan && plan.plannedAtTick === Game.time ? plan : null;
}

/** 无威胁房间的 plan 清理（生产路径）。 */
export function clearRoomEngagementPlan(roomName: string): void {
  const runtime = Memory.runtime as RuntimeMemoryWithEngagement | undefined;
  if (runtime?.defenseEngagement?.[roomName]) {
    delete runtime.defenseEngagement[roomName];
  }
}

export function clearDefenseEngagementForTest(): void {
  const runtime = Memory.runtime as RuntimeMemoryWithEngagement | undefined;
  if (runtime?.defenseEngagement) {
    delete runtime.defenseEngagement;
  }
}

// ── 运行时快照采集（每房间每 tick 一次 Game 读） ───────────────────────────

/** 敌方威胁权重（与 defenseFronts.getHostileThreat 同式——单一语义源）。 */
function hostileThreatOf(body: BodyPartDefinition[], activeCounts: (part: BodyPartConstant) => number): number {
  void body;
  return activeCounts(ATTACK) * 4 + activeCounts(RANGED_ATTACK) * 4 + activeCounts(HEAL) * 5 + activeCounts(WORK) * 3 + activeCounts(MOVE);
}

/** 敌方 creep 的 range-aware heal 输出（近程 1、远程 ≤3；含 boost 乘区）。 */
function creepHealPowerAtRange(creep: Creep, rangeToTarget: number): number {
  if (rangeToTarget > 3) return 0;
  const ranged = rangeToTarget > 1;
  return creep.body.reduce((sum, part) => {
    if (part.type !== HEAL || part.hits <= 0) return sum;
    const base = ranged ? RANGED_HEAL_POWER : HEAL_POWER;
    if (!part.boost) return sum + base;
    const boostEntry = (BOOSTS[HEAL] as Record<string, { heal?: number; rangedHeal?: number } | undefined> | undefined)?.[part.boost];
    const multiplier = ranged ? boostEntry?.rangedHeal : boostEntry?.heal;
    return sum + (typeof multiplier === "number" && Number.isFinite(multiplier) ? Math.floor(base * multiplier) : base);
  }, 0);
}

/** 防御者 boost 攻击乘区（无 boost 返回 1）。 */
function attackBoostMultiplier(part: BodyPartDefinition, kind: "attack" | "rangedAttack"): number {
  if (!part.boost) return 1;
  const entry = (BOOSTS[part.type] as Record<string, { attack?: number; rangedAttack?: number } | undefined> | undefined)?.[part.boost];
  const multiplier = kind === "attack" ? entry?.attack : entry?.rangedAttack;
  return typeof multiplier === "number" && Number.isFinite(multiplier) ? multiplier : 1;
}

/** TOUGH/boost 顺序模拟档案（部件按 body 序；boost 的 damage ratio<1）。 */
function toughProfileOfBody(body: BodyPartDefinition[]): { hits: number; ratio: number }[] {
  return body
    .filter((part) => part.hits > 0)
    .map((part) => {
      let ratio = 1;
      if (part.boost) {
        const entry = (BOOSTS as Record<string, Record<string, { damage?: number } | undefined>>)?.[part.type]?.[part.boost];
        if (typeof entry?.damage === "number" && Number.isFinite(entry.damage)) {
          ratio = entry.damage;
        }
      }
      return { hits: part.hits, ratio };
    });
}

export function buildFocusFireRoomInput(args: {
  readonly roomName: string;
  readonly hostiles: readonly Creep[];
  readonly towers: readonly StructureTower[];
  readonly defenders: readonly Creep[];
  readonly defenderSlots: Readonly<Record<string, string>>;
  readonly defenderRoles: Readonly<Record<string, "primary" | "secondary">>;
  readonly wounded: readonly Creep[];
}): FocusFireRoomInput {
  const { hostiles } = args;
  const hostileSnapshots: FocusFireHostileSnapshot[] = hostiles.map((hostile) => {
    let incomingHeal = 0;
    for (const healer of hostiles) {
      const range = Math.max(Math.abs(healer.pos.x - hostile.pos.x), Math.abs(healer.pos.y - hostile.pos.y));
      incomingHeal += creepHealPowerAtRange(healer, range);
    }
    return {
      id: hostile.id,
      x: hostile.pos.x,
      y: hostile.pos.y,
      hits: hostile.hits,
      hitsMax: hostile.hitsMax,
      toughProfile: toughProfileOfBody(hostile.body),
      incomingHeal,
      threat: hostileThreatOf(hostile.body, (part) => hostile.getActiveBodyparts(part)),
    };
  });
  const towerSnapshots: FocusFireTowerSnapshot[] = args.towers.map((tower) => ({
    id: tower.id,
    x: tower.pos.x,
    y: tower.pos.y,
    energy: tower.store.getUsedCapacity(RESOURCE_ENERGY),
  }));
  const defenderSnapshots: FocusFireDefenderSnapshot[] = args.defenders.map((creep) => {
    const slot = args.defenderSlots[creep.name] ?? creep.name;
    let meleeDamage = 0;
    let rangedDamage = 0;
    for (const part of creep.body) {
      if (part.hits <= 0) continue;
      if (part.type === ATTACK) meleeDamage += Math.floor(ATTACK_POWER * attackBoostMultiplier(part, "attack"));
      if (part.type === RANGED_ATTACK) rangedDamage += Math.floor(RANGED_ATTACK_POWER * attackBoostMultiplier(part, "rangedAttack"));
    }
    return {
      id: creep.id,
      slot,
      role: args.defenderRoles[slot] ?? "primary",
      x: creep.pos.x,
      y: creep.pos.y,
      meleeDamage,
      rangedDamage,
    };
  });
  const woundedSnapshots: FocusFireWoundedSnapshot[] = args.wounded.map((creep) => ({
    id: creep.id,
    x: creep.pos.x,
    y: creep.pos.y,
    hits: creep.hits,
    hitsMax: creep.hitsMax,
  }));
  return {
    roomName: args.roomName,
    hostiles: hostileSnapshots,
    towers: towerSnapshots,
    defenders: defenderSnapshots,
    wounded: woundedSnapshots,
  };
}
