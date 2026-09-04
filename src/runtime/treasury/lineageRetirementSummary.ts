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
import { peekTreasuryReceiptHealth } from "@/runtime/treasury/receipts";
import { readTreasuryTrustedSettlementProofForAttempt } from "@/runtime/treasury/trustedSettlementProof";
import { readTreasuryResolutionTombstone, peekTreasuryResolutionStoreHealth } from "@/runtime/treasury/resolutionStore";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { registerTreasuryLineageResetHook } from "@/runtime/treasury/receipts";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import {
  expectedTreasuryCurrentLineageExactIdentity,
  describeTreasuryCurrentLineageRequiredness,
} from "@/runtime/treasury/currentLineageSettlementVerifier";
import {
  TREASURY_TERMINAL_ROOT_IDENTITY_ALGORITHM,
  TREASURY_TERMINAL_EXACT_IDENTITY_SCHEMA,
  validateTreasuryTerminalRootExactShape,
  validateTreasuryTerminalFinalExactShape,
  type TreasuryTerminalRootExactIdentity,
  type TreasuryTerminalFinalExactIdentity,
} from "@/runtime/treasury/terminalExactIdentity";
import { verifyTreasuryGenerationRetirementRelation } from "@/runtime/treasury/generationRetirementRelation";
import { treasuryExactAttemptIdentityOfReceiptProof, treasuryExactAttemptIdentityOfTombstone, treasuryExactAttemptIdentityRelation } from "@/runtime/treasury/exactAttemptIdentity";
import { computeTreasuryGenerationRootIdentityDigest } from "@/runtime/treasury/generationRetirementAuthority";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { formatTreasuryRearmChildTransactionIdV2, hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import { treasuryIdentityProfileOfFacts, treasuryProofClassOfIdentityProfile } from "@/runtime/treasury/identityProfile";
import {
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
  readTreasuryGenerationRetirementProof,
  releaseOrphanTreasuryGenerationRetirementProofs,
} from "@/runtime/treasury/generationRetirementAuthority";
import {
  peekTreasuryResolutionCleanupHealth,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { registerTreasurySemanticSummarySourceForAssembly } from "@/runtime/treasury/semanticLineageValidation";
import { registerTreasurySettlementSummaryHealthSourceForAssembly, verifyTreasuryOppositeProofAbsence } from "@/runtime/treasury/currentSettlementCoordinator";
import { archiveTreasuryCleanupCompletionViaAuthority } from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  absorbTreasuryRetiredSequence,
  compressTreasuryChainHistoricalEntries,
  lookupTreasuryChainRetirementCertificate,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryChainRetirementCertificateHealth,
  recordTreasuryChainRetirementCertificate,
  registerTreasuryRetirementSummaryProbeForAssembly,
} from "@/runtime/treasury/chainRetirementCertificate";
import { parseTreasuryIssuedInitialAttemptId } from "@/runtime/treasury/attemptIssuer";

/**
 * 【第二十一轮 7】summary v3：持久化 root / final exact identity（exact
 * terminal authority）。v3 之前（v1/v2）的 store 是 replay-only——root 永久
 * 重放门禁保留，但不得证明 terminal current / 授权新写入。
 */
export const TREASURY_RETIREMENT_SUMMARY_VERSION = 3;
/** legacy store 版本（v2/v1——load 只读解释，不自动迁移到 v3）。 */
export const TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION = 2;
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
  /**
   * root identity 合成 digest（root 永久退休门禁的紧凑绑定）。
   * 【v3】canonical 单一口径：computeTreasuryGenerationRootIdentityDigest
   * (rootExact 五元)——不再保留"双口径任一匹配"语义（旧口径 summary 是
   * replay-only）。
   */
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
  /** 【v3】canonical root exact identity（root replacement 的权威证明）。 */
  readonly rootExact?: TreasuryTerminalRootExactIdentity;
  /** 【v3】final attempt 的完整 exact identity（terminal current 的权威证明）。 */
  readonly finalExact?: TreasuryTerminalFinalExactIdentity;
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
  completionArchivePending: 0,
};

export function resetTreasuryRetirementSummaryRuntimeForTest(): void {
  heapRuntime = null;
  Object.assign(retirementSummaryEvents, { fullScans: 0, compactions: 0, compactionRejections: 0, writes: 0, writeFailures: 0, completionArchivePending: 0 });
}

interface TreasurySummaryRuntime {
  readonly store: TreasuryRetirementSummaryStore;
  readonly fatal: string | null;
  published: boolean;
  readonly byRoot: Map<string, string>;
  readonly byLineageId: Map<string, string>;
}

let heapRuntime: TreasurySummaryRuntime | null = null;

/** 【XI 工作流 D】最近一次 compaction 孤儿清理 pending 诊断（GRA release 被阻断——proof 保留）。 */
let lastCompactionOrphanReleasePending: string | null = null;

/** 只读：最近一次 compaction 的 GRA 孤儿释放 pending（null = 无 pending 记录）。 */
export function peekTreasuryCompactionOrphanReleasePending(): string | null {
  return lastCompactionOrphanReleasePending;
}

