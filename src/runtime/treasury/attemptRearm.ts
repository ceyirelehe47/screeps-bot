/**
 * 【第十六轮第五节】显式 attempt rearm 协议（确定性 child-attempt identity）。
 *
 * 背景（Round 15 遗留断链）：resolve-as-not-executed 返回
 * reprepareAllowed=true，允许同 transaction ID 直接重新执行——但同 ID 的
 * final tombstone 不可改写，同 ID 新 attempt 一旦再次故障将无法 resolution
 * （状态机只允许 exact idempotent），且旧 proof 无法证明新 attempt。
 *
 * 固定语义（5.1）：
 * - **同一个 transaction ID 永远只对应一个执行 attempt**（同 ID 直接重试的
 *   兼容路径不复存在）；
 * - not-executed 后若需重试，必须由 Treasury 显式 rearm，生成新的 child
 *   transaction ID（A 的 child = B；B 再次 not-executed 后 → C——每个 attempt
 *   最多确定性地产生一个直接 child）；
 * - rearm 是**纯确定性计算**（零写）——不持久化无界 attempt sequence 表；
 *   child ID 由 canonical tuple hash 派生（现有 transactionId 基础设施），
 *   同 parent 重复 rearm 幂等得到同一 child，跨 global reset 结果一致；
 * - parent final not-executed tombstone 继续证明 parent attempt 已结束；
 *   parent proof 不阻断 child ID，也不能释放/证明 child attempt（child 的
 *   contract/bundle/intents 全部绑定 child transaction ID，故障后独立签发
 *   capability、resolution 与 receipt）。
 *
 * Child ID 绑定成分（5.3）：rearm 协议版本 + parent transaction ID + parent
 * attempt identity（digest / contractDigest / authorizationCohortDigest /
 * durableIdentityDigest / lowlevelSource）——不同 parent、不同 parent identity
 * 得到不同 child ID；输出满足现有 transaction ID validator、长度有界
 * （tr1_ + 16hex = 20 字符）、不依赖随机数。
 *
 * 前置校验（5.2）：parent 存在 final not-executed tombstone、proof identity
 * 完整（identity-bound/lowlevel；legacy/forensic 不足 proof 不能 rearm）、
 * 不存在 parent unresolved intent/quarantine、不存在 parent resolving
 * tombstone、marker 清理已完成（7.3）、各 store 健康（第八节）。
 */

