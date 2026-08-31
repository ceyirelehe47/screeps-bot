/**
 * Treasury resolution tombstone store（第八轮升级 version 2 + staged 状态）。
 *
 * 角色：显式 fault resolution 的有界幂等记录与 staged 状态机载体。独立成
 * 模块（而非内嵌 faultResolution.ts）的原因：facade 需要（a）统一 replay
 * horizon 的 committed tombstone 只读查询（prepare 幂等）与（b）beginTick
 * 的 staged resolution 恢复——生产代码不得 import faultResolution（架构
 * 边界测试守护），本模块只承载 store 级语义供两侧共享。
 *
 * 健康契约（与 receipt/quarantine/intent 同款）：
 * - version 2：version/entryCount 元数据 + key="r:"+transactionId + entry
 *   完整形状校验（resolution/stage 枚举、digest 16hex、安全整数、有界
 *   string）+ 容量上限 256（满时在**任何原状态变化之前**拒绝）+ 未知版本
 *   fail closed（原数据保留）+ global reset 首次 load 全量验证 + heap cache；
 * - v1（第七轮，无 entryCount/stage）：全量验证通过后无损升级 v2（补
 *   entryCount、stage=final）；损坏 fatal（malformed 旧 tombstone 绝不当
 *   可清理垃圾删除——人工处理）；
 * - 惰性清理只删除 resolvedAtTick 超过 retention（5000）的完整验证条目；
 *   损坏条目不删除。
 *
 * staged 状态机（task 8.2）：resolve-as-committed 先写 stage="resolving"
 * tombstone（resolution-intent 落盘）再执行 receipt 刷新与释放，最后
 * finalize（stage="final"）；任何阶段中断由 recoverStagedResolutions 在
 * beginTick 幂等恢复——不出现"返回 rejected 却已解锁"或"先删 quarantine
 * 再写 tombstone 失败"的不可恢复窗口。
 */