function validateSummaryShape(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return "summary 非对象";
  const candidate = summary as Partial<TreasuryLineageRetirementSummary>;
  if (candidate.schemaVersion !== TREASURY_RETIREMENT_SUMMARY_VERSION && candidate.schemaVersion !== TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION) {
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
  // 【第二十一轮 7】exact identity 字段矩阵：
  // - v3：rootExact / finalExact 必须存在且形状合法（authorityClass 与
  //   finalExact.proofClass 强制一致；rootIdentityDigest 与 rootExact canonical
  //   重算一致；finalAttemptId 派生与 finalGeneration 相容）；
  // - v2（legacy replay-only）：不得携带 exact 字段（半升级形态 = 损坏）。
  if (candidate.schemaVersion === TREASURY_RETIREMENT_SUMMARY_VERSION) {
    if (candidate.rootExact === undefined || candidate.finalExact === undefined) {
      return "v3 summary 缺少 rootExact/finalExact（exact terminal authority 必填）";
    }
    const rootShapeError = validateTreasuryTerminalRootExactShape(candidate.rootExact);
    if (rootShapeError !== null) return `summary.rootExact 损坏: ${rootShapeError}`;
    const finalShapeError = validateTreasuryTerminalFinalExactShape(candidate.finalExact, candidate.finalGeneration);
    if (finalShapeError !== null) return `summary.finalExact 损坏: ${finalShapeError}`;
    if (candidate.authorityClass === undefined || candidate.authorityClass !== candidate.finalExact.proofClass) {
      return "v3 summary 的 authorityClass 与 finalExact.proofClass 不一致（class 双权威矛盾）";
    }
    const canonicalRootDigest = computeTreasuryGenerationRootIdentityDigest(candidate.rootExact);
    if (canonicalRootDigest !== candidate.rootIdentityDigest) {
      return "v3 summary 的 rootIdentityDigest 与 rootExact canonical 重算不一致（单一口径）";
    }
    if (candidate.finalExact.durableIdentityDigest === undefined) {
      return "v3 summary 的 finalExact 缺 durableIdentityDigest（弱身份不得充当 terminal authority）";
    }
    // 【第二十二轮第十五节】canonical 派生重算（load/写入自证——不依赖
    // 后续 semantic 调用才发现）：lineageId/finalAttemptId/parent/binding
    // 派生 + rootExact 的 profile 推导与 authorityClass 一致。
    // lineageId 的 root 绑定派生由 GRA 的 computeLineageIdFromRootBinding 校验
    // 承载（summary 的 rootIdentityDigest 含 provenance 回落口径，与 record
    // 派生口径存在已知设计差异——双口径不在此重复强制）。
    const expectedFinalAttemptId = candidate.finalGeneration <= 0
      ? candidate.rootTransactionId
      : formatTreasuryRearmChildTransactionIdV2({ lineageId: candidate.lineageId, generation: candidate.finalGeneration, rootTransactionId: candidate.rootTransactionId });
    if (expectedFinalAttemptId !== candidate.finalAttemptId) {
      return "canonical：finalAttemptId 与 (lineageId, root, finalGeneration) 派生不一致";
    }
    if (candidate.finalGeneration >= 1) {
      const expectedParent = candidate.finalGeneration === 1
        ? candidate.rootTransactionId
        : formatTreasuryRearmChildTransactionIdV2({ lineageId: candidate.lineageId, generation: candidate.finalGeneration - 1, rootTransactionId: candidate.rootTransactionId });
      if (candidate.finalExact?.parentTransactionId === undefined || candidate.finalExact.parentTransactionId !== expectedParent) {
        return "canonical：finalExact.parentTransactionId 与上一代确定性派生不一致";
      }
      const expectedBinding = computeTreasuryLineageBindingDigest({
        lineageId: candidate.lineageId,
        generation: candidate.finalGeneration,
        parentTransactionId: expectedParent,
        childTransactionId: candidate.finalAttemptId,
      });
      if (candidate.finalExact!.lineageBindingDigest !== expectedBinding) {
        return "canonical：finalExact.lineageBindingDigest 权威重算不一致";
      }
    }
    const rootProfile = treasuryIdentityProfileOfFacts(candidate.rootExact!);
    if (rootProfile === null || treasuryProofClassOfIdentityProfile(rootProfile) !== candidate.authorityClass) {
      return "canonical：rootExact 的 profile 推导与 authorityClass 不一致（partial/矛盾——store unhealthy）";
    }
  } else {
    if (candidate.rootExact !== undefined || candidate.finalExact !== undefined) {
      return "legacy v2 summary 携带 exact identity 字段（半升级形态——损坏，fail closed）";
    }
  }
  return null;
}

function validateSummaryStoreShape(store: TreasuryRetirementSummaryStore): string | null {
  if (!store || typeof store !== "object") return "summary store 非对象";
  // 【第二十一轮 7】store version 2 是 legacy replay-only（root 门禁保留，
  // terminal exact 语义不可证明）；版本未知 fail closed。
  if (store.version !== TREASURY_RETIREMENT_SUMMARY_VERSION && store.version !== TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION) {
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
    // 【第二十一轮 7】store 版本与 entry schemaVersion 必须一致（v3 store 含
    // v2 entry = 混合形态损坏；v2 store 的 replay-only 语义依赖版本隔离）。
    if (summary.schemaVersion !== store.version) {
      return `summary entry schemaVersion ${String(summary.schemaVersion)} 与 store version ${String(store.version)} 不一致（混合版本 store——fail closed）`;
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
  let store = branch.lineageRetirementSummaries as unknown as TreasuryRetirementSummaryStore;
  // 【XII 工作流 D / Q4】query 不迁移：读路径（forWrite=false）遇 v1/v2
  // legacy 版本 → fatal（migration_required——fail closed，原数据保留、
  // 零写）；迁移只由写路径 load（forWrite=true）或 beginTick migration
  // owner 执行。
  if (!forWrite && (store.version === 1 || store.version === TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION)) {
    const pendingRuntime: TreasurySummaryRuntime = {
      store,
      fatal: `summary store v${String(store.version)} 待迁移（query 零写——beginTick migration owner 执行）`,
      published: true,
      byRoot: new Map(),
      byLineageId: new Map(),
    };
    heapRuntime = pendingRuntime;
    return pendingRuntime;
  }
  // 【第十九轮 E / 第二十一轮 7.4】v1 → v2 迁移（原子：临时结构验证通过后
  // 一次替换；失败保留原数据并 fail closed）：v2 只新增可选 authorityClass
  //（v1 summary 无来源可补）。迁移零字段变换（version 提升而已）。
  // 【第二十一轮 7.4】v1/v2 都是 replay-only——不自动补造 exact identity，
  // 不迁移到 v3（只有能从仍存在的 active lineage 与 matching 外部 settlement
  // proof 确定性重建时才允许升级，而 v1/v2 summary 存在意味着 active record
  // 已删除——无法重建）。root 永久重放门禁不受影响。
  if (store.version === 1) {
    // entry 级 schemaVersion 一并提升（v2 只新增可选 authorityClass——纯格式
    // 升级，零字段变换；任一 entry 形状损坏 → 整体保留原数据 fail closed）。
    const migratedEntries: Record<string, TreasuryLineageRetirementSummary> = {};
    for (const [key, summary] of Object.entries(store.entries)) {
      migratedEntries[key] = { ...summary, schemaVersion: TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION };
    }
    const upgraded: TreasuryRetirementSummaryStore = {
      version: TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION,
      entries: migratedEntries,
      entryCount: store.entryCount,
      updatedAt: store.updatedAt,
    };
    const dbgV12 = validateSummaryStoreShape(upgraded);
    if (dbgV12 === null) {
      retirementSummaryEvents.fullScans += 1;
      branch.lineageRetirementSummaries = upgraded as unknown as NonNullable<(typeof branch)["lineageRetirementSummaries"]>;
      // 【第二十二轮】v1→v2 迁移成功后不在此 return——fall through 到 v2
      // legacy archive 拆分段（同一 load 内完成 v1→v2→archive 链）。
      store = upgraded;
    } else {
      const fatalRuntime: TreasurySummaryRuntime = { store, fatal: "summary store v1→v2 迁移自检失败（原数据保留 fail closed）", published: true, byRoot: new Map(), byLineageId: new Map() };
      heapRuntime = fatalRuntime;
      return fatalRuntime;
    }
  }
  // 【第二十二轮第十四节】legacy v2 store 拆分到独立 replay archive：不再
  // 阻止未来 exact 压缩。legacy summary 永久保留 root 重放门禁，但不得
  // 证明 terminal current / historical eviction；新 exact summary 继续写入
  // 主 store（v3）。双平面 root 唯一性由压缩前 cross-plane 检查承载。
  if (store.version === TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION) {
    const legacyBranch = branch as unknown as { legacyRetirementSummaries?: TreasuryRetirementSummaryStore };
    if (legacyBranch.legacyRetirementSummaries === undefined) {
      legacyBranch.legacyRetirementSummaries = { version: TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION, entries: { ...store.entries }, entryCount: store.entryCount, updatedAt: store.updatedAt };
    } else {
      const existing = legacyBranch.legacyRetirementSummaries;
      for (const [key, summary] of Object.entries(store.entries)) {
        const dup = Object.values(existing.entries).find((e) => e.rootTransactionId === summary.rootTransactionId || e.lineageId === summary.lineageId);
        if (dup !== undefined && (dup.rootTransactionId !== summary.rootTransactionId || dup.lineageId !== summary.lineageId)) {
          const fatalRuntime: TreasurySummaryRuntime = { store, fatal: "legacy archive 与 legacy store 的 root/lineageId 冲突（fail closed——不覆盖）", published: true, byRoot: new Map(), byLineageId: new Map() };
          heapRuntime = fatalRuntime;
          return fatalRuntime;
        }
        existing.entries[key] = summary;
        existing.entryCount += 1;
      }
    }
    const rebuilt: TreasuryRetirementSummaryStore = {
      version: TREASURY_RETIREMENT_SUMMARY_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    branch.lineageRetirementSummaries = rebuilt as unknown as NonNullable<(typeof branch)["lineageRetirementSummaries"]>;
    const rebuiltRuntime: TreasurySummaryRuntime = { store: rebuilt, fatal: null, published: true, byRoot: new Map(), byLineageId: new Map() };
    heapRuntime = rebuiltRuntime;
    return rebuiltRuntime;
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
/** 【第二十二轮第十四节】legacy replay archive 只读查询（root 重放门禁——不证明 terminal current）。 */
export function lookupTreasuryLegacyRetirementSummaryByRoot(rootTransactionId: string): Readonly<TreasuryLineageRetirementSummary> | undefined {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithSummary | undefined)?.treasury as { legacyRetirementSummaries?: TreasuryRetirementSummaryStore } | undefined;
  const archive = branch?.legacyRetirementSummaries;
  if (archive === undefined) return undefined;
  for (const summary of Object.values(archive.entries)) {
    if (summary.rootTransactionId === rootTransactionId) {
      return treasuryBoundedDeepFreezeSnapshot(summary) as Readonly<TreasuryLineageRetirementSummary>;
    }
  }
  return undefined;
}

/** 双平面 root 唯一性检查（root 相同 identity 不一致 → conflict 详情；一致/无冲突 → null）。 */
export function treasuryRetirementSummaryCrossPlaneConflictDetail(rootTransactionId: string): string | null {
  const exact = lookupTreasuryRetirementSummaryByRoot(rootTransactionId);
  const legacy = lookupTreasuryLegacyRetirementSummaryByRoot(rootTransactionId);
  if (exact !== undefined && legacy !== undefined && exact.lineageId !== legacy.lineageId) {
    return `root ${rootTransactionId.slice(0, 16)} 在 exact 与 legacy 双平面的 identity 不一致（fail closed——不覆盖）`;
  }
  return null;
}

/** 【诊断/测试】当前 summary entry 数（只读——store 不存在 = 0）。 */
export function peekTreasuryRetirementSummaryEntryCount(): number {
  const raw = (Memory.runtime as unknown as { treasury?: { lineageRetirementSummaries?: { entries?: Record<string, unknown> } } } | undefined)
    ?.treasury?.lineageRetirementSummaries;
  if (raw === undefined) return 0;
  return Object.keys(raw.entries ?? {}).length;
}

/**
 * 【XII 工作流 D / Q7】summary store legacy 版本的 tick-boundary 显式迁移
 * （唯一 migration owner——beginTick 前置阶段调用）。absent/v3 → idle
 * （零写）；v1/v2 → 复用写路径 load（forWrite=true）的确定性迁移（v1→v2
 * + legacy archive 拆分）+ 全量重验 + 原子替换；失败 → blocked（原数据
 * 保留，读路径继续 fail closed）。
 */
export function migrateTreasuryRetirementSummaryStoreLegacyAtTickBoundary(): { status: "idle" | "migrated" | "blocked"; detail: string | null } {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithSummary | undefined)?.treasury;
  const raw = branch?.lineageRetirementSummaries as { version?: unknown } | undefined;
  if (raw === undefined) return { status: "idle", detail: null };
  if (raw.version === TREASURY_RETIREMENT_SUMMARY_VERSION) return { status: "idle", detail: null };
  if (raw.version !== 1 && raw.version !== TREASURY_RETIREMENT_SUMMARY_LEGACY_VERSION) {
    return { status: "blocked", detail: `summary store 版本未知（${String(raw.version).slice(0, 8)}——不迁移，fail closed）` };
  }
  const runtime = loadSummaryRuntime(true);
  if (runtime.fatal !== null) {
    return { status: "blocked", detail: runtime.fatal };
  }
  return { status: "migrated", detail: null };
}

export function lookupTreasuryRetirementSummaryByRoot(rootTransactionId: string): Readonly<TreasuryLineageRetirementSummary> | undefined {
  const runtime = loadSummaryRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.byRoot.get(rootTransactionId);
  if (key !== undefined) {
    const summary = runtime.store.entries[key];
    if (summary !== undefined) {
      return treasuryBoundedDeepFreezeSnapshot(summary) as Readonly<TreasuryLineageRetirementSummary>;
    }
  }
  // 【第二十二轮第十四节】root/lineage lookup 同时检查两个平面：legacy
  // archive 的 root 重放门禁永久保留（v2 entry 在 semantic 层 replay-only）。
  return lookupTreasuryLegacyRetirementSummaryByRoot(rootTransactionId);
}

/** lineageId → summary 的 O(1) 查询（诊断/防重复压缩）。 */
export function lookupTreasuryRetirementSummaryByLineageId(lineageId: string): Readonly<TreasuryLineageRetirementSummary> | undefined {
  const runtime = loadSummaryRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.byLineageId.get(lineageId);
  if (key !== undefined) {
    const summary = runtime.store.entries[key];
    if (summary !== undefined) {
      return treasuryBoundedDeepFreezeSnapshot(summary) as Readonly<TreasuryLineageRetirementSummary>;
    }
  }
  // 【第二十二轮第十四节】双平面 lookup（archive 的 v2 entry 在 semantic
  // 层按 replay-only 处理——terminal current 恒 insufficient）。archive 按
  // lineageId 线性查（容量 128 有界——load 时已保证）。
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithSummary | undefined)?.treasury as { legacyRetirementSummaries?: TreasuryRetirementSummaryStore } | undefined;
  const archive = branch?.legacyRetirementSummaries;
  if (archive === undefined) return undefined;
  for (const summary of Object.values(archive.entries)) {
    if (summary.lineageId === lineageId) {
      return treasuryBoundedDeepFreezeSnapshot(summary) as Readonly<TreasuryLineageRetirementSummary>;
    }
  }
  return undefined;
}

/** 单条压缩（summary 写入 + read-back → 历史代 proof 验证 → 删除 active record → 孤儿 proof 清理）。 */

/** 【第二十一轮 7.1/7.2】record → summary candidate 的 root exact identity（canonical 单一构造）。 */
/**
 * 【IX 工作流 C / 6.2】summary ↔ certificate 的正面 replacement relation
 * 验证（Q2-Q4 全维度——"同 root 有一个 certificate"不足以授权删除）：
 * root ID / lineageId / terminalState / finalGeneration / finalAttemptId /
 * rootSequence 与 summary root 的发行序号一致；certificate 本身 shape 健康
 * （含 canonical child checksum——lookup 单条复验承载）。返回 null = 验证
 * 通过；字符串 = 不一致维度（不驱逐）。
 */
export function verifyTreasurySummaryCertificateReplacement(
  summary: Readonly<TreasuryLineageRetirementSummary>,
  certificate: Readonly<{ rootSequence: number; lineageId: string; rootTransactionId: string; finalAttemptId: string; finalGeneration: number; terminalState: string }>,
): string | null {
  if (certificate.rootTransactionId !== summary.rootTransactionId) return "root ID 不一致";
  if (certificate.lineageId !== summary.lineageId) return "lineageId 不一致";
  if (certificate.terminalState !== summary.terminalState) return "terminalState 与 summary 相反";
  if (certificate.finalGeneration !== summary.finalGeneration) return "finalGeneration 不一致";
  if (certificate.finalAttemptId !== summary.finalAttemptId) return "finalAttemptId 不一致";
  const parsedRoot = parseTreasuryIssuedInitialAttemptId(summary.rootTransactionId);
  if (parsedRoot === null || certificate.rootSequence !== parsedRoot.sequence) return "rootSequence 与 root 发行序号不一致";
  // 【X 工作流 D / N10】issuer domain 显式维度：rootSequence 不能脱离
  // root namespace 单独充当 replacement——同序号不同域（ti1_ vs ti2_）
  // 的 summary ↔ certificate 一律 conflict。
  const parsedCertificateRoot = parseTreasuryIssuedInitialAttemptId(certificate.rootTransactionId);
  if (parsedCertificateRoot === null || parsedCertificateRoot.namespace !== parsedRoot.namespace) {
    return "rootSequence 的发行域不一致（ti1_/ti2_ 是两个独立发行域——同序号不构成 replacement）";
  }
  return null;
}

function rootExactOfRecord(record: Readonly<TreasuryAttemptLineageRecord>): TreasuryTerminalRootExactIdentity {
  const rootLowlevelSource = record.rootIdentity.lowlevelSource ?? (record.authorityClass === "lowlevel" ? record.lowlevelSource : undefined);
  return {
    digest: record.rootIdentity.digest,
    ...(record.rootIdentity.contractDigest !== undefined ? { contractDigest: record.rootIdentity.contractDigest } : {}),
    ...(record.rootIdentity.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: record.rootIdentity.authorizationCohortDigest } : {}),
    ...(record.rootIdentity.durableIdentityDigest !== undefined ? { durableIdentityDigest: record.rootIdentity.durableIdentityDigest } : {}),
    ...(rootLowlevelSource !== undefined ? { lowlevelSource: rootLowlevelSource } : {}),
    proofClass: record.authorityClass,
    identityAlgorithm: TREASURY_TERMINAL_ROOT_IDENTITY_ALGORITHM,
  };
}

/** 【第二十一轮 7.2】record → summary candidate 的 final exact identity（canonical 单一构造）。 */
function finalExactOfRecord(record: Readonly<TreasuryAttemptLineageRecord>): TreasuryTerminalFinalExactIdentity {
  const lowlevelSource = record.currentIdentity.lowlevelSource ?? record.lowlevelSource;
  return {
    digest: record.currentIdentity.digest,
    ...(record.currentIdentity.contractDigest !== undefined ? { contractDigest: record.currentIdentity.contractDigest } : {}),
    ...(record.currentIdentity.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: record.currentIdentity.authorizationCohortDigest } : {}),
    ...(record.currentIdentity.durableIdentityDigest !== undefined ? { durableIdentityDigest: record.currentIdentity.durableIdentityDigest } : {}),
    ...(lowlevelSource !== undefined ? { lowlevelSource } : {}),
    proofClass: record.authorityClass,
    ...(record.generation >= 1
      ? { parentTransactionId: record.currentParentTransactionId!, lineageBindingDigest: record.bindingDigest! }
      : {}),
    ...(record.retrySemanticDigest !== undefined ? { retrySemanticDigest: record.retrySemanticDigest } : {}),
    exactIdentitySchema: TREASURY_TERMINAL_EXACT_IDENTITY_SCHEMA,
  };
}

/**
 * 四方 proof 的第四方：candidate finalExact ↔ record current exact（构造自
 * 同一 record——显式 relation 验证防御构造逻辑漂移）。null = 一致。
 */
function candidateFinalExactRelationError(
  currentExact: ReturnType<typeof expectedTreasuryCurrentLineageExactIdentity>,
  finalExact: TreasuryTerminalFinalExactIdentity,
): string | null {
  if (currentExact === null) return "record current exact identity 不可构造";
  if (currentExact.proofClass !== finalExact.proofClass) return "proof class 不一致";
  if (currentExact.digest !== finalExact.digest) return "digest 不一致";
  const dimensions: readonly (readonly [string, string | undefined, string | undefined])[] = [
    ["contractDigest", currentExact.contractDigest, finalExact.contractDigest],
    ["authorizationCohortDigest", currentExact.authorizationCohortDigest, finalExact.authorizationCohortDigest],
    ["durableIdentityDigest", currentExact.durableIdentityDigest, finalExact.durableIdentityDigest],
    ["lowlevelSource", currentExact.lowlevelSource, finalExact.lowlevelSource],
    ["parentTransactionId", currentExact.parentTransactionId, finalExact.parentTransactionId],
    ["lineageBindingDigest", currentExact.lineageBindingDigest, finalExact.lineageBindingDigest],
  ];
  for (const [field, current, final_] of dimensions) {
    if ((current ?? undefined) !== (final_ ?? undefined)) return `${field} 不一致`;
  }
  return null;
}

function compactTerminalLineageRecord(record: Readonly<TreasuryAttemptLineageRecord>): { readonly status: "compacted"; readonly chainHistoricalRetired?: number; readonly completionArchivePending?: readonly string[] } | { readonly status: "rejected"; readonly detail: string } {
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
  // ──【第二十一轮 11.1/11.2】exact four-way proof：外部终态证明（committed
  //    receipt / final not-executed tombstone）↔ active lineage current exact
  //    identity ↔ semantic lineage authority ↔ summary candidate final exact
  //    identity 四者全部 match（单一比较入口 currentLineageSettlementVerifier
  //    的 expected 构造 + exactAttemptIdentity relation / generation
  //    retirement relation——record.state 终态本身不足以授权删除 active 权威）。
  const requirednessError = describeTreasuryCurrentLineageRequiredness(record);
  if (requirednessError !== null) {
    return { status: "rejected", detail: `record current 身份不满足 requiredness（${requirednessError}）——不压缩` };
  }
  const currentExact = expectedTreasuryCurrentLineageExactIdentity(record);
  if (currentExact === null) {
    return { status: "rejected", detail: "record current exact identity 构造失败（不压缩）" };
  }
  if (record.state === "chain_committed") {
    // 【Remediation III 九】terminal compaction 的 committed receipt 必须
    // release-trusted：store 任一无关 entry 损坏 → store_unhealthy 不压缩
    //（replay-readable 单条读取不再作为压缩依据）。
    const compactionTrusted = readTreasuryTrustedSettlementProofForAttempt(currentId, currentExact);
    if (compactionTrusted.status !== "trusted_proof") {
      return { status: "rejected", detail: `chain_committed 的 trusted committed receipt ${compactionTrusted.status}: ${compactionTrusted.detail}——不压缩` };
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
        purpose: "committed_settlement",
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
    if (tombstone === undefined || tombstone.stage !== "final" || tombstone.resolution !== "not-executed") {
      return { status: "rejected", detail: "non_rearmable_retired 缺少 matching final not-executed tombstone——不压缩" };
    }
    if (!record.retirement.lineagePublished || !record.retirement.authorityReleased || !record.retirement.markerCleaned) {
      return { status: "rejected", detail: "non_rearmable_retired 的 retirement 三段未全部完成（publication/release/marker）——不压缩" };
    }
    // 【第二十一轮 11.2/11.3】tombstone ↔ record ↔ exact retirement proof 三方
    // relation（不能只检查 proof 存在性）。
    const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
    const tombstoneRelation = tombstoneExact === null ? ("insufficient" as const) : treasuryExactAttemptIdentityRelation(tombstoneExact, currentExact);
    if (tombstoneRelation !== "match") {
      return { status: "rejected", detail: `non_rearmable_retired 的 final tombstone 与 record current exact identity 不${tombstoneRelation === "conflict" ? "一致（conflict）" : "可证明（insufficient）"}——不压缩` };
    }
    const exactProof = readTreasuryGenerationRetirementProof(record.lineageId, record.generation);
    if (exactProof === undefined) {
      return { status: "rejected", detail: "当前代 exact retirement proof 缺失（三段布尔不构成 replacement——不压缩）" };
    }
    const retirementRelation = verifyTreasuryGenerationRetirementRelation({
      exactProof,
      // expected.rootIdentityDigest 与 GRA proof 写入口径一致（converge 用
      // record.rootIdentity 直接五元合成——relation 重算必须同口径）。
      expectedCurrent: { ...currentExact, rootTransactionId: record.rootTransactionId, rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(record.rootIdentity), authorityLineageId: record.lineageId, authorityGeneration: record.generation },
      tombstone,
    });
    if (retirementRelation.verdict !== "match") {
      return { status: "rejected", detail: `non_rearmable_retired 的 exact retirement proof 三方 relation 未通过（${retirementRelation.verdict}: ${retirementRelation.detail}）——不压缩` };
    }
  }
  // ── 【第二十二轮第十六节】相反结论 proof 显式不存在检查：“目标结论
  //    proof 存在”不等于“相反结论 proof 不存在”。chain_committed 目标旁存在
  //    matching final not-executed tombstone / GRA not-executed exact proof、
  //    或 non_rearmable 目标旁存在 trusted committed receipt / committed
  //    tombstone → 拒绝压缩（active lineage 保留）。exact identity 匹配——
  //    同 ID 的其它 attempt 不误阻断。
  const oppositeCheck = verifyTreasuryOppositeProofAbsence({
    outcome: record.state === "chain_committed" ? "committed" : "not-executed",
    attempt: currentExact,
  });
  if (oppositeCheck.blocked) {
    return { status: "rejected", detail: `相反结论 proof 存在（${oppositeCheck.sources.join(", ")}: ${oppositeCheck.details.join(" | ").slice(0, 192)}）——不压缩` };
  }
  // ── summary 写入（先于 active 删除；read-back 完整验证）。
  // 【第二十二轮第十四节】双平面 root 唯一性：压缩目标 root 已存在于
  // legacy archive 且 identity 不一致 → 拒绝（不覆盖）。
  const crossPlaneConflict = treasuryRetirementSummaryCrossPlaneConflictDetail(record.rootTransactionId);
  if (crossPlaneConflict !== null) {
    return { status: "rejected", detail: crossPlaneConflict };
  }
  const runtime = loadSummaryRuntime(true);
  if (!runtime.published) publishSummaryStoreToMemory(runtime);
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: runtime.fatal };
  }
  // 【第二十一轮 7.4/14.3】legacy replay-only store（v2）不接受新 summary
  // 写入——v2 entry 无法补造 exact identity，升级 store 会制造混合版本权威；
  // 拒绝压缩（active record 保留，明确诊断）。
  if (runtime.store.version !== TREASURY_RETIREMENT_SUMMARY_VERSION) {
    return {
      status: "rejected",
      detail: `retirement summary store 是 legacy replay-only 版本 ${String(runtime.store.version)}（不覆盖、不混合、不自动补造 exact identity——active record 保留）`,
    };
  }
  // 【第二十一轮 7.1/7.2】summary candidate 的 root/final exact identity 从
  // record 构造（canonical 单一构造——helper 复用，compaction 不自行展开）。
  const rootExact = rootExactOfRecord(record);
  const canonicalRootIdentityDigest = computeTreasuryGenerationRootIdentityDigest(rootExact);
  const finalExact = finalExactOfRecord(record);
  // 四方 proof 的最后一方：candidate finalExact ↔ record current exact（构造
  // 自同一 record，relation 显式验证——防御构造逻辑漂移）。
  const candidateRelationError = candidateFinalExactRelationError(currentExact, finalExact);
  if (candidateRelationError !== null) {
    return { status: "rejected", detail: `summary candidate final exact identity 与 record current exact identity 不一致（${candidateRelationError}）——不压缩` };
  }
  const key = SUMMARY_KEY_PREFIX + record.rootTransactionId;
  const existing = Object.prototype.hasOwnProperty.call(runtime.store.entries, key)
    ? runtime.store.entries[key]
    : undefined;
  if (existing !== undefined) {
    // 已有同 root summary（幂等压缩重入 / root 重用冲突防御）——【第二十一轮
    // 7.5】完整 exact 幂等：lineageId / root exact / terminal state / final
    // generation / final attempt ID / final exact identity / proof class /
    // lowlevel provenance / schema version 任一不同即拒绝（不覆盖、不删除
    // active record）。
    const identityMatch =
      existing.lineageId === record.lineageId &&
      existing.schemaVersion === TREASURY_RETIREMENT_SUMMARY_VERSION &&
      existing.rootIdentityDigest === canonicalRootIdentityDigest &&
      JSON.stringify(existing.rootExact) === JSON.stringify(rootExact) &&
      existing.terminalState === record.state &&
      existing.finalGeneration === record.generation &&
      existing.finalAttemptId === currentId &&
      JSON.stringify(existing.finalExact) === JSON.stringify(finalExact) &&
      existing.authorityClass === record.authorityClass;
    if (!identityMatch) {
      return { status: "rejected", detail: "同 root 已存在不同 identity 的 summary（exact 幂等失败——不覆盖安全事实）" };
    }
  } else {
    if (runtime.store.entryCount >= TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES) {
      // 【VIII 工作流 E2/L1】满载不再永久 fail closed：现代 service-issued
      // chain 的 summary 条目在 replacement authority（chain certificate
      // 在位，或其 root 序号已被 retired range 吸收）写入并 read-back 后
      // 可驱逐——certificate 承接 chain 权威（root/final/terminalState +
      // 协议 outcome），range 承接 anti-reuse；summary 只是审计视图。
      // 无可驱逐条目（全 legacy pin / replacement 不在位）→ fail closed。
      const eviction = evictTreasuryRetirementSummaryForCapacity();
      if (eviction.status === "rejected") {
        return { status: "rejected", detail: `retirement summary 已达硬容量 ${String(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES)} 且无可安全驱逐条目（${eviction.detail}——fail closed）` };
      }
    }
    const published = cloneTreasuryDurableValue<TreasuryLineageRetirementSummary>({
      schemaVersion: TREASURY_RETIREMENT_SUMMARY_VERSION,
      lineageId: record.lineageId,
      rootTransactionId: record.rootTransactionId,
      rootIdentityDigest: canonicalRootIdentityDigest,
      terminalState: record.state,
      finalGeneration: record.generation,
      finalAttemptId: currentId,
      finalizedAtTick: Game.time,
      // 【第十九轮 E v2】chain 的 proof class（压缩后历史代 tombstone 的
      // class 比较权威）。【第二十一轮 7】v3 强制与 finalExact.proofClass 一致。
      authorityClass: record.authorityClass,
      rootExact,
      finalExact,
    });
    runtime.store.entries[key] = published;
    runtime.store.updatedAt = Game.time;
    const readBackShapeError = validateSummaryShape(runtime.store.entries[key]);
    if (readBackShapeError !== null || JSON.stringify(runtime.store.entries[key]) !== JSON.stringify(published)) {
      delete runtime.store.entries[key];
      runtime.store.updatedAt = Game.time;
      retirementSummaryEvents.writeFailures += 1;
      return { status: "rejected", detail: `summary read-back 验证失败（${readBackShapeError ?? "JSON 不一致"}——不删除 active record）` };
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
  // 【XI 工作流 D】孤儿清理统一经 GRA release authority（去谓词注入——
  // tombstone/journal/lineage/索引由 primitive 内部自验，调用方检查不再
  // 构成授权）；blocked → 结构化 pending（compaction 安全完成但 proof 保留，
  // 不谎称已释放——诊断写入模块级 pending 记录）。
  const orphanRelease = releaseOrphanTreasuryGenerationRetirementProofs(record.lineageId);
  if (orphanRelease.blockedDetail !== null) {
    lastCompactionOrphanReleasePending = orphanRelease.blockedDetail;
  } else if (orphanRelease.retained === 0) {
    lastCompactionOrphanReleasePending = null;
  }
/**
 * 【IX 工作流 C / Q5】range-only 替代（anti-reuse-only 不得替代 exact
 * summary）前的 exact 依赖检查：summary 的 root / finalAttemptId 仍被任何
 * active cleanup journal 或 generation retirement proof 引用时不得驱逐。
 * 相关 store unhealthy 视为依赖在位（fail closed——不把"读不到"解释成无
 * 依赖）。返回 null = 无 exact 依赖；字符串 = 依赖描述。
 */
function summaryExactDependenciesActive(summary: Readonly<TreasuryLineageRetirementSummary>): string | null {
  const journalHealth = peekTreasuryResolutionCleanupHealth();
  if (!journalHealth.healthy) return `cleanup journal store unhealthy（fail closed）: ${journalHealth.detail ?? ""}`;
  const graHealth = peekTreasuryGenerationRetirementHealth();
  if (!graHealth.healthy) return `generation retirement store unhealthy（fail closed）: ${graHealth.detail ?? ""}`;
  for (const attemptId of [summary.rootTransactionId, summary.finalAttemptId]) {
    if (readTreasuryResolutionCleanupEntry(attemptId) !== undefined) {
      return `cleanup journal 引用 ${attemptId.slice(0, 24)}`;
    }
    if (lookupTreasuryGenerationRetirementProofByAttemptId(attemptId) !== undefined) {
      return `generation retirement proof 引用 ${attemptId.slice(0, 24)}`;
    }
  }
  return null;
}

/**
 * 【VIII E2/L1 → IX 工作流 C】retirement summary 满载驱逐：有界 eligible
 * 扫描（全部现代条目按 root 发行序号升序——Q8：队首不可清理不永久停机，
 * 在硬容量范围内找到可安全淘汰项）。eligibility：
 *  1. matching chain certificate 在位且 verifyTreasurySummaryCertificateReplacement
 *     全维度通过（Q2-Q4）——certificate 承接 chain 的 protocol 权威；
 *  2. 或 retired range 结构化查询 present 且无 exact 依赖（Q5：anti-reuse
 *     -only 只有在 exact terminal facts 不再被 active cleanup / semantic
 *     exact path 需要时才可替代）；
 *  3. range store_unhealthy/malformed → 该条不驱逐（Q1：损坏不当作
 *     replacement 在位），继续扫描其它条目；全部不 eligible → fail closed。
 * legacy pin（非 ti root）不驱逐。删除 + Memory read-back + 结构化结果。
 */
function evictTreasuryRetirementSummaryForCapacity():
  | { readonly status: "evicted"; readonly rootTransactionId: string }
  | { readonly status: "rejected"; readonly detail: string } {
  const runtime = loadSummaryRuntime(true);
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: `retirement summary store fail-closed: ${runtime.fatal}` };
  }
  const modern = Object.entries(runtime.store.entries)
    .map(([key, entry]) => {
      const parsed = parseTreasuryIssuedInitialAttemptId(entry.rootTransactionId);
      return parsed === null ? null : { key, entry, namespace: parsed.namespace, sequence: parsed.sequence };
    })
    .filter((item): item is { key: string; entry: TreasuryLineageRetirementSummary; namespace: "legacy" | "current"; sequence: number } => item !== null)
    // 【X 工作流 D】驱逐顺序按（发行域, 序号）——current 域优先淘汰（活跃
    // 域的旧事实更快进入 range/certificate 接管；legacy 域序号靠后）。
    .sort((left, right) =>
      left.namespace !== right.namespace ? (left.namespace < right.namespace ? -1 : 1) : left.sequence - right.sequence,
    );
  if (modern.length === 0) {
    return { status: "rejected", detail: "满载条目全部为 legacy pin（无现代条目可驱逐）" };
  }
  const certificateHealth = peekTreasuryChainRetirementCertificateHealth();
  if (!certificateHealth.healthy) {
    return { status: "rejected", detail: `chain certificate store 不可读（replacement 无法验证——Q1 fail closed）: ${certificateHealth.detail ?? ""}` };
  }
  let evictTarget: { key: string; entry: TreasuryLineageRetirementSummary } | null = null;
  let evictDetail = "";
  for (const item of modern) {
    const certificate = lookupTreasuryChainRetirementCertificate(item.entry.rootTransactionId);
    if (certificate !== undefined) {
      const relationError = verifyTreasurySummaryCertificateReplacement(item.entry, certificate);
      if (relationError === null) {
        evictTarget = item;
        evictDetail = "matching certificate replacement relation 验证通过";
        break;
      }
      continue; // relation 不一致（Q2-Q4）——不驱逐该条，继续扫描
    }
    const rangeLookup = lookupTreasuryRetiredRangeStructured(item.entry.rootTransactionId);
    if (rangeLookup.status !== "present") continue; // absent/store_unhealthy/malformed 均不驱逐（Q1）
    const dependency = summaryExactDependenciesActive(item.entry);
    if (dependency !== null) continue; // Q5：exact 依赖仍在
    evictTarget = item;
    evictDetail = `retired range ${rangeLookup.detail} 已接管 anti-reuse 且无 exact 依赖`;
    break;
  }
  if (evictTarget === null) {
    return {
      status: "rejected",
      detail: "满载条目均不可安全驱逐（replacement relation 不一致 / range 不在位或损坏 / exact 依赖仍在——不删除 exact facts）",
    };
  }
  const evictKey = evictTarget.key;
  const evictRoot = evictTarget.entry.rootTransactionId;
  const evictedLineage = runtime.store.entries[evictKey]!.lineageId;
  delete runtime.store.entries[evictKey];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  runtime.byRoot.delete(evictRoot);
  runtime.byLineageId.delete(evictedLineage);
  const rawStore = (Memory.runtime as unknown as { treasury?: { lineageRetirementSummaries?: { entries?: Record<string, unknown>; entryCount?: number } } } | undefined)
    ?.treasury?.lineageRetirementSummaries;
  if (rawStore === undefined || rawStore.entries?.[evictKey] !== undefined || rawStore.entryCount !== runtime.store.entryCount) {
    return { status: "rejected", detail: "summary 驱逐 read-back 失败（已尽力删除——调用方按满载 fail closed 处理）" };
  }
  return { status: "evicted", rootTransactionId: evictRoot, ...(evictDetail.length > 0 ? { detail: evictDetail } : {}) };
}



  // ──【Remediation VII 修复四】chain retirement certificate：summary 已
  //    完整写入 read-back 后，把 chain 的永久防重放权威压缩为单条
  //    certificate（root/final 代/terminalState——footprint 与 generation
  //    数量无关）。certificate 写入失败（满载且全为 legacy pin / store
  //    unhealthy）→ 不压缩 historical（chain 的 per-attempt exact outcome
  //    保留——fail closed，不影响 summary 压缩本身）。
  let chainHistoricalRetired = 0;
  const terminalState: "chain_committed" | "non_rearmable_retired" = record.state;
  const compressChainAfterArchive = (): void => {
    const certificateWrite = recordTreasuryChainRetirementCertificate({
      lineageId: record.lineageId,
      rootTransactionId: record.rootTransactionId,
      finalAttemptId: currentId,
      finalGeneration: record.generation,
      terminalState,
    });
    if (certificateWrite.status !== "rejected") {
      // 【IX 工作流 C / 6.3】chain root 是 ti root 时把发行序号吸收进
      // retired range（monotonic anti-reuse frontier——chain 已终结、序号
      // 已消耗）：certificate 满载驱逐的前提从此建立（range present 才可
      // 驱逐 certificate；certificate 驱逐后 chain 查询退化为 retired——
      // Q6：旧 ID 返回 retired/protocol 而非 absent）。absorb 失败不回滚
      // certificate（anti-reuse 由 certificate 在位兜底——下轮压缩重试）。
      const parsedRoot = parseTreasuryIssuedInitialAttemptId(record.rootTransactionId);
      if (parsedRoot !== null) {
        // 【X 工作流 D / N9】吸收域取自 root ID 自带 namespace（ti1_/ti2_
        // 分别进入匹配域的 anti-reuse authority——historical compression
        // 吸收到匹配 namespace 的 range）。
        void absorbTreasuryRetiredSequence(parsedRoot.namespace, parsedRoot.sequence);
      }
      const compressed = compressTreasuryChainHistoricalEntries({
        rootTransactionId: record.rootTransactionId,
        lineageId: record.lineageId,
      });
      chainHistoricalRetired = compressed.retired;
    }
  };
  // ──【Remediation VI 4.5 / VII 修复五.5】final/root attempt 的 completion
  //    经统一 supersession authority 入口归档回收（exact replacement 验证
  //    → durable historical authority 写入 read-back → 删除 + read-back）。
  //    archive 结果不再被无条件忽略：blocked/interrupted（exact 不可证明/
  //    满载/损坏）→ completion 保留（fail closed），pending 事实随返回值
  //    结构化上报（容量交由 bounded headroom 回收；压缩已由 certificate
  //    承载 chain 权威——pending 不产生安全缺口）。
  const completionArchivePending: string[] = [];
  {
    const currentArchive = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: currentId, via: "any-exact" });
    if (currentArchive.status === "blocked" || currentArchive.status === "interrupted") {
      retirementSummaryEvents.completionArchivePending += 1;
      completionArchivePending.push(currentId);
    }
    if (record.rootTransactionId !== currentId) {
      const rootArchive = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: record.rootTransactionId, via: "any-exact" });
      if (rootArchive.status === "blocked" || rootArchive.status === "interrupted") {
        retirementSummaryEvents.completionArchivePending += 1;
        completionArchivePending.push(record.rootTransactionId);
      }
    }
  }
  // 【Remediation VII 修复四】chain 压缩位于 completion archive **之后**：
  // 尾部归档新写入的 per-attempt entry 同样被 certificate 接管退休——
  // terminal 压缩后 historical 不残留任何该 chain 的 per-attempt 记录。
  compressChainAfterArchive();
  retirementSummaryEvents.compactions += 1;
  return {
    status: "compacted",
    ...(chainHistoricalRetired > 0 ? { chainHistoricalRetired } : {}),
    ...(completionArchivePending.length > 0 ? { completionArchivePending } : {}),
  };
}

