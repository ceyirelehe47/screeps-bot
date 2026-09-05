/**
 * 【第十七轮建立·第十八轮 v2 升级】durable attempt lineage / retired-attempt store。
 *
 * Round 17 语义（保留）：每条业务重试链一个有界 record（root/current attempt
 * ID 与完整 identity、generation、状态、next child、retry semantic digest、
 * authority class、retirement 三段）；状态机单调；硬容量满载 fail closed；
 * root/current O(1) 索引；root attempt ID 永久 retired。
 *
 * 【第十八轮 v2】新增：
 * - lineageId/root/current/next 四索引全部 O(1) 且全局唯一——跨索引冲突
 *   （lineageIndexIntegrity.ts 单一语义）令整个 store unhealthy，绝不静默
 *   覆盖、绝不自动删除（写入候选预检：冲突 → 原 store 不变）；
 * - exact idempotence 修复：candidate 与 existing 完整一致（含 revision 一致）
 *   才幂等；非幂等写 revision 严格 +1；每条转换有允许变化字段集合，冻结
 *   lineageId/root/root identity/authority class/lowlevel source/action kind/
 *   adapter stable identity/owner/created tick；current identity/generation/
 *   binding 只在接管转换（child_intent_pending → child_active）同时变化；
 * - retirement 按 generation 重置：retirementGeneration 标记三段所属代，
 *   新 generation 接管时复位——上一代完成标志不得授权当前代驱逐；
 * - handoff facts 持久化：capability_issued/child_intent_pending 必须携带
 *   nextChildTransactionId（v2 generation-addressable）与 pendingBindingDigest
 *   （写入冻结、load 重算验证）；
 * - generation-addressable child ID 协议 v2（tr1_<lineageId>_<generation>_
 *   <checksum>——checksum 绑定 root）：任意历史代 attempt ID 与 binding 可
 *   只凭 record O(1) 重算（per-generation tombstone verdict 与多代回收的基
 *   础；不保存无界 attempt 数组）；
 * - child_active 进入 pending 恢复集（commit-pending / 退休防御收敛）；
 *   terminalIds 索引（压缩候选，lineageRetirementSummary 使用）；
 * - store v1 → v2 迁移：v1 next-child（parent identity 派生、不可 generation
 *   寻址）一律回退清除（等价 global reset 后的 capability 过期回滚——heap
 *   capability 在迁移场景必然已失效）；其余状态原样携带（v1 child 的
 *   tombstone 不可寻址 → 永久 pin，不猜测 generation）。
 */

import {
  encodeTreasuryCanonicalTuple,
  hashTreasuryCanonicalString,
  isValidTreasuryTransactionId,
  formatTreasuryRearmChildTransactionIdV2,
  parseTreasuryRearmChildTransactionIdV2,
  treasuryRearmChildIdChecksumOf,
} from "@/runtime/treasury/transactionId";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import {
  findTreasuryLineageCrossIndexConflicts,
  treasuryLineageCandidateConflictsWith,
} from "@/runtime/treasury/lineageIndexIntegrity";
import {
  readTreasuryResolutionTombstone,
  listTreasuryPendingReleaseIds,
} from "@/runtime/treasury/resolutionStore";
import { registerTreasuryLineageResetHook } from "@/runtime/treasury/receipts";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { archiveTreasuryCleanupCompletionViaAuthority } from "@/runtime/treasury/cleanupSupersessionAuthority";
import { treasuryMarkerExactIdentityRelation } from "@/runtime/treasury/markerExactIdentity";
import { verifyTreasuryCurrentSettlement, registerTreasurySettlementLineageHealthSourceForAssembly } from "@/runtime/treasury/currentSettlementCoordinator";
import { treasuryIdentityProfileOfFacts, treasuryProofClassOfIdentityProfile, TREASURY_IDENTITY_PROFILES } from "@/runtime/treasury/identityProfile";
import { sweepTreasuryOrphanGenerationProofOnAdvance } from "@/runtime/treasury/generationProofLifecycle";
import { treasuryMarkerDischargeExpectedOfFacts } from "@/runtime/treasury/markerDischarge";
import {
  readTreasuryIntentEntry,
  releaseTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { classifyTreasuryHandoffAuthorityWindow } from "@/runtime/treasury/lineageHandoff";
import { registerTreasuryIntentLineageProofResolverForAssembly } from "@/runtime/treasury/intents";
import { registerTreasuryQuarantineLineageProofResolverForAssembly } from "@/runtime/treasury/quarantine";
import {
  persistTreasuryGenerationRetirementProof,
  computeTreasuryGenerationRootIdentityDigest,
} from "@/runtime/treasury/generationRetirementAuthority";
import {
  registerTreasurySemanticLineageRecordSourceForAssembly,
} from "@/runtime/treasury/semanticLineageValidation";
import { verifyTreasuryChildActiveCommitRecovery, expectedTreasuryCurrentLineageExactIdentity } from "@/runtime/treasury/currentLineageSettlementVerifier";

/** lineage store schema 版本（持久格式升级时递增；未知版本 fail closed）。 */
export const TREASURY_LINEAGE_VERSION = 3;
/** v2（Round 18，无 identityProfile）——确定性迁移到 v3。 */
export const TREASURY_LINEAGE_LEGACY_VERSION = 2;
/** 硬容量：最多同时存续的重试链数（满载 fail closed，不驱逐；终态压缩见 lineageRetirementSummary）。 */
export const TREASURY_LINEAGE_MAX_ENTRIES = 64;

const LINEAGE_KEY_PREFIX = "l:";
const LINEAGE_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const LINEAGE_ID_BASIS = "treasury-attempt-lineage@v1";
const NON_REARM_REASON_MAX = 96;

/** lineage 状态（单调状态机；语义见 ALLOWED_TRANSITIONS 与模块头注释）。 */
export type TreasuryAttemptLineageState =
  | "retiring"
  | "rearm_ready"
  | "capability_issued"
  | "child_intent_pending"
  | "child_active"
  | "chain_committed"
  | "non_rearmable_retired"
  | "forensic_isolated";

export const TREASURY_ATTEMPT_LINEAGE_STATES: ReadonlySet<string> = new Set<string>([
  "retiring",
  "rearm_ready",
  "capability_issued",
  "child_intent_pending",
  "child_active",
  "chain_committed",
  "non_rearmable_retired",
  "forensic_isolated",
]);

/** current attempt 的 resolution 终态（与 store 状态解耦）。 */
export type TreasuryLineageResolutionState = "unresolved" | "not_executed" | "committed";

/** lineage authority/proof class（与 resolution proofLevel 的可 rearm 子集一致）。 */
export type TreasuryLineageAuthorityClass = "identity-bound" | "lowlevel";

/** attempt identity 的完整视图（root/current 共用形状）。 */
export interface TreasuryAttemptLineageIdentity {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
}

export interface TreasuryAttemptLineageRecord {
  /** 16hex lineage 身份（rootTransactionId + root identity 派生）。 */
  readonly lineageId: string;
  readonly rootTransactionId: string;
  /** 【第二十二轮第十一节】显式 identity profile（v3 必带——chain 级、生命周期不可变）。 */
  readonly identityProfile: import("@/runtime/treasury/identityProfile").TreasuryIdentityProfile;
  readonly rootIdentity: TreasuryAttemptLineageIdentity;
  readonly currentTransactionId: string;
  readonly currentIdentity: TreasuryAttemptLineageIdentity;
  /** 【v2】当前代的 parent attempt ID（generation≥1 必填——接管时冻结）。 */
  readonly currentParentTransactionId?: string;
  /** 当前 attempt 的 action kind（capability actionKind 绑定；不可变）。 */
  readonly actionKind: string;
  /** 稳定 adapter/reconciler 语义身份（capability 匹配用；可选）。 */
  readonly adapterSemanticIdentity?: string;
  /** owner canonical identity（capability 匹配用；可选）。 */
  readonly ownerIdentity?: string;
  /** 非负安全整数；root=0；child 接管完成时 +1（只在接管转换推进）。 */
  readonly generation: number;
  readonly state: TreasuryAttemptLineageState;
  readonly resolutionState: TreasuryLineageResolutionState;
  /** rearm 派生的确定性 child ID（v2 generation-addressable；仅 handoff/回滚态携带）。 */
  readonly nextChildTransactionId?: string;
  /** 【v2】handoff 在途 binding digest（capability_issued 冻结；load 重算验证）。 */
  readonly pendingBindingDigest?: string;
  /** 当前 current 为 rearm child 时的 lineage binding digest（接管时 = pendingBinding）。 */
  readonly bindingDigest?: string;
  /** 当前 current 的重试语义 digest（non-rearmable 缺失；链内不可变）。 */
  readonly retrySemanticDigest?: string;
  readonly authorityClass: TreasuryLineageAuthorityClass;
  readonly lowlevelSource?: string;
  readonly rearmable: boolean;
  readonly nonRearmReason?: string;
  /** retirement 三段完成标志——只适用于 retirementGeneration 标记的代。 */
  readonly retirement: {
    readonly lineagePublished: boolean;
    readonly authorityReleased: boolean;
    readonly markerCleaned: boolean;
  };
  /** 【v2】retirement 三段所属的 generation（新 generation 接管时复位）。 */
  readonly retirementGeneration: number;
  /** 每次成功写入 +1（capability 的 lineage revision 绑定）。 */
  readonly recordRevision: number;
  readonly createdAtTick: number;
  readonly updatedAtTick: number;
}

export interface TreasuryAttemptLineageStore {
  readonly version: number;
  readonly entries: Record<string, TreasuryAttemptLineageRecord>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryLineageBranch {
  attemptLineage?: TreasuryAttemptLineageStore;
}

type RuntimeMemoryWithLineage = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryLineageBranch;
};

function treasuryBranch(): TreasuryLineageBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithLineage;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** 恢复/诊断计数（metrics 聚合用；测试断言 operation-count）。 */
export const lineageStoreEvents = {
  fullScans: 0,
  idleFastPath: 0,
  backfills: 0,
  capabilityExpiries: 0,
  childIntentRollbacks: 0,
  childIntentForensics: 0,
  childActivationForwardCompletions: 0,
  chainCommitCompletions: 0,
  /** 【第二十一轮 8.3】child-active 补完成的 receipt proof conflict 计数。 */
  childCommitProofConflicts: 0,
  retirementCompletions: 0,
  indexCorruptions: 0,
  migrations: 0,
  writes: 0,
  writeFailures: 0,
};

export function resetTreasuryLineageRuntimeForTest(): void {
  heapRuntime = null;
  Object.assign(lineageStoreEvents, {
    fullScans: 0,
    idleFastPath: 0,
    backfills: 0,
    capabilityExpiries: 0,
    childIntentRollbacks: 0,
    childIntentForensics: 0,
    childActivationForwardCompletions: 0,
    chainCommitCompletions: 0,
    childCommitProofConflicts: 0,
    retirementCompletions: 0,
    indexCorruptions: 0,
    migrations: 0,
    writes: 0,
    writeFailures: 0,
  });
}

// 测试清理注册（receipts.clearTreasuryPersistenceForTest 统一调用——模块
// 单向依赖，避免 receipts ↔ attemptLineage 循环 import）。
registerTreasuryLineageResetHook(resetTreasuryLineageRuntimeForTest);

// 【第十八轮 24.5】intent store v6→v7 迁移的 lineage proof 补全 resolver
//（装配注入——模块单向依赖：intents 不 import 本模块）。
const lineageProofOfCurrentAttempt = (transactionId: string): { readonly lineageId: string; readonly generation: number; readonly parentTransactionId: string; readonly bindingDigest: string } | null => {
  const record = lookupTreasuryAttemptLineageByAttemptId(transactionId);
  if (record === undefined || record.currentTransactionId !== transactionId) return null;
  if (record.bindingDigest === undefined || record.currentParentTransactionId === undefined) return null;
  return {
    lineageId: record.lineageId,
    generation: record.generation,
    parentTransactionId: record.currentParentTransactionId,
    bindingDigest: record.bindingDigest,
  };
};
registerTreasuryIntentLineageProofResolverForAssembly(lineageProofOfCurrentAttempt);
registerTreasuryQuarantineLineageProofResolverForAssembly(lineageProofOfCurrentAttempt);

// 【第二十轮第六节】semantic lineage validator 的 active record 只读 source
//（模块加载注册——单向依赖；semanticLineageValidation 不 import 本模块；
// 可重入：测试注销 sources 后可重新装配）。
export function registerTreasuryAttemptLineageSemanticSourceForAssembly(): void {
  registerTreasurySettlementLineageHealthSourceForAssembly(() => {
  const health = peekTreasuryAttemptLineageHealth();
  return { healthy: health.healthy, detail: health.detail ?? null };
});
registerTreasurySemanticLineageRecordSourceForAssembly({
    healthy: () => peekTreasuryAttemptLineageHealth().healthy,
    unhealthyDetail: () => peekTreasuryAttemptLineageHealth().detail,
    readByLineageId: (lineageId) => readTreasuryAttemptLineageRecord(lineageId),
  });
}
registerTreasuryAttemptLineageSemanticSourceForAssembly();

// ── heap 运行态（global reset 即丢；首次 load 一次全表验证重建） ───────────

interface TreasuryLineageStoreRuntime {
  readonly store: TreasuryAttemptLineageStore;
  /** 致命诊断（索引同步失败等——写入失败后标记 fatal，fail closed）。 */
  fatal: string | null;
  /** 空 store 是否已发布到 Memory（读取路径零写缓存——写入前必须发布）。 */
  published: boolean;
  readonly lineageIdIndex: Map<string, string>;
  /** root/current/next O(1) 索引（key = store key，含前缀）。 */
  readonly rootIndex: Map<string, string>;
  readonly currentIndex: Map<string, string>;
  readonly nextChildIndex: Map<string, string>;
  /** 需要恢复动作的 lineage ID 子集（retiring / handoff / child_active）。 */
  readonly pendingIds: Set<string>;
  /** 终态压缩候选（chain_committed / non_rearmable_retired）。 */
  readonly terminalIds: Set<string>;
}

let heapRuntime: TreasuryLineageStoreRuntime | null = null;

// ── 身份派生（纯函数） ──────────────────────────────────────────────────────

/** lineage identity 的合成 digest（capability parentIdentityDigest 等用）。 */
export function computeTreasuryLineageIdentityDigest(identity: TreasuryAttemptLineageIdentity): string {
  return hashTreasuryCanonicalString(
    `lineage-identity:${encodeTreasuryCanonicalTuple([
      identity.digest,
      identity.contractDigest ?? "",
      identity.authorizationCohortDigest ?? "",
      identity.durableIdentityDigest ?? "",
      identity.lowlevelSource ?? "",
    ])}`,
  );
}

/** lineage record 的 lineageId（rootTransactionId + root identity 派生）。 */
export function computeTreasuryAttemptLineageId(
  rootTransactionId: string,
  rootIdentity: TreasuryAttemptLineageIdentity,
): string {
  return hashTreasuryCanonicalString(
    `${LINEAGE_ID_BASIS}:${rootTransactionId}:${computeTreasuryLineageIdentityDigest(rootIdentity)}`,
  );
}

/**
 * 【第十八轮 14.4】generation-addressable next-child ID 派生（production 权威
 * 实现——facade issueTreasuryRearmCapability 专用）：`tr1_<lineageId16>_
 * <generation6hex>_<checksum8>`，checksum 绑定 root transaction ID。同
 * (lineage, generation) 幂等、跨 global reset 恒定；状态机保证每代唯一 child。
 */
export function deriveTreasuryLineageNextChildTransactionId(
  lineageId: string,
  generation: number,
  rootTransactionId: string,
): string {
  return formatTreasuryRearmChildTransactionIdV2({ lineageId, generation, rootTransactionId });
}

/**
 * 指定 generation 的期望 attempt ID（verdict / binding 重算共用）：gen 0 =
 * root；gen ≥1 = v2 派生。O(1)、只凭 record 字段。
 */
export function expectedTreasuryLineageAttemptId(
  record: Pick<TreasuryAttemptLineageRecord, "lineageId" | "rootTransactionId">,
  generation: number,
): string {
  if (generation <= 0) return record.rootTransactionId;
  return deriveTreasuryLineageNextChildTransactionId(record.lineageId, generation, record.rootTransactionId);
}

// ── 形状与语义校验 ──────────────────────────────────────────────────────────

function validateIdentityShape(identity: unknown, label: string): string | null {
  if (!identity || typeof identity !== "object") return `${label} 非对象`;
  const candidate = identity as Partial<TreasuryAttemptLineageIdentity>;
  if (typeof candidate.digest !== "string" || !LINEAGE_DIGEST_PATTERN.test(candidate.digest)) {
    return `${label}.digest 非法（须 16 小写 hex）`;
  }
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !LINEAGE_DIGEST_PATTERN.test(value))) {
      return `${label}.${field} 非法（须 16 小写 hex）`;
    }
  }
  if (candidate.lowlevelSource !== undefined && typeof candidate.lowlevelSource !== "string") {
    return `${label}.lowlevelSource 非字符串`;
  }
  return null;
}

