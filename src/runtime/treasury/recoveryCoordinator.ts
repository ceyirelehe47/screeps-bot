/**
 * Treasury recovery coordinator（第十一轮 3.13.10，自 facade 抽出）。
 *
 * intent ↔ quarantine 事实转移（transferTreasuryIntentToQuarantine 的
 * facade 侧协调：fault marker 写入 + 防御分支直写 + emergency 保留计数）、
 * tick 边界的 prepared 分类隔离、finalized intent 的 cross-store proof
 * 检查（receipts + resolution tombstone 组合——beginTick 恢复注入）。
 */

import { recordTreasuryWriteFault, classAwareMarkerFieldsOfFacts, TREASURY_WRITE_FAULT_DETAIL_MAX, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  outcomeOfTreasuryFaultPhase,
  quarantineTreasuryTransaction,
} from "@/runtime/treasury/quarantine";
import {
  readTreasuryIntentEntry,
  transferTreasuryIntentToQuarantine,
} from "@/runtime/treasury/intents";
import { readTreasurySettlementProof } from "@/runtime/treasury/receipts";
import { readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
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
  /** 【第十七轮】class-aware marker / proof 链继承字段（facade 注入）。 */
  readonly contractDigest?: string;
  readonly lineageBindingDigest?: string;
  readonly lineageGeneration?: number;
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
  /** finalized intent 的 cross-store proof（beginTick 恢复注入；attempt identity 绑定）。 */
  checkTreasuryFinalizedProof(transactionId: string, outcome: string, attempt: TreasuryAttemptIdentity): string | null;
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
      // 【第十七轮第十四节】class-aware attempt identity（contract →
      // identity-bound；纯低层 → lowlevel + runtime 来源；binding/generation
      // 由 tr1_ 接管路径注入）。
      ...classAwareMarkerFieldsOfFacts({
        ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
        ...(record.lineageBindingDigest !== undefined ? { lineageBindingDigest: record.lineageBindingDigest } : {}),
        ...(record.lineageGeneration !== undefined ? { lineageGeneration: record.lineageGeneration } : {}),
      }),
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
    // intent）：按 fault phase 推导 outcome 直写最小 entry。【第十二轮 3.8】
    // 该 entry 缺少现代完整 identity 事实（无 contract/cohort/descriptor 输入）
    // ——显式标记 forensic incomplete authority：继续阻断 writer 并保留
    // postings，但不得被当前 adapter reconciler 解释、不得签发普通
    // capability、不得自动 resolve；只能经显式人工修复/迁移或专门 forensic
    // resolution 流程处理（诊断：treasuryForensicQuarantineDiagnostics）。
    const derived = outcomeOfTreasuryFaultPhase(faultPhase);
    if (derived === null) {
      deps.metrics.quarantineAdmissionRejections += 1;
      return;
    }
    const write = quarantineTreasuryTransaction({
      transactionId: record.canonical.transactionId,
      /** 【第十三轮】forensic incomplete authority 的显式等级。 */
      authorityLevel: "forensic",
      digest: record.digest,
      tick: record.preparedAtTick,
      kind: record.canonical.kind,
      source: record.canonical.source,
      phase: faultPhase,
      deltas: deps.quarantineDeltasOf(record),
      recordedAt: Game.time,
      outcome: derived,
      settlement: "quarantined",
      forensic: {
        reason: "intent_missing_fallback",
        detail: "recovery coordinator 在 intent 缺失时防御性直写（无 contract/cohort/descriptor 身份事实）——forensic 隔离，不得自动解释或 resolve",
      },
    } as Parameters<typeof quarantineTreasuryTransaction>[0]);
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
  /**
   * 【第十二轮 3.4】finalized proof 按完整 attempt identity 校验：
   * - returned_ok：只能由与该 attempt identity 完全匹配的 committed proof
   *   （settlement receipt 或 final committed tombstone）证明；
   * - 其余 outcome：只能由 identity 匹配的 final not-executed tombstone 证明；
   * - 旧 attempt 的 receipt/tombstone（identity 不同或缺失现代身份事实）
   *   不得释放新 attempt 的 intent（conflict/insufficient 均 fail closed）。
   */
  /**
   * 【第十四轮第七节】receipt proof 视图完整传递全部身份字段（digest /
   * contractDigest / authorizationCohortDigest / durableIdentityDigest）——
   * 不再只传 digest+durableIdentityDigest 子集（cohort/contract 不同即
   * conflict，缺失即 insufficient）。
   */
  const checkTreasuryFinalizedProof = (transactionId: string, outcome: string, attempt: TreasuryAttemptIdentity): string | null => {
    if (outcome === "returned_ok") {
      const settlement = readTreasurySettlementProof(transactionId);
      if (
        settlement !== undefined &&
        treasuryAttemptIdentityRelation(
          {
            digest: settlement.digest ?? attempt.digest,
            ...(settlement.contractDigest !== undefined ? { contractDigest: settlement.contractDigest } : {}),
            ...(settlement.authorizationCohortDigest !== undefined
              ? { authorizationCohortDigest: settlement.authorizationCohortDigest }
              : {}),
            ...(settlement.durableIdentityDigest !== undefined
              ? { durableIdentityDigest: settlement.durableIdentityDigest }
              : {}),
          },
          attempt,
        ) === "match"
      ) {
        return null;
      }
      const tombstone = readTreasuryResolutionTombstone(transactionId);
      if (tombstone !== undefined && tombstone.stage === "final" && tombstone.resolution === "committed") {
        if (treasuryAttemptIdentityRelation(tombstone, attempt) === "match") return null;
      }
      return `settled receipt 或 committed resolution proof 缺失或 attempt identity 不匹配（${transactionId.slice(0, 48)}）`;
    }
    const tombstone = readTreasuryResolutionTombstone(transactionId);
    if (tombstone !== undefined && tombstone.stage === "final" && tombstone.resolution === "not-executed") {
      if (treasuryAttemptIdentityRelation(tombstone, attempt) === "match") return null;
    }
    return `not-executed/rolled-back resolution proof 缺失或 attempt identity 不匹配（${transactionId.slice(0, 48)}）`;
  };

  return {
    quarantineFaultedRecord,
    quarantinePreparedRecord,
    transferRecordToQuarantine,
    checkTreasuryFinalizedProof,
  };
}
