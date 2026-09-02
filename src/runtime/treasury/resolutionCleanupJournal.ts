/**
 * 【第二十二轮第七节】resolution cleanup journal——committed 与
 * not-executed 共用的持久 cleanup 状态机。
 *
 * Round 21 及之前 marker 清理是一次 best-effort 调用：committed finalize
 * 无任何 marker-cleanup pending 阶段（clear 失败仅靠全局锁被动阻断）；
 * not-executed 的 pendingReleaseIds 在 clear 调用后被无条件移除；
 * global reset 后两类 cleanup 无法从 Memory 区分"settlement proof 已
 * 持久化 / marker discharge / authority release / outcome 终态 /
 * lineage 终态"五个中断窗口。
 *
 * 本 journal 是独立持久 store（Memory.runtime.treasury.resolutionCleanup）：
 * - entry 在 settlement/resolution proof 持久化时创建（携带完整 attempt
 *   exact identity——重建 discharge expected 不依赖 heap）；
 * - 四个持久阶段布尔（markerDischarged / authorityReleased /
 *   outcomeFinalized / lineageFinalized）单调推进，每个中断窗口可区分；
 * - journal 自身即 pending 索引（entry 完成即删），global reset 后遍历
 *   journal 重建——不依赖 heap Set；
 * - 恢复编排（recoverTreasuryResolutionCleanupAtTickBoundary）按安全顺序
 *   补完成：marker discharge → authority release（read-back not_found）→
 *   outcome 终态 proof → lineage 终态；重操作经装配注入的 stage handlers
 *   （facade 装配，production 未装配 fail closed）。
 *
 * 安全顺序（七.2）：marker 清除时 Authority 仍在（可继续阻断 writer）；
 * 即使清 marker 后中断，Intent/Quarantine 仍阻断——不再形成
 * "Authority 已删、Marker 无法证明"的孤儿状态。
 *
 * 【Round 22 Remediation II】journal 成为不可绕过的持久恢复所有权门禁：
 * - reservation 模式（A.6）：not-executed 路径在消费 capability 之前以
 *   settlementProofDurable=false 的持久 admission 取得 cleanup 所有权；
 * - activate/revoke（A.5/A.6）：proof 落盘后激活；回滚路径只撤销"本次
 *   创建、exact identity 一致、零阶段推进"的 entry；
 * - 完整 load 校验（D.1-D.3）：entry identity 形状、store 不变量、阶段
 *   偏序、reservation 约束；
 * - 恢复不信任阶段 boolean（D.4）：每阶段经幂等外部事实验证后推进。
 */

import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
  type TreasuryMarkerDischargeOutcome,
} from "@/runtime/treasury/markerDischarge";
import {
  TREASURY_IDENTITY_PROFILES,
  treasuryProofClassOfIdentityProfile,
  treasuryIdentityProfileOfProofClass,
  validateTreasuryIdentityProfileFacts,
  type TreasuryIdentityProfile,
} from "@/runtime/treasury/identityProfile";

export const TREASURY_RESOLUTION_CLEANUP_VERSION = 1;
export const TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES = 256;
const CLEANUP_KEY_PREFIX = "c:";

/**
 * 【Round 22 remediation B】open 输入的单一构造权威：identity profile 按
 * proof class 唯一映射（未知 → legacy-replay 隔离），全部身份字段按携带
 * 透传——所有生产调用点（faultResolution / resolutionStore 恢复 /
 * resolutionAuthority / facade executed-aborted）共用同一字段集构造，
 * 幂等 reopen 的 exact 相等比较不因调用点构造差异产生伪 conflict。
 */
