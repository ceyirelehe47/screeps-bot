/**
 * Treasury write-fault marker 与 write admission 锁（第五轮建立、第七轮
 * 补严 marker 形状契约与 phase 语义拆分）。
 *
 * 语义：Game API 已返回 OK 的 prepared commit 发生理论上不应发生的内部
 * 写故障（receipt/heap/handle 状态发布失败、endTick 时 handle 仍处于
 * executing 等）时，不得当作普通 rejected/aborted——transaction 进入
 * faulted 终态，tentative 预留与 receipt 槽不释放，全部后续 Treasury
 * writer fail closed，直至对账或人工修复。
 *
 * phase 分类（第七轮拆分，resolution 的允许性依赖该分类）：
 * - commit 类（Game callback 已确认 OK，之后的 Treasury 发布故障）：
 *   receipt_publish / heap_publish / journal_publish / overlay_publish /
 *   handle_state / commit_unexpected——Game 动作已发生，绝不允许
 *   resolve-as-not-executed；
 * - execution-unknown 类（Game 副作用未知）：executing_at_end_tick（endTick
 *   时仍在 executing）、action_threw_execution_unknown（callback 抛错——
 *   默认视为 execution unknown，见 facade 状态机）、
 *   action_returned_non_ok_abort_failed（Game 正常返回非 OK 但 abort 未确
 *   认）——配合显式 post-observation 证据可 resolution。
 *
 * marker 形状契约（第七轮）：transactionId/digest/phase/tick/status/
 * recordedAt/kind/source 严格校验 + detail（可选，≤192 字符有界异常摘要）；
 * 读取路径对损坏 marker 一律视为存在 unresolved fault（fail closed，绝不
 * 当作"没有 fault"）——peekTreasuryWriteFaultHealth 提供有界诊断。
 *
 * 持久化：最小、有界、正式类型化的 Memory write-fault marker
 * （Memory.runtime.treasury.writeFault，单条即首个 unresolved 故障的根因
 * 快照），global reset 后仍可发现 Treasury 曾发生 unresolved commit
 * fault。绝不持久化正常 transaction/journal/overlay 全量数据。
 *
 * 解除：第六轮起只有显式 fault resolution 协议（treasury/faultResolution.ts）
 * 可以清除 marker——resolve-as-committed / resolve-as-not-executed 经
 * transactionId+digest 严格匹配（clearTreasuryWriteFaultMarkerForResolution，
 * 仅供该模块调用）后随 resolution 一并解除；无条件删除 marker 的入口已
 * 移除（marker 无法证明 Game 动作是否发生，直接解锁会错误释放资源并
 * 可能重放已执行动作）；测试用清理包含在 clearTreasuryPersistenceForTest。
 */

import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import { treasuryMarkerExactIdentityRelation } from "@/runtime/treasury/markerExactIdentity";
import {
  TREASURY_IDENTITY_PROFILES,
  type TreasuryIdentityProfile,
  treasuryIdentityProfileOfProofClass,
  treasuryProofClassOfIdentityProfile,
  validateTreasuryIdentityProfileFacts,
} from "@/runtime/treasury/identityProfile";

/** commit 类 phase（Game callback 已确认 OK）：不允许 not-executed resolution。 */
export type TreasuryCommitFaultPhase =
  | "receipt_publish"
  | "heap_publish"
  | "journal_publish"
  | "overlay_publish"
  | "handle_state"
  | "commit_unexpected"
  /** 第九轮：intent ok_pending_commit 相恢复——已知 Game 返回 OK（事实单调：
   * 不得退化为可能未执行，永不允许 not-executed resolution）。 */
  | "ok_pending_commit_unresolved"
  /** 第十轮：原子 bundle redemption 中断（状态已一致回滚；marker 阻断后续
   * writer 直至显式确认——发生在 Game callback 之前，动作确定未执行）。 */
  | "internal_authorization_fault"
  /** 【第十二轮 3.1.7】internal authorization fault 的 forensic fail-closed
   * 状态：authorization 已完整回滚（动作确定未执行），但 durable fault
   * authority 写入失败（store fatal / 容量耗尽 / identity conflict / read-back
   * 不一致）——不满足"marker 发布前必须有完整 authority"的正常协议，以
   * 显式 forensic phase 阻断 writer，只能经 acknowledge-rolled-back 的
   * forensic 通道或人工修复解除。 */
  | "internal_authorization_fault_forensic";

