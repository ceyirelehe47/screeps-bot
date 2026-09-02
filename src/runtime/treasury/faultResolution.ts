/**
 * Treasury 显式 fault resolution 协议（第六轮建立、第七轮证据协议、第八轮
 * 重做为 **staged atomic resolution + service-issued capability**）。
 *
 * 背景：write-fault marker / durable quarantine / durable intent 只证明
 * "Game 结果未知或 commit 未完成"，无法证明 Game 动作是否发生。解锁必须
 * 携带结论语义——而结论不得由普通调用者自填：
 *
 * - **结论来源（第八轮）**：TreasuryService.issueTreasuryReconciliationCapability
 *   基于当前 exact post-fault observation + **受注册 action reconciler**
 *   （actionContracts registry）判定 committed / not-executed / uncertain，
 *   签发 opaque capability（reconciliation.ts——对象身份防伪、单次使用、
 *   generation/tick 有界）；resolve 函数只接受 capability（旧 evidence/
 *   guard 自由对象入口已移除）。跨 global reset 由新 service 重新签发。
 * - **staged atomic（第八轮 8.2）**：
 *   resolve-as-committed：prevalidate → resolution slot 预检（满载在任何
 *   原状态变化之前拒绝）→ 写 stage="resolving" tombstone（resolution-
 *   intent 落盘）→ receipt **刷新**（既有 receipt 真正更新到 resolution
 *   tick，见 receipts.refreshSettledReceiptForResolution；无则写入）→
 *   释放 quarantine/intent → 清匹配 marker → finalize（stage="final"）。
 *   resolve-as-not-executed：prevalidate → slot 预检 → 先写 **final**
 *   tombstone（可写性保证）→ 再释放 quarantine/intent + 清 marker——
 *   绝无"函数返回失败但 transaction 已可重新 prepare"的中间态。
 *   任何阶段中断由 resolutionStore.recoverStagedResolutions 在 beginTick
 *   幂等恢复（receipt 已写→继续 finalize；无进展→回滚 tombstone；
 *   final 未释放→补完成）。
 * - **时序前置**（第七轮保留）：transaction 不得仍属当前 active handle
 *   registry；当前 tick > 故障 tick；系统已建立故障后 shared observation；
 *   capability 的 observationTick 严格晚于故障 tick 且不晚于当前 tick。
 * - **phase 允许性**：not-executed 仅 execution-unknown 类 phase
 *   （executing_at_end_tick / action_threw_execution_unknown /
 *   action_returned_non_ok_abort_failed）；commit 类 phase 一律拒绝（不
 *   允许伪造"未执行"）。
 * - still_uncertain：reconciler 结论不足——保持 quarantine/intent 与全部
 *   占用，不解锁，零副作用。
 * - 幂等：重复调用 already_resolved（tombstone final / receipt）；错误
 *   transactionId / digest / capability / 时序 → 拒绝且 fault 不动。
 *
 * 安全边界（架构测试守护）：生产 tick 不得自动调用（仅显式管理/修复路径
 * 与测试可引用）；显式 repair（quarantine/intent store 元数据）只在本模块。
 */

import { refreshSettledReceiptForResolution, hasSettledReceipt } from "@/runtime/treasury/receipts";
import {
  clearTreasuryWriteFaultMarkerForResolution,
  readTreasuryWriteFault,
} from "@/runtime/treasury/writeFault";
import {
  ensureTreasuryQuarantineStoreValidated,
  peekTreasuryQuarantineHealth,
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
  repairTreasuryQuarantineStoreMetadataForResolution,
} from "@/runtime/treasury/quarantine";
import {
  ensureTreasuryIntentStoreValidated,
  readTreasuryIntentEntry,
  releaseTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  isTreasuryUnresolvedAuthorityNotExecutable,
  resolveTreasuryUnresolvedAuthority,
  type TreasuryUnresolvedAuthority,
} from "@/runtime/treasury/unresolvedAuthority";
import {
  committedResolutionSettledAtTick,
  deleteTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
  ensureTreasuryResolutionStoreValidated,
  markTreasuryPendingReleaseCompleted,
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  type TreasuryResolutionProofLevel,
} from "@/runtime/treasury/resolutionStore";
import { isTreasuryRearmAttemptId } from "@/runtime/treasury/transactionId";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  completeTreasuryResolutionCleanup,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
  treasuryMarkerDischargeExpectedOfFacts,
} from "@/runtime/treasury/markerDischarge";
import { treasuryIdentityProfileOfProofClass } from "@/runtime/treasury/identityProfile";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import {
  createTreasuryAttemptLineageRecord,
  ensureTreasuryLineageSlotAvailable,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  retireTreasuryLineageCurrentAttempt,
  convergeTreasuryLineageRetirementFromFacts,
  closeTreasuryLineageAsChainCommitted,
  type TreasuryAttemptLineageIdentity,
  type TreasuryLineageAuthorityClass,
} from "@/runtime/treasury/attemptLineage";
import {
  computeTreasuryModernRetrySemanticDigest,
  computeTreasuryLowlevelRetrySemanticDigest,
  modernRetrySemanticFactsOfEntry,
  lowlevelRetrySemanticFactsOfEntry,
} from "@/runtime/treasury/retrySemanticIdentity";
import { classAwareIdentityOfAttempt } from "@/runtime/treasury/markerAttemptIdentity";
import { verifyTreasuryCommittedResolutionProof } from "@/runtime/treasury/committedProofVerifier";
import type {
  TreasuryReconciliationCapability,
  TreasuryReconciliationCapabilityAuthority,
} from "@/runtime/treasury/reconciliation";
import { recordTreasuryResolutionEvent } from "@/runtime/treasury/resolutionEvents";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
import { readTreasurySettlementProof } from "@/runtime/treasury/receipts";

export type { TreasuryReconciliationConclusion } from "@/runtime/treasury/reconciliation";
import {
  TREASURY_RESOLUTION_KERNEL,
  type TreasuryResolutionKernel,
  type TreasuryResolutionKernelHolder,
} from "@/runtime/treasury/resolutionKernelChannel";

// ── resolution kernel 通道（第十一轮 3.13.8） ────────────────────────────────
// 模块级 WeakSet 注册机制删除：resolve 函数只接受持有
// TREASURY_RESOLUTION_KERNEL（non-enumerable symbol）的 service 运行时
// 对象——伪造对象无该 symbol 属性一律无效（closure 直接调用，注册函数
// 不复存在）。
function resolutionKernelOf(service: object): TreasuryResolutionKernel | undefined {
  return (service as Partial<TreasuryResolutionKernelHolder>)[TREASURY_RESOLUTION_KERNEL];
}

/** resolution 输入（第八轮）：capability 取代旧 evidence/guard 自由对象。 */
export interface TreasuryFaultResolutionInput {
  readonly transactionId: string;
  /** 可选 digest 核对（提供时必须与 entry/capability 一致，否则拒绝）。 */
  readonly digest?: string;
  /** service 签发的 reconciliation capability（issueTreasuryReconciliationCapability）。 */
  readonly capability: TreasuryReconciliationCapability;
}

export type TreasuryFaultResolutionResult =
  | {
      readonly status: "resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
      /** 本次调用是否实际写入/刷新 receipt（false = 幂等命中既有结算）。 */
      readonly receiptWritten: boolean;
      /**
       * 【第十六轮第五节】同 transaction ID 不可再次执行（一个 transaction ID
       * 永远只标识一个执行 attempt——旧 reprepareAllowed=true 语义已删除）。
       */
      readonly sameIdRetryAllowed: false;
      /** 原 action tick（审计保留；receipt retention 从 settlement tick 起算）。 */
      readonly actionTick: number;
      /** receipt 结算 tick（resolve-as-committed 时存在 = resolution tick）。 */
      readonly settledAtTick?: number;
      /**
       * 【第十七轮第六节】not-executed 的 retirement 状态（取代第十六轮
       * 直接返回的 rearmChildTransactionId 字符串——普通字符串不再是
       * rearm 权威，child ID 只经 issueTreasuryRearmCapability 交付）。
       */
      readonly retirement?:
        | "complete_rearm_ready"
        | "complete_non_rearmable"
        | "pending_cleanup"
        | "pending_publication";
      /** 【第二十二轮 17.3】当前 attempt 已完成但其它 attempt 的 write-fault
       * marker 仍锁定全局 writer（unrelated global lock 事实——与 attempt
       * resolution 状态正交）。 */
      readonly globalWriteAdmissionStillLocked?: boolean;
    }
  | {
      readonly status: "already_resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
    }
  | {
      /** reconciler 结论为 still_uncertain：保持隔离，不解锁，零副作用。 */
      readonly status: "uncertain";
      readonly transactionId: string;
      readonly detail: string;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "not_found"
        | "digest_mismatch"
        | "invalid_capability"
        | "active_handle_present"
        | "resolution_not_allowed"
        | "stale_observation"
        | "evidence_mismatch"
        | "reconciler_mismatch"
        | "receipt_store_fatal"
        | "quarantine_store_fatal"
        | "intent_store_fatal"
        | "authority_inconsistent"
        /** 【第十六轮第八节】intent/quarantine store fatal（resolver store_unhealthy）。 */
        | "authority_store_unhealthy"
        | "resolution_store_fatal"
        | "resolution_store_full"
        /** 【第十八轮 24.1】lineage retirement candidate 持久化/read-back 失败——
         *  authority/quarantine/marker/pending-release 全部保留（fail closed）。 */
        | "lineage_publication_pending"
        /** 【第二十二轮第七节】committed resolution 的 marker discharge 未完成
         *  （conflict/insufficient/store unhealthy/delete failed）——authority 与
         *  resolving tombstone 保留，beginTick journal 恢复幂等重试。 */
        | "marker_cleanup_blocked"
        | "invalid_input"
        /** 【第十三轮】同 id 既有 receipt proof 与当前 attempt identity 冲突。 */
        | "settlement_identity_conflict"
        /** 【第十三轮】既有 receipt proof（legacy/身份不足）不能证明当前 attempt。 */
        | "settlement_proof_insufficient";
      readonly detail: string;
    };

