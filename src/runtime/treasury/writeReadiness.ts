/**
 * 统一 write readiness 权威（第十轮 3.12.10）。
 *
 * query 的 writeAdmission 视图、contract authorization 前置与 prepare/execute
 * 的独立复查共用**单一评估器**：一套 blocker 枚举、一套优先级、一套状态
 * 来源（facade 采集后传入——本模块纯函数、零 Memory 写）。三处不再各自拼
 * 装条件；prepare 仍独立复查（TOCTOU 防护——不信任调用方已读过 readiness）。
 */

/** 评估目的（诊断排序与上下文相关项的取舍）。 */
export type TreasuryWriteReadinessPurpose = "query" | "authorize" | "prepare" | "diagnostics";

/** 单一状态来源（facade 采集点一次填充）。 */
export interface TreasuryWriteReadinessInputs {
  readonly lifecycleClosed: boolean;
  readonly staleTickState: boolean;
  readonly writeFaultLocked: boolean;
  readonly writeFaultUnhealthy: boolean;
  readonly invalidOwner: boolean;
  readonly commitmentIncomplete: boolean;
  readonly quarantineUnhealthy: boolean;
  readonly quarantineUnresolved: boolean;
  readonly intentUnhealthy: boolean;
  readonly intentUnresolved: boolean;
  readonly reservationMigrationIncomplete: boolean;
  readonly reservationStoreUnhealthy: boolean;
  readonly reservationStoreCorrupted: boolean;
  readonly receiptUnhealthy: boolean;
  readonly receiptCapacityExhausted: boolean;
  readonly resolutionStoreUnhealthy: boolean;
  readonly resolutionResolvingBlocker: boolean;
  readonly recoverySlotExhausted: boolean;
  readonly policyNotReady: boolean;
  readonly authorizationCapacityExhausted: boolean;
  /** pre-execution authorization fault 未解除（第十一轮 3.13.1：与 marker 同生命周期）。 */
  readonly authorizationFaultUnresolved: boolean;
  /** 【第十二轮 3.1.6】fault authority 容量前置 admission（满载阻断新 writer）。 */
  readonly authorizationFaultCapacityExhausted: boolean;
}

/** 评估结果（blockers 按优先级排序；ready = blockers 为空）。 */
export interface TreasuryWriteReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

/** blocker 枚举 + 优先级（单一权威；字符串与历史 query 断言兼容）。 */
const BLOCKER_PRIORITY: ReadonlyArray<{ readonly key: keyof TreasuryWriteReadinessInputs; readonly blocker: string }> = Object.freeze([
  { key: "invalidOwner", blocker: "invalid_owner" },
  { key: "lifecycleClosed", blocker: "lifecycle_closed" },
  { key: "staleTickState", blocker: "stale_tick_state" },
  { key: "writeFaultLocked", blocker: "write_fault" },
  { key: "writeFaultUnhealthy", blocker: "write_fault" },
  { key: "policyNotReady", blocker: "policy_not_ready" },
  { key: "quarantineUnhealthy", blocker: "quarantine_unhealthy" },
  { key: "quarantineUnresolved", blocker: "quarantine_unresolved" },
  { key: "intentUnhealthy", blocker: "intent_unhealthy" },
  { key: "intentUnresolved", blocker: "intent_unresolved" },
  { key: "reservationMigrationIncomplete", blocker: "reservation_migration_incomplete" },
  { key: "reservationStoreUnhealthy", blocker: "reservation_store_unhealthy" },
  { key: "reservationStoreCorrupted", blocker: "reservation_store_corrupted" },
  { key: "receiptUnhealthy", blocker: "receipt_unhealthy" },
  { key: "receiptCapacityExhausted", blocker: "receipt_capacity_exhausted" },
  { key: "commitmentIncomplete", blocker: "commitment_incomplete" },
  { key: "resolutionStoreUnhealthy", blocker: "resolution_store_unhealthy" },
  { key: "resolutionResolvingBlocker", blocker: "resolution_resolving" },
  { key: "recoverySlotExhausted", blocker: "quarantine_slot_exhausted" },
  { key: "authorizationCapacityExhausted", blocker: "authorization_capacity_exhausted" },
  { key: "authorizationFaultUnresolved", blocker: "authorization_fault" },
  { key: "authorizationFaultCapacityExhausted", blocker: "authorization_fault_capacity_exhausted" },
] as const);

/**
 * 单一评估器（纯函数）：按优先级输出 blockers；ready = 无 blocker。
 * 正常路径 O(1)（输入由 facade 基于已缓存 health/counter 一次采集）。
 */
export function evaluateTreasuryWriteReadiness(
  inputs: TreasuryWriteReadinessInputs,
  _purpose: TreasuryWriteReadinessPurpose,
): TreasuryWriteReadiness {
  const blockers: string[] = [];
  for (const entry of BLOCKER_PRIORITY) {
    if (inputs[entry.key] === true && !blockers.includes(entry.blocker)) {
      blockers.push(entry.blocker);
    }
  }
  return { ready: blockers.length === 0, blockers: Object.freeze(blockers) };
}