/** execution-unknown 类 phase（Game 副作用未知）：配合显式证据可 resolution。 */
export type TreasuryExecutionUnknownPhase =
  | "executing_at_end_tick"
  /** action callback 抛出异常——副作用未知，默认 execution unknown（第七轮）。 */
  | "action_threw_execution_unknown"
  /** Game 正常返回非 OK 但 abort 未确认——动作未成功，资源仍被占用（第七轮）。 */
  | "action_returned_non_ok_abort_failed";

export type TreasuryWriteFaultPhase = TreasuryCommitFaultPhase | TreasuryExecutionUnknownPhase;

/** 合法 phase 全集（quarantine 形状校验与 resolution 允许性判定的单一权威）。 */
export const TREASURY_WRITE_FAULT_PHASES: ReadonlySet<string> = new Set<string>([
  "receipt_publish",
  "heap_publish",
  "journal_publish",
  "overlay_publish",
  "handle_state",
  "commit_unexpected",
  "ok_pending_commit_unresolved",
  "internal_authorization_fault",
  "internal_authorization_fault_forensic",
  "executing_at_end_tick",
  "action_threw_execution_unknown",
  "action_returned_non_ok_abort_failed",
]);

/** execution-unknown 类集合（faultResolution 的 not-executed 允许性用）。 */
export const TREASURY_EXECUTION_UNKNOWN_PHASES: ReadonlySet<string> = new Set<string>([
  "executing_at_end_tick",
  "action_threw_execution_unknown",
  "action_returned_non_ok_abort_failed",
]);

/** marker 异常摘要的有界长度（不持久化完整 Error 对象）。 */
export const TREASURY_WRITE_FAULT_DETAIL_MAX = 192;

const WRITE_FAULT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX = 128;

export interface TreasuryWriteFaultMarker {
  readonly transactionId: string;
  readonly digest: string;
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  readonly phase: TreasuryWriteFaultPhase;
  readonly status: "unresolved";
  readonly recordedAt: number;
  /** 有界异常/故障摘要（可选；绝不持久化完整 Error/stack 对象）。 */
  readonly detail?: string;
  /**
   * 【第十三轮第十一节】forensic marker 绑定的完整 attempt identity
   * （redemption 故障前已计算的事实）：contract digest / authorization
   * cohort digest / durable identity digest。缺失（旧 marker）= legacy
   * forensic proof——不得证明携带现代身份的新 attempt。
   */
  readonly attemptIdentity?: {
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
  };
  /**
   * 【第十七轮第十四节】marker v2 class-aware attempt identity：authority
   * class、lowlevelSource、lineage/rearm binding digest、parent/child
   * generation。缺失（v1 marker）= class 不可证明——class-aware 清除按
   * insufficient 保守处理（绝不猜测 class）。
   */
  readonly markerVersion?: 2 | 3;
  readonly authorityClass?: "identity-bound" | "lowlevel" | "legacy" | "forensic";
  readonly lowlevelSource?: string;
  readonly lineageBindingDigest?: string;
  readonly attemptGeneration?: number;
  /** 【第十八轮 v3】tr1_ marker 的完整 lineage proof（binding 携带时必填）。 */
  readonly lineageId?: string;
  /**
   * 【第二十二轮 v4 exact marker】显式 identity profile + 顶层完整身份事实
   * （contract / cohort / durable digest / lineage 四字段），替代旧式嵌套
   * attemptIdentity 与调用方拼接。v4 marker 由 markerExactIdentity 单一
   * relation 比较；legacy-replay / forensic-isolated profile 不参与普通
   * discharge。
   */
  readonly markerProtocol?: 4;
  readonly identityProfile?: TreasuryIdentityProfile;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
}

