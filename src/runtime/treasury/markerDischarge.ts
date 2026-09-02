/**
 * 【第二十二轮第六/七节】marker discharge 权威——持久、可恢复、可读回
 * 证明的受控 marker 解除协议（committed 与 not-executed 共用）。
 *
 * Round 21 及之前 marker 清除是一次 best-effort 函数调用（返回 boolean，
 * 无 read-back）：clear 返回 false 混合"marker 不存在 / 属于其它
 * transaction / identity 冲突 / proof 不足 / 实际删除失败"五种含义，
 * 调用方无法安全决定后续状态；pendingReleaseIds 在 clear 后被无条件移除。
 * 本模块把"当前 attempt 的 marker 是否已解除"与"系统是否仍被其它
 * attempt 的 marker 全局锁定"拆成两个独立事实：
 *
 * - already_absent：marker 不存在——当前 attempt discharged，全局未锁。
 * - matching_cleared：匹配 marker 已删除且 read-back 确认消失。
 * - unrelated_global_lock：marker 属于其它 transaction——当前 attempt
 *   discharged（不需要也不得删除它），但 global write admission 仍被
 *   另一 attempt 的 marker 阻断（metrics/evidence 必须明确记录）。
 * - conflict：同 transaction 但任一 exact 字段不同——零状态变化，不得
 *   finalize、不得移除 pending 索引。
 * - insufficient：同 transaction 但 proof 不足（v1 legacy / v2 缺链绑定 /
 *   requiredness 缺失）——保留 marker，fail closed。
 * - store_unhealthy：marker malformed——零状态变化。
 * - delete_failed_or_still_present：删除后 read-back 仍是同 transaction
 *   marker——pending，不得 finalize。
 *
 * Read-back 协议（6.4）：matching marker 删除后重新读取 Memory——变成其它
 * transaction 视为"当前 attempt 已解除 + global lock 仍在"；仍是同
 * transaction 视为 pending；新值 malformed 视为 store unhealthy。
 *
 * 本模块是 marker 清除的唯一生产入口；旧 clearTreasuryWriteFaultMarker-
 * ForResolution 语义重定向至此（boolean 兼容包装）。
 */

import {
  readTreasuryWriteFault,
  validateTreasuryWriteFaultMarkerShape,
  type TreasuryWriteFaultMarker,
} from "@/runtime/treasury/writeFault";
import { treasuryMarkerExactIdentityRelation } from "@/runtime/treasury/markerExactIdentity";
import {
  type TreasuryIdentityProfile,
  treasuryProfileAllowsAutomaticProtocol,
  validateTreasuryIdentityProfileFacts,
} from "@/runtime/treasury/identityProfile";

/** discharge 结果（六值 + detail；boolean 歧义全部展开）。 */
export type TreasuryMarkerDischargeOutcome =
  | "already_absent"
  | "matching_cleared"
  | "unrelated_global_lock"
  | "conflict"
  | "insufficient"
  | "store_unhealthy"
  | "delete_failed_or_still_present";

export interface TreasuryMarkerDischargeResult {
  readonly outcome: TreasuryMarkerDischargeOutcome;
  readonly detail: string;
  /** 当前 attempt 自己的 marker 是否已解除（不含其它 attempt 的 marker）。 */
  readonly attemptMarkerDischarged: boolean;
  /** 全局 write admission 是否仍被（其它 attempt 的）marker 锁定。 */
  readonly globalWriteAdmissionStillLocked: boolean;
}

/** discharge 的 expected attempt 身份（权威事实——由 lineage/authority 构造）。 */
export interface TreasuryMarkerDischargeExpected {
  readonly transactionId: string;
  readonly digest: string;
  readonly proofClass: string;
  readonly identityProfile: TreasuryIdentityProfile;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

interface TreasuryWriteFaultBranchForDischarge {
  writeFault?: TreasuryWriteFaultMarker;
}

type RuntimeMemoryWithTreasuryFaultBranch = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryWriteFaultBranchForDischarge;
};

/**
 * 受控 marker discharge（唯一生产清除入口）：
 * expected requiredness 校验 → marker 完整 shape 校验 → relation 判定 →
 * 匹配删除 → Memory read-back（含 shape 校验）→ 结构化结果。
 * 永不抛出；除"匹配 marker 实际删除"外零状态变化。
 *
 * 【Round 22 remediation C】marker 的 phase/status/tick/recordedAt/kind/
 * source 任一非法 → store_unhealthy（marker 保留、authority 保留、
 * journal/pending 不推进）；expected 缺 profile required 字段 →
 * insufficient（不利用 expectedValue === undefined 跳过维度比较）；删除后
 * read-back 的新 marker 非对象/缺基础字段 → store_unhealthy（不抛异常、
 * 不当 unrelated）。
 */
