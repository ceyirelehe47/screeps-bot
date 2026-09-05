/**
 * Treasury 统一授权事实口径（Core Rewrite II 工作流 B）。
 *
 * 查询中的严格可授权结果、普通接纳（authorize）、rearm 新代与执行前
 * 复验使用同一套业务语义（design II §5.1）——不再复制公式：
 * - 合法管辖范围与结构身份（观察覆盖的房间/位置）；
 * - 有效观察（本 tick shared observation）；
 * - 本 tick 已确定变化（applied overlay：已发生的世界效果）；
 * - 现有资源运输承诺（pendingOutgoing 任务流出）；
 * - 合法生产 reservation（exact owner 可排除自己的那一项）；
 * - policy/withhold（resolver 缺失/抛错/非法 fail closed）；
 * - 活动 pending/dispatching/unknown 的风险（kernel 占用投影：流出占存量、
 *   流入占接收容量）。
 *
 * 同一责任唯一扣减归属（§5.2）：
 * - pending/dispatching/unknown → kernel 占用（active 权威）；
 * - committed（同 tick）→ applied overlay（世界效果已发生，观察 stale）；
 * - committed（跨 tick 后）→ 刷新后的观察；
 * - not_executed → 无责任。
 * 不存在 tentative 与 active 的双份表达，也不把同一笔 outflow 同时算进
 * 多个桶（B09 双扣对照）。
 */

import type { TreasuryCoreWorstCaseLeg } from "@/runtime/treasury/kernel/types";
import type { TreasuryOwnerIdentity } from "@/runtime/treasury/ownerIdentity";

/** 候选动作的原始 posting 腿（未合并；同键流出与流入分别承担风险）。 */
export interface TreasuryCandidateLeg {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  readonly delta: number;
}

/** 授权事实来源（facade 装配；本模块只消费，不做 IO）。 */
export interface TreasuryAdmissionFactSources {
  /** 观察（本 tick shared observation）。 */
  readonly observedAmount: (roomName: string, locationKind: string, resource: string) => number;
  readonly observedFreeCapacity: (roomName: string, locationKind: string) => number;
  /** 本 tick 已发生的世界效果（applied overlay；净 delta，流入为正）。 */
  readonly appliedResourceDelta: (roomName: string, locationKind: string, resource: string) => number;
  /** 本 tick 已发生的容量占用（applied overlay 正流入）。 */
  readonly appliedCapacityUsed: (roomName: string, locationKind: string) => number;
  /** kernel 活跃占用投影（跨 tick 风险）。 */
  readonly occupancyOutflow: (roomName: string, locationKind: string, resource: string) => number;
  readonly occupancyInflow: (roomName: string, locationKind: string) => number;
  /** 业务承诺：任务流出（资源运输承诺）。 */
  readonly committedOutgoing: (roomName: string, resource: string) => number;
  /** 业务承诺：合法生产预留（exact owner 验证后可排除自己的那一项）。 */
  readonly reservedProduction: (roomName: string, resource: string, excludeOwner?: TreasuryOwnerIdentity) => number;
  /** policy per (resource, rooms)：返回 withhold+reserve 合计；异常由装配方 fail closed。 */
  readonly policyReserve: (resource: string, rooms: readonly string[]) =>
    | { readonly status: "ok"; readonly reserve: number }
    | { readonly status: "rejected"; readonly reasonCode: "policy_unavailable" | "policy_fault" | "policy_violation" | "insufficient_amount"; readonly reason: string };
}

export type TreasuryAdmissionVerdict =
  | { readonly status: "ok" }
  | { readonly status: "rejected"; readonly reasonCode: string; readonly reason: string };