interface TreasuryWriteFaultBranch {
  writeFault?: TreasuryWriteFaultMarker;
}

type RuntimeMemoryWithTreasuryFault = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryWriteFaultBranch;
};

function treasuryBranch(): TreasuryWriteFaultBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/**
 * 只读读取 marker 快照（查询/门禁路径零写；不校验形状——校验见 health）。
 * 【第十六轮 7.2】返回有界深冻结快照——不泄漏嵌套 attemptIdentity 的
 * Memory 引用（调用方原地改写无法污染权威 marker）。
 */
export function readTreasuryWriteFault(): TreasuryWriteFaultMarker | undefined {
  const marker = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury?.writeFault;
  return marker === undefined ? undefined : (treasuryBoundedDeepFreezeSnapshot(marker) as TreasuryWriteFaultMarker);
}

/**
 * marker 形状校验（第七轮）：返回 null = 合法，否则有界错误描述。
 * transactionId/digest/phase/tick/status/recordedAt/kind/source 逐字段。
 */
export function validateTreasuryWriteFaultMarkerShape(marker: unknown): string | null {
  if (!marker || typeof marker !== "object") return "marker 非对象";
  const candidate = marker as Partial<TreasuryWriteFaultMarker>;
  if (
    typeof candidate.transactionId !== "string" ||
    candidate.transactionId.length === 0 ||
    candidate.transactionId.length > WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX
  ) {
    return "marker.transactionId 非法";
  }
  if (typeof candidate.digest !== "string" || !WRITE_FAULT_DIGEST_PATTERN.test(candidate.digest)) {
    return "marker.digest 非法（须为 16 小写 hex）";
  }
  if (typeof candidate.phase !== "string" || !TREASURY_WRITE_FAULT_PHASES.has(candidate.phase)) {
    return `marker.phase 非法（未知枚举）: ${String(candidate.phase).slice(0, 48)}`;
  }
  if (candidate.status !== "unresolved") return "marker.status 非法（须为 unresolved）";
  if (typeof candidate.tick !== "number" || !Number.isSafeInteger(candidate.tick) || candidate.tick < 0) {
    return "marker.tick 非安全整数";
  }
  if (
    typeof candidate.recordedAt !== "number" ||
    !Number.isSafeInteger(candidate.recordedAt) ||
    candidate.recordedAt < 0
  ) {
    return "marker.recordedAt 非安全整数";
  }
  if (
    typeof candidate.kind !== "string" ||
    candidate.kind.length === 0 ||
    candidate.kind.length > WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX
  ) {
    return "marker.kind 非法";
  }
  if (
    typeof candidate.source !== "string" ||
    candidate.source.length === 0 ||
    candidate.source.length > WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX
  ) {
    return "marker.source 非法";
  }
  if (
    candidate.detail !== undefined &&
    (typeof candidate.detail !== "string" || candidate.detail.length > TREASURY_WRITE_FAULT_DETAIL_MAX)
  ) {
    return "marker.detail 非法（须为 ≤192 字符）";
  }
  // 【第十三轮第十一节】attempt identity 绑定字段（可选；存在须为 16 hex）。
  if (candidate.attemptIdentity !== undefined) {
    const identity = candidate.attemptIdentity as Partial<NonNullable<TreasuryWriteFaultMarker["attemptIdentity"]>> | undefined;
    if (!identity || typeof identity !== "object") return "marker.attemptIdentity 非对象";
    for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
      const value = identity[field];
      if (value !== undefined && (typeof value !== "string" || !WRITE_FAULT_DIGEST_PATTERN.test(value))) {
        return `marker.attemptIdentity.${field} 非法（须为 16 小写 hex）`;
      }
    }
  }
  // 【第十七轮第十四节】marker v2 class-aware 字段（可选；存在即校验）。
  if (candidate.markerVersion !== undefined && candidate.markerVersion !== 2 && candidate.markerVersion !== 3) {
    return `marker.markerVersion 非法（期望 2 或 3）: ${String(candidate.markerVersion).slice(0, 16)}`;
  }
  // 【第十八轮 24.4 marker v3】tr1_ marker 的 lineage proof：binding 携带时
  // lineageId 必填（v3）；v2 marker（无 lineageId）按 legacy identity 语义
  // 继续读取（class-aware 清除 insufficient——不猜）。
  if (candidate.lineageId !== undefined && (typeof candidate.lineageId !== "string" || !WRITE_FAULT_DIGEST_PATTERN.test(candidate.lineageId))) {
    return "marker.lineageId 非法（须为 16 小写 hex）";
  }
  if (candidate.lineageBindingDigest !== undefined && candidate.lineageId === undefined) {
    return "marker 携带 lineageBindingDigest 但缺少 lineageId（v3 proof 不完整）";
  }
  if (candidate.markerVersion === 3 && candidate.lineageBindingDigest !== undefined && candidate.lineageId === undefined) {
    return "marker v3 携带 binding 必须同时携带 lineageId";
  }
  if (
    candidate.authorityClass !== undefined &&
    !["identity-bound", "lowlevel", "legacy", "forensic"].includes(candidate.authorityClass)
  ) {
    return `marker.authorityClass 非法枚举: ${String(candidate.authorityClass).slice(0, 32)}`;
  }
  if (candidate.lowlevelSource !== undefined && (typeof candidate.lowlevelSource !== "string" || candidate.lowlevelSource.length === 0)) {
    return "marker.lowlevelSource 非法";
  }
  if (candidate.lineageBindingDigest !== undefined && (typeof candidate.lineageBindingDigest !== "string" || !WRITE_FAULT_DIGEST_PATTERN.test(candidate.lineageBindingDigest))) {
    return "marker.lineageBindingDigest 非法（须为 16 小写 hex）";
  }
  if (candidate.attemptGeneration !== undefined && (typeof candidate.attemptGeneration !== "number" || !Number.isSafeInteger(candidate.attemptGeneration) || candidate.attemptGeneration < 0)) {
    return "marker.attemptGeneration 非安全非负整数";
  }
  // v2 一致性：identity-bound 禁 lowlevelSource；lowlevel 必带。
  if (candidate.authorityClass === "identity-bound" && candidate.lowlevelSource !== undefined) {
    return "marker.identity-bound 携带 lowlevelSource（class 矛盾）";
  }
  if (candidate.authorityClass === "lowlevel" && candidate.lowlevelSource === undefined) {
    return "marker.lowlevel 缺少 lowlevelSource（class 矛盾）";
  }
  // 【第二十二轮 v4 exact marker】顶层身份事实（可选；存在须为 16 hex）。
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !WRITE_FAULT_DIGEST_PATTERN.test(value))) {
      return `marker.${field} 非法（须为 16 小写 hex）`;
    }
  }
  if (candidate.lineageGeneration !== undefined && (typeof candidate.lineageGeneration !== "number" || !Number.isSafeInteger(candidate.lineageGeneration) || candidate.lineageGeneration < 0)) {
    return "marker.lineageGeneration 非安全非负整数";
  }
  if (candidate.parentTransactionId !== undefined && (typeof candidate.parentTransactionId !== "string" || candidate.parentTransactionId.length === 0)) {
    return "marker.parentTransactionId 非法";
  }
  if (candidate.identityProfile !== undefined && !TREASURY_IDENTITY_PROFILES.has(candidate.identityProfile)) {
    return `marker.identityProfile 非法枚举: ${String(candidate.identityProfile).slice(0, 32)}`;
  }
  // v4 协议校验：markerProtocol 4 必带 identityProfile 与 authorityClass，
  // 且二者满足唯一合法组合；顶层身份事实满足 profile required/forbidden
  // 矩阵（legacy-replay / forensic-isolated 不参与——矩阵校验仍执行以发现
  // class 矛盾，协议隔离由 discharge 承载）。
  if (candidate.markerProtocol === 4) {
    if (candidate.identityProfile === undefined) {
      return "marker v4 缺少 identityProfile（exact marker 必填）";
    }
    if (candidate.authorityClass === undefined) {
      return "marker v4 缺少 authorityClass（exact marker 必填）";
    }
    if (treasuryProofClassOfIdentityProfile(candidate.identityProfile) !== candidate.authorityClass) {
      return "marker v4 的 identityProfile 与 authorityClass 不满足唯一合法组合";
    }
    const profileError = validateTreasuryIdentityProfileFacts(candidate.identityProfile, {
      digest: candidate.digest,
      contractDigest: candidate.contractDigest,
      authorizationCohortDigest: candidate.authorizationCohortDigest,
      durableIdentityDigest: candidate.durableIdentityDigest,
      lowlevelSource: candidate.lowlevelSource,
    });
    if (profileError !== null) return `marker v4 profile 矩阵失败: ${profileError}`;
    // v4 的 lineage 维度统一用 lineageGeneration / parentTransactionId /
    // lineageBindingDigest / lineageId 四字段（attemptGeneration 旧名不得
    // 混入 v4——避免双表示）。
    if (candidate.attemptGeneration !== undefined) {
      return "marker v4 携带 attemptGeneration（v4 统一用 lineageGeneration）";
    }
    if (candidate.markerVersion !== undefined) {
      return "marker v4 携带 markerVersion（v2/v3 旧字段不得混入 v4）";
    }
    if (candidate.attemptIdentity !== undefined) {
      return "marker v4 携带旧式嵌套 attemptIdentity（v4 统一顶层表示）";
    }
  }
  return null;
}

