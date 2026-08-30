/**
 * Treasury recovery coordinator（第十一轮 3.13.10，自 facade 抽出）。
 *
 * intent ↔ quarantine 事实转移（transferTreasuryIntentToQuarantine 的
 * facade 侧协调：fault marker 写入 + 防御分支直写 + emergency 保留计数）、
 * tick 边界的 prepared 分类隔离、finalized intent 的 cross-store proof
 * 检查（receipts + resolution tombstone 组合——beginTick 恢复注入）。
 */

import { recordTreasuryWriteFault, TREASURY_WRITE_FAULT_DETAIL_MAX, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  outcomeOfTreasuryFaultPhase,
  quarantineTreasuryTransaction,
} from "@/runtime/treasury/quarantine";
import {
  readTreasuryIntentEntry,
  transferTreasuryIntentToQuarantine,
} from "@/runtime/treasury/intents";
import { hasSettledReceipt } from "@/runtime/treasury/receipts";
import { readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import type { TreasuryMetrics } from "@/runtime/treasury/types";

/** 恢复协调所需的 prepared record 事实（facade 内部 PreparedTransaction 的窄视图）。 */
export interface TreasuryRecoveryRecord {
  readonly canonical: {
    readonly transactionId: string;
    readonly kind: string;
    readonly source: string;
  };
  readonly digest: string;
  readonly preparedAtTick: number;
  readonly faultPhase?: TreasuryWriteFaultPhase;
  state: string;
}

export interface TreasuryRecoveryCoordinatorDeps {
  readonly metrics: TreasuryMetrics;
  /** record.shape.merged → canonical quarantine deltas（facade 闭包形状适配）。 */
  readonly quarantineDeltasOf: (record: TreasuryRecoveryRecord) => readonly {
    roomName: string;
    locationKind: string;
    resource: string;
    delta: number;
  }[];
}

export interface TreasuryRecoveryCoordinator {
  /** 已 fault 的 prepared record：写 marker + 转 durable quarantine。 */
  quarantineFaultedRecord(record: TreasuryRecoveryRecord, detail?: string): void;
  /** executing/faulted handle → durable quarantine（tick 边界分类）。 */
  quarantinePreparedRecord(record: TreasuryRecoveryRecord): void;
  /** durable 事实转移统一入口（intent → quarantine 优先，防御分支直写最小 v2）。 */
  transferRecordToQuarantine(record: TreasuryRecoveryRecord, faultPhase: TreasuryWriteFaultPhase): void;
  /** finalized intent 的 cross-store proof（beginTick 恢复注入）。 */
  checkTreasuryFinalizedProof(transactionId: string, outcome: string): string | null;
}

export function createTreasuryRecoveryCoordinator(deps: TreasuryRecoveryCoordinatorDeps): TreasuryRecoveryCoordinator {
  const quarantineFaultedRecord = (record: TreasuryRecoveryRecord, detail?: string): void => {
    record.state = "faulted";
    deps.metrics.commitFaults += 1;
    const faultPhase = record.faultPhase ?? "commit_unexpected";
    recordTreasuryWriteFault({
      transactionId: record.canonical.transactionId,
      digest: record.digest,
      tick: record.preparedAtTick,
      kind: record.canonical.kind,
      source: record.canonical.source,
      phase: faultPhase,
      status: "unresolved",
      recordedAt: Game.time,
      ...(detail !== undefined ? { detail: detail.slice(0, TREASURY_WRITE_FAULT_DETAIL_MAX) } : {}),
    });
    transferRecordToQuarantine(record, faultPhase);
  };

  const quarantinePreparedRecord = (record: TreasuryRecoveryRecord): void => {
    const faultPhase = record.state === "executing" ? "executing_at_end_tick" : record.faultPhase ?? "commit_unexpected";
    transferRecordToQuarantine(record, faultPhase);
    deps.metrics.preparedQuarantinedAtBoundary += 1;
  };

  const transferRecordToQuarantine = (record: TreasuryRecoveryRecord, faultPhase: TreasuryWriteFaultPhase): void => {
    const intent = readTreasuryIntentEntry(record.canonical.transactionId);
    if (intent !== undefined) {
      const transferred = transferTreasuryIntentToQuarantine(intent, faultPhase);
      if (transferred.status === "retained") {
        deps.metrics.quarantineAdmissionRejections += 1;
      }
      return;
    }
    // 防御分支（intent 已释放/不存在——正常路径 executePreparedAction 恒先写
    // intent）：按 fault phase 推导 outcome 直写最小 v2 entry。
    const derived = outcomeOfTreasuryFaultPhase(faultPhase);
    if (derived === null) {
      deps.metrics.quarantineAdmissionRejections += 1;
      return;
    }
    const write = quarantineTreasuryTransaction({
      transactionId: record.canonical.transactionId,
      digest: record.digest,
      tick: record.preparedAtTick,
      kind: record.canonical.kind,
      source: record.canonical.source,
      phase: faultPhase,
      deltas: deps.quarantineDeltasOf(record),
      recordedAt: Game.time,
      outcome: derived,
      settlement: "quarantined",
    });
    if (write.status === "rejected") {
      deps.metrics.quarantineAdmissionRejections += 1;
    }
  };

  /**
   * finalized intent 的 cross-store proof（第十一轮 3.13.6）：returned_ok
   * 须 settled receipt 或 final committed tombstone；其余须 final
   * not-executed/rolled-back tombstone。proof 缺失 → 恢复路径 semantic
   * fault（entry 保留不释放、fail closed）。
   */
  const checkTreasuryFinalizedProof = (transactionId: string, outcome: string): string | null => {
    if (outcome === "returned_ok") {
      if (hasSettledReceipt(transactionId) !== undefined) return null;
      const tombstone = readTreasuryResolutionTombstone(transactionId);
      if (tombstone !== undefined && tombstone.stage === "final" && tombstone.resolution === "committed") {
        return null;
      }
      return `settled receipt 或 committed resolution proof 缺失（${transactionId.slice(0, 48)}）`;
    }
    const tombstone = readTreasuryResolutionTombstone(transactionId);
    if (tombstone !== undefined && tombstone.stage === "final" && tombstone.resolution === "not-executed") {
      return null;
    }
    return `not-executed/rolled-back resolution proof 缺失（${transactionId.slice(0, 48)}）`;
  };

  return {
    quarantineFaultedRecord,
    quarantinePreparedRecord,
    transferRecordToQuarantine,
    checkTreasuryFinalizedProof,
  };
}