import {
  encodeTreasuryCanonicalTuple,
  hashTreasuryCanonicalString,
  isValidTreasuryTransactionId,
  TREASURY_REARM_ID_PREFIX as REARM_ID_PREFIX,
} from "@/runtime/treasury/transactionId";
import {
  ensureTreasuryResolutionStoreValidated,
  readTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";

/** rearm 协议版本（child ID 派生的 canonical 成分；协议升级时递增）。 */
export const TREASURY_ATTEMPT_REARM_PROTOCOL = "treasury-attempt-rearm@v1";

/** parent attempt identity 的完整视图（child ID 派生输入）。 */
export interface TreasuryRearmParentIdentity {
  readonly transactionId: string;
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  /** 【第二十轮 8】tr1_ parent 的 lineage 四字段（expected identity 与
   * tombstone 的完整比较维度——parent proof 不能被缺 lineage 的期望身份
   * 冒充证明）。 */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

export type TreasuryAttemptRearmResult =
  | {
      readonly status: "rearmed";
      readonly parentTransactionId: string;
      readonly childTransactionId: string;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid_input"
        | "resolution_store_fatal"
        | "parent_not_resolved"
        | "parent_proof_insufficient"
        | "parent_authority_present"
        | "parent_identity_mismatch"
        | "authority_inconsistent"
        | "authority_store_unhealthy"
        | "marker_cleanup_pending";
      readonly detail: string;
    };

/**
 * 确定性派生 rearm child transaction ID（O(1)；纯函数、无随机数、跨 global
 * reset 恒定）：`tr1_<hash16>`，hash 输入为 canonical tuple（协议版本 +
 * parent ID + parent attempt identity 全部成分）。同 parent 重复 rearm 得到
 * 同一 child；不同 parent / 不同 parent identity 得到不同 child。
 *
 * 【第十七轮第七节】**test-only 边界**：production 源码（非 .test.ts / 非
 * testHarness）不得 import 本函数（架构扫描守护）——child ID 只能经
 * service.issueTreasuryRearmCapability 签发 opaque capability 时交付
 *（production 权威派生在 attemptLineage.deriveTreasuryLineageNextChild
 * TransactionId，同一 canonical 编码）。
 */
export function deriveTreasuryRearmChildTransactionId(parent: TreasuryRearmParentIdentity): string {
  const canonical = encodeTreasuryCanonicalTuple([
    TREASURY_ATTEMPT_REARM_PROTOCOL,
    parent.transactionId,
    parent.digest,
    parent.contractDigest ?? "",
    parent.authorizationCohortDigest ?? "",
    parent.durableIdentityDigest ?? "",
    parent.lowlevelSource ?? "",
  ]);
  const childId = REARM_ID_PREFIX + hashTreasuryCanonicalString(canonical);
  if (!isValidTreasuryTransactionId(childId)) {
    // 不可达防御（tr1_ + 16hex 恒满足 charset/长度）——保持显式。
    throw new Error(`rearm child id 铸造结果不符合 Treasury transactionId 边界: ${childId}`);
  }
  return childId;
}

/**
 * 显式 rearm 入口（受控 service 方法；零写——只做前置校验与确定性派生）：
 * 全部前置满足才返回 child transaction ID，供调用方以 child ID 重新构建
 * contract 与 authorization（Production writer 不得自己拼接重试 ID 或直接
 * 重用 parent ID）。
 */
export function rearmResolvedNotExecutedAttempt(input: {
  readonly parentTransactionId: string;
  /** 可选 expected parent identity（提供时必须与 tombstone 完整 identity match）。 */
  readonly expectedParentIdentity?: TreasuryRearmParentIdentity;
}): TreasuryAttemptRearmResult {
  if (
    !input ||
    typeof input.parentTransactionId !== "string" ||
    input.parentTransactionId.length === 0 ||
    !isValidTreasuryTransactionId(input.parentTransactionId)
  ) {
    return { status: "rejected", reason: "invalid_input", detail: "parentTransactionId 缺失或非法" };
  }
  const resolutionFatal = ensureTreasuryResolutionStoreValidated();
  if (resolutionFatal !== null) {
    return {
      status: "rejected",
      reason: "resolution_store_fatal",
      detail: `${resolutionFatal}（不可信 resolution store 上不得 rearm）`,
    };
  }
  const parent = readTreasuryResolutionTombstone(input.parentTransactionId);
  if (parent === undefined) {
    return {
      status: "rejected",
      reason: "parent_not_resolved",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 无 resolution tombstone（未 resolution 或 proof 已过 retention——rearm 需要可验证的 final not-executed proof）`,
    };
  }
  if (parent.stage !== "final" || parent.resolution !== "not-executed") {
    return {
      status: "rejected",
      reason: "parent_not_resolved",
      detail: `parent tombstone 非 final not-executed（stage ${String(parent.stage)}，resolution ${String(parent.resolution)}）——resolving/committed 均不可 rearm`,
    };
  }
  if (parent.proofLevel !== "identity-bound" && parent.proofLevel !== "lowlevel") {
    return {
      status: "rejected",
      reason: "parent_proof_insufficient",
      detail: `parent proof level ${String(parent.proofLevel)} 不足（legacy/forensic proof 不能证明可安全重试的 attempt identity——显式迁移/人工处理）`,
    };
  }
  // 可选 expected parent identity：调用方携带的期望身份必须与 tombstone 完整
  // identity match（conflict/insufficient 均拒绝——不猜测）。
  if (input.expectedParentIdentity !== undefined) {
    const expected = input.expectedParentIdentity;
    const relation = treasuryAttemptIdentityRelation(parent, {
      digest: expected.digest,
      ...(expected.contractDigest !== undefined ? { contractDigest: expected.contractDigest } : {}),
      ...(expected.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: expected.authorizationCohortDigest } : {}),
      ...(expected.durableIdentityDigest !== undefined ? { durableIdentityDigest: expected.durableIdentityDigest } : {}),
      ...(expected.lowlevelSource !== undefined ? { lowlevelSource: expected.lowlevelSource } : {}),
      ...(expected.lineageId !== undefined ? { lineageId: expected.lineageId } : {}),
      ...(expected.lineageGeneration !== undefined ? { lineageGeneration: expected.lineageGeneration } : {}),
      ...(expected.parentTransactionId !== undefined ? { parentTransactionId: expected.parentTransactionId } : {}),
      ...(expected.lineageBindingDigest !== undefined ? { lineageBindingDigest: expected.lineageBindingDigest } : {}),
    } satisfies TreasuryAttemptIdentity);
    if (relation !== "match") {
      return {
        status: "rejected",
        reason: "parent_identity_mismatch",
        detail: `expected parent identity 与 tombstone ${relation}——不匹配的 parent 不得 rearm`,
      };
    }
  }
  // parent durable authority 必须已释放（不存在 unresolved intent/quarantine）；
  // resolving tombstone 已被上文 stage 检查排除（同 id 唯一 tombstone）。
  const authorityResolution = resolveTreasuryUnresolvedAuthority(input.parentTransactionId);
  if (authorityResolution.status === "ok") {
    return {
      status: "rejected",
      reason: "parent_authority_present",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 仍有 unresolved ${authorityResolution.authority.authorityKind} authority——rearm 只允许在 authority 完全释放后`,
    };
  }
  if (authorityResolution.status === "inconsistent") {
    return { status: "rejected", reason: "authority_inconsistent", detail: authorityResolution.detail };
  }
  if (authorityResolution.status === "store_unhealthy") {
    return {
      status: "rejected",
      reason: "authority_store_unhealthy",
      detail: `${authorityResolution.detail}（store_unhealthy 上零 rearm——不得把 store 损坏当作已释放）`,
    };
  }
  // 【7.3】marker 清理前置：parent final not-executed 对应 marker 尚未完成
  // 清理时 rearm 拒绝（含 digest 不一致的 conflict 形态）。
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && marker.transactionId === input.parentTransactionId) {
    return {
      status: "rejected",
      reason: "marker_cleanup_pending",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 的 write-fault marker 尚未完成清理（digest ${marker.digest.slice(0, 16)}）——beginTick 补完成或显式处理后才能 rearm`,
    };
  }
  const childTransactionId = deriveTreasuryRearmChildTransactionId({
    transactionId: parent.transactionId,
    digest: parent.digest,
    ...(parent.contractDigest !== undefined ? { contractDigest: parent.contractDigest } : {}),
    ...(parent.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: parent.authorizationCohortDigest } : {}),
    ...(parent.durableIdentityDigest !== undefined ? { durableIdentityDigest: parent.durableIdentityDigest } : {}),
    ...(parent.lowlevelSource !== undefined ? { lowlevelSource: parent.lowlevelSource } : {}),
  });
  return { status: "rearmed", parentTransactionId: parent.transactionId, childTransactionId };
}