export interface TreasuryWriteFaultHealth {
  readonly healthy: boolean;
  /** marker 不存在或形状合法时为 null；损坏时有界诊断。 */
  readonly detail: string | null;
}

/**
 * write-fault marker 健康探测（只读）：marker 不存在 → healthy；存在且形状
 * 合法 → healthy（存在 unresolved fault 是合法状态——锁语义由
 * isTreasuryWriteAdmissionLocked 表达）；存在但损坏 → unhealthy（fail
 * closed：损坏 marker 不得被当作"没有 fault"）。
 */
export function peekTreasuryWriteFaultHealth(): TreasuryWriteFaultHealth {
  const marker = readTreasuryWriteFault();
  if (marker === undefined) return { healthy: true, detail: null };
  const shapeError = validateTreasuryWriteFaultMarkerShape(marker);
  if (shapeError !== null) return { healthy: false, detail: shapeError };
  return { healthy: true, detail: null };
}

/**
 * write admission 全局锁：存在 marker（无论形状是否合法）即锁定——损坏
 * marker 一律视为存在 unresolved fault（fail closed）。quarantine blocker
 * 独立于本锁（write-fault marker 不是唯一锁来源）。
 */
export function isTreasuryWriteAdmissionLocked(): boolean {
  return readTreasuryWriteFault() !== undefined;
}

