/**
 * 【Round 22 Remediation IV 十六 + V 十】room-level fallback revision——目标
 * 失效时的一次性房间级修订计划（per-defender 独立位置重新分配）。
 *
 * Remediation III 的共享 fallback 只解析一个房间级 targetId；Remediation IV
 * 升级为房间级修订计划，但 Defender 的修订位置仍从 plan.
 * engagementByTargetId[target] 复制 target-level 单一位置——多 Defender 同
 * revised target 时重新产生 Rampart 冲突。
 *
 * 【Remediation V 十】本模块在第一次房间级修订生成时对整个房间的 Defender
 * 集合重新执行 actor-specific position allocation（allocate 单一实现）：
 *
 *  - 原 assignment 仍有效的 Defender：保留原 target 与原独立位置（不重排）
 *    ——原位置先占 used 集合（合法、未冲突才保留）；
 *  - 目标失效的 Defender：只从 front-local alive targets 选择替代；boundary
 *    target 使用 plan 持久化的候选 Rampart 集合（engagementCandidatesByTargetId
 *    ——含他属占用标记），房间级单次分配中共享 used-position 集合；
 *  - occupied candidate 跳过；候选不足时明确 hold（保留 combat target）；
 *  - inside target 不携带位置——消费方按当前可执行距离重算 action mode
 *    （不错误复用原目标的 mode）；
 *  - Tower 修订目标与紧急治疗 assignment 原样保留（plan 权威）；
 *  - Tower 与 Defender 消费同一 revision（任意顺序请求得到同一对象）。
 *
 * 每房间每 tick 至多生成一次（写回 plan，计数有界）；不调用 PathFinder、
 * 不建立第二套防线模型。
 */

import { allocateDefenderRampartPositions } from "@/runtime/defenderRampartAllocation";

import { readRoomEngagementPlan, type FocusFireEngagementPlan } from "@/runtime/defenseFocusFire";

/** fallback 修订计划中单个 Defender 的 assignment。 */
export interface FocusFireFallbackDefenderEngagement {
  /** 修订后的 combat target（null = 本 tick hold——无合法 front-local 替代）。 */
  readonly targetId: string | null;
  /**
   * 修订后的 action mode（engage_position=boundary 独立站位 / inside 由消费方按距离重算；hold=无合法位置或无替代；
   * attack/ranged_attack=unaffected direct actor 的原动作保留——其 Rampart
   * 已在 used-position 集合，不得被 replacement 抢占）。
   */
  readonly mode: "engage_position" | "hold" | "attack" | "ranged_attack";
  /** 修订后的独立接敌位置（boundary engage_position 时必带——per-defender 唯一）。 */
  readonly position?: { readonly x: number; readonly y: number };
  readonly positionKind?: "inside" | "boundary";
  /** 【Remediation VI 6.3】unaffected direct actor 的 Rampart 保留事实（原样透传）。 */
  readonly reservedPosition?: { readonly x: number; readonly y: number };
}

/** 房间级 fallback 修订计划（Tower 与 Defender 共同消费）。 */
export interface FocusFireFallbackRevision {
  readonly tick: number;
  readonly towerTargetByTowerId: Readonly<Record<string, string | null>>;
  readonly defenderEngagementBySlot: Readonly<Record<string, FocusFireFallbackDefenderEngagement>>;
  /** 保持的紧急治疗 assignment（plan 权威——不因 target 失效改变）。 */
  readonly emergencyHealByTowerId: Readonly<Record<string, string>>;
  /** 本 tick 消费计数（诊断/测试）。 */
  requests: number;
}

interface RuntimeMemoryWithEngagementRevision {
  defenseEngagement?: Record<string, FocusFireEngagementPlan & { fallbackRevision?: FocusFireFallbackRevision }>;
}

function planWithRevision(
  roomName: string,
): (FocusFireEngagementPlan & { fallbackRevision?: FocusFireFallbackRevision }) | null {
  const plan = (Memory.runtime as RuntimeMemoryWithEngagementRevision | undefined)?.defenseEngagement?.[roomName];
  return plan && plan.plannedAtTick === Game.time ? plan : null;
}

