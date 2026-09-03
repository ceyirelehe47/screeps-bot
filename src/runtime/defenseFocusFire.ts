/**
 * Defense Focus-Fire Coordination Sidecar——房间级协同集火规划器。
 *
 * 【协同缺陷背景】Tower 与主防 Creep 各自独立评分选目标导致伤害分裂，
 * 被敌方治疗分别抵消。本模块是纯函数 planner（不调用任何 Game 写 API）：
 * 每房间每 tick 由调用方（homeDefense）采集一次快照并生成唯一 engagement
 * plan；最终执行仍由 towerControl 与 homeDefender 的既有动作入口完成。
 *
 * 【Remediation III：kill feasibility 三分类 + 有状态分配】
 * 1. 目标分类（killable_this_tick / positive_pressure / suppression_only）：
 *    killBudget = ceil((hits + incomingHeal) × MARGIN)——只有全部可参与
 *    攻击 actor 的顺序模拟有效伤害达到完整预算才是本 tick 可靠击杀；
 *    killExpected=true 当且仅当 primary 是 killable 且实际分配伤害达到
 *    预算（净伤害为正不再等价于可击杀）。
 * 2. 候选优先级按桶：可靠击杀桶（HEAL 核心 / 拆墙 / 威胁 / 低血量 /
 *    少 actor 成本 / 小过量 / 稳定 ID）→ 正净伤压制桶 → 共同压制桶——
 *    高净伤但不可击杀的高血量目标不得压过本 tick 可靠击杀的低血量目标。
 * 3. Primary actor 分配：确定性 greedy（对 primary 的边际有效伤害降序、
 *    稳定 key 决胜），TOUGH 状态随分配顺序推进，达到预算即停止——
 *    跨越预算阈值的 actor 恒留 primary；移动中的 Defender 边际伤害为 0，
 *    不计入预算但保留定位 assignment。
 * 4. Stateful secondary：目标级分配循环——secondary 达到自身 killBudget
 *    才切 tertiary；当前目标无法由全部剩余 actor 击杀时，全部剩余 actor
 *    共同压制该目标（不再切换、不逐 actor 各自选敌——确定性拆火）。
 * 5. Combat target 与 engagement position 分离：hostile 快照携带接敌位置
 *    （安全区内=直接接敌；边界外=最近合法 rampart——由采集方按既有
 *    front/rampart 系统计算，planner 不建立平行防线模型）。Defender 的
 *    approach 消费该位置——不因共享目标绕过 Rampart、不离开防线追逐。
 * 6. Shared live fallback：plan 持久化候选顺序（fallbackTargetIds），
 *    目标失效时每房间每 tick 至多一次共享解析（Tower 与 Defender 消费
 *    同一结果——fallbackResolution 运行期写回 plan，计数有界）。
 * 7. 紧急治疗 Tower 按对伤员的实际治疗量选择（距离衰减感知，治疗量
 *    降序、Tower ID 稳定决胜；满足保守需求即停——剩余塔进入攻击预算）。
 *
 * 确定性：候选/actor 全部按稳定 id（slot）字典序，评分平手以 id 决胜；
 * 同快照（任意来源顺序）产生同一 plan。
 */

import { getMemoryService } from "@/runtime/runtimeServices";
import { allocateDefenderRampartPositions } from "@/runtime/defenderRampartAllocation";

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
/** WORK 部件拆墙输出（引擎 WORK_POWER=100——常量包未导出，本地同值）。 */
const WORK_DISMANTLE_POWER = 100;

/** 【Remediation III 十三】目标的三分类（本 tick 联合可行性行为语义）。 */
export type FocusFireTargetClass = "killable_this_tick" | "positive_pressure" | "suppression_only";

/** 【Remediation III 十六】combat target 与 engagement position 分离。 */
export interface FocusFireEngagementPosition {
  readonly x: number;
  readonly y: number;
  /** inside=敌在安全区内（直接接敌）；boundary=敌在边界外（合法 rampart 站位）。 */
  readonly kind: "inside" | "boundary";
}

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
  /** 【Remediation III】该目标自身的 heal 输出（HEAL 核心排序维度）。 */
  readonly healPower?: number;
  /** 【Remediation III】该目标自身的 WORK 拆墙输出（拆墙威胁排序维度）。 */
  readonly workPower?: number;
  /** 【Remediation III 十六】接敌位置（采集方按既有 front/rampart 系统给出）。 */
  readonly engagement?: FocusFireEngagementPosition;
  /** 【Remediation IV 十五】per-defender 唯一 Rampart 分配的候选集合（boundary 接敌；含他属占用标记）。 */
  readonly engagementCandidates?: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number; readonly occupied?: boolean }>;
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
  /** 【Remediation IV 十三】assigned front ID（未分配 = undefined——room-scope 保守默认）。 */
  readonly frontId?: string;
  /** 【Remediation IV 十三】该 front 允许处理的 hostile ID 集合（预计算——planner 内 O(1) 判定）。 */
  readonly eligibleHostileIds?: ReadonlySet<string>;
  /** 【Remediation IV 十三】既有协调系统显式标记的跨 front 增援许可。 */
  readonly reinforcementAllowed?: boolean;
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