import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import {
  TREASURY_RECEIPT_RETENTION_TICKS,
  hasSettledReceipt,
  refreshSettledReceiptForResolution,
  registerTreasuryResolutionResetHook,
} from "@/runtime/treasury/receipts";
import { clearTreasuryWriteFaultMarkerForResolution } from "@/runtime/treasury/writeFault";
import { releaseTreasuryQuarantineEntry, readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentEntry, releaseTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";

export const TREASURY_RESOLUTION_VERSION = 3 as const;
export const TREASURY_RESOLUTION_MAX_ENTRIES = 256;
const TREASURY_RESOLUTION_RETENTION_TICKS = 5_000;
const RESOLUTION_KEY_PREFIX = "r:";
const RESOLUTION_SOURCE_MAX = 128;
const RESOLUTION_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

export type TreasuryResolutionKind = "committed" | "not-executed";
export type TreasuryResolutionStage = "resolving" | "final";

export interface TreasuryResolutionTombstone {
  transactionId: string;
  digest: string;
  resolution: TreasuryResolutionKind;
  /** staged 状态：resolving = resolution 进行中（可恢复）；final = 完成。 */
  stage: TreasuryResolutionStage;
  /** 原 action tick（审计保留；receipt retention 从 settledAtTick 起算）。 */
  actionTick: number;
  /** receipt 结算 tick（resolve-as-committed = resolution tick）。 */
  settledAtTick?: number;
  /** 对账观察 tick（capability 签发时点）。 */
  observationTick: number;
  resolvedAtTick: number;
  reconcilerKind?: string;
  source?: string;
  /** pre-execution authorization fault 的 acknowledge-rolled-back resolution（第十一轮 3.13.1）。 */
  preExecution?: boolean;
  // ── v3（第十二轮 3.3：tombstone 绑定完整 action attempt identity——
  //    同 transaction ID 的不同 attempt 不得共享旧 proof）。缺省 = legacy
  //    proof（不得证明携带现代身份事实的新 attempt）。 ────────────────────
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
}

export interface TreasuryResolutionStore {
  version: 3;
  entries: Record<string, TreasuryResolutionTombstone>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryResolutionBranch {
  resolutions?: {
    version?: number;
    entries?: Record<string, TreasuryResolutionTombstone>;
    entryCount?: number;
    updatedAt?: number;
  };
}

type RuntimeMemoryWithResolutions = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryResolutionBranch;
};

function resolutionBranch(): TreasuryResolutionBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithResolutions;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

// ── heap 运行态 + 计数 ──────────────────────────────────────────────────────

interface ResolutionStoreRuntime {
  store: TreasuryResolutionStore;
  fatal: string | null;
}

let heapRuntime: ResolutionStoreRuntime | null = null;

const resolutionStoreEvents = {
  fullScans: 0,
  loadValidationEntries: 0,
  inProgressRecoveries: 0,
  recovered: 0,
  faulted: 0,
  /** 【第十三轮】staged recovery 的 identity relation 独立计数（conflict 与 insufficient 分离）。 */
  identityConflicts: 0,
  identityInsufficientBlockers: 0,
};

export interface TreasuryResolutionStoreCounters {
  readonly fullScans: number;
  readonly loadValidationEntries: number;
  readonly recovered: number;
  readonly faulted: number;
  readonly identityConflicts: number;
  readonly identityInsufficientBlockers: number;
}

export function readTreasuryResolutionStoreCounters(): TreasuryResolutionStoreCounters {
  const { fullScans, loadValidationEntries, recovered, faulted, identityConflicts, identityInsufficientBlockers } = resolutionStoreEvents;
  return { fullScans, loadValidationEntries, recovered, faulted, identityConflicts, identityInsufficientBlockers };
}

/**
 * 仅供测试：清零（经 receipts 的注册钩子随 clearTreasuryPersistenceForTest
 * 调用——模块加载时自注册，避免 receipts ↔ resolutionStore 循环依赖）。
 */
export function resetTreasuryResolutionStoreForTest(): void {
  heapRuntime = null;
  resolutionStoreEvents.fullScans = 0;
  resolutionStoreEvents.loadValidationEntries = 0;
  resolutionStoreEvents.inProgressRecoveries = 0;
  resolutionStoreEvents.recovered = 0;
  resolutionStoreEvents.faulted = 0;
  resolutionStoreEvents.identityConflicts = 0;
  resolutionStoreEvents.identityInsufficientBlockers = 0;
}

registerTreasuryResolutionResetHook(resetTreasuryResolutionStoreForTest);

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** 单条 tombstone 完整形状校验（返回 null = 合法，否则有界错误描述）。 */
export function validateTreasuryResolutionTombstoneShape(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "tombstone 非对象";
  const candidate = entry as Partial<TreasuryResolutionTombstone>;
  if (typeof candidate.transactionId !== "string" || !isValidTreasuryTransactionId(candidate.transactionId)) {
    return `transactionId 非法: ${String(candidate.transactionId).slice(0, 48)}`;
  }
  if (typeof candidate.digest !== "string" || !RESOLUTION_DIGEST_PATTERN.test(candidate.digest)) {
    return "digest 非法（须为 16 小写 hex）";
  }
  if (candidate.resolution !== "committed" && candidate.resolution !== "not-executed") {
    return `resolution 非法（未知枚举）: ${String(candidate.resolution).slice(0, 24)}`;
  }
  if (candidate.stage !== undefined && candidate.stage !== "resolving" && candidate.stage !== "final") {
    return `stage 非法（未知枚举）: ${String(candidate.stage).slice(0, 24)}`;
  }
  if (!isSafeInteger(candidate.actionTick) || candidate.actionTick < 0) return "actionTick 非安全整数";
  if (candidate.settledAtTick !== undefined && (!isSafeInteger(candidate.settledAtTick) || candidate.settledAtTick < 0)) {
    return "settledAtTick 非安全整数";
  }
  if (!isSafeInteger(candidate.observationTick) || candidate.observationTick < 0) return "observationTick 非安全整数";
  if (!isSafeInteger(candidate.resolvedAtTick) || candidate.resolvedAtTick < 0) return "resolvedAtTick 非安全整数";
  if (candidate.reconcilerKind !== undefined) {
    if (typeof candidate.reconcilerKind !== "string" || candidate.reconcilerKind.length === 0 || candidate.reconcilerKind.length > RESOLUTION_SOURCE_MAX) {
      return "reconcilerKind 非法（须为 1..128 字符）";
    }
  }
  if (candidate.source !== undefined) {
    if (typeof candidate.source !== "string" || candidate.source.length === 0 || candidate.source.length > RESOLUTION_SOURCE_MAX) {
      return "source 非法（须为 1..128 字符）";
    }
  }
  // 【第十二轮 3.3】attempt identity 绑定字段（可选；存在须为 16 hex）。
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !RESOLUTION_DIGEST_PATTERN.test(value))) {
      return `${field} 非法（须为 16 小写 hex）`;
    }
  }
  return null;
}