/**
 * 记录 write-fault marker：只保留**首个** unresolved 故障（根因快照，
 * 后续故障不覆盖——有界）；heap 侧的重复计数由 facade metrics 负责。
 * detail 为有界异常摘要（≤192 字符，调用方负责截断）。
 */
export function recordTreasuryWriteFault(marker: TreasuryWriteFaultMarker): void {
  const branch = treasuryBranch();
  if (branch.writeFault?.status === "unresolved") return;
  const detail = marker.detail !== undefined ? marker.detail.slice(0, TREASURY_WRITE_FAULT_DETAIL_MAX) : undefined;
  // 【第十六轮第十节】写入 Memory 前构造完全独立的有界深拷贝（嵌套
  // attemptIdentity 一并隔离——调用方后续修改输入不影响权威 marker）。
  branch.writeFault = cloneTreasuryDurableValue(
    detail !== undefined ? { ...marker, status: "unresolved", detail } : { ...marker, status: "unresolved" },
  );
}

/**
 * 显式 fault resolution 的受控 marker 清除（历史兼容入口——boolean 语义）。
 *
 * 【第二十二轮】生产路径的 marker 解除一律改用 markerDischarge.
 * dischargeTreasuryMarkerForAttempt（结构化结果 + Memory read-back + 全局
 * 锁事实分离）；本函数保留给既有调用方/测试的 boolean 兼容，内部 relation
 * 判定同样收敛到 markerExactIdentity 单一权威（v4 全维 / v3 携带维度 /
 * v2 缺链绑定 insufficient / v1 legacy insufficient——不再按 v1 的
 * transactionId+digest 裸匹配放行）。
 */