/** 显式压缩单条 lineage（beginTick 有界批处理 / 测试与运维通道）。 */
export function compactTreasuryTerminalLineage(lineageId: string): { readonly status: "compacted"; readonly chainHistoricalRetired?: number; readonly completionArchivePending?: readonly string[] } | { readonly status: "rejected"; readonly detail: string } {
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
  registerTreasurySettlementSummaryHealthSourceForAssembly(() => {
  const health = peekTreasuryRetirementSummaryHealth();
  return { healthy: health.healthy, detail: health.detail ?? null };
});
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

// 【IX 工作流 C】certificate 驱逐的 summary probe（matching summary 在位
// 时不撤走其 replacement authority）与 certificate health probe（summary
// 驱逐的 replacement 验证前置——Q1）。
registerTreasuryRetirementSummaryProbeForAssembly({
  summaryOfRoot: (rootTransactionId) => lookupTreasuryRetirementSummaryByRoot(rootTransactionId),
  summaryStoreHealthy: () => peekTreasuryRetirementSummaryHealth().healthy,
});
// 【IX 工作流 E 8.3】统一 lifecycle owner resolver 的 summary 维度（terminal
// authority——阻断 sequence abandon，不阻断 reservation sweep）。
import { registerTreasuryLifecycleSummaryProbeForAssembly as __registerLifecycleSummaryProbe } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
__registerLifecycleSummaryProbe({
  summaryOfRoot: (rootTransactionId) => lookupTreasuryRetirementSummaryByRoot(rootTransactionId),
  summaryStoreHealthy: () => peekTreasuryRetirementSummaryHealth().healthy,
});
// 【IX 工作流 B/C → X 工作流 F】GRA 满载驱逐的 summary probe：modern-only
//（当前 exact schema v3——legacy replay-only archive 回落不进入驱逐判定，
// G6；关系全维度由 GRA 侧 verifyTreasuryGenerationSummaryReplacement 验证）。
import { registerTreasuryGenerationSummaryProbeForAssembly as __registerGenerationSummaryProbe } from "@/runtime/treasury/generationRetirementAuthority";
__registerGenerationSummaryProbe({
  summaryOfLineageId: (lineageId) => {
    const summary = lookupTreasuryRetirementSummaryByLineageId(lineageId);
    if (summary === undefined) return undefined;
    if (summary.schemaVersion !== TREASURY_RETIREMENT_SUMMARY_VERSION) return undefined;
    return summary;
  },
  summaryStoreHealthy: () => peekTreasuryRetirementSummaryHealth().healthy,
});