/** store 完整形状自检（load 与 v1 升级共用；一次全表扫描）。 */
function validateResolutionStoreShape(store: TreasuryResolutionStore): string | null {
  if (store.version !== TREASURY_RESOLUTION_VERSION) {
    return `未知 resolution store 版本 ${String(store.version)}`;
  }
  if (!store.entries || typeof store.entries !== "object") return "resolution entries 非对象";
  resolutionStoreEvents.fullScans += 1;
  const ownKeys = Object.keys(store.entries);
  resolutionStoreEvents.loadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  if (ownKeys.length > TREASURY_RESOLUTION_MAX_ENTRIES) {
    return `entries 超过上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)}（含 ${String(ownKeys.length)} 条）`;
  }
  for (const key of ownKeys) {
    if (!key.startsWith(RESOLUTION_KEY_PREFIX)) {
      return `存储键格式非法（须为 "r:"+transactionId）: ${key.slice(0, 48)}`;
    }
    const entry = (store.entries as Record<string, unknown>)[key];
    const shapeError = validateTreasuryResolutionTombstoneShape(entry);
    if (shapeError !== null) {
      return `${shapeError}（key ${key.slice(0, 48)}）`;
    }
    const typed = entry as TreasuryResolutionTombstone;
    if (RESOLUTION_KEY_PREFIX + typed.transactionId !== key) {
      return `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}`;
    }
  }
  return null;
}

function fatalRuntime(store: TreasuryResolutionStore, reason: string): ResolutionStoreRuntime {
  return { store, fatal: reason };
}

/**
 * 加载（含校验与 v1 无损升级）：写路径专用。v1（无 entryCount/stage）全量
 * 验证通过后升级（补 entryCount、stage=final）；任何损坏 → fatal fail
 * closed（原数据不删、写入拒绝、恢复拒绝）。
 */
