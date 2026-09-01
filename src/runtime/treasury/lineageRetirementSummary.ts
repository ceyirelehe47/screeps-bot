/**
 * 【第十八轮 24.10】terminal lineage 压缩与退休摘要（retirement summary）。
 *
 * Round 17 断链：active lineage store 终身硬容量 64 条，chain committed /
 * non-rearmable retired 后 record 永久占槽——长期运行不可持续。
 *
 * 固定语义：
 * - active store 保留进行中/可 rearm 的 chain；终态（chain_committed /
 *   non_rearmable_retired）在无 intent/quarantine/marker/authorization-fault/
 *   pending 事实时可压缩为 retirement summary；
 * - summary 是**精确权威**（不是 Bloom filter/概率结构）：永久阻止 root ID
 *   重用（prepare 门禁含 summary 索引）、证明终态、绑定 root identity 与
 *   lineageId、区分 committed/non-rearmable、O(1) 查询、不依赖普通
 *   receipt/tombstone retention；
 * - 独立硬容量（TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES）：满载 fail closed
 *   ——不删除旧 summary、不压缩 active record、新 chain 经 active 容量门禁
 *   拒绝（ensureTreasuryLineageSlotAvailable 的压缩钩子返回 0）；
 * - forensic_isolated 不得自动压缩（保持 pin / 独立 forensic 处理）；
 * - 写入顺序：summary 写入 + read-back 完整验证成功 → 才删除 active record
 *   （压缩失败零删除）；删除后同步全部索引；
 * - 输入深拷贝隔离（alias 不污染 Memory）；store 损坏 → unhealthy，prepare
 *   fail closed。
 */

import {
  peekTreasuryAttemptLineageHealth,
  listTreasuryTerminalLineageIds,
  readTreasuryAttemptLineageRecord,
  removeTreasuryAttemptLineageRecordForCompaction,
  registerTreasuryLineageCompactorForAssembly,
  computeTreasuryLineageIdentityDigest,
  type TreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import { readTreasuryIntentEntry, peekTreasuryIntentHealth } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry, peekTreasuryQuarantineHealth } from "@/runtime/treasury/quarantine";
import { readTreasuryAuthorizationFaultEntry, peekTreasuryAuthorizationFaultHealth } from "@/runtime/treasury/authorizationFaults";
import { readTreasuryWriteFault, validateTreasuryWriteFaultMarkerShape } from "@/runtime/treasury/writeFault";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";

export const TREASURY_RETIREMENT_SUMMARY_VERSION = 1;
/** 独立硬容量（evidence 记录推导：≤128 × ~250B ≈ 32KB Memory 上界）。 */
export const TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES = 128;

const SUMMARY_KEY_PREFIX = "rs:";
const SUMMARY_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

export type TreasuryLineageTerminalState = "chain_committed" | "non_rearmable_retired";

export interface TreasuryLineageRetirementSummary {
  readonly schemaVersion: number;
  /** 16hex lineage 身份（root + identity 派生——与 active record 同源）。 */
  readonly lineageId: string;
  readonly rootTransactionId: string;
  /** root identity 合成 digest（root 永久退休门禁的紧凑绑定）。 */
  readonly rootIdentityDigest: string;
  readonly terminalState: TreasuryLineageTerminalState;
  /** chain 最终 generation（committed 的一代 / non-rearmable 退休的一代）。 */
  readonly finalGeneration: number;
  /** 最终 attempt ID（chain_committed 的 child / non-rearmable 的 current）。 */
  readonly finalAttemptId: string;
  readonly finalizedAtTick: number;
}

export interface TreasuryRetirementSummaryStore {
  readonly version: number;
  readonly entries: Record<string, TreasuryLineageRetirementSummary>;
  entryCount: number;
  updatedAt: number;
}

interface TreasurySummaryBranch {
  lineageRetirementSummaries?: TreasuryRetirementSummaryStore;
}

type RuntimeMemoryWithSummary = NonNullable<Memory["runtime"]> & {
  treasury?: TreasurySummaryBranch;
};

/** 诊断计数（opcount/metrics 用）。 */
export const retirementSummaryEvents = {
  fullScans: 0,
  compactions: 0,
  compactionRejections: 0,
  writes: 0,
  writeFailures: 0,
};

export function resetTreasuryRetirementSummaryRuntimeForTest(): void {
  heapRuntime = null;
  Object.assign(retirementSummaryEvents, { fullScans: 0, compactions: 0, compactionRejections: 0, writes: 0, writeFailures: 0 });
}

