/**
 * 【Round 22 Remediation IV 十】cleanup completion authority——journal entry
 * 删除后的持久完成事实（有界、exact、可 read-back）。
 *
 * Remediation III 之前 journal entry 删除后没有任何持久事实区分"合法完成"
 * 与"意外缺失"：coordinator 发现 journal 不存在即解释为 completed——
 * journal 从未创建 / 被错误删除 / Memory 损坏丢失 entry 全部无法与合法完成
 * 区分。
 *
 * 本模块是独立有界 completion store（Memory.runtime.treasury.
 * cleanupCompletions）：每个完成 attempt 写入一份 completion proof（完整
 * exact identity + 五阶段事实 + 完成tick），journal 删除前写入并 read-back；
 * journal 不存在时以 completion authority 区分 completed（match）/
 * no_cleanup_authority（absent——不得折叠为 completed）/ conflict（身份
 * 冲突 fail closed）。
 *
 * 写入顺序由 completeTreasuryCleanupAcknowledged 承载：
 *   全部 journal 阶段 ack → completion 写入 + read-back → 删除 journal →
 *   journal 删除 read-back → fully complete。
 *
 * 容量与 retention：硬容量 128 满载 fail closed（不驱逐——journal 保留、
 * 完成路径 pending 重试）；同 transactionId 幂等要求完整 exact identity
 * 一致（不覆盖旧 proof）；terminal lineage summary 是更高层的 chain 级
 * 权威（压缩后由 summary 持续证明终态），completion proof 只承担单
 * attempt cleanup 完成事实——容量回收跟随 summary 压缩（retired chain 的
 * completion 不再被查询：journal 已删、resolutionStore pending 索引已移除）。
 */

import { registerTreasuryResolutionCleanupResetHook } from "@/runtime/treasury/receipts";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import {
  TREASURY_IDENTITY_PROFILES,
  treasuryProofClassOfIdentityProfile,
  validateTreasuryIdentityProfileFacts,
  type TreasuryIdentityProfile,
} from "@/runtime/treasury/identityProfile";
import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";
import type { TreasuryResolutionCleanupEntry } from "@/runtime/treasury/resolutionCleanupJournal";

export const TREASURY_CLEANUP_COMPLETION_VERSION = 1;
export const TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES = 128;
const COMPLETION_KEY_PREFIX = "cc:";
/** digest 维度字段格式（与 authorizationFaults/lineage 的 16hex 同口径）。 */
const COMPLETION_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 单 attempt cleanup 完成的持久证明（journal 删除后的唯一完成权威）。
 * identity 子对象持久化完整 exact identity 维度（与 journal entry 相同的
 * 不可变字段集）——lookup 时按全维度比较，不存在"只比 transactionId"。
 */
export interface TreasuryCleanupCompletionProof {
  readonly schemaVersion: typeof TREASURY_CLEANUP_COMPLETION_VERSION;
  readonly transactionId: string;
  readonly resolution: "committed" | "not-executed";
  readonly identity: {
    readonly digest: string;
    readonly identityProfile: string;
    readonly proofClass: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  };
  readonly settlementProofVerified: true;
  readonly markerDischarged: true;
  readonly authorityAbsentConfirmed: true;
  readonly outcomeFinal: true;
  readonly lineageFinalOrNotApplicable: true;
  /** lineage 阶段的完成语义（finalized/already_final=final；not_applicable=not_applicable）。 */
  readonly lineageDisposition: "final" | "not_applicable";
  /** unrelated global marker 存在时记录"本 attempt 已完成、全局 write lock 由其它 attempt 持有"。 */
  readonly globalWriteAdmissionStillLocked: boolean;
  readonly completedAtTick: number;
}

export interface TreasuryCleanupCompletionStore {
  readonly version: typeof TREASURY_CLEANUP_COMPLETION_VERSION;
  entries: Record<string, TreasuryCleanupCompletionProof>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithCompletions {
  cleanupCompletions?: TreasuryCleanupCompletionStore;
}

type RuntimeMemoryWithCompletions = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithCompletions;
};

