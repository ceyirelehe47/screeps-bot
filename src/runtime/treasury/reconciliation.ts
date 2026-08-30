/**
 * Treasury service-issued reconciliation capability（第八轮）。
 *
 * 角色：resolution 结论的**唯一合法来源**是当前 Treasury service 基于 exact
 * post-fault observation 与受注册 action reconciler 的判定——普通调用者不得
 * 自行填写 conclusion/observationTick。本模块承载 capability 类型、模块级
 * 私有 registry（WeakSet 对象身份防伪）与签发/校验 helper：
 *
 * - facade.issueTreasuryReconciliationCapability 签发（绑定 transaction/
 *   digest/actionKind/conclusion/postFaultEpoch/incarnation/reconciler 版本/
 *   service generation/tick）；
 * - faultResolution 的两个 resolve 函数只接受 capability 并经本模块校验
 *  （普通对象伪造/JSON round-trip/旧 service（generation）/旧 epoch/
 *   单次使用全部失败）；
 * - 跨 global reset：旧 heap token 一律失效——新 service 依据持久
 *   intent/quarantine 与当前 observation 重新签发（不恢复旧 token）。
 */

import type { TreasuryObservationScope } from "@/runtime/treasury/types";

export type TreasuryReconciliationConclusion = "observed_committed" | "observed_not_executed" | "still_uncertain";

/** 不可伪造的 reconciliation capability（heap-only 冻结对象 + 私有 WeakSet）。 */
export interface TreasuryReconciliationCapability {
  readonly __brand: "treasury-reconciliation-capability";
  readonly transactionId: string;
  readonly digest: string;
  readonly actionKind: string;
  /** 结论只能来自注册 reconciler 的判定（调用者不可自填）。 */
  readonly conclusion: TreasuryReconciliationConclusion;
  readonly postFaultEpoch: {
    readonly scope: TreasuryObservationScope;
    readonly epochSeq: number;
    readonly observedAtTick: number;
  };
  readonly observationTick: number;
  readonly reconcilerKind: string;
  readonly reconcilerVersion: number;
  readonly serviceGeneration: number;
  readonly tick: number;
}

/** 模块级私有 registry（对象身份防伪的唯一权威）。 */
const capabilityRegistry = new WeakSet<TreasuryReconciliationCapability>();
/** 单次使用：已消费的 capability（WeakSet；重复消费拒绝）。 */
const consumedCapabilities = new WeakSet<TreasuryReconciliationCapability>();

export function isTreasuryReconciliationCapabilityRegistered(capability: unknown): capability is TreasuryReconciliationCapability {
  return capabilityRegistry.has(capability as TreasuryReconciliationCapability);
}

/** 注册签发的 capability（仅供签发路径调用——facade issue 方法）。 */
export function registerTreasuryReconciliationCapability(
  capability: TreasuryReconciliationCapability,
): TreasuryReconciliationCapability {
  capabilityRegistry.add(capability);
  return capability;
}

export type TreasuryReconciliationCapabilityValidation =
  | { readonly status: "valid"; readonly capability: TreasuryReconciliationCapability }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_capability" | "cross_generation" | "cross_tick" | "already_used";
      readonly detail: string;
    };

/**
 * resolution 前的 capability 校验：对象身份（伪造/JSON 副本失败）→ 单次
 * 使用 → generation（旧 service 失败）→ tick（跨 tick 失败）。
 * transaction/digest/reconciler 匹配由调用方（faultResolution）依据目标
 * entry 继续校验。
 */
export function validateTreasuryReconciliationCapability(
  capability: unknown,
  currentServiceGeneration: number,
): TreasuryReconciliationCapabilityValidation {
  if (!capability || typeof capability !== "object" || !capabilityRegistry.has(capability as TreasuryReconciliationCapability)) {
    return {
      status: "rejected",
      reason: "invalid_capability",
      detail: "capability 未在本模块签发（普通对象/JSON round-trip 副本一律无效——结论只能来自注册 reconciler）",
    };
  }
  const typed = capability as TreasuryReconciliationCapability;
  if (consumedCapabilities.has(typed)) {
    return { status: "rejected", reason: "already_used", detail: "capability 已消费（单次使用）" };
  }
  if (typed.serviceGeneration !== currentServiceGeneration) {
    return {
      status: "rejected",
      reason: "cross_generation",
      detail: "capability 由旧 Treasury service 签发（global reset 后必须由新 service 重新签发，不恢复旧 heap token）",
    };
  }
  if (typed.tick !== Game.time) {
    return {
      status: "rejected",
      reason: "cross_tick",
      detail: `capability 于 tick ${String(typed.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效`,
    };
  }
  return { status: "valid", capability: typed };
}

/** 标记已消费（resolution 使用成功后；单次使用语义）。 */
export function consumeTreasuryReconciliationCapability(capability: TreasuryReconciliationCapability): void {
  consumedCapabilities.add(capability);
}