interface TreasurySummaryRuntime {
  readonly store: TreasuryRetirementSummaryStore;
  readonly fatal: string | null;
  published: boolean;
  readonly byRoot: Map<string, string>;
  readonly byLineageId: Map<string, string>;
}

let heapRuntime: TreasurySummaryRuntime | null = null;

function validateSummaryShape(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return "summary 非对象";
  const candidate = summary as Partial<TreasuryLineageRetirementSummary>;
  if (candidate.schemaVersion !== TREASURY_RETIREMENT_SUMMARY_VERSION) {
    return `summary.schemaVersion 非法（${String(candidate.schemaVersion)}）`;
  }
  if (typeof candidate.lineageId !== "string" || !SUMMARY_DIGEST_PATTERN.test(candidate.lineageId)) {
    return "summary.lineageId 非法（须 16 小写 hex）";
  }
  if (typeof candidate.rootTransactionId !== "string" || candidate.rootTransactionId.length === 0 || candidate.rootTransactionId.length > 128) {
    return "summary.rootTransactionId 非法";
  }
  if (typeof candidate.rootIdentityDigest !== "string" || !SUMMARY_DIGEST_PATTERN.test(candidate.rootIdentityDigest)) {
    return "summary.rootIdentityDigest 非法（须 16 小写 hex）";
  }
  if (candidate.terminalState !== "chain_committed" && candidate.terminalState !== "non_rearmable_retired") {
    return `summary.terminalState 非法: ${String(candidate.terminalState)}`;
  }
  for (const field of ["finalGeneration", "finalizedAtTick"] as const) {
    const value = candidate[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return `summary.${field} 非安全非负整数`;
    }
  }
  if (typeof candidate.finalAttemptId !== "string" || candidate.finalAttemptId.length === 0 || candidate.finalAttemptId.length > 128) {
    return "summary.finalAttemptId 非法";
  }
  return null;
}

function validateSummaryStoreShape(store: TreasuryRetirementSummaryStore): string | null {
  if (!store || typeof store !== "object") return "summary store 非对象";
  if (store.version !== TREASURY_RETIREMENT_SUMMARY_VERSION) {
    return `summary store 版本未知（${String(store.version)}）——fail closed`;
  }
  if (!store.entries || typeof store.entries !== "object") return "summary store.entries 非对象";
  const ownKeys = Object.keys(store.entries);
  if (ownKeys.length !== store.entryCount) {
    return `summary entryCount 不一致（ownKeys ${String(ownKeys.length)}，entryCount ${String(store.entryCount)}）`;
  }
  if (store.entryCount > TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES) {
    return `summary store 超过硬容量（${String(store.entryCount)} > ${String(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES)}）`;
  }
  const seenLineage = new Set<string>();
  for (const key of ownKeys) {
    if (!key.startsWith(SUMMARY_KEY_PREFIX)) return `summary key 非法（须 ${SUMMARY_KEY_PREFIX} 前缀）: ${key.slice(0, 24)}`;
    const summary = store.entries[key];
    const shapeError = validateSummaryShape(summary);
    if (shapeError !== null) return `summary entry 损坏（${key.slice(0, 24)}）: ${shapeError}`;
    if (key !== SUMMARY_KEY_PREFIX + summary.rootTransactionId) {
      return `summary key 与 rootTransactionId 不一致（${key.slice(0, 24)}）`;
    }
    if (seenLineage.has(summary.lineageId)) {
      return `summary lineageId 重复（${summary.lineageId.slice(0, 12)}）`;
    }
    seenLineage.add(summary.lineageId);
  }
  return null;
}

function publishSummaryStoreToMemory(runtime: TreasurySummaryRuntime): void {
  const target = ((Memory.runtime ??= {} as NonNullable<Memory["runtime"]>) as unknown as RuntimeMemoryWithSummary);
  const branch = (target.treasury ??= {});
  if (branch.lineageRetirementSummaries === undefined) {
    branch.lineageRetirementSummaries = runtime.store as unknown as NonNullable<(typeof branch)["lineageRetirementSummaries"]>;
  }
  runtime.published = true;
}