export function clearTreasuryWriteFaultMarkerForResolution(
  proof:
    | {
        readonly transactionId: string;
        readonly digest: string;
        readonly authorityClass?: "identity-bound" | "lowlevel" | "legacy" | "forensic";
        readonly contractDigest?: string;
        readonly authorizationCohortDigest?: string;
        readonly durableIdentityDigest?: string;
        readonly lowlevelSource?: string;
        readonly lineageBindingDigest?: string;
        readonly attemptGeneration?: number;
        readonly lineageId?: number | string;
      }
    | string,
  legacyDigest?: string,
): boolean {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury;
  const marker = branch?.writeFault;
  if (!marker || marker.status !== "unresolved") return false;
  const typedProof = (typeof proof === "string"
    ? { transactionId: proof, digest: legacyDigest ?? "" }
    : proof) as {
    transactionId: string;
    digest: string;
    authorityClass?: "identity-bound" | "lowlevel" | "legacy" | "forensic";
    contractDigest?: string;
    authorizationCohortDigest?: string;
    durableIdentityDigest?: string;
    lowlevelSource?: string;
    lineageBindingDigest?: string;
    attemptGeneration?: number;
    lineageId?: number | string;
    parentTransactionId?: string;
  };
  if (typedProof.transactionId === undefined || typedProof.digest === undefined) return false;
  const expectedProfile: TreasuryIdentityProfile =
    treasuryIdentityProfileOfProofClass(typedProof.authorityClass ?? "legacy") ?? "legacy-replay";
  const relation = treasuryMarkerExactIdentityRelation(
    {
      transactionId: typedProof.transactionId,
      digest: typedProof.digest,
      proofClass: typedProof.authorityClass ?? "legacy",
      identityProfile: expectedProfile,
      ...(typedProof.contractDigest !== undefined ? { contractDigest: typedProof.contractDigest } : {}),
      ...(typedProof.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: typedProof.authorizationCohortDigest } : {}),
      ...(typedProof.durableIdentityDigest !== undefined ? { durableIdentityDigest: typedProof.durableIdentityDigest } : {}),
      ...(typedProof.lowlevelSource !== undefined ? { lowlevelSource: typedProof.lowlevelSource } : {}),
      ...(typeof typedProof.lineageId === "string" ? { lineageId: typedProof.lineageId } : {}),
      ...(typedProof.attemptGeneration !== undefined ? { lineageGeneration: typedProof.attemptGeneration } : {}),
      ...(typedProof.lineageBindingDigest !== undefined ? { lineageBindingDigest: typedProof.lineageBindingDigest } : {}),
      ...(typedProof.parentTransactionId !== undefined ? { parentTransactionId: typedProof.parentTransactionId } : {}),
    },
    marker,
  );
  if (relation.kind !== "match") return false;
  delete branch!.writeFault;
  return true;
}

