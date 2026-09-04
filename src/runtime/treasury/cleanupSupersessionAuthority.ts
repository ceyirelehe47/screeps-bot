/**
 * 【Round 22 Remediation VI】cleanup supersession authority——completion
 * 精确交接与 durable historical completion 的单一权威。
 *
 * Remediation V 的 replacement 判定只按 transactionId + resolution 字符串
 * 匹配（GRA / terminal summary / final tombstone 存在即 superseded），且
 * final committed tombstone 单独就能把 journal-absent + completion-absent
 * 折叠为 completed——这不是 exact relation，也无法在 GRA / tombstone 各自的
 * retention 生命周期结束后继续证明完成事实。
 *
 * 本模块关闭该断链：
 *
 * 1. verifyTreasuryExactCompletionReplacement：replacement 必须与 completion
 *    在 settlement outcome + 全部 exact identity 维度（digest / profile /
 *    proofClass / contract / cohort / durable / lowlevel / lineage 四字段）
 *    完整匹配；GRA 额外验证 root 绑定 / authorityClass / resolution /
 *    retirement 三阶段；outcome 相反（T1/T2）或任一维度冲突（T3/T4）时
 *    conflict——completion 保留（fail closed）。
 * 2. archiveTreasuryCleanupCompletionViaAuthority：所有 completion 的
 *    destructive release 唯一生产入口（attemptLineage / summary compaction
 *    / headroom reclaim 均经此，不得再直接调用底层 release）——固定顺序：
 *    验证 completion → 验证 replacement（via 指定时）→ 写入 durable
 *    historical authority（压缩归档：outcome + canonical exact identity）→
 *    Memory read-back → 删除 completion → 删除 read-back absent。
 * 3. durable historical authority（Memory.runtime.treasury.
 *    cleanupSupersessions）：有界硬容量 384，独立于 GRA / tombstone /
 *    active lineage 的生命周期——ephemeral replacement 被回收、global
 *    reset、heap 清空后仍可按 attempt 精确查询完成事实与 authoritative
 *    settlement outcome（跨 GRA/tombstone retention 存续）。
 * 4. lookupTreasuryHistoricalCompletion：查询绑定 settlement outcome——
 *    committed 权威用 not-executed 视角查询返回 conflict（不得 relabel）。
 * 5. ensureTreasuryCleanupCompletionHeadroom：state-changing headroom
 *    preflight——满载时 bounded（≤硬容量）exact archive 回收后复查容量；
 *    query 路径零写语义不受影响（本函数只被 authorize / prepare /
 *    execute 等 state-changing 路径调用）。
 *
 * store 损坏 / 未知版本 / identity 不足 / outcome 冲突 / replacement 不可
 * 证明 / 容量无法安全压缩时一律 fail closed：completion 保留、零删除、
 * 零全局 GC 副作用。
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
  treasuryExactAttemptIdentityOfTombstone,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";
import {
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
  listTreasuryCleanupCompletionTransactionIds,
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionEntryCount,
  peekTreasuryCleanupCompletionHealth,
  releaseTreasuryCleanupCompletionOfAttempt,
  type TreasuryCleanupCompletionProof,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import { peekTreasuryCompletionHeadroomReservationCount } from "@/runtime/treasury/completionHeadroomReservation";

export const TREASURY_CLEANUP_SUPERSESSION_VERSION = 1;
export const TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES = 384;
const SUPERSESSION_KEY_PREFIX = "sa:";
const SUPERSESSION_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/**
 * durable historical completion record——completion proof 的紧凑压缩归档
 * （journal 删除后 completion 又被回收时的最终完成权威）。
 * identity 子对象持久化与 completion proof 相同的全部不可变维度。
 */
export interface TreasuryHistoricalCompletionRecord {
  readonly schemaVersion: typeof TREASURY_CLEANUP_SUPERSESSION_VERSION;
  readonly transactionId: string;
  /** authoritative settlement outcome（压缩时从 completion 绑定，不可 relabel）。 */
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
  /** completion 的 lineage 阶段完成语义（final / not_applicable）。 */
  readonly lineageDisposition: "final" | "not_applicable";
  /** 归档依据（exact replacement 来源 / compact archive）。 */
  readonly via: "gra-proof" | "terminal-summary" | "final-tombstone" | "compact-archive";
  readonly archivedAtTick: number;
}

export interface TreasuryCleanupSupersessionStore {
  readonly version: typeof TREASURY_CLEANUP_SUPERSESSION_VERSION;
  entries: Record<string, TreasuryHistoricalCompletionRecord>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithSupersessions {
  cleanupSupersessions?: TreasuryCleanupSupersessionStore;
}

type RuntimeMemoryWithSupersessions = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithSupersessions;
};

interface SupersessionRuntime {
  store: TreasuryCleanupSupersessionStore;
  fatal: string | null;
}

let heapRuntime: SupersessionRuntime | null = null;

registerTreasuryResolutionCleanupResetHook(() => {
  heapRuntime = null;
});