function loadSummaryRuntime(forWrite = false): TreasurySummaryRuntime {
  if (heapRuntime !== null) return heapRuntime;
  retirementSummaryEvents.fullScans += 1;
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithSummary | undefined)?.treasury;
  if (branch?.lineageRetirementSummaries === undefined) {
    const store: TreasuryRetirementSummaryStore = {
      version: TREASURY_RETIREMENT_SUMMARY_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    heapRuntime = { store, fatal: null, published: false, byRoot: new Map(), byLineageId: new Map() };
    if (forWrite) publishSummaryStoreToMemory(heapRuntime);
    return heapRuntime;
  }
  const store = branch.lineageRetirementSummaries as unknown as TreasuryRetirementSummaryStore;
  const fatal = validateSummaryStoreShape(store);
  const runtime: TreasurySummaryRuntime = { store, fatal, published: true, byRoot: new Map(), byLineageId: new Map() };
  if (fatal === null) {
    for (const [key, summary] of Object.entries(store.entries)) {
      runtime.byRoot.set(summary.rootTransactionId, key);
      runtime.byLineageId.set(summary.lineageId, key);
    }
  }
  heapRuntime = runtime;
  return runtime;
}

export interface TreasuryRetirementSummaryHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
}

/** 零写健康探测（store 不存在视为健康空——fail closed 只对损坏store）。 */
export function peekTreasuryRetirementSummaryHealth(): TreasuryRetirementSummaryHealth {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithSummary | undefined)?.treasury;
  if (branch?.lineageRetirementSummaries === undefined) {
    return { healthy: true, detail: null, entryCount: 0 };
  }
  const runtime = loadSummaryRuntime();
  if (runtime.fatal !== null) {
    return { healthy: false, detail: runtime.fatal, entryCount: 0 };
  }
  return { healthy: true, detail: null, entryCount: runtime.store.entryCount };
}

/** root ID → summary 的 O(1) 查询（prepare 永久退休门禁的一部分）。 */
export function lookupTreasuryRetirementSummaryByRoot(rootTransactionId: string): Readonly<TreasuryLineageRetirementSummary> | undefined {
  const runtime = loadSummaryRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.byRoot.get(rootTransactionId);
  if (key === undefined) return undefined;
  const summary = runtime.store.entries[key];
  if (summary === undefined) return undefined;
  return treasuryBoundedDeepFreezeSnapshot(summary) as Readonly<TreasuryLineageRetirementSummary>;
}

/** lineageId → summary 的 O(1) 查询（诊断/防重复压缩）。 */
export function lookupTreasuryRetirementSummaryByLineageId(lineageId: string): Readonly<TreasuryLineageRetirementSummary> | undefined {
  const runtime = loadSummaryRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.byLineageId.get(lineageId);
  if (key === undefined) return undefined;
  const summary = runtime.store.entries[key];
  if (summary === undefined) return undefined;
  return treasuryBoundedDeepFreezeSnapshot(summary) as Readonly<TreasuryLineageRetirementSummary>;
}

