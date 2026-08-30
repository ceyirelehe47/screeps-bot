/**
 * Treasury reconciliation capability 类型定义（第八轮建立、第九轮 4.8 私有化）。
 *
 * 角色：resolution 结论的**唯一合法来源**是当前 Treasury service 基于 exact
 * post-fault observation 与受注册 action reconciler 的判定——普通调用者不得
 * 自行填写 conclusion/observationTick。
 *
 * 第九轮私有化：capability registry（签发/校验/消费）已全部移入
 * createTreasuryService 闭包（facade.ts）——本模块**只承载类型与结论枚举**，
 * 不再导出任何 register/validate/consume 入口（架构测试扫描导出面：普通
 * 模块无法把自构对象加入 registry、无法绕过 service 校验）。generation 由
 * 当前 service 闭包值校验（调用者提交的 serviceGeneration 数字不再接受）。
 *
 * capability 防伪契约（由 service 闭包保证）：
 * - 对象身份（WeakSet——伪造/JSON round-trip 副本一律无效）；
 * - 单次使用（已消费拒绝）；
 * - cross-generation 失效（global reset 后由新 service 重新签发）；
 * - cross-tick 失效。
 */

import type { TreasuryObservationScope } from "@/runtime/treasury/types";

export type TreasuryReconciliationConclusion = "observed_committed" | "observed_not_executed" | "still_uncertain";

/**
 * 不可伪造的 reconciliation capability（heap-only 冻结对象 + service 闭包
 * 私有 WeakSet）。第九轮扩展绑定：authorityKind/contract ID+digest/adapter
 * kind+version/durable payload version。
 */
export interface TreasuryReconciliationCapability {
  readonly __brand: "treasury-reconciliation-capability";
  readonly transactionId: string;
  readonly digest: string;
  /** unresolved authority 形态（quarantine | intent）。 */
  readonly authorityKind: "quarantine" | "intent";
  readonly actionKind: string;
  /** 结论只能来自注册 reconciler 的判定（调用者不可自填）。 */
  readonly conclusion: TreasuryReconciliationConclusion;
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly adapterVersion?: number;
  readonly durablePayloadVersion?: number;
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

/** capability 校验/消费结果（service 闭包内实现，faultResolution 消费）。 */
export type TreasuryReconciliationCapabilityConsumption =
  | { readonly status: "valid"; readonly capability: TreasuryReconciliationCapability }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_capability" | "cross_generation" | "cross_tick" | "already_used";
      readonly detail: string;
    };

/**
 * faultResolution 经此窄接口消费 capability（第九轮 4.8）：generation 由
 * service 闭包值校验——调用者无法通过提交 serviceGeneration 数字绕过。
 * TreasuryService 结构兼容本接口。
 */
export interface TreasuryReconciliationCapabilityAuthority {
  /**
   * 只读验证（第十轮 3.12.8）：对象身份 → 单次未用 → generation → tick——
   * 零消费（消费移至 staged resolution 写入之后；staged 前的任何拒绝不得
   * 烧掉 capability）。
   */
  validateReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
  consumeReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
}