function firstAliveInOrder(order: readonly string[], alive: ReadonlySet<string>, exclude: ReadonlySet<string>): string | null {
  for (const candidate of order) {
    if (exclude.has(candidate)) continue;
    if (alive.has(candidate)) return candidate;
  }
  return null;
}

/** plan 持久化的接敌位置事实（target-level——仅作为 inside/无候选退化视图）。 */
function planEngagementOfTarget(
  plan: FocusFireEngagementPlan,
  targetId: string,
): { x: number; y: number; kind: "inside" | "boundary" } | undefined {
  const engagement = plan.engagementByTargetId?.[targetId];
  return engagement !== undefined && (engagement.kind === "inside" || engagement.kind === "boundary")
    ? { x: engagement.x, y: engagement.y, kind: engagement.kind }
    : undefined;
}

/**
 * 目标失效时的房间级修订：第一次请求生成完整 revision（全部参与 actor 的
 * 修订目标 + per-defender 独立位置重新分配），后续请求（Tower / Defender
 * 任意顺序）读同一 revision。stale plan / 无 plan → 空 revision 语义由调用方
 * 按既有安全 fallback 处理（返回 fromCache=false 且 revision=null——调用方
 * 不得据此回退独立评分）。
 */
export function resolveRoomEngagementFallbackRevision(
  roomName: string,
  failedTargetIds: readonly string[],
  aliveHostileIds: ReadonlySet<string>,
): { readonly revision: FocusFireFallbackRevision | null; readonly fromCache: boolean } {
  const plan = planWithRevision(roomName);
  if (!plan) return { revision: null, fromCache: false };
  if (plan.fallbackRevision && plan.fallbackRevision.tick === Game.time) {
    plan.fallbackRevision.requests += 1;
    return { revision: plan.fallbackRevision, fromCache: true };
  }
  const failed = new Set(failedTargetIds);
  // Tower：全房间最佳替代（候选顺序 = plan 的分类桶排序）。
  const towerTarget = firstAliveInOrder(plan.fallbackTargetIds, aliveHostileIds, failed);
  // ── Defender 集合的房间级修订（front-local 替代 + 位置保留/重新分配）。
  // 1. 决定每个 slot 的修订 target：原 target 有效 → 保留；失效 →
  //    front-local alive 替代；无替代 → null（hold）。
  interface RevisedSlot {
    readonly slot: string;
    readonly targetId: string | null;
    /** 原 assignment 是否保留（unaffected——原位置优先保留）。 */
    readonly retained: boolean;
    readonly boundary: boolean;
    /** 修订 target 的接敌位置事实（plan 持久——boundary 候选优先）。 */
    readonly engagement: { x: number; y: number; kind: "inside" | "boundary" } | undefined;
    readonly originalPosition: { readonly x: number; readonly y: number } | undefined;
    readonly originalPositionKind: "inside" | "boundary" | undefined;
    /** 【Remediation VI 6.3】unaffected 的原 action mode（direct actor 保留原动作）。 */
    readonly originalMode: "attack" | "ranged_attack" | "engage_position" | "hold" | undefined;
    /** 【Remediation VI 6.3】unaffected direct actor 的 Rampart 保留事实。 */
    readonly reservedPosition: { readonly x: number; readonly y: number } | undefined;
  }
  const slots = Object.keys(plan.defenderFronts ?? {}).sort((left, right) => left.localeCompare(right));
  const revisedSlots: RevisedSlot[] = [];
  for (const slot of slots) {
    const front = plan.defenderFronts![slot]!;
    const original = plan.defenderEngagements?.[slot];
    const originalTargetId = original?.targetId ?? null;
    const originalAlive = originalTargetId !== null && aliveHostileIds.has(originalTargetId) && !failed.has(originalTargetId);
    if (originalAlive) {
      const engagement = planEngagementOfTarget(plan, originalTargetId!);
      revisedSlots.push({
        slot,
        targetId: originalTargetId,
        retained: true,
        boundary: original?.positionKind === "boundary",
        engagement,
        originalPosition: original?.position,
        originalPositionKind: original?.positionKind,
        originalMode: original?.mode,
        reservedPosition: original?.reservedPosition,
      });
      continue;
    }
    // 原 target 失效：front-local 替代（eligible 集合 ∩ 存活；不跨 front）。
    const eligibleOrder = plan.fallbackTargetIds.filter((id) => front.eligibleTargetIds.includes(id));
    const revised = firstAliveInOrder(eligibleOrder, aliveHostileIds, failed);
    revisedSlots.push({
      slot,
      targetId: revised,
      retained: false,
      boundary: revised !== null && planEngagementOfTarget(plan, revised)?.kind === "boundary",
      engagement: revised !== null ? planEngagementOfTarget(plan, revised) : undefined,
      originalPosition: undefined,
      originalPositionKind: undefined,
      originalMode: undefined,
      reservedPosition: undefined,
    });
  }
  // 2. 房间级 used-position 初始化：
  //    - unaffected Defender 的原独立位置优先保留（合法 boundary 位置先占
  //      ——不被替代分配抢占）；
  //    - 【Remediation VI 6.3】unaffected direct actor（attack/ranged_attack）
  //      的 reservedPosition 同样进入 used 集合——revision 不得把该 Rampart
  //      分给 replacement Defender（D4：fallback 不抢 unaffected actor 的位置）。
  const usedPositionKeys = new Set<string>();
  const planCandidateKeys = new Set<string>();
  for (const candidates of Object.values(plan.engagementCandidatesByTargetId ?? {})) {
    for (const candidate of candidates) {
      planCandidateKeys.add(`${candidate.x},${candidate.y}`);
    }
  }
  for (const item of revisedSlots) {
    if (item.retained && item.originalPosition !== undefined) {
      usedPositionKeys.add(`${item.originalPosition.x},${item.originalPosition.y}`);
    }
    if (item.retained && item.reservedPosition !== undefined) {
      usedPositionKeys.add(`${item.reservedPosition.x},${item.reservedPosition.y}`);
    }
    // 【Remediation VII 修复】第三路：retained stationary 且无 reservedPosition
    //（旧 plan 数据 / planner 保留事实缺失）——hold 的真实坐标来自 plan
    // 持久化的 defender facts；坐标命中 plan 任一候选集时进入 used 集合
    //（unaffected hold Defender 的脚下 Rampart 不被 replacement 抢占）。
    if (item.retained && item.reservedPosition === undefined && item.originalMode === "hold") {
      const facts = plan.defenderFactsBySlot?.[item.slot];
      if (facts !== undefined && planCandidateKeys.has(`${facts.x},${facts.y}`)) {
        usedPositionKeys.add(`${facts.x},${facts.y}`);
      }
    }
  }
  // 3. 需要重新分配独立位置的 Defender（替代 boundary target 者）进入统一
  //    allocate：候选 = plan 持久化的该 target 候选集合（occupied 跳过；
  //    候选缺失退化为 plan 的 target-level 单一 engagement 位置——单候选
  //    只分配一名，其余 hold）；unaffected 已占位置不可再分配。
  //    【Remediation VI 6.3】真实 role/坐标来自 plan 持久化的 defender
  //    facts（planner 输入快照）——按真实 actor 位置评分（不用 target
  //    anchor 近似、不硬编码 secondary）；旧 plan 无 facts 时回落 anchor。
  let reallocationInput: { slot: string; role: "primary" | "secondary"; x: number; y: number; targetId: string }[] = [];
  for (const item of revisedSlots) {
    if (!item.retained && item.targetId !== null && item.boundary) {
      const facts = plan.defenderFactsBySlot?.[item.slot];
      const anchor = item.engagement ?? { x: 0, y: 0, kind: "boundary" as const };
      reallocationInput.push({
        slot: item.slot,
        role: facts?.role ?? "secondary",
        x: facts?.x ?? anchor.x,
        y: facts?.y ?? anchor.y,
        targetId: item.targetId,
      });
    }
  }
  // ──【Remediation VIII 工作流 F】replacement 的物理 Rampart ownership：
  //    replacement Defender 站在**自己 revised target** 的未占用候选上时
  //    直接 claim（engage_position = 当前 tile + used 集合——occupant 优先
  //    保留自己的位置，不进 allocator；D11/D12 的晚绑定冲突在 allocate
  //    之前消除）。claim 按 slot 字典序（reallocationInput 构造自排序的
  //    revisedSlots——确定性）。站在别的 target 候选的成员照常进入
  //    allocator；变 hold 时的脚下保留由下方 D5 分支回填承载。
  const claimedPositions = new Map<string, { x: number; y: number }>();
  {
    const availableCandidatesOf = (targetId: string): { id: string; x: number; y: number }[] => {
      const persisted = plan.engagementCandidatesByTargetId?.[targetId];
      if (persisted !== undefined && persisted.length > 0) {
        return persisted
          .filter((candidate) => candidate.occupied !== true)
          .filter((candidate) => !usedPositionKeys.has(`${candidate.x},${candidate.y}`))
          .map((candidate) => ({ id: candidate.id, x: candidate.x, y: candidate.y }));
      }
      const engagement = planEngagementOfTarget(plan, targetId);
      if (engagement !== undefined && !usedPositionKeys.has(`${engagement.x},${engagement.y}`)) {
        return [{ id: `pos:${engagement.x},${engagement.y}`, x: engagement.x, y: engagement.y }];
      }
      return [];
    };
    const stillAllocating: typeof reallocationInput = [];
    for (const item of reallocationInput) {
      const ownCandidate = availableCandidatesOf(item.targetId).find(
        (candidate) => candidate.x === item.x && candidate.y === item.y,
      );
      if (ownCandidate !== undefined) {
        claimedPositions.set(item.slot, { x: item.x, y: item.y });
        usedPositionKeys.add(`${item.x},${item.y}`);
        continue;
      }
      stillAllocating.push(item);
    }
    reallocationInput = stillAllocating;
  }
  let allocation: Record<string, { id: string; x: number; y: number; occupied?: boolean }> = {};
  if (reallocationInput.length > 0) {
    const candidatesByTargetId: Record<string, { id: string; x: number; y: number; occupied?: boolean }[]> = {};
    const targetPositionById: Record<string, { x: number; y: number }> = {};
    for (const item of revisedSlots) {
      if (item.retained || item.targetId === null || !item.boundary) continue;
      const persisted = plan.engagementCandidatesByTargetId?.[item.targetId];
      if (persisted !== undefined && persisted.length > 0) {
        candidatesByTargetId[item.targetId] = persisted
          .filter((candidate) => candidate.occupied !== true)
          .filter((candidate) => !usedPositionKeys.has(`${candidate.x},${candidate.y}`))
          .map((candidate) => ({ id: candidate.id, x: candidate.x, y: candidate.y }));
      } else if (item.engagement !== undefined) {
        // 候选集合未持久化（采集层退化）：单一 target-level 位置候选。
        candidatesByTargetId[item.targetId] = [
          ...(usedPositionKeys.has(`${item.engagement.x},${item.engagement.y}`)
            ? []
            : [{ id: `pos:${item.engagement.x},${item.engagement.y}`, x: item.engagement.x, y: item.engagement.y }]),
        ];
      }
      if (item.engagement !== undefined) {
        targetPositionById[item.targetId] = { x: item.engagement.x, y: item.engagement.y };
      }
    }
    allocation = allocateDefenderRampartPositions({
      defenders: reallocationInput,
      candidatesByTargetId,
      targetPositionById,
    });
  }
  // 4. 生成 per-slot 修订 assignment：retained 保留原位置（direct actor 保留
  //    原动作与 Rampart 保留事实）；替代 boundary 用 allocate 结果（无 →
  //    hold——保留 combat target）；inside 不带位置（消费方按当前距离重算
  //    mode）。
  const defenderEngagementBySlot: Record<string, FocusFireFallbackDefenderEngagement> = {};
  for (const item of revisedSlots) {
    if (item.targetId === null) {
      defenderEngagementBySlot[item.slot] = { targetId: null, mode: "hold" };
      continue;
    }
    if (item.retained) {
      // 【Remediation VI 6.3】unaffected direct actor（attack/ranged_attack）
      // 保留原动作（不因 fallback 停止攻击）；其 reservedPosition 已进
      // used 集合并原样透传（消费方据此知道该 Rampart 被保留）。
      if (item.originalMode === "attack" || item.originalMode === "ranged_attack") {
        defenderEngagementBySlot[item.slot] = {
          targetId: item.targetId,
          mode: item.originalMode,
          ...(item.reservedPosition !== undefined ? { reservedPosition: { x: item.reservedPosition.x, y: item.reservedPosition.y } } : {}),
        };
        continue;
      }
      // 【Remediation VII 修复】retained hold 保持 hold（不再错误改写为无
      // 位置的 engage_position——那会让消费方回落 target-level 单一位置，
      // 重新制造共享位置冲突）；真实坐标保留事实随 facts 透传（脚下合法
      // Rampart 继续进入 used 权威，hold actor 不被迫移动）。
      if (item.originalMode === "hold") {
        const facts = plan.defenderFactsBySlot?.[item.slot];
        const stationaryReserved =
          item.reservedPosition !== undefined
            ? item.reservedPosition
            : facts !== undefined && planCandidateKeys.has(`${facts.x},${facts.y}`)
              ? { x: facts.x, y: facts.y }
              : undefined;
        defenderEngagementBySlot[item.slot] = {
          targetId: item.targetId,
          mode: "hold",
          ...(stationaryReserved !== undefined ? { reservedPosition: { x: stationaryReserved.x, y: stationaryReserved.y } } : {}),
        };
        continue;
      }
      defenderEngagementBySlot[item.slot] = {
        targetId: item.targetId,
        mode: "engage_position",
        ...(item.originalPosition !== undefined ? { position: { x: item.originalPosition.x, y: item.originalPosition.y } } : {}),
        ...(item.originalPositionKind !== undefined ? { positionKind: item.originalPositionKind } : {}),
      };
      continue;
    }
    if (item.boundary) {
      const claimed = claimedPositions.get(item.slot);
      if (claimed !== undefined) {
        // 【VIII F】replacement 的 physical claim（occupant 保留自己脚下
        // 的合法候选——engage_position + reservedPosition）。
        defenderEngagementBySlot[item.slot] = {
          targetId: item.targetId,
          mode: "engage_position",
          position: { x: claimed.x, y: claimed.y },
          positionKind: "boundary",
          reservedPosition: { x: claimed.x, y: claimed.y },
        };
        continue;
      }
      const allocated = allocation[item.slot];
      if (allocated !== undefined) {
        defenderEngagementBySlot[item.slot] = { targetId: item.targetId, mode: "engage_position", position: { x: allocated.x, y: allocated.y }, positionKind: "boundary" };
        continue;
      }
      // 【Remediation VII 修复 D5】替代无合法候选 → 明确 hold；actor 当前
      // 已站在合法候选 Rampart 上时保留当前位置事实（reservedPosition——
      // 不输出无位置的 hold 让消费方回落共享位置；hold actor 不被迫移动）。
      const facts = plan.defenderFactsBySlot?.[item.slot];
      const currentOnCandidate = facts !== undefined && planCandidateKeys.has(`${facts.x},${facts.y}`) ? { x: facts.x, y: facts.y } : undefined;
      defenderEngagementBySlot[item.slot] = {
        targetId: item.targetId,
        mode: "hold",
        ...(currentOnCandidate !== undefined ? { reservedPosition: currentOnCandidate } : {}),
      };
      continue;
    }
    // inside（或无站位信息）：不带位置——消费方按当前可执行距离重算 action
    // mode（不错误复用原目标的 mode）。
    defenderEngagementBySlot[item.slot] = {
      targetId: item.targetId,
      mode: "engage_position",
      ...(item.engagement !== undefined ? { positionKind: "inside" } : {}),
    };
  }
  const revision: FocusFireFallbackRevision = {
    tick: Game.time,
    towerTargetByTowerId: Object.fromEntries(
      Object.keys(plan.towerAssignments).map((towerId) => [towerId, towerTarget]),
    ),
    defenderEngagementBySlot,
    emergencyHealByTowerId: plan.emergencyHealByTowerId,
    requests: 1,
  };
  plan.fallbackRevision = revision;
  return { revision, fromCache: false };
}

/** 【兼容/诊断】读取当前 revision（无 / stale → null）。 */
export function peekRoomEngagementFallbackRevision(roomName: string): FocusFireFallbackRevision | null {
  const plan = planWithRevision(roomName);
  if (!plan?.fallbackRevision || plan.fallbackRevision.tick !== Game.time) return null;
  return plan.fallbackRevision;
}