export function treasuryResolutionCleanupOpenInputOfFacts(facts: {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: "committed" | "not-executed";
  readonly proofClass: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: "committed" | "not-executed";
  readonly identityProfile: TreasuryIdentityProfile;
  readonly proofClass: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
} {
  return {
    transactionId: facts.transactionId,
    digest: facts.digest,
    resolution: facts.resolution,
    identityProfile: treasuryIdentityProfileOfProofClass(facts.proofClass) ?? "legacy-replay",
    proofClass: facts.proofClass,
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

/** cleanup entry：完整 attempt exact identity + 四阶段持久布尔。 */
export interface TreasuryResolutionCleanupEntry {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: "committed" | "not-executed";
  readonly identityProfile: TreasuryIdentityProfile;
  readonly proofClass: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
  /**
   * settlement/resolution proof 是否已持久化：proof_durable 模式 open 创建
   * 即 true（proof 已在 open 前落盘）；【Remediation II A.6】reservation
   * 模式创建为 false——不谎称 proof durable，proof 写入成功后经
   * activateTreasuryResolutionCleanupProof（或恢复路径的 proof_durable open
   * 幂等激活）推进为 true；false 期间任何阶段标记都被拒绝。
   */
  settlementProofDurable: boolean;
  markerDischarged: boolean;
  markerDischargeOutcome?: string;
  authorityReleased: boolean;
  outcomeFinalized: boolean;
  lineageFinalized: boolean;
  readonly openedAtTick: number;
  updatedAt: number;
}

export interface TreasuryResolutionCleanupStore {
  readonly version: typeof TREASURY_RESOLUTION_CLEANUP_VERSION;
  entries: Record<string, TreasuryResolutionCleanupEntry>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithCleanup {
  resolutionCleanup?: TreasuryResolutionCleanupStore;
}

type RuntimeMemoryWithCleanup = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithCleanup;
};

/** journal 阶段（持久布尔 ↔ 阶段名映射；单调推进）。 */
export type TreasuryResolutionCleanupStage =
  | "marker_discharge"
  | "authority_release"
  | "outcome_finalization"
  | "lineage_finalization";

/** 恢复编排的阶段处理器（facade 装配——重操作不进 journal 模块解依赖环）。 */
export interface TreasuryResolutionCleanupStageHandlers {
  /** authority 释放（committed：trusted receipt 验证后；not-executed：final tombstone 依据）。 */
  readonly authorityRelease: (
    entry: Readonly<TreasuryResolutionCleanupEntry>,
  ) => { readonly status: "released" | "already_absent" | "blocked"; readonly detail: string };
  /** outcome 终态（committed：final tombstone；not-executed：exact GRA proof converge）。 */
  readonly outcomeFinalization: (
    entry: Readonly<TreasuryResolutionCleanupEntry>,
  ) => { readonly status: "finalized" | "already_final" | "blocked"; readonly detail: string };
  /** lineage 终态（committed：chain_committed；not-executed：rearm_ready/non_rearmable）。 */
  readonly lineageFinalization: (
    entry: Readonly<TreasuryResolutionCleanupEntry>,
  ) => { readonly status: "finalized" | "already_final" | "not_applicable" | "blocked"; readonly detail: string };
}

let stageHandlers: TreasuryResolutionCleanupStageHandlers | null = null;

/** 装配入口（facade 模块加载时注册；test reset 传 null 重入）。 */
export function registerTreasuryResolutionCleanupHandlersForAssembly(
  handlers: TreasuryResolutionCleanupStageHandlers | null,
): void {
  stageHandlers = handlers;
}

export interface TreasuryResolutionCleanupEvents {
  opened: number;
  reopened: number;
  conflicts: number;
  markerDischarges: number;
  markerDischargeBlocks: number;
  stageAdvances: number;
  completed: number;
  /** 【Remediation II A.5】回滚路径安全撤销的 reservation/新建 entry 计数。 */
  revocations: number;
  recoveryBlocked: number;
  shapeFailures: number;
  capacityBlocked: number;
}

const cleanupEvents: TreasuryResolutionCleanupEvents = {
  opened: 0,
  reopened: 0,
  conflicts: 0,
  markerDischarges: 0,
  markerDischargeBlocks: 0,
  stageAdvances: 0,
  completed: 0,
  revocations: 0,
  recoveryBlocked: 0,
  shapeFailures: 0,
  capacityBlocked: 0,
};

export function readTreasuryResolutionCleanupEvents(): Readonly<TreasuryResolutionCleanupEvents> {
  return cleanupEvents;
}

export function resetTreasuryResolutionCleanupEventsForTest(): void {
  cleanupEvents.opened = 0;
  cleanupEvents.reopened = 0;
  cleanupEvents.conflicts = 0;
  cleanupEvents.markerDischarges = 0;
  cleanupEvents.markerDischargeBlocks = 0;
  cleanupEvents.stageAdvances = 0;
  cleanupEvents.completed = 0;
  cleanupEvents.revocations = 0;
  cleanupEvents.recoveryBlocked = 0;
  cleanupEvents.shapeFailures = 0;
  cleanupEvents.capacityBlocked = 0;
}

function cleanupBranch(): TreasuryMemoryBranchWithCleanup {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithCleanup;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/**
 * 【Remediation II D.1】entry identity 完整形状验证（复用 identityProfile
 * 单一语义源）：profile 合法枚举 + profile↔proofClass 唯一映射 + profile
 * required/forbidden 矩阵 + lineage 四字段整体性（tr1_ 必携带、initial 禁带）
 * + generation/时间字段形状。返回 null = 合法。
 */
function validateCleanupEntryIdentity(
  entry: Partial<TreasuryResolutionCleanupEntry>,
  key: string,
): string | null {
  if (!TREASURY_IDENTITY_PROFILES.has(entry.identityProfile as never)) {
    return `cleanup entry ${key.slice(0, 8)} identityProfile 非法枚举: ${String(entry.identityProfile).slice(0, 32)}`;
  }
  if (
    typeof entry.proofClass !== "string" ||
    treasuryProofClassOfIdentityProfile(entry.identityProfile as TreasuryIdentityProfile) !== entry.proofClass
  ) {
    return `cleanup entry ${key.slice(0, 8)} identityProfile 与 proofClass 不满足唯一合法组合（${String(entry.identityProfile)} vs ${String(entry.proofClass)}）`;
  }
  const profileError = validateTreasuryIdentityProfileFacts(entry.identityProfile as TreasuryIdentityProfile, {
    digest: entry.digest,
    contractDigest: entry.contractDigest,
    authorizationCohortDigest: entry.authorizationCohortDigest,
    durableIdentityDigest: entry.durableIdentityDigest,
    lowlevelSource: entry.lowlevelSource,
  });
  if (profileError !== null) {
    return `cleanup entry ${key.slice(0, 8)} ${profileError}`;
  }
  // lineage 四字段整体性 + tr1_/initial 携带矩阵。
  const lineageFields = ["lineageId", "lineageGeneration", "parentTransactionId", "lineageBindingDigest"] as const;
  const presentLineage = lineageFields.filter((field) => entry[field] !== undefined);
  if (presentLineage.length !== 0 && presentLineage.length !== lineageFields.length) {
    return `cleanup entry ${key.slice(0, 8)} lineage 字段必须整体存在或整体缺失（部分携带: ${presentLineage.join(",")}）`;
  }
  if (presentLineage.length === lineageFields.length) {
    if (typeof entry.lineageId !== "string" || entry.lineageId.length === 0) {
      return `cleanup entry ${key.slice(0, 8)} lineageId 非法`;
    }
    if (typeof entry.lineageGeneration !== "number" || !Number.isSafeInteger(entry.lineageGeneration) || entry.lineageGeneration < 1) {
      return `cleanup entry ${key.slice(0, 8)} lineageGeneration 非安全正整数`;
    }
    if (typeof entry.parentTransactionId !== "string" || entry.parentTransactionId.length === 0) {
      return `cleanup entry ${key.slice(0, 8)} parentTransactionId 非法`;
    }
    if (typeof entry.lineageBindingDigest !== "string" || entry.lineageBindingDigest.length === 0) {
      return `cleanup entry ${key.slice(0, 8)} lineageBindingDigest 非法`;
    }
    // 注：tr1_↔lineage 绑定判定是 transactionId 模块的单一权威 + facade
    // 门禁边界——本模块不复制该判定（架构边界测试守护）；此处只承载
    // 四字段整体性。
  }
  if (!Number.isSafeInteger(entry.openedAtTick) || (entry.openedAtTick as number) < 0) {
    return `cleanup entry ${key.slice(0, 8)} openedAtTick 非安全非负整数`;
  }
  if (!Number.isSafeInteger(entry.updatedAt) || (entry.updatedAt as number) < 0) {
    return `cleanup entry ${key.slice(0, 8)} updatedAt 非安全非负整数`;
  }
  return null;
}

/**
 * store 完整形状自检（【Remediation II D.2/D.3】）：version / entries 原型 /
 * 键前缀与 transactionId 一致 / entry 基础字段与完整 identity 形状 /
 * settlementProofDurable 布尔 + reservation 期间阶段全 false / 阶段偏序
 * （marker → authority → outcome → lineage）/ entryCount 精确 / 硬容量。
 * 损坏必须结构化 unhealthy——不得折叠成"entry 不存在"或"pending 为空"。
 */
function validateCleanupStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "cleanup journal 非对象";
  const candidate = store as Partial<TreasuryResolutionCleanupStore>;
  if (candidate.version !== TREASURY_RESOLUTION_CLEANUP_VERSION) {
    return `cleanup journal 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "cleanup journal.entries 非对象";
  const entriesProto = Object.getPrototypeOf(candidate.entries);
  if (entriesProto !== Object.prototype && entriesProto !== null) {
    return "cleanup journal.entries 原型非普通对象（非法持久值）";
  }
  const keys = Object.keys(candidate.entries);
  if (keys.length > TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES) {
    return `cleanup journal 超过硬容量 ${String(TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES)}（实际 ${String(keys.length)}）`;
  }
  for (const key of keys) {
    if (key === "__proto__" || !key.startsWith(CLEANUP_KEY_PREFIX)) return `cleanup journal 键 ${key.slice(0, 8)} 缺少前缀`;
    const entry = candidate.entries[key] as Partial<TreasuryResolutionCleanupEntry> | undefined;
    if (!entry || typeof entry !== "object") return `cleanup entry ${key.slice(0, 8)} 非对象`;
    const entryProto = Object.getPrototypeOf(entry);
    if (entryProto !== Object.prototype && entryProto !== null) {
      return `cleanup entry ${key.slice(0, 8)} 原型非普通对象（非法持久值）`;
    }
    if (typeof entry.transactionId !== "string" || entry.transactionId.length === 0) return `cleanup entry ${key.slice(0, 8)} transactionId 非法`;
    if (key !== CLEANUP_KEY_PREFIX + entry.transactionId) return `cleanup entry ${key.slice(0, 8)} 键与 transactionId 不一致`;
    if (entry.resolution !== "committed" && entry.resolution !== "not-executed") return `cleanup entry ${key.slice(0, 8)} resolution 非法`;
    if (typeof entry.digest !== "string" || entry.digest.length === 0) return `cleanup entry ${key.slice(0, 8)} digest 非法`;
    const identityError = validateCleanupEntryIdentity(entry, key);
    if (identityError !== null) return identityError;
    if (typeof entry.settlementProofDurable !== "boolean") return `cleanup entry ${key.slice(0, 8)} settlementProofDurable 非布尔`;
    for (const stage of ["markerDischarged", "authorityReleased", "outcomeFinalized", "lineageFinalized"] as const) {
      if (typeof entry[stage] !== "boolean") return `cleanup entry ${key.slice(0, 8)} 阶段 ${stage} 非布尔`;
    }
    // D.3 阶段偏序 + reservation 约束（settlementProofDurable=false 时全 false）。
    if (!entry.settlementProofDurable && (entry.markerDischarged || entry.authorityReleased || entry.outcomeFinalized || entry.lineageFinalized)) {
      return `cleanup entry ${key.slice(0, 8)} reservation（proof 未 durable）携带已推进阶段`;
    }
    if (entry.authorityReleased && !entry.markerDischarged) {
      return `cleanup entry ${key.slice(0, 8)} 阶段越级（authorityReleased 先于 markerDischarged）`;
    }
    if (entry.outcomeFinalized && !entry.authorityReleased) {
      return `cleanup entry ${key.slice(0, 8)} 阶段越级（outcomeFinalized 先于 authorityReleased）`;
    }
    if (entry.lineageFinalized && !entry.outcomeFinalized) {
      return `cleanup entry ${key.slice(0, 8)} 阶段越级（lineageFinalized 先于 outcomeFinalized）`;
    }
  }
  if (candidate.entryCount !== keys.length) return `cleanup journal entryCount ${String(candidate.entryCount)} != ${String(keys.length)}`;
  return null;
}

interface CleanupRuntime {
  store: TreasuryResolutionCleanupStore;
  fatal: string | null;
}

let heapRuntime: CleanupRuntime | null = null;

function loadCleanupRuntime(): CleanupRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCleanup | undefined)?.treasury?.resolutionCleanup;
  if (raw === undefined) {
    const store: TreasuryResolutionCleanupStore = {
      version: TREASURY_RESOLUTION_CLEANUP_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    // 【Round 22 remediation A.1/A.2】首次初始化必须把新 store 真正挂到
    // Memory.runtime.treasury.resolutionCleanup——heap 缓存只是同一 Memory
    // 权威 store 的引用，global reset 后从 Memory 原样恢复（不依赖 heap）。
    cleanupBranch().resolutionCleanup = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateCleanupStoreShape(raw);
  if (shapeError !== null) {
    cleanupEvents.shapeFailures += 1;
    heapRuntime = { store: raw as unknown as TreasuryResolutionCleanupStore, fatal: shapeError };
    return heapRuntime;
  }
  heapRuntime = { store: raw as unknown as TreasuryResolutionCleanupStore, fatal: null };
  return heapRuntime;
}

/** journal store 结构化健康探测（destructive caller 门禁——不得折叠为 entry absent）。 */
export interface TreasuryResolutionCleanupHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/**
 * 【Round 22 remediation A.5】cleanup journal 健康探测（只读）：store 不存在
 * 或形状合法 → healthy；损坏 → unhealthy。destructive caller（GRA 孤儿
 * proof 清理等）遇 unhealthy 必须 retained/fail closed——不得把
 * readTreasuryResolutionCleanupEntry 的 undefined（fatal 与 absent 同形）
 * 当作"无 pending cleanup"。
 */
export function peekTreasuryResolutionCleanupHealth(): TreasuryResolutionCleanupHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCleanup | undefined)?.treasury?.resolutionCleanup;
  if (raw === undefined) return { healthy: true, detail: null };
  const shapeError = validateCleanupStoreShape(raw);
  if (shapeError !== null) {
    cleanupEvents.shapeFailures += 1;
    return { healthy: false, detail: shapeError };
  }
  return { healthy: true, detail: null };
}

/** test-only：删除 Memory 中的 durable 数据（heap 缓存一并失效）。 */
export function clearTreasuryResolutionCleanupDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithCleanup | undefined)?.treasury;
  if (branch !== undefined) delete branch.resolutionCleanup;
  heapRuntime = null;
  resetTreasuryResolutionCleanupEventsForTest();
}

/**
 * test-only：只清 heap 缓存、不删除 Memory——模拟 global reset 后的
 * 首次访问（下次 load 从 Memory 权威恢复全部 entry 与阶段进度）。
 */
export function resetTreasuryResolutionCleanupHeapCacheForTest(): void {
  heapRuntime = null;
}

/** test 完全清理（Memory + heap + events；测试 setup 用，不用于模拟 global reset）。 */
export function resetTreasuryResolutionCleanupForTest(): void {
  clearTreasuryResolutionCleanupDurableForTest();
}

export type TreasuryResolutionCleanupOpenResult =
  | { readonly status: "opened" }
  | { readonly status: "already_open" }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * 【Round 22 remediation D】open 的 exact identity 字段（幂等 reopen 的
 * 全量比较集——任何维度不等即 conflict，零状态变化）。
 */
const CLEANUP_IDENTITY_FIELDS = [
  "digest",
  "identityProfile",
  "proofClass",
  "contractDigest",
  "authorizationCohortDigest",
  "durableIdentityDigest",
  "lowlevelSource",
  "lineageId",
  "lineageGeneration",
  "parentTransactionId",
  "lineageBindingDigest",
] as const;

/**
 * settlement proof 持久化后创建 cleanup entry（或【Remediation II A.6】在
 * 消费 capability 之前以 reservation 模式先行取得 cleanup 所有权）。幂等
 * reopen（同 transactionId 同 resolution）要求 exact identity 全字段相等
 * （【Round 22 remediation D】identity 不可变——digest/profile/class/
 * provenance/lineage 任一不等 → conflict，零状态变化，不得在保留阶段进度
 * 时覆盖身份字段）；不同 resolution → conflict fail closed。容量满 →
 * rejected（调用方不得继续推进终态——settlement proof 已持久化，恢复稍后
 * 重试 open）。
 *
 * proofMode（默认 "proof_durable"——proof 已在 open 前落盘，创建即
 * settlementProofDurable=true）：
 * - "reservation"【Remediation II A.6】：capability 消费前的持久、exact、
 *   不可与其他 attempt 冲突的 cleanup admission——创建为
 *   settlementProofDurable=false（不谎称 proof durable）；proof 写入成功后
 *   经 activate（或对既有 reservation 的 proof_durable open 幂等激活）推进；
 *   未激活的 reservation 不参与任何阶段推进，可被本次创建方安全撤销。
 * - 对既有 reservation entry 的 proof_durable open（exact identity 一致）→
 *   幂等激活（settlementProofDurable 推进为 true，阶段进度保留）。
 */
export function openTreasuryResolutionCleanup(input: {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: "committed" | "not-executed";
  readonly identityProfile: TreasuryIdentityProfile;
  readonly proofClass: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
  readonly proofMode?: "proof_durable" | "reservation";
}): TreasuryResolutionCleanupOpenResult {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: `cleanup journal fail-closed: ${runtime.fatal}` };
  }
  const key = CLEANUP_KEY_PREFIX + input.transactionId;
  const existing = runtime.store.entries[key];
  if (existing !== undefined) {
    if (existing.resolution !== input.resolution) {
      cleanupEvents.conflicts += 1;
      return {
        status: "conflict",
        detail: `cleanup entry 已以 ${existing.resolution} 打开（同一 attempt 不得同时存在两种 settlement 结论——fail closed）`,
      };
    }
    for (const field of CLEANUP_IDENTITY_FIELDS) {
      const existingValue = existing[field];
      const inputValue = input[field];
      if (existingValue !== inputValue) {
        cleanupEvents.conflicts += 1;
        return {
          status: "conflict",
          detail: `cleanup entry 身份字段 ${field} 不一致（既有 ${String(existingValue).slice(0, 24)} vs 请求 ${String(inputValue).slice(0, 24)}）——identity 不可变，零状态变化（fail closed）`,
        };
      }
    }
    // 【Remediation II A.6】既有 reservation + 本次 proof_durable open（proof
    // 已由调用方确认落盘）→ 幂等激活；identity 冲突已在上文 fail closed。
    if (!existing.settlementProofDurable && input.proofMode !== "reservation") {
      existing.settlementProofDurable = true;
      existing.updatedAt = Game.time;
      runtime.store.updatedAt = Game.time;
    }
    cleanupEvents.reopened += 1;
    return { status: "already_open" };
  }
  if (runtime.store.entryCount >= TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES) {
    cleanupEvents.capacityBlocked += 1;
    return {
      status: "rejected",
      detail: `cleanup journal 满载（${String(TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES)}——fail closed，不驱逐未完成 cleanup）`,
    };
  }
  runtime.store.entries[key] = cloneTreasuryDurableValue({
    transactionId: input.transactionId,
    digest: input.digest,
    resolution: input.resolution,
    identityProfile: input.identityProfile,
    proofClass: input.proofClass,
    settlementProofDurable: input.proofMode !== "reservation",
    markerDischarged: false,
    authorityReleased: false,
    outcomeFinalized: false,
    lineageFinalized: false,
    openedAtTick: Game.time,
    updatedAt: Game.time,
    ...(input.contractDigest !== undefined ? { contractDigest: input.contractDigest } : {}),
    ...(input.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: input.authorizationCohortDigest } : {}),
    ...(input.durableIdentityDigest !== undefined ? { durableIdentityDigest: input.durableIdentityDigest } : {}),
    ...(input.lowlevelSource !== undefined ? { lowlevelSource: input.lowlevelSource } : {}),
    ...(input.lineageId !== undefined ? { lineageId: input.lineageId } : {}),
    ...(input.lineageGeneration !== undefined ? { lineageGeneration: input.lineageGeneration } : {}),
    ...(input.parentTransactionId !== undefined ? { parentTransactionId: input.parentTransactionId } : {}),
    ...(input.lineageBindingDigest !== undefined ? { lineageBindingDigest: input.lineageBindingDigest } : {}),
  });
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  cleanupEvents.opened += 1;
  return { status: "opened" };
}

/** 读取 entry（只读冻结快照）。 */
export function readTreasuryResolutionCleanupEntry(
  transactionId: string,
): Readonly<TreasuryResolutionCleanupEntry> | undefined {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) return undefined;
  const entry = runtime.store.entries[CLEANUP_KEY_PREFIX + transactionId];
  return entry === undefined ? undefined : (treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
}

/** pending cleanup id 列表（journal 即持久索引——global reset 后直接重建）。 */
export function listTreasuryResolutionCleanupPendingIds(): readonly string[] {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) return [];
  return Object.keys(runtime.store.entries).map((key) => key.slice(CLEANUP_KEY_PREFIX.length));
}

/**
 * 阶段完成标记（单调推进——已完成阶段不得回退）。【Round 22 remediation D】
 * 强制前置顺序 marker → authority → outcome → lineage：越级设置后续布尔
 * 一律拒绝（返回 false，零状态变化）——任意 caller 不得跳过前置阶段。
 * 【Remediation II A.6】settlementProofDurable=false 的 reservation entry
 * 不得推进任何阶段（proof 未落盘的 admission 不是可执行 cleanup）。
 */
export function markTreasuryResolutionCleanupStage(
  transactionId: string,
  stage: TreasuryResolutionCleanupStage,
  detail?: string,
): boolean {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) return false;
  const key = CLEANUP_KEY_PREFIX + transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) return false;
  if (!entry.settlementProofDurable) return false;
  switch (stage) {
    case "marker_discharge":
      if (entry.markerDischarged) return true;
      entry.markerDischarged = true;
      entry.markerDischargeOutcome = detail;
      break;
    case "authority_release":
      if (entry.authorityReleased) return true;
      if (!entry.markerDischarged) return false;
      entry.authorityReleased = true;
      break;
    case "outcome_finalization":
      if (entry.outcomeFinalized) return true;
      if (!entry.markerDischarged || !entry.authorityReleased) return false;
      entry.outcomeFinalized = true;
      break;
    case "lineage_finalization":
      if (entry.lineageFinalized) return true;
      if (!entry.markerDischarged || !entry.authorityReleased || !entry.outcomeFinalized) return false;
      entry.lineageFinalized = true;
      break;
  }
  entry.updatedAt = Game.time;
  runtime.store.updatedAt = Game.time;
  cleanupEvents.stageAdvances += 1;
  return true;
}

/** entry 是否全部阶段完成。 */
export function treasuryResolutionCleanupComplete(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
): boolean {
  return entry.markerDischarged && entry.authorityReleased && entry.outcomeFinalized && entry.lineageFinalized;
}

/** 全阶段完成后移除 entry（唯一合法删除点——七.6）。 */
export function completeTreasuryResolutionCleanup(transactionId: string): boolean {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) return false;
  const key = CLEANUP_KEY_PREFIX + transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) return true;
  if (!treasuryResolutionCleanupComplete(entry)) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  cleanupEvents.completed += 1;
  return true;
}

/**
 * 【Remediation II A.6】reservation 激活：settlement/resolution proof 写入
 * 成功并 read-back 确认后调用——settlementProofDurable false→true（幂等：
 * 已激活返回 true）。fatal / entry 缺失 → false（调用方继续主流程，恢复
 * 路径的 proof_durable open 会按 proof 事实幂等补激活）。
 */
export function activateTreasuryResolutionCleanupProof(transactionId: string): boolean {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) return false;
  const entry = runtime.store.entries[CLEANUP_KEY_PREFIX + transactionId];
  if (entry === undefined) return false;
  if (entry.settlementProofDurable) return true;
  entry.settlementProofDurable = true;
  entry.updatedAt = Game.time;
  runtime.store.updatedAt = Game.time;
  return true;
}

export type TreasuryResolutionCleanupRevokeResult =
  | { readonly status: "revoked" }
  | { readonly status: "absent" }
  | { readonly status: "refused"; readonly detail: string };

/**
 * 【Remediation II A.5】回滚路径的 reservation/新建 entry 安全撤销：只允许
 * 删除"本次创建、exact identity 完全一致、四个阶段均未推进、
 * settlementProofDurable 与调用方所知事实一致"的 entry——already-open 的
 * 既有 entry（identity 不匹配 / 阶段已推进 / durable 事实不符）一律 refused
 * 零状态变化（不得误删既有 journal，也不得留下没有有效 settlement 流程却
 * 永久 pending 的孤儿 entry）。
 */
export function revokeTreasuryResolutionCleanup(input: {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: "committed" | "not-executed";
  readonly identityProfile: TreasuryIdentityProfile;
  readonly proofClass: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
  readonly settlementProofDurable: boolean;
}): TreasuryResolutionCleanupRevokeResult {
  const runtime = loadCleanupRuntime();
  if (runtime.fatal !== null) {
    return { status: "refused", detail: `cleanup journal fail-closed: ${runtime.fatal}` };
  }
  const key = CLEANUP_KEY_PREFIX + input.transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) return { status: "absent" };
  if (entry.resolution !== input.resolution) {
    return { status: "refused", detail: `resolution 不一致（${entry.resolution} vs ${input.resolution}）——既有 entry 保留` };
  }
  for (const field of CLEANUP_IDENTITY_FIELDS) {
    if (entry[field] !== input[field]) {
      return { status: "refused", detail: `身份字段 ${field} 不一致——既有 entry 保留（零状态变化）` };
    }
  }
  if (entry.markerDischarged || entry.authorityReleased || entry.outcomeFinalized || entry.lineageFinalized) {
    return { status: "refused", detail: "entry 已推进阶段——不可撤销（保留待恢复补完成）" };
  }
  if (entry.settlementProofDurable !== input.settlementProofDurable) {
    return { status: "refused", detail: `settlementProofDurable 事实不一致（${String(entry.settlementProofDurable)} vs ${String(input.settlementProofDurable)}）——保留` };
  }
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  cleanupEvents.revocations += 1;
  return { status: "revoked" };
}

function dischargeExpectedOfEntry(entry: Readonly<TreasuryResolutionCleanupEntry>) {
  return {
    transactionId: entry.transactionId,
    digest: entry.digest,
    proofClass: entry.proofClass,
    identityProfile: entry.identityProfile,
    ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
    ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
    ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
    ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
    ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
    ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
    ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
    ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
  };
}

export interface TreasuryResolutionCleanupRecoveryReport {
  readonly examined: number;
  readonly progressed: number;
  readonly completed: number;
  readonly blocked: number;
  readonly blockedDetails: readonly string[];
  /** 【Remediation II A.6】settlementProofDurable=false 的 reservation entry（不参与恢复——等待 proof 落盘激活或调用方撤销）。 */
  readonly pendingReservations: number;
}

/**
 * beginTick 恢复编排：journal 未完成 entry 按安全顺序补完成
 * （marker discharge → authority release → outcome → lineage）。
 * handlers 未装配（production 装配缺失）→ fail closed 保留全部 pending。
 * 空 journal O(1) 快路径。
 *
 * 【Remediation II D.4】阶段持久 boolean 只是恢复进度提示，不是安全证明：
 * 每个阶段都重新通过幂等外部事实验证（marker：重新读取并 discharge；
 * authority：resolver 重确认 + 需要时重新释放；outcome：committed 重验
 * trusted receipt + exact tombstone、not-executed 重验 exact proof/GRA 收敛
 * ——由 facade 装配的 stage handlers 承载）；"boolean 撒谎"（如
 * markerDischarged=true 但 matching marker 仍存在）不得直接跳过并删除
 * entry。settlementProofDurable=false 的 reservation 跳过（无 proof 可恢复，
 * 等待激活或撤销——计入 pendingReservations，不折叠为已完成）。
 */
export function recoverTreasuryResolutionCleanupAtTickBoundary(): TreasuryResolutionCleanupRecoveryReport {
  const runtime = loadCleanupRuntime();
  const examined = 0;
  const progressed = 0;
  const completed = 0;
  const blocked = 0;
  const blockedDetails: string[] = [];
  const pendingReservations = 0;
  const report = { examined, progressed, completed, blocked, blockedDetails, pendingReservations };
  if (runtime.fatal !== null) {
    return { ...report, blocked: -1, blockedDetails: [`cleanup journal fail-closed: ${runtime.fatal}`] };
  }
  const keys = Object.keys(runtime.store.entries);
  if (keys.length === 0) return report;
  if (stageHandlers === null) {
    cleanupEvents.recoveryBlocked += keys.length;
    return {
      ...report,
      blocked: keys.length,
      blockedDetails: ["cleanup stage handlers 未装配（production fail closed——pending 保留）"],
    };
  }
  for (const key of keys) {
    const entry = runtime.store.entries[key];
    if (entry === undefined) continue;
    if (!entry.settlementProofDurable) {
      report.pendingReservations += 1;
      continue;
    }
    report.examined += 1;
    let advanced = false;
    // 阶段 1：marker discharge——boolean 为 true 也重新读取并验证 marker
    //（matching marker 重现时按 exact relation 安全补 discharge；malformed/
    // conflict/insufficient 阻断；unrelated marker 区分"本 attempt 阶段完成"
    // 与"全局 write admission 仍锁定"——后者不阻断本 attempt 恢复）。
    {
      const discharge = dischargeTreasuryMarkerForAttempt(dischargeExpectedOfEntry(entry));
      if (discharge.outcome === "matching_cleared" || discharge.outcome === "already_absent") {
        cleanupEvents.markerDischarges += 1;
      }
      if (treasuryMarkerDischargeCompletesAttemptPhase(discharge.outcome)) {
        if (!entry.markerDischarged) {
          markTreasuryResolutionCleanupStage(entry.transactionId, "marker_discharge", discharge.outcome);
        }
        advanced = true;
      } else {
        cleanupEvents.markerDischargeBlocks += 1;
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`marker discharge ${discharge.outcome}: ${discharge.detail}`);
        continue;
      }
    }
    // 阶段 2：authority release——resolver 重确认 not_found；仍有同 attempt
    // Authority 时按安全顺序重新释放并 read-back（handler 承载；inconsistent/
    // store_unhealthy 阻断）。boolean 为 true 同样重验（boolean 撒谎不得跳过）。
    {
      const release = stageHandlers.authorityRelease(treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
      if (release.status === "released" || release.status === "already_absent") {
        if (!entry.authorityReleased) {
          markTreasuryResolutionCleanupStage(entry.transactionId, "authority_release");
        }
        advanced = true;
      } else {
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`authority release ${release.status}: ${release.detail}`);
        continue;
      }
    }
    // 阶段 3：outcome 终态——committed 重验 trusted Receipt + exact tombstone
    // 后 finalize；not-executed 重验 exact GRA proof（handler 承载）。
    {
      const outcome = stageHandlers.outcomeFinalization(treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
      if (outcome.status === "finalized" || outcome.status === "already_final") {
        if (!entry.outcomeFinalized) {
          markTreasuryResolutionCleanupStage(entry.transactionId, "outcome_finalization");
        }
        advanced = true;
      } else {
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`outcome finalization ${outcome.status}: ${outcome.detail}`);
        continue;
      }
    }
    // 阶段 4：lineage 终态——exact 最终状态重确认（generation/parent/binding/
    // 当前 attempt 任一不匹配都不得完成——handler 承载）。
    {
      const lineage = stageHandlers.lineageFinalization(treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
      if (lineage.status === "finalized" || lineage.status === "already_final" || lineage.status === "not_applicable") {
        if (!entry.lineageFinalized) {
          markTreasuryResolutionCleanupStage(entry.transactionId, "lineage_finalization");
        }
        advanced = true;
      } else {
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`lineage finalization ${lineage.status}: ${lineage.detail}`);
        continue;
      }
    }
    if (advanced) report.progressed += 1;
    if (treasuryResolutionCleanupComplete(runtime.store.entries[key])) {
      if (completeTreasuryResolutionCleanup(entry.transactionId)) {
        report.completed += 1;
      }
    }
  }
  return report;
}

/** marker discharge 结果类型重导出（调用方报告用）。 */
export type { TreasuryMarkerDischargeOutcome };