function loadResolutionStoreRuntime(): ResolutionStoreRuntime {
  if (heapRuntime) return heapRuntime;
  const raw = resolutionBranch().resolutions;
  if (!raw) {
    const created: TreasuryResolutionStore = { version: TREASURY_RESOLUTION_VERSION, entries: {}, entryCount: 0, updatedAt: Game.time };
    resolutionBranch().resolutions = created;
    heapRuntime = { store: created, fatal: null };
    return heapRuntime;
  }
  if ((raw.version as number) === TREASURY_RESOLUTION_VERSION) {
    const candidate = raw as unknown as TreasuryResolutionStore;
    const shapeError = validateResolutionStoreShape(candidate);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(candidate, `${shapeError}（resolution store fail closed，原数据保留）`);
      return heapRuntime;
    }
    heapRuntime = { store: candidate, fatal: null };
    return heapRuntime;
  }
  if (raw.version === 2) {
    // v2 → v3 无损升级（第十二轮 3.3）：entries 原样保留（identity 字段
    // 缺省 = legacy proof——不得证明现代 attempt）；损坏 → fatal。
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v2→v3 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null };
    return heapRuntime;
  }
  if (raw.version === 1) {
    // v1 无损升级：全量验证 → 补 entryCount/stage=final → 原子替换。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    let entryCount = 0;
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries(raw.entries ?? {})) {
      const shapeError = validateTreasuryResolutionTombstoneShape(value);
      if (shapeError !== null) {
        heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v1 tombstone 损坏，人工处理；key ${key.slice(0, 48)}）`);
        return heapRuntime;
      }
      if (RESOLUTION_KEY_PREFIX + value.transactionId !== key) {
        heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `v1 存储键与 transactionId 不一致: ${key.slice(0, 48)}`);
        return heapRuntime;
      }
      entries[key] = { ...value, stage: "final" };
      entryCount += 1;
    }
    const upgraded: TreasuryResolutionStore = { version: TREASURY_RESOLUTION_VERSION, entries, entryCount, updatedAt: Game.time };
    if (validateResolutionStoreShape(upgraded) !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, "v1→v2 升级自检失败（原数据保留）");
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null };
    return heapRuntime;
  }
  heapRuntime = fatalRuntime(
    raw as unknown as TreasuryResolutionStore,
    `未知 resolution store 版本 ${String(raw.version)}（原数据保留，fail closed）`,
  );
  return heapRuntime;
}

export interface TreasuryResolutionStoreHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  /** 当前 resolving（进行中）条数（gauge；轻量探测）。 */
  readonly inProgress: number;
  readonly entryCount: number;
}

/** 健康探测（只读零写；轻量——entry 级损坏由 load 检出）。 */
export function peekTreasuryResolutionStoreHealth(): TreasuryResolutionStoreHealth {
  if (heapRuntime?.fatal) {
    return { healthy: false, detail: heapRuntime.fatal, inProgress: 0, entryCount: Object.keys(heapRuntime.store.entries ?? {}).length };
  }
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions;
  if (raw === undefined) return { healthy: true, detail: null, inProgress: 0, entryCount: 0 };
  if (raw.version !== TREASURY_RESOLUTION_VERSION && raw.version !== 1 && raw.version !== 2) {
    return { healthy: false, detail: `未知 resolution store 版本 ${String(raw.version)}`, inProgress: 0, entryCount: 0 };
  }
  if (!raw.entries || typeof raw.entries !== "object") {
    return { healthy: false, detail: "resolution entries 非对象", inProgress: 0, entryCount: 0 };
  }
  let entryCount = 0;
  let inProgress = 0;
  for (const entry of Object.values(raw.entries)) {
    entryCount += 1;
    if ((entry as Partial<TreasuryResolutionTombstone>).stage === "resolving") inProgress += 1;
  }
  return { healthy: true, detail: null, inProgress, entryCount };
}

/** 显式触发 load 验证（写路径）：返回 fatal 描述（null = 可用）。 */
export function ensureTreasuryResolutionStoreValidated(): string | null {
  const runtime = loadResolutionStoreRuntime();
  return runtime.fatal;
}

// ── 读写 ────────────────────────────────────────────────────────────────────

/** 只读读取单条（冻结快照；不触发创建）。 */
export function readTreasuryResolutionTombstone(transactionId: string): Readonly<TreasuryResolutionTombstone> | undefined {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions;
  if (!raw || !raw.entries || typeof raw.entries !== "object") return undefined;
  const entry = raw.entries[RESOLUTION_KEY_PREFIX + transactionId];
  return entry === undefined ? undefined : Object.freeze({ ...entry });
}

/**
 * 容量预检（staged 流程第一步——在任何原状态变化之前执行）：已满且无可
 * 清理过期项 → 拒绝（fail closed）。返回 null = 可写。
 */
export function ensureTreasuryResolutionSlotAvailable(): string | null {
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) return runtime.fatal;
  const key = RESOLUTION_KEY_PREFIX; // 通用预检（不含具体 id 时按新条目判断）
  void key;
  if (runtime.store.entryCount < TREASURY_RESOLUTION_MAX_ENTRIES) return null;
  // 满载：尝试惰性清理过期项后重判。
  evictExpiredTombstones(runtime.store);
  if (runtime.store.entryCount < TREASURY_RESOLUTION_MAX_ENTRIES) return null;
  return `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`;
}

/** 惰性清理：只删除 stage=final 且超过 retention 的形状完整条目（第九轮
 *  4.10：stage=resolving 永不被普通垃圾回收驱逐——resolution-intent 丢弃
 *  不可接受，满载 fail closed 由容量预检承担）。 */
function evictExpiredTombstones(store: TreasuryResolutionStore): number {
  let removed = 0;
  resolutionStoreEvents.fullScans += 1;
  for (const [key, entry] of Object.entries(store.entries)) {
    if (validateTreasuryResolutionTombstoneShape(entry) !== null) continue; // 损坏不删除
    if (entry.stage === "resolving") continue; // resolving 永不驱逐（第九轮 4.10）
    if (entry.resolvedAtTick < Game.time - TREASURY_RESOLUTION_RETENTION_TICKS) {
      delete store.entries[key];
      store.entryCount -= 1;
      removed += 1;
    }
  }
  if (removed > 0) store.updatedAt = Game.time;
  return removed;
}

export type TreasuryResolutionTombstoneWriteResult =
  | { readonly status: "written" }
  | { readonly status: "updated" }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * 写入/更新 tombstone（形状校验 + 容量约束 + 惰性清理）。同 id 已存在时
 * 覆盖为 final（resolving → final 的 finalize 语义）。
 */
export function writeTreasuryResolutionTombstone(entry: TreasuryResolutionTombstone): TreasuryResolutionTombstoneWriteResult {
  const shapeError = validateTreasuryResolutionTombstoneShape(entry);
  if (shapeError !== null) {
    return { status: "rejected", detail: `拒绝写入非法 tombstone: ${shapeError}` };
  }
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) {
    return { status: "rejected", detail: runtime.fatal };
  }
  const key = RESOLUTION_KEY_PREFIX + entry.transactionId;
  if (!Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) {
    if (runtime.store.entryCount >= TREASURY_RESOLUTION_MAX_ENTRIES) {
      evictExpiredTombstones(runtime.store);
      if (runtime.store.entryCount >= TREASURY_RESOLUTION_MAX_ENTRIES) {
        return {
          status: "rejected",
          detail: `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`,
        };
      }
    }
    runtime.store.entries[key] = { ...entry };
    runtime.store.entryCount += 1;
    runtime.store.updatedAt = Game.time;
    return { status: "written" };
  }
  runtime.store.entries[key] = { ...entry };
  runtime.store.updatedAt = Game.time;
  return { status: "updated" };
}

/** 删除单条（staged 回滚专用：resolving 无进展时）。 */
export function deleteTreasuryResolutionTombstone(transactionId: string): boolean {
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) return false;
  const key = RESOLUTION_KEY_PREFIX + transactionId;
  if (!Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  return true;
}

// ── 统一 replay horizon（prepare 幂等与 receipt 同一规则） ─────────────────

/**
 * committed resolution tombstone 的防重放窗口查询：resolution=committed 且
 * settledAtTick + retention ≥ Game.time 时返回 settledAtTick（prepare 须将其
 * 视为已结算——receipt 过期但 committed tombstone 仍在窗口内时不得当全新
 * 动作）；不在窗口或非 committed 返回 undefined。与 receipt 使用同一
 * retention 常量（统一 replay horizon）。
 */
export function committedResolutionSettledAtTick(transactionId: string): number | undefined {
  const tombstone = readTreasuryResolutionTombstone(transactionId);
  if (tombstone === undefined || tombstone.resolution !== "committed") return undefined;
  if (tombstone.settledAtTick === undefined) return undefined;
  if (tombstone.settledAtTick < Game.time - TREASURY_RECEIPT_RETENTION_TICKS) return undefined;
  return tombstone.settledAtTick;
}

// ── staged 恢复（beginTick 显式分支调用；幂等） ────────────────────────────

export interface TreasuryResolutionRecoveryReport {
  /** resolving-committed 且 receipt 已刷新至 settledAtTick → 完成 finalize 的条数。 */
  completed: number;
  /** resolving 无进展且不可恢复（防御分支）→ 回滚删除 tombstone 的条数。 */
  rolledBack: number;
  /** final not-executed 但 authority 仍存在 → 补完成释放的条数。 */
  completedRelease: number;
  /** receipt 不可写：resolving 保留（刷新未完成，绝不 finalize——第九轮 4.9）。 */
  refreshBlocked: number;
  /** 【第十三轮】identity conflict 保留 authority 的条数（独立诊断/计数）。 */
  identityConflicts: number;
  /** 【第十三轮】legacy/insufficient proof 保留 authority 的条数（独立诊断/计数）。 */
  identityInsufficient: number;
  storeFatal: string | null;
}

/**
 * staged resolution 恢复（global reset / 中断后；第九轮 4.9 修复 receipt
 * 刷新判定 + 4.10 final not-executed 补完成 intent 释放）：
 * - stage=resolving + committed：**只在 receipt tick ≥ tombstone 的
 *   settledAtTick 时才 finalize**——旧 action tick 的 receipt 不被误判为
 *   已刷新（第九轮修复：不再只判 receipt 存在性）；未刷新（旧 receipt 或
 *   无 receipt）→ 幂等续做 refresh 至**原定** settledAtTick（不缩短 replay
 *   horizon），refresh 成功后 finalize；refresh fatal → 保留 resolving +
 *   报告 blocker（unresolved authority 不释放——绝不直接 finalize、绝不
 *   回滚丢弃 resolution-intent）；
 * - stage=resolving 但无 settledAtTick / resolution 非 committed（防御：
 *   正常 staged 流程不产生该形态）→ 回滚删除 tombstone（原状态未变，
 *   resolution 可重试）；
 * - stage=final + not-executed 且 authority（quarantine **或 intent**——
 *   第九轮 4.10 补 intent 释放）仍存在 → 补完成释放（幂等）；
 * - store fatal：不删任何数据，报告诊断（resolution 路径拒绝）。
 */
/** authority entry → attempt identity 视图（tombstone 释放前的 identity 比较）。 */
function attemptIdentityOf(authority: {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
}): TreasuryAttemptIdentity {
  return {
    digest: authority.digest,
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
  };
}

export function recoverStagedResolutions(): TreasuryResolutionRecoveryReport {
  const report: TreasuryResolutionRecoveryReport = {
    completed: 0,
    rolledBack: 0,
    completedRelease: 0,
    refreshBlocked: 0,
    identityConflicts: 0,
    identityInsufficient: 0,
    storeFatal: null,
  };
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) {
    report.storeFatal = runtime.fatal;
    resolutionStoreEvents.faulted += 1;
    return report;
  }
  resolutionStoreEvents.fullScans += 1;
  for (const [key, entry] of Object.entries(runtime.store.entries)) {
    if (entry.stage === "resolving") {
      resolutionStoreEvents.inProgressRecoveries += 1;
      if (entry.resolution === "committed" && entry.settledAtTick !== undefined) {
        const receiptTick = hasSettledReceipt(entry.transactionId);
        if (receiptTick === undefined || receiptTick < entry.settledAtTick) {
          // receipt 未刷新到位（旧 action tick 的 receipt 或不存在）：幂等
          // 续做 refresh 至原定 settledAtTick——绝不把旧 receipt 误判为已
          // 刷新、绝不缩短 replay horizon。【第十三轮第六节】refresh 携带
          // tombstone 绑定的完整 attempt identity；blocked（legacy/冲突/
          // 证明不足）与 fatal 同样保留 resolving + authority（fail closed）。
          const refresh = refreshSettledReceiptForResolution(entry.transactionId, entry.settledAtTick, {
            digest: entry.digest,
            ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
            ...(entry.authorizationCohortDigest !== undefined
              ? { authorizationCohortDigest: entry.authorizationCohortDigest }
              : {}),
            ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          });
          if (refresh.status === "fatal" || refresh.status === "blocked") {
            // receipt 不可写或身份不可证明：保留 resolving（authority 不释放），
            // 报告 blocker（blocked 的 reason 区分 conflict 与不足）。
            resolutionStoreEvents.faulted += 1;
            report.refreshBlocked += 1;
            if (refresh.status === "blocked" && refresh.reason === "identity_conflict") {
              report.identityConflicts += 1;
              resolutionStoreEvents.identityConflicts += 1;
            } else if (refresh.status === "blocked") {
              report.identityInsufficient += 1;
              resolutionStoreEvents.identityInsufficientBlockers += 1;
            }
            continue;
          }
        }
        // receipt 已刷新至 settledAtTick：完成 finalize（幂等——authority
        // 释放与 marker 清除均为幂等操作）。【第十三轮第七节】释放的唯一
        // 许可是 identity relation === "match"——conflict 与 insufficient
        // （legacy proof 对现代 attempt）都保留全部 authority 并独立计数。
        const committedAuthority = readTreasuryQuarantineEntry(entry.transactionId) ?? readTreasuryIntentEntry(entry.transactionId);
        if (committedAuthority !== undefined) {
          const relation = treasuryAttemptIdentityRelation(
            entry,
            attemptIdentityOf(committedAuthority as { digest: string; durableIdentityDigest?: string; authorizationCohortDigest?: string; contractDigest?: string }),
          );
          if (relation !== "match") {
            resolutionStoreEvents.faulted += 1;
            if (relation === "conflict") {
              report.identityConflicts += 1;
              resolutionStoreEvents.identityConflicts += 1;
            } else {
              report.identityInsufficient += 1;
              resolutionStoreEvents.identityInsufficientBlockers += 1;
            }
            continue;
          }
        }
        releaseTreasuryQuarantineEntry(entry.transactionId);
        releaseTreasuryIntentEntry(entry.transactionId);
        clearTreasuryWriteFaultMarkerForResolution(entry.transactionId, entry.digest);
        entry.stage = "final";
        runtime.store.updatedAt = Game.time;
        resolutionStoreEvents.recovered += 1;
        report.completed += 1;
      } else {
        // 防御分支：resolving 无 settledAtTick 或非 committed——回滚
        // tombstone（原状态未变，resolution 可重试）。
        delete runtime.store.entries[key];
        runtime.store.entryCount -= 1;
        resolutionStoreEvents.faulted += 1;
        report.rolledBack += 1;
      }
      continue;
    }
    if (entry.stage === "final" && entry.resolution === "not-executed") {
      const quarantined = readTreasuryQuarantineEntry(entry.transactionId);
      const intended = quarantined === undefined ? readTreasuryIntentEntry(entry.transactionId) : undefined;
      if (quarantined !== undefined || intended !== undefined) {
        // 【第十三轮第七节】补完成释放前验证完整 attempt identity：旧
        // tombstone（同 ID 不同 attempt）不得释放当前 authority——identity
        // conflict 保留 authority 并报告（fail closed）；legacy/insufficient
        // proof 同样不得释放（不得再以 !== "conflict" 作为释放许可）。
        const authority = quarantined ?? intended;
        const relation = treasuryAttemptIdentityRelation(
          entry,
          attemptIdentityOf(authority as { digest: string; durableIdentityDigest?: string; authorizationCohortDigest?: string; contractDigest?: string }),
        );
        if (relation !== "match") {
          resolutionStoreEvents.faulted += 1;
          if (relation === "conflict") {
            report.identityConflicts += 1;
            resolutionStoreEvents.identityConflicts += 1;
          } else {
            report.identityInsufficient += 1;
            resolutionStoreEvents.identityInsufficientBlockers += 1;
          }
          continue;
        }
        // final tombstone 已写但释放未完成：补完成（幂等；含 intent-only
        // authority 场景——quarantine 与 intent 一并释放）。
        releaseTreasuryQuarantineEntry(entry.transactionId);
        releaseTreasuryIntentEntry(entry.transactionId);
        clearTreasuryWriteFaultMarkerForResolution(entry.transactionId, entry.digest);
        resolutionStoreEvents.recovered += 1;
        report.completedRelease += 1;
      }
    }
  }
  return report;
}