// ── resolution 计数器（resolutionEvents.ts 承载，facade 只读聚合） ─────────

export type { TreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";
export { readTreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";

function countRejected(): void {
  recordTreasuryResolutionEvent("rejected");
}

/**
 * 【第二十轮 13.4】tr1_ authority 的 semantic lineage verdict（三方 verifier
 * 调用输入）：child ID 派生/parent/binding 权威重算/active-terminal authority
 * 状态的语义证明——一组结构完整但语义伪造的四字段（互相一致却与 ID 派生
 * 冲突）不得落盘为现代 proof / 释放 authority。非 tr1_ 返回 undefined。
 */
function semanticLineageVerdictOfAuthorityFacts(authority: {
  readonly transactionId: string;
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): { readonly verdict: string; readonly detail?: string } | undefined {
  if (!isTreasuryRearmAttemptId(authority.transactionId)) return undefined;
  if (
    authority.lineageId === undefined || authority.lineageGeneration === undefined ||
    authority.parentTransactionId === undefined || authority.lineageBindingDigest === undefined
  ) {
    return { verdict: "insufficient", detail: "tr1_ authority 缺完整 lineage proof（resolver shape 层应已拦截——防御）" };
  }
  const semantic = validateTreasurySemanticLineage({
    transactionId: authority.transactionId,
    proof: {
      lineageId: authority.lineageId,
      lineageGeneration: authority.lineageGeneration,
      parentTransactionId: authority.parentTransactionId,
      lineageBindingDigest: authority.lineageBindingDigest,
    },
    purpose: "committed_settlement",
    identity: {
      digest: authority.digest,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    },
  });
  return semantic.verdict === "match"
    ? { verdict: "match" }
    : { verdict: semantic.verdict, detail: "detail" in semantic ? semantic.detail : undefined };
}

// ── 【第十五轮第十三节】test-only 故障注入：receipt refresh 成功之后、统一
//    三方 verifier 读取持久 proof 之前（模拟"refresh 返回成功但持久副本被
//    篡改 / 双 authority 变 inconsistent / proof 变 legacy"窗口——证明不得
//    仅凭 refresh 返回成功释放）。生产路径恒不注册。 ─────────────────────────
type TreasuryImmediateResolutionFaultPhase = "after_refresh_before_read_back";
let immediateResolutionFaultInjector: ((phase: TreasuryImmediateResolutionFaultPhase) => void) | null = null;

/** 仅供测试：注册 immediate resolution 故障注入（null 清除）。 */
export function setTreasuryImmediateResolutionFaultForTest(
  injector: ((phase: TreasuryImmediateResolutionFaultPhase) => void) | null,
): void {
  immediateResolutionFaultInjector = injector;
}

function runImmediateResolutionFaultInjector(): void {
  if (immediateResolutionFaultInjector !== null) {
    immediateResolutionFaultInjector("after_refresh_before_read_back");
  }
}

// ── 输入形状验证 ────────────────────────────────────────────────────────────

function describeInvalidInput(input: TreasuryFaultResolutionInput): string | null {
  if (!input || typeof input !== "object" || typeof input.transactionId !== "string" || input.transactionId.length === 0) {
    return "transactionId 缺失或非法";
  }
  if (input.digest !== undefined && (typeof input.digest !== "string" || input.digest.length === 0)) {
    return "digest 非法";
  }
  if (input.capability === undefined || input.capability === null || typeof input.capability !== "object") {
    return "capability 缺失（须经 service.issueTreasuryReconciliationCapability 签发）";
  }
  return null;
}

/**
 * 共享前置验证链：形状 → capability 防伪/单次/generation/tick → quarantine
 * health（显式 load）→ 定位 entry（tombstone/receipt 幂等）→ digest →
 * active handle → tick 时序 → post-observation → conclusion 匹配 →
 * reconciler 绑定。返回 entry+capability 或拒绝/uncertain 结果。
 */
function prevalidate(
  kernel: TreasuryResolutionKernel,
  input: TreasuryFaultResolutionInput,
): { authority: TreasuryUnresolvedAuthority; capability: TreasuryReconciliationCapability } | { stop: TreasuryFaultResolutionResult } {
  const inputError = describeInvalidInput(input);
  if (inputError !== null) {
    countRejected();
    return { stop: { status: "rejected", reason: "invalid_input", detail: inputError } };
  }
  // 幂等快路径（重复管理调用稳定 already_resolved）：entry 已释放且 final
  // tombstone / receipt / committed tombstone 窗口任一命中时直接幂等返回——
  // 不经 capability 校验/消费（resolved 状态不因重复调用改变）。
  const earlyAuthority = resolveTreasuryUnresolvedAuthority(input.transactionId);
  if (earlyAuthority.status === "not_found") {
    // 【第十二轮 3.3】快路径不得只看 transaction ID：legacy proof（无现代
    // attempt identity 字段）仅在 digest 匹配时幂等；现代 proof 无法由本
    // 入口证明属于当前 attempt（调用方未携带 identity）→ 不快路径，交由
    // capability 校验后的 identity 比较或 not_found 拒绝。
    const earlyTombstone = readTreasuryResolutionTombstone(input.transactionId);
    if (
      earlyTombstone !== undefined &&
      earlyTombstone.stage === "final" &&
      earlyTombstone.durableIdentityDigest === undefined &&
      (input.digest === undefined || earlyTombstone.digest === input.digest)
    ) {
      return { stop: { status: "already_resolved", resolution: earlyTombstone.resolution, transactionId: input.transactionId } };
    }
    if (
      input.digest !== undefined &&
      hasSettledReceipt(input.transactionId) !== undefined &&
      committedResolutionSettledAtTick(input.transactionId) === undefined
    ) {
      const earlyProof = readTreasurySettlementProof(input.transactionId);
      if (earlyProof !== undefined && earlyProof.durableIdentityDigest === undefined) {
        return { stop: { status: "already_resolved", resolution: "committed", transactionId: input.transactionId } };
      }
    }
  }
  // capability 防伪（第十轮 3.12.8）：**只读验证**（对象身份/单次未用/
  // generation/tick——零消费）。消费移至 staged resolution intent 写入之后：
  // staged 前的任何拒绝（store fatal/authority mismatch/evidence/slot）都
  // 不烧掉 capability（可重试）。
  const capabilityCheck = kernel.validateReconciliationCapability(input.capability);
  if (capabilityCheck.status !== "valid") {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "invalid_capability",
        detail: `capability 校验失败（${capabilityCheck.reason}）: ${capabilityCheck.detail}`,
      },
    };
  }
  const capability = capabilityCheck.capability;
  // resolution 是写路径：显式触发 quarantine/intent store load 验证 + resolution
  // store 验证（不可信 store 上不得执行）。
  const quarantineFatal = ensureTreasuryQuarantineStoreValidated();
  const intentFatal = ensureTreasuryIntentStoreValidated();
  const resolutionFatal = ensureTreasuryResolutionStoreValidated();
  if (resolutionFatal !== null) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "resolution_store_fatal", detail: `${resolutionFatal}（不可信 store 上不得执行 resolution）` },
    };
  }
  if (intentFatal !== null) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "intent_store_fatal", detail: `${intentFatal}（不可信 intent store 上不得执行 resolution）` },
    };
  }
  const quarantineHealth = quarantineFatal !== null ? { healthy: false, detail: quarantineFatal } : peekTreasuryQuarantineHealth();
  if (!quarantineHealth.healthy) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "quarantine_store_fatal",
        detail: quarantineHealth.detail ?? "quarantine store 损坏（不可信 store 上不得执行 resolution）",
      },
    };
  }
  const authorityResolution = resolveTreasuryUnresolvedAuthority(input.transactionId);
  if (authorityResolution.status === "store_unhealthy") {
    // 【第十六轮第八节】intent/quarantine store fatal → 零副作用拒绝（不
    // refresh receipt、不释放 authority、不清 marker、不 finalize、不签发）。
    countRejected();
    return {
      stop: { status: "rejected", reason: "authority_store_unhealthy", detail: authorityResolution.detail },
    };
  }
  if (authorityResolution.status === "not_found") {
    // 【第十二轮 3.3/3.4】幂等快路径必须验证完整 attempt identity：以
    // capability 绑定的 identity 与 tombstone / settlement proof 比较——
    // identity 不同（conflict）或 proof 缺少现代身份事实（insufficient）
    // 都不得 already_resolved（同 ID 新 attempt 的旧 proof 无效）。
    const attempt: TreasuryAttemptIdentity = {
      digest: capability.digest,
      ...(capability.contractDigest !== undefined ? { contractDigest: capability.contractDigest } : {}),
      ...(capability.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: capability.authorizationCohortDigest } : {}),
      ...(capability.durableIdentityDigest !== undefined ? { durableIdentityDigest: capability.durableIdentityDigest } : {}),
      ...(capability.lowlevelSource !== undefined ? { lowlevelSource: capability.lowlevelSource } : {}),
      ...(capability.lineageId !== undefined ? { lineageId: capability.lineageId } : {}),
      ...(capability.lineageGeneration !== undefined ? { lineageGeneration: capability.lineageGeneration } : {}),
      ...(capability.parentTransactionId !== undefined ? { parentTransactionId: capability.parentTransactionId } : {}),
      ...(capability.lineageBindingDigest !== undefined ? { lineageBindingDigest: capability.lineageBindingDigest } : {}),
    };
    const tombstone = readTreasuryResolutionTombstone(input.transactionId);
    if (tombstone !== undefined && tombstone.stage === "final") {
      if (treasuryAttemptIdentityRelation(tombstone, attempt) === "match") {
        return { stop: { status: "already_resolved", resolution: tombstone.resolution, transactionId: input.transactionId } };
      }
      return {
        stop: {
          status: "rejected",
          reason: "not_found",
          detail: `transactionId ${input.transactionId.slice(0, 48)} 的 durable authority 已释放，但既有 final tombstone 与本次 attempt identity 不一致——不得以旧 proof 解决新 attempt（fail closed）`,
        },
      };
    }
    if (hasSettledReceipt(input.transactionId) !== undefined || committedResolutionSettledAtTick(input.transactionId) !== undefined) {
      const proof = readTreasurySettlementProof(input.transactionId);
      const committedTombstone = readTreasuryResolutionTombstone(input.transactionId);
      // 【第十四轮第七节】receipt proof 视图完整传递全部身份字段——不再只传
      // digest+durableIdentityDigest 子集（cohort/contract 不同即 conflict）。
      const relation = proof !== undefined
        ? treasuryAttemptIdentityRelation(
            {
              digest: proof.digest ?? attempt.digest,
              ...(proof.contractDigest !== undefined ? { contractDigest: proof.contractDigest } : {}),
              ...(proof.authorizationCohortDigest !== undefined
                ? { authorizationCohortDigest: proof.authorizationCohortDigest }
                : {}),
              ...(proof.durableIdentityDigest !== undefined ? { durableIdentityDigest: proof.durableIdentityDigest } : {}),
              ...(proof.lineageId !== undefined ? { lineageId: proof.lineageId } : {}),
              ...(proof.lineageGeneration !== undefined ? { lineageGeneration: proof.lineageGeneration } : {}),
              ...(proof.parentTransactionId !== undefined ? { parentTransactionId: proof.parentTransactionId } : {}),
              ...(proof.lineageBindingDigest !== undefined ? { lineageBindingDigest: proof.lineageBindingDigest } : {}),
            },
            attempt,
          )
        : committedTombstone !== undefined
          ? treasuryAttemptIdentityRelation(committedTombstone, attempt)
          : "insufficient" as const;
      if (relation === "match") {
        return { stop: { status: "already_resolved", resolution: "committed", transactionId: input.transactionId } };
      }
      return {
        stop: {
          status: "rejected",
          reason: "not_found",
          detail: `transactionId ${input.transactionId.slice(0, 48)} 的 durable authority 已释放，但 committed proof 与本次 attempt identity 不一致——fail closed`,
        },
      };
    }
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "not_found",
        detail: `transactionId ${input.transactionId.slice(0, 48)} 不在 durable quarantine/intent（可能已解决或从未隔离）`,
      },
    };
  }
  if (authorityResolution.status === "inconsistent") {
    countRejected();
    return { stop: { status: "rejected", reason: "authority_inconsistent", detail: `${authorityResolution.detail}` } };
  }
  const authority = authorityResolution.authority;
  if (capability.transactionId !== input.transactionId) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "invalid_capability",
        detail: `capability 绑定 transactionId ${capability.transactionId}，请求 ${input.transactionId}`,
      },
    };
  }
  if (capability.digest !== authority.digest) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "digest_mismatch", detail: `capability digest ${capability.digest} 与 authority ${authority.digest} 不一致` },
    };
  }
  if (input.digest !== undefined && authority.digest !== input.digest) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "digest_mismatch", detail: `digest 不匹配（authority ${authority.digest}，请求 ${input.digest}）` },
    };
  }
  // reconciler 绑定：capability 的 reconcilerKind 必须与 entry 的 action kind
  // 一致（结论必须来自该 action 的注册 reconciler）。
  if (capability.reconcilerKind !== authority.actionKind) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `capability 的 reconciler kind ${capability.reconcilerKind} 与 authority action kind ${authority.actionKind} 不一致`,
      },
    };
  }
  // capability 绑定强匹配（第十轮 3.12.8）：contract-backed authority（携带
  // 合同事实）的全部绑定字段必须**双方都存在且完全一致**——弱 optional 检查
  //（双方都存在才比）删除：authority 有 contract/adapter 事实而 capability
  // 缺失对应绑定即为不匹配。
  if (capability.authorityKind !== undefined && capability.authorityKind !== authority.authorityKind) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `capability 的 authorityKind ${capability.authorityKind} 与实际 authority ${authority.authorityKind} 不一致`,
      },
    };
  }
  // 【第十一轮 3.13.7】legacy authority 防御：legacyV1 quarantine 即使经
  // 其它通道进入 resolution 也拒绝（隔离不因入口不同而失效）。
  if ((authority as { legacyV1?: boolean }).legacyV1 === true) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "resolution_not_allowed", detail: "legacy v1 quarantine 不参与 resolution（无完整 contract/cohort identity——显式人工 migration/reconciliation 处理）" },
    };
  }
  // 【第十二轮 3.8】forensic incomplete authority 隔离：intent 缺失时防御性
  // 直写的最小 quarantine 不得经普通 resolution 入口释放（缺少完整身份证明
  // ——显式人工修复/迁移或专门 forensic resolution 流程处理）。
  if ((authority as { forensic?: unknown }).forensic !== undefined) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: "forensic incomplete authority 不参与普通 resolution（intent 缺失时的防御性直写，无完整 contract/cohort identity——显式 forensic 流程处理，诊断：treasuryForensicQuarantineDiagnostics）",
      },
    };
  }
  const contractBacked =
    authority.contractId !== undefined || authority.contractDigest !== undefined || authority.adapterVersion !== undefined;
  if (contractBacked) {
    if (capability.contractId === undefined || authority.contractId === undefined || capability.contractId !== authority.contractId) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 contractId 必须双方存在且一致（capability 绑定缺失即不匹配）" },
      };
    }
    if (capability.contractDigest === undefined || authority.contractDigest === undefined || capability.contractDigest !== authority.contractDigest) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 contractDigest 必须双方存在且一致" },
      };
    }
    if (authority.adapterVersion === undefined || capability.reconcilerVersion !== authority.adapterVersion) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 adapter/reconciler version 必须双方存在且一致" },
      };
    }
    // 【第十一轮 3.13.4】cohort digest 严格绑定：authority 携带 cohort 时
    // capability 必须绑定同一 canonical authorizationCohortDigest。
    if (authority.durableIdentityDigest !== undefined && capability.durableIdentityDigest !== authority.durableIdentityDigest) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 durable identity digest 与 capability 绑定不一致" },
      };
    }
    if (authority.authorizationCohortDigest !== undefined && capability.authorizationCohortDigest !== authority.authorizationCohortDigest) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 authorization cohort digest 与 capability 绑定不一致" },
      };
    }
    if (authority.durablePayloadVersion !== undefined && capability.durablePayloadVersion !== authority.durablePayloadVersion) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 durable payload version 与 capability 绑定不一致" },
      };
    }
  }
  // 【第十六轮第十一节】lowlevel provenance 强绑定：lowlevel authority 的
  // capability 必须携带相同 lowlevelSource（runtime 与 migrated 不能互相
  // 证明）；authority 无 lowlevel 来源而 capability 携带 → conflict。
  if (authority.authorityLevel === "lowlevel") {
    if (capability.lowlevelSource === undefined || authority.lowlevelSource === undefined || capability.lowlevelSource !== authority.lowlevelSource) {
      countRejected();
      return {
        stop: {
          status: "rejected",
          reason: "reconciler_mismatch",
          detail: `lowlevel authority 的 capability lowlevelSource 绑定不一致（capability ${String(capability.lowlevelSource)}，authority ${String(authority.lowlevelSource)}）——runtime 与 migrated 不能互相证明`,
        },
      };
    }
  } else if (capability.lowlevelSource !== undefined) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `非 lowlevel authority（${String(authority.authorityLevel)}）的 capability 不得携带 lowlevelSource（低层 proof 不能证明非低层 attempt）`,
      },
    };
  }
  // 【第十九轮 A.2】lineage proof 强绑定：tr1_ rearm authority 的 capability
  // 必须携带**完全相同**的完整 lineage proof——capability 不得仅凭
  // transactionId / digest / 普通 durable identity 证明 child generation
  //（generation N 的 capability 不能证明 N+1、parent 不能证明 child）。
  // 非 tr1_（initial）authority 的 capability 不得携带任何 lineage 字段。
  {
    const authorityHasLineage = authority.lineageId !== undefined;
    const capabilityHasLineage =
      capability.lineageId !== undefined || capability.lineageGeneration !== undefined ||
      capability.parentTransactionId !== undefined || capability.lineageBindingDigest !== undefined;
    if (authorityHasLineage !== capabilityHasLineage) {
      countRejected();
      return {
        stop: {
          status: "rejected",
          reason: "reconciler_mismatch",
          detail: authorityHasLineage
            ? `tr1_ rearm authority 的 capability 缺少 lineage proof 绑定（child generation 不可证明——fail closed）`
            : `非 rearm authority（initial attempt）的 capability 不得携带 lineage proof（initial 不能被 lineage proof 证明）`,
        },
      };
    }
    if (
      authorityHasLineage &&
      (capability.lineageId !== authority.lineageId ||
        capability.lineageGeneration !== authority.lineageGeneration ||
        capability.parentTransactionId !== authority.parentTransactionId ||
        capability.lineageBindingDigest !== authority.lineageBindingDigest)
    ) {
      countRejected();
      return {
        stop: {
          status: "rejected",
          reason: "reconciler_mismatch",
          detail: `capability 绑定的 lineage proof 与 authority 不一致（lineageId/generation/parent/binding 任一不同——不同 generation 的 proof 互不证明）`,
        },
      };
    }
  }
  // 时序：当前 tick 严格晚于故障 tick；capability 观察严格晚于故障 tick 且
  // 不晚于当前 tick（stale/未来观察均拒绝）。
  if (Game.time <= authority.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: `当前 tick ${String(Game.time)} 未晚于故障 tick ${String(authority.recordedAt)}（同 tick 不得 resolution）`,
      },
    };
  }
  if (capability.postFaultEpoch.observedAtTick <= authority.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: `capability 基于 tick ${String(capability.postFaultEpoch.observedAtTick)} 的观察——尚未建立故障后 shared observation（故障 tick ${String(authority.recordedAt)}）`,
      },
    };
  }
  if (capability.observationTick <= authority.recordedAt) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "stale_observation", detail: `capability 观察 tick ${String(capability.observationTick)} 不晚于故障 tick ${String(authority.recordedAt)}` },
    };
  }
  if (capability.observationTick > Game.time) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "invalid_input", detail: `capability 观察 tick ${String(capability.observationTick)} 晚于当前 tick ${String(Game.time)}` },
    };
  }
  if (capability.conclusion === "still_uncertain") {
    recordTreasuryResolutionEvent("uncertain");
    return {
      stop: {
        status: "uncertain",
        transactionId: input.transactionId,
        detail: "reconciler 结论为 still_uncertain——保持 quarantine/intent 与全部占用，不解锁",
      },
    };
  }
  return { authority, capability };
}

