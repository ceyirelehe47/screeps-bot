/**
 * 【Round 22 Remediation IV 十六】room-level fallback revision——目标失效时
 * 的一次性房间级修订计划。
 *
 * Remediation III 的共享 fallback 只解析一个房间级 targetId（fallback
 * Resolution.resolvedTargetId）：多 front / per-defender 独立位置 / 多个
 * assigned target 同时失效时，单一缓存 target 不能表达各 actor 的修订
 * （第一个请求者决定缓存、后续 actor 消费可能错误的共享目标——南
 * Defender 的失败可能把北 Defender 错误转到南 front）。
 *
 * 本模块生成一次房间级修订计划（每房间每 tick 至多一次——plan 运行期
 * 写回，计数有界）：
 *  - Tower：全房间修订目标（fallback 候选顺序 ∩ 存活集合的首个）或 null
 *    （明确 idle——不回退独立评分）；
 *  - Defender：front-local 修订目标（其 eligible 集合 ∩ 存活集合，按计划
 *    候选顺序）或 null（hold——不跨 front、不回退独立选敌）；
 *  - 紧急治疗 assignment 原样保留（plan 权威）；
 *  - Tower 与 Defender 消费同一 revision（多 consumer 只触发一次生成）。
 */

import { readRoomEngagementPlan, type FocusFireEngagementPlan } from "@/runtime/defenseFocusFire";

/** fallback 修订计划中单个 Defender 的 assignment。 */
export interface FocusFireFallbackDefenderEngagement {
  /** 修订后的 combat target（null = 本 tick hold——无合法 front-local 替代）。 */
  readonly targetId: string | null;
  /** 修订后的接敌位置（有 target 时携带 plan 的位置事实）。 */
  readonly position?: { readonly x: number; readonly y: number };
  readonly positionKind?: "inside" | "boundary";
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

/**
 * 目标失效时的房间级修订：第一次请求生成完整 revision（全部参与 actor 的
 * 修订目标），后续请求（Tower / Defender 任意顺序）读同一 revision。
 * stale plan / 无 plan → 空 revision 语义由调用方按既有安全 fallback
 * 处理（返回 fromCache=false 且各映射为空——调用方不得据此回退独立评分）。
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
  // Defender：front-local 替代（eligible 集合 ∩ 存活；不跨 front）。
  const defenderEngagementBySlot: Record<string, FocusFireFallbackDefenderEngagement> = {};
  for (const [slot, front] of Object.entries(plan.defenderFronts ?? {})) {
    const eligibleOrder = plan.fallbackTargetIds.filter((id) => front.eligibleTargetIds.includes(id));
    const revised = firstAliveInOrder(eligibleOrder, aliveHostileIds, failed);
    const engagement = revised !== null ? plan.engagementByTargetId[revised] : undefined;
    defenderEngagementBySlot[slot] = {
      targetId: revised,
      ...(revised !== null && engagement !== undefined
        ? { position: { x: engagement.x, y: engagement.y }, positionKind: engagement.kind }
        : {}),
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