/**
 * record 形状校验（返回 null = 合法）。digest 类字段全部 16hex；generation/
 * recordRevision 非负安全整数；state 枚举；identity-bound 禁 lowlevelSource、
 * lowlevel 必带；lineageId 与 root 派生一致（重算验证——不信任自带字符串）。
 */
export function validateTreasuryAttemptLineageRecordShape(record: unknown): string | null {
  if (!record || typeof record !== "object") return "record 非对象";
  const candidate = record as Partial<TreasuryAttemptLineageRecord>;
  for (const field of ["rootTransactionId", "currentTransactionId"] as const) {
    const value = candidate[field];
    if (typeof value !== "string" || !isValidTreasuryTransactionId(value)) {
      return `record.${field} 非法 transactionId`;
    }
  }
  const rootIdentityError = validateIdentityShape(candidate.rootIdentity, "record.rootIdentity");
  if (rootIdentityError !== null) return rootIdentityError;
  const currentIdentityError = validateIdentityShape(candidate.currentIdentity, "record.currentIdentity");
  if (currentIdentityError !== null) return currentIdentityError;
  const derivedLineageId = computeTreasuryAttemptLineageId(candidate.rootTransactionId!, candidate.rootIdentity!);
  if (candidate.lineageId !== derivedLineageId) {
    return `record.lineageId 与 root identity 重算不一致（entry ${String(candidate.lineageId).slice(0, 16)}，重算 ${derivedLineageId.slice(0, 16)}）`;
  }
  if (candidate.state === undefined || !TREASURY_ATTEMPT_LINEAGE_STATES.has(candidate.state)) {
    return `record.state 非法枚举: ${String(candidate.state).slice(0, 32)}`;
  }
  if (
    candidate.resolutionState === undefined ||
    !["unresolved", "not_executed", "committed"].includes(candidate.resolutionState)
  ) {
    return `record.resolutionState 非法枚举: ${String(candidate.resolutionState).slice(0, 32)}`;
  }
  if (candidate.authorityClass !== "identity-bound" && candidate.authorityClass !== "lowlevel") {
    return `record.authorityClass 非法: ${String(candidate.authorityClass).slice(0, 32)}`;
  }
  if (candidate.authorityClass === "identity-bound" && candidate.lowlevelSource !== undefined) {
    return "record.identity-bound 携带 lowlevelSource（class 矛盾）";
  }
  if (candidate.authorityClass === "lowlevel" && typeof candidate.lowlevelSource !== "string") {
    return "record.lowlevel 缺少 lowlevelSource";
  }
  if (!TREASURY_IDENTITY_PROFILES.has(candidate.identityProfile as never)) {
    return `record.identityProfile 非法枚举（${String(candidate.identityProfile).slice(0, 32)}）`;
  }
  if (
    candidate.identityProfile !== "legacy-replay" &&
    candidate.identityProfile !== "forensic-isolated" &&
    treasuryProofClassOfIdentityProfile(candidate.identityProfile) !== candidate.authorityClass
  ) {
    return "record.identityProfile 与 authorityClass 不满足唯一合法组合";
  }
  for (const field of ["generation", "recordRevision", "createdAtTick", "updatedAtTick"] as const) {
    const value = candidate[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return `record.${field} 非安全非负整数`;
    }
  }
  if (
    candidate.retirementGeneration === undefined ||
    typeof candidate.retirementGeneration !== "number" ||
    !Number.isSafeInteger(candidate.retirementGeneration) ||
    candidate.retirementGeneration < 0
  ) {
    return "record.retirementGeneration 非安全非负整数（v2 必填）";
  }
  if (typeof candidate.actionKind !== "string" || candidate.actionKind.length === 0 || candidate.actionKind.length > 128) {
    return "record.actionKind 非法（1..128 字符）";
  }
  if (candidate.adapterSemanticIdentity !== undefined && (typeof candidate.adapterSemanticIdentity !== "string" || candidate.adapterSemanticIdentity.length === 0)) {
    return "record.adapterSemanticIdentity 非法";
  }
  if (candidate.ownerIdentity !== undefined && (typeof candidate.ownerIdentity !== "string" || candidate.ownerIdentity.length === 0)) {
    return "record.ownerIdentity 非法";
  }
  if (candidate.currentParentTransactionId !== undefined) {
    if (typeof candidate.currentParentTransactionId !== "string" || !isValidTreasuryTransactionId(candidate.currentParentTransactionId)) {
      return "record.currentParentTransactionId 非法 transactionId";
    }
  }
  if (candidate.nextChildTransactionId !== undefined) {
    if (typeof candidate.nextChildTransactionId !== "string" || !isValidTreasuryTransactionId(candidate.nextChildTransactionId)) {
      return "record.nextChildTransactionId 非法";
    }
  }
  if (candidate.retrySemanticDigest !== undefined && (typeof candidate.retrySemanticDigest !== "string" || !LINEAGE_DIGEST_PATTERN.test(candidate.retrySemanticDigest))) {
    return "record.retrySemanticDigest 非法（须 16 小写 hex）";
  }
  for (const field of ["bindingDigest", "pendingBindingDigest"] as const) {
    if (candidate[field] !== undefined && (typeof candidate[field] !== "string" || !LINEAGE_DIGEST_PATTERN.test(candidate[field] as string))) {
      return `record.${field} 非法（须 16 小写 hex）`;
    }
  }
  if (typeof candidate.rearmable !== "boolean") return "record.rearmable 非布尔";
  if (candidate.nonRearmReason !== undefined) {
    if (typeof candidate.nonRearmReason !== "string" || candidate.nonRearmReason.length === 0 || candidate.nonRearmReason.length > NON_REARM_REASON_MAX) {
      return "record.nonRearmReason 非法（1..96 字符）";
    }
  }
  if (candidate.rearmable === false && candidate.nonRearmReason === undefined) {
    return "record.non-rearmable 缺少 nonRearmReason";
  }
  if (candidate.rearmable === true && candidate.retrySemanticDigest === undefined) {
    return "record.rearmable 缺少 retrySemanticDigest（无 retry 语义不可 rearm）";
  }
  const retirement = candidate.retirement as Partial<TreasuryAttemptLineageRecord["retirement"]> | undefined;
  if (!retirement || typeof retirement !== "object") return "record.retirement 非对象";
  for (const field of ["lineagePublished", "authorityReleased", "markerCleaned"] as const) {
    if (typeof retirement[field] !== "boolean") return `record.retirement.${field} 非布尔`;
  }
  return null;
}

/**
 * 持久语义矩阵（load / 写入候选共用）：状态组合 + handoff facts 派生验证
 * （nextChild 必须是 v2 generation-addressable 且等于 record 派生；pending-
 * Binding 必须等于 (lineageId, generation+1, parent=current, child) 重算）。
 */