function supersessionBranch(): TreasuryMemoryBranchWithSupersessions {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithSupersessions;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function historicalRecordExactIdentity(
  record: Pick<TreasuryHistoricalCompletionRecord, "transactionId" | "identity">,
): TreasuryExactAttemptIdentity | null {
  const identity = record.identity;
  return treasuryExactAttemptIdentityOfFacts(
    record.transactionId,
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

function validateHistoricalRecordShape(record: unknown, key: string): string | null {
  if (!record || typeof record !== "object") return `historical record ${key.slice(0, 11)} 非对象`;
  const candidate = record as Partial<TreasuryHistoricalCompletionRecord>;
  if (candidate.schemaVersion !== TREASURY_CLEANUP_SUPERSESSION_VERSION) {
    return `historical record ${key.slice(0, 11)} schemaVersion 非法`;
  }
  if (typeof candidate.transactionId !== "string" || candidate.transactionId.length === 0) {
    return `historical record ${key.slice(0, 11)} transactionId 非法`;
  }
  if (key !== SUPERSESSION_KEY_PREFIX + candidate.transactionId) {
    return `historical record ${key.slice(0, 11)} 键与 transactionId 不一致`;
  }
  if (candidate.resolution !== "committed" && candidate.resolution !== "not-executed") {
    return `historical record ${key.slice(0, 11)} resolution 非法`;
  }
  const identity = candidate.identity;
  if (!identity || typeof identity !== "object") return `historical record ${key.slice(0, 11)} identity 非对象`;
  for (const field of ["digest", "contractDigest", "authorizationCohortDigest", "durableIdentityDigest", "lineageBindingDigest"] as const) {
    const value = identity[field];
    if (value !== undefined && (typeof value !== "string" || !SUPERSESSION_DIGEST_PATTERN.test(value))) {
      return `historical record ${key.slice(0, 11)} identity.${field} 非法（须 16 小写 hex）`;
    }
  }
  if (typeof identity.digest !== "string" || identity.digest.length === 0) {
    return `historical record ${key.slice(0, 11)} identity.digest 非法`;
  }
  if (typeof identity.proofClass !== "string" || identity.proofClass.length === 0) {
    return `historical record ${key.slice(0, 11)} identity.proofClass 非法`;
  }
  if (typeof identity.identityProfile !== "string" || !TREASURY_IDENTITY_PROFILES.has(identity.identityProfile)) {
    return `historical record ${key.slice(0, 11)} identity.identityProfile 非法枚举: ${String(identity.identityProfile).slice(0, 32)}`;
  }
  if (treasuryProofClassOfIdentityProfile(identity.identityProfile as TreasuryIdentityProfile) !== identity.proofClass) {
    return `historical record ${key.slice(0, 11)} identityProfile 与 proofClass 不满足唯一合法组合`;
  }
  const profileError = validateTreasuryIdentityProfileFacts(identity.identityProfile as TreasuryIdentityProfile, {
    digest: identity.digest,
    contractDigest: identity.contractDigest,
    authorizationCohortDigest: identity.authorizationCohortDigest,
    durableIdentityDigest: identity.durableIdentityDigest,
    lowlevelSource: identity.lowlevelSource,
  });
  if (profileError !== null) {
    return `historical record ${key.slice(0, 11)} ${profileError}`;
  }
  if (
    identity.lineageGeneration !== undefined &&
    (!Number.isSafeInteger(identity.lineageGeneration) || (identity.lineageGeneration as number) < 0)
  ) {
    return `historical record ${key.slice(0, 11)} identity.lineageGeneration 非法`;
  }
  if (historicalRecordExactIdentity(record as TreasuryHistoricalCompletionRecord) === null) {
    return `historical record ${key.slice(0, 11)} 身份无法构造 exact identity（lineage 四字段整体性 / 携带矩阵失败）`;
  }
  if (candidate.lineageDisposition !== "final" && candidate.lineageDisposition !== "not_applicable") {
    return `historical record ${key.slice(0, 11)} lineageDisposition 非法`;
  }
  if (
    candidate.via !== "gra-proof" &&
    candidate.via !== "terminal-summary" &&
    candidate.via !== "final-tombstone" &&
    candidate.via !== "compact-archive"
  ) {
    return `historical record ${key.slice(0, 11)} via 非法`;
  }
  if (!Number.isSafeInteger(candidate.archivedAtTick) || (candidate.archivedAtTick as number) < 0) {
    return `historical record ${key.slice(0, 11)} archivedAtTick 非法`;
  }
  return null;
}

function validateSupersessionStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "supersession store 非对象";
  const candidate = store as Partial<TreasuryCleanupSupersessionStore>;
  if (candidate.version !== TREASURY_CLEANUP_SUPERSESSION_VERSION) {
    return `supersession store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "supersession store entries 非对象";
  const proto = Object.getPrototypeOf(candidate.entries);
  if (proto !== Object.prototype && proto !== null) return "supersession store entries 原型非普通对象";
  const keys = Object.keys(candidate.entries);
  if (keys.length > TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES) {
    return `supersession store 超过硬容量 ${String(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES)}（实际 ${String(keys.length)}）`;
  }
  for (const key of keys) {
    if (key === "__proto__" || !key.startsWith(SUPERSESSION_KEY_PREFIX)) return `supersession store 键 ${key.slice(0, 11)} 缺少前缀`;
    const error = validateHistoricalRecordShape(candidate.entries[key], key);
    if (error !== null) return error;
  }
  if (candidate.entryCount !== keys.length) {
    return `supersession store entryCount ${String(candidate.entryCount)} != ${String(keys.length)}`;
  }
  return null;
}

function loadSupersessionRuntime(): SupersessionRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury?.cleanupSupersessions;
  if (raw === undefined) {
    const store: TreasuryCleanupSupersessionStore = {
      version: TREASURY_CLEANUP_SUPERSESSION_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    supersessionBranch().cleanupSupersessions = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateSupersessionStoreShape(raw);
  heapRuntime = { store: raw as unknown as TreasuryCleanupSupersessionStore, fatal: shapeError };
  return heapRuntime;
}

export interface TreasuryCleanupSupersessionHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/** 只读健康探测（store 不存在 = 健康空；损坏 → unhealthy——不折叠为 absent）。 */
export function peekTreasuryCleanupSupersessionHealth(): TreasuryCleanupSupersessionHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury?.cleanupSupersessions;
  if (raw === undefined) return { healthy: true, detail: null };
  const shapeError = validateSupersessionStoreShape(raw);
  return shapeError === null ? { healthy: true, detail: null } : { healthy: false, detail: shapeError };
}

/** 【诊断/测试】当前 historical store entry 数（只读：store 不存在 = 0）。 */
export function peekTreasuryCleanupSupersessionEntryCount(): number {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury?.cleanupSupersessions;
  if (raw === undefined) return 0;
  const keys = raw && typeof raw === "object" ? Object.keys(raw.entries ?? {}) : [];
  return keys.length > TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES ? -1 : keys.length;
}

/** test-only：删除 Memory 中的 durable supersession store（heap 一并失效）。 */
export function clearTreasuryCleanupSupersessionDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury;
  if (branch !== undefined) delete branch.cleanupSupersessions;
  heapRuntime = null;
}

/** test-only：只清 heap 缓存（模拟 global reset 后首次访问——从 Memory 权威恢复）。 */
export function resetTreasuryCleanupSupersessionHeapCacheForTest(): void {
  heapRuntime = null;
}

// ── replacement probes（模块环规避：GRA / summary / tombstone 只读探测）────

/** 只读 store 探测（resolutionCleanupStageHandlers 装配；test 可重入）。 */
export interface TreasuryCompletionReplacementProbes {
  readonly graStoreHealthy: () => boolean;
  readonly readGRAProofByAttempt: (transactionId: string) => {
    readonly transactionId: string;
    readonly resolution: string;
    readonly identityProfile: string;
    readonly lineageId: string;
    readonly rootTransactionId: string;
    readonly rootIdentityDigest: string;
    readonly generation: number;
    readonly parentTransactionId?: string;
    readonly bindingDigest?: string;
    readonly digest: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly authorityClass: string;
    readonly retirement: {
      readonly lineagePublished: boolean;
      readonly authorityReleased: boolean;
      readonly markerCleaned: boolean;
    };
  } | undefined;
  readonly summaryStoreHealthy: () => boolean;
  readonly readSummaryByRoot: (rootTransactionId: string) => {
    readonly rootTransactionId: string;
    readonly finalAttemptId: string;
    readonly terminalState: string;
    readonly rootExact?: {
      readonly digest: string;
      readonly contractDigest?: string;
      readonly authorizationCohortDigest?: string;
      readonly durableIdentityDigest?: string;
      readonly lowlevelSource?: string;
      readonly proofClass: string;
    };
    readonly finalExact?: {
      readonly digest: string;
      readonly contractDigest?: string;
      readonly authorizationCohortDigest?: string;
      readonly durableIdentityDigest?: string;
      readonly lowlevelSource?: string;
      readonly proofClass: string;
      readonly parentTransactionId?: string;
      readonly lineageBindingDigest?: string;
    };
  } | undefined;
  readonly resolutionStoreHealthy: () => boolean;
  readonly readTombstone: (transactionId: string) => {
    readonly transactionId: string;
    readonly resolution: string;
    readonly stage: string;
    readonly digest: string;
    readonly proofLevel: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  } | undefined;
  /** 有界枚举当前 completion store 的全部 transactionId（bounded compaction 用）。 */
  readonly listCompletionTransactionIds: () => readonly string[];
  /** 删除后的 read-back（absent 确认——completion 模块单 key 直读）。 */
  readonly completionAbsentAfterRelease: (transactionId: string) => boolean;
}

let replacementProbes: TreasuryCompletionReplacementProbes | null = null;

export function registerTreasuryCompletionReplacementProbesForAssembly(
  probes: TreasuryCompletionReplacementProbes | null,
): void {
  replacementProbes = probes;
}

export function peekTreasuryCompletionReplacementProbes(): TreasuryCompletionReplacementProbes | null {
  return replacementProbes;
}

// ── exact replacement 验证（outcome + 全维度 identity——不再 transactionId-only）──

export type TreasuryExactCompletionReplacement =
  | {
      readonly verdict: "superseded";
      readonly via: "gra-proof" | "terminal-summary" | "final-tombstone";
      readonly detail: string;
    }
  | { readonly verdict: "no_replacement" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

function graExactIdentityOfProof(
  gra: NonNullable<ReturnType<TreasuryCompletionReplacementProbes["readGRAProofByAttempt"]>>,
): TreasuryExactAttemptIdentity | null {
  // gen0（root）的 attempt identity 不含 lineage 维度（initial attempt 禁止
  // lineage proof——构造器矩阵）；GRA 的 lineageId/root 绑定是 proof 自身的
  // 绑定事实（load 时 semantics 校验 canonical 重算），不进入 root 的
  // identity 比较。gen≥1（tr1_ child）携带完整 lineage 四字段。
  const isRootGeneration = gra.generation === 0;
  return treasuryExactAttemptIdentityOfFacts(
    gra.transactionId,
    {
      digest: gra.digest,
      ...(gra.contractDigest !== undefined ? { contractDigest: gra.contractDigest } : {}),
      ...(gra.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: gra.authorizationCohortDigest } : {}),
      ...(gra.durableIdentityDigest !== undefined ? { durableIdentityDigest: gra.durableIdentityDigest } : {}),
      ...(gra.lowlevelSource !== undefined ? { lowlevelSource: gra.lowlevelSource } : {}),
      ...(isRootGeneration
        ? {}
        : {
            ...(gra.lineageId !== undefined ? { lineageId: gra.lineageId } : {}),
            ...(gra.generation !== undefined ? { lineageGeneration: gra.generation } : {}),
            ...(gra.parentTransactionId !== undefined ? { parentTransactionId: gra.parentTransactionId } : {}),
            ...(gra.bindingDigest !== undefined ? { lineageBindingDigest: gra.bindingDigest } : {}),
          }),
    },
    gra.authorityClass === "lowlevel" ? "lowlevel" : "identity-bound",
  );
}

function relationConflictDetail(
  left: TreasuryExactAttemptIdentity,
  right: TreasuryExactAttemptIdentity,
  relation: string,
): string {
  return `replacement exact identity 与 completion ${relation}（completion digest ${left.digest.slice(0, 8)} vs replacement digest ${right.digest.slice(0, 8)}——任一不可变身份维度差异都不得 supersede）`;
}

/**
 * completion 的 exact replacement 验证（单一权威——GRA / terminal summary /
 * final tombstone 三路，全部 outcome + 全维度 identity 匹配才 superseded）：
 *
 * - GRA（tr1_ / root 的 per-generation retirement proof）：outcome 必须
 *   not-executed ↔ not_executed；retirement 三阶段全 true；identity 全维度
 *   relation match（含 lineage 四字段同一代）；root 绑定（rootTransactionId +
 *   rootIdentityDigest → lineageId canonical 重算）经 GRA store load 时的
 *   全表 semantics 校验承载，lineageId 相等传递 root 一致性；authorityClass
 *   与 completion proofClass 经 relation 的 proofClass 维度比较。
 * - terminal summary（root 是 final 代）：rootExact 全维度 relation match +
 *   not-executed retirement 终态；finalAttemptId 相同时 finalExact 额外匹配。
 * - final committed tombstone：outcome committed ↔ committed + stage final +
 *   identity 全维度 relation match（outcome 相反即 conflict——T2）。
 *
 * 任一路径 outcome 相反或维度冲突 → conflict（completion 保留）；store
 * unhealthy → fail closed；三路都不成立 → no_replacement。
 */
export function verifyTreasuryExactCompletionReplacement(input: {
  readonly transactionId: string;
  readonly completion: Pick<TreasuryCleanupCompletionProof, "transactionId" | "resolution" | "identity">;
  readonly allowedVia?: readonly ("gra-proof" | "terminal-summary" | "final-tombstone")[];
}): TreasuryExactCompletionReplacement {
  if (replacementProbes === null) {
    return { verdict: "store_unhealthy", detail: "completion replacement probes 未装配（fail closed——supersession 不可证明）" };
  }
  const probes = replacementProbes;
  const allowed = input.allowedVia ?? ["gra-proof", "terminal-summary", "final-tombstone"];
  const completionExact = historicalRecordExactIdentity(input.completion);
  if (completionExact === null) {
    return { verdict: "store_unhealthy", detail: "completion 身份无法构造 exact identity（shape 校验后仍失败——防御）" };
  }
  // 1. GRA proof byAttempt：该代的 exact retirement proof。
  if (allowed.includes("gra-proof")) {
    if (!probes.graStoreHealthy()) {
      return { verdict: "store_unhealthy", detail: "GRA store unhealthy（replacement 不可证明——fail closed）" };
    }
    const gra = probes.readGRAProofByAttempt(input.transactionId);
    if (gra !== undefined) {
      if (gra.transactionId !== input.transactionId) {
        return { verdict: "store_unhealthy", detail: "GRA byAttempt 索引返回身份不一致的 proof（fail closed）" };
      }
      // outcome 绑定：GRA 恒 not_executed——committed completion 不得被 GRA supersede（T1）。
      if (input.completion.resolution !== "not-executed" || gra.resolution !== "not_executed") {
        return {
          verdict: "conflict",
          detail: `GRA resolution=${gra.resolution} 与 completion resolution=${input.completion.resolution} outcome 不一致（相反 outcome 的 GRA 不得删除 completion——T1 语义）`,
        };
      }
      if (!gra.retirement.lineagePublished || !gra.retirement.authorityReleased || !gra.retirement.markerCleaned) {
        return { verdict: "conflict", detail: "GRA retirement 三阶段未全部完成（不得作为 replacement）" };
      }
      if (typeof gra.rootTransactionId !== "string" || gra.rootTransactionId.length === 0 || typeof gra.rootIdentityDigest !== "string" || !SUPERSESSION_DIGEST_PATTERN.test(gra.rootIdentityDigest)) {
        return { verdict: "store_unhealthy", detail: "GRA root 绑定字段缺失/非法（root transaction/identity 不可证明——fail closed）" };
      }
      const graExact = graExactIdentityOfProof(gra);
      if (graExact === null) {
        return { verdict: "store_unhealthy", detail: "GRA proof 身份无法构造 exact identity（fail closed）" };
      }
      const relation = treasuryExactAttemptIdentityRelation(completionExact, graExact);
      if (relation !== "match") {
        return { verdict: "conflict", detail: relationConflictDetail(completionExact, graExact, relation) };
      }
      return {
        verdict: "superseded",
        via: "gra-proof",
        detail: "exact per-generation retirement proof 与 completion 在 outcome + 全部 identity 维度完整匹配（含 lineage 四字段同一代；root 绑定经 GRA semantics 校验 + lineageId 相等传递）",
      };
    }
  }
  // 2. terminal summary byRoot：root 是 final 代的 chain 级持久权威。
  if (allowed.includes("terminal-summary")) {
    if (!probes.summaryStoreHealthy()) {
      return { verdict: "store_unhealthy", detail: "terminal summary store unhealthy（replacement 不可证明——fail closed）" };
    }
    const summary = probes.readSummaryByRoot(input.transactionId);
    if (summary !== undefined && summary.rootTransactionId === input.transactionId) {
      if (input.completion.resolution !== "not-executed") {
        return {
          verdict: "conflict",
          detail: "terminal summary 证明 not-executed retirement 终局，与 committed completion outcome 不一致（不得 supersede）",
        };
      }
      if (summary.terminalState !== "non_rearmable_retired" && summary.terminalState !== "chain_committed") {
        return { verdict: "no_replacement" };
      }
      const rootExact = summary.rootExact;
      if (rootExact === undefined) {
        return { verdict: "store_unhealthy", detail: "summary 缺少 rootExact（exact identity 不可证明——fail closed）" };
      }
      const summaryExact = treasuryExactAttemptIdentityOfFacts(
        input.transactionId,
        {
          digest: rootExact.digest,
          ...(rootExact.contractDigest !== undefined ? { contractDigest: rootExact.contractDigest } : {}),
          ...(rootExact.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: rootExact.authorizationCohortDigest } : {}),
          ...(rootExact.durableIdentityDigest !== undefined ? { durableIdentityDigest: rootExact.durableIdentityDigest } : {}),
          ...(rootExact.lowlevelSource !== undefined ? { lowlevelSource: rootExact.lowlevelSource } : {}),
        },
        rootExact.proofClass === "lowlevel" ? "lowlevel" : rootExact.proofClass === "identity-bound" ? "identity-bound" : "legacy",
      );
      if (summaryExact === null) {
        return { verdict: "store_unhealthy", detail: "summary rootExact 无法构造 exact identity（fail closed）" };
      }
      const rootRelation = treasuryExactAttemptIdentityRelation(completionExact, summaryExact);
      if (rootRelation !== "match") {
        return { verdict: "conflict", detail: relationConflictDetail(completionExact, summaryExact, rootRelation) };
      }
      if (summary.finalAttemptId === input.transactionId) {
        const finalExact = summary.finalExact;
        if (finalExact === undefined) {
          return { verdict: "store_unhealthy", detail: "summary 缺少 finalExact（root=final 代的 exact identity 不可证明——fail closed）" };
        }
        const finalRelationFields = (finalExact.durableIdentityDigest ?? undefined) === (input.completion.identity.durableIdentityDigest ?? undefined)
          && (finalExact.lowlevelSource ?? undefined) === (input.completion.identity.lowlevelSource ?? undefined)
          && (finalExact.contractDigest ?? undefined) === (input.completion.identity.contractDigest ?? undefined)
          && (finalExact.authorizationCohortDigest ?? undefined) === (input.completion.identity.authorizationCohortDigest ?? undefined)
          && finalExact.digest === input.completion.identity.digest;
        if (!finalRelationFields) {
          return { verdict: "conflict", detail: "summary finalExact 与 completion identity 维度不一致（root=final 代须全维度匹配）" };
        }
      }
      return {
        verdict: "superseded",
        via: "terminal-summary",
        detail: "terminal summary rootExact（root=final 代时含 finalExact）与 completion 在 outcome + 全部 identity 维度完整匹配",
      };
    }
  }
  // 3. final committed tombstone：initial committed 的 settlement 权威。
  if (allowed.includes("final-tombstone")) {
    if (!probes.resolutionStoreHealthy()) {
      return { verdict: "store_unhealthy", detail: "resolution store unhealthy（replacement 不可证明——fail closed）" };
    }
    const tombstone = probes.readTombstone(input.transactionId);
    if (tombstone !== undefined && tombstone.transactionId === input.transactionId) {
      if (tombstone.resolution === "not-executed") {
        return {
          verdict: "conflict",
          detail: "not-executed tombstone 与 committed completion outcome 不一致（相反 outcome 的 tombstone 不得替代 not-executed completion——T2 语义）",
        };
      }
      if (tombstone.resolution !== "committed" || tombstone.stage !== "final") {
        return { verdict: "no_replacement" };
      }
      const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
      if (tombstoneExact === null) {
        return { verdict: "store_unhealthy", detail: "tombstone 无法构造 exact identity（fail closed）" };
      }
      if (input.completion.resolution !== "committed") {
        return {
          verdict: "conflict",
          detail: `final committed tombstone 与 completion resolution=${input.completion.resolution} outcome 不一致（不得 supersede）`,
        };
      }
      const relation = treasuryExactAttemptIdentityRelation(completionExact, tombstoneExact);
      if (relation !== "match") {
        return { verdict: "conflict", detail: relationConflictDetail(completionExact, tombstoneExact, relation) };
      }
      return {
        verdict: "superseded",
        via: "final-tombstone",
        detail: "final committed tombstone 与 completion 在 outcome + 全部 identity 维度完整匹配（tombstone 只证明 settlement——cleanup 完成仍由 completion/historical authority 承载）",
      };
    }
  }
  return { verdict: "no_replacement" };
}

// ── historical authority 查询（outcome 绑定）──────────────────────────────

export type TreasuryHistoricalCompletionLookup =
  | { readonly verdict: "match"; readonly record: Readonly<TreasuryHistoricalCompletionRecord> }
  | { readonly verdict: "absent" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/**
 * durable historical completion 查询（单 key O(1)）：match 要求 expected
 * identity（提供时）全维度一致 **且** expected outcome（提供时）与权威
 * resolution 一致——committed 权威用 not-executed 视角查询返回 conflict
 * （settlement relabel 被 authority 语义阻断）。
 */
export function lookupTreasuryHistoricalCompletion(
  transactionId: string,
  expected?: TreasuryExactAttemptIdentity,
  expectedOutcome?: "committed" | "not-executed",
): TreasuryHistoricalCompletionLookup {
  const runtime = loadSupersessionRuntime();
  if (runtime.fatal !== null) {
    return { verdict: "store_unhealthy", detail: `supersession store fail-closed: ${runtime.fatal}` };
  }
  const record = runtime.store.entries[SUPERSESSION_KEY_PREFIX + transactionId];
  if (record === undefined) return { verdict: "absent" };
  const shapeError = validateHistoricalRecordShape(record, SUPERSESSION_KEY_PREFIX + transactionId);
  if (shapeError !== null) {
    return { verdict: "store_unhealthy", detail: `historical record 损坏: ${shapeError}` };
  }
  if (expectedOutcome !== undefined && record.resolution !== expectedOutcome) {
    return {
      verdict: "conflict",
      detail: `historical authority settlement=${record.resolution} 与查询视角 ${expectedOutcome} 不一致（outcome 绑定——不得 relabel）`,
    };
  }
  if (expected !== undefined) {
    const recordExact = historicalRecordExactIdentity(record);
    if (recordExact === null) {
      return { verdict: "store_unhealthy", detail: "historical record 身份无法构造 exact identity（防御）" };
    }
    const relation = treasuryExactAttemptIdentityRelation(recordExact, expected);
    if (relation !== "match") {
      return {
        verdict: "conflict",
        detail: `historical authority 身份与 expected ${relation}（digest ${record.identity.digest.slice(0, 8)} vs ${expected.digest.slice(0, 8)} 等——不得视为已完成）`,
      };
    }
  }
  return { verdict: "match", record: treasuryBoundedDeepFreezeSnapshot(record) as TreasuryHistoricalCompletionRecord };
}

// ── 统一 archive 入口（completion destructive release 的唯一生产权威）──────

export type TreasuryCompletionArchiveBlockReason =
  | "completion_store_unhealthy"
  | "supersession_store_unhealthy"
  | "completion_conflict"
  | "completion_absent_without_authority"
  | "replacement_conflict"
  | "replacement_absent"
  | "replacement_store_unhealthy"
  | "supersession_identity_conflict"
  | "capacity_exhausted"
  | "authority_write_failure"
  | "read_back_failure"
  | "delete_failure"
  | "delete_read_back_failure";

export type TreasuryCompletionArchiveResult =
  | { readonly status: "archived"; readonly detail: string }
  | { readonly status: "already_archived"; readonly detail: string }
  /** completion 与 historical authority 均不存在（无可归档事实）。 */
  | { readonly status: "absent"; readonly detail: string }
  /** fault 注入：authority 写入成功后、completion 删除前中断（两者并存——幂等重入）。 */
  | { readonly status: "interrupted"; readonly phase: "authority_written"; readonly detail: string }
  | { readonly status: "blocked"; readonly reason: TreasuryCompletionArchiveBlockReason; readonly detail: string };

/** test-only fault 注入（T7 中断窗口）——生产恒为 null。 */
export type TreasurySupersessionArchiveFaultStep =
  | "before-authority-write"
  | "after-authority-write"
  | "corrupt-authority-readback"
  | "resurrect-after-delete";

let archiveFaultStep: TreasurySupersessionArchiveFaultStep | null = null;

export function injectTreasurySupersessionArchiveFaultForTest(
  step: TreasurySupersessionArchiveFaultStep | null,
): void {
  archiveFaultStep = step;
}

/**
 * completion → durable historical authority 的统一归档/交接（所有 completion
 * destructive release 的唯一生产入口）。固定顺序：
 *
 *  1. 读取并验证原 completion（store 健康 + shape 完整）；
 *  2. 验证 settlement outcome（via 指定 replacement 时与 replacement exact
 *     比较——outcome 相反/维度冲突即 blocked，completion 保留）；
 *  3. 写入 durable historical authority（outcome + canonical exact identity
 *     压缩归档）；
 *  4. authority Memory read-back 全维度验证（失败回滚 authority，completion
 *     保留）；
 *  5. 删除 completion（底层 release 仅为本模块私有实现细节）；
 *  6. completion 删除 read-back absent（失败返回 blocked——historical 已在，
 *     下 tick 幂等重删）；
 *  7. 返回结构化结果。
 *
 * via："gra-proof" / "terminal-summary" / "final-tombstone" 要求对应
 * replacement exact superseded；"any-exact" 三路任一成立；"compact-archive"
 * 不要求 replacement（completion 自身已完整验证——安全压缩语义，用于
 * headroom 回收）。幂等：completion 已不在但 historical 在位 →
 * already_archived；两者均不在 → absent。
 */
export function archiveTreasuryCleanupCompletionViaAuthority(input: {
  readonly transactionId: string;
  readonly via: "gra-proof" | "terminal-summary" | "final-tombstone" | "any-exact" | "compact-archive";
}): TreasuryCompletionArchiveResult {
  const transactionId = input.transactionId;
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  if (!completionHealth.healthy) {
    return { status: "blocked", reason: "completion_store_unhealthy", detail: `completion store unhealthy: ${completionHealth.detail}（零删除——fail closed）` };
  }
  const completion = lookupTreasuryCleanupCompletion(transactionId);
  if (completion.verdict === "store_unhealthy") {
    return { status: "blocked", reason: "completion_store_unhealthy", detail: `completion store unhealthy: ${completion.detail}` };
  }
  if (completion.verdict === "conflict") {
    return { status: "blocked", reason: "completion_conflict", detail: `completion 单条复验失败: ${completion.detail}（零删除——fail closed）` };
  }
  if (completion.verdict === "absent") {
    // completion 已不在：historical authority 在位即已完成交接（幂等）。
    const historical = lookupTreasuryHistoricalCompletion(transactionId);
    if (historical.verdict === "match") {
      return { status: "already_archived", detail: "completion 已回收且 historical authority 在位（交接已完成——幂等）" };
    }
    if (historical.verdict === "store_unhealthy") {
      return { status: "blocked", reason: "supersession_store_unhealthy", detail: `historical authority store unhealthy: ${historical.detail}` };
    }
    return { status: "absent", detail: "completion 与 historical authority 均不存在（无可归档事实）" };
  }
  const proof = completion.proof;
  // via 指定 replacement 时：exact 验证（outcome + 全维度 identity）。
  if (input.via !== "compact-archive") {
    if (replacementProbes === null) {
      return { status: "blocked", reason: "replacement_store_unhealthy", detail: "completion replacement probes 未装配（fail closed——supersession 不可证明）" };
    }
    const allowedVia =
      input.via === "any-exact"
        ? (["gra-proof", "terminal-summary", "final-tombstone"] as const)
        : ([input.via] as readonly ("gra-proof" | "terminal-summary" | "final-tombstone")[]);
    const replacement = verifyTreasuryExactCompletionReplacement({
      transactionId,
      completion: proof,
      allowedVia,
    });
    if (replacement.verdict === "conflict") {
      return { status: "blocked", reason: "replacement_conflict", detail: `replacement 验证冲突（completion 保留——零删除）: ${replacement.detail}` };
    }
    if (replacement.verdict === "store_unhealthy") {
      return { status: "blocked", reason: "replacement_store_unhealthy", detail: `replacement store unhealthy（completion 保留）: ${replacement.detail}` };
    }
    if (replacement.verdict === "no_replacement") {
      return { status: "blocked", reason: "replacement_absent", detail: "要求 exact replacement 但三路均不成立（completion 保留——fail closed）" };
    }
  }
  // historical authority：健康 + 幂等 + 容量。
  const supersessionRuntime = loadSupersessionRuntime();
  if (supersessionRuntime.fatal !== null) {
    return { status: "blocked", reason: "supersession_store_unhealthy", detail: `supersession store fail-closed: ${supersessionRuntime.fatal}（completion 保留）` };
  }
  const key = SUPERSESSION_KEY_PREFIX + transactionId;
  const candidate: TreasuryHistoricalCompletionRecord = cloneTreasuryDurableValue({
    schemaVersion: TREASURY_CLEANUP_SUPERSESSION_VERSION,
    transactionId: proof.transactionId,
    resolution: proof.resolution,
    identity: { ...proof.identity },
    lineageDisposition: proof.lineageDisposition,
    via: input.via === "any-exact" ? "gra-proof" : input.via,
    archivedAtTick: Game.time,
  });
  const existing = supersessionRuntime.store.entries[key];
  if (existing !== undefined) {
    // 【Remediation VII 修复三】existing record 在任何删除决策前必须完整
    // shape revalidation（schemaVersion / archivedAtTick 安全整数 / via 枚举
    // / profile↔class / 键一致 / digest hex / lineage 矩阵）——热缓存后
    // 被原地篡改（非身份字段）不得在删除 live completion 之后才暴露。
    const existingShapeError = validateHistoricalRecordShape(existing, key);
    if (existingShapeError !== null) {
      return {
        status: "blocked",
        reason: "supersession_store_unhealthy",
        detail: `已存在 historical record 损坏: ${existingShapeError}（completion 保留——零删除，fail closed）`,
      };
    }
    // 幂等：已存在 historical record 必须与 completion 在全部持久维度一致
    //（archivedAtTick/via 除外）——身份或 outcome 冲突 → blocked（不覆盖）。
    const sameRecord =
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
    if (!sameRecord) {
      return { status: "blocked", reason: "supersession_identity_conflict", detail: "historical authority 已存在身份不一致的 record（不覆盖旧权威——fail closed，completion 保留）" };
    }
    // authority 已在且一致 → 直接进入删除阶段（中断窗口 B 的幂等继续）。
    return deleteCompletionAfterAuthority(transactionId);
  }
  if (supersessionRuntime.store.entryCount >= TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES) {
    return {
      status: "blocked",
      reason: "capacity_exhausted",
      detail: `historical authority 满载（${String(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES)}——completion 保留 fail closed，不得删除旧安全事实）`,
    };
  }
  if (archiveFaultStep === "before-authority-write") {
    return { status: "blocked", reason: "authority_write_failure", detail: "fault 注入：authority 写入前中断（completion 保留）" };
  }
  // 写入独立 clone（heap store 与 Memory 权威同对象——candidate 引用不得
  // 同时充当比较基准，否则写入窗口内的篡改会同步进 candidate 使 read-back
  // 比较恒真）。
  supersessionRuntime.store.entries[key] = cloneTreasuryDurableValue(candidate);
  supersessionRuntime.store.entryCount += 1;
  supersessionRuntime.store.updatedAt = Game.time;
  // authority Memory read-back：直读权威 store 单 key + 全维度比较。
  if (archiveFaultStep === "corrupt-authority-readback") {
    // 模拟 read-back 前外部篡改（Memory 中的 durable 拷贝被改写——read-back
    // 全维度比较必须拦截并回滚 authority，completion 保留）。
    const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury?.cleanupSupersessions;
    const durableEntry = rawStore?.entries[key] as { identity?: { digest?: string } } | undefined;
    if (durableEntry?.identity !== undefined) {
      durableEntry.identity.digest = "9999999999999999";
    }
  }
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury?.cleanupSupersessions;
  if (rawStore === undefined) {
    delete supersessionRuntime.store.entries[key];
    supersessionRuntime.store.entryCount -= 1;
    return { status: "blocked", reason: "read_back_failure", detail: "authority 写入后 Memory read-back store 缺失（已回滚，completion 保留）" };
  }
  const readBack = rawStore.entries[key];
  const readBackError = readBack === undefined ? "read-back record 缺失" : validateHistoricalRecordShape(readBack, key);
  if (readBackError !== null) {
    delete supersessionRuntime.store.entries[key];
    supersessionRuntime.store.entryCount -= 1;
    return { status: "blocked", reason: "read_back_failure", detail: `authority read-back 失败: ${readBackError}（已回滚，completion 保留）` };
  }
  const readBackRecord = readBack as TreasuryHistoricalCompletionRecord;
  const readBackEqual =
    readBackRecord.transactionId === candidate.transactionId &&
    readBackRecord.resolution === candidate.resolution &&
    readBackRecord.identity.digest === candidate.identity.digest &&
    readBackRecord.identity.identityProfile === candidate.identity.identityProfile &&
    readBackRecord.identity.proofClass === candidate.identity.proofClass &&
    (readBackRecord.identity.contractDigest ?? undefined) === (candidate.identity.contractDigest ?? undefined) &&
    (readBackRecord.identity.authorizationCohortDigest ?? undefined) === (candidate.identity.authorizationCohortDigest ?? undefined) &&
    (readBackRecord.identity.durableIdentityDigest ?? undefined) === (candidate.identity.durableIdentityDigest ?? undefined) &&
    (readBackRecord.identity.lowlevelSource ?? undefined) === (candidate.identity.lowlevelSource ?? undefined) &&
    (readBackRecord.identity.lineageId ?? undefined) === (candidate.identity.lineageId ?? undefined) &&
    (readBackRecord.identity.lineageGeneration ?? undefined) === (candidate.identity.lineageGeneration ?? undefined) &&
    (readBackRecord.identity.parentTransactionId ?? undefined) === (candidate.identity.parentTransactionId ?? undefined) &&
    (readBackRecord.identity.lineageBindingDigest ?? undefined) === (candidate.identity.lineageBindingDigest ?? undefined) &&
    readBackRecord.lineageDisposition === candidate.lineageDisposition &&
    readBackRecord.resolution === proof.resolution;
  if (!readBackEqual) {
    delete supersessionRuntime.store.entries[key];
    supersessionRuntime.store.entryCount -= 1;
    return { status: "blocked", reason: "read_back_failure", detail: "authority read-back 身份或 outcome 不一致（已回滚，completion 保留）" };
  }
  if (archiveFaultStep === "after-authority-write") {
    return { status: "interrupted", phase: "authority_written", detail: "fault 注入：authority 写入成功后、completion 删除前中断（两者并存——重入幂等继续）" };
  }
  return deleteCompletionAfterAuthority(transactionId);
}

function deleteCompletionAfterAuthority(transactionId: string): TreasuryCompletionArchiveResult {
  // 【Remediation VII 修复三】删除的最后一步之前，再从 Memory 权威直读
  // historical record 并完整验证一次（shape 全维度 + 在位）——不依赖模块
  // load 时的全表验证，也不让 heap 缓存对象充当唯一基准。record 缺失或
  // 损坏 → blocked（completion 保留，fail closed）。
  {
    const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithSupersessions | undefined)?.treasury?.cleanupSupersessions;
    const key = SUPERSESSION_KEY_PREFIX + transactionId;
    const durableRecord = rawStore?.entries[key];
    const durableError = durableRecord === undefined
      ? "Memory 权威中 historical record 缺失（heap 与 Memory 不一致）"
      : validateHistoricalRecordShape(durableRecord, key);
    if (durableError !== null) {
      return {
        status: "blocked",
        reason: "supersession_store_unhealthy",
        detail: `删除前 Memory 直读复验失败: ${durableError}（completion 保留——零删除，fail closed）`,
      };
    }
  }
  // authority 已持久验证 → 删除 completion → 删除 read-back absent。
  const released = releaseTreasuryCleanupCompletionOfAttempt(transactionId);
  if (!released) {
    return { status: "blocked", reason: "delete_failure", detail: `completion ${transactionId.slice(0, 12)} 删除失败（historical authority 已在——下 tick 幂等重删）` };
  }
  if (archiveFaultStep === "resurrect-after-delete") {
    // 模拟删除后、read-back 前的持久化竞争（entry 又出现——absent 确认失败；
    // 形状非法不会被 lookup 判 match，store shape 校验将 fail closed）。
    const completionStore = (Memory.runtime as unknown as {
      treasury?: { cleanupCompletions?: { entries?: Record<string, unknown>; entryCount?: number } };
    }).treasury?.cleanupCompletions;
    if (completionStore !== undefined) {
      completionStore.entries = completionStore.entries ?? {};
      completionStore.entries[`cc:${transactionId}`] = { __faultResurrected: true };
      completionStore.entryCount = (completionStore.entryCount ?? 0) + 1;
    }
  }
  // 删除 read-back：直读 completion store 单 key（absent 才算交接完成；store
  // fatal / entry 仍在 → delete_read_back_failure，下 tick 幂等重删）。
  const afterDelete = lookupTreasuryCleanupCompletion(transactionId);
  if (afterDelete.verdict !== "absent") {
    return {
      status: "blocked",
      reason: "delete_read_back_failure",
      detail: `completion ${transactionId.slice(0, 12)} 删除后 read-back 仍存在/不可读（historical authority 已在——下 tick 幂等重删，pending 语义）`,
    };
  }
  return { status: "archived", detail: "completion 已验证归档至 durable historical authority（outcome + exact identity 交接完成，删除 read-back absent）" };
}

// ── state-changing headroom preflight（满载活性）──────────────────────────

export type TreasuryCompletionHeadroomPreflight =
  | { readonly status: "ok"; readonly reclaimed: number; readonly detail: string }
  | { readonly status: "headroom_exhausted"; readonly reclaimed: number; readonly detail: string }
  | { readonly status: "store_unhealthy"; readonly reclaimed: 0; readonly detail: string };

/**
 * completion 容量 preflight（state-changing 路径专用——authorize / prepare /
 * execute 在拒绝前调用；query 保持零写）：
 *
 * 1. completion / historical store unhealthy → store_unhealthy（零 archive、
 *    零删除——不得折叠为"无可回收项"）；
 * 2. headroom 足够（entryCount + minSlots ≤ MAX）→ ok（零写零扫描）；
 * 3. bounded（≤completion 硬容量）exact archive 回收：逐条 compact-archive
 *    （completion 自身完整验证 + authority 写入 read-back + 删除 read-back），
 *    单条 store 级失败立即停止（已回收项均有 durable authority）；
 * 4. 复查容量：足够 → ok；不足 → headroom_exhausted（completion 均保留）。
 */
export function ensureTreasuryCleanupCompletionHeadroom(input: {
  readonly minSlots: number;
}): TreasuryCompletionHeadroomPreflight {
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  if (!completionHealth.healthy) {
    return { status: "store_unhealthy", reclaimed: 0, detail: `completion store unhealthy: ${completionHealth.detail}（零回收零删除——fail closed）` };
  }
  const supersessionHealth = peekTreasuryCleanupSupersessionHealth();
  if (!supersessionHealth.healthy) {
    return { status: "store_unhealthy", reclaimed: 0, detail: `historical authority store unhealthy: ${supersessionHealth.detail}（零回收零删除——fail closed）` };
  }
  if (replacementProbes === null) {
    return { status: "store_unhealthy", reclaimed: 0, detail: "completion replacement probes 未装配（fail closed——不回收）" };
  }
  const entryCount = peekTreasuryCleanupCompletionEntryCount();
  if (entryCount < 0) {
    return { status: "store_unhealthy", reclaimed: 0, detail: "completion store 超容（entryCount 探测失败——fail closed）" };
  }
  // 【Remediation VII 修复二】独占 reservation 计入占用：live completion +
  // reserved slots ≤ 硬容量 恒成立——已被其它 transaction 预留的槽不算
  // headroom（"检查当前还有一个槽"不是 reservation）。
  const reservedCount = peekTreasuryCompletionHeadroomReservationCount();
  if (entryCount + reservedCount + input.minSlots <= TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES) {
    return { status: "ok", reclaimed: 0, detail: `headroom 充足（live ${String(entryCount)} + reserved ${String(reservedCount)}/${String(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES)}——零回收）` };
  }
  let reclaimed = 0;
  for (const transactionId of replacementProbes.listCompletionTransactionIds()) {
    if (
      peekTreasuryCleanupCompletionEntryCount() + peekTreasuryCompletionHeadroomReservationCount() + input.minSlots
      <= TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES
    ) break;
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    if (archived.status === "archived") {
      reclaimed += 1;
      continue;
    }
    if (archived.status === "already_archived" || archived.status === "absent") {
      // completion 不在（并发回收/手工构造）——继续下一条。
      continue;
    }
    if (archived.status === "interrupted") {
      return { status: "headroom_exhausted", reclaimed, detail: `archive 中断（${archived.detail}——停止回收）` };
    }
    // store 级失败（unhealthy / 容量 / read-back / delete）→ 立即停止；
    // 单条身份冲突（completion/supersession/replacement conflict）→ 跳过
    // 该条继续 bounded 扫描。
    if (
      archived.reason === "supersession_identity_conflict" ||
      archived.reason === "completion_conflict" ||
      archived.reason === "replacement_conflict" ||
      archived.reason === "replacement_absent"
    ) {
      continue;
    }
    return {
      status: "headroom_exhausted",
      reclaimed,
      detail: `archive 停止（${archived.reason}: ${archived.detail}）——已回收 ${String(reclaimed)} 条均有 durable authority`,
    };
  }
  const afterCount = peekTreasuryCleanupCompletionEntryCount();
  if (
    afterCount >= 0 &&
    afterCount + peekTreasuryCompletionHeadroomReservationCount() + input.minSlots <= TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES
  ) {
    return { status: "ok", reclaimed, detail: `headroom preflight 回收 ${String(reclaimed)} 条（exact archive + read-back）后容量恢复` };
  }
  return {
    status: "headroom_exhausted",
    reclaimed,
    detail: `满载且无更多安全可回收项（回收 ${String(reclaimed)} 条后仍 live ${String(afterCount)} + reserved ${String(peekTreasuryCompletionHeadroomReservationCount())}/${String(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES)}——fail closed，completion 均保留）`,
  };
}

/**
 * 【诊断/测试】按 attempt ID 查询 exact 历史完成权威状态（generation-
 * addressable tr1_ ID 直接 O(1) 单 key 查询）。
 */
export function verifyTreasuryHistoricalCompletionStatus(transactionId: string): {
  readonly verdict: "match" | "absent" | "conflict" | "store_unhealthy";
  readonly settlement: "committed" | "not-executed" | null;
  readonly detail: string;
} {
  const lookup = lookupTreasuryHistoricalCompletion(transactionId);
  if (lookup.verdict === "match") {
    return { verdict: "match", settlement: lookup.record.resolution, detail: `historical authority 在位（outcome=${lookup.record.resolution}）` };
  }
  if (lookup.verdict === "absent") {
    return { verdict: "absent", settlement: null, detail: "无 historical completion authority" };
  }
  return { verdict: lookup.verdict, settlement: null, detail: lookup.detail };
}
