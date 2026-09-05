/**
 * Treasury 统一授权事实口径（Core Rewrite III 修订）。
 *
 * 接纳、rearm、执行前严格复验与 kernel 容量端口消费同一份判定与同一份
 * 上下文（§4.1）——上层与端口不再是两套公式：
 * - 合法管辖范围与结构身份（观察覆盖的房间/位置——由装配方在端口内检查）；
 * - 有效观察（本 tick shared observation，含有效性边界 asOfTick）；
 * - 现有资源运输承诺（pendingOutgoing 任务流出）；
 * - 合法生产 reservation（exact owner 可排除自己的那一项）；
 * - policy/withhold（resolver 缺失/抛错/非法 fail closed；scope 合计）；
 * - 活跃聚合占用投影（pending/dispatching/unknown + **未被当前观察覆盖的
 *   已确认效果**——流出占存量、流入占接收容量）。
 *
 * 同一责任唯一扣减归属（§6.1，III 修订）：
 * - pending/dispatching/unknown → kernel 占用（active 权威）；
 * - committed 且效果未被观察覆盖（observedAtTick ≤ invocation.atTick）→
 *   同一 kernel 占用（原聚合继续承担——多实例/reset 无责任空窗）；
 * - committed 且效果已被观察覆盖 → 刷新后的观察（不再扣占用）；
 * - not_executed → 无责任。
 * 实例本地 applied overlay 不参与授权判定（R5：它不能是已确认效果的
 * 唯一安全载体），仅作查询展示缓存。
 *
 * Policy 累计语义（R1/§4.2）：reserve 对 (resource, rooms scope) 有效。
 * 可供新工作使用的额度 = scope 合计观察 − scope 合计占用 − scope 合计
 * 业务承诺 − scope 合计生产预留 − 保留额；比较对象是**该资源候选流出的
 * scope 合计**（跨房间累计，同一范围多条候选共同消费政策余量，共享池
 * 不按房间复制余额）。物理位置约束（第 1/2 段）与范围保留额约束同时成立。
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
  /** 观察（本 tick shared observation；有效性边界由装配方持有）。 */
  readonly observedAmount: (roomName: string, locationKind: string, resource: string) => number;
  readonly observedFreeCapacity: (roomName: string, locationKind: string) => number;
  /** kernel 活跃占用投影（含未被观察覆盖的已确认效果；facade 传 asOfTick）。 */
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
 * 接纳、rearm、kernel 容量端口与执行前复验共用（§4.1）；宽松展示选项
 * （projected/incoming）不经过本函数——它们不授予可花费资产。
 */
export function evaluateTreasuryAdmissionFacts(
  sources: TreasuryAdmissionFactSources,
  legs: readonly TreasuryCandidateLeg[],
  options: { readonly excludeOwner?: TreasuryOwnerIdentity },
): TreasuryAdmissionVerdict {
  if (legs.length === 0) {
    return { status: "rejected", reasonCode: "invalid_input", reason: "候选 posting 腿为空" };
  }
  // 1) per (room, loc, res) 流出合计 ×（存量观察 − 占用 − 承诺 − 预留）。
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
      sources.observedAmount(leg.roomName, leg.locationKind, leg.resource) -
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
  // 2) per (room, loc) 流入合计 × 接收容量（unknown 与未覆盖 committed 的
  //    可能流入占接收空间，不成为可花费资产——§6.1）。
  for (const leg of inflowByLocation.values()) {
    const freeCapacity =
      sources.observedFreeCapacity(leg.roomName, leg.locationKind) -
      sources.occupancyInflow(leg.roomName, leg.locationKind);
    if (leg.amount > freeCapacity) {
      return {
        status: "rejected",
        reasonCode: "capacity_insufficient",
        reason: `接收容量不足：${leg.roomName}/${leg.locationKind} 剩余 ${String(freeCapacity)} < 本笔最坏流入 ${String(leg.amount)}`,
      };
    }
  }
  // 3) policy/withhold：scope 合计累计口径（R1/§4.2）——同一范围的多条
  //    候选腿合并消费政策余量；其他活动责任（占用/承诺/预留）在同一
  //    scope 口径下扣除一次，不按房间复制、不逐腿重复。
  const rooms = [...new Set(legs.map((leg) => leg.roomName))];
  const LOCATION_KINDS = ["storage", "terminal"] as const;
  for (const resource of new Set(legs.filter((l) => l.delta < 0).map((l) => l.resource))) {
    const decision = sources.policyReserve(resource, rooms);
    if (decision.status === "rejected") {
      return { status: "rejected", reasonCode: decision.reasonCode, reason: decision.reason };
    }
    if (decision.reserve <= 0) continue;
    let observedScope = 0;
    let occupiedScope = 0;
    let committedScope = 0;
    let reservedScope = 0;
    for (const roomName of rooms) {
      for (const kind of LOCATION_KINDS) {
        observedScope += sources.observedAmount(roomName, kind, resource);
        occupiedScope += sources.occupancyOutflow(roomName, kind, resource);
      }
      committedScope += sources.committedOutgoing(roomName, resource);
      reservedScope += sources.reservedProduction(roomName, resource, options.excludeOwner);
    }
    // 候选在该 scope 的累计流出（跨房间合计——共享池不按房间复制余额）。
    let candidateScope = 0;
    for (const leg of outflowByKey.values()) {
      if (leg.resource === resource) candidateScope += leg.amount;
    }
    const available = observedScope - occupiedScope - committedScope - reservedScope - decision.reserve;
    if (candidateScope > available) {
      return {
        status: "rejected",
        reasonCode: "insufficient_amount",
        reason:
          `policy 额度不足：${resource} scope 合计可支配 ${String(Math.max(0, available))}` +
          `（观察 ${String(observedScope)} − 占用 ${String(occupiedScope)} − 承诺 ${String(committedScope)} − 预留 ${String(reservedScope)} − policy 保留 ${String(decision.reserve)}）` +
          ` < 累计最坏流出 ${String(candidateScope)}`,
      };
    }
  }
  return { status: "ok" };
}