export function validateTreasuryAttemptLineageRecordState(record: unknown): string | null {
  const candidate = record as Partial<TreasuryAttemptLineageRecord>;
  const state = candidate.state;
  // handoff facts 派生验证（任何携带 nextChild 的状态）。
  if (candidate.nextChildTransactionId !== undefined) {
    if (state !== "rearm_ready" && state !== "capability_issued" && state !== "child_intent_pending") {
      return `${String(state)} 不得携带 nextChildTransactionId（handoff 事实只存在于 handoff/回滚态）`;
    }
    const parsed = parseTreasuryRearmChildTransactionIdV2(candidate.nextChildTransactionId);
    if (parsed === null) {
      return "record.nextChildTransactionId 非 v2 generation-addressable 形态（legacy v1 child 不得出现在 v2 store）";
    }
    if (parsed.lineageId !== candidate.lineageId || parsed.generation !== candidate.generation! + 1) {
      return "record.nextChildTransactionId 与 (lineageId, generation+1) 派生不一致";
    }
    const checksum = treasuryRearmChildIdChecksumOf({
      lineageId: candidate.lineageId!,
      generation: candidate.generation! + 1,
      rootTransactionId: candidate.rootTransactionId!,
    });
    if (!candidate.nextChildTransactionId.endsWith(`_${checksum}`)) {
      return "record.nextChildTransactionId checksum 与 root 绑定重算不一致";
    }
    if (candidate.pendingBindingDigest === undefined) {
      return "携带 nextChildTransactionId 的 record 必须同时携带 pendingBindingDigest";
    }
    const expectedBinding = computeTreasuryLineageBindingDigest({
      lineageId: candidate.lineageId!,
      generation: candidate.generation! + 1,
      parentTransactionId: candidate.currentTransactionId!,
      childTransactionId: candidate.nextChildTransactionId,
    });
    if (candidate.pendingBindingDigest !== expectedBinding) {
      return "record.pendingBindingDigest 与 handoff 派生重算不一致（篡改/损坏）";
    }
  } else if (candidate.pendingBindingDigest !== undefined) {
    return "record.pendingBindingDigest 只能与 nextChildTransactionId 同时存在";
  }
  // 接管后的 binding 与 parent 验证（generation ≥1）。
  if (candidate.generation! >= 1) {
    if (candidate.currentParentTransactionId === undefined) {
      return `generation≥1 的 record 必须携带 currentParentTransactionId（迁移遗留的 v1 child 除外——load 迁移时按原始事实保留）`;
    }
    if (candidate.bindingDigest === undefined) {
      return "generation≥1 的 record 必须携带 bindingDigest（child 接管证明）";
    }
    if (candidate.currentParentTransactionId === candidate.currentTransactionId) {
      return "record.currentParentTransactionId 等于 current（parent/child 不得相同）";
    }
    const parsedCurrent = parseTreasuryRearmChildTransactionIdV2(candidate.currentTransactionId);
    if (parsedCurrent !== null) {
      const expectedCurrent = expectedTreasuryLineageAttemptId(candidate as TreasuryAttemptLineageRecord, candidate.generation!);
      if (parsedCurrent.lineageId !== candidate.lineageId || candidate.currentTransactionId !== expectedCurrent) {
        return "generation≥1 的 v2 current 与 (lineageId, generation) 派生不一致";
      }
      const expectedParent = expectedTreasuryLineageAttemptId(candidate as TreasuryAttemptLineageRecord, candidate.generation! - 1);
      if (candidate.currentParentTransactionId !== expectedParent) {
        return "record.currentParentTransactionId 与上一代期望 attempt ID 不一致";
      }
    }
    const expectedBinding = computeTreasuryLineageBindingDigest({
      lineageId: candidate.lineageId!,
      generation: candidate.generation!,
      parentTransactionId: candidate.currentParentTransactionId,
      childTransactionId: candidate.currentTransactionId,
    });
    if (candidate.bindingDigest !== expectedBinding) {
      return "record.bindingDigest 与 (lineage, generation, parent, current) 派生重算不一致";
    }
  } else {
    if (candidate.bindingDigest !== undefined) return "generation=0（root 代）不得携带 bindingDigest";
    if (candidate.currentParentTransactionId !== undefined) return "generation=0 不得携带 currentParentTransactionId";
  }
  switch (state) {
    case "retiring":
      if (candidate.resolutionState !== "not_executed") return "retiring 只能配 not_executed";
      if (candidate.retirementGeneration !== candidate.generation) return "retiring 的 retirementGeneration 必须等于当前代";
      break;
    case "rearm_ready":
      if (candidate.resolutionState !== "not_executed") return "rearm_ready 只能配 not_executed";
      if (!candidate.retirement?.lineagePublished || !candidate.retirement?.authorityReleased || !candidate.retirement?.markerCleaned) {
        return "rearm_ready 必须三段 retirement 全部完成";
      }
      if (candidate.retirementGeneration !== candidate.generation) return "rearm_ready 的 retirementGeneration 必须等于当前代";
      break;
    case "capability_issued":
      if (candidate.resolutionState !== "not_executed") return "capability_issued 只能配 not_executed";
      if (candidate.nextChildTransactionId === undefined) return "capability_issued 必须携带 nextChildTransactionId";
      break;
    case "child_intent_pending":
      if (candidate.nextChildTransactionId === undefined) return "child_intent_pending 必须携带 nextChildTransactionId";
      break;
    case "child_active":
      if (candidate.resolutionState !== "unresolved") return "child_active 只能配 unresolved";
      if (candidate.currentTransactionId === candidate.rootTransactionId) {
        return "child_active 的 current 必须是 child（不得为 root）";
      }
      break;
    case "chain_committed":
      if (candidate.resolutionState !== "committed") return "chain_committed 只能配 committed";
      break;
    case "non_rearmable_retired":
    case "forensic_isolated":
      if (candidate.rearmable !== false) return `${String(state)} 必须 non-rearmable`;
      if (candidate.retirementGeneration !== candidate.generation) {
        return `${String(state)} 的 retirementGeneration 必须等于当前代`;
      }
      break;
  }
  return null;
}

// ── 状态机（单调转换矩阵 + transition-specific 允许字段） ───────────────────

export type TreasuryAttemptLineageTransitionResult =
  | { readonly status: "allowed" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly detail: string };

/** 单次状态转换的合法边（forensic_isolated 允许从任意状态进入——隔离）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<TreasuryAttemptLineageState, readonly TreasuryAttemptLineageState[]>> = {
  retiring: ["rearm_ready", "non_rearmable_retired", "forensic_isolated"],
  rearm_ready: ["capability_issued", "forensic_isolated"],
  capability_issued: ["child_intent_pending", "rearm_ready", "forensic_isolated"],
  child_intent_pending: ["child_active", "rearm_ready", "forensic_isolated"],
  child_active: ["chain_committed", "retiring", "forensic_isolated"],
  chain_committed: ["forensic_isolated"],
  non_rearmable_retired: [],
  forensic_isolated: [],
};

/** 全局冻结字段（任何转换不得变化——不可变安全事实）。 */
const FROZEN_FIELDS: readonly string[] = [
  "lineageId",
  "rootTransactionId",
  "rootIdentity",
  "actionKind",
  "adapterSemanticIdentity",
  "ownerIdentity",
  "authorityClass",
  "lowlevelSource",
  "createdAtTick",
];

/**
 * 【第十八轮 24.7】每条转换的允许变化字段集合（top-level key；"retirement"
 * 视为单字段）。未列出的字段变化 → 拒绝（同 state 只允许明确声明的进度
 * 字段变化；current identity/generation/binding 只在接管转换同时变化）。
 */
const TRANSITION_ALLOWED_CHANGES: Readonly<Record<string, readonly string[]>> = {
  // child 退休（direct non-OK 或 resolver publication）。
  "child_active>retiring": [
    "state", "resolutionState", "retirement", "retirementGeneration", "nextChildTransactionId",
    "pendingBindingDigest", "rearmable", "nonRearmReason", "retrySemanticDigest", "updatedAtTick", "recordRevision",
  ],
  "retiring>rearm_ready": ["state", "retirement", "rearmable", "nonRearmReason", "updatedAtTick", "recordRevision"],
  "retiring>non_rearmable_retired": ["state", "retirement", "rearmable", "nonRearmReason", "updatedAtTick", "recordRevision"],
  // capability 签发（handoff facts 冻结）。
  "rearm_ready>capability_issued": ["state", "nextChildTransactionId", "pendingBindingDigest", "updatedAtTick", "recordRevision"],
  // handoff 推进（child intent 写入前）。
  "capability_issued>child_intent_pending": ["state", "updatedAtTick", "recordRevision"],
  // 回滚（capability 过期 / intent 未开始失败）——child facts 保留（同代重签）。
  "capability_issued>rearm_ready": ["state", "updatedAtTick", "recordRevision"],
  "child_intent_pending>rearm_ready": ["state", "updatedAtTick", "recordRevision"],
  // 接管（唯一允许 current/generation/binding 变化的转换）。
  "child_intent_pending>child_active": [
    "state", "currentTransactionId", "currentIdentity", "currentParentTransactionId", "generation",
    "resolutionState", "bindingDigest", "nextChildTransactionId", "pendingBindingDigest",
    "retirement", "retirementGeneration", "updatedAtTick", "recordRevision",
  ],
  // child commit 终态。
  "child_active>chain_committed": ["state", "resolutionState", "updatedAtTick", "recordRevision"],
  // retiring 同 state 的恢复收敛（三段标志 / backfill 补齐 digest）。
  "retiring>retiring": ["retirement", "retrySemanticDigest", "rearmable", "nonRearmReason", "updatedAtTick", "recordRevision"],
};

function allowedChangesOf(existingState: TreasuryAttemptLineageState, nextState: TreasuryAttemptLineageState): readonly string[] | null {
  if (nextState === "forensic_isolated") {
    return ["state", "rearmable", "nonRearmReason", "nextChildTransactionId", "pendingBindingDigest", "updatedAtTick", "recordRevision"];
  }
  return TRANSITION_ALLOWED_CHANGES[`${existingState}>${nextState}`] ?? null;
}