/**
 * 【第十四轮第十一节】authority 显式等级 → tombstone proof class 映射：
 * modern → identity-bound（完整 contract/cohort/durable 身份矩阵由 authority
 * 等级保证）；lowlevel → lowlevel（durable-only）；legacy/forensic/缺失 →
 * null（不得走普通 staged resolution——capability 签发等级门禁已挡，此处
 * 防御性拒绝）。
 */
function resolutionProofLevelOfAuthority(
  authority: TreasuryUnresolvedAuthority,
): TreasuryResolutionProofLevel | null {
  if (authority.authorityLevel === "modern") return "identity-bound";
  if (authority.authorityLevel === "lowlevel") return "lowlevel";
  return null;
}

/**
 * resolve-as-committed（staged）：slot 预检 → resolving tombstone → receipt
 * 刷新（resolution tick）→ 释放 quarantine/intent → 清 marker → finalize。
 * 原 action tick 保留在 tombstone（审计）；不向当前 tick overlay/journal
 * 重放历史动作。
 */
export function resolveTreasuryQuarantinedTransactionAsCommitted(
  serviceHolder: object,
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const kernel = resolutionKernelOf(serviceHolder);
  if (kernel === undefined) {
    countRejected();
    return { status: "rejected", reason: "invalid_input", detail: "对象不持有 resolution kernel（non-enumerable symbol 通道——结构兼容的伪 service 无效；对外入口是 service.resolveUnresolvedTransaction）" };
  }
  const pre = prevalidate(kernel, input);
  if ("stop" in pre) return pre.stop;
  const { authority, capability } = pre;
  if (capability.conclusion !== "observed_committed") {
    countRejected();
    return {
      status: "rejected",
      reason: "evidence_mismatch",
      detail: `resolve-as-committed 需要 observed_committed 结论（got ${capability.conclusion}）`,
    };
  }
  // staged 第 1 步：slot 预检（任何原状态变化之前）。
  const slotError = ensureTreasuryResolutionSlotAvailable();
  if (slotError !== null) {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: slotError };
  }
  // staged 第 2 步：resolving tombstone 落盘（resolution-intent）。
  // 【第十四轮第十一节】显式 proof class（modern → identity-bound；
  // lowlevel → lowlevel；其余等级防御拒绝——不得隐式降级 legacy）。
  const resolvingProofLevel = resolutionProofLevelOfAuthority(authority);
  if (resolvingProofLevel === null) {
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_not_allowed",
      detail: `authority 等级 ${String(authority.authorityLevel)} 不参与普通 staged resolution（无对应 proof class——显式 forensic/legacy 流程处理）`,
    };
  }
  // 【第十九轮 A.3】tr1_ authority 的完整 lineage proof 进 tombstone（resolving
  // 与 final 同源——verdict / verifier / marker 清除全部按此比较）。
  const authorityLineageProofSpread = {
    ...(authority.lineageId !== undefined ? { lineageId: authority.lineageId } : {}),
    ...(authority.lineageGeneration !== undefined ? { lineageGeneration: authority.lineageGeneration } : {}),
    ...(authority.parentTransactionId !== undefined ? { parentTransactionId: authority.parentTransactionId } : {}),
    ...(authority.lineageBindingDigest !== undefined ? { lineageBindingDigest: authority.lineageBindingDigest } : {}),
  };
  const resolvingWrite = writeTreasuryResolutionTombstone({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "committed",
    stage: "resolving",
    proofLevel: resolvingProofLevel,
    actionTick: authority.actionTick,
    settledAtTick: Game.time,
    observationTick: capability.observationTick,
    resolvedAtTick: Game.time,
    reconcilerKind: capability.reconcilerKind,
    source: "capability",
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(resolvingProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    ...authorityLineageProofSpread,
  });
  if (resolvingWrite.status === "rejected") {
    countRejected();
    return { status: "rejected", reason: "resolution_store_fatal", detail: `resolving tombstone 写入失败: ${resolvingWrite.detail}` };
  }
  // 【第二十二轮第七节】committed cleanup journal entry：settlement proof
  // （resolving tombstone）持久化即创建——四个持久阶段（marker discharge /
  // authority release / outcome finalization / lineage finalization）的
  // pending 权威，global reset 后从 Memory 重建。
  openTreasuryResolutionCleanup({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "committed",
    identityProfile: treasuryIdentityProfileOfProofClass(resolvingProofLevel) ?? "legacy-replay",
    proofClass: resolvingProofLevel,
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    ...(authority.lineageId !== undefined ? { lineageId: authority.lineageId } : {}),
    ...(authority.lineageGeneration !== undefined ? { lineageGeneration: authority.lineageGeneration } : {}),
    ...(authority.parentTransactionId !== undefined ? { parentTransactionId: authority.parentTransactionId } : {}),
    ...(authority.lineageBindingDigest !== undefined ? { lineageBindingDigest: authority.lineageBindingDigest } : {}),
  });
  // 【第十轮 3.12.8】capability 消费时点：staged resolution intent（resolving
  // tombstone）写入成功后才消费——此前任何拒绝都不烧掉 capability；此后
  // 中断由 durable staged state 跨 reset 幂等恢复（不依赖旧 capability）。
  const consumedNow = kernel.consumeReconciliationCapability(input.capability);
  if (consumedNow.status !== "valid") {
    // 防御分支（validate 通过后同步窗口内无失效源）：回滚 tombstone。
    deleteTreasuryResolutionTombstone(authority.transactionId);
    countRejected();
    return { status: "rejected", reason: "invalid_capability", detail: `capability 消费失败（${consumedNow.reason}）: ${consumedNow.detail}` };
  }
  // staged 第 3 步：receipt 刷新（既有 receipt 真正更新到 resolution tick）。
  // 【第十三轮第六节】identity-aware：携带完整 attempt 身份；blocked（同 id
  // 既有 proof 为 legacy/与当前 attempt 冲突/证明不足）不得覆盖——回滚
  // tombstone（零原状态变化），quarantine/marker 不动，authority 保持。
  const receipt = refreshSettledReceiptForResolution(authority.transactionId, Game.time, {
    ...(authority.digest !== undefined ? { digest: authority.digest } : {}),
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined
      ? { authorizationCohortDigest: authority.authorizationCohortDigest }
      : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    ...authorityLineageProofSpread,
  });
  if (receipt.status === "fatal") {
    // receipt 不可写：回滚 tombstone（零原状态变化），quarantine/marker 不动。
    deleteTreasuryResolutionTombstone(authority.transactionId);
    countRejected();
    return { status: "rejected", reason: "receipt_store_fatal", detail: receipt.detail };
  }
  if (receipt.status === "blocked") {
    deleteTreasuryResolutionTombstone(authority.transactionId);
    countRejected();
    return {
      status: "rejected",
      reason: receipt.reason === "identity_conflict" ? "settlement_identity_conflict" : "settlement_proof_insufficient",
      detail: `receipt 刷新被身份验证阻断（${receipt.reason}）: ${receipt.detail}——authority 保持，显式处理`,
    };
  }
  // staged 第 4 步【第十五轮第十三节】：重新读取持久 receipt proof + 重新
  // 解析 unified authority → 统一三方 committed proof verifier（与 staged
  // recovery 复用同一 verifier）。不得仅凭 refresh 返回成功释放——refresh
  // 成功后 receipt 被篡改、双 authority 变 inconsistent、proof 变 legacy/
  // insufficient 都在此 fail closed（authority 与 resolving tombstone 保留，
  // 由 beginTick 恢复继续阻断）。
  runImmediateResolutionFaultInjector();
  const readBackProof = readTreasurySettlementProof(authority.transactionId);
  const postRefreshAuthority = resolveTreasuryUnresolvedAuthority(authority.transactionId);
  // 【第二十轮 13.4】tr1_ 的 semantic lineage verdict（三方互相 match ≠ 真实
  // generation——child ID 派生/parent/binding/authority 状态语义独立验证）。
  const semanticLineageVerdict = semanticLineageVerdictOfAuthorityFacts(authority);
  const committedVerdict = verifyTreasuryCommittedResolutionProof({
    tombstone: {
      transactionId: authority.transactionId,
      digest: authority.digest,
      proofLevel: resolvingProofLevel,
      settledAtTick: Game.time,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(resolvingProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
      ...authorityLineageProofSpread,
    },
    authorityResolution: postRefreshAuthority,
    receiptProof: readBackProof,
    ...(semanticLineageVerdict !== undefined ? { semanticLineageVerdict } : {}),
  });
  if (committedVerdict.status !== "verified") {
    countRejected();
    return {
      status: "rejected",
      reason: committedVerdict.status === "authority_inconsistent"
        ? "authority_inconsistent"
        : committedVerdict.status === "authority_store_unhealthy"
          ? "authority_store_unhealthy"
          : committedVerdict.status === "conflict"
            ? "settlement_identity_conflict"
            : "settlement_proof_insufficient",
      detail: `committed proof 三方验证失败（${committedVerdict.status}）: ${committedVerdict.detail}——authority 与 resolving tombstone 保留（beginTick 恢复幂等重验）`,
    };
  }
  // staged 第 5-7 步【第二十二轮 7.3】：marker discharge（read-back）→ 释放
  // quarantine/intent → read-back 确认 not_found → finalize。discharge 先于
  // release：marker 清除时 Authority 仍在，可继续阻断 writer；即使清 marker
  // 后中断，Intent/Quarantine 仍阻断——不形成"Authority 已删、Marker 无法
  // 证明"的孤儿状态。
  const committedDischarge = dischargeTreasuryMarkerForAttempt(
    treasuryMarkerDischargeExpectedOfFacts({
      transactionId: authority.transactionId,
      digest: authority.digest,
      proofClass: resolvingProofLevel,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(resolvingProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
      ...(authority.lineageId !== undefined ? { lineageId: authority.lineageId } : {}),
      ...(authority.lineageGeneration !== undefined ? { lineageGeneration: authority.lineageGeneration } : {}),
      ...(authority.parentTransactionId !== undefined ? { parentTransactionId: authority.parentTransactionId } : {}),
      ...(authority.lineageBindingDigest !== undefined ? { lineageBindingDigest: authority.lineageBindingDigest } : {}),
    }),
  );
  if (!treasuryMarkerDischargeCompletesAttemptPhase(committedDischarge.outcome)) {
    // marker 清理未完成：authority 与 resolving tombstone 保留（beginTick
    // journal 恢复幂等重试 discharge）；不释放、不 finalize。
    countRejected();
    return {
      status: "rejected",
      reason: "marker_cleanup_blocked",
      detail: `committed resolution 的 marker discharge 未完成（${committedDischarge.outcome}: ${committedDischarge.detail}）——authority 保留，恢复稍后重试`,
    };
  }
  markTreasuryResolutionCleanupStage(authority.transactionId, "marker_discharge", committedDischarge.outcome);
  releaseTreasuryQuarantineEntry(authority.transactionId);
  releaseTreasuryIntentEntry(authority.transactionId);
  if (resolveTreasuryUnresolvedAuthority(authority.transactionId).status === "not_found") {
    markTreasuryResolutionCleanupStage(authority.transactionId, "authority_release");
  }
  const finalizeWrite = writeTreasuryResolutionTombstone({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "committed",
    stage: "final",
    proofLevel: resolvingProofLevel,
    actionTick: authority.actionTick,
    settledAtTick: Game.time,
    observationTick: capability.observationTick,
    resolvedAtTick: Game.time,
    reconcilerKind: capability.reconcilerKind,
    source: "capability",
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(resolvingProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    ...authorityLineageProofSpread,
  });
  if (finalizeWrite.status === "rejected") {
    // finalize 失败：保持 resolving（beginTick 恢复幂等完成——receipt 已写、
    // quarantine 已释放），显式返回 faulted 语义（resolution_store_fatal）。
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_store_fatal",
      detail: `finalize 写入失败（恢复将在下一 beginTick 幂等完成）: ${finalizeWrite.detail}`,
    };
  }
  recordTreasuryResolutionEvent("committed");
  markTreasuryResolutionCleanupStage(authority.transactionId, "outcome_finalization");
  if (!isTreasuryRearmAttemptId(authority.transactionId)) {
    // initial attempt 无 lineage 终态阶段（not_applicable）——journal 直接完成。
    markTreasuryResolutionCleanupStage(authority.transactionId, "lineage_finalization");
    completeTreasuryResolutionCleanup(authority.transactionId);
  }
  // 【第十八轮 24.3】【第十九轮 A.6】【第二十轮 13.6】resolution-as-committed 后
  // tr1_ child 的 lineage 最终 chain-committed：receipt 已是 committed 权威——
  // 推进前按**完整 exact settlement identity**（digest/contract/cohort/durable/
  // lowlevel + lineage 四字段 + proof class）与 lineage record current 一致验证
  //（generation 混用与 identity 降级防御）。不匹配 → 保持 child_active（beginTick
  // 补完成同样按 matching receipt 判定，不会推进）；close 写入结果不被忽略——
  // 失败保持 pending（可恢复，beginTick 幂等补完成），不伪装已完成。
  if (isTreasuryRearmAttemptId(authority.transactionId)) {
    const chainLineage = lookupTreasuryAttemptLineageByAttemptId(authority.transactionId);
    if (chainLineage !== undefined && chainLineage.state === "child_active" && chainLineage.currentTransactionId === authority.transactionId) {
      const committedProof = readTreasurySettlementProof(authority.transactionId);
      const proofLineageMatchesRecord =
        committedProof !== undefined &&
        committedProof.lineageId === chainLineage.lineageId &&
        committedProof.lineageGeneration === chainLineage.generation &&
        committedProof.parentTransactionId === chainLineage.currentParentTransactionId &&
        committedProof.lineageBindingDigest === chainLineage.bindingDigest;
      // exact settlement identity 维度（同 digest/lineage 但 contract/cohort/
      // durable/lowlevel 不同的 receipt 不得推进 chain）。
      const proofIdentityMatchesRecord =
        committedProof !== undefined &&
        committedProof.digest === chainLineage.currentIdentity.digest &&
        (committedProof.contractDigest ?? undefined) === (chainLineage.currentIdentity.contractDigest ?? undefined) &&
        (committedProof.authorizationCohortDigest ?? undefined) === (chainLineage.currentIdentity.authorizationCohortDigest ?? undefined) &&
        (committedProof.durableIdentityDigest ?? undefined) === (chainLineage.currentIdentity.durableIdentityDigest ?? undefined) &&
        (committedProof.lowlevelSource ?? undefined) === (chainLineage.currentIdentity.lowlevelSource ?? chainLineage.lowlevelSource ?? undefined);
      if (proofLineageMatchesRecord && proofIdentityMatchesRecord) {
        const closed = closeTreasuryLineageAsChainCommitted(chainLineage.lineageId);
        if (closed.status === "rejected") {
          // 写入失败：保持 child_active（可恢复 pending——beginTick 的
          // commit-pending 补完成按同一 matching receipt 幂等重试）。
          recordTreasuryResolutionEvent("chainCommitPendingRetries");
        } else {
          markTreasuryResolutionCleanupStage(authority.transactionId, "lineage_finalization");
          completeTreasuryResolutionCleanup(authority.transactionId);
        }
      }
    }
  }
  return {
    status: "resolved",
    resolution: "committed",
    transactionId: authority.transactionId,
    receiptWritten: true,
    // 【第二十二轮 17.3】unrelated marker 场景：当前 attempt complete，但
    // Treasury 全局 write lock 仍被另一 fault 持有（明确表达两个事实）。
    globalWriteAdmissionStillLocked: committedDischarge.globalWriteAdmissionStillLocked,
    sameIdRetryAllowed: false, // receipt 已刷新：同 id 重放命中 already_settled（防重放）
    actionTick: authority.actionTick,
    settledAtTick: Game.time,
  };
}

/**
 * 【第十七轮第六节】not-executed lineage preparation：从 authority（释放前
 * 的完整 facts）计算 retry semantic digest 并做 lineage 容量预检。返回
 * rejected 时零持久副作用（capability 不消费、tombstone 不写、authority
 * 不释放——lineage 容量不足 fail closed）。
 */
function prepareTreasuryNotExecutedLineage(
  authority: TreasuryUnresolvedAuthority,
  finalProofLevel: TreasuryResolutionProofLevel,
):
  | {
      readonly status: "prepared";
      readonly retrySemanticDigest: string | null;
      readonly retryFactsInsufficient: boolean;
    }
  | { readonly status: "rejected"; readonly detail: string } {
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) {
    return { status: "rejected", detail: lineageHealth.detail ?? "lineage store 损坏（不可信 store 上不得建立 retirement 权威）" };
  }
  const slotError = ensureTreasuryLineageSlotAvailable(authority.transactionId);
  if (slotError !== null) {
    return { status: "rejected", detail: slotError };
  }
  // retry semantic facts：authority 释放前的原始 entry（intent/quarantine）
  // 是完整事实来源——释放后 facts 丢失，必须在 staged 协议内先行计算。
  const intent = readTreasuryIntentEntry(authority.transactionId);
  const quarantine = readTreasuryQuarantineEntry(authority.transactionId);
  // intent 用 postings、quarantine 用 deltas（同构 canonical postings 事实）。
  const entryFacts:
    | {
        readonly kind: string;
        readonly source: string;
        readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
        readonly adapterVersion?: number;
        readonly adapterRetryFacts?: string;
        readonly adapterSemanticIdentity?: string;
        readonly structureFacts?: readonly ({ readonly [key: string]: unknown })[];
        readonly durablePayload?: string;
        readonly durablePayloadVersion?: number;
        readonly ownerIdentity?: string;
      }
    | undefined = (() => {
    if (intent !== undefined) {
      return {
        kind: intent.kind,
        source: intent.source,
        postings: intent.postings,
        ...(intent.adapterVersion !== undefined ? { adapterVersion: intent.adapterVersion } : {}),
        ...(intent.adapterRetryFacts !== undefined ? { adapterRetryFacts: intent.adapterRetryFacts } : {}),
        ...(intent.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: intent.adapterSemanticIdentity } : {}),
        ...(intent.structureFacts !== undefined ? { structureFacts: intent.structureFacts as unknown as readonly { readonly [key: string]: unknown }[] } : {}),
        ...(intent.durablePayload !== undefined ? { durablePayload: intent.durablePayload } : {}),
        ...(intent.durablePayloadVersion !== undefined ? { durablePayloadVersion: intent.durablePayloadVersion } : {}),
        ...(intent.ownerIdentity !== undefined ? { ownerIdentity: intent.ownerIdentity } : {}),
      };
    }
    if (quarantine !== undefined) {
      return {
        kind: quarantine.kind,
        source: quarantine.source,
        postings: quarantine.deltas,
        ...(quarantine.adapterVersion !== undefined ? { adapterVersion: quarantine.adapterVersion } : {}),
        ...(quarantine.adapterRetryFacts !== undefined ? { adapterRetryFacts: quarantine.adapterRetryFacts } : {}),
        ...(quarantine.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: quarantine.adapterSemanticIdentity } : {}),
        ...(quarantine.structureFacts !== undefined ? { structureFacts: quarantine.structureFacts as unknown as readonly { readonly [key: string]: unknown }[] } : {}),
        ...(quarantine.durablePayload !== undefined ? { durablePayload: quarantine.durablePayload } : {}),
        ...(quarantine.durablePayloadVersion !== undefined ? { durablePayloadVersion: quarantine.durablePayloadVersion } : {}),
        ...(quarantine.ownerIdentity !== undefined ? { ownerIdentity: quarantine.ownerIdentity } : {}),
      };
    }
    return undefined;
  })();
  if (entryFacts === undefined) {
    // 归一化 authority 存在但两侧原始 entry 均缺失——不一致（resolver 已
    // 在 prevalidate 校验过；防御分支）。
    return { status: "rejected", detail: "authority 归一化视图存在但原始 intent/quarantine entry 缺失（facts 不可重建）" };
  }
  if (finalProofLevel === "lowlevel") {
    const facts = lowlevelRetrySemanticFactsOfEntry({
      kind: entryFacts.kind,
      source: entryFacts.source,
      postings: entryFacts.postings,
      lowlevelSource: authority.lowlevelSource,
      durablePayload: entryFacts.durablePayload,
      durablePayloadVersion: entryFacts.durablePayloadVersion,
      adapterSemanticIdentity: entryFacts.adapterSemanticIdentity,
    });
    if (facts === null) {
      return { status: "prepared", retrySemanticDigest: null, retryFactsInsufficient: true };
    }
    const digest = computeTreasuryLowlevelRetrySemanticDigest(facts);
    return { status: "prepared", retrySemanticDigest: digest, retryFactsInsufficient: digest === null };
  }
  const facts = modernRetrySemanticFactsOfEntry({
    actionKind: entryFacts.kind,
    kind: entryFacts.kind,
    ...(entryFacts.adapterVersion !== undefined ? { adapterVersion: entryFacts.adapterVersion } : {}),
    ...(entryFacts.adapterRetryFacts !== undefined ? { adapterRetryFacts: entryFacts.adapterRetryFacts } : {}),
    ...(entryFacts.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: entryFacts.adapterSemanticIdentity } : {}),
    postings: entryFacts.postings,
    ...(entryFacts.structureFacts !== undefined ? { structureFacts: entryFacts.structureFacts } : {}),
    ...(entryFacts.durablePayload !== undefined ? { durablePayload: entryFacts.durablePayload } : {}),
    ...(entryFacts.durablePayloadVersion !== undefined ? { durablePayloadVersion: entryFacts.durablePayloadVersion } : {}),
    source: entryFacts.source,
    ...(entryFacts.ownerIdentity !== undefined ? { ownerIdentity: entryFacts.ownerIdentity } : {}),
  });
  if (facts === null) {
    return { status: "prepared", retrySemanticDigest: null, retryFactsInsufficient: true };
  }
  const digest = computeTreasuryModernRetrySemanticDigest(facts);
  return { status: "prepared", retrySemanticDigest: digest, retryFactsInsufficient: digest === null };
}

