/**
 * Treasury write-readiness 状态收集器（第十一轮 3.13.10，自 facade 抽出）。
 *
 * 从各 store（writeFault/quarantine/intent/receipts/resolutions/reservation/
 * authorizationFaults/policy registry/授权 ledger）收集 readiness 输入并
 * 调用统一评估器 evaluateTreasuryWriteReadiness——query 的 writeAdmission
 * 视图与 contract authorization 前置共用同一收集器（一处构造、一处维护；
 * prepare 的独立复查沿用同一输入形状做 TOCTOU 防护）。零 Memory 写。
 */

import type { TreasuryWriteReadinessInputs } from "@/runtime/treasury/writeReadiness";

/** 各 blocker 的状态来源（facade 闭包一次装配；getter 保持惰性求值）。 */
export interface TreasuryReadinessStateSources {
  readonly lifecycleClosed: () => boolean;
  readonly staleTickState: () => boolean;
  readonly writeFaultLocked: () => boolean;
  readonly writeFaultUnhealthy: () => boolean;
  readonly invalidOwner: () => boolean;
  readonly commitmentIncomplete: () => boolean;
  readonly quarantineUnhealthy: () => boolean;
  readonly quarantineUnresolved: () => boolean;
  readonly intentUnhealthy: () => boolean;
  readonly intentUnresolved: () => boolean;
  readonly reservationMigrationIncomplete: () => boolean;
  readonly reservationStoreUnhealthy: () => boolean;
  readonly reservationStoreCorrupted: () => boolean;
  readonly receiptUnhealthy: () => boolean;
  readonly receiptCapacityExhausted: () => boolean;
  readonly resolutionStoreUnhealthy: () => boolean;
  readonly resolutionResolvingBlocker: () => boolean;
  readonly recoverySlotExhausted: () => boolean;
  readonly authorizationFaultUnresolved: () => boolean;
  /** 【第十二轮 3.1.6】fault authority 容量前置 admission（满载阻断新 writer）。 */
  readonly authorizationFaultCapacityExhausted: () => boolean;
  /** 【Remediation V 八】completion store 健康与容量 headroom 前置 admission。 */
  readonly completionStoreUnhealthy: () => boolean;
  readonly completionHeadroomExhausted: () => boolean;
  readonly policyNotReady: () => boolean;
  readonly authorizationCapacityExhausted: () => boolean;
}

/**
 * 收集 readiness 输入（纯函数；authorize 路径的 policyNotReady 走前置
 * 专用 reason，经 overrides 显式覆盖为 false——差异显式化，不再两处拼装）。
 */
export function collectTreasuryWriteReadinessInputs(
  sources: TreasuryReadinessStateSources,
  overrides?: Partial<TreasuryWriteReadinessInputs>,
): TreasuryWriteReadinessInputs {
  return {
    lifecycleClosed: sources.lifecycleClosed(),
    staleTickState: sources.staleTickState(),
    writeFaultLocked: sources.writeFaultLocked(),
    writeFaultUnhealthy: sources.writeFaultUnhealthy(),
    invalidOwner: sources.invalidOwner(),
    commitmentIncomplete: sources.commitmentIncomplete(),
    quarantineUnhealthy: sources.quarantineUnhealthy(),
    quarantineUnresolved: sources.quarantineUnresolved(),
    intentUnhealthy: sources.intentUnhealthy(),
    intentUnresolved: sources.intentUnresolved(),
    reservationMigrationIncomplete: sources.reservationMigrationIncomplete(),
    reservationStoreUnhealthy: sources.reservationStoreUnhealthy(),
    reservationStoreCorrupted: sources.reservationStoreCorrupted(),
    receiptUnhealthy: sources.receiptUnhealthy(),
    receiptCapacityExhausted: sources.receiptCapacityExhausted(),
    resolutionStoreUnhealthy: sources.resolutionStoreUnhealthy(),
    resolutionResolvingBlocker: sources.resolutionResolvingBlocker(),
    recoverySlotExhausted: sources.recoverySlotExhausted(),
    authorizationFaultUnresolved: sources.authorizationFaultUnresolved(),
    authorizationFaultCapacityExhausted: sources.authorizationFaultCapacityExhausted(),
    completionStoreUnhealthy: sources.completionStoreUnhealthy(),
    completionHeadroomExhausted: sources.completionHeadroomExhausted(),
    ...(overrides?.policyNotReady !== undefined ? { policyNotReady: overrides.policyNotReady } : { policyNotReady: sources.policyNotReady() }),
    authorizationCapacityExhausted: sources.authorizationCapacityExhausted(),
  };
}