function changedTopLevelKeys(
  existing: TreasuryAttemptLineageRecord,
  next: TreasuryAttemptLineageRecord,
): string[] {
  const keys = new Set<string>([...Object.keys(existing), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    const left = (existing as unknown as Record<string, unknown>)[key];
    const right = (next as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(key);
  }
  return changed;
}

/**
 * 转换校验（写入与 load 全表校验共用）：
 * - exact idempotence：完整一致（含 revision 一致）→ idempotent（真正可达）；
 * - 非幂等写：recordRevision 严格 +1；
 * - 全局冻结字段不可变；generation 只在接管转换 +1、其余必须相等；
 * - 每条转换的允许变化字段集合（changed keys ⊆ allowed set）；
 * - updatedAtTick 不回退；rearmable 只允许 true→false。
 */
export function validateTreasuryAttemptLineageTransition(
  existing: TreasuryAttemptLineageRecord | undefined,
  next: TreasuryAttemptLineageRecord,
): TreasuryAttemptLineageTransitionResult {
  if (existing === undefined) {
    // 新建：retiring（staged publication 起点）或终局 non-rearmable/forensic。
    if (next.state !== "retiring" && next.state !== "non_rearmable_retired" && next.state !== "forensic_isolated") {
      return { status: "rejected", detail: `新建 lineage 只能从 retiring/non_rearmable_retired/forensic_isolated 开始（got ${String(next.state)}）` };
    }
    return { status: "allowed" };
  }
  // 全局冻结事实。
  for (const field of FROZEN_FIELDS) {
    const left = (existing as unknown as Record<string, unknown>)[field];
    const right = (next as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      return { status: "rejected", detail: `冻结字段 ${field} 不可变化` };
    }
  }
  // 接管转换的 generation 规则。
  const isTakeover = existing.state === "child_intent_pending" && next.state === "child_active";
  if (isTakeover) {
    if (next.generation !== existing.generation + 1) {
      return { status: "rejected", detail: `接管转换 generation 必须严格 +1（${String(existing.generation)} → ${String(next.generation)}）` };
    }
  } else if (next.generation !== existing.generation) {
    return { status: "rejected", detail: "非接管转换 generation 不可变化（不可回退、不可跳跃）" };
  }
  // exact idempotence（完整一致且 revision 一致 → 幂等，revision 不增加）。
  if (JSON.stringify({ ...existing }) === JSON.stringify({ ...next })) {
    return { status: "idempotent" };
  }
  if (next.recordRevision !== existing.recordRevision + 1) {
    return { status: "rejected", detail: `recordRevision 必须严格 +1 或 exact idempotent（${String(existing.recordRevision)} → ${String(next.recordRevision)}）` };
  }
  if (existing.rearmable === true && next.rearmable === false) {
    // 允许（retiring/forensic 的 declared 进度）；false→true 禁止。
  } else if (existing.rearmable !== next.rearmable) {
    return { status: "rejected", detail: "rearmable 不可从 false 恢复为 true" };
  }
  if (existing.retrySemanticDigest !== next.retrySemanticDigest) {
    const progressDigest = existing.retrySemanticDigest === undefined && next.retrySemanticDigest !== undefined;
    if (!progressDigest) {
      return { status: "rejected", detail: "retry semantic identity 不可改变（child 必须是 parent 动作的语义重试；已定义后不可重写）" };
    }
  }
  if (next.updatedAtTick < existing.updatedAtTick) {
    return { status: "rejected", detail: "updatedAtTick 不可回退" };
  }
  const allowed = allowedChangesOf(existing.state, next.state);
  if (allowed === null) {
    if (existing.state === next.state) {
      return { status: "rejected", detail: `同状态 ${String(existing.state)} 只允许明确声明的进度字段变化` };
    }
    return { status: "rejected", detail: `非法状态转换 ${String(existing.state)} → ${String(next.state)}` };
  }
  if (existing.state !== next.state && !ALLOWED_TRANSITIONS[existing.state].includes(next.state)) {
    return { status: "rejected", detail: `非法状态转换 ${String(existing.state)} → ${String(next.state)}` };
  }
  const changed = changedTopLevelKeys(existing, next);
  for (const key of changed) {
    if (!allowed.includes(key)) {
      return { status: "rejected", detail: `转换 ${String(existing.state)} → ${String(next.state)} 不允许修改字段 ${key}（transition-specific 允许字段集外的变化）` };
    }
  }
  return { status: "allowed" };
}

// ── store 运行态 load / 验证 / 索引 ────────────────────────────────────────

/** 空 store 发布到 Memory（写入路径权威初始化——读取路径零写缓存解除）。 */
function publishLineageStoreToMemory(runtime: TreasuryLineageStoreRuntime): void {
  const target = ((Memory.runtime ??= {} as NonNullable<Memory["runtime"]>) as unknown as RuntimeMemoryWithLineage);
  const branch = (target.treasury ??= {});
  if (branch.attemptLineage === undefined) {
    branch.attemptLineage = runtime.store as unknown as NonNullable<(typeof branch)["attemptLineage"]>;
  }
  runtime.published = true;
}

function emptyLineageRuntime(): TreasuryLineageStoreRuntime {
  const store: TreasuryAttemptLineageStore = {
    version: TREASURY_LINEAGE_VERSION,
    entries: {},
    entryCount: 0,
    updatedAt: Game.time,
  };
  return {
    store,
    fatal: null,
    published: false,
    lineageIdIndex: new Map(),
    rootIndex: new Map(),
    currentIndex: new Map(),
    nextChildIndex: new Map(),
    pendingIds: new Set(),
    terminalIds: new Set(),
  };
}

/**
 * 【第十八轮 24.9】store v1 → v2 迁移：v1 record 的 nextChildTransactionId
 * 由 parent identity 派生（不可 generation 寻址）——一律回退清除（等价
 * global reset 后的 capability 过期回滚：heap capability 在迁移场景必然已
 * 失效，child ID 将按 v2 重新确定性派生）；capability_issued/child_intent_
 * pending 同步回退 rearm_ready。其余状态原样携带 + 补 retirementGeneration。
 * 迁移后的 v1 child（current）不受影响（current 不需重派生），但其历史
 * tombstone 不可寻址 → verdict 永久 pin。
 */
function migrateLineageStoreV1ToV2(raw: TreasuryAttemptLineageStore): { store: TreasuryAttemptLineageStore; detail: string | null } {
  const entries: Record<string, TreasuryAttemptLineageRecord> = {};
  let rolledBack = 0;
  let forensics = 0;
  for (const [key, rawRecord] of Object.entries(raw.entries)) {
    const record = rawRecord as Partial<TreasuryAttemptLineageRecord>;
    let next: TreasuryAttemptLineageRecord;
    const legacyChild =
      record.nextChildTransactionId !== undefined &&
      parseTreasuryRearmChildTransactionIdV2(record.nextChildTransactionId) === null;
    if (legacyChild || record.state === "capability_issued" || record.state === "child_intent_pending") {
      // 回退：handoff 在途状态迁移等价 global reset（capability 必然失效）。
      const { nextChildTransactionId: _stale, pendingBindingDigest: _staleBinding, ...rest } = record as TreasuryAttemptLineageRecord;
      void _stale;
      void _staleBinding;
      next = {
        ...rest,
        state: "rearm_ready",
        retirementGeneration: record.generation,
        updatedAtTick: Game.time,
        recordRevision: record.recordRevision + 1,
      } as TreasuryAttemptLineageRecord;
      rolledBack += 1;
    } else if (
      record.generation! >= 1 &&
      record.currentParentTransactionId === undefined &&
      parseTreasuryRearmChildTransactionIdV2(record.currentTransactionId!) === null
    ) {
      // v1 child（不可 generation 寻址）且无法证明 parent（gen≥2 的 parent 是
      // 不可重派的 v1 child）→ forensic 隔离（不猜测）；gen 1 的 parent=root
      // 可安全补全。
      const { nextChildTransactionId: _stale, pendingBindingDigest: _staleBinding, ...rest } = record as TreasuryAttemptLineageRecord;
      void _stale;
      void _staleBinding;
      next = {
        ...rest,
        currentParentTransactionId: record.generation === 1 ? record.rootTransactionId : undefined,
        ...(record.generation === 1 ? {} : { state: "forensic_isolated" as const, rearmable: false, nonRearmReason: "v1→v2 迁移：gen≥2 的 v1 child 无法证明 parent（不猜测 generation/parent）" }),
        retirementGeneration: record.generation,
        updatedAtTick: Game.time,
        recordRevision: record.recordRevision + 1,
      } as TreasuryAttemptLineageRecord;
      if (record.generation !== 1) forensics += 1;
    } else {
      next = {
        ...record,
        ...(record.generation! >= 1 && record.currentParentTransactionId === undefined
          ? { currentParentTransactionId: record.rootTransactionId }
          : {}),
        retirementGeneration: record.generation,
      } as TreasuryAttemptLineageRecord;
    }
    entries[key] = next;
  }
  const store: TreasuryAttemptLineageStore = {
    // 【第二十二轮】v1→v2 产物标记 legacy 版本——v2→v3 迁移链式接续补 profile。
    version: TREASURY_LINEAGE_LEGACY_VERSION,
    entries,
    entryCount: Object.keys(entries).length,
    updatedAt: Game.time,
  };
  lineageStoreEvents.migrations += 1;
  return {
    store,
    detail: `lineage store v1→v2 迁移完成（回退 ${String(rolledBack)}，forensic 隔离 ${String(forensics)}）`,
  };
}

function loadLineageStoreRuntime(forWrite = false): TreasuryLineageStoreRuntime {
  if (heapRuntime !== null) return heapRuntime;
  lineageStoreEvents.fullScans += 1;
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  if (branch?.attemptLineage === undefined) {
    // 读取路径返回空运行态（零写）；写入路径创建空 store 并发布到 Memory
    //（否则后续写入落在 heap 幽灵对象上——Memory 从未收到权威数据）。
    heapRuntime = emptyLineageRuntime();
    if (forWrite) publishLineageStoreToMemory(heapRuntime);
    return heapRuntime;
  }
  const raw = branch.attemptLineage as unknown as TreasuryAttemptLineageStore;
  // 【XII 工作流 D / Q4】query 不迁移：读路径（forWrite=false）遇 v1/v2
  // legacy 版本 → fatal（migration_required——fail closed，原数据保留、
  // 零写）；迁移只由写路径 load（forWrite=true）或 beginTick migration
  // owner 执行。unrelated 损坏仍由下方 v3 校验承载。
  if (
    !forWrite &&
    (raw.version === TREASURY_LINEAGE_VERSION - 2 || raw.version === TREASURY_LINEAGE_VERSION - 1)
  ) {
    const pendingRuntime: TreasuryLineageStoreRuntime = {
      store: raw,
      fatal: `lineage store v${String(raw.version)} 待迁移（query 零写——beginTick migration owner 执行）`,
      published: true,
      lineageIdIndex: new Map(),
      rootIndex: new Map(),
      currentIndex: new Map(),
      nextChildIndex: new Map(),
      pendingIds: new Set(),
      terminalIds: new Set(),
    };
    heapRuntime = pendingRuntime;
    return pendingRuntime;
  }
  let store = raw;
  if (raw.version === TREASURY_LINEAGE_VERSION - 2) {
    const migrated = migrateLineageStoreV1ToV2(raw);
    store = migrated.store;
    branch.attemptLineage = store as unknown as NonNullable<(typeof branch)["attemptLineage"]>;
  }
  // 【第二十二轮 11.7】v2 → v3 确定性迁移（identityProfile 从 root identity
  // 推导——modern 三元组 → modern-contract；lowlevel 矩阵 → lowlevel；
  // contract/cohort 同时缺失 → legacy-replay（隔离，不自动获得 execution/
  // settlement 权限）；partial → 整 store fail closed 原数据保留）。
  if ((store as { version?: number }).version === TREASURY_LINEAGE_VERSION - 1) {
    lineageStoreEvents.fullScans += 1;
    const migratedEntries: Record<string, TreasuryAttemptLineageRecord> = {};
    let migrationError: string | null = null;
    for (const [key, record] of Object.entries(store.entries)) {
      const profile = treasuryIdentityProfileOfFacts((record as { rootIdentity?: unknown }).rootIdentity);
      if (profile === null) {
        migrationError = `v2→v3 迁移推导失败（${key.slice(0, 16)}：partial/矛盾身份字段——整 store fail closed，原数据保留）`;
        break;
      }
      migratedEntries[key] = { ...(record as object), identityProfile: profile } as unknown as TreasuryAttemptLineageRecord;
    }
    if (migrationError === null) {
      const migratedStore: TreasuryAttemptLineageStore = {
        version: TREASURY_LINEAGE_VERSION,
        entries: migratedEntries,
        entryCount: Object.keys(migratedEntries).length,
        updatedAt: Game.time,
      };
      const migratedShape = validateLineageStoreShape(migratedStore);
      if (migratedShape === null) {
        lineageStoreEvents.migrations += 1;
        store = migratedStore;
        branch.attemptLineage = store as unknown as NonNullable<(typeof branch)["attemptLineage"]>;
      } else {
        migrationError = migratedShape;
      }
    }
    if (migrationError !== null) {
      if (process.env.DEBUG_R22L) console.log("DBG-LIN-MIG:", migrationError);
      const fatalRuntime: TreasuryLineageStoreRuntime = {
        store,
        fatal: `lineage v2→v3 迁移自检失败: ${migrationError}（原数据保留 fail closed）`,
        published: true,
        lineageIdIndex: new Map(),
        rootIndex: new Map(),
        currentIndex: new Map(),
        nextChildIndex: new Map(),
        pendingIds: new Set(),
        terminalIds: new Set(),
      };
      heapRuntime = fatalRuntime;
      return fatalRuntime;
    }
  }
  const fatal = validateLineageStoreShape(store);
  const runtime: TreasuryLineageStoreRuntime = {
    store,
    fatal,
    published: true,
    lineageIdIndex: new Map(),
    rootIndex: new Map(),
    currentIndex: new Map(),
    nextChildIndex: new Map(),
    pendingIds: new Set(),
    terminalIds: new Set(),
  };
  if (fatal === null) {
    // 跨索引完整性（24.6）：duplicate lineageId/current/next、跨索引冲突 →
    // 整个 store unhealthy（不静默覆盖、不自动删除）。
    const conflict = findTreasuryLineageCrossIndexConflicts(Object.values(store.entries));
    if (conflict !== null) {
      runtime.fatal = `lineage 索引冲突: ${conflict}`;
      lineageStoreEvents.indexCorruptions += 1;
    } else {
      buildLineageIndexes(runtime);
    }
  }
  heapRuntime = runtime;
  return runtime;
}

function validateLineageStoreShape(store: TreasuryAttemptLineageStore): string | null {
  if (!store || typeof store !== "object") return "lineage store 非对象";
  if (store.version !== TREASURY_LINEAGE_VERSION && store.version !== TREASURY_LINEAGE_LEGACY_VERSION) {
    return `lineage store 版本未知（${String(store.version)}，期望 ${String(TREASURY_LINEAGE_VERSION)}）——fail closed`;
  }
  if (!store.entries || typeof store.entries !== "object") return "lineage store.entries 非对象";
  const ownKeys = Object.keys(store.entries);
  if (ownKeys.length !== store.entryCount) {
    return `lineage entryCount 不一致（ownKeys ${String(ownKeys.length)}，entryCount ${String(store.entryCount)}）`;
  }
  if (store.entryCount > TREASURY_LINEAGE_MAX_ENTRIES) {
    return `lineage store 超过硬容量（${String(store.entryCount)} > ${String(TREASURY_LINEAGE_MAX_ENTRIES)}）`;
  }
  const seenRoot = new Set<string>();
  for (const key of ownKeys) {
    if (!key.startsWith(LINEAGE_KEY_PREFIX)) return `lineage key 非法（须 ${LINEAGE_KEY_PREFIX} 前缀）: ${key.slice(0, 24)}`;
    const record = store.entries[key];
    const shapeError = validateTreasuryAttemptLineageRecordShape(record);
    if (shapeError !== null) return `lineage entry 损坏（${key.slice(0, 24)}）: ${shapeError}`;
    const stateError = validateTreasuryAttemptLineageRecordState(record);
    if (stateError !== null) return `lineage entry 语义非法（${key.slice(0, 24)}）: ${stateError}`;
    if (key !== LINEAGE_KEY_PREFIX + record.rootTransactionId) {
      return `lineage key 与 rootTransactionId 不一致（${key.slice(0, 24)}）`;
    }
    if (seenRoot.has(record.rootTransactionId)) return `lineage root 重复（${record.rootTransactionId.slice(0, 24)}）`;
    seenRoot.add(record.rootTransactionId);
  }
  return null;
}

function buildLineageIndexes(runtime: TreasuryLineageStoreRuntime): void {
  runtime.lineageIdIndex.clear();
  runtime.rootIndex.clear();
  runtime.currentIndex.clear();
  runtime.nextChildIndex.clear();
  runtime.pendingIds.clear();
  runtime.terminalIds.clear();
  for (const [key, record] of Object.entries(runtime.store.entries)) {
    runtime.lineageIdIndex.set(record.lineageId, key);
    runtime.rootIndex.set(record.rootTransactionId, key);
    runtime.currentIndex.set(record.currentTransactionId, key);
    if (record.nextChildTransactionId !== undefined) runtime.nextChildIndex.set(record.nextChildTransactionId, key);
    if (record.state === "retiring" || record.state === "capability_issued" || record.state === "child_intent_pending" || record.state === "child_active") {
      runtime.pendingIds.add(record.lineageId);
    }
    if (record.state === "chain_committed" || record.state === "non_rearmable_retired") {
      runtime.terminalIds.add(record.lineageId);
    }
  }
}

export interface TreasuryAttemptLineageHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
  readonly pendingCount: number;
}

/** 零写健康探测（不触发创建；对已存在 store 触发 load validation）。 */
export function peekTreasuryAttemptLineageHealth(): TreasuryAttemptLineageHealth {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  if (branch?.attemptLineage === undefined) {
    return { healthy: true, detail: null, entryCount: 0, pendingCount: 0 };
  }
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) {
    return { healthy: false, detail: runtime.fatal, entryCount: 0, pendingCount: 0 };
  }
  return { healthy: true, detail: null, entryCount: runtime.store.entryCount, pendingCount: runtime.pendingIds.size };
}

/** 写路径健康门禁（返回 null = 可写）。 */
export function ensureTreasuryAttemptLineageStoreValidated(): string | null {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  if (branch?.attemptLineage === undefined) return null;
  return loadLineageStoreRuntime().fatal;
}