/**
 * 【第十八轮 24.1】写 lineage retirement candidate 并 read-back（**先于
 * capability 消费、tombstone 写入与 authority release**——candidate 是
 * root/current 的永久退休权威，可安全先行）：root 无既有 lineage → 创建
 * retiring candidate；既有 lineage（本 attempt 是 current）→ current
 * not-executed 退休（child_active → retiring）。幂等重入（已 retiring 且
 * identity 匹配 → published，不重复推进）；写后从 Memory 实际副本 read-back
 * 并与 authority identity 完全匹配验证——任一失败返回 pending（调用侧保留
 * intent/quarantine/marker/pending-release 并返回 lineage_publication_pending）。
 */
function publishTreasuryNotExecutedLineage(
  authority: TreasuryUnresolvedAuthority,
  finalProofLevel: TreasuryResolutionProofLevel,
  retrySemanticDigest: string | null,
): { readonly status: "published" | "pending" } {
  // entry 事实（intent 优先；publish 发生在 authority 释放之前——entry 在场）。
  const intent = readTreasuryIntentEntry(authority.transactionId);
  const quarantine = readTreasuryQuarantineEntry(authority.transactionId);
  const entryAdapterSemanticIdentity = intent?.adapterSemanticIdentity ?? quarantine?.adapterSemanticIdentity;
  const entryOwnerIdentity = intent?.ownerIdentity ?? quarantine?.ownerIdentity;
  const identity: TreasuryAttemptLineageIdentity = {
    digest: authority.digest,
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(finalProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
  };
  const authorityClass: TreasuryLineageAuthorityClass = finalProofLevel === "lowlevel" ? "lowlevel" : "identity-bound";
  const rearmable = retrySemanticDigest !== null;
  const existing = lookupTreasuryAttemptLineageByAttemptId(authority.transactionId);
  if (existing === undefined) {
    // 新 root chain。
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: authority.transactionId,
      rootIdentity: identity,
      actionKind: authority.actionKind || authority.kind,
      ...(entryAdapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: entryAdapterSemanticIdentity } : {}),
      ...(entryOwnerIdentity !== undefined ? { ownerIdentity: entryOwnerIdentity } : {}),
      authorityClass,
      ...(finalProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
      rearmable,
      ...(retrySemanticDigest !== null ? { retrySemanticDigest } : {}),
      ...(rearmable ? {} : { nonRearmReason: retrySemanticDigest === null ? "retry semantic facts 不足（无法证明 child 是 parent 动作的语义重试）" : "non-rearmable" }),
    });
    if (created.status === "rejected") return { status: "pending" };
  } else {
    if (existing.currentTransactionId === authority.transactionId && existing.state === "retiring") {
      // 幂等重入：candidate 已持久化（consume/tombstone 写失败后的重试）。
      // identity 必须仍与 authority 完全匹配（篡改 → pending，fail closed）。
      const stillMatching =
        existing.currentIdentity.digest === identity.digest &&
        existing.currentIdentity.contractDigest === identity.contractDigest &&
        existing.currentIdentity.authorizationCohortDigest === identity.authorizationCohortDigest &&
        existing.currentIdentity.durableIdentityDigest === identity.durableIdentityDigest &&
        existing.authorityClass === authorityClass;
      return stillMatching ? { status: "published" } : { status: "pending" };
    }
    // 既有 chain：本 attempt 是 current（child 退休）——推进 retirement 阶段
    //（单一权威 helper：清 next-child、三段复位、retirementGeneration 归属
    // 当前代）。非 child_active 状态由状态机拒绝 → pending（fail closed）。
    const updated = retireTreasuryLineageCurrentAttempt({
      lineageId: existing.lineageId,
      ...(retrySemanticDigest !== null ? { retrySemanticDigest } : {}),
    });
    if (updated.status === "rejected") return { status: "pending" };
  }
  // ── read-back（从 Memory 实际副本）：record 存在、current 是本 attempt、
  //    identity 与 authority 完全匹配——否则视为 publication 失败。
  const readBackRecord = lookupTreasuryAttemptLineageByAttemptId(authority.transactionId);
  if (readBackRecord === undefined || readBackRecord.currentTransactionId !== authority.transactionId) {
    return { status: "pending" };
  }
  const identityMatch =
    readBackRecord.currentIdentity.digest === identity.digest &&
    readBackRecord.currentIdentity.contractDigest === identity.contractDigest &&
    readBackRecord.currentIdentity.authorizationCohortDigest === identity.authorizationCohortDigest &&
    readBackRecord.currentIdentity.durableIdentityDigest === identity.durableIdentityDigest &&
    readBackRecord.currentIdentity.lowlevelSource === identity.lowlevelSource &&
    readBackRecord.authorityClass === authorityClass &&
    readBackRecord.retirementGeneration === readBackRecord.generation &&
    readBackRecord.retirement.lineagePublished;
  return identityMatch ? { status: "published" } : { status: "pending" };
}