/** 【Remediation III 十六 / IV 十四】Defender 的作战 assignment（目标 + 接敌模式/位置）。 */
export interface FocusFireDefenderEngagement {
  /** combat target（null = 无目标的本 tick hold——fresh plan 仍是权威，不回退独立选敌）。 */
  readonly targetId: string | null;
  /** attack/ranged_attack=本 tick 有伤害动作；engage_position=移动接敌（本 tick 伤害 0）；hold=守位/等待（无合法替代）。 */
  readonly mode: "attack" | "ranged_attack" | "engage_position" | "hold";
  /** 接敌目标位置（engage_position 时必带——inside 直接接敌 / boundary per-defender 唯一 rampart）。 */
  readonly position?: { readonly x: number; readonly y: number };
  readonly positionKind?: "inside" | "boundary";
}

/** 【Remediation IV 十六】plan 持久的 Defender front 约束（fallback revision 消费）。 */
export interface FocusFireDefenderFrontFact {
  readonly frontId?: string;
  readonly eligibleTargetIds: readonly string[];
}

export interface FocusFireEngagementPlan {
  readonly roomName: string;
  readonly plannedAtTick: number;
  /** 联合预算下的共享主目标（pressure 模式也非 null；null = 真正无 plan）。 */
  readonly focusTargetId: string | null;
  /** 【Remediation III 十三】主目标的三分类。 */
  readonly focusTargetClass: FocusFireTargetClass;
  /** 主目标是否在联合预算内可击杀（= primary 分类 killable 且分配伤害达到预算）。 */
  readonly killExpected: boolean;
  /** 主目标累计分配的联合**有效**伤害（顺序 TOUGH 模拟、仅实际分配 actor）。 */
  readonly focusAssignedDamage: number;
  /** 主目标的完整击杀预算（ceil((hits+heal)×margin)；pressure 类为 null）。 */
  readonly focusKillBudget: number | null;
  /** 主目标的敌方治疗总量（预算对照）。 */
  readonly focusExpectedHeal: number;
  /** towerId → hostileId（目标级分配结果；治疗塔不出现）。 */
  readonly towerAssignments: Readonly<Record<string, string>>;
  /** 防御者 slot → hostileId。 */
  readonly defenderAssignments: Readonly<Record<string, string>>;
  /** 【Remediation III 十六 / IV 十四】防御者 slot → 作战 assignment（覆盖全部参与 Defender——含 hold；目标与站位分离表达）。 */
  readonly defenderEngagements: Readonly<Record<string, FocusFireDefenderEngagement>>;
  /** 【Remediation III 十六】hostileId → 接敌位置（fallback 消费侧复用）。 */
  readonly engagementByTargetId: Readonly<Record<string, FocusFireEngagementPosition>>;
  /** towerId → 重伤 creep id（紧急治疗仲裁；这些塔不参与攻击）。 */
  readonly emergencyHealByTowerId: Readonly<Record<string, string>>;
  /** 【Remediation III 十七】共享 fallback 候选顺序（分类桶排序；resolver 逐个探活）。 */
  readonly fallbackTargetIds: readonly string[];
  /** 【Remediation IV 十六】Defender front 约束（fallback revision 的 front-local 替代依据）。 */
  readonly defenderFronts: Readonly<Record<string, FocusFireDefenderFrontFact>>;
  /** 【Remediation III 十七】运行期共享 fallback 解析缓存（每房间每 tick 至多一次）。 */
  fallbackResolution?: { readonly tick: number; readonly resolvedTargetId: string | null; requests: number };
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
  /** 【Remediation IV 十三】defender 的 front eligibility（tower 无此约束 = 房间级）。 */
  readonly eligibleHostileIds?: ReadonlySet<string>;
  /** 【Remediation IV 十四】defender 角色事实（positioning 阶段排序）。 */
  readonly role?: "primary" | "secondary";
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
    // 【Remediation IV 十三】Defender 默认只对其 assigned front 的 hostile
    // 可用（eligible 集合预计算——内层 O(1) 判定，不重复扫描 front）；
    // 未分配 front 的 Defender 采用 room-scope 保守默认（全集合）。
    eligibleHostileIds: defender.eligibleHostileIds,
    role: defender.role,
    rawDamageTo: (target: { x: number; y: number; id?: string }) =>
      target.id !== undefined && defender.eligibleHostileIds !== undefined && !defender.eligibleHostileIds.has(target.id)
        ? 0
        : executableDefenderDamage(defender, target),
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

/** 完整击杀预算（含保守敌方治疗与安全裕度）。 */
function killBudgetOf(target: FocusFireHostileSnapshot): number {
  return Math.ceil((target.hits + target.incomingHeal) * FOCUS_FIRE_KILL_OVERKILL_MARGIN);
}

/** 【Remediation III 十三】目标三分类（按全部可参与攻击 actor 的联合有效伤害）。 */
export function classifyFocusTarget(
  target: FocusFireHostileSnapshot,
  jointEffectiveDamage: number,
): FocusFireTargetClass {
  if (jointEffectiveDamage >= killBudgetOf(target)) return "killable_this_tick";
  if (jointEffectiveDamage - target.incomingHeal > 0) return "positive_pressure";
  return "suppression_only";
}

function classRankOfClass(cls: FocusFireTargetClass): number {
  return cls === "killable_this_tick" ? 2 : cls === "positive_pressure" ? 1 : 0;
}

/**
 * 目标评分（压制桶与决胜用：净伤害优先、残血加成、威胁决胜——确定性）。
 */
function scoreOf(target: FocusFireHostileSnapshot, effective: number): number {
  const net = effective - target.incomingHeal;
  return net * 1000 - target.hits * 0.2 + target.threat - (target.hits < target.hitsMax ? 50 : 0);
}

/**
 * 【Remediation III 十三】候选排序键（桶优先）：
 * killable 桶内按战略价值——HEAL 核心（healPower）→ 拆墙（workPower）→
 * 威胁 → 低当前 hits → 少 actor 成本 → 小过量伤害 → 稳定 ID；
 * pressure 桶内按净伤害评分；suppression 桶同。高净伤不可击杀目标不得
 * 压过本 tick 可靠击杀目标。
 */
type CandidateOrderKey = { readonly descending: readonly number[]; readonly id: string };

function candidateOrderKey(
  target: FocusFireHostileSnapshot,
  jointEffective: number,
  budget: number,
): CandidateOrderKey {
  const cls = classifyFocusTarget(target, jointEffective);
  // 桶间：可靠击杀 > 正净伤压制 > 共同压制；桶内语义随桶变化——
  // killable 桶按战略价值（HEAL 核心/拆墙/威胁/低血量/小过量），
  // pressure/suppression 桶按净伤害评分（Remediation II 的压制语义保留）。
  if (cls === "killable_this_tick") {
    const overkill = Math.max(0, jointEffective - budget);
    return {
      descending: [2, target.healPower ?? 0, target.workPower ?? 0, target.threat, -target.hits, -overkill],
      id: target.id,
    };
  }
  if (cls === "positive_pressure") {
    return { descending: [1, scoreOf(target, jointEffective)], id: target.id };
  }
  return { descending: [0, scoreOf(target, jointEffective)], id: target.id };
}

function compareCandidateOrder(left: CandidateOrderKey, right: CandidateOrderKey): number {
  for (let i = 0; i < left.descending.length; i++) {
    if (left.descending[i]! < right.descending[i]!) return 1;
    if (left.descending[i]! > right.descending[i]!) return -1;
  }
  return left.id.localeCompare(right.id);
}

/** 紧急治疗仲裁（【Remediation III 十八】）：对每个伤员按**实际治疗量**降序
 * 选塔（距离衰减感知；平手按 Tower ID 稳定决胜），满足保守需求即停——
 * 剩余塔全部进入攻击预算。伤员按缺口降序、ID 决胜。 */
function planEmergencyHeal(
  input: FocusFireRoomInput,
  eligibleTowerIds: readonly string[],
): Record<string, string> {
  const assignments: Record<string, string> = {};
  const emergencyCap = Math.max(1, Math.ceil(eligibleTowerIds.length * FOCUS_FIRE_EMERGENCY_HEAL_TOWER_CAP_RATIO));
  const towersById = new Map(input.towers.map((tower) => [tower.id, tower]!));
  const wounded = [...input.wounded]
    .map((creep) => ({ creep, missing: creep.hitsMax - creep.hits }))
    .filter((entry) => entry.missing >= Math.max(1, Math.floor(entry.creep.hitsMax * FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO)))
    .sort((left, right) => right.missing - left.missing || left.creep.id.localeCompare(right.creep.id));
  if (wounded.length === 0 || eligibleTowerIds.length === 0) {
    return assignments;
  }
  const usedTowerIds = new Set<string>();
  for (const entry of wounded) {
    if (Object.keys(assignments).length >= emergencyCap) break;
    // 按对该伤员的实际治疗量降序、Tower ID 决胜（确定性）。
    const ranked = eligibleTowerIds
      .filter((towerId) => !usedTowerIds.has(towerId))
      .map((towerId) => ({ towerId, heal: towerHealPowerAtRange(chebyshevRange(towersById.get(towerId)!, entry.creep)) }))
      .filter((candidate) => candidate.heal > 0)
      .sort((left, right) => right.heal - left.heal || left.towerId.localeCompare(right.towerId));
    let remaining = entry.missing;
    for (const candidate of ranked) {
      if (Object.keys(assignments).length >= emergencyCap) break;
      if (remaining <= 0) break;
      // 同一塔本 tick 只服务一个重伤目标（不跨目标拆分）。
      assignments[candidate.towerId] = entry.creep.id;
      usedTowerIds.add(candidate.towerId);
      remaining -= candidate.heal;
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
 * 顺序：紧急治疗仲裁（按实际治疗量）→ 攻击 actor 集合（剔除治疗塔）→
 * 三分类候选排序（killable 桶战略优先）→ 目标级分配循环（primary greedy
 * 至 killBudget → secondary/tertiary 同算法；不可击杀时全部剩余共同压制）
 * → combat target 与 engagement position 分离输出 → fallback 候选顺序。
 */
export function planRoomEngagement(input: FocusFireRoomInput, tick: number): FocusFireEngagementPlan {
  plannerStats.invocations += 1;
  // 【Remediation III 十八】紧急治疗仲裁先于一切攻击预算。
  const eligibleTowerIds = input.towers.filter((tower) => tower.energy >= TOWER_ACTION_ENERGY_COST).map((tower) => tower.id);
  const emergencyHealByTowerId = planEmergencyHeal(input, eligibleTowerIds);
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

  const emptyEngagements: Record<string, FocusFireEngagementPosition> = {};
  for (const hostile of input.hostiles) {
    if (hostile.engagement !== undefined) {
      emptyEngagements[hostile.id] = hostile.engagement;
    }
  }

  if (input.hostiles.length === 0) {
    return {
      roomName: input.roomName,
      plannedAtTick: tick,
      focusTargetId: null,
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      // 【IV 十七】fresh plan 是权威：即使 focusTargetId=null，全部参与
      // Defender 获得显式 hold（消费侧不得回退独立选敌）。
      defenderEngagements: Object.fromEntries(
        input.defenders.map((defender) => [defender.slot, { targetId: null, mode: "hold" as const }]),
      ),
      engagementByTargetId: emptyEngagements,
      emergencyHealByTowerId,
      fallbackTargetIds: [],
      defenderFronts: {},
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
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: Object.fromEntries(
        input.defenders.map((defender) => [defender.slot, { targetId: null, mode: "hold" as const }]),
      ),
      engagementByTargetId: emptyEngagements,
      emergencyHealByTowerId,
      fallbackTargetIds: input.hostiles.map((hostile) => hostile.id),
      defenderFronts: Object.fromEntries(
        input.defenders.map((defender) => [
          defender.slot,
          {
            ...(defender.frontId !== undefined ? { frontId: defender.frontId } : {}),
            eligibleTargetIds:
              defender.eligibleHostileIds !== undefined
                ? input.hostiles.map((h) => h.id).filter((id) => defender.eligibleHostileIds!.has(id))
                : input.hostiles.map((h) => h.id).slice().sort((a, b) => a.localeCompare(b)),
          },
        ]),
      ),
      fallbackReason: "no-attack-actor",
    };
  }

  // 联合有效伤害与分类（per hostile，fresh 状态）。
  const jointEffectiveByHostileId = new Map<string, number>();
  const budgetByHostileId = new Map<string, number>();
  for (const hostile of input.hostiles) {
    jointEffectiveByHostileId.set(hostile.id, effectiveDamageOfActors(actors, hostile));
    budgetByHostileId.set(hostile.id, killBudgetOf(hostile));
  }
  // 候选排序（桶优先；killable 桶战略价值；同桶 ID 决胜）。
  const orderedHostiles = [...input.hostiles].sort((left, right) => {
    const leftKey = candidateOrderKey(left, jointEffectiveByHostileId.get(left.id) ?? 0, budgetByHostileId.get(left.id) ?? 0);
    const rightKey = candidateOrderKey(right, jointEffectiveByHostileId.get(right.id) ?? 0, budgetByHostileId.get(right.id) ?? 0);
    return compareCandidateOrder(leftKey, rightKey);
  });
  const primary = orderedHostiles[0]!;
  const primaryClass = classifyFocusTarget(primary, jointEffectiveByHostileId.get(primary.id) ?? 0);

  // 【Remediation III 十四/十五 + IV 十四】目标级分配循环（确定性、有界——
  // 无指数搜索）。【IV】对当前 target 伤害为 0 的 Defender 不再被提前消费
  // 为 positioning follower——零伤害 Defender 保留在 remaining 池，下一个
  // target 重新计算其伤害（对 Primary 为 0、对 Secondary 为正的 Defender
  // 参与 Secondary）；只有全部可执行伤害分配完成后才进入 positioning
  // 阶段（独立 rampart / hold）。
  const towerAssignments: Record<string, string> = {};
  const defenderAssignments: Record<string, string> = {};
  const defenderEngagements: Record<string, FocusFireDefenderEngagement> = {};
  const defenderFronts: Record<string, FocusFireDefenderFrontFact> = {};
  const orderedHostileIds = () => orderedHostiles.map((hostile) => hostile.id);
  for (const defender of input.defenders) {
    defenderFronts[defender.slot] = {
      ...(defender.frontId !== undefined ? { frontId: defender.frontId } : {}),
      eligibleTargetIds:
        defender.eligibleHostileIds !== undefined
          ? orderedHostileIds().filter((id) => defender.eligibleHostileIds!.has(id))
          : orderedHostileIds(),
    };
  }
  let focusAssignedDamage = 0;
  let unassigned = [...actors];
  let current: FocusFireHostileSnapshot | null = primary;
  const assignedTargets: { targetId: string; class: FocusFireTargetClass }[] = [];
  let guard = 0;
  while (current !== null && unassigned.length > 0 && guard++ <= input.hostiles.length + 1) {
    const budget = budgetByHostileId.get(current.id)!;
    const classOfCurrent = classifyFocusTarget(current, jointEffectiveByHostileId.get(current.id) ?? 0);
    // 对当前 target 有正本 tick 伤害且符合 front eligibility 的 actor 子集
    //（零伤害 actor 保留——不作为 follower 提前消费）。
    const positiveActors = unassigned.filter((actor) => actor.rawDamageTo(current!) > 0);
    if (positiveActors.length === 0) {
      // 剩余 actor（含 front-受限 Defender）对当前目标均零伤害：不消费、
      // 不压制——评估下一个目标。
      const remainingHostiles = orderedHostiles.filter(
        (hostile) => !assignedTargets.some((entry) => entry.targetId === hostile.id) && hostile.id !== current!.id,
      );
      if (remainingHostiles.length === 0) {
        current = null;
        break;
      }
      current = pickNextTarget(remainingHostiles, unassigned, jointEffectiveByHostileId, budgetByHostileId);
      continue;
    }
    // 剩余 actor 对当前目标的联合可行性（重算——目标级状态；零伤害 actor
    // 不改变数值，killability 只由正伤害 actor 构成）。
    const jointWithRemaining = effectiveDamageOfActors(positiveActors, current);
    if (classOfCurrent === "killable_this_tick" && jointWithRemaining >= budget) {
      // 可靠击杀：确定性 greedy（边际有效伤害降序——对 fresh 状态的单 actor
      // 有效伤害排序，平手稳定 key；分配顺序推进 TOUGH 模拟至预算达成）。
      const sim = freshToughSimState(current.toughProfile);
      const marginalRanked = [...positiveActors]
        .map((actor) => ({ actor, marginal: applyRawDamage(freshToughSimState(current!.toughProfile), actor.rawDamageTo(current!)) }))
        .filter((entry) => entry.marginal > 0)
        .sort((left, right) => right.marginal - left.marginal || left.actor.sortKey.localeCompare(right.actor.sortKey));
      let cumulative = 0;
      const assignedNow: AttackActor[] = [];
      for (const entry of marginalRanked) {
        if (cumulative >= budget) break;
        cumulative += applyRawDamage(sim, entry.actor.rawDamageTo(current));
        assignedNow.push(entry.actor);
      }
      // 【Remediation IV 十四】零伤害 Defender 不再作为 follower 提前消费
      //——保留在 unassigned（下一 target 重新评估；全部伤害分配完成后
      // 由 positioning 阶段分配独立 rampart / hold）。
      for (const actor of assignedNow) {
        if (actor.kind === "tower") towerAssignments[actor.id] = current.id;
        else defenderAssignments[actor.id] = current.id;
      }
      if (current.id === primary.id) focusAssignedDamage = cumulative;
      assignedTargets.push({ targetId: current.id, class: classOfCurrent });
      const assignedKeySet = new Set(assignedNow.map((actor) => actor.sortKey));
      unassigned = unassigned.filter((actor) => !assignedKeySet.has(actor.sortKey));
      // 选择下一个目标：剩余 actor 重新分类排序（killable 优先）。
      const remainingHostiles = orderedHostiles.filter(
        (hostile) => !assignedTargets.some((entry) => entry.targetId === hostile.id),
      );
      if (remainingHostiles.length === 0) {
        current = null;
        break;
      }
      current = pickNextTarget(remainingHostiles, unassigned, jointEffectiveByHostileId, budgetByHostileId);
      continue;
    }
    // 不可击杀（suppression/pressure 或剩余火力不足）：对当前目标有正伤害
    // 的全部剩余 actor 共同压制——不切换第三目标、不逐 actor 各自选敌
    //（15.1）；零伤害 Defender 保留（14.1——下一目标重新评估）。
    for (const actor of positiveActors) {
      if (actor.kind === "tower") towerAssignments[actor.id] = current.id;
      else defenderAssignments[actor.id] = current.id;
    }
    if (current.id === primary.id) {
      focusAssignedDamage = jointWithRemaining;
    }
    assignedTargets.push({ targetId: current.id, class: classOfCurrent });
    const positiveKeySet = new Set(positiveActors.map((actor) => actor.sortKey));
    unassigned = unassigned.filter((actor) => !positiveKeySet.has(actor.sortKey));
    const remainingHostiles = orderedHostiles.filter(
      (hostile) => !assignedTargets.some((entry) => entry.targetId === hostile.id),
    );
    if (remainingHostiles.length === 0) {
      current = null;
      break;
    }
    current = pickNextTarget(remainingHostiles, unassigned, jointEffectiveByHostileId, budgetByHostileId);
  }
  // 未获得目标的残余 Tower（防御性压制 primary——理论不可达）。零伤害
  // Defender 不在此分配——positioning 阶段统一处理（独立 rampart / hold）。
  for (const actor of unassigned) {
    if (actor.kind === "tower") towerAssignments[actor.id] = primary.id;
  }

  // 【Remediation IV 十四.2 / 十五】positioning 阶段：全部可执行伤害分配完成
  // 后处理仍未分配的 Defender——按自身 front 选择需要防守的 target（eligible
  // 集合内按计划候选顺序——combat target 保留给下一 tick 规划），分配独立
  // engagement position（per-defender 唯一 rampart——allocate 单一实现）；
  // 候选不足时明确 hold（不追逐边界外 hostile、不回退独立选敌）。
  const positioningDefenders = input.defenders.filter((defender) => defenderAssignments[defender.slot] === undefined);
  if (positioningDefenders.length > 0) {
    const targetIdBySlot: Record<string, string> = {};
    for (const defender of positioningDefenders) {
      // eligible 集合内、本 plan 仍存在的 hostiles 中按候选顺序选第一个
      //（无 front 约束的 Defender 用全局顺序——primary 所在 front 优先）。
      const eligibleOrder = orderedHostiles.filter(
        (hostile) => defender.eligibleHostileIds === undefined || defender.eligibleHostileIds.has(hostile.id),
      );
      const chosen = eligibleOrder[0];
      if (chosen !== undefined) {
        defenderAssignments[defender.slot] = chosen.id;
        targetIdBySlot[defender.slot] = chosen.id;
      }
    }
    // per-defender 唯一 rampart 分配（boundary 候选；inside 直接接敌）。
    const candidatesByTargetId: Record<string, { id: string; x: number; y: number; occupied?: boolean }[]> = {};
    const targetPositionById: Record<string, { x: number; y: number }> = {};
    for (const hostile of input.hostiles) {
      targetPositionById[hostile.id] = { x: hostile.x, y: hostile.y };
      if (hostile.engagementCandidates !== undefined && hostile.engagementCandidates.length > 0) {
        candidatesByTargetId[hostile.id] = [...hostile.engagementCandidates];
      } else if (hostile.engagement?.kind === "boundary") {
        // 候选缺失时退化为单一 engagement 位置（采集层默认——per-defender
        // 唯一性由 allocate 保证：单候选只分配一名 Defender，其余 hold）。
        candidatesByTargetId[hostile.id] = [{ id: `pos:${hostile.engagement.x},${hostile.engagement.y}`, x: hostile.engagement.x, y: hostile.engagement.y }];
      }
    }
    const allocation = allocateDefenderRampartPositions({
      defenders: positioningDefenders
        .filter((defender) => targetIdBySlot[defender.slot] !== undefined)
        .map((defender) => ({ slot: defender.slot, role: defender.role, x: defender.x, y: defender.y, targetId: targetIdBySlot[defender.slot]! })),
      candidatesByTargetId,
      targetPositionById,
    });
    for (const defender of positioningDefenders) {
      const targetId = targetIdBySlot[defender.slot];
      if (targetId === undefined) {
        // 无 eligible target（全部失效/不在 front）：明确 hold（不跨 front、
        // 不回退独立选敌）。
        defenderEngagements[defender.slot] = { targetId: null, mode: "hold" };
        continue;
      }
      const target = hostilesById.get(targetId)!;
      const mode = defenderEngagementMode(defender, target);
      const engagement = target.engagement;
      if (mode !== "approach") {
        // 站位即战位（贴身/射程内）：直接动作语义。
        defenderEngagements[defender.slot] = { targetId, mode };
        continue;
      }
      if (engagement?.kind === "inside") {
        defenderEngagements[defender.slot] = {
          targetId,
          mode: "engage_position",
          position: { x: engagement.x, y: engagement.y },
          positionKind: "inside",
        };
        continue;
      }
      if (engagement?.kind === "boundary") {
        const allocated = allocation[defender.slot];
        if (allocated !== undefined) {
          defenderEngagements[defender.slot] = {
            targetId,
            mode: "engage_position",
            position: { x: allocated.x, y: allocated.y },
            positionKind: "boundary",
          };
        } else {
          // 候选 Rampart 不足：明确 hold（本 tick 伤害 0、保留 combat target
          // 给下一 tick 规划——不重复分配已占用位置、不追逐边界外 hostile）。
          defenderEngagements[defender.slot] = { targetId, mode: "hold" };
        }
        continue;
      }
      // 无站位信息（采集层防线系统未给出）：engage_position 不带位置——
      // 消费侧按既有规则直接接敌。
      defenderEngagements[defender.slot] = { targetId, mode: "engage_position" };
    }
  }

  // 【十六】Defender 的作战 assignment：目标与接敌位置分离表达。
  for (const defender of input.defenders) {
    if (defenderEngagements[defender.slot] !== undefined) continue;
    const targetId = defenderAssignments[defender.slot];
    if (targetId === undefined) {
      // 参与计划但无任何 assignment（输入 defender 均应参与——防御性 hold）。
      defenderEngagements[defender.slot] = { targetId: null, mode: "hold" };
      continue;
    }
    const target = hostilesById.get(targetId)!;
    const mode = defenderEngagementMode(defender, target);
    const engagement = target.engagement;
    if (mode === "approach") {
      defenderEngagements[defender.slot] = {
        targetId,
        mode: "engage_position",
        // inside=直接接敌（追击目标自身符合既有规则）；boundary=前往合法
        // rampart 站位（不离开防线追逐不可达目标）。
        ...(engagement !== undefined ? { position: { x: engagement.x, y: engagement.y }, positionKind: engagement.kind } : {}),
      };
    } else {
      defenderEngagements[defender.slot] = { targetId, mode };
    }
  }

  const killExpected = primaryClass === "killable_this_tick" && focusAssignedDamage >= budgetByHostileId.get(primary.id)!;

  return {
    roomName: input.roomName,
    plannedAtTick: tick,
    focusTargetId: primary.id,
    focusTargetClass: primaryClass,
    killExpected,
    focusAssignedDamage: Math.round(focusAssignedDamage),
    focusKillBudget: primaryClass === "killable_this_tick" ? budgetByHostileId.get(primary.id)! : null,
    focusExpectedHeal: primary.incomingHeal,
    towerAssignments,
    defenderAssignments,
    defenderEngagements,
    engagementByTargetId: emptyEngagements,
    emergencyHealByTowerId,
    // 【十七】fallback 候选顺序 = 分类桶排序（primary 在首位；resolver 在
    // 失效时按顺序探活）。
    fallbackTargetIds: orderedHostiles.map((hostile) => hostile.id),
    defenderFronts,
  };
}

/** 剩余目标中的下一个（killable 优先 → 战略价值；无可击杀时选最佳共同压制）。 */
function pickNextTarget(
  remainingHostiles: readonly FocusFireHostileSnapshot[],
  remainingActors: readonly AttackActor[],
  jointEffectiveByHostileId: ReadonlyMap<string, number>,
  budgetByHostileId: ReadonlyMap<string, number>,
): FocusFireHostileSnapshot | null {
  if (remainingHostiles.length === 0) return null;
  const scored = remainingHostiles.map((hostile) => {
    // 用**剩余** actor 重新评估（已分配 actor 不再计入任何预算——E 语义）。
    const remainingJoint = effectiveDamageOfActors(remainingActors, hostile);
    const remainingBudget = budgetByHostileId.get(hostile.id)!;
    return { hostile, remainingJoint, remainingBudget };
  });
  scored.sort((left, right) => {
    const leftKillable = left.remainingJoint >= left.remainingBudget ? 1 : 0;
    const rightKillable = right.remainingJoint >= right.remainingBudget ? 1 : 0;
    if (leftKillable !== rightKillable) return rightKillable - leftKillable;
    // killable 桶内战略价值；pressure/suppression 桶内评分。
    if (leftKillable === 1) {
      // killable 桶内战略价值（HEAL/拆墙/威胁/低血量——降序），稳定 ID
      // 字典序升序决胜。
      const leftKey = [left.hostile.healPower ?? 0, left.hostile.workPower ?? 0, left.hostile.threat, -left.hostile.hits];
      const rightKey = [right.hostile.healPower ?? 0, right.hostile.workPower ?? 0, right.hostile.threat, -right.hostile.hits];
      for (let i = 0; i < leftKey.length; i++) {
        if (leftKey[i]! < rightKey[i]!) return 1;
        if (leftKey[i]! > rightKey[i]!) return -1;
      }
      return left.hostile.id.localeCompare(right.hostile.id);
    }
    const leftScore = scoreOf(left.hostile, left.remainingJoint);
    const rightScore = scoreOf(right.hostile, right.remainingJoint);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.hostile.id.localeCompare(right.hostile.id);
  });
  void jointEffectiveByHostileId;
  return scored[0]!.hostile;
}

// ── 【Remediation III 十七】房间级一次性共享 live fallback ──────────────────

interface RuntimeMemoryWithEngagement {
  defenseEngagement?: Record<string, FocusFireEngagementPlan>;
}

/**
 * 共享 fallback 解析：计划目标失效时，每房间每 tick 至多计算一次（结果
 * 写回 plan 的 fallbackResolution——Tower 与 Defender 消费同一缓存）。
 * 按计划时的候选顺序（fallbackTargetIds）找第一个仍存活的 hostile；
 * 无合法 fallback 返回 null（全部相关 actor 本 tick 共同空转——不回退
 * 独立评分）。计数有界（plan 每 tick 重写）。
 */
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
  /** 【Remediation III 十六】hostile 接敌位置（安全区内/边界外 rampart——由调用方按既有防线系统给出）。 */
  readonly hostileEngagements?: Readonly<Record<string, FocusFireEngagementPosition>>;
  /** 【Remediation IV 十五】hostile 的 boundary rampart 候选集合（per-defender 唯一分配——由调用方按既有防线系统给出）。 */
  readonly hostileEngagementCandidates?: Readonly<Record<string, readonly { id: string; x: number; y: number; occupied?: boolean }[]>>;
  /** 【Remediation IV 十三】Defender 的 assigned front 与该 front 允许的 hostile 集合（预计算）。 */
  readonly defenderFronts?: Readonly<Record<string, { frontId?: string; eligibleHostileIds: ReadonlySet<string> }>>;
}): FocusFireRoomInput {
  const { hostiles } = args;
  const hostileSnapshots: FocusFireHostileSnapshot[] = hostiles.map((hostile) => {
    let incomingHeal = 0;
    let healPower = 0;
    let workPower = 0;
    for (const healer of hostiles) {
      const range = Math.max(Math.abs(healer.pos.x - hostile.pos.x), Math.abs(healer.pos.y - hostile.pos.y));
      incomingHeal += creepHealPowerAtRange(healer, range);
    }
    healPower = creepHealPowerAtRange(hostile, 1);
    workPower = hostile.getActiveBodyparts(WORK) * WORK_DISMANTLE_POWER;
    return {
      id: hostile.id,
      x: hostile.pos.x,
      y: hostile.pos.y,
      hits: hostile.hits,
      hitsMax: hostile.hitsMax,
      toughProfile: toughProfileOfBody(hostile.body),
      incomingHeal,
      threat: hostileThreatOf(hostile.body, (part) => hostile.getActiveBodyparts(part)),
      ...(healPower > 0 || workPower > 0 || args.hostileEngagements?.[hostile.id] !== undefined || args.hostileEngagementCandidates?.[hostile.id] !== undefined
        ? {
            ...(healPower > 0 ? { healPower } : {}),
            ...(workPower > 0 ? { workPower } : {}),
            ...(args.hostileEngagements?.[hostile.id] !== undefined
              ? { engagement: args.hostileEngagements[hostile.id] }
              : {}),
            ...(args.hostileEngagementCandidates?.[hostile.id] !== undefined
              ? { engagementCandidates: args.hostileEngagementCandidates[hostile.id] }
              : {}),
          }
        : {}),
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
    const front = args.defenderFronts?.[slot];
    return {
      id: creep.id,
      slot,
      role: args.defenderRoles[slot] ?? "primary",
      x: creep.pos.x,
      y: creep.pos.y,
      meleeDamage,
      rangedDamage,
      ...(front?.frontId !== undefined ? { frontId: front.frontId } : {}),
      ...(front?.eligibleHostileIds !== undefined ? { eligibleHostileIds: front.eligibleHostileIds } : {}),
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