/**
 * 【XII 工作流 D / Q7】lineage store legacy 版本的 tick-boundary 显式迁移
 * （唯一 migration owner——beginTick 前置阶段调用）。absent/v3 → idle（零
 * 写）；v1/v2 → 复用写路径 load（forWrite=true）的确定性迁移 + 全量重验 +
 * 原子替换；迁移失败 → blocked（原数据保留，读路径继续 fail closed）。
 */
export function migrateTreasuryLineageStoreLegacyAtTickBoundary(): { status: "idle" | "migrated" | "blocked"; detail: string | null } {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  const raw = branch?.attemptLineage as { version?: unknown } | undefined;
  if (raw === undefined) return { status: "idle", detail: null };
  if (raw.version === TREASURY_LINEAGE_VERSION) return { status: "idle", detail: null };
  if (raw.version !== TREASURY_LINEAGE_VERSION - 2 && raw.version !== TREASURY_LINEAGE_VERSION - 1) {
    return { status: "blocked", detail: `lineage store 版本未知（${String(raw.version).slice(0, 8)}——不迁移，fail closed）` };
  }
  // 【XII】heap 失效（同 issuer migrate——防 heap 视图遮蔽 Memory legacy store）。
  if (heapRuntime !== null && heapRuntime.store !== raw) heapRuntime = null;
  const runtime = loadLineageStoreRuntime(true);
  if (runtime.fatal !== null) {
    return { status: "blocked", detail: runtime.fatal };
  }
  return { status: "migrated", detail: null };
}

// ── 读取（冻结快照；全部 O(1) 索引） ────────────────────────────────────────

function freezeRecord(record: TreasuryAttemptLineageRecord): Readonly<TreasuryAttemptLineageRecord> {
  return treasuryBoundedDeepFreezeSnapshot(record) as Readonly<TreasuryAttemptLineageRecord>;
}

/** lineageId O(1) 读取（第十八轮起不再扫描全部 entries）。 */
export function readTreasuryAttemptLineageRecord(lineageId: string): Readonly<TreasuryAttemptLineageRecord> | undefined {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.lineageIdIndex.get(lineageId);
  if (key === undefined) return undefined;
  const record = runtime.store.entries[key];
  if (record === undefined || record.lineageId !== lineageId) {
    lineageStoreEvents.indexCorruptions += 1;
    return undefined;
  }
  return freezeRecord(record);
}

/** root ∪ current 索引 O(1) 查询（prepare 门禁的 retired 检测）。 */
export function lookupTreasuryAttemptLineageByAttemptId(transactionId: string): Readonly<TreasuryAttemptLineageRecord> | undefined {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.rootIndex.get(transactionId) ?? runtime.currentIndex.get(transactionId);
  if (key === undefined) return undefined;
  const record = runtime.store.entries[key];
  if (record === undefined) {
    lineageStoreEvents.indexCorruptions += 1;
    return undefined;
  }
  return freezeRecord(record);
}

/** next-child 索引 O(1) 查询（child 占用检测的一部分）。 */
export function lookupTreasuryAttemptLineageByNextChild(childTransactionId: string): Readonly<TreasuryAttemptLineageRecord> | undefined {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.nextChildIndex.get(childTransactionId);
  if (key === undefined) return undefined;
  const record = runtime.store.entries[key];
  if (record === undefined) {
    lineageStoreEvents.indexCorruptions += 1;
    return undefined;
  }
  return freezeRecord(record);
}

// ── 容量预检 ────────────────────────────────────────────────────────────────

/**
 * 容量预检（新 root chain 前执行；在任何原状态变化之前）：同 root 已存在
 * 不占新 slot；满载时先尝试终态压缩（lineageRetirementSummary 装配注入），
 * 仍满 → 拒绝（fail closed——不驱逐安全事实）。
 */
let terminalCompactor: (() => number) | null = null;

/** 装配注入（lineageRetirementSummary 模块加载时注册——单向依赖）。 */
export function registerTreasuryLineageCompactorForAssembly(compact: () => number): void {
  terminalCompactor = compact;
}

export function ensureTreasuryLineageSlotAvailable(rootTransactionId?: string): string | null {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return runtime.fatal;
  if (rootTransactionId !== undefined && runtime.rootIndex.has(rootTransactionId)) return null;
  if (runtime.store.entryCount < TREASURY_LINEAGE_MAX_ENTRIES) return null;
  const compacted = terminalCompactor !== null ? terminalCompactor() : 0;
  if (compacted > 0 && runtime.store.entryCount < TREASURY_LINEAGE_MAX_ENTRIES) return null;
  return `attempt lineage store 已达硬容量 ${String(TREASURY_LINEAGE_MAX_ENTRIES)}（fail closed——不驱逐安全事实；终态压缩后仍满）`;
}

// ── 写入（clone → 校验 → 转换 → 跨记录冲突预检 → 发布 → 完整 read-back） ──

export type TreasuryAttemptLineageWriteResult =
  | { readonly status: "written"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly status: "updated"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly status: "idempotent"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly status: "rejected"; readonly detail: string };

function writeLineageRecord(candidate: TreasuryAttemptLineageRecord): TreasuryAttemptLineageWriteResult {
  const shapeError = validateTreasuryAttemptLineageRecordShape(candidate);
  if (shapeError !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `拒绝写入非法 lineage record: ${shapeError}` };
  }
  const stateError = validateTreasuryAttemptLineageRecordState(candidate);
  if (stateError !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `拒绝写入语义非法 lineage record: ${stateError}` };
  }
  const runtime = loadLineageStoreRuntime(true);
  if (!runtime.published) publishLineageStoreToMemory(runtime);
  if (runtime.fatal !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: runtime.fatal };
  }
  // 写入目标 store 是 runtime.store（同一引用——fatal 为 null 时可信）。
  const store = runtime.store;
  const key = LINEAGE_KEY_PREFIX + candidate.rootTransactionId;
  const existing = Object.prototype.hasOwnProperty.call(store.entries, key) ? store.entries[key] : undefined;
  const transition = validateTreasuryAttemptLineageTransition(existing, candidate);
  if (transition.status === "rejected") {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `lineage 状态机拒绝: ${transition.detail}` };
  }
  if (transition.status === "idempotent") {
    return { status: "idempotent", record: freezeRecord(existing!) };
  }
  // 【24.6】跨记录索引唯一性预检：候选键与其它 record 冲突 → 原 store 不变。
  const others = Object.entries(store.entries)
    .filter(([otherKey]) => otherKey !== key)
    .map(([, record]) => record);
  const conflict = treasuryLineageCandidateConflictsWith(candidate, others);
  if (conflict !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: conflict };
  }
  if (existing === undefined) {
    // 新 root：占用新 slot——满载 fail closed（预检之外的双保险）。
    if (store.entryCount >= TREASURY_LINEAGE_MAX_ENTRIES) {
      lineageStoreEvents.writeFailures += 1;
      return {
        status: "rejected",
        detail: `attempt lineage store 已达硬容量 ${String(TREASURY_LINEAGE_MAX_ENTRIES)}（fail closed——不驱逐安全事实）`,
      };
    }
  }
  // 深拷贝发布（调用方输入与 Memory 无共享引用）。
  const previous = existing === undefined ? undefined : cloneTreasuryDurableValue(existing);
  const published = cloneTreasuryDurableValue(candidate);
  store.entries[key] = published;
  store.updatedAt = Game.time;
  // 【24.6】完整 read-back：与发布副本全字段一致 + 形状/语义/lineageId 重算。
  const readBack = store.entries[key];
  const readBackError =
    validateTreasuryAttemptLineageRecordShape(readBack) === null &&
    validateTreasuryAttemptLineageRecordState(readBack) === null &&
    JSON.stringify(readBack) === JSON.stringify(published)
      ? null
      : "lineage read-back 完整验证失败（全字段比较）";
  if (readBackError !== null) {
    if (previous === undefined) delete store.entries[key];
    else store.entries[key] = previous;
    store.updatedAt = Game.time;
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: readBackError };
  }
  if (existing === undefined) store.entryCount += 1;
  // 索引同步维护（写入与 read-back 已验证；此处任何跨记录覆盖都是致命——
  // 预检已排除，防御分支回滚 Memory 并标记 fatal）。
  const rollbackMemory = (): void => {
    if (previous === undefined) delete store.entries[key];
    else store.entries[key] = previous;
    if (existing === undefined) store.entryCount -= 1;
    store.updatedAt = Game.time;
  };
  try {
    if (existing !== undefined) {
      runtime.lineageIdIndex.delete(existing.lineageId);
      runtime.rootIndex.delete(existing.rootTransactionId);
      runtime.currentIndex.delete(existing.currentTransactionId);
      if (existing.nextChildTransactionId !== undefined) runtime.nextChildIndex.delete(existing.nextChildTransactionId);
      runtime.pendingIds.delete(existing.lineageId);
      runtime.terminalIds.delete(existing.lineageId);
    }
    const assertFree = (label: string, value: string | undefined, index: Map<string, string>): void => {
      if (value === undefined) return;
      const owner = index.get(value);
      if (owner !== undefined && owner !== key) {
        throw new Error(`索引同步冲突（${label} ${value.slice(0, 24)} 已属于 ${owner.slice(0, 24)}）`);
      }
    };
    assertFree("lineageId", readBack!.lineageId, runtime.lineageIdIndex);
    assertFree("root", readBack!.rootTransactionId, runtime.rootIndex);
    assertFree("current", readBack!.currentTransactionId, runtime.currentIndex);
    assertFree("next", readBack!.nextChildTransactionId, runtime.nextChildIndex);
    runtime.lineageIdIndex.set(readBack!.lineageId, key);
    runtime.rootIndex.set(readBack!.rootTransactionId, key);
    runtime.currentIndex.set(readBack!.currentTransactionId, key);
    if (readBack!.nextChildTransactionId !== undefined) runtime.nextChildIndex.set(readBack!.nextChildTransactionId, key);
    if (readBack!.state === "retiring" || readBack!.state === "capability_issued" || readBack!.state === "child_intent_pending" || readBack!.state === "child_active") {
      runtime.pendingIds.add(readBack!.lineageId);
    }
    if (readBack!.state === "chain_committed" || readBack!.state === "non_rearmable_retired") {
      runtime.terminalIds.add(readBack!.lineageId);
    }
  } catch (error) {
    rollbackMemory();
    runtime.fatal = `lineage 索引同步失败（已回滚 Memory）: ${String(error instanceof Error ? error.message : error).slice(0, 128)}`;
    lineageStoreEvents.indexCorruptions += 1;
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: runtime.fatal };
  }
  lineageStoreEvents.writes += 1;
  return {
    status: existing === undefined ? "written" : "updated",
    record: freezeRecord(readBack!),
  };
}

/** 新建 root chain 的 retiring record（publication 即创建——lineagePublished 起点 true）。 */
export function createTreasuryAttemptLineageRecord(input: {
  readonly rootTransactionId: string;
  readonly rootIdentity: TreasuryAttemptLineageIdentity;
  readonly actionKind: string;
  readonly authorityClass: TreasuryLineageAuthorityClass;
  readonly lowlevelSource?: string;
  readonly rearmable: boolean;
  readonly retrySemanticDigest?: string;
  readonly nonRearmReason?: string;
  readonly adapterSemanticIdentity?: string;
  readonly ownerIdentity?: string;
  /** 【第二十二轮】显式 profile（缺省从 root identity 事实推导——partial → 拒绝创建）。 */
  readonly identityProfile?: import("@/runtime/treasury/identityProfile").TreasuryIdentityProfile;
}): TreasuryAttemptLineageWriteResult {
  const slotError = ensureTreasuryLineageSlotAvailable(input.rootTransactionId);
  if (slotError !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: slotError };
  }
  // 统一从 retiring 开始（rearmable 与否）——retirement 三段完成后由
  // complete/backfill 推进到 rearm_ready 或 non_rearmable_retired 终态。
  // 创建即 publication（第十八轮 §5：candidate 持久化先于 authority release）。
  const now = Game.time;
  // 【第二十二轮 11.1】新权威记录必须携带显式 identity profile。
  const identityProfile = input.identityProfile ?? treasuryIdentityProfileOfFacts(input.rootIdentity);
  if (identityProfile === null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: "root identity 的 profile 推导失败（partial/矛盾字段——不创建 lineage）" };
  }
  return writeLineageRecord({
    identityProfile,
    lineageId: computeTreasuryAttemptLineageId(input.rootTransactionId, input.rootIdentity),
    rootTransactionId: input.rootTransactionId,
    rootIdentity: cloneTreasuryDurableValue(input.rootIdentity),
    currentTransactionId: input.rootTransactionId,
    currentIdentity: cloneTreasuryDurableValue(input.rootIdentity),
    actionKind: input.actionKind,
    ...(input.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: input.adapterSemanticIdentity } : {}),
    ...(input.ownerIdentity !== undefined ? { ownerIdentity: input.ownerIdentity } : {}),
    generation: 0,
    state: "retiring",
    resolutionState: "not_executed",
    ...(input.retrySemanticDigest !== undefined ? { retrySemanticDigest: input.retrySemanticDigest } : {}),
    authorityClass: input.authorityClass,
    ...(input.lowlevelSource !== undefined ? { lowlevelSource: input.lowlevelSource } : {}),
    rearmable: input.rearmable,
    ...(input.nonRearmReason !== undefined ? { nonRearmReason: input.nonRearmReason } : {}),
    retirement: { lineagePublished: true, authorityReleased: false, markerCleaned: false },
    retirementGeneration: 0,
    recordRevision: 0,
    createdAtTick: now,
    updatedAtTick: now,
  });
}