/**
 * 【第十七轮第十四节→第二十二轮 v4】从 attempt 权威事实构造 marker 的
 * exact 身份字段（写入调用方共用）：显式 identity profile + 顶层完整身份
 * 事实（contract / cohort / durable / lowlevel provenance / lineage 四字段），
 * 不再输出旧式顶层 class 子集与嵌套 attemptIdentity 两套表示。profile
 * requiredness 不满足时返回 null（调用方 fail closed——不写不完整 marker）。
 */
export function exactMarkerFieldsOfAttemptFacts(facts: {
  readonly identityProfile: TreasuryIdentityProfile;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): {
  readonly markerProtocol: 4;
  readonly identityProfile: TreasuryIdentityProfile;
  readonly authorityClass: "identity-bound" | "lowlevel" | "legacy" | "forensic";
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
} | null {
  const authorityClass = treasuryProofClassOfIdentityProfile(facts.identityProfile);
  const profileError = validateTreasuryIdentityProfileFacts(facts.identityProfile, {
    digest: "0000000000000000",
    contractDigest: facts.contractDigest,
    authorizationCohortDigest: facts.authorizationCohortDigest,
    durableIdentityDigest: facts.durableIdentityDigest,
    lowlevelSource: facts.lowlevelSource,
  });
  if (profileError !== null) return null;
  return {
    markerProtocol: 4,
    identityProfile: facts.identityProfile,
    authorityClass: authorityClass as "identity-bound" | "lowlevel" | "legacy" | "forensic",
    ...(facts.contractDigest !== undefined ? { contractDigest: facts.contractDigest } : {}),
    ...(facts.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts.authorizationCohortDigest } : {}),
    ...(facts.durableIdentityDigest !== undefined ? { durableIdentityDigest: facts.durableIdentityDigest } : {}),
    ...(facts.lowlevelSource !== undefined ? { lowlevelSource: facts.lowlevelSource } : {}),
    ...(facts.lineageId !== undefined ? { lineageId: facts.lineageId } : {}),
    ...(facts.lineageGeneration !== undefined ? { lineageGeneration: facts.lineageGeneration } : {}),
    ...(facts.parentTransactionId !== undefined ? { parentTransactionId: facts.parentTransactionId } : {}),
    ...(facts.lineageBindingDigest !== undefined ? { lineageBindingDigest: facts.lineageBindingDigest } : {}),
  };
}

/**
 * 【第二十二轮】prepared/recovery record 的 marker v4 写入侧便捷构造：
 * contract 路径（contractDigest 携带）→ modern-contract（cohort/durable 缺
 * 失即构造失败——不写不完整 marker）；纯低层路径 → lowlevel + runtime
 * 受控来源。lineage 维度按携带透传（tr1_ 路径注入）。
 */
export function exactMarkerFieldsOfPreparedRecord(facts: {
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): ReturnType<typeof exactMarkerFieldsOfAttemptFacts> {
  const identityProfile: TreasuryIdentityProfile | null =
    facts.contractDigest !== undefined
      ? facts.authorizationCohortDigest !== undefined && facts.durableIdentityDigest !== undefined
        ? "modern-contract"
        : null
      : "lowlevel";
  if (identityProfile === null) return null;
  return exactMarkerFieldsOfAttemptFacts({
    identityProfile,
    ...(facts.contractDigest !== undefined ? { contractDigest: facts.contractDigest } : {}),
    ...(facts.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts.authorizationCohortDigest } : {}),
    ...(facts.durableIdentityDigest !== undefined ? { durableIdentityDigest: facts.durableIdentityDigest } : {}),
    ...(identityProfile === "lowlevel" ? { lowlevelSource: "runtime-lowlevel@v1" } : {}),
    ...(facts.lineageId !== undefined ? { lineageId: facts.lineageId } : {}),
    ...(facts.lineageGeneration !== undefined ? { lineageGeneration: facts.lineageGeneration } : {}),
    ...(facts.parentTransactionId !== undefined ? { parentTransactionId: facts.parentTransactionId } : {}),
    ...(facts.lineageBindingDigest !== undefined ? { lineageBindingDigest: facts.lineageBindingDigest } : {}),
  });
}