export function dischargeTreasuryMarkerForAttempt(
  expected: TreasuryMarkerDischargeExpected,
): TreasuryMarkerDischargeResult {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFaultBranch | undefined)?.treasury;
  const marker = branch?.writeFault;
  if (marker === undefined) {
    return {
      outcome: "already_absent",
      detail: "write-fault marker 不存在（当前 attempt discharged；全局未锁）",
      attemptMarkerDischarged: true,
      globalWriteAdmissionStillLocked: false,
    };
  }
  // C.1：discharge 前完整 write-fault marker shape validation（phase/status/
  // tick/recordedAt/kind/source 及全部身份字段形状）——malformed marker 的
  // exact relation 不可判定，零状态 fail closed。
  const markerShapeError = validateTreasuryWriteFaultMarkerShape(marker);
  if (markerShapeError !== null) {
    return {
      outcome: "store_unhealthy",
      detail: `write-fault marker 形状非法（discharge 拒绝——marker/authority/journal 全部保留）: ${markerShapeError}`,
      attemptMarkerDischarged: false,
      globalWriteAdmissionStillLocked: true,
    };
  }
  if (!treasuryProfileAllowsAutomaticProtocol(expected.identityProfile)) {
    return {
      outcome: "insufficient",
      detail: `expected attempt 的 identity profile ${expected.identityProfile} 不参与自动 marker discharge（显式 forensic / 人工通道）`,
      attemptMarkerDischarged: false,
      globalWriteAdmissionStillLocked: true,
    };
  }
  // C.3：expected attempt 自身的 profile required/forbidden 矩阵——缺
  // required 事实（modern-contract 缺 contract/cohort/durable；lowlevel 缺
  // durable/受控 source）→ insufficient（expected 证明材料不足，不删除）。
  const expectedFactsError = validateTreasuryIdentityProfileFacts(expected.identityProfile, {
    digest: expected.digest,
    contractDigest: expected.contractDigest,
    authorizationCohortDigest: expected.authorizationCohortDigest,
    durableIdentityDigest: expected.durableIdentityDigest,
    lowlevelSource: expected.lowlevelSource,
  });
  if (expectedFactsError !== null) {
    return {
      outcome: "insufficient",
      detail: `expected attempt 未通过 ${expected.identityProfile} profile required/forbidden 矩阵（维度不得按 undefined 跳过比较）: ${expectedFactsError}`,
      attemptMarkerDischarged: false,
      globalWriteAdmissionStillLocked: true,
    };
  }
  const relation = treasuryMarkerExactIdentityRelation(expected, marker);
  if (relation.kind === "unrelated") {
    return {
      outcome: "unrelated_global_lock",
      detail: relation.detail,
      attemptMarkerDischarged: true,
      globalWriteAdmissionStillLocked: true,
    };
  }
  if (relation.kind === "store_unhealthy") {
    return { outcome: "store_unhealthy", detail: relation.detail, attemptMarkerDischarged: false, globalWriteAdmissionStillLocked: true };
  }
  if (relation.kind === "conflict") {
    return { outcome: "conflict", detail: relation.detail, attemptMarkerDischarged: false, globalWriteAdmissionStillLocked: true };
  }
  if (relation.kind === "insufficient") {
    return { outcome: "insufficient", detail: relation.detail, attemptMarkerDischarged: false, globalWriteAdmissionStillLocked: true };
  }
  // relation match：执行删除并 read-back（6.4 + remediation C.2 read-back
  // shape 校验——null/非对象/缺 transactionId 不得抛异常或当 unrelated）。
  delete branch!.writeFault;
  const readBack = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFaultBranch | undefined)?.treasury?.writeFault;
  if (readBack === undefined) {
    return {
      outcome: "matching_cleared",
      detail: `匹配 marker 已删除并经 Memory read-back 确认消失（${relation.detail}）`,
      attemptMarkerDischarged: true,
      globalWriteAdmissionStillLocked: false,
    };
  }
  if (readBack === null || typeof readBack !== "object") {
    return {
      outcome: "store_unhealthy",
      detail: "marker 删除后 read-back 为非对象值（store unhealthy——当前 attempt 视为已解除，全局锁保留并要求修复）",
      attemptMarkerDischarged: true,
      globalWriteAdmissionStillLocked: true,
    };
  }
  const readBackShapeError = validateTreasuryWriteFaultMarkerShape(readBack);
  if (readBackShapeError !== null || typeof (readBack as TreasuryWriteFaultMarker).transactionId !== "string") {
    return {
      outcome: "store_unhealthy",
      detail: `marker 删除后 read-back 形状非法（${readBackShapeError ?? "transactionId 非法"}——当前 attempt 视为已解除，全局锁保留）`,
      attemptMarkerDischarged: true,
      globalWriteAdmissionStillLocked: true,
    };
  }
  if ((readBack as TreasuryWriteFaultMarker).transactionId !== expected.transactionId) {
    return {
      outcome: "unrelated_global_lock",
      detail: `匹配 marker 删除后 read-back 发现新的其它 transaction marker ${((readBack as TreasuryWriteFaultMarker).transactionId).slice(0, 12)}…（当前 attempt 已解除；global lock 保留）`,
      attemptMarkerDischarged: true,
      globalWriteAdmissionStillLocked: true,
    };
  }
  return {
    outcome: "delete_failed_or_still_present",
    detail: "marker 删除后 read-back 仍存在同 transaction marker（pending——不得 finalize、不得移除 pending 索引）",
    attemptMarkerDischarged: false,
    globalWriteAdmissionStillLocked: true,
  };
}