/**
 * 受控状态推进（capability 签发 / child 接管 / 终态 / 三段补完成的唯一
 * mutation 入口）：next 必须通过状态机与不可变事实校验。exact idempotent
 * （revision 一致 + 完整一致）合法返回；否则 revision 必须基于最新 +1。
 */
export function updateTreasuryAttemptLineageRecord(
  lineageId: string,
  mutate: (current: Readonly<TreasuryAttemptLineageRecord>) => TreasuryAttemptLineageRecord,
): TreasuryAttemptLineageWriteResult {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: runtime.fatal };
  }
  const existing = readTreasuryAttemptLineageRecord(lineageId);
  if (existing === undefined) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `lineage ${lineageId.slice(0, 16)} 不存在（不可凭空推进）` };
  }
  const next = mutate(existing);
  if (next.recordRevision !== existing.recordRevision + 1 && next.recordRevision !== existing.recordRevision) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: "mutation 必须基于最新 record 推进 recordRevision+1（或 exact idempotent）" };
  }
  return writeLineageRecord(next);
}

// ── 协议推进 helper（单一权威构造——facade / faultResolution / recovery 共用） ─

/** capability 签发推进：rearm_ready → capability_issued（handoff facts 冻结）。 */
export function stageTreasuryLineageCapabilityIssued(
  lineageId: string,
  childTransactionId: string,
): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    const expected = deriveTreasuryLineageNextChildTransactionId(current.lineageId, current.generation + 1, current.rootTransactionId);
    if (childTransactionId !== expected) {
      throw new Error(`child ID 与 lineage 派生不一致（期望 ${expected.slice(0, 24)}，实际 ${childTransactionId.slice(0, 24)}）`);
    }
    return {
      ...current,
      state: "capability_issued",
      nextChildTransactionId: childTransactionId,
      pendingBindingDigest: computeTreasuryLineageBindingDigest({
        lineageId: current.lineageId,
        generation: current.generation + 1,
        parentTransactionId: current.currentTransactionId,
        childTransactionId,
      }),
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/** handoff 推进：capability_issued → child_intent_pending（intent 写入前）。 */
export function stageTreasuryLineageChildIntentPending(
  lineageId: string,
  childTransactionId: string,
): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    if (current.nextChildTransactionId !== childTransactionId) {
      throw new Error(`child intent 阶段的 child ID 与冻结的 nextChild 不一致`);
    }
    return {
      ...current,
      state: "child_intent_pending",
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/** 回滚：capability_issued/child_intent_pending → rearm_ready（child facts 保留——同代重签）。 */
export function rollbackTreasuryLineageToRearmReady(lineageId: string): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    if (current.state !== "capability_issued" && current.state !== "child_intent_pending") {
      throw new Error(`回滚只允许 handoff 在途状态（got ${String(current.state)}）`);
    }
    return {
      ...current,
      state: "rearm_ready",
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/**
 * 接管推进（唯一允许 current/generation/binding 变化的转换）：child_intent_
 * pending → child_active。binding 取 pendingBinding；parent = 推进前 current；
 * retirement 三段按新 generation 复位（上一代完成标志不得沿用）。
 */
export function activateTreasuryLineageChild(
  lineageId: string,
  childIdentity: TreasuryAttemptLineageIdentity,
): TreasuryAttemptLineageWriteResult {
  // 【Remediation IV 十.4】child 接管前捕获 parent attempt ID——其 cleanup
  // completion proof 的回收在此完成。【Remediation VII 修复五.5】archive 前
  // 移：先完成 exact archive/read-back（GRA replacement 验证 → durable
  // historical authority 写入 read-back → 删除 read-back）再推进
  // child_active——失败结果不再被无条件 void 忽略，blocked（GRA 缺失/
  // exact 冲突/满载/损坏）→ 拒绝推进，lineage 保持 child_intent_pending
  //（可恢复重试——capability 尚未消费、同代 child 保留）；absent（parent
  // 无 completion——无事实可交接）与 interrupted（authority 已写、删除
  // 未确认——交接事实已建立）不阻塞推进。
  const parentAttemptId = readTreasuryAttemptLineageRecord(lineageId)?.currentTransactionId;
  if (parentAttemptId !== undefined) {
    const parentArchive = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: parentAttemptId, via: "gra-proof" });
    if (parentArchive.status === "blocked") {
      return {
        status: "rejected",
        detail: `parent completion 归档失败（${parentArchive.reason}）: ${parentArchive.detail}——child_active 不推进（lineage 保持 child_intent_pending，可恢复重试）`,
      };
    }
  }
  const result = updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    if (current.state !== "child_intent_pending") {
      throw new Error(`child 接管只允许从 child_intent_pending（got ${String(current.state)}）`);
    }
    const parentTransactionId = current.currentTransactionId;
    const childTransactionId = current.nextChildTransactionId!;
    const { nextChildTransactionId: _consumedChild, pendingBindingDigest: _consumedBinding, ...rest } = current;
    void _consumedChild;
    void _consumedBinding;
    return {
      ...rest,
      state: "child_active",
      currentTransactionId: childTransactionId,
      currentIdentity: cloneTreasuryDurableValue(childIdentity),
      currentParentTransactionId: parentTransactionId,
      generation: current.generation + 1,
      resolutionState: "unresolved",
      bindingDigest: current.pendingBindingDigest,
      retirement: { lineagePublished: false, authorityReleased: false, markerCleaned: false },
      retirementGeneration: current.generation + 1,
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
  return result;
}

/** child 退休推进：child_active → retiring（当前代 not-executed publication）。 */
export function retireTreasuryLineageCurrentAttempt(input: {
  readonly lineageId: string;
  readonly retrySemanticDigest?: string;
  readonly rearmable?: boolean;
  readonly nonRearmReason?: string;
}): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(input.lineageId, (current) => {
    if (current.state !== "child_active") {
      throw new Error(`child 退休只允许从 child_active（got ${String(current.state)}）`);
    }
    const { nextChildTransactionId: _stale, pendingBindingDigest: _staleBinding, ...rest } = current;
    void _stale;
    void _staleBinding;
    const rearmable = input.rearmable !== undefined ? input.rearmable && current.rearmable : current.rearmable;
    return {
      ...rest,
      state: "retiring",
      resolutionState: "not_executed" as const,
      ...(input.retrySemanticDigest !== undefined && current.retrySemanticDigest === undefined
        ? { retrySemanticDigest: input.retrySemanticDigest }
        : {}),
      rearmable,
      ...(rearmable && current.rearmable
        ? {}
        : { nonRearmReason: input.nonRearmReason ?? current.nonRearmReason ?? "non-rearmable" }),
      retirement: { lineagePublished: true, authorityReleased: false, markerCleaned: false },
      retirementGeneration: current.generation,
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/**
 * 【第十九轮 C.1】retirement 阶段分别推进（单调 false→true）。调用方必须
 * **先完成对应持久证明**——本 helper 只记录已证明事实，绝不自行推断：
 * - authorityReleased：统一 resolver 明确返回 not_found（或等价受控 release
 *   结果）之后；
 * - markerCleaned：class-aware marker 证明（marker 不存在 / 不指向本
 *   attempt / 匹配 marker 已成功清除）之后。
 * publication 不经本 helper（retire 转换的 candidate 持久化 + read-back 内置）。
 */
export function markTreasuryLineageRetirementStageVerified(
  lineageId: string,
  stage: "authorityReleased" | "markerCleaned",
): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    if (current.state !== "retiring") {
      throw new Error(`retirement 阶段推进只允许从 retiring（got ${String(current.state)}）`);
    }
    if (current.retirement[stage]) {
      // 已证明的阶段幂等重入——零写入（不烧 revision）。
      return current;
    }
    return {
      ...current,
      retirement: { ...current.retirement, [stage]: true },
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/**
 * retirement 完成推进（retiring → rearm_ready / non_rearmable_retired）。
 * 【第十九轮 C.1】本函数**不再无条件置三段全 true**——只推进 state，且要求
 * 三段已分别由对应持久证明推进（publication: retire 转换内置；release/
 * marker: markTreasuryLineageRetirementStageVerified）。未全部证明 → 拒绝
 * （保持 retiring——cleanup/release pending，不进 rearm_ready、无 eviction
 * 资格）。
 */
export function completeTreasuryLineageRetirement(lineageId: string): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    if (current.state !== "retiring") {
      throw new Error(`retirement 完成只允许从 retiring（got ${String(current.state)}）`);
    }
    if (!current.retirement.lineagePublished || !current.retirement.authorityReleased || !current.retirement.markerCleaned) {
      throw new Error(
        `retirement 三段未全部证明（publication=${String(current.retirement.lineagePublished)}，release=${String(current.retirement.authorityReleased)}，marker=${String(current.retirement.markerCleaned)}）——保持 retiring（阶段分别证明后才可完成）`,
      );
    }
    return {
      ...current,
      state: current.rearmable ? "rearm_ready" : "non_rearmable_retired",
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/**
 * 【第十九轮 C.7】从持久事实收敛 retirement 三段并完成——facade 运行时路径
 * 与 beginTick 恢复共用的单一权威（不在各调用方实现近似算法）：
 * - authorityReleased：统一 resolver 返回 not_found 才推进（ok/inconsistent/
 *   store_unhealthy 都保持 pending——不可判定绝不猜测）；
 * - markerCleaned：marker 不存在或 transactionId 不指向本 attempt 才推进
 *   （marker 指向本 attempt 时——匹配未清或 digest/binding 冲突——一律
 *   cleanup pending，不得进入 rearm_ready）；
 * - 三段全 true 才 complete；否则保持 retiring（返回 pending 与未证明阶段）。
 */
export function convergeTreasuryLineageRetirementFromFacts(lineageId: string): {
  readonly status: "completed" | "pending" | "rejected";
  readonly pendingStages?: readonly string[];
  readonly detail?: string;
} {
  const record = readTreasuryAttemptLineageRecord(lineageId);
  if (record === undefined) {
    return { status: "rejected", detail: `lineage ${lineageId.slice(0, 16)} 不存在` };
  }
  if (record.state !== "retiring") {
    return { status: "rejected", detail: `retirement 收敛只允许 retiring（got ${String(record.state)}）` };
  }
  const pendingStages: string[] = [];
  if (!record.retirement.authorityReleased) {
    const authorityResolution = resolveTreasuryUnresolvedAuthority(record.currentTransactionId);
    if (authorityResolution.status === "not_found") {
      const marked = markTreasuryLineageRetirementStageVerified(lineageId, "authorityReleased");
      if (marked.status === "rejected") {
        return { status: "pending", pendingStages: ["authorityReleased"], detail: marked.detail };
      }
    } else {
      pendingStages.push("authorityReleased");
    }
  }
  if (!record.retirement.markerCleaned) {
    const marker = readLineageRecoveryMarker();
    if (marker === undefined || marker.transactionId !== record.currentTransactionId) {
      const marked = markTreasuryLineageRetirementStageVerified(lineageId, "markerCleaned");
      if (marked.status === "rejected") {
        return { status: "pending", pendingStages: ["markerCleaned"], detail: marked.detail };
      }
    } else {
      // marker 指向本 attempt：匹配未清（等待 recoverStagedResolutions 的
      // class-aware 清除）或 digest 冲突（不可证明清除）都保持 pending。
      pendingStages.push("markerCleaned");
    }
  }
  if (pendingStages.length > 0) {
    return { status: "pending", pendingStages };
  }
  const fresh = readTreasuryAttemptLineageRecord(lineageId);
  if (fresh === undefined || fresh.state !== "retiring") {
    return { status: "rejected", detail: "收敛过程中 record 消失或状态变化" };
  }
  if (!fresh.retirement.lineagePublished) {
    return { status: "pending", pendingStages: ["lineagePublished"] };
  }
  // 【第二十轮 10.1/10.3】exact per-generation retirement proof：三段收敛
  // 完成后、状态推进（rearm_ready / non_rearmable_retired——下一代 capability
  // 的前置）之前写入 + read-back 验证。写入失败（容量满载/冲突/损坏）→
  // 保持 retiring（fail closed——不签发下一代、无 eviction 资格）。幂等
  // 重入（中断窗口：proof 已写、状态未推进）不烧容量。
  if (fresh.generation >= 1 && (fresh.currentParentTransactionId === undefined || fresh.bindingDigest === undefined)) {
    return {
      status: "pending",
      pendingStages: ["exact_retirement_proof"],
      detail: "generation≥1 的 retiring record 缺 parent/binding（无法构造 exact retirement proof——防御）",
    };
  }
  // 【第二十二轮 11.1】新写 proof 必须携带显式 identity profile（字段推导；
  // partial/矛盾 → 构造失败保持 pending——不写不完整 proof）。
  const exactProofProfile = treasuryIdentityProfileOfFacts({
    digest: fresh.currentIdentity.digest,
    ...(fresh.currentIdentity.contractDigest !== undefined ? { contractDigest: fresh.currentIdentity.contractDigest } : {}),
    ...(fresh.currentIdentity.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fresh.currentIdentity.authorizationCohortDigest } : {}),
    ...(fresh.currentIdentity.durableIdentityDigest !== undefined ? { durableIdentityDigest: fresh.currentIdentity.durableIdentityDigest } : {}),
    ...((fresh.currentIdentity.lowlevelSource ?? fresh.lowlevelSource) !== undefined ? { lowlevelSource: fresh.currentIdentity.lowlevelSource ?? fresh.lowlevelSource } : {}),
  });
  if (exactProofProfile === null) {
    return { status: "pending", pendingStages: ["exact_retirement_proof"], detail: "exact retirement proof 的 identity profile 推导失败（partial/矛盾字段——fail closed 不写入）" };
  }
  const exactProofInput = {
    schemaVersion: 2 as const,
    identityProfile: exactProofProfile,
    lineageId: fresh.lineageId,
    rootTransactionId: fresh.rootTransactionId,
    rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(fresh.rootIdentity),
    generation: fresh.generation,
    transactionId: fresh.currentTransactionId,
    ...(fresh.generation >= 1 ? { parentTransactionId: fresh.currentParentTransactionId!, bindingDigest: fresh.bindingDigest! } : {}),
    digest: fresh.currentIdentity.digest,
    ...(fresh.currentIdentity.contractDigest !== undefined ? { contractDigest: fresh.currentIdentity.contractDigest } : {}),
    ...(fresh.currentIdentity.authorizationCohortDigest !== undefined
      ? { authorizationCohortDigest: fresh.currentIdentity.authorizationCohortDigest }
      : {}),
    ...(fresh.currentIdentity.durableIdentityDigest !== undefined ? { durableIdentityDigest: fresh.currentIdentity.durableIdentityDigest } : {}),
    // lowlevel provenance：identity 维度优先，缺省回落 record 顶层冻结字段
    //（低层 root/identity 视图未携带 provenance 时 record.lowlevelSource 是权威）。
    ...((fresh.currentIdentity.lowlevelSource ?? fresh.lowlevelSource) !== undefined
      ? { lowlevelSource: fresh.currentIdentity.lowlevelSource ?? fresh.lowlevelSource }
      : {}),
    authorityClass: fresh.authorityClass,
    ...(fresh.retrySemanticDigest !== undefined ? { retrySemanticDigest: fresh.retrySemanticDigest } : {}),
    resolution: "not_executed" as const,
    retirement: { lineagePublished: true as const, authorityReleased: true as const, markerCleaned: true as const },
    completedAtTick: Game.time,
  };
  const exactPersisted = persistTreasuryGenerationRetirementProof(exactProofInput);
  if (exactPersisted.status === "rejected") {
    return { status: "pending", pendingStages: ["exact_retirement_proof"], detail: exactPersisted.detail };
  }
  const completed = completeTreasuryLineageRetirement(lineageId);
  if (completed.status === "rejected") {
    return { status: "pending", pendingStages: ["complete"], detail: completed.detail };
  }
  lineageStoreEvents.retirementCompletions += 1;
  return { status: "completed" };
}

/** child commit 终态推进：child_active → chain_committed。 */
export function closeTreasuryLineageAsChainCommitted(lineageId: string): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    if (current.state !== "child_active") {
      throw new Error(`chain_committed 只允许从 child_active（got ${String(current.state)}）`);
    }
    return {
      ...current,
      state: "chain_committed",
      resolutionState: "committed",
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

/** forensic 隔离（任意状态进入；child facts 清除、non-rearmable）。 */
export function isolateTreasuryLineageForensically(lineageId: string, reason: string): TreasuryAttemptLineageWriteResult {
  return updateTreasuryAttemptLineageRecord(lineageId, (current) => {
    const { nextChildTransactionId: _stale, pendingBindingDigest: _staleBinding, ...rest } = current;
    void _stale;
    void _staleBinding;
    return {
      ...rest,
      state: "forensic_isolated",
      rearmable: false,
      nonRearmReason: reason.slice(0, NON_REARM_REASON_MAX),
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    };
  });
}

// ── 终态压缩支持（lineageRetirementSummary 编排；本模块只提供受控删除） ────

/** 终态压缩候选清单（O(terminal) ≤ 容量上界；空闲零成本）。 */
export function listTreasuryTerminalLineageIds(): readonly string[] {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return [];
  return [...runtime.terminalIds];
}

/**
 * 受控删除（仅 lineageRetirementSummary 压缩编排调用）：record 必须处于终态
 * 且 summary 已写入并 read-back（调用方保证）——删除后同步全部索引。
 */
export function removeTreasuryAttemptLineageRecordForCompaction(lineageId: string): { readonly status: "removed" } | { readonly status: "rejected"; readonly detail: string } {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return { status: "rejected", detail: runtime.fatal };
  const key = runtime.lineageIdIndex.get(lineageId);
  if (key === undefined) return { status: "rejected", detail: `lineage ${lineageId.slice(0, 16)} 不存在` };
  const record = runtime.store.entries[key];
  if (record === undefined) return { status: "rejected", detail: "索引与 entries 不一致（拒绝压缩）" };
  if (record.state !== "chain_committed" && record.state !== "non_rearmable_retired") {
    return { status: "rejected", detail: `非终态 record 不得压缩（state ${String(record.state)}）` };
  }
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  runtime.lineageIdIndex.delete(record.lineageId);
  runtime.rootIndex.delete(record.rootTransactionId);
  runtime.currentIndex.delete(record.currentTransactionId);
  if (record.nextChildTransactionId !== undefined) runtime.nextChildIndex.delete(record.nextChildTransactionId);
  runtime.pendingIds.delete(record.lineageId);
  runtime.terminalIds.delete(record.lineageId);
  return { status: "removed" };
}

// ── beginTick 恢复 ──────────────────────────────────────────────────────────

export interface TreasuryLineageRecoveryResult {
  readonly skipped: string | null;
  readonly capabilityExpiries: number;
  readonly childIntentRollbacks: number;
  readonly childIntentForensics: number;
  readonly childActivationForwardCompletions: number;
  readonly chainCommitCompletions: number;
  readonly retirementCompletions: number;
  readonly backfills: number;
}

/**
 * 单个 child_intent_pending 窗口的恢复动作（beginTick handoff 判定与主
 * lineage recovery 共用——【第二十轮 7.1】双 authority 判定先于普通 Intent
 * recovery 执行；主 recovery 对同一 record 的重入幂等：转换后的 state 不再
 * 命中 child_intent_pending 分支）。
 */
function recoverPendingHandoffWindow(
  lineageId: string,
  record: Readonly<TreasuryAttemptLineageRecord>,
  result: TreasuryLineageRecoveryResult,
): TreasuryLineageRecoveryResult {
  const childId = record.nextChildTransactionId!;
  // 【第二十轮 7.2】handoff 恢复直接复用 unified unresolved authority
  // resolver 的完整一致性（identity 重算/等级/proof class/lowlevel/
  // digest/contract/cohort/durable/postings/kind/lineage/execution-fact
  // cohesion）+ semantic lineage validation——不再自行比较 lineage 外壳。
  const window = classifyTreasuryHandoffAuthorityWindow({
    record,
    childTransactionId: childId,
    authorityResolution: resolveTreasuryUnresolvedAuthority(childId),
  });
  if (window.action === "forensic") {
    const isolated = isolateTreasuryLineageForensically(lineageId, window.detail);
    if (isolated.status !== "rejected") {
      lineageStoreEvents.childIntentForensics += 1;
      return { ...result, childIntentForensics: result.childIntentForensics + 1 };
    }
    return result;
  }
  if (window.action === "pending_store_unhealthy") {
    // 保留两侧证据（intent + quarantine + record 原样），不 rollback、
    // 不 forward——store 损坏绝不解释为 authority absent。
    return result;
  }
  if (window.action === "rollback") {
    if (window.releaseIntent) releaseTreasuryIntentEntry(childId);
    const rolled = rollbackTreasuryLineageToRearmReady(lineageId);
    if (rolled.status !== "rejected") {
      lineageStoreEvents.childIntentRollbacks += 1;
      return { ...result, childIntentRollbacks: result.childIntentRollbacks + 1 };
    }
    return result;
  }
  // forward_complete：child identity 从统一 resolver 结果构造（不从任意
  // 一侧挑字段——resolver 已完成完整一致性归一）。
  const activated = activateTreasuryLineageChild(lineageId, window.childIdentity);
  if (activated.status !== "rejected") {
    lineageStoreEvents.childActivationForwardCompletions += 1;
    // 【第二十二轮第十三节】advance 后的上一代孤儿 proof 有界清理。
    sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, activated.record.generation - 1);
    return { ...result, childActivationForwardCompletions: result.childActivationForwardCompletions + 1 };
  }
  return result;
}

/**
 * 【第二十轮 7.1】beginTick 的 handoff 双 authority 证据保留顺序：本函数
 * 必须先于 recoverTreasuryIntentsAtTickBoundary（普通 Intent recovery/
 * cleanup）执行——child_intent_pending 的 Intent 与 Quarantine 完整一致性
 * 判定（含 rollback 的 intent 释放、forward 的接管、forensic 隔离）先于
 * 任何通用 ready-intent 删除，双 authority 冲突证据不会被提前清除。只
 * 处理 pending handoff（不扫描全部 Intent/Quarantine——O(pending)）。
 */
export function recoverTreasuryLineageHandoffEvidenceAtTickBoundary(): TreasuryLineageRecoveryResult {
  const empty: TreasuryLineageRecoveryResult = {
    skipped: null,
    capabilityExpiries: 0,
    childIntentRollbacks: 0,
    childIntentForensics: 0,
    childActivationForwardCompletions: 0,
    chainCommitCompletions: 0,
    retirementCompletions: 0,
    backfills: 0,
  };
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return { ...empty, skipped: runtime.fatal };
  if (runtime.pendingIds.size === 0) {
    lineageStoreEvents.idleFastPath += 1;
    return empty;
  }
  let result: TreasuryLineageRecoveryResult = empty;
  for (const lineageId of [...runtime.pendingIds]) {
    const record = readTreasuryAttemptLineageRecord(lineageId);
    if (record === undefined) continue;
    if (record.state !== "child_intent_pending") continue;
    result = recoverPendingHandoffWindow(lineageId, record, result);
  }
  return result;
}

/**
 * 【第十八轮 24.2/24.3】beginTick lineage 恢复（挂 facade performBeginTick，
 * 位于 intent recovery 与 recoverStagedResolutions 之后）：
 * - capability_issued：heap capability 已失效 → 回退 rearm_ready（child facts
 *   保留——同代 child ID 确定性不变，可重签）；
 * - child_intent_pending：intent 缺失 → 回滚；一致 not_started/ready → 释放
 *   intent 并回滚（正常窗口不 forensic）；binding/generation/child 冲突 →
 *   forensic；intent 已 executing/更后或已转 quarantine（proof 匹配）→ 前向
 *   补完成 child_active（callback 可能已开始，不得回滚为未执行）；
 * - child_active：当前代 committed receipt 匹配（binding/generation）→ 补完成
 *   chain_committed 并释放遗留 intent；final not-executed tombstone 且 authority
 *   已清 → 防御性完成 retirement；
 * - retiring：三段按最终持久事实收敛（release/marker 实际动作由
 *   recoverStagedResolutions / resolver 承担）；
 * - pendingRelease 索引中无 lineage record 的 final not-executed tombstone：
 *   backfill（Round 16 遗留）。
 * 空闲（pendingIds 与 pendingRelease 索引均空）→ O(1) 快路径，不扫描 entries。
 */
export function recoverTreasuryAttemptLineageAtTickBoundary(pendingReleaseSnapshot?: readonly string[]): TreasuryLineageRecoveryResult {
  const empty: TreasuryLineageRecoveryResult = {
    skipped: null,
    capabilityExpiries: 0,
    childIntentRollbacks: 0,
    childIntentForensics: 0,
    childActivationForwardCompletions: 0,
    chainCommitCompletions: 0,
    retirementCompletions: 0,
    backfills: 0,
  };
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return { ...empty, skipped: runtime.fatal };
  const pendingReleaseIds = pendingReleaseSnapshot ?? listTreasuryPendingReleaseIds();
  if (runtime.pendingIds.size === 0 && pendingReleaseIds.length === 0) {
    lineageStoreEvents.idleFastPath += 1;
    return empty;
  }
  let result: TreasuryLineageRecoveryResult = empty;
  const recordOf = (lineageId: string): Readonly<TreasuryAttemptLineageRecord> | undefined => {
    const record = readTreasuryAttemptLineageRecord(lineageId);
    if (record === undefined) {
      // 索引项失效（Memory 已无该 record）——索引只是定位器，清理。
      runtime.pendingIds.delete(lineageId);
      runtime.terminalIds.delete(lineageId);
      lineageStoreEvents.indexCorruptions += 1;
    }
    return record;
  };
  for (const lineageId of [...runtime.pendingIds]) {
    const record = recordOf(lineageId);
    if (record === undefined) continue;
    if (record.state === "capability_issued") {
      const rolled = rollbackTreasuryLineageToRearmReady(lineageId);
      if (rolled.status !== "rejected") {
        lineageStoreEvents.capabilityExpiries += 1;
        result = { ...result, capabilityExpiries: result.capabilityExpiries + 1 };
      }
      continue;
    }
    if (record.state === "child_intent_pending") {
      // 【第二十轮 7.1】主 recovery 重入同一 handoff 判定（beginTick 前置的
      // recoverTreasuryLineageHandoffEvidenceAtTickBoundary 已处理过的 record
      // 状态已转换——此处只覆盖 store_unhealthy 保留的重入，幂等）。
      result = recoverPendingHandoffWindow(lineageId, record, result);
      continue;
    }
    if (record.state === "child_active") {
      // 【第二十二轮 13.2】advance 后中断的孤儿 proof 补清理（确定性检查
      // generation-1——幂等，不依赖 heap 列表）。
      if (record.generation >= 1) {
        sweepTreasuryOrphanGenerationProofOnAdvance(record.lineageId, record.generation - 1);
      }
      // 【第二十一轮 8】commit-pending 补完成的单一 verifier：完整 Receipt
      // exact proof（digest/contract/cohort/durable/proof class/lowlevel
      // provenance/lineage 四字段）与 record current exact identity 匹配才
      // 允许关闭 lineage——binding+generation 快捷放行已删除（轻量字段不再
      // 单独构成关闭依据）。状态变化顺序（8.2）：close chain_committed →
      // 释放残留 Intent（close 失败时 Intent 与 child_active 事实保留，
      // Receipt 作为持久 commit proof，beginTick 幂等重试）。
      const receiptProof = lineageReceiptProofReader(record.currentTransactionId);
      if (receiptProof !== undefined) {
        const recovery = verifyTreasuryChildActiveCommitRecovery({ record, receiptProof });
        if (recovery.status === "verified") {
          // 【第二十二轮 9.4】child-active 关闭必须经 cross-store settlement
          // coordinator：Receipt 单条 exact match 之外统一检查 Intent/Quarantine
          // 结论、Resolution tombstone、相反 not-executed proof（GRA）、marker
          // 归属与各 store health——任一冲突/不健康不关闭 lineage。
          const currentExact = expectedTreasuryCurrentLineageExactIdentity(record);
          const settlement = currentExact === null ? null : verifyTreasuryCurrentSettlement({
            outcome: "committed",
            attempt: currentExact,
            identityProfile: treasuryIdentityProfileOfFacts(record.currentIdentity) ?? "legacy-replay",
            lineageProof: {
              lineageId: record.lineageId,
              lineageGeneration: record.generation,
              parentTransactionId: record.currentParentTransactionId!,
              lineageBindingDigest: record.bindingDigest!,
            },
            identityFacts: record.currentIdentity,
          });
          if (settlement !== null && settlement.verdict === "committed_verified") {
            const closed = closeTreasuryLineageAsChainCommitted(lineageId);
            if (closed.status !== "rejected") {
              if (readTreasuryIntentEntry(record.currentTransactionId) !== undefined) {
                releaseTreasuryIntentEntry(record.currentTransactionId);
              }
              lineageStoreEvents.chainCommitCompletions += 1;
              result = { ...result, chainCommitCompletions: result.chainCommitCompletions + 1 };
            }
            continue;
          }
          if (settlement !== null && settlement.verdict === "conflict") {
            lineageStoreEvents.childCommitProofConflicts += 1;
          }
          // insufficient / store_unhealthy：cross-store 前置未满足——child_active、
          // Intent 与 Receipt 证据保留（beginTick 幂等重试）。
          continue;
        }
        if (recovery.status === "conflict") {
          lineageStoreEvents.childCommitProofConflicts += 1;
        }
        // conflict / insufficient / legacy：child_active、Intent 与 Receipt
        // 证据全部保留（不自动升级、不猜测），fallthrough 到防御性 retirement
        // 收敛检查（committed receipt 冲突时 not-executed 分支不会命中——
        // tombstone/authority 条件不满足，保持现状）。
      }
      // 防御性 retirement 收敛：final not-executed tombstone + authority 已清。
      // 【第十九轮 C.6】与运行时路径执行同样的 marker 证明——经 retire 转换
      //（publication 内置）+ converge 分别证明 release/marker（marker 指向本
      // attempt 时保持 cleanup pending，不进 rearm_ready）。
      const tombstone = readTreasuryResolutionTombstone(record.currentTransactionId);
      if (
        tombstone !== undefined &&
        tombstone.stage === "final" &&
        tombstone.resolution === "not-executed" &&
        resolveTreasuryUnresolvedAuthority(record.currentTransactionId).status === "not_found" &&
        record.retirementGeneration === record.generation
      ) {
        const retired = retireTreasuryLineageCurrentAttempt({ lineageId });
        if (retired.status !== "rejected") {
          const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
          if (converged.status === "completed") {
            result = { ...result, retirementCompletions: result.retirementCompletions + 1 };
          }
        }
      }
      continue;
    }
    if (record.state === "retiring") {
      // 【第十九轮 C.7】三段按持久事实收敛（release/marker 的实际补动作由
      // recoverStagedResolutions 完成——顺序在前；本处只按最终持久事实推进
      // 阶段与状态，与运行时路径共用同一 converge）。
      const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
      if (converged.status === "completed") {
        result = { ...result, retirementCompletions: result.retirementCompletions + 1 };
      }
      continue;
    }
  }
  // pendingRelease 索引中无 lineage record 的 final not-executed（Round 16
  // 遗留 / lineage 写失败中断）——backfill。
  for (const transactionId of pendingReleaseIds) {
    const existing = lookupTreasuryAttemptLineageByAttemptId(transactionId);
    if (existing !== undefined) continue;
    const tombstone = readTreasuryResolutionTombstone(transactionId);
    if (tombstone === undefined || tombstone.stage !== "final" || tombstone.resolution !== "not-executed") continue;
    const backfilled = backfillLineageFromTombstone(transactionId, tombstone);
    if (backfilled) {
      lineageStoreEvents.backfills += 1;
      result = { ...result, backfills: result.backfills + 1 };
    }
  }
  return result;
}

// committed receipt 完整 proof 只读视图（facade 装配注入——保持模块单向依赖）。
// 【第二十一轮 8.1】reader 返回完整 settlement proof 视图（不再只透传
// binding/generation——child-active 补完成按完整 exact proof 验证）。
export interface TreasuryLineageReceiptProofView {
  readonly level?: string;
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

let lineageReceiptProofReader: (transactionId: string) => TreasuryLineageReceiptProofView | undefined = () => undefined;

/** facade 装配时注入 receipt settlement proof 的完整只读视图。 */
export function setTreasuryLineageReceiptReaderForAssembly(
  reader: (transactionId: string) => TreasuryLineageReceiptProofView | undefined,
): void {
  lineageReceiptProofReader = reader;
}

/** 恢复路径的 marker 只读完整视图（【第二十二轮第十二节】backfill/converge 的
 * marker 判定需要 class-aware 维度——facade 透传 write-fault 快照全字段）。 */
export interface TreasuryLineageRecoveryMarkerView {
  readonly transactionId: string;
  readonly digest: string;
  readonly markerProtocol?: number;
  readonly markerVersion?: number;
  readonly identityProfile?: string;
  readonly authorityClass?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly attemptGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
  readonly attemptIdentity?: { readonly contractDigest?: string; readonly authorizationCohortDigest?: string; readonly durableIdentityDigest?: string };
}

let lineageRecoveryMarkerReader: () => TreasuryLineageRecoveryMarkerView | undefined = () => undefined;

/** facade 装配时注入 marker 读取（保持模块单向依赖：writeFault → 不 import 本模块）。 */
export function setTreasuryLineageRecoveryMarkerReaderForAssembly(
  reader: () => TreasuryLineageRecoveryMarkerView | undefined,
): void {
  lineageRecoveryMarkerReader = reader;
}

function readLineageRecoveryMarker(): TreasuryLineageRecoveryMarkerView | undefined {
  return lineageRecoveryMarkerReader();
}

/**
 * Round 16 旧 final not-executed tombstone 的 backfill（Round 17 语义保留）：
 * backfill 统一 non-rearmable retired（tombstone 自身不携带 action retry 语义，
 * prevalidate 上下文缺失——不猜测）；identity partial 或矛盾 → forensic；
 * 容量不足 → 不写（tombstone 保持 pin，fail closed）。
 */
function backfillLineageFromTombstone(
  transactionId: string,
  tombstone: Readonly<{ transactionId: string; digest: string; proofLevel: string; contractDigest?: string; authorizationCohortDigest?: string; durableIdentityDigest?: string; lowlevelSource?: string }>,
): boolean {
  const authorityClass: TreasuryLineageAuthorityClass =
    tombstone.proofLevel === "lowlevel" ? "lowlevel" : "identity-bound";
  const identity: TreasuryAttemptLineageIdentity = {
    digest: tombstone.digest,
    ...(tombstone.contractDigest !== undefined ? { contractDigest: tombstone.contractDigest } : {}),
    ...(tombstone.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: tombstone.authorizationCohortDigest } : {}),
    ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
    ...(tombstone.proofLevel === "lowlevel" && tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
  };
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: identity,
    actionKind: `backfilled:${String(tombstone.proofLevel)}`,
    authorityClass,
    ...(tombstone.proofLevel === "lowlevel" && tombstone.lowlevelSource !== undefined
      ? { lowlevelSource: tombstone.lowlevelSource }
      : {}),
    rearmable: false,
    nonRearmReason: "Round16 backfill：只有 attempt proof、缺少 action retry 语义（non-rearmable retired）",
  });
  if (created.status === "rejected") return false;
  // backfill record 直接落终态（retirement 视 authority/marker 终态收敛——
  // recoverStagedResolutions 已先行补完成释放与清 marker）。
  const record = created.record;
  const authorityResolution = resolveTreasuryUnresolvedAuthority(transactionId);
  // 【第二十二轮第十二节】marker 判定改用统一 marker exact relation——
  // 删除 backfill 自定义 boolean（旧逻辑把同 transaction digest 冲突误判为
  // cleaned）：unrelated/absent 才算当前 attempt 已解除；match（未清）/conflict/
  // insufficient 均保持 markerCleaned=false（终态不推进、tombstone 继续 pin）。
  const marker = readLineageRecoveryMarker();
  let markerCleaned: boolean;
  if (marker === undefined) {
    markerCleaned = true;
  } else {
    const relation = treasuryMarkerExactIdentityRelation(
      treasuryMarkerDischargeExpectedOfFacts({
        transactionId,
        digest: tombstone.digest,
        proofClass: tombstone.proofLevel,
        ...(tombstone.contractDigest !== undefined ? { contractDigest: tombstone.contractDigest } : {}),
        ...(tombstone.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: tombstone.authorizationCohortDigest } : {}),
        ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
        ...(tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
      }),
      marker,
    );
    markerCleaned = relation.kind === "unrelated";
  }
  const authorityReleased = authorityResolution.status === "not_found";
  const threeComplete = authorityReleased && markerCleaned;
  const completed = updateTreasuryAttemptLineageRecord(record.lineageId, (current) => ({
    ...current,
    state: threeComplete ? "non_rearmable_retired" : current.state,
    retirement: { lineagePublished: true, authorityReleased, markerCleaned },
    updatedAtTick: Game.time,
    recordRevision: current.recordRevision + 1,
  }));
  return completed.status !== "rejected";
}

// 【Remediation VIII 工作流 D6】owner truth graph 的 lineage 维度注入
//（cleanupCompletionHandoff 不得反向 import 本模块——TDZ 环规避；本模块
// 加载晚于 resolutionStore 的占位注册，此处覆盖为完整 probes）。
import { registerTreasuryLifecycleLineageProbeForAssembly as __registerLifecycleLineageProbe } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
__registerLifecycleLineageProbe({
  lineageOf: (transactionId) => lookupTreasuryAttemptLineageByAttemptId(transactionId) as unknown as { readonly state?: unknown } | undefined,
  lineageStoreHealthy: () => peekTreasuryAttemptLineageHealth().healthy,
});

// 【X 工作流 F / G7】GRA 满载驱逐的 lineage 依赖 probe（exact consumer 仍在
// active lineage 时不得驱逐 proof；GRA ↔ attemptLineage 模块环——底部注册）。
import { registerTreasuryGenerationLineageProbeForAssembly as __registerGenerationLineageProbe } from "@/runtime/treasury/generationRetirementAuthority";
__registerGenerationLineageProbe({
  lineageOf: (transactionId) => lookupTreasuryAttemptLineageByAttemptId(transactionId) as unknown as { readonly state?: unknown } | undefined,
  lineageStoreHealthy: () => peekTreasuryAttemptLineageHealth().healthy,
});