interface CompletionRuntime {
  store: TreasuryCleanupCompletionStore;
  fatal: string | null;
}

let heapRuntime: CompletionRuntime | null = null;

registerTreasuryResolutionCleanupResetHook(() => {
  heapRuntime = null;
});

function completionBranch(): TreasuryMemoryBranchWithCompletions {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithCompletions;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function validateCompletionProofShape(proof: unknown, key: string): string | null {
  if (!proof || typeof proof !== "object") return `completion proof ${key.slice(0, 11)} 非对象`;
  const candidate = proof as Partial<TreasuryCleanupCompletionProof>;
  if (candidate.schemaVersion !== TREASURY_CLEANUP_COMPLETION_VERSION) {
    return `completion proof ${key.slice(0, 11)} schemaVersion 非法`;
  }
  if (typeof candidate.transactionId !== "string" || candidate.transactionId.length === 0) {
    return `completion proof ${key.slice(0, 11)} transactionId 非法`;
  }
  if (key !== COMPLETION_KEY_PREFIX + candidate.transactionId) {
    return `completion proof ${key.slice(0, 11)} 键与 transactionId 不一致`;
  }
  if (candidate.resolution !== "committed" && candidate.resolution !== "not-executed") {
    return `completion proof ${key.slice(0, 11)} resolution 非法`;
  }
  const identity = candidate.identity;
  if (!identity || typeof identity !== "object") return `completion proof ${key.slice(0, 11)} identity 非对象`;
  // 【Remediation V 五.2】digest 维度字段格式（16hex——与 fault/lineage 同
  // 口径；格式非法 = 损坏，不折叠为 absent）。
  for (const field of ["digest", "contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = identity[field];
    if (value !== undefined && (typeof value !== "string" || !COMPLETION_DIGEST_PATTERN.test(value))) {
      return `completion proof ${key.slice(0, 11)} identity.${field} 非法（须 16 小写 hex）`;
    }
  }
  if (typeof identity.digest !== "string" || identity.digest.length === 0) {
    return `completion proof ${key.slice(0, 11)} identity.digest 非法`;
  }
  if (typeof identity.proofClass !== "string" || identity.proofClass.length === 0) {
    return `completion proof ${key.slice(0, 11)} identity.proofClass 非法`;
  }
  // 【Remediation V 五.2】completion exact relation 的单一语义源（与 journal
  // validateCleanupEntryIdentity 同强度）：profile 枚举 + profile↔proofClass
  // 唯一映射 + required/forbidden 矩阵——completion 不再接受"字段是非空字符
  // 串"的自我授权形状。
  if (typeof identity.identityProfile !== "string" || !TREASURY_IDENTITY_PROFILES.has(identity.identityProfile)) {
    return `completion proof ${key.slice(0, 11)} identity.identityProfile 非法枚举: ${String(identity.identityProfile).slice(0, 32)}`;
  }
  if (treasuryProofClassOfIdentityProfile(identity.identityProfile as TreasuryIdentityProfile) !== identity.proofClass) {
    return `completion proof ${key.slice(0, 11)} identityProfile 与 proofClass 不满足唯一合法组合（${identity.identityProfile} vs ${identity.proofClass}）`;
  }
  const profileError = validateTreasuryIdentityProfileFacts(identity.identityProfile as TreasuryIdentityProfile, {
    digest: identity.digest,
    contractDigest: identity.contractDigest,
    authorizationCohortDigest: identity.authorizationCohortDigest,
    durableIdentityDigest: identity.durableIdentityDigest,
    lowlevelSource: identity.lowlevelSource,
  });
  if (profileError !== null) {
    return `completion proof ${key.slice(0, 11)} ${profileError}`;
  }
  // lineage 四字段整体性 + tr1_/initial 携带矩阵（exact identity 构造层单一
  // 权威——部分携带 / tr1_ 缺字段 / initial 错带全部拒绝）。
  if (completionExactIdentityOfProof(proof as TreasuryCleanupCompletionProof) === null) {
    return `completion proof ${key.slice(0, 11)} 身份无法构造 exact identity（lineage 四字段整体性 / tr1_ 携带矩阵失败）`;
  }
  if (
    candidate.settlementProofVerified !== true ||
    candidate.markerDischarged !== true ||
    candidate.authorityAbsentConfirmed !== true ||
    candidate.outcomeFinal !== true ||
    candidate.lineageFinalOrNotApplicable !== true
  ) {
    return `completion proof ${key.slice(0, 11)} 五阶段完成事实缺失（completion 必须证明全部阶段）`;
  }
  if (candidate.lineageDisposition !== "final" && candidate.lineageDisposition !== "not_applicable") {
    return `completion proof ${key.slice(0, 11)} lineageDisposition 非法`;
  }
  if (typeof candidate.globalWriteAdmissionStillLocked !== "boolean") {
    return `completion proof ${key.slice(0, 11)} globalWriteAdmissionStillLocked 非布尔`;
  }
  if (!Number.isSafeInteger(candidate.completedAtTick) || (candidate.completedAtTick as number) < 0) {
    return `completion proof ${key.slice(0, 11)} completedAtTick 非法`;
  }
  return null;
}

/**
 * 【Remediation V 五.2】completion proof → exact attempt identity（单一构造
 * 口径——与 journal entry 的 treasuryPreReleaseExactIdentityOfEntry 同源；
 * lineage 四字段整体性与 tr1_/initial 携带矩阵由构造层承载，非法形状返回
 * null）。
 */
export function completionExactIdentityOfProof(
  proof: Pick<TreasuryCleanupCompletionProof, "transactionId" | "identity">,
): TreasuryExactAttemptIdentity | null {
  const identity = proof.identity;
  return treasuryExactAttemptIdentityOfFacts(
    proof.transactionId,
    {
      digest: identity.digest,
      ...(identity.contractDigest !== undefined ? { contractDigest: identity.contractDigest } : {}),
      ...(identity.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: identity.authorizationCohortDigest } : {}),
      ...(identity.durableIdentityDigest !== undefined ? { durableIdentityDigest: identity.durableIdentityDigest } : {}),
      ...(identity.lowlevelSource !== undefined ? { lowlevelSource: identity.lowlevelSource } : {}),
      ...(identity.lineageId !== undefined ? { lineageId: identity.lineageId } : {}),
      ...(identity.lineageGeneration !== undefined ? { lineageGeneration: identity.lineageGeneration } : {}),
      ...(identity.parentTransactionId !== undefined ? { parentTransactionId: identity.parentTransactionId } : {}),
      ...(identity.lineageBindingDigest !== undefined ? { lineageBindingDigest: identity.lineageBindingDigest } : {}),
    },
    identity.proofClass === "lowlevel" ? "lowlevel" : identity.proofClass === "identity-bound" ? "identity-bound" : "legacy",
  );
}

function validateCompletionStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "completion store 非对象";
  const candidate = store as Partial<TreasuryCleanupCompletionStore>;
  if (candidate.version !== TREASURY_CLEANUP_COMPLETION_VERSION) {
    return `completion store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "completion store entries 非对象";
  const proto = Object.getPrototypeOf(candidate.entries);
  if (proto !== Object.prototype && proto !== null) return "completion store entries 原型非普通对象";
  const keys = Object.keys(candidate.entries);
  if (keys.length > TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES) {
    return `completion store 超过硬容量 ${String(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES)}（实际 ${String(keys.length)}）`;
  }
  for (const key of keys) {
    if (key === "__proto__" || !key.startsWith(COMPLETION_KEY_PREFIX)) return `completion store 键 ${key.slice(0, 11)} 缺少前缀`;
    const error = validateCompletionProofShape(candidate.entries[key], key);
    if (error !== null) return error;
  }
  if (candidate.entryCount !== keys.length) {
    return `completion store entryCount ${String(candidate.entryCount)} != ${String(keys.length)}`;
  }
  return null;
}

function loadCompletionRuntime(): CompletionRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCompletions | undefined)?.treasury?.cleanupCompletions;
  if (raw === undefined) {
    const store: TreasuryCleanupCompletionStore = {
      version: TREASURY_CLEANUP_COMPLETION_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    completionBranch().cleanupCompletions = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateCompletionStoreShape(raw);
  heapRuntime = { store: raw as unknown as TreasuryCleanupCompletionStore, fatal: shapeError };
  return heapRuntime;
}

export interface TreasuryCleanupCompletionHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/** 只读健康探测（store 不存在 = 健康空；损坏 → unhealthy——不折叠为 absent）。 */
export function peekTreasuryCleanupCompletionHealth(): TreasuryCleanupCompletionHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCompletions | undefined)?.treasury?.cleanupCompletions;
  if (raw === undefined) return { healthy: true, detail: null };
  const shapeError = validateCompletionStoreShape(raw);
  return shapeError === null ? { healthy: true, detail: null } : { healthy: false, detail: shapeError };
}

/** test-only：删除 Memory 中的 durable completion store（heap 一并失效）。 */
export function clearTreasuryCleanupCompletionDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithCompletions | undefined)?.treasury;
  if (branch !== undefined) delete branch.cleanupCompletions;
  heapRuntime = null;
}

/** test-only：只清 heap 缓存（模拟 global reset 后首次访问——从 Memory 权威恢复）。 */
export function resetTreasuryCleanupCompletionHeapCacheForTest(): void {
  heapRuntime = null;
}

/** 【Remediation VI 4.6】completion 写入失败的结构化原因（只有 capacity_exhausted 允许触发 reclaim）。 */
export type TreasuryCleanupCompletionRejectReason =
  | "store_unhealthy"
  | "invalid_candidate"
  | "existing_conflict"
  | "capacity_exhausted"
  | "read_back_failure";

export type TreasuryCleanupCompletionRecordResult =
  | { readonly status: "written" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly reason: TreasuryCleanupCompletionRejectReason; readonly detail: string };

/**
 * completion proof 写入（journal 删除前的持久化步骤）：全部 journal 阶段
 * 已 ack 的 entry → candidate 写入 → 单 key Memory read-back → 完整 identity
 * 与阶段事实重新验证。写入失败/冲突 → rejected（携带结构化 reason——只有
 * capacity_exhausted 允许触发 bounded reclaim，identity conflict / invalid /
 * unhealthy / read-back 失败一律零全局 GC 副作用）；同 id 幂等要求完整
 * identity 一致（不覆盖旧 proof）。
 */
export function recordTreasuryCleanupCompletion(input: {
  readonly entry: Readonly<TreasuryResolutionCleanupEntry>;
  readonly lineageDisposition: "final" | "not_applicable";
  readonly globalWriteAdmissionStillLocked: boolean;
}): TreasuryCleanupCompletionRecordResult {
  const runtime = loadCompletionRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `completion store fail-closed: ${runtime.fatal}` };
  }
  const entry = input.entry;
  if (
    !entry.settlementProofDurable ||
    !entry.markerDischarged ||
    !entry.authorityReleased ||
    !entry.outcomeFinalized ||
    !entry.lineageFinalized
  ) {
    return { status: "rejected", reason: "invalid_candidate", detail: "completion 只能证明五阶段全部 ack 的 entry（journal 阶段未完成）" };
  }
  const key = COMPLETION_KEY_PREFIX + entry.transactionId;
  const existing = runtime.store.entries[key];
  const candidate: TreasuryCleanupCompletionProof = cloneTreasuryDurableValue({
    schemaVersion: TREASURY_CLEANUP_COMPLETION_VERSION,
    transactionId: entry.transactionId,
    resolution: entry.resolution,
    identity: {
      digest: entry.digest,
      identityProfile: entry.identityProfile,
      proofClass: entry.proofClass,
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
      ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
      ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
      ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
      ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
      ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
    },
    settlementProofVerified: true,
    markerDischarged: true,
    authorityAbsentConfirmed: true,
    outcomeFinal: true,
    lineageFinalOrNotApplicable: true,
    lineageDisposition: input.lineageDisposition,
    globalWriteAdmissionStillLocked: input.globalWriteAdmissionStillLocked,
    completedAtTick: Game.time,
  });
  if (existing !== undefined) {
    // 幂等：已存在的 completion 必须与 candidate 在全部持久维度一致（除
    // completedAtTick / globalWriteAdmissionStillLocked 的运行期事实）——
    // 身份或阶段事实冲突 → rejected（fail closed，不覆盖旧 proof）。
    const sameIdentity =
      existing.transactionId === candidate.transactionId &&
      existing.resolution === candidate.resolution &&
      existing.identity.digest === candidate.identity.digest &&
      existing.identity.identityProfile === candidate.identity.identityProfile &&
      existing.identity.proofClass === candidate.identity.proofClass &&
      (existing.identity.contractDigest ?? undefined) === (candidate.identity.contractDigest ?? undefined) &&
      (existing.identity.authorizationCohortDigest ?? undefined) === (candidate.identity.authorizationCohortDigest ?? undefined) &&
      (existing.identity.durableIdentityDigest ?? undefined) === (candidate.identity.durableIdentityDigest ?? undefined) &&
      (existing.identity.lowlevelSource ?? undefined) === (candidate.identity.lowlevelSource ?? undefined) &&
      (existing.identity.lineageId ?? undefined) === (candidate.identity.lineageId ?? undefined) &&
      (existing.identity.lineageGeneration ?? undefined) === (candidate.identity.lineageGeneration ?? undefined) &&
      (existing.identity.parentTransactionId ?? undefined) === (candidate.identity.parentTransactionId ?? undefined) &&
      (existing.identity.lineageBindingDigest ?? undefined) === (candidate.identity.lineageBindingDigest ?? undefined) &&
      existing.lineageDisposition === candidate.lineageDisposition;
    return sameIdentity
      ? { status: "idempotent" }
      : { status: "rejected", reason: "existing_conflict", detail: "同 transactionId 已存在身份不一致的 completion proof（不覆盖旧 proof——fail closed）" };
  }
  if (runtime.store.entryCount >= TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES) {
    return {
      status: "rejected",
      reason: "capacity_exhausted",
      detail: `completion store 满载（${String(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES)}——fail closed，journal 保留 pending 重试）`,
    };
  }
  // 【Remediation VI】写入独立 clone（heap store 与 Memory 权威同对象——
  // candidate 引用不得同时充当 read-back 比较基准，否则写入窗口内的篡改
  // 会同步进 candidate 使全维度比较恒真）。
  runtime.store.entries[key] = cloneTreasuryDurableValue(candidate);
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  // Memory read-back：直读权威 store 单 key，完整 identity + 阶段事实重新验证。
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCompletions | undefined)?.treasury?.cleanupCompletions;
  if (rawStore === undefined) {
    return { status: "rejected", reason: "read_back_failure", detail: "completion 写入后 Memory read-back store 缺失（journal 保留）" };
  }
  const readBack = rawStore.entries[key];
  const readBackError = readBack === undefined ? "read-back proof 缺失" : validateCompletionProofShape(readBack, key);
  if (readBackError !== null) {
    // read-back 失败：回滚本次写入（completion 是新写入的——entry 从未存在）。
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    return { status: "rejected", reason: "read_back_failure", detail: `completion read-back 失败: ${readBackError}（已回滚，journal 保留）` };
  }
  // 【Remediation V 五.2】read-back 比较全部不可变身份维度与必要完成事实
  //（不再只比 digest/proofClass/lineageId/lineageDisposition/transactionId
  // 五项——contract/cohort/durable/lowlevel/generation/parent/binding/
  // identityProfile 任一被篡改都必须失败回滚）。
  const readBackProof = readBack as TreasuryCleanupCompletionProof;
  const readBackIdentityEqual =
    readBackProof.transactionId === candidate.transactionId &&
    readBackProof.resolution === candidate.resolution &&
    readBackProof.identity.digest === candidate.identity.digest &&
    readBackProof.identity.identityProfile === candidate.identity.identityProfile &&
    readBackProof.identity.proofClass === candidate.identity.proofClass &&
    (readBackProof.identity.contractDigest ?? undefined) === (candidate.identity.contractDigest ?? undefined) &&
    (readBackProof.identity.authorizationCohortDigest ?? undefined) === (candidate.identity.authorizationCohortDigest ?? undefined) &&
    (readBackProof.identity.durableIdentityDigest ?? undefined) === (candidate.identity.durableIdentityDigest ?? undefined) &&
    (readBackProof.identity.lowlevelSource ?? undefined) === (candidate.identity.lowlevelSource ?? undefined) &&
    (readBackProof.identity.lineageId ?? undefined) === (candidate.identity.lineageId ?? undefined) &&
    (readBackProof.identity.lineageGeneration ?? undefined) === (candidate.identity.lineageGeneration ?? undefined) &&
    (readBackProof.identity.parentTransactionId ?? undefined) === (candidate.identity.parentTransactionId ?? undefined) &&
    (readBackProof.identity.lineageBindingDigest ?? undefined) === (candidate.identity.lineageBindingDigest ?? undefined) &&
    readBackProof.lineageDisposition === candidate.lineageDisposition &&
    readBackProof.settlementProofVerified === true &&
    readBackProof.markerDischarged === true &&
    readBackProof.authorityAbsentConfirmed === true &&
    readBackProof.outcomeFinal === true &&
    readBackProof.lineageFinalOrNotApplicable === true;
  if (!readBackIdentityEqual) {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    return { status: "rejected", reason: "read_back_failure", detail: "completion read-back 身份或完成事实不一致（已回滚，journal 保留）" };
  }
  return { status: "written" };
}

export type TreasuryCleanupCompletionLookup =
  | { readonly verdict: "match"; readonly proof: Readonly<TreasuryCleanupCompletionProof> }
  | { readonly verdict: "absent" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/**
 * journal absent 时的完成判定（单 key O(1)）：completion 存在且与调用方
 * expected identity 完整 match → match；不存在 → absent（no_cleanup_
 * authority——不得折叠为 completed）；身份不一致 → conflict（fail closed）。
 * 【Remediation VI 4.4】查询绑定 settlement outcome：expectedOutcome 提供
 * 时与 proof.resolution 比较，不一致 → conflict（committed completion 用
 * not-executed 视角查询不得 match——settlement relabel 被 authority 阻断）。
 * expected 未提供时（无 journal 可对照的幂等重入）proof 自身为持久权威——
 * 但 shape 校验（load 时全表 + 此处单条复验）保证完整 profile/lineage 矩阵，
 * 不存在"仅字段非空即自我授权"。
 */
export function lookupTreasuryCleanupCompletion(
  transactionId: string,
  expected?: TreasuryExactAttemptIdentity,
  expectedOutcome?: "committed" | "not-executed",
): TreasuryCleanupCompletionLookup {
  const runtime = loadCompletionRuntime();
  if (runtime.fatal !== null) {
    return { verdict: "store_unhealthy", detail: `completion store fail-closed: ${runtime.fatal}` };
  }
  const proof = runtime.store.entries[COMPLETION_KEY_PREFIX + transactionId];
  if (proof === undefined) return { verdict: "absent" };
  // 防御性单条复验（heap store 与 Memory 同对象——手工篡改在 load 后发生时
  // 由此拦截，不得以损坏形状判 match）。
  const shapeError = validateCompletionProofShape(proof, COMPLETION_KEY_PREFIX + transactionId);
  if (shapeError !== null) {
    return { verdict: "store_unhealthy", detail: `completion proof 损坏: ${shapeError}` };
  }
  if (expectedOutcome !== undefined && proof.resolution !== expectedOutcome) {
    return {
      verdict: "conflict",
      detail: `completion proof settlement=${proof.resolution} 与查询视角 ${expectedOutcome} 不一致（outcome 绑定——不得 relabel）`,
    };
  }
  if (expected !== undefined) {
    // 【Remediation V 五.2】expected 比较完整 exact relation（单一构造层 +
    // 对称 relation——含 contract/cohort/durable/lowlevel/lineage 四字段；
    // proofClass 经 relation 比较，identityProfile 由 profile↔class 唯一映射
    // 传递保证）+ settlement resolution 维度。
    const proofExact = completionExactIdentityOfProof(proof);
    if (proofExact === null) {
      return { verdict: "store_unhealthy", detail: "completion proof 身份无法构造 exact identity（shape 校验后仍失败——防御）" };
    }
    const relation = treasuryExactAttemptIdentityRelation(proofExact, expected);
    if (relation !== "match") {
      return {
        verdict: "conflict",
        detail: `completion proof 身份与 expected ${relation}（digest ${proof.identity.digest.slice(0, 8)} vs ${expected.digest.slice(0, 8)} 等——不得视为已完成）`,
      };
    }
  }
  return { verdict: "match", proof: treasuryBoundedDeepFreezeSnapshot(proof) as TreasuryCleanupCompletionProof };
}

/** 【诊断/测试】当前 store entry 数（容量观测——只读：store 不存在 = 0，不隐式创建）。 */
export function peekTreasuryCleanupCompletionEntryCount(): number {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCompletions | undefined)?.treasury?.cleanupCompletions;
  if (raw === undefined) return 0;
  const keys = raw && typeof raw === "object" ? Object.keys(raw.entries ?? {}) : [];
  return keys.length > TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES ? -1 : keys.length;
}

/**
 * 【Remediation V 八】bounded 枚举当前 completion 的全部 transactionId
 * （≤硬容量；replacement 模块的 headroom 回收扫描用——不进入 normal 查询
 * 路径）。fatal store → 空数组（调用方按 unhealthy fail closed）。
 */
export function listTreasuryCleanupCompletionTransactionIds(): readonly string[] {
  const runtime = loadCompletionRuntime();
  if (runtime.fatal !== null) return [];
  return Object.keys(runtime.store.entries).map((key) => key.slice(COMPLETION_KEY_PREFIX.length));
}

/**
 * 【十.4 容量回收】completion proof 的定向释放——不可覆盖旧 proof 的容量
 * 约束由"完成事实被更高层权威安全替代后回收"承载：
 *  - rearm 链：child 激活（activateTreasuryLineageChild 成功）时释放
 *    parent attempt 的 completion（parent cleanup 已被 rearm 门禁消费确认，
 *    journal 已删、查询者已完成）；
 *  - chain 终结：terminal summary 压缩成功时释放 final/root attempt 的
 *    completion（summary 成为 chain 级持久权威）。
 * 释放后 store 容量回到可用区间（满载 fail closed 不再永久卡死长链）。
 */
export function releaseTreasuryCleanupCompletionOfAttempt(transactionId: string): boolean {
  const runtime = loadCompletionRuntime();
  if (runtime.fatal !== null) return false;
  const key = COMPLETION_KEY_PREFIX + transactionId;
  if (runtime.store.entries[key] === undefined) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  return true;
}
