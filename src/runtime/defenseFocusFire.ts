/**
 * Defense Focus-Fire Coordination Sidecar——房间级协同集火规划器。
 *
 * 【协同缺陷背景】Tower（towerControl.chooseFocusTarget / assignSpreadTargets）
 * 与主防 Creep（homeDefender 经 hostilePriorities.chooseInsideBurstTarget /
 * chooseBoundaryBurstEngagement）各自独立评分选目标：同一 tick 塔群集火
 * hostile X 而防御者攻击 hostile Y 的伤害分裂使敌方治疗可以分别抵消两路
 * 伤害；分火判定只计塔伤害不含防御者输出；治疗无紧急度仲裁（任一擦伤
 * creep 会吸走全部塔）；评分平手依赖 find 顺序（非确定）。
 *
 * 本模块是纯函数 planner（不调用任何 Game 写 API、不移动、不攻击）：
 * - 每房间每 tick 由调用方（homeDefense）采集一次快照并生成唯一
 *   engagement plan（联合伤害预算 = Tower 距离衰减 × TOUGH/boost 有效伤害
 *   比 + 防御者近战/远程输出 - 敌方 range-aware 治疗）；
 * - 输出目标与 actor 分配（towerAssignments / defenderAssignments /
 *   emergencyHealByTowerId），最终执行仍由 towerControl 与 homeDefender 的
 *   既有动作入口完成（不新增散落 Game API 调用点）；
 * - 过量伤害控制：主目标累计分配伤害 ≥ hits × KILL_OVERKILL_MARGIN 后，
 *   追加 actor 按同一评分分火次级目标；
 * - 紧急治疗仲裁：仅重伤（缺口 ≥ EMERGENCY_HEAL_MISSING_RATIO × hitsMax）
 *   creep 占用塔，且紧急治疗塔数不超过攻击塔一半（保留火力下限）；
 * - 确定性：全部候选按 id 字典序稳定排序，评分平手以 id 决胜；同快照
 *   输入（任意来源顺序）产生同一 plan；
 * - fallback：无净伤害候选 → focusTargetId=null + fallbackReason，消费方
 *   回退既有独立逻辑（每房间每 tick 一次重规划，失效即回退一次）。
 */

import { calcEffectiveDamage } from "@/runtime/towerControl";
import { getMemoryService } from "@/runtime/runtimeServices";

/** 保守击杀裕度：主目标累计分配伤害达到该倍数后开始向次级目标分火。 */
export const FOCUS_FIRE_KILL_OVERKILL_MARGIN = 1.15;
/** 重伤阈值：hp 缺口达到 hitsMax 的该比例才允许占用塔紧急治疗。 */
export const FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO = 0.35;
/** 紧急治疗塔数上限：不超过攻击塔数量的一半（向上取整，至少 1）。 */
export const FOCUS_FIRE_EMERGENCY_HEAL_TOWER_CAP_RATIO = 0.5;
/** 主防 Creep 的远程攻击射程（RANGED_ATTACK）。 */
const DEFENDER_RANGED_RANGE = 3;
/** 主防 Creep 的近战攻击射程（ATTACK）。 */
const DEFENDER_MELEE_RANGE = 1;

export interface FocusFireHostileSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 当前 hits。 */
  readonly hits: number;
  readonly hitsMax: number;
  /** TOUGH/boost 有效伤害比（calcEffectiveDamage(creep, total)/total；无 boost 恒 1）。 */
  readonly toughDamageRatio: number;
  /** 敌方 range-aware 治疗总量（同族 heal，含 boost；采集时一次算好）。 */
  readonly incomingHeal: number;
  /** 威胁权重（body 组成；采集时由既有 threat 语义计算）。 */
  readonly threat: number;
}

export interface FocusFireTowerSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 当前能量（0 能量塔不参与攻击分配）。 */
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
  /** 远程单 tick 输出（getActiveBodyparts(RANGED_ATTACK) × RANGED_ATTACK_POWER）。 */
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
  /** 联合预算下的主目标（null = fallbackReason 场景）。 */
  readonly focusTargetId: string | null;
  /** 主目标累计分配的联合伤害（tough 比修正后）。 */
  readonly focusAssignedDamage: number;
  /** 主目标的敌方治疗总量（预算对照）。 */
  readonly focusExpectedHeal: number;
  /** towerId → hostileId（过量伤害控制后的分火结果）。 */
  readonly towerAssignments: Readonly<Record<string, string>>;
  /** 防御者 slot → hostileId。 */
  readonly defenderAssignments: Readonly<Record<string, string>>;
  /** towerId → 重伤 creep id（紧急治疗仲裁；这些塔不参与攻击）。 */
  readonly emergencyHealByTowerId: Readonly<Record<string, string>>;
  readonly fallbackReason?: string;
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