/** 只读 discharge 预检（coordinator / 门禁用：不删除，只判定当前阻断状态）。 */
export function peekTreasuryMarkerDischargeState(
  expected: TreasuryMarkerDischargeExpected,
): { blocked: boolean; relation: ReturnType<typeof treasuryMarkerExactIdentityRelation> } {
  const marker = readTreasuryWriteFault();
  if (marker === undefined) {
    return {
      blocked: false,
      relation: { kind: "unrelated", detail: "marker 不存在（无阻断）" },
    };
  }
  const relation = treasuryMarkerExactIdentityRelation(expected, marker);
  // marker 属于当前 attempt（match / conflict / insufficient）且未清除 →
  // 阻断；unrelated（其它 attempt）不阻断当前 attempt 的 settlement。
  const blocked = relation.kind !== "unrelated";
  return { blocked, relation };
}

/**
 * discharge 结果是否构成"当前 attempt 的 marker 阶段完成"（pending 索引
 * 只能在此时移除——七.6）。
 */
export function treasuryMarkerDischargeCompletesAttemptPhase(
  result: TreasuryMarkerDischargeOutcome,
): boolean {
  return (
    result === "already_absent" ||
    result === "matching_cleared" ||
    result === "unrelated_global_lock"
  );
}

/**
 * 【第二十二轮第七节】tombstone / authority 权威事实 → discharge expected
 * （resolutionStore 与 faultResolution 共用——committed 与 not-executed 同一
 * discharge 权威）。proofClass 之外的 identity 维度按携带透传；profile 按
 * class 唯一映射（legacy / forensic → 隔离 profile，discharge 判
 * insufficient fail closed——11.4/11.5）。
 */
export function treasuryMarkerDischargeExpectedOfFacts(facts: {
  readonly transactionId: string;
  readonly digest: string;
  readonly proofClass: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): TreasuryMarkerDischargeExpected {
  const profileOf = (proofClass: string): TreasuryIdentityProfile => {
    switch (proofClass) {
      case "identity-bound":
      case "modern":
        return "modern-contract";
      case "lowlevel":
        return "lowlevel";
      case "forensic":
        return "forensic-isolated";
      default:
        return "legacy-replay";
    }
  };
  const isRearm = facts.lineageId !== undefined;
  return {
    transactionId: facts.transactionId,
    digest: facts.digest,
    proofClass:
      facts.proofClass === "identity-bound" || facts.proofClass === "modern"
        ? "identity-bound"
        : facts.proofClass === "lowlevel"
          ? "lowlevel"
          : facts.proofClass === "forensic"
            ? "forensic"
            : "legacy",
    identityProfile: profileOf(facts.proofClass),
    ...(facts.contractDigest !== undefined ? { contractDigest: facts.contractDigest } : {}),
    ...(facts.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts.authorizationCohortDigest } : {}),
    ...(facts.durableIdentityDigest !== undefined ? { durableIdentityDigest: facts.durableIdentityDigest } : {}),
    ...(facts.lowlevelSource !== undefined ? { lowlevelSource: facts.lowlevelSource } : {}),
    ...(isRearm ? { lineageId: facts.lineageId } : {}),
    ...(isRearm && facts.lineageGeneration !== undefined ? { lineageGeneration: facts.lineageGeneration } : {}),
    ...(isRearm && facts.parentTransactionId !== undefined ? { parentTransactionId: facts.parentTransactionId } : {}),
    ...(isRearm && facts.lineageBindingDigest !== undefined ? { lineageBindingDigest: facts.lineageBindingDigest } : {}),
  };
}