/**
 * 【第十七轮第六节】not-executed retirement 三段完成（lineage publication、
 * authority release、marker cleanup 全部完成后调用）：rearmable →
 * rearm_ready（capability 可申请）；non-rearmable → 终态 non_rearmable_
 * retired（永久阻断 parent、不签发 capability）。
 */
function completeTreasuryNotExecutedRetirement(transactionId: string): { readonly status: "completed" | "pending" | "rejected" } {
  const lineage = lookupTreasuryAttemptLineageByAttemptId(transactionId);
  if (lineage === undefined) return { status: "rejected" };
  // 【第十九轮 C.1/C.7】三段分别由持久证明推进（publication: retire 转换
  // 内置；release: 统一 resolver not_found；marker: class-aware 清除后重读
  // 不存在/不指向本 attempt）——converge 单一权威收敛，不再无条件置 true。
  if (lineage.state !== "retiring") return { status: "rejected" };
  return convergeTreasuryLineageRetirementFromFacts(lineage.lineageId);
}

/**
 * resolve-as-not-executed（staged）：【第十七轮第六节】安全顺序——完整
 * prevalidate → resolution slot + **lineage 容量与 retry semantic 预检** →
 * consume capability → 写 final not-executed tombstone → **写 lineage
 * candidate 并 read-back** → 释放 quarantine/intent → identity-aware 清
 * marker（检查清除结果）→ 标记 pending release 与 lineage publication 均
 * 完成：
 * - lineage 容量不足/预检失败：capability 不消费、tombstone 不写、authority
 *   不释放（零持久副作用）；
 * - consume 失败：不写 tombstone、authority 保留、marker 保留（返回
 *   invalid_capability，beginTick 无 proof 可自动释放）；
 * - consume 成功、tombstone 写失败：authority 保留、不释放（后续 tick 重新
 *   签发 capability 重试，不形成错误终态）；
 * - tombstone 成功、lineage 写失败：authority 与 marker 保留，beginTick 经
 *   pendingRelease 索引重试 lineage publication（不做无 lineage replacement
 *   的驱逐）；
 * - marker class-aware 清除失败（conflict/insufficient）：tombstone 与
 *   pending 索引保留、lineage 保持 cleanup-pending、返回结构化
 *   pending_cleanup 状态、不进入 rearm-ready。
 * 不写 receipt、不生成 committed projection；结果不携带 rearm child ID
 * 字符串（issueTreasuryRearmCapability 是唯一交付通道）。
 */
