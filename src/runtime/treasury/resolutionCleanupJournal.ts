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
 */

import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
  type TreasuryMarkerDischargeOutcome,
} from "@/runtime/treasury/markerDischarge";
import { treasuryIdentityProfileOfProofClass, type TreasuryIdentityProfile } from "@/runtime/treasury/identityProfile";

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
  /** settlement/resolution proof 已持久化（创建即 true——open 的前置条件）。 */
  readonly settlementProofDurable: true;
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

function validateCleanupStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "cleanup journal 非对象";
  const candidate = store as Partial<TreasuryResolutionCleanupStore>;
  if (candidate.version !== TREASURY_RESOLUTION_CLEANUP_VERSION) {
    return `cleanup journal 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "cleanup journal.entries 非对象";
  const keys = Object.keys(candidate.entries);
  for (const key of keys) {
    if (!key.startsWith(CLEANUP_KEY_PREFIX)) return `cleanup journal 键 ${key.slice(0, 8)} 缺少前缀`;
    const entry = candidate.entries[key] as Partial<TreasuryResolutionCleanupEntry> | undefined;
    if (!entry || typeof entry !== "object") return `cleanup entry ${key.slice(0, 8)} 非对象`;
    if (typeof entry.transactionId !== "string" || entry.transactionId.length === 0) return `cleanup entry ${key.slice(0, 8)} transactionId 非法`;
    if (key !== CLEANUP_KEY_PREFIX + entry.transactionId) return `cleanup entry ${key.slice(0, 8)} 键与 transactionId 不一致`;
    if (entry.resolution !== "committed" && entry.resolution !== "not-executed") return `cleanup entry ${key.slice(0, 8)} resolution 非法`;
    if (typeof entry.digest !== "string" || entry.digest.length === 0) return `cleanup entry ${key.slice(0, 8)} digest 非法`;
    if (typeof entry.proofClass !== "string" || entry.proofClass.length === 0) return `cleanup entry ${key.slice(0, 8)} proofClass 非法`;
    for (const stage of ["markerDischarged", "authorityReleased", "outcomeFinalized", "lineageFinalized"] as const) {
      if (typeof entry[stage] !== "boolean") return `cleanup entry ${key.slice(0, 8)} 阶段 ${stage} 非布尔`;
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
 * settlement proof 持久化后创建 cleanup entry。幂等 reopen（同 transactionId
 * 同 resolution）要求 exact identity 全字段相等（【Round 22 remediation D】
 * identity 不可变——digest/profile/class/provenance/lineage 任一不等 →
 * conflict，零状态变化，不得在保留阶段进度时覆盖身份字段）；不同
 * resolution → conflict fail closed。容量满 → rejected（调用方不得继续
 * 推进终态——settlement proof 已持久化，恢复稍后重试 open）。
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
    settlementProofDurable: true as const,
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
}

/**
 * beginTick 恢复编排：journal 未完成 entry 按安全顺序补完成
 * （marker discharge → authority release → outcome → lineage）。
 * handlers 未装配（production 装配缺失）→ fail closed 保留全部 pending。
 * 空 journal O(1) 快路径。
 */
export function recoverTreasuryResolutionCleanupAtTickBoundary(): TreasuryResolutionCleanupRecoveryReport {
  const runtime = loadCleanupRuntime();
  const examined = 0;
  const progressed = 0;
  const completed = 0;
  const blocked = 0;
  const blockedDetails: string[] = [];
  const report = { examined, progressed, completed, blocked, blockedDetails };
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
    report.examined += 1;
    let advanced = false;
    // 阶段 1：marker discharge（journal 自有权威——expected 从 entry 身份重建）。
    if (!entry.markerDischarged) {
      const discharge = dischargeTreasuryMarkerForAttempt(dischargeExpectedOfEntry(entry));
      if (discharge.outcome === "matching_cleared" || discharge.outcome === "already_absent") {
        cleanupEvents.markerDischarges += 1;
      }
      if (treasuryMarkerDischargeCompletesAttemptPhase(discharge.outcome)) {
        markTreasuryResolutionCleanupStage(entry.transactionId, "marker_discharge", discharge.outcome);
        advanced = true;
      } else {
        cleanupEvents.markerDischargeBlocks += 1;
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`marker discharge ${discharge.outcome}: ${discharge.detail}`);
        continue;
      }
    }
    // 阶段 2：authority release（read-back not_found 由 handler 内部确认）。
    if (!entry.authorityReleased) {
      const release = stageHandlers.authorityRelease(treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
      if (release.status === "released" || release.status === "already_absent") {
        markTreasuryResolutionCleanupStage(entry.transactionId, "authority_release");
        advanced = true;
      } else {
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`authority release ${release.status}: ${release.detail}`);
        continue;
      }
    }
    // 阶段 3：outcome 终态（committed final tombstone / not-executed exact proof）。
    if (!entry.outcomeFinalized) {
      const outcome = stageHandlers.outcomeFinalization(treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
      if (outcome.status === "finalized" || outcome.status === "already_final") {
        markTreasuryResolutionCleanupStage(entry.transactionId, "outcome_finalization");
        advanced = true;
      } else {
        cleanupEvents.recoveryBlocked += 1;
        report.blocked += 1;
        report.blockedDetails.push(`outcome finalization ${outcome.status}: ${outcome.detail}`);
        continue;
      }
    }
    // 阶段 4：lineage 终态。
    if (!entry.lineageFinalized) {
      const lineage = stageHandlers.lineageFinalization(treasuryBoundedDeepFreezeSnapshot(entry) as TreasuryResolutionCleanupEntry);
      if (lineage.status === "finalized" || lineage.status === "already_final" || lineage.status === "not_applicable") {
        markTreasuryResolutionCleanupStage(entry.transactionId, "lineage_finalization");
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