interface HostileBudgetRow {
  readonly hostile: FocusFireHostileSnapshot;
  /** 全部 actor（塔+防御者）全力输出的有效伤害。 */
  readonly fullPower: number;
  /** 联合预算净伤害（扣治疗）。 */
  readonly net: number;
  /** 评分（净伤害优先、残血加成、威胁决胜——全部确定性）。 */
  readonly score: number;
}

/**
 * 联合伤害预算表：每个敌方单位的全火力有效伤害、净伤害与评分。
 * 评分与 towerControl.chooseFocusTarget 语义兼容（net × 1000 - hits × 0.2），
 * 增加 threat 决胜与 id 字典序终判（消除 find 顺序依赖）。
 */
function buildBudgetRows(input: FocusFireRoomInput): HostileBudgetRow[] {
  const hostiles = [...input.hostiles].sort((left, right) => left.id.localeCompare(right.id));
  const rows: HostileBudgetRow[] = [];
  for (const hostile of hostiles) {
    let fullPower = 0;
    for (const tower of input.towers) {
      if (tower.energy <= 0) continue;
      fullPower += towerAttackPowerAtRange(chebyshevRange(tower, hostile)) * hostile.toughDamageRatio;
    }
    for (const defender of input.defenders) {
      const range = chebyshevRange(defender, hostile);
      if (defender.meleeDamage > 0 && range <= DEFENDER_MELEE_RANGE) {
        fullPower += defender.meleeDamage;
      }
      if (defender.rangedDamage > 0 && range <= DEFENDER_RANGED_RANGE) {
        fullPower += defender.rangedDamage;
      }
    }
    const net = fullPower - hostile.incomingHeal;
    const score = net * 1000 - hostile.hits * 0.2 + hostile.threat - (hostile.hits < hostile.hitsMax ? 50 : 0);
    rows.push({ hostile, fullPower, net, score });
  }
  return rows;
}

/** 次级分火候选：剔除已分配主目标与净伤害非正的单位（无次级时返回 null）。 */
function pickSecondaryTarget(rows: HostileBudgetRow[], assignedIds: ReadonlySet<string>): HostileBudgetRow | null {
  const candidates = rows
    .filter((row) => !assignedIds.has(row.hostile.id) && row.net > 0)
    .sort((left, right) => right.score - left.score || left.hostile.id.localeCompare(right.hostile.id));
  return candidates[0] ?? null;
}