/** 同键分方向合计：流出腿与流入腿各一条（不确定的流出不抵消不确定的流入）。 */
export function treasuryWorstCaseOfPostings(postings: readonly TreasuryCandidateLeg[]): TreasuryCoreWorstCaseLeg[] {
  const keyOf = (leg: TreasuryCandidateLeg): string => `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
  const outflows = new Map<string, { roomName: string; locationKind: string; resource: string; out: number }>();
  const inflows = new Map<string, { roomName: string; locationKind: string; resource: string; in: number }>();
  for (const leg of postings) {
    const key = keyOf(leg);
    if (leg.delta < 0) {
      const existing = outflows.get(key);
      outflows.set(key, {
        roomName: leg.roomName,
        locationKind: leg.locationKind,
        resource: leg.resource,
        out: (existing?.out ?? 0) + -leg.delta,
      });
    } else if (leg.delta > 0) {
      const existing = inflows.get(key);
      inflows.set(key, {
        roomName: leg.roomName,
        locationKind: leg.locationKind,
        resource: leg.resource,
        in: (existing?.in ?? 0) + leg.delta,
      });
    }
  }
  const legs: TreasuryCoreWorstCaseLeg[] = [];
  for (const [key, leg] of outflows) {
    legs.push({ roomName: leg.roomName, locationKind: leg.locationKind, resource: leg.resource, delta: -leg.out });
    void key;
  }
  for (const [key, leg] of inflows) {
    legs.push({ roomName: leg.roomName, locationKind: leg.locationKind, resource: leg.resource, delta: leg.in });
    void key;
  }
  return legs;
}

/**
 * 共同授权判定：对候选原始腿全集做流出/流入/承诺/policy 检查。
 * 接纳、rearm 与严格查询共用（§5.1）；宽松展示选项（projected/incoming）
 * 不经过本函数——它们不授予可花费资产。
 */
export function evaluateTreasuryAdmissionFacts(
  sources: TreasuryAdmissionFactSources,
  legs: readonly TreasuryCandidateLeg[],
  options: { readonly excludeOwner?: TreasuryOwnerIdentity },
): TreasuryAdmissionVerdict {
  if (legs.length === 0) {
    return { status: "rejected", reasonCode: "invalid_input", reason: "候选 posting 腿为空" };
  }
  // 1) per (room, loc, res) 流出合计 ×（存量观察 + applied − 占用 − 承诺 − 预留）。
  const outflowByKey = new Map<string, { roomName: string; locationKind: string; resource: string; amount: number }>();
  const inflowByLocation = new Map<string, { roomName: string; locationKind: string; amount: number }>();
  for (const leg of legs) {
    if (leg.delta < 0) {
      const key = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      const existing = outflowByKey.get(key);
      outflowByKey.set(key, {
        roomName: leg.roomName,
        locationKind: leg.locationKind,
        resource: leg.resource,
        amount: (existing?.amount ?? 0) + -leg.delta,
      });
    } else if (leg.delta > 0) {
      const key = `${leg.roomName}\u0000${leg.locationKind}`;
      const existing = inflowByLocation.get(key);
      inflowByLocation.set(key, {
        roomName: leg.roomName,
        locationKind: leg.locationKind,
        amount: (existing?.amount ?? 0) + leg.delta,
      });
    }
  }
  for (const leg of outflowByKey.values()) {
    const available =
      sources.observedAmount(leg.roomName, leg.locationKind, leg.resource) +
      sources.appliedResourceDelta(leg.roomName, leg.locationKind, leg.resource) -
      sources.occupancyOutflow(leg.roomName, leg.locationKind, leg.resource) -
      sources.committedOutgoing(leg.roomName, leg.resource) -
      sources.reservedProduction(leg.roomName, leg.resource, options.excludeOwner);
    if (leg.amount > available) {
      return {
        status: "rejected",
        reasonCode: "capacity_insufficient",
        reason: `容量不足：${leg.roomName}/${leg.locationKind}/${leg.resource} 可用 ${String(available)} < 最坏流出 ${String(leg.amount)}`,
      };
    }
  }
  // 2) per (room, loc) 流入合计 × 接收容量（unknown 的可能流入占接收空间，
  //    不成为可花费资产——§5.2）。
  for (const leg of inflowByLocation.values()) {
    const freeCapacity =
      sources.observedFreeCapacity(leg.roomName, leg.locationKind) -
      sources.appliedCapacityUsed(leg.roomName, leg.locationKind) -
      sources.occupancyInflow(leg.roomName, leg.locationKind);
    if (leg.amount > freeCapacity) {
      return {
        status: "rejected",
        reasonCode: "capacity_insufficient",
        reason: `接收容量不足：${leg.roomName}/${leg.locationKind} 剩余 ${String(freeCapacity)} < 本笔最坏流入 ${String(leg.amount)}`,
      };
    }
  }
  // 3) policy/withhold（per resource；房间合计观察 − 保留额 ≥ 最坏流出）。
  const rooms = [...new Set(legs.map((leg) => leg.roomName))];
  for (const resource of new Set(legs.map((leg) => leg.resource))) {
    const decision = sources.policyReserve(resource, rooms);
    if (decision.status === "rejected") {
      return { status: "rejected", reasonCode: decision.reasonCode, reason: decision.reason };
    }
    if (decision.reserve <= 0) continue;
    for (const leg of outflowByKey.values()) {
      if (leg.resource !== resource) continue;
      let roomObserved = 0;
      for (const kind of ["storage", "terminal"] as const) {
        roomObserved += sources.observedAmount(leg.roomName, kind, resource);
      }
      if (roomObserved - decision.reserve < leg.amount) {
        return {
          status: "rejected",
          reasonCode: "insufficient_amount",
          reason:
            `policy 额度不足：${resource} 可支配 ${String(Math.max(0, roomObserved - decision.reserve))}` +
            `（policy 保留 ${String(decision.reserve)}）< 最坏流出 ${String(leg.amount)}`,
        };
      }
    }
  }
  return { status: "ok" };
}