export function resolveTreasuryQuarantinedTransactionAsNotExecuted(
  serviceHolder: object,
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const kernel = resolutionKernelOf(serviceHolder);
  if (kernel === undefined) {
    countRejected();
    return { status: "rejected", reason: "invalid_input", detail: "对象不持有 resolution kernel（non-enumerable symbol 通道——结构兼容的伪 service 无效；对外入口是 service.resolveUnresolvedTransaction）" };
  }
  const pre = prevalidate(kernel, input);
  if ("stop" in pre) return pre.stop;
  const { authority, capability } = pre;
  if (capability.conclusion !== "observed_not_executed") {
    countRejected();
    return {
      status: "rejected",
      reason: "evidence_mismatch",
      detail: `resolve-as-not-executed 需要 observed_not_executed 结论（got ${capability.conclusion}）`,
    };
  }
  if (!isTreasuryUnresolvedAuthorityNotExecutable(authority)) {
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_not_allowed",
      detail: `phase ${authority.phase} 表示 Game callback 已确认成功或终态（authorityKind 与 phase 见 detail）——不允许 resolve-as-not-executed；只能 resolve-as-committed`,
    };
  }
  // staged 第 1 步：slot 预检（任何原状态变化之前）。
  const slotError = ensureTreasuryResolutionSlotAvailable();
  if (slotError !== null) {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: slotError };
  }
  // 【第十六轮第十二节】显式 proof class（与 committed 路径同一映射）。
  const finalProofLevel = resolutionProofLevelOfAuthority(authority);
  if (finalProofLevel === null) {
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_not_allowed",
      detail: `authority 等级 ${String(authority.authorityLevel)} 不参与普通 staged resolution（无对应 proof class——显式 forensic/legacy 流程处理）`,
    };
  }
  // 【第十七轮第六节】lineage 容量与 retry semantic 预检（consume 之前——
  // 容量不足时零持久副作用）。
  const lineagePreparation = prepareTreasuryNotExecutedLineage(authority, finalProofLevel);
  if (lineagePreparation.status === "rejected") {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: `lineage replacement 预检失败（authority 保持，fail closed）: ${lineagePreparation.detail}` };
  }
  // staged 第 2 步【第十八轮 24.1 publication-before-release】：**先持久化
  // lineage retirement candidate 并 read-back**（candidate 是 root/current 的
  // 永久退休权威，可安全先行；read-back 含 identity 与 authority 完全匹配
  // 验证）。失败 → intent/quarantine/marker/pending-release 索引全部保留、
  // 不写 tombstone、不消费 capability、返回 lineage_publication_pending——
  // 下一轮从保留的 authority 重建完整 retry facts（不退化为只能
  // non-rearmable backfill）。
  const lineagePublication = publishTreasuryNotExecutedLineage(authority, finalProofLevel, lineagePreparation.retrySemanticDigest);
  if (lineagePublication.status === "pending") {
    countRejected();
    return {
      status: "rejected",
      reason: "lineage_publication_pending",
      detail: `lineage retirement candidate 持久化/read-back 失败（authority/quarantine/marker/pending-release 全部保留，下一轮可重试完整 publication——fail closed）`,
    };
  }
  // staged 第 3 步【第十六轮第十二节】：**consume capability**——final
  // tombstone 不可回滚（状态机只允许 exact idempotent），必须保证"final
  // proof 存在即表示 capability 消费阶段已完成"。consume 失败时 lineage
  // candidate 保留（retiring 权威无害——阻断同 ID 重 prepare），authority 与
  // marker 保留、不写 tombstone。
  const consumedNow = kernel.consumeReconciliationCapability(input.capability);
  if (consumedNow.status !== "valid") {
    countRejected();
    return { status: "rejected", reason: "invalid_capability", detail: `capability 消费失败（${consumedNow.reason}）: ${consumedNow.detail}——未产生 final tombstone，authority 与 marker 均保留` };
  }
  // marker class-aware 清除与 tr1_ proof 所需的 lineage record（publication
  // 已成功——record 即当前 attempt 的退休权威）。
  const lineagePublicationRecord = lookupTreasuryAttemptLineageByAttemptId(authority.transactionId);
  // 【第十九轮 A.3】lineage proof 只对 tr1_ rearm attempt 生成——root/
  // initial attempt 的 lineage record 虽有 lineageId/generation(0)，但 initial
  // 禁止携带 proof（部分字段 = 形状损坏，整体性校验 fail closed）。
  const lineageProofOfAuthority =
    lineagePublicationRecord !== undefined &&
    lineagePublicationRecord.currentTransactionId === authority.transactionId &&
    isTreasuryRearmAttemptId(authority.transactionId)
      ? {
          ...(lineagePublicationRecord.lineageId !== undefined ? { lineageId: lineagePublicationRecord.lineageId } : {}),
          ...(lineagePublicationRecord.generation !== undefined ? { lineageGeneration: lineagePublicationRecord.generation } : {}),
          ...(lineagePublicationRecord.currentParentTransactionId !== undefined ? { parentTransactionId: lineagePublicationRecord.currentParentTransactionId } : {}),
          ...(lineagePublicationRecord.bindingDigest !== undefined ? { lineageBindingDigest: lineagePublicationRecord.bindingDigest } : {}),
        }
      : {};
  // staged 第 4 步：写 final tombstone（capability 已消费——此后任何中断都
  // 由 beginTick pending-release 补完成，不存在可自动释放但未消费的 proof）。
  const finalWrite = writeTreasuryResolutionTombstone({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "not-executed",
    stage: "final",
    proofLevel: finalProofLevel,
    actionTick: authority.actionTick,
    observationTick: capability.observationTick,
    resolvedAtTick: Game.time,
    reconcilerKind: capability.reconcilerKind,
    source: "capability",
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(finalProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    ...lineageProofOfAuthority,
  });
  if (finalWrite.status === "rejected") {
    // consume 成功但 tombstone 写失败：authority 保留（本 tick capability 已
    // 消费；后续 tick 重新签发 capability 重试——不形成错误终态；lineage
    // candidate 保留为退休权威，tombstone 未写 → pendingRelease 索引无项）。
    countRejected();
    return { status: "rejected", reason: "resolution_store_fatal", detail: `final tombstone 写入失败（capability 已消费，authority 保留，后续 tick 可重新签发重试）: ${finalWrite.detail}` };
  }
  // 【第二十二轮第七节】not-executed cleanup journal entry（settlement
  // proof = final tombstone 持久化即创建——四个持久阶段的 pending 权威）。
  openTreasuryResolutionCleanup({
    transactionId: authority.transactionId,
    digest: authority.digest,
    resolution: "not-executed",
    identityProfile: treasuryIdentityProfileOfProofClass(finalProofLevel) ?? "legacy-replay",
    proofClass: finalProofLevel,
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
    ...(finalProofLevel === "lowlevel" && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    ...(authority.lineageId !== undefined ? { lineageId: authority.lineageId } : {}),
    ...(authority.lineageGeneration !== undefined ? { lineageGeneration: authority.lineageGeneration } : {}),
    ...(authority.parentTransactionId !== undefined ? { parentTransactionId: authority.parentTransactionId } : {}),
    ...(authority.lineageBindingDigest !== undefined ? { lineageBindingDigest: authority.lineageBindingDigest } : {}),
  });
  // staged 第 5 步【第二十二轮 7.4】：marker discharge（read-back）先于
  // authority release——marker 清除时 Authority 仍在；中断后 Intent/Quarantine
  // 仍阻断。discharge 未完成 → tombstone 与 pending 索引保留、lineage 保持
  // cleanup-pending、返回结构化 pending 状态（beginTick journal 幂等重试）。
  const notExecutedDischarge = dischargeTreasuryMarkerForAttempt(
    treasuryMarkerDischargeExpectedOfFacts({
      transactionId: authority.transactionId,
      digest: authority.digest,
      proofClass: finalProofLevel,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(finalProofLevel === 'lowlevel' && authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
      ...(isTreasuryRearmAttemptId(authority.transactionId) && lineagePublicationRecord?.lineageId !== undefined
        ? { lineageId: lineagePublicationRecord.lineageId }
        : {}),
      ...(isTreasuryRearmAttemptId(authority.transactionId) && lineagePublicationRecord?.generation !== undefined
        ? { lineageGeneration: lineagePublicationRecord.generation }
        : {}),
      ...(isTreasuryRearmAttemptId(authority.transactionId) && lineagePublicationRecord?.currentParentTransactionId !== undefined
        ? { parentTransactionId: lineagePublicationRecord.currentParentTransactionId }
        : {}),
      ...(isTreasuryRearmAttemptId(authority.transactionId) && lineagePublicationRecord?.bindingDigest !== undefined
        ? { lineageBindingDigest: lineagePublicationRecord.bindingDigest }
        : {}),
    }),
  );
  if (!treasuryMarkerDischargeCompletesAttemptPhase(notExecutedDischarge.outcome)) {
    recordTreasuryResolutionEvent('notExecuted');
    return {
      status: 'resolved',
      resolution: 'not-executed',
      transactionId: authority.transactionId,
      receiptWritten: false,
      sameIdRetryAllowed: false,
      actionTick: authority.actionTick,
      retirement: 'pending_cleanup',
    };
  }
  markTreasuryResolutionCleanupStage(authority.transactionId, 'marker_discharge', notExecutedDischarge.outcome);
  releaseTreasuryQuarantineEntry(authority.transactionId);
  releaseTreasuryIntentEntry(authority.transactionId);
  if (resolveTreasuryUnresolvedAuthority(authority.transactionId).status === 'not_found') {
    markTreasuryResolutionCleanupStage(authority.transactionId, 'authority_release');
  }
  // staged 第 6 步：三段收敛（exact retirement proof 写入由 converge 内部
  // 承载——【第十九轮 C.7】pending-release 索引移除与 retirement 完成共享
  // 同一阶段事实——converge 完成才移除）。
  {
    const converged = completeTreasuryNotExecutedRetirement(authority.transactionId);
    if (converged.status === 'completed') {
      markTreasuryPendingReleaseCompleted(authority.transactionId);
      markTreasuryResolutionCleanupStage(authority.transactionId, 'outcome_finalization');
      markTreasuryResolutionCleanupStage(authority.transactionId, 'lineage_finalization');
      completeTreasuryResolutionCleanup(authority.transactionId);
    }
    recordTreasuryResolutionEvent("notExecuted");
    return {
      status: "resolved",
      resolution: "not-executed",
      transactionId: authority.transactionId,
      receiptWritten: false, // 绝不写 receipt / committed projection
      sameIdRetryAllowed: false, // 【第十六轮第五节】同 ID 永不可直接重新执行
      actionTick: authority.actionTick,
      // 【第十七轮第六节】retirement 状态（child ID 只经 opaque capability 交付；
      // 【第十八轮】publication 已在前置验证成功——此处只区分 rearmable 终态）。
      retirement:
        lineagePreparation.retrySemanticDigest === null
          ? "complete_non_rearmable"
          : "complete_rearm_ready",
      globalWriteAdmissionStillLocked: notExecutedDischarge.globalWriteAdmissionStillLocked,
    };
  }
  // marker 清除失败：pending 索引保留、lineage 保持 cleanup-pending（不签发
  // rearm capability——beginTick 补完成或显式处理）。
  recordTreasuryResolutionEvent("notExecuted");
  return {
    status: "resolved",
    resolution: "not-executed",
    transactionId: authority.transactionId,
    receiptWritten: false,
    sameIdRetryAllowed: false,
    actionTick: authority.actionTick,
    retirement: "pending_cleanup",
  };
}

/**
 * 显式 repair（第七轮，quarantine 元数据 + 第八轮 intent 元数据）：全量
 * 验证现存 entries 合法后修复 store 元数据；任何 entry 损坏 → 拒绝（原
 * 数据不动，交人工处理）。绝不删除任何 entry。
 */
export function repairTreasuryQuarantineStoreForResolution(): { status: "repaired" | "rejected"; detail: string } {
  return repairTreasuryQuarantineStoreMetadataForResolution();
}

/** 诊断：当前 unresolved write-fault marker（只读）。 */
export function currentTreasuryWriteFaultMarker(): ReturnType<typeof readTreasuryWriteFault> {
  return readTreasuryWriteFault();
}