/** 单个 actor 对目标的有效伤害（塔按衰减 × tough 比；防御者按射程）。 */
function actorDamageToTarget(
  actor: FocusFireTowerSnapshot | FocusFireDefenderSnapshot,
  target: FocusFireHostileSnapshot,
): number {
  if ("energy" in actor) {
    if (actor.energy <= 0) return 0;
    return towerAttackPowerAtRange(chebyshevRange(actor, target)) * target.toughDamageRatio;
  }
  const range = chebyshevRange(actor, target);
  if (actor.meleeDamage > 0 && range <= DEFENDER_MELEE_RANGE) return actor.meleeDamage;
  if (actor.rangedDamage > 0 && range <= DEFENDER_RANGED_RANGE) return actor.rangedDamage;
  return 0;
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

/** 每房间每 tick 的唯一 engagement plan（纯函数——确定性输入输出）。 */
export function planRoomEngagement(input: FocusFireRoomInput, tick: number): FocusFireEngagementPlan {
  const rows = buildBudgetRows(input);
  const scored = rows
    .filter((row) => row.net > 0)
    .sort((left, right) => right.score - left.score || left.hostile.id.localeCompare(right.hostile.id));
  const primary = scored[0] ?? null;

  const emergencyHealByTowerId = planEmergencyHeal(
    input,
    input.towers.filter((tower) => tower.energy > 0).map((tower) => tower.id),
  );
  const healTowerIds = new Set(Object.keys(emergencyHealByTowerId));

  if (primary === null) {
    // fallback：联合预算无可击穿目标（治疗全覆盖或无输出）——消费方回退
    // 既有独立逻辑（spread 探测等）。
    return {
      roomName: input.roomName,
      plannedAtTick: tick,
      focusTargetId: null,
      focusAssignedDamage: 0,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      emergencyHealByTowerId,
      fallbackReason: "no-net-positive-target",
    };
  }

  // 过量伤害控制：主目标累计分配达到 hits × margin 后，追加 actor 分火
  // 次级目标（无次级候选时继续主目标——不浪费输出口）。
  const killThreshold = primary.hostile.hits * FOCUS_FIRE_KILL_OVERKILL_MARGIN;
  const towerAssignments: Record<string, string> = {};
  const defenderAssignments: Record<string, string> = {};
  const assignedHostileIds = new Set<string>([primary.hostile.id]);
  let focusAssignedDamage = 0;
  let spillTarget = pickSecondaryTarget(rows, assignedHostileIds);

  const assignActor = (
    actor: FocusFireTowerSnapshot | FocusFireDefenderSnapshot,
    assign: (targetId: string) => void,
  ): void => {
    const damageToPrimary = actorDamageToTarget(actor, primary.hostile);
    const useSpill =
      spillTarget !== null &&
      focusAssignedDamage + damageToPrimary >= killThreshold &&
      focusAssignedDamage > 0;
    if (useSpill && spillTarget !== null) {
      assign(spillTarget.hostile.id);
      return;
    }
    focusAssignedDamage += damageToPrimary;
    assign(primary.hostile.id);
  };

  // actor 处理顺序确定性：塔与防御者各自按 id 字典序。
  for (const tower of [...input.towers].sort((left, right) => left.id.localeCompare(right.id))) {
    if (tower.energy <= 0 || healTowerIds.has(tower.id)) continue;
    assignActor(tower, (targetId) => {
      towerAssignments[tower.id] = targetId;
    });
  }
  for (const defender of [...input.defenders].sort((left, right) => left.slot.localeCompare(right.slot))) {
    assignActor(defender, (targetId) => {
      defenderAssignments[defender.slot] = targetId;
    });
  }

  return {
    roomName: input.roomName,
    plannedAtTick: tick,
    focusTargetId: primary.hostile.id,
    focusAssignedDamage: Math.round(focusAssignedDamage),
    focusExpectedHeal: primary.hostile.incomingHeal,
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

export function buildFocusFireRoomInput(args: {
  readonly roomName: string;
  readonly hostiles: readonly Creep[];
  readonly towers: readonly StructureTower[];
  readonly defenders: readonly Creep[];
  readonly defenderSlots: Readonly<Record<string, string>>;
  readonly defenderRoles: Readonly<Record<string, "primary" | "secondary">>;
  readonly wounded: readonly Creep[];
}): FocusFireRoomInput {
  const { hostiles, towers } = args;
  // TOUGH/boost 有效伤害比：以全塔总伤为基准一次计算（与 towerControl 的
  // ratio 分摊语义一致）。
  const rawTotals = new Map<string, number>();
  for (const hostile of hostiles) {
    let total = 0;
    for (const tower of towers) {
      const range = Math.max(Math.abs(tower.pos.x - hostile.pos.x), Math.abs(tower.pos.y - hostile.pos.y));
      // 与 towerAttackPowerAtRange 同式（采集侧不重复展开常量逻辑）。
      total += towerAttackPowerAtRange(range);
    }
    rawTotals.set(hostile.id, total);
  }
  const hostileSnapshots: FocusFireHostileSnapshot[] = hostiles.map((hostile) => {
    const rawTotal = rawTotals.get(hostile.id) || 0;
    const effective = calcEffectiveDamage(hostile, rawTotal);
    const ratio = rawTotal > 0 ? effective / rawTotal : 1;
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
      toughDamageRatio: ratio,
      incomingHeal,
      threat: hostileThreatOf(hostile.body, (part) => hostile.getActiveBodyparts(part)),
    };
  });
  const towerSnapshots: FocusFireTowerSnapshot[] = towers.map((tower) => ({
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