/**
 * 【第二十二轮】forensic 通道的显式 marker 清除（acknowledge-rolled-back
 * 人工确认协议——与普通 discharge 分离）：forensic-isolated profile 不参
 * 与自动 discharge（11.5），只能经本入口解除。transactionId + digest +
 * 身份维度（v4 顶层或旧式嵌套，按 marker 自身协议）匹配才删除，删除后
 * Memory read-back 确认。expected 身份来自 resolution 权威（tombstone 与
 * marker 绑定同一 identity）。
 */
export function clearTreasuryForensicMarkerForAcknowledgedRollback(expected: {
  readonly transactionId: string;
  readonly digest: string;
  readonly identityProfile?: TreasuryIdentityProfile;
  readonly authorityClass?: "identity-bound" | "lowlevel" | "legacy" | "forensic";
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
}): boolean {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury;
  const marker = branch?.writeFault;
  if (!marker || marker.status !== "unresolved") return false;
  if (marker.transactionId !== expected.transactionId || marker.digest !== expected.digest) return false;
  if (marker.markerProtocol === 4) {
    // v4：比较顶层身份维度（缺失维度不构成匹配依据——按携带比较）。
    if (expected.identityProfile !== undefined && marker.identityProfile !== expected.identityProfile) return false;
    if (expected.authorityClass !== undefined && marker.authorityClass !== expected.authorityClass) return false;
    for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest", "lowlevelSource"] as const) {
      const markerValue = marker[field];
      const expectedValue = expected[field];
      if (markerValue !== undefined && expectedValue !== undefined && markerValue !== expectedValue) return false;
    }
  } else {
    // 旧式（含嵌套 attemptIdentity 的十三轮形态）：嵌套维度按携带比较。
    const nested = marker.attemptIdentity;
    if (nested?.contractDigest !== undefined && expected.contractDigest !== undefined && nested.contractDigest !== expected.contractDigest) return false;
    if (nested?.authorizationCohortDigest !== undefined && expected.authorizationCohortDigest !== undefined && nested.authorizationCohortDigest !== expected.authorizationCohortDigest) return false;
    if (nested?.durableIdentityDigest !== undefined && expected.durableIdentityDigest !== undefined && nested.durableIdentityDigest !== expected.durableIdentityDigest) return false;
  }
  delete branch!.writeFault;
  const readBack = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury?.writeFault;
  return readBack === undefined || readBack.transactionId !== expected.transactionId;
}

/**
 * staged commit 的意外故障异常（facade 捕获后统一进入 faulted 终态 +
 * marker + 全局锁）。phase 用于 marker 与故障注入测试断言。
 */
export class TreasuryCommitFaultError extends Error {
  readonly phase: TreasuryWriteFaultPhase;
  constructor(phase: TreasuryWriteFaultPhase, detail: string) {
    super(`Treasury commit fault (${phase}): ${detail}`);
    this.name = "TreasuryCommitFaultError";
    this.phase = phase;
  }
}

/**
 * 可注入故障点（仅测试）：commit 的每个 staged 边界前调用；抛错即模拟
 * 该阶段失败。生产代码不得设置（架构边界测试守护调用面）。
 */
let commitFaultInjector: ((phase: TreasuryWriteFaultPhase) => void) | null = null;

export function setTreasuryCommitFaultInjectorForTest(
  injector: ((phase: TreasuryWriteFaultPhase) => void) | null,
): void {
  commitFaultInjector = injector;
}

/** 注入器抛错时封装为携带 phase 的 TreasuryCommitFaultError（保真故障点）。 */
export function runTreasuryCommitFaultHook(phase: TreasuryWriteFaultPhase): void {
  if (commitFaultInjector === null) return;
  try {
    commitFaultInjector(phase);
  } catch (error) {
    if (error instanceof TreasuryCommitFaultError) throw error;
    throw new TreasuryCommitFaultError(phase, error instanceof Error ? error.message : String(error));
  }
}
