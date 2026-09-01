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
import { readTreasurySettlementProof, peekTreasuryReceiptHealth } from "@/runtime/treasury/receipts";
import { readTreasuryResolutionTombstone, peekTreasuryResolutionStoreHealth } from "@/runtime/treasury/resolutionStore";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { registerTreasuryLineageResetHook } from "@/runtime/treasury/receipts";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import {
  peekTreasuryGenerationRetirementHealth,
  readTreasuryGenerationRetirementProof,
  releaseOrphanTreasuryGenerationRetirementProofs,
} from "@/runtime/treasury/generationRetirementAuthority";
import { registerTreasurySemanticSummarySourceForAssembly } from "@/runtime/treasury/semanticLineageValidation";

export const TREASURY_RETIREMENT_SUMMARY_VERSION = 2;
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
  /**
   * 【第十九轮 E v2】chain 的 authority/proof class——压缩后历史代 tombstone
   * 的 proof class 与此比较（v1 迁移 summary 缺失 → 历史代 verdict 保守
   * pin；root 永久门禁不受影响）。
   */
  readonly authorityClass?: "identity-bound" | "lowlevel";
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
  // 【第十九轮 E v2】authorityClass 可选（v1 迁移缺失 = 历史代 class 不可
  // 证明）；存在时必须是受控枚举。
  if (candidate.authorityClass !== undefined && candidate.authorityClass !== "identity-bound" && candidate.authorityClass !== "lowlevel") {
    return `summary.authorityClass 非法: ${String(candidate.authorityClass)}`;
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
  // 【第十九轮 E】v1 → v2 迁移（原子：临时结构验证通过后一次替换；失败
  // 保留原数据并 fail closed）：v2 只新增可选 authorityClass（v1 summary 无
  // 来源可补——迁移后历史代 tombstone 的 class 不可证明，verdict 保守 pin；
  // root 永久门禁不受影响）。迁移零字段变换（version 提升而已）。
  if (store.version === 1) {
    // entry 级 schemaVersion 一并提升（v2 只新增可选 authorityClass——纯格式
    // 升级，零字段变换；任一 entry 形状损坏 → 整体保留原数据 fail closed）。
    const migratedEntries: Record<string, TreasuryLineageRetirementSummary> = {};
    for (const [key, summary] of Object.entries(store.entries)) {
      migratedEntries[key] = { ...summary, schemaVersion: TREASURY_RETIREMENT_SUMMARY_VERSION };
    }
    const upgraded: TreasuryRetirementSummaryStore = {
      version: TREASURY_RETIREMENT_SUMMARY_VERSION,
      entries: migratedEntries,
      entryCount: store.entryCount,
      updatedAt: store.updatedAt,
    };
    if (validateSummaryStoreShape(upgraded) === null) {
      retirementSummaryEvents.fullScans += 1;
      branch.lineageRetirementSummaries = upgraded as unknown as NonNullable<(typeof branch)["lineageRetirementSummaries"]>;
      const runtime: TreasurySummaryRuntime = { store: upgraded, fatal: null, published: true, byRoot: new Map(), byLineageId: new Map() };
      for (const [key, summary] of Object.entries(upgraded.entries)) {
        runtime.byRoot.set(summary.rootTransactionId, key);
        runtime.byLineageId.set(summary.lineageId, key);
      }
      heapRuntime = runtime;
      return runtime;
    }
    const fatalRuntime: TreasurySummaryRuntime = { store, fatal: "summary store v1→v2 迁移自检失败（原数据保留 fail closed）", published: true, byRoot: new Map(), byLineageId: new Map() };
    heapRuntime = fatalRuntime;
    return fatalRuntime;
  }
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

/** 单条压缩（summary 写入 + read-back → 历史代 proof 验证 → 删除 active record → 孤儿 proof 清理）。 */
function compactTerminalLineageRecord(record: Readonly<TreasuryAttemptLineageRecord>): { readonly status: "compacted" } | { readonly status: "rejected"; readonly detail: string } {
  // ──【第二十轮 11.4】压缩前检查全部相关 store 健康（lineage/summary 自身
  //    由写入路径 load 承载；此处显式检查 resolution/receipt/exact
  //    retirement——任一 unhealthy 不压缩）。
  if (!peekTreasuryResolutionStoreHealth().healthy) {
    return { status: "rejected", detail: "resolution store unhealthy（compaction fail closed）" };
  }
  if (!peekTreasuryReceiptHealth().healthy) {
    return { status: "rejected", detail: "receipt store unhealthy（compaction fail closed）" };
  }
  if (!peekTreasuryGenerationRetirementHealth().healthy) {
    return { status: "rejected", detail: "exact generation retirement store unhealthy（compaction fail closed）" };
  }
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
  // ──【第二十轮 11.2/11.3】exact settlement identity 验证：外部终态证明与
  //    active lineage current 的**完整** exact identity 比较（digest/contract/
  //    cohort/durable/lowlevel + proof class + lineage 四字段）+ semantic
  //    lineage validation = match（record.state 终态本身不足以授权删除 active
  //    权威——summary 必须能在 record 消失后独立证明终态）。
  if (record.state === "chain_committed") {
    const receiptProof = readTreasurySettlementProof(currentId);
    const expectedClass = record.authorityClass;
    const receiptLineageMatches =
      receiptProof !== undefined &&
      receiptProof.level !== "legacy" &&
      receiptProof.level === expectedClass &&
      receiptProof.digest === record.currentIdentity.digest &&
      (receiptProof.contractDigest ?? undefined) === (record.currentIdentity.contractDigest ?? undefined) &&
      (receiptProof.authorizationCohortDigest ?? undefined) === (record.currentIdentity.authorizationCohortDigest ?? undefined) &&
      (receiptProof.durableIdentityDigest ?? undefined) === (record.currentIdentity.durableIdentityDigest ?? undefined) &&
      (receiptProof.lowlevelSource ?? undefined) === (record.currentIdentity.lowlevelSource ?? record.lowlevelSource ?? undefined) &&
      (record.generation >= 1
        ? receiptProof.lineageId === record.lineageId &&
          receiptProof.lineageGeneration === record.generation &&
          receiptProof.parentTransactionId === record.currentParentTransactionId &&
          receiptProof.lineageBindingDigest === record.bindingDigest
        : receiptProof.lineageId === undefined);
    if (!receiptLineageMatches) {
      return { status: "rejected", detail: "chain_committed 缺少 matching committed receipt（完整 exact settlement identity：digest/contract/cohort/durable/lowlevel + proof class + lineage proof 与 record 一致）——不压缩" };
    }
    if (record.generation >= 1) {
      const semantic = validateTreasurySemanticLineage({
        transactionId: currentId,
        proof: {
          lineageId: record.lineageId,
          lineageGeneration: record.generation,
          parentTransactionId: record.currentParentTransactionId!,
          lineageBindingDigest: record.bindingDigest!,
        },
        identity: {
          digest: record.currentIdentity.digest,
          ...(record.currentIdentity.contractDigest !== undefined ? { contractDigest: record.currentIdentity.contractDigest } : {}),
          ...(record.currentIdentity.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: record.currentIdentity.authorizationCohortDigest } : {}),
          ...(record.currentIdentity.durableIdentityDigest !== undefined ? { durableIdentityDigest: record.currentIdentity.durableIdentityDigest } : {}),
          ...((record.currentIdentity.lowlevelSource ?? record.lowlevelSource) !== undefined
            ? { lowlevelSource: record.currentIdentity.lowlevelSource ?? record.lowlevelSource }
            : {}),
        },
      });
      if (semantic.verdict !== "match") {
        return { status: "rejected", detail: `chain_committed 的 semantic lineage validation 未通过（${semantic.verdict}）——不压缩` };
      }
    }
  } else {
    const tombstone = readTreasuryResolutionTombstone(currentId);
    const tombstoneLineageMatches =
      tombstone !== undefined &&
      tombstone.stage === "final" &&
      tombstone.resolution === "not-executed" &&
      tombstone.proofLevel === record.authorityClass &&
      tombstone.digest === record.currentIdentity.digest &&
      (tombstone.contractDigest ?? undefined) === (record.currentIdentity.contractDigest ?? undefined) &&
      (tombstone.authorizationCohortDigest ?? undefined) === (record.currentIdentity.authorizationCohortDigest ?? undefined) &&
      (tombstone.durableIdentityDigest ?? undefined) === (record.currentIdentity.durableIdentityDigest ?? undefined) &&
      (tombstone.lowlevelSource ?? undefined) === (record.currentIdentity.lowlevelSource ?? record.lowlevelSource ?? undefined) &&
      (record.generation >= 1
        ? tombstone.lineageId === record.lineageId &&
          tombstone.lineageGeneration === record.generation &&
          tombstone.parentTransactionId === record.currentParentTransactionId &&
          tombstone.lineageBindingDigest === record.bindingDigest
        : tombstone.lineageId === undefined);
    if (!tombstoneLineageMatches) {
      return { status: "rejected", detail: "non_rearmable_retired 缺少 matching final not-executed tombstone（完整 exact settlement identity 与 record 一致）——不压缩" };
    }
    if (!record.retirement.lineagePublished || !record.retirement.authorityReleased || !record.retirement.markerCleaned) {
      return { status: "rejected", detail: "non_rearmable_retired 的 retirement 三段未全部完成（publication/release/marker）——不压缩" };
    }
    // 【第二十轮 11.3】当前代 exact retirement proof 必须在位（压缩后历史代
    // tombstone 的 replacement 由 exact proof 证明）。
    if (readTreasuryGenerationRetirementProof(record.lineageId, record.generation) === undefined) {
      return { status: "rejected", detail: "当前代 exact retirement proof 缺失（压缩后历史代证明缺失——不压缩）" };
    }
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
    // 已有同 root summary（幂等压缩重入 / root 重用冲突防御）——完整
    // identity 必须一致（【第二十轮 11.2】幂等比较扩展 finalGeneration/
    // finalAttemptId/authorityClass），否则拒绝（不覆盖、不删除 active record）。
    const identityMatch =
      existing.lineageId === record.lineageId &&
      existing.rootIdentityDigest === computeTreasuryLineageIdentityDigest(record.rootIdentity) &&
      existing.terminalState === record.state &&
      existing.finalGeneration === record.generation &&
      existing.finalAttemptId === currentId &&
      (existing.authorityClass ?? undefined) === (record.authorityClass ?? undefined);
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
      // 【第十九轮 E v2】chain 的 proof class（压缩后历史代 tombstone 的
      // class 比较权威）。
      authorityClass: record.authorityClass,
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
  // ──【第二十轮 11.5】summary 已持久化验证 → 历史 generation proof 可独立
  //    验证（仍存活 tombstone 的 exact proof 在位）→ 删除 active record（失败
  //    零删除已保证顺序）→ 清理该 lineage 中 tombstone 已不存在的孤儿 proof
  //    （per-chain 有界遍历；root 门禁由 summary 承担）。
  const removed = removeTreasuryAttemptLineageRecordForCompaction(record.lineageId);
  if (removed.status === "rejected") {
    return { status: "rejected", detail: `active record 删除失败（summary 保留）: ${removed.detail}` };
  }
  releaseOrphanTreasuryGenerationRetirementProofs(record.lineageId, (generation, proof) => {
    // 仍存活的 tombstone 依赖保留（generation 0 的 root tombstone 与 tr1_ child）。
    void generation;
    return readTreasuryResolutionTombstone(proof.transactionId) !== undefined;
  });
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

// 【第二十轮第六节】semantic lineage validator 的 terminal summary 只读
// source（模块加载注册——可重入：测试注销 sources 后可重新装配）。
export function registerTreasuryRetirementSummarySemanticSourceForAssembly(): void {
  registerTreasurySemanticSummarySourceForAssembly({
    healthy: () => peekTreasuryRetirementSummaryHealth().healthy,
    unhealthyDetail: () => peekTreasuryRetirementSummaryHealth().detail,
    readByLineageId: (lineageId) => lookupTreasuryRetirementSummaryByLineageId(lineageId),
  });
}
registerTreasuryRetirementSummarySemanticSourceForAssembly();

// 测试清理注册（receipts.clearTreasuryPersistenceForTest 统一调用——与
// attemptLineage 同一清理链，summary heap 缓存不跨测试泄漏）。
registerTreasuryLineageResetHook(resetTreasuryRetirementSummaryRuntimeForTest);

// 装配注册（attemptLineage 容量预检的压缩钩子——满载时先压缩终态 record）。
registerTreasuryLineageCompactorForAssembly(compactTreasuryTerminalLineagesAtTickBoundary);