/** 单条压缩（summary 写入 + read-back → 删除 active record）。 */
function compactTerminalLineageRecord(record: Readonly<TreasuryAttemptLineageRecord>): { readonly status: "compacted" } | { readonly status: "rejected"; readonly detail: string } {
  // ── 压缩资格（24.10）：终态 + 无任何 pending authority/marker 事实。
  if (record.state !== "chain_committed" && record.state !== "non_rearmable_retired") {
    return { status: "rejected", detail: `非终态（state ${String(record.state)}）` };
  }
  const currentId = record.currentTransactionId;
  if (readTreasuryIntentEntry(currentId) !== undefined) {
    return { status: "rejected", detail: "final attempt 仍存在 durable intent（commit-pending / authority 未清）" };
  }
  if (readTreasuryQuarantineEntry(currentId) !== undefined) {
    return { status: "rejected", detail: "final attempt 仍存在 durable quarantine" };
  }
  if (readTreasuryAuthorizationFaultEntry(currentId) !== undefined || readTreasuryAuthorizationFaultEntry(record.rootTransactionId) !== undefined) {
    return { status: "rejected", detail: "仍存在 authorization-fault authority" };
  }
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && validateTreasuryWriteFaultMarkerShape(marker) !== null) {
    return { status: "rejected", detail: "write-fault marker 损坏（fail closed——不压缩）" };
  }
  if (marker !== undefined && (marker.transactionId === currentId || marker.transactionId === record.rootTransactionId)) {
    return { status: "rejected", detail: "write-fault marker 尚未清理（pending marker 不压缩）" };
  }
  // ── summary 写入（先于 active 删除；read-back 完整验证）。
  const runtime = loadSummaryRuntime(true);
  if (!runtime.published) publishSummaryStoreToMemory(runtime);
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: runtime.fatal };
  }
  const key = SUMMARY_KEY_PREFIX + record.rootTransactionId;
  const existing = Object.prototype.hasOwnProperty.call(runtime.store.entries, key)
    ? runtime.store.entries[key]
    : undefined;
  if (existing !== undefined) {
    // 已有同 root summary（幂等压缩重入 / root 重用冲突防御）——identity 必须
    // 一致，否则拒绝（不覆盖、不删除 active record）。
    const identityMatch =
      existing.lineageId === record.lineageId &&
      existing.rootIdentityDigest === computeTreasuryLineageIdentityDigest(record.rootIdentity) &&
      existing.terminalState === record.state;
    if (!identityMatch) {
      return { status: "rejected", detail: "同 root 已存在不同 identity 的 summary（压缩拒绝——不覆盖安全事实）" };
    }
  } else {
    if (runtime.store.entryCount >= TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES) {
      return { status: "rejected", detail: `retirement summary 已达硬容量 ${String(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES)}（不删除旧 summary、不压缩 active record——fail closed）` };
    }
    const published = cloneTreasuryDurableValue<TreasuryLineageRetirementSummary>({
      schemaVersion: TREASURY_RETIREMENT_SUMMARY_VERSION,
      lineageId: record.lineageId,
      rootTransactionId: record.rootTransactionId,
      rootIdentityDigest: computeTreasuryLineageIdentityDigest(record.rootIdentity),
      terminalState: record.state,
      finalGeneration: record.generation,
      finalAttemptId: currentId,
      finalizedAtTick: Game.time,
    });
    runtime.store.entries[key] = published;
    runtime.store.updatedAt = Game.time;
    if (validateSummaryShape(runtime.store.entries[key]) !== null || JSON.stringify(runtime.store.entries[key]) !== JSON.stringify(published)) {
      delete runtime.store.entries[key];
      runtime.store.updatedAt = Game.time;
      retirementSummaryEvents.writeFailures += 1;
      return { status: "rejected", detail: "summary read-back 验证失败（不删除 active record）" };
    }
    runtime.store.entryCount += 1;
    runtime.byRoot.set(published.rootTransactionId, key);
    runtime.byLineageId.set(published.lineageId, key);
    retirementSummaryEvents.writes += 1;
  }
  // ── summary 已持久化验证 → 删除 active record（失败零删除已保证顺序）。
  const removed = removeTreasuryAttemptLineageRecordForCompaction(record.lineageId);
  if (removed.status === "rejected") {
    return { status: "rejected", detail: `active record 删除失败（summary 保留）: ${removed.detail}` };
  }
  retirementSummaryEvents.compactions += 1;
  return { status: "compacted" };
}

/** 显式压缩单条 lineage（beginTick 有界批处理 / 测试与运维通道）。 */
export function compactTreasuryTerminalLineage(lineageId: string): { readonly status: "compacted" } | { readonly status: "rejected"; readonly detail: string } {
  const record = readTreasuryAttemptLineageRecord(lineageId);
  if (record === undefined) {
    return { status: "rejected", detail: `lineage ${lineageId.slice(0, 16)} 不存在` };
  }
  const result = compactTerminalLineageRecord(record);
  if (result.status === "rejected") retirementSummaryEvents.compactionRejections += 1;
  return result;
}

/**
 * beginTick 的有界终态压缩：只处理 terminalIds（≤ active 容量上界；空闲为空
 * ——零成本）。store unhealthy 时不压缩（fail closed）。
 */
export function compactTreasuryTerminalLineagesAtTickBoundary(): number {
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) return 0;
  if (!peekTreasuryIntentHealth().healthy || !peekTreasuryQuarantineHealth().healthy || !peekTreasuryAuthorizationFaultHealth().healthy) {
    return 0;
  }
  let compacted = 0;
  for (const lineageId of listTreasuryTerminalLineageIds()) {
    const result = compactTreasuryTerminalLineage(lineageId);
    if (result.status === "compacted") compacted += 1;
  }
  return compacted;
}

// 装配注册（attemptLineage 容量预检的压缩钩子——满载时先压缩终态 record）。
registerTreasuryLineageCompactorForAssembly(compactTreasuryTerminalLineagesAtTickBoundary);
