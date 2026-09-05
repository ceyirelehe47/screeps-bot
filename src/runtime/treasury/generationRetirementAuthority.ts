/**
 * 【第二十轮第十节】exact per-generation retirement authority。
 *
 * Round 18/19 断链：历史 generation 是否安全退休只能凭
 * "generation < currentGeneration + 状态机曾推进" 推断——上一代 retirement
 * 完成事实在 child 接管时被整体复位删除，没有独立、持久、可验证的
 * per-generation 证明。本模块为每个 final not-executed generation 持久化
 * 一条 exact retirement proof：
 *
 * - 写入顺序：retirement 三段全部收敛完成后、retiring → rearm_ready /
 *   non_rearmable_retired 状态推进**之前**写入 + Memory read-back 验证；
 *   写入失败（容量满载/冲突/损坏）→ retirement 保持 retiring（fail closed，
 *   不驱逐安全事实、不签发下一代）；
 * - 下一代门禁：Generation N+1 capability 只有 N 的 exact proof 持久化并
 *   read-back 后才可签发（attemptOccupancy preflight 校验）；
 * - 容量：硬容量 384（推导：resolution store 256 条 tombstone 的逐条依赖
 *   上界 + active lineage 64 条当前代余量 + 边界余量），满载 fail closed，
 *   不驱逐仍被 tombstone/summary 依赖的 proof；
 * - lookup O(1)（扁平 key `gr:<lineageId>:<generationHex>` + heap byLineage
 *   索引）；不保存无界数组；global reset 首次 load 一次有界全表验证与索引
 *   重建，正常 tick 不重复扫描；
 * - 回收（有界，依赖驱动）：resolution tombstone 驱逐（replacement verdict
 *   为 match）后经注入 hook 释放对应代 proof；chain 压缩后由
 *   lineageRetirementSummary 调用孤儿清理（该 lineage 中 tombstone 已不
 *   存在的历史代 proof）。root 永久门禁由 retirement summary 承担（本
 *   store 不承担 root 门禁语义）；
 * - 旧数据：Round 18/19 历史代缺 exact proof → verdict insufficient / pin
 *   （不自动补现代 proof、不猜测）。
 */

import {
  isValidTreasuryTransactionId,
  isTreasuryRearmAttemptId,
  parseTreasuryRearmChildTransactionIdV2,
  formatTreasuryRearmChildTransactionIdV2,
  hashTreasuryCanonicalString,
  encodeTreasuryCanonicalTuple,
} from "@/runtime/treasury/transactionId";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import { registerTreasuryLineageResetHook } from "@/runtime/treasury/receipts";
import {
  registerTreasuryGenerationProofSourceForAssembly,
  peekTreasurySemanticLineageRecordSource,
  type TreasuryGenerationProofSource,
} from "@/runtime/treasury/semanticLineageValidation";
import {
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionTombstone,
  registerTreasuryGenerationProofReleaseForAssembly,
} from "@/runtime/treasury/resolutionStore";
import {
  peekTreasuryResolutionCleanupHealth,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  TREASURY_IDENTITY_PROFILES,
  treasuryProofClassOfIdentityProfile,
  validateTreasuryIdentityProfileFacts,
  treasuryIdentityProfileOfFacts,
} from "@/runtime/treasury/identityProfile";
import { parseTreasuryIssuedInitialAttemptId } from "@/runtime/treasury/attemptIssuer";
import { peekTreasuryIntentStoreValidation, readTreasuryIntentEntryForQuery } from "@/runtime/treasury/intents";
import { peekTreasuryQuarantineStoreValidation, readTreasuryQuarantineEntryForQuery } from "@/runtime/treasury/quarantine";
import { peekTreasuryAuthorizationFaultStoreValidation, readTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import { peekTreasuryWriteFaultHealth, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import {
  lookupTreasuryChainRetirementCertificate,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryChainRetirementCertificateHealth,
} from "@/runtime/treasury/chainRetirementCertificate";

export const TREASURY_GENERATION_RETIREMENT_VERSION = 2;
/** v1（Round 20 exact proof，无 identityProfile）——确定性迁移到 v2。 */
const TREASURY_GENERATION_RETIREMENT_LEGACY_VERSION = 1;
/** 硬容量（evidence 记录推导：256 tombstone 依赖上界 + 64 active 当前代 + 余量）。 */
export const TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES = 384;

const PROOF_KEY_PREFIX = "gr:";
const DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/** exact per-generation retirement proof（可独立验证的该代退休权威）。 */
export interface TreasuryGenerationRetirementProof {
  readonly schemaVersion: 2;
  /** 【第二十二轮第十一节】显式 identity profile（v2 必带——禁止 optional
   * 字段反向推断等级；legacy-replay / forensic-isolated 不参与自动协议）。 */
  readonly identityProfile: import("@/runtime/treasury/identityProfile").TreasuryIdentityProfile;
  /** 16hex lineage 身份（与 active record / summary 同源）。 */
  readonly lineageId: string;
  readonly rootTransactionId: string;
  /** root identity 合成 digest（与 summary.rootIdentityDigest 同算法绑定）。 */
  readonly rootIdentityDigest: string;
  /** 该 proof 证明的 generation（root=0；child ≥1）。 */
  readonly generation: number;
  /** 该代 attempt ID（gen0=root；gen≥1=v2 派生）。 */
  readonly transactionId: string;
  /** gen≥1 必填：该代 parent attempt ID（= 上一代确定性派生）。 */
  readonly parentTransactionId?: string;
  /** gen≥1 必填：该代 lineage binding digest（权威重算绑定）。 */
  readonly bindingDigest?: string;
  /** 该代 canonical payload digest（完整 attempt identity 维度）。 */
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly authorityClass: "identity-bound" | "lowlevel";
  readonly retrySemanticDigest?: string;
  readonly resolution: "not_executed";
  /** 三段完成事实（proof 形状强制全 true——写入前置条件由调用方 converge 保证）。 */
  readonly retirement: {
    readonly lineagePublished: true;
    readonly authorityReleased: true;
    readonly markerCleaned: true;
  };
  readonly completedAtTick: number;
}

export interface TreasuryGenerationRetirementStore {
  readonly version: number;
  readonly entries: Record<string, TreasuryGenerationRetirementProof>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryGenerationRetirementBranch {
  generationRetirementProofs?: TreasuryGenerationRetirementStore;
}

type RuntimeMemoryWithGenerationRetirement = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryGenerationRetirementBranch;
};

/** 诊断计数（opcount/metrics 用）。 */
export const generationRetirementEvents = {
  fullScans: 0,
  writes: 0,
  writeFailures: 0,
  idempotentWrites: 0,
  releases: 0,
  orphanReleases: 0,
  /** 【第二十一轮 10.3】全局 transactionId 唯一性冲突计数。 */
  indexConflicts: 0,
  /** 【第二十二轮】v1→v2 迁移自检失败计数。 */
  incompatibleFailures: 0,
};

export function resetTreasuryGenerationRetirementRuntimeForTest(): void {
  heapRuntime = null;
  Object.assign(generationRetirementEvents, {
    fullScans: 0,
    writes: 0,
    writeFailures: 0,
    idempotentWrites: 0,
    releases: 0,
    orphanReleases: 0,
    indexConflicts: 0,
  });
}

/**
 * test-only：直删单条 proof（验证 tombstone replacement verdict / 依赖行为
 * 的 fixture 构造——测试目的是观察"proof 缺失"后的下游行为，不是释放语义
 * 本身）。生产零调用（test-only 命名 + 架构守护）；同步维护 heap 索引与
 * Memory。返回是否实际删除。
 */
export function removeTreasuryGenerationRetirementProofForTest(transactionId: string): boolean {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) return false;
  const key = runtime.byAttempt.get(transactionId);
  if (key === undefined) return false;
  const proof = runtime.store.entries[key];
  if (proof === undefined) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  runtime.byAttempt.delete(transactionId);
  const keys = runtime.byLineage.get(proof.lineageId);
  if (keys !== undefined) {
    keys.delete(key);
    if (keys.size === 0) runtime.byLineage.delete(proof.lineageId);
  }
  return true;
}

// 测试清理注册（receipts.clearTreasuryPersistenceForTest 统一调用——模块
// 单向依赖，避免 receipts ↔ 本模块循环 import）。
registerTreasuryLineageResetHook(resetTreasuryGenerationRetirementRuntimeForTest);

interface TreasuryGenerationRetirementRuntime {
  readonly store: TreasuryGenerationRetirementStore;
  readonly fatal: string | null;
  published: boolean;
  /** lineageId → 该 chain 的全部 store key（容量上界内的有界集合）。 */
  readonly byLineage: Map<string, Set<string>>;
  /** attempt ID（root 或 tr1_ child）→ store key（tombstone 驱逐联动释放 O(1)）。 */
  readonly byAttempt: Map<string, string>;
}

let heapRuntime: TreasuryGenerationRetirementRuntime | null = null;

// ── key 与派生（纯函数） ─────────────────────────────────────────────────────

function toHex6(value: number): string {
  return (value >>> 0).toString(16).padStart(6, "0");
}

function encodeGenerationProofKey(lineageId: string, generation: number): string {
  return `${PROOF_KEY_PREFIX}${lineageId}:${toHex6(generation)}`;
}

/**
 * 【第二十一轮 10.2】root 身份绑定共享 canonical 算法（与
 * attemptLineage.computeTreasuryAttemptLineageId 同协议——lineageId 由
 * rootTransactionId + rootIdentityDigest 派生）：proof 的三_ROOT 字段必须
 * 互相可验证，不能只检查格式合法。协议常量复制自 attemptLineage（模块
 * 单向依赖：attemptLineage import 本模块，不得反向）。
 */
const LINEAGE_ID_DERIVATION_BASIS = "treasury-attempt-lineage@v1";

function computeLineageIdFromRootBinding(rootTransactionId: string, rootIdentityDigest: string): string {
  return hashTreasuryCanonicalString(`${LINEAGE_ID_DERIVATION_BASIS}:${rootTransactionId}:${rootIdentityDigest}`);
}

/** proof 内部一致性重算（load/写入/read-back/查询共用）：ID/parent/binding/class 派生 + class 字段矩阵 + root 绑定。 */
function validateTreasuryGenerationRetirementProofSemantics(proof: TreasuryGenerationRetirementProof): string | null {
  const isRearm = isTreasuryRearmAttemptId(proof.transactionId);
  if (proof.generation === 0) {
    if (!isRearm && proof.transactionId !== proof.rootTransactionId) {
      return "generation 0 的 transactionId 必须是 root 本身";
    }
    if (proof.parentTransactionId !== undefined || proof.bindingDigest !== undefined) {
      return "generation 0 不得携带 parentTransactionId/bindingDigest（root 无 binding）";
    }
    if (isRearm) {
      return "generation 0 的 root 不得是 tr1_ ID（rearm child 不能作为 root）";
    }
  } else {
    if (!isRearm) {
      return `generation ≥1 的 transactionId 必须是 tr1_ child ID（got ${proof.transactionId.slice(0, 24)}）`;
    }
    const parsed = parseTreasuryRearmChildTransactionIdV2(proof.transactionId);
    if (parsed === null) return "generation ≥1 的 transactionId 非 v2 generation-addressable 形态";
    if (parsed.lineageId !== proof.lineageId || parsed.generation !== proof.generation) {
      return "transactionId 内嵌 (lineageId, generation) 与 proof 字段不一致";
    }
    if (proof.parentTransactionId === undefined || proof.bindingDigest === undefined) {
      return "generation ≥1 必须携带 parentTransactionId 与 bindingDigest";
    }
    const expectedParent = proof.generation - 1 <= 0
      ? proof.rootTransactionId
      : encodeTreasuryRearmChildId(proof.lineageId, proof.generation - 1, proof.rootTransactionId);
    if (proof.parentTransactionId !== expectedParent) {
      return "parentTransactionId 与上一代确定性派生不一致";
    }
    const expectedBinding = computeTreasuryLineageBindingDigest({
      lineageId: proof.lineageId,
      generation: proof.generation,
      parentTransactionId: expectedParent,
      childTransactionId: proof.transactionId,
    });
    if (proof.bindingDigest !== expectedBinding) {
      return "bindingDigest 与 (lineageId, generation, parent, child) 权威重算不一致";
    }
  }
  // ──【第二十一轮 10.1】proof-class required/forbidden 字段矩阵。
  if (proof.authorityClass === "identity-bound") {
    if (proof.lowlevelSource !== undefined) {
      return "identity-bound proof 携带 lowlevelSource（class 矛盾）";
    }
    if (proof.durableIdentityDigest === undefined) {
      return "identity-bound proof 缺 durableIdentityDigest（不得持久化只有普通 digest 的 identity-bound exact proof）";
    }
    // modern contract 来源（携带任一 contract 维度）必须成对保留。
    if (
      (proof.contractDigest !== undefined || proof.authorizationCohortDigest !== undefined) &&
      (proof.contractDigest === undefined || proof.authorizationCohortDigest === undefined)
    ) {
      return "modern contract 来源的 identity-bound proof 必须成对携带 contractDigest 与 authorizationCohortDigest";
    }
  } else {
    if (typeof proof.lowlevelSource !== "string") {
      return "lowlevel proof 缺少 lowlevelSource";
    }
    if (proof.durableIdentityDigest === undefined) {
      return "lowlevel proof 缺 durableIdentityDigest";
    }
    if (proof.contractDigest !== undefined || proof.authorizationCohortDigest !== undefined) {
      return "lowlevel proof 携带 modern contract/cohort 事实（class 矛盾）";
    }
  }
  // ──【第二十一轮 10.2】root 身份绑定：(rootTransactionId, rootIdentityDigest)
  //    共享 canonical 算法重算 lineageId——三者互相验证。
  if (computeLineageIdFromRootBinding(proof.rootTransactionId, proof.rootIdentityDigest) !== proof.lineageId) {
    return "proof 的 (rootTransactionId, rootIdentityDigest, lineageId) 不满足共享 canonical 派生（root 绑定不可验证）";
  }
  return null;
}

function encodeTreasuryRearmChildId(lineageId: string, generation: number, rootTransactionId: string): string {
  return formatTreasuryRearmChildTransactionIdV2({ lineageId, generation, rootTransactionId });
}

/** proof 形状校验（返回 null = 合法）。 */
export function validateTreasuryGenerationRetirementProofShape(proof: unknown): string | null {
  if (!proof || typeof proof !== "object") return "proof 非对象";
  const candidate = proof as Partial<TreasuryGenerationRetirementProof>;
  if (candidate.schemaVersion !== TREASURY_GENERATION_RETIREMENT_VERSION) {
    return `proof.schemaVersion 非法（${String(candidate.schemaVersion)}）`;
  }
  if (!TREASURY_IDENTITY_PROFILES.has(candidate.identityProfile as never)) {
    return `proof.identityProfile 非法枚举（${String(candidate.identityProfile).slice(0, 32)}）`;
  }
  if (
    candidate.identityProfile !== "legacy-replay" &&
    treasuryProofClassOfIdentityProfile(candidate.identityProfile) !== candidate.authorityClass
  ) {
    return "proof.identityProfile 与 authorityClass 不满足唯一合法组合";
  }
  const profileError = validateTreasuryIdentityProfileFacts(candidate.identityProfile, {
    digest: candidate.digest,
    contractDigest: candidate.contractDigest,
    authorizationCohortDigest: candidate.authorizationCohortDigest,
    durableIdentityDigest: candidate.durableIdentityDigest,
    lowlevelSource: candidate.lowlevelSource,
  });
  if (profileError !== null) return `proof v2 profile 矩阵失败: ${profileError}`;
  if (typeof candidate.lineageId !== "string" || !DIGEST_PATTERN.test(candidate.lineageId)) {
    return "proof.lineageId 非法（须 16 小写 hex）";
  }
  if (typeof candidate.rootTransactionId !== "string" || !isValidTreasuryTransactionId(candidate.rootTransactionId)) {
    return "proof.rootTransactionId 非法 transactionId";
  }
  if (typeof candidate.rootIdentityDigest !== "string" || !DIGEST_PATTERN.test(candidate.rootIdentityDigest)) {
    return "proof.rootIdentityDigest 非法（须 16 小写 hex）";
  }
  if (
    typeof candidate.generation !== "number" || !Number.isSafeInteger(candidate.generation) || candidate.generation < 0 ||
    candidate.generation > 0xffffff
  ) {
    return "proof.generation 非法（非负安全整数且 ≤ 0xffffff）";
  }
  if (typeof candidate.transactionId !== "string" || !isValidTreasuryTransactionId(candidate.transactionId)) {
    return "proof.transactionId 非法 transactionId";
  }
  if (typeof candidate.digest !== "string" || !DIGEST_PATTERN.test(candidate.digest)) {
    return "proof.digest 非法（须 16 小写 hex）";
  }
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !DIGEST_PATTERN.test(value))) {
      return `proof.${field} 非法（须 16 小写 hex）`;
    }
  }
  if (candidate.lowlevelSource !== undefined && typeof candidate.lowlevelSource !== "string") {
    return "proof.lowlevelSource 非字符串";
  }
  if (candidate.authorityClass !== "identity-bound" && candidate.authorityClass !== "lowlevel") {
    return `proof.authorityClass 非法: ${String(candidate.authorityClass)}`;
  }
  if (candidate.retrySemanticDigest !== undefined && (typeof candidate.retrySemanticDigest !== "string" || !DIGEST_PATTERN.test(candidate.retrySemanticDigest))) {
    return "proof.retrySemanticDigest 非法（须 16 小写 hex）";
  }
  if (candidate.resolution !== "not_executed") {
    return `proof.resolution 非法（exact retirement 只证明 not_executed，got ${String(candidate.resolution)}）`;
  }
  const retirement = candidate.retirement as Partial<TreasuryGenerationRetirementProof["retirement"]> | undefined;
  if (!retirement || typeof retirement !== "object") return "proof.retirement 非对象";
  if (retirement.lineagePublished !== true || retirement.authorityReleased !== true || retirement.markerCleaned !== true) {
    return "proof.retirement 三段必须全部为 true（exact proof 只在 retirement 完成后写入）";
  }
  if (typeof candidate.completedAtTick !== "number" || !Number.isSafeInteger(candidate.completedAtTick) || candidate.completedAtTick < 0) {
    return "proof.completedAtTick 非安全非负整数";
  }
  return validateTreasuryGenerationRetirementProofSemantics(candidate as TreasuryGenerationRetirementProof);
}

// ── store 运行态 ─────────────────────────────────────────────────────────────

function publishGenerationRetirementStoreToMemory(runtime: TreasuryGenerationRetirementRuntime): void {
  const target = ((Memory.runtime ??= {} as NonNullable<Memory["runtime"]>) as unknown as RuntimeMemoryWithGenerationRetirement);
  const branch = (target.treasury ??= {});
  if (branch.generationRetirementProofs === undefined) {
    branch.generationRetirementProofs = runtime.store as unknown as NonNullable<(typeof branch)["generationRetirementProofs"]>;
  }
  runtime.published = true;
}

function validateGenerationRetirementStoreShape(store: TreasuryGenerationRetirementStore): string | null {
  if (!store || typeof store !== "object") return "generation retirement store 非对象";
  if (store.version !== TREASURY_GENERATION_RETIREMENT_VERSION && store.version !== TREASURY_GENERATION_RETIREMENT_LEGACY_VERSION) {
    return `generation retirement store 版本未知（${String(store.version)}，期望 ${String(TREASURY_GENERATION_RETIREMENT_VERSION)}）——fail closed`;
  }
  if (!store.entries || typeof store.entries !== "object") return "generation retirement store.entries 非对象";
  const ownKeys = Object.keys(store.entries);
  if (ownKeys.length !== store.entryCount) {
    return `generation retirement entryCount 不一致（ownKeys ${String(ownKeys.length)}，entryCount ${String(store.entryCount)}）`;
  }
  if (store.entryCount > TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES) {
    return `generation retirement store 超过硬容量（${String(store.entryCount)} > ${String(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES)}）`;
  }
  for (const key of ownKeys) {
    if (!key.startsWith(PROOF_KEY_PREFIX)) return `generation retirement key 非法（须 ${PROOF_KEY_PREFIX} 前缀）: ${key.slice(0, 28)}`;
    const proof = store.entries[key];
    const shapeError = validateTreasuryGenerationRetirementProofShape(proof);
    if (shapeError !== null) return `generation retirement entry 损坏（${key.slice(0, 28)}）: ${shapeError}`;
    if (key !== encodeGenerationProofKey(proof.lineageId, proof.generation)) {
      return `generation retirement key 与 (lineageId, generation) 不一致（${key.slice(0, 28)}）`;
    }
  }
  return null;
}

function loadGenerationRetirementRuntime(forWrite = false): TreasuryGenerationRetirementRuntime {
  if (heapRuntime !== null) return heapRuntime;
  generationRetirementEvents.fullScans += 1;
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithGenerationRetirement | undefined)?.treasury;
  if (branch?.generationRetirementProofs === undefined) {
    const store: TreasuryGenerationRetirementStore = {
      version: TREASURY_GENERATION_RETIREMENT_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    heapRuntime = { store, fatal: null, published: false, byLineage: new Map(), byAttempt: new Map() };
    if (forWrite) publishGenerationRetirementStoreToMemory(heapRuntime);
    return heapRuntime;
  }
  let store = branch.generationRetirementProofs as unknown as TreasuryGenerationRetirementStore;
  // 【XII 工作流 D / Q4】query 不迁移：读路径（forWrite=false）遇 v1 legacy
  // 版本 → fatal（migration_required——fail closed，原数据保留、零写）；
  // 迁移只由写路径 load（forWrite=true）或 beginTick migration owner 执行。
  if (!forWrite && store.version === TREASURY_GENERATION_RETIREMENT_LEGACY_VERSION) {
    heapRuntime = {
      store,
      fatal: "GRA store v1 待迁移（query 零写——beginTick migration owner 执行）",
      published: true,
      byLineage: new Map(),
      byAttempt: new Map(),
    };
    return heapRuntime;
  }
  // 【第二十二轮 11.7】v1 → v2 确定性迁移（identityProfile 从字段推导）：
  // - modern 三元组 + durable → modern-contract；
  // - lowlevel（source + durable，无 contract/cohort）→ lowlevel；
  // - digest + durable、contract/cohort 同时缺失 → legacy-replay（隔离——
  //   不自动获得 execution/settlement 权限，由消费方 profile gate 拒绝）；
  // - partial（contract XOR cohort / lowlevel 维度不完整 / 缺 digest）→
  //   整 store fail closed（原 Memory 保留）。
  // 迁移临时结构 + 全量重验证 + 成功后一次替换（失败保留原 store replay-only）。
  if (store.version === TREASURY_GENERATION_RETIREMENT_LEGACY_VERSION) {
    generationRetirementEvents.fullScans += 1;
    const migrated: TreasuryGenerationRetirementStore = {
      version: TREASURY_GENERATION_RETIREMENT_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    let migrationError: string | null = null;
    for (const [key, proof] of Object.entries(store.entries)) {
      const profile = treasuryIdentityProfileOfFacts(proof);
      if (profile === null) {
        migrationError = `v1→v2 迁移推导失败（${key.slice(0, 28)}：partial/矛盾字段——整 store fail closed，原数据保留 replay-only）`;
        break;
      }
      migrated.entries[key] = { ...(proof as object), schemaVersion: TREASURY_GENERATION_RETIREMENT_VERSION, identityProfile: profile } as TreasuryGenerationRetirementProof;
      migrated.entryCount += 1;
    }
    const migratedShapeError = migrationError ?? validateGenerationRetirementStoreShape(migrated);
    if (migratedShapeError !== null) {
      heapRuntime = { store, fatal: `GRA v1→v2 迁移自检失败: ${migratedShapeError}（原数据保留 fail closed）`, published: true, byLineage: new Map(), byAttempt: new Map() };
      generationRetirementEvents.incompatibleFailures = (generationRetirementEvents.incompatibleFailures ?? 0) + 1;
      return heapRuntime;
    }
    // 原子替换（原 v1 store 不再读取）。
    store = migrated;
    (branch as { generationRetirementProofs?: TreasuryGenerationRetirementStore }).generationRetirementProofs = migrated;
  }
  const shapeError = validateGenerationRetirementStoreShape(store);
  // 【第二十一轮 10.3】索引重建不得依赖 Map.set 覆盖——同 transactionId 出现
  // 在两个不同 key（含 root ID 出现在两个不同 lineage）→ 整 store unhealthy。
  let indexError: string | null = null;
  if (shapeError === null) {
    const probeByAttempt = new Map<string, string>();
    for (const [key, proof] of Object.entries(store.entries)) {
      const existingKey = probeByAttempt.get(proof.transactionId);
      if (existingKey !== undefined && existingKey !== key) {
        indexError = `generation retirement transactionId 重复（${proof.transactionId.slice(0, 28)} 同时位于 ${existingKey.slice(0, 28)} 与 ${key.slice(0, 28)}）——整 store unhealthy`;
        break;
      }
      probeByAttempt.set(proof.transactionId, key);
    }
    if (indexError !== null) generationRetirementEvents.indexConflicts += 1;
  }
  const fatal = shapeError ?? indexError;
  const runtime: TreasuryGenerationRetirementRuntime = { store, fatal, published: true, byLineage: new Map(), byAttempt: new Map() };
  if (fatal === null) {
    for (const [key, proof] of Object.entries(store.entries)) {
      let keys = runtime.byLineage.get(proof.lineageId);
      if (keys === undefined) {
        keys = new Set<string>();
        runtime.byLineage.set(proof.lineageId, keys);
      }
      keys.add(key);
      runtime.byAttempt.set(proof.transactionId, key);
    }
  }
  heapRuntime = runtime;
  return runtime;
}

export interface TreasuryGenerationRetirementHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
}

/** 零写健康探测（store 不存在视为健康空——fail closed 只对损坏 store）。 */
export function peekTreasuryGenerationRetirementHealth(): TreasuryGenerationRetirementHealth {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithGenerationRetirement | undefined)?.treasury;
  if (branch?.generationRetirementProofs === undefined) {
    return { healthy: true, detail: null, entryCount: 0 };
  }
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) {
    return { healthy: false, detail: runtime.fatal, entryCount: 0 };
  }
  return { healthy: true, detail: null, entryCount: runtime.store.entryCount };
}

/** 写路径健康门禁（返回 null = 可写）。 */
export function ensureTreasuryGenerationRetirementStoreValidated(): string | null {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithGenerationRetirement | undefined)?.treasury;
  if (branch?.generationRetirementProofs === undefined) return null;
  return loadGenerationRetirementRuntime().fatal;
}

/**
 * 【XII 工作流 D / Q7】GRA store v1 的 tick-boundary 显式迁移（唯一
 * migration owner——beginTick 前置阶段调用）。absent/v2 → idle（零写）；
 * v1 → 复用写路径 load（forWrite=true）的确定性迁移（identityProfile 推导
 * + 全量重验 + 原子替换）；失败 → blocked（原数据保留 replay-only，读路径
 * 继续 fail closed）。
 */
export function migrateTreasuryGenerationRetirementStoreLegacyAtTickBoundary(): { status: "idle" | "migrated" | "blocked"; detail: string | null } {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithGenerationRetirement | undefined)?.treasury;
  const raw = branch?.generationRetirementProofs as { version?: unknown } | undefined;
  if (raw === undefined) return { status: "idle", detail: null };
  if (raw.version === TREASURY_GENERATION_RETIREMENT_VERSION) return { status: "idle", detail: null };
  if (raw.version !== TREASURY_GENERATION_RETIREMENT_LEGACY_VERSION) {
    return { status: "blocked", detail: `GRA store 版本未知（${String(raw.version).slice(0, 8)}——不迁移，fail closed）` };
  }
  // 【XII】heap 失效（同 issuer migrate——防 heap 视图遮蔽 Memory legacy store）。
  if (heapRuntime !== null && heapRuntime.store !== raw) heapRuntime = null;
  const runtime = loadGenerationRetirementRuntime(true);
  if (runtime.fatal !== null) {
    return { status: "blocked", detail: runtime.fatal };
  }
  return { status: "migrated", detail: null };
}

// ── 读取（冻结快照；O(1)） ───────────────────────────────────────────────────

/** (lineageId, generation) O(1) 查询（历史代 verdict / 下一代 capability 门禁共用）。 */
export function readTreasuryGenerationRetirementProof(
  lineageId: string,
  generation: number,
): Readonly<TreasuryGenerationRetirementProof> | undefined {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = encodeGenerationProofKey(lineageId, generation);
  const proof = runtime.store.entries[key];
  if (proof === undefined) return undefined;
  return treasuryBoundedDeepFreezeSnapshot(proof) as Readonly<TreasuryGenerationRetirementProof>;
}

/** attempt ID O(1) 查询（真实索引命中——root 或 tr1_ child 的 proof 定位）。 */
export function lookupTreasuryGenerationRetirementProofByAttemptId(
  transactionId: string,
): Readonly<TreasuryGenerationRetirementProof> | undefined {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) return undefined;
  // 【第二十一轮 10.4】byAttempt 索引直接命中——不解析 lineage 后遍历该
  // lineage 的全部 proof。
  const key = runtime.byAttempt.get(transactionId);
  if (key === undefined) return undefined;
  const proof = runtime.store.entries[key];
  if (proof === undefined || proof.transactionId !== transactionId) return undefined;
  return treasuryBoundedDeepFreezeSnapshot(proof) as Readonly<TreasuryGenerationRetirementProof>;
}

// ── 写入（clone → 校验 → 幂等/冲突预检 → 发布 → read-back → 索引同步） ─────

export type TreasuryGenerationRetirementWriteResult =
  | { readonly status: "written" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * exact retirement proof 持久化（attemptLineage.converge 在 retirement 三段
 * 收敛完成、状态推进之前调用）：同 key 完整一致 → 幂等；同 key 不同内容 →
 * 拒绝（原 store 不变——冲突不覆盖）；满载 fail closed。输入深拷贝隔离
 * （alias 不污染 Memory）。
 */
export function persistTreasuryGenerationRetirementProof(
  proof: TreasuryGenerationRetirementProof,
): TreasuryGenerationRetirementWriteResult {
  const shapeError = validateTreasuryGenerationRetirementProofShape(proof);
  if (shapeError !== null) {
    generationRetirementEvents.writeFailures += 1;
    return { status: "rejected", detail: `拒绝写入非法 generation retirement proof: ${shapeError}` };
  }
  const runtime = loadGenerationRetirementRuntime(true);
  if (!runtime.published) publishGenerationRetirementStoreToMemory(runtime);
  if (runtime.fatal !== null) {
    generationRetirementEvents.writeFailures += 1;
    return { status: "rejected", detail: runtime.fatal };
  }
  const key = encodeGenerationProofKey(proof.lineageId, proof.generation);
  const existing = Object.prototype.hasOwnProperty.call(runtime.store.entries, key)
    ? runtime.store.entries[key]
    : undefined;
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(proof)) {
      generationRetirementEvents.idempotentWrites += 1;
      return { status: "idempotent" };
    }
    generationRetirementEvents.writeFailures += 1;
    return {
      status: "rejected",
      detail: `同 (lineageId, generation) 已存在不同内容的 exact retirement proof（${key.slice(0, 28)}）——冲突不覆盖`,
    };
  }
  // 【第二十一轮 10.3】全局 transaction ID 唯一：同 transactionId 已被其它
  // entry（不同 key / 不同 lineage / 不同 generation，含 root ID 出现在两个
  // lineage）占用 → 拒绝（byAttempt 索引不得被 Map.set 覆盖隐藏冲突）。
  const occupiedKey = runtime.byAttempt.get(proof.transactionId);
  if (occupiedKey !== undefined && occupiedKey !== key) {
    generationRetirementEvents.writeFailures += 1;
    generationRetirementEvents.indexConflicts += 1;
    return {
      status: "rejected",
      detail: `transactionId ${proof.transactionId.slice(0, 28)} 已被其它 exact retirement entry 占用（${occupiedKey.slice(0, 28)}）——全局唯一，拒绝写入`,
    };
  }
  if (runtime.store.entryCount >= TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES) {
    // 【IX 工作流 B/C → X 工作流 F】GRA 是 recent exact detail（非永久层）
    // ——满载不再永久 fail closed：有界 eligible 扫描驱逐被 matching exact
    // current summary **按 exact replacement relation 全维度接管**（root ID/
    // lineage/issuer domain/terminalState 相容/authorityClass/identity
    // profile/digest/canonical root identity/durable/contract/cohort/
    // lowlevel 矩阵——legacy replay-only 不授权）且无 exact 依赖（journal/
    // tombstone/active lineage 关闭）的 root 代 proof；probe 未装配/summary
    // 不在位/store unhealthy/relation 不一致/依赖在位一律不驱逐，fail
    // closed。无 eligible → rejected。
    const evicted = evictGenerationProofsSupersededBySummary(runtime);
    if (evicted === 0) {
      generationRetirementEvents.writeFailures += 1;
      return {
        status: "rejected",
        detail: `generation retirement store 已达硬容量 ${String(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES)} 且无 summary 接管的 eligible proof（fail closed——不驱逐被依赖 proof；retirement 保持 retiring）`,
      };
    }
  }
  const published = cloneTreasuryDurableValue(proof);
  runtime.store.entries[key] = published;
  runtime.store.updatedAt = Game.time;
  // read-back：完整一致 + 形状/语义重算（不信任发布副本的自带派生字段）。
  const readBack = runtime.store.entries[key];
  if (
    validateTreasuryGenerationRetirementProofShape(readBack) !== null ||
    JSON.stringify(readBack) !== JSON.stringify(published)
  ) {
    delete runtime.store.entries[key];
    runtime.store.updatedAt = Game.time;
    generationRetirementEvents.writeFailures += 1;
    return { status: "rejected", detail: "generation retirement proof read-back 验证失败（不推进 retirement）" };
  }
  // 【第二十一轮 10.5】read-back 后、索引同步前复核 transactionId 未被其它
  // entry 占用（防御 read-back 窗口内的并发形态——JS 单线程下覆盖仍是索引
  // 同步顺序错误的防护）；占用 → 回滚 Memory（不推进 lineage）。
  const postOccupiedKey = runtime.byAttempt.get(proof.transactionId);
  if (postOccupiedKey !== undefined && postOccupiedKey !== key) {
    delete runtime.store.entries[key];
    runtime.store.updatedAt = Game.time;
    generationRetirementEvents.writeFailures += 1;
    generationRetirementEvents.indexConflicts += 1;
    return { status: "rejected", detail: "generation retirement proof 索引同步前发现 transactionId 占用冲突（已回滚）" };
  }
  runtime.store.entryCount += 1;
  let keys = runtime.byLineage.get(proof.lineageId);
  if (keys === undefined) {
    keys = new Set<string>();
    runtime.byLineage.set(proof.lineageId, keys);
  }
  keys.add(key);
  runtime.byAttempt.set(proof.transactionId, key);
  generationRetirementEvents.writes += 1;
  return { status: "written" };
}

// ── 回收（依赖驱动；正常 tick 零扫描） ──────────────────────────────────────

// ──【Round 22 Remediation XI 工作流 D】统一 GRA destructive release
//    authority——全部生产 delete 的唯一出口。三个既有路径（tombstone 驱逐
//    联动 / generation advance 孤儿清理 / chain 压缩孤儿清理）与满载驱逐
//    都必须经 releaseGenerationProofDestructive；primitive 内部自验全部
//    结构化证据（不信任调用方"刚刚做过检查"的隐式授权）：
//     1. entry 在位 + byAttempt/byLineage 索引一致（防索引漂移）；
//     2. active lineage 不再依赖：lineage probe 装配 + 健康；record 仍是
//        当前代（generation 相同）→ 阻断（下一代 capability 门禁依据）；
//     3. exact consumer 关闭：cleanup journal 健康 + 该 attempt entry 不在；
//        resolution store 健康 + tombstone 不在（tombstone 不存在不再是
//        独立充分条件——G1）；
//     4. mode=summary_superseded 附加：summary probe 装配 + store 健康 +
//        verifyTreasuryGenerationSummaryReplacement 全维度通过（legacy
//        replay-only 不授权——G2/G3）；
//     5. 删除同步维护 entries/entryCount/byAttempt/byLineage/updatedAt +
//        Memory read-back；失败完整恢复（G6）。
export type TreasuryGenerationProofReleaseMode =
  /** tombstone 驱逐联动（resolutionStore hook——not-executed verdict match 后）。 */
  | "tombstone_retired"
  /** generation advance 后的有界孤儿清理（generationProofLifecycle）。 */
  | "orphan_advance"
  /** chain 压缩后的孤儿清理（lineageRetirementSummary compaction）。 */
  | "compaction_orphan"
  /** 满载驱逐：exact summary replacement relation 全维度接管（X 工作流 F）。 */
  | "summary_superseded";

export type TreasuryGenerationProofReleaseOutcome =
  | { readonly status: "released"; readonly mode: TreasuryGenerationProofReleaseMode }
  | { readonly status: "absent" }
  | {
      readonly status: "blocked";
      readonly reason: "store_unhealthy" | "index_conflict" | "lineage_current" | "consumer_active" | "replacement_missing";
      readonly detail: string;
    };

interface TreasuryGenerationProofReleaseRuntime {
  store: { entries: Record<string, TreasuryGenerationRetirementProof>; entryCount: number; updatedAt: number };
  byAttempt: Map<string, string>;
  byLineage: Map<string, Set<string>>;
}

/** 唯一 destructive primitive（GRA 内部——生产 delete 的唯一实现点）。 */
function releaseGenerationProofDestructive(
  runtime: TreasuryGenerationProofReleaseRuntime,
  key: string,
  mode: TreasuryGenerationProofReleaseMode,
): TreasuryGenerationProofReleaseOutcome {
  const proof = runtime.store.entries[key];
  if (proof === undefined) return { status: "absent" };
  // 1) 索引一致：byAttempt 必须反查到同一 key（索引漂移 → 阻断，不猜测删除）。
  if (runtime.byAttempt.get(proof.transactionId) !== key) {
    return {
      status: "blocked",
      reason: "index_conflict",
      detail: `byAttempt 索引与 entry 不一致（${proof.transactionId.slice(0, 24)} → ${String(runtime.byAttempt.get(proof.transactionId))}）——不删除`,
    };
  }
  // 2) 【XII 工作流 C / 6.4】lineage 依赖判定与 record 读取使用**同一**装配
  //    source（semantic lineage record source——health/read 同源；probe A 说
  //    健康而 source B 读不到不得当 absent）。未装配/不健康 → 阻断 fail
  //    closed。record 仍是当前代 → lineage_current。
  const recordSource = peekTreasurySemanticLineageRecordSource();
  if (recordSource === null) {
    return { status: "blocked", reason: "store_unhealthy", detail: "semantic lineage record source 未装配（依赖不可判定——不删除 proof）" };
  }
  const sourceUnhealthy = recordSource.unhealthyDetail();
  if (sourceUnhealthy !== null && sourceUnhealthy !== undefined) {
    return { status: "blocked", reason: "store_unhealthy", detail: `attempt lineage store unhealthy: ${String(sourceUnhealthy)}（依赖不可判定——不删除 proof）` };
  }
  const activeRecord = recordSource.readByLineageId(proof.lineageId);
  if (activeRecord !== undefined && activeRecord.generation === proof.generation) {
    return {
      status: "blocked",
      reason: "lineage_current",
      detail: `lineage ${proof.lineageId.slice(0, 8)} 仍在 generation ${String(proof.generation)}（当前代 proof 是下一代 capability 门禁——不释放）`,
    };
  }
  // 3) 【XII 工作流 C / 6.3】exact consumer 关闭：cleanup journal / resolution
  //    tombstone / unresolved intent / quarantine / write-fault marker /
  //    authorization fault。任一在位 → consumer_active；任一 store
  //    unhealthy / probe 缺失 → 阻断（不把"不知道"解释成"已关闭"）。
  const journalHealth = peekTreasuryResolutionCleanupHealth();
  if (!journalHealth.healthy) {
    return { status: "blocked", reason: "store_unhealthy", detail: `cleanup journal store unhealthy: ${journalHealth.detail ?? ""}（不删除 proof）` };
  }
  if (readTreasuryResolutionCleanupEntry(proof.transactionId) !== undefined) {
    return {
      status: "blocked",
      reason: "consumer_active",
      detail: `cleanup journal 引用 ${proof.transactionId.slice(0, 24)}（exact consumer 在位——不删除 proof）`,
    };
  }
  const tombstoneHealth = peekTreasuryResolutionStoreHealth();
  if (!tombstoneHealth.healthy) {
    return { status: "blocked", reason: "store_unhealthy", detail: `resolution store unhealthy: ${tombstoneHealth.detail ?? ""}（不删除 proof）` };
  }
  if (readTreasuryResolutionTombstone(proof.transactionId) !== undefined) {
    return {
      status: "blocked",
      reason: "consumer_active",
      detail: `resolution tombstone 在位（${proof.transactionId.slice(0, 24)}——exact consumer 未关闭，不删除 proof）`,
    };
  }
  const intentValidation = peekTreasuryIntentStoreValidation();
  if (intentValidation.status === "unhealthy" || intentValidation.status === "migration_required") {
    return { status: "blocked", reason: "store_unhealthy", detail: `intent store unhealthy（${intentValidation.detail}）——exact consumer 不可判定，不删除 proof` };
  }
  if (readTreasuryIntentEntryForQuery(proof.transactionId) !== undefined) {
    return {
      status: "blocked",
      reason: "consumer_active",
      detail: `unresolved intent 在位（${proof.transactionId.slice(0, 24)}——exact consumer 未关闭，不删除 proof）`,
    };
  }
  const quarantineValidation = peekTreasuryQuarantineStoreValidation();
  if (quarantineValidation.status === "unhealthy" || quarantineValidation.status === "migration_required") {
    return { status: "blocked", reason: "store_unhealthy", detail: `quarantine store unhealthy（${quarantineValidation.detail}）——exact consumer 不可判定，不删除 proof` };
  }
  if (readTreasuryQuarantineEntryForQuery(proof.transactionId) !== undefined) {
    return {
      status: "blocked",
      reason: "consumer_active",
      detail: `quarantine 在位（${proof.transactionId.slice(0, 24)}——exact consumer 未关闭，不删除 proof）`,
    };
  }
  const markerHealth = peekTreasuryWriteFaultHealth();
  if (!markerHealth.healthy) {
    return { status: "blocked", reason: "store_unhealthy", detail: `write-fault marker store unhealthy: ${markerHealth.detail ?? ""}（不删除 proof）` };
  }
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && marker.transactionId === proof.transactionId) {
    return {
      status: "blocked",
      reason: "consumer_active",
      detail: `write-fault marker 引用 ${proof.transactionId.slice(0, 24)}（exact consumer 在位——不删除 proof）`,
    };
  }
  const faultValidation = peekTreasuryAuthorizationFaultStoreValidation();
  if (faultValidation.status === "unhealthy" || faultValidation.status === "migration_required") {
    return { status: "blocked", reason: "store_unhealthy", detail: `authorization fault store unhealthy（${faultValidation.detail}）——exact consumer 不可判定，不删除 proof` };
  }
  if (readTreasuryAuthorizationFaultEntry(proof.transactionId) !== undefined) {
    return {
      status: "blocked",
      reason: "consumer_active",
      detail: `authorization fault 在位（${proof.transactionId.slice(0, 24)}——exact consumer 未关闭，不删除 proof）`,
    };
  }
  // 4) 【XII 工作流 C / 6.1-6.2】replacement 正面验证矩阵：mode 只是调用方
  //    声明的释放目的——授权由 primitive 自己读取并正面验证对应 replacement
  //    class（"tombstone 缺失 + journal 缺失 + 非当前代 → 删除"的缺席链不再
  //    构成授权）：
  //    - summary_superseded / compaction_orphan：exact Summary full relation
  //      （compaction_orphan 亦接受 terminal certificate 覆盖）；
  //    - orphan_advance：active-lineage advanced replacement（record 在位 +
  //      同 lineage + generation 严格更大 + root identity 相容）；
  //    - tombstone_retired：terminal certificate 覆盖或 namespace-scoped
  //      retired range anti-reuse 覆盖（tombstone 已被 caller 驱逐——持久
  //      接管证据是 certificate/range）。
  const replacementError = verifyGenerationProofReplacement(proof, mode, activeRecord);
  if (replacementError !== null) {
    return { status: "blocked", reason: "replacement_missing", detail: replacementError };
  }
  // 5) 删除 + 索引维护 + read-back；失败完整恢复（entries/entryCount/
  //    byAttempt/byLineage；updatedAt 保守 bump——G6/G9）。
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  runtime.byAttempt.delete(proof.transactionId);
  const lineageKeys = runtime.byLineage.get(proof.lineageId);
  if (lineageKeys !== undefined) {
    lineageKeys.delete(key);
    if (lineageKeys.size === 0) runtime.byLineage.delete(proof.lineageId);
  }
  const rawStore = (Memory.runtime as unknown as { treasury?: { generationRetirementProofs?: { entries?: Record<string, unknown>; entryCount?: number } } } | undefined)
    ?.treasury?.generationRetirementProofs;
  if (rawStore === undefined || rawStore.entries?.[key] !== undefined || rawStore.entryCount !== runtime.store.entryCount) {
    runtime.store.entries[key] = proof;
    runtime.store.entryCount += 1;
    runtime.store.updatedAt = Game.time;
    runtime.byAttempt.set(proof.transactionId, key);
    let restoredKeys = runtime.byLineage.get(proof.lineageId);
    if (restoredKeys === undefined) {
      restoredKeys = new Set<string>();
      runtime.byLineage.set(proof.lineageId, restoredKeys);
    }
    restoredKeys.add(key);
    return {
      status: "blocked",
      reason: "store_unhealthy",
      detail: "generation retirement proof release read-back 失败（已完整恢复 entries/entryCount/byAttempt/byLineage）",
    };
  }
  return { status: "released", mode };
}

/**
 * 【XII 工作流 C / 6.2】replacement class 正面验证（返回 null = 至少一种
 * 持久接管关系被正面证明；字符串 = replacement_missing detail）。
 */
function verifyGenerationProofReplacement(
  proof: TreasuryGenerationRetirementProof,
  mode: TreasuryGenerationProofReleaseMode,
  activeRecord: { lineageId: string; generation: number; rootTransactionId: string } | undefined,
): string | null {
  if (mode === "summary_superseded" || mode === "compaction_orphan") {
    // Exact Summary replacement（full relation）优先；compaction_orphan 亦
    // 接受 terminal certificate 覆盖。
    if (generationSummaryProbe !== null && generationSummaryProbe.summaryStoreHealthy()) {
      const summary = generationSummaryProbe.summaryOfLineageId(proof.lineageId);
      if (summary !== undefined) {
        const relationError = verifyTreasuryGenerationSummaryReplacement(proof, summary);
        if (relationError === null) return null;
        if (mode === "summary_superseded") {
          return `summary replacement relation 不一致（${relationError}——不删除 proof）`;
        }
      } else if (mode === "summary_superseded") {
        return `lineage ${proof.lineageId.slice(0, 8)} 无 matching summary（无 replacement 不删除 proof）`;
      }
    } else if (mode === "summary_superseded") {
      return generationSummaryProbe === null
        ? "retirement summary probe 未装配（exact replacement 不可判定——不删除 proof）"
        : "retirement summary store unhealthy（exact replacement 不可判定——不删除 proof）";
    }
    if (mode === "compaction_orphan") {
      const certificateError = verifyGenerationProofCertificateCoverage(proof);
      if (certificateError === null) return null;
      return `lineage ${proof.lineageId.slice(0, 8)} 无 matching summary 且无 terminal certificate 覆盖（${certificateError}——无 replacement 不删除 proof）`;
    }
    return "exact summary replacement 不可判定（summary probe 未装配/不健康——不删除 proof）";
  }
  if (mode === "orphan_advance") {
    // Active-lineage advanced replacement：必须**正面**证明后继 generation
    // 已接管（record 在位 + 同 lineage + generation 严格更大 + root 一致）。
    // "record 缺席"或"当前代不等于 proof generation"不再是删除依据。
    if (activeRecord === undefined) {
      return `lineage ${proof.lineageId.slice(0, 8)} 无 active record（advanced replacement 不可证明——record 缺席不是删除依据）`;
    }
    if (activeRecord.lineageId !== proof.lineageId || activeRecord.generation <= proof.generation) {
      return `active lineage generation ${String(activeRecord.generation)} 未严格超过 proof generation ${String(proof.generation)}（advanced replacement 不成立）`;
    }
    if (activeRecord.rootTransactionId !== proof.rootTransactionId) {
      return `active lineage root（${activeRecord.rootTransactionId.slice(0, 16)}）与 proof root（${proof.rootTransactionId.slice(0, 16)}）不一致（lineage identity 冲突——不得释放）`;
    }
    return null;
  }
  // tombstone_retired：tombstone 已被 caller 驱逐——持久接管证据按序验证：
  // 1) active-lineage advanced replacement（chain 仍在推进：record 在位 +
  //    generation 严格更大 + root 一致——中间代 tombstone 驱逐的正牌
  //    replacement，6.2）；
  // 2) terminal certificate 覆盖（chain 已终结压缩）；
  // 3) namespace-scoped retired range anti-reuse 覆盖。
  if (
    activeRecord !== undefined &&
    activeRecord.generation > proof.generation &&
    activeRecord.rootTransactionId === proof.rootTransactionId
  ) {
    return null;
  }
  const certificateError = verifyGenerationProofCertificateCoverage(proof);
  if (certificateError === null) return null;
  const range = lookupTreasuryRetiredRangeStructured(proof.rootTransactionId);
  if (range.status === "present") return null;
  return `无 advanced active lineage / terminal certificate / retired range 覆盖（${certificateError}；range ${range.status}——tombstone 缺席不构成 replacement，不删除 proof）`;
}

/** terminal certificate 覆盖验证（certificate 健康 + root/lineage/finalGeneration 覆盖该代）。 */
function verifyGenerationProofCertificateCoverage(proof: TreasuryGenerationRetirementProof): string | null {
  const health = peekTreasuryChainRetirementCertificateHealth();
  if (!health.healthy) {
    return `chain certificate store unhealthy: ${health.detail ?? ""}`;
  }
  const certificate = lookupTreasuryChainRetirementCertificate(proof.rootTransactionId);
  if (certificate === undefined) {
    return `root ${proof.rootTransactionId.slice(0, 16)} 无 terminal chain certificate`;
  }
  if (certificate.lineageId !== proof.lineageId) {
    return `certificate lineage（${certificate.lineageId.slice(0, 8)}）与 proof lineage（${proof.lineageId.slice(0, 8)}）不一致`;
  }
  if (certificate.finalGeneration < proof.generation) {
    return `certificate finalGeneration ${String(certificate.finalGeneration)} 未覆盖 proof generation ${String(proof.generation)}`;
  }
  return null;
}

/**
 * tombstone 驱逐联动释放（resolutionStore.evictExpiredTombstones 注入调用；
 * generationProofLifecycle 的 advance sweep 经 mode="orphan_advance"）：
 * 该 attempt 的 tombstone 已按 replacement_match 驱逐 → 对应代 proof 的
 * 唯一长期依赖消失（root 门禁由 summary 承担）→ 经统一 release authority
 * 释放（内部自验 lineage/journal/tombstone/索引——调用方检查不构成授权）。
 * blocked → 结构化返回（proof 保留，不谎称已释放）。
 */
export function releaseTreasuryGenerationRetirementProofOfAttempt(
  transactionId: string,
  mode: TreasuryGenerationProofReleaseMode = "tombstone_retired",
): TreasuryGenerationProofReleaseOutcome {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) {
    return { status: "blocked", reason: "store_unhealthy", detail: `GRA store fail-closed: ${runtime.fatal}` };
  }
  const key = runtime.byAttempt.get(transactionId);
  if (key === undefined) return { status: "absent" };
  const outcome = releaseGenerationProofDestructive(runtime, key, mode);
  if (outcome.status === "released") {
    generationRetirementEvents.releases += 1;
  }
  return outcome;
}

/** chain 压缩后的孤儿清理结果（compaction 结构化报告 pending——不谎称已释放）。 */
export interface TreasuryOrphanGenerationProofReleaseReport {
  readonly released: number;
  readonly retained: number;
  readonly blockedDetail: string | null;
}

/**
 * chain 压缩后的孤儿清理（lineageRetirementSummary 压缩编排调用）：该
 * lineage 中历史代 proof 经统一 release authority（mode="compaction_orphan"）
 * 逐条自验释放——tombstone/journal 仍在位、lineage 仍是当前代、索引漂移、
 * store unhealthy 一律保留（结构化 pending）。per-chain 有界遍历（≤ 该 chain
 * 代数 ≤ 容量）。
 */
export function releaseOrphanTreasuryGenerationRetirementProofs(
  lineageId: string,
): TreasuryOrphanGenerationProofReleaseReport {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) {
    return { released: 0, retained: 0, blockedDetail: `GRA store fail-closed: ${runtime.fatal}` };
  }
  const keys = runtime.byLineage.get(lineageId);
  if (keys === undefined) return { released: 0, retained: 0, blockedDetail: null };
  let released = 0;
  let retained = 0;
  let blockedDetail: string | null = null;
  for (const key of [...keys]) {
    const proof = runtime.store.entries[key];
    if (proof === undefined) {
      // 索引自愈（entry 缺失的悬挂 key——非 destructive 路径）。
      keys.delete(key);
      continue;
    }
    const outcome = releaseGenerationProofDestructive(runtime, key, "compaction_orphan");
    if (outcome.status === "released") {
      released += 1;
    } else if (outcome.status === "blocked") {
      retained += 1;
      if (blockedDetail === null) blockedDetail = outcome.detail;
    }
  }
  if (keys.size === 0) runtime.byLineage.delete(lineageId);
  if (released > 0) generationRetirementEvents.orphanReleases += released;
  return { released, retained, blockedDetail };
}

/** rootIdentityDigest 派生（与 attemptLineage.computeTreasuryLineageIdentityDigest 同算法——proof 构造共用）。 */
export function computeTreasuryGenerationRootIdentityDigest(identity: {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
}): string {
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

// ── 装配注册（semantic validator 的 proof source + tombstone 驱逐释放 hook；
//    均可重入——测试注销 sources 后可重新装配） ─────────────────────────────

export function registerTreasuryGenerationRetirementSemanticSourceForAssembly(): void {
  registerTreasuryGenerationProofSourceForAssembly({
    healthy: () => peekTreasuryGenerationRetirementHealth().healthy,
    unhealthyDetail: () => peekTreasuryGenerationRetirementHealth().detail,
    read: (lineageId, generation) => readTreasuryGenerationRetirementProof(lineageId, generation),
  });
  // 【XI 工作流 D】hook 返回结构化 outcome（resolutionStore 消费 blocked——
  // 不再 void；统一经 release authority 自验）。
  registerTreasuryGenerationProofReleaseForAssembly((transactionId) =>
    releaseTreasuryGenerationRetirementProofOfAttempt(transactionId, "tombstone_retired"),
  );
}
registerTreasuryGenerationRetirementSemanticSourceForAssembly();

// ──【IX 工作流 B/C → X 工作流 F】retirement summary 的 assembly probe（GRA
//    满载驱逐前验证"summary 已按 exact replacement relation 接管该 proof 的
//    retirement 语义"）。注册方：lineageRetirementSummary 模块底部（GRA 与
//    summary 互相在对方上游——直接 import 成环）。未装配 → 无驱逐（fail
//    closed）。【X/F】probe 返回完整 summary 视图（modern-only——legacy
//    replay-only archive 不进入驱逐判定，G6）。
interface TreasuryGenerationSummaryReplacementView {
  readonly schemaVersion: number;
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly rootIdentityDigest: string;
  readonly terminalState: string;
  readonly finalGeneration: number;
  readonly finalAttemptId: string;
  readonly authorityClass?: string;
  readonly rootExact?: {
    readonly digest: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly proofClass: string;
  };
}

interface TreasuryGenerationSummaryProbe {
  readonly summaryOfLineageId: (lineageId: string) => TreasuryGenerationSummaryReplacementView | undefined;
  readonly summaryStoreHealthy: () => boolean;
}

let generationSummaryProbe: TreasuryGenerationSummaryProbe | null = null;

export function registerTreasuryGenerationSummaryProbeForAssembly(probe: TreasuryGenerationSummaryProbe): void {
  generationSummaryProbe = probe;
}

// 【X 工作流 F / G7】GRA ↔ attemptLineage 模块环规避：lineage 依赖维度经
// probe 注入（注册方：attemptLineage 模块底部）。未装配 → 无驱逐（fail
// closed——依赖不可判定时不删除 proof）。
interface TreasuryGenerationLineageProbe {
  readonly lineageOf: (transactionId: string) => { readonly state?: unknown } | undefined;
  readonly lineageStoreHealthy: () => boolean;
}

let generationLineageProbe: TreasuryGenerationLineageProbe | null = null;

export function registerTreasuryGenerationLineageProbeForAssembly(probe: TreasuryGenerationLineageProbe): void {
  generationLineageProbe = probe;
}

/**
 * 【X 工作流 F】GRA proof ↔ summary 的 exact replacement relation（单一
 * canonical verifier——驱逐决策不得自行比较字段子集）。维度：
 *  - summary 是当前 exact schema（v3；legacy replay-only 不授权——G6）；
 *  - root transaction ID / lineage ID / root issuer domain 一致（G1/N10）；
 *  - generation 语义：只有 root 代（generation=0）proof 可由 summary 的
 *    root exact identity 接管；
 *  - retirement outcome 相容：gen0 proof 的 resolution 恒 not_executed——
 *    root-only chain 的 summary terminalState=chain_committed 与之矛盾（G2）；
 *  - proof class（authorityClass）/ identity profile 一致（G3）；
 *  - digest / canonical root identity（五元合成）一致（G4）；
 *  - contract / cohort / durable / lowlevel provenance 按 class 矩阵逐维
 *    一致（G5）。
 * 返回 null = exact replacement 在位；字符串 = 首个不一致维度。
 */
export function verifyTreasuryGenerationSummaryReplacement(
  proof: Readonly<TreasuryGenerationRetirementProof>,
  summary: Readonly<TreasuryGenerationSummaryReplacementView>,
): string | null {
  if (summary.schemaVersion !== 3) return "summary 不是当前 exact schema（legacy replay-only archive 不授权 destructive eviction）";
  if (proof.rootTransactionId !== summary.rootTransactionId) return "root transaction ID 不一致";
  if (proof.lineageId !== summary.lineageId) return "lineage ID 不一致";
  if (proof.generation !== 0) return "只有 root 代（generation=0）proof 可由 summary 接管";
  if (summary.finalGeneration === 0 && summary.terminalState === "chain_committed") {
    return "summary terminalState 与 root not-executed proof 矛盾（root-only chain 的 committed 属于 root）";
  }
  if (summary.authorityClass !== proof.authorityClass) return "proof class（authorityClass）不一致";
  if (summary.rootExact === undefined) return "summary 缺少 rootExact exact identity";
  const rootExact = summary.rootExact;
  if (proof.digest !== rootExact.digest) return "digest 不一致";
  if (proof.rootIdentityDigest !== summary.rootIdentityDigest) return "canonical root identity（五元合成）不一致";
  if (proof.durableIdentityDigest !== rootExact.durableIdentityDigest) return "durable identity 不一致";
  if (proof.authorityClass === "identity-bound") {
    if (proof.contractDigest !== rootExact.contractDigest) return "contract digest 不一致（identity-bound 必须成对一致）";
    if (proof.authorizationCohortDigest !== rootExact.authorizationCohortDigest) return "authorization cohort digest 不一致（identity-bound 必须成对一致）";
    if (rootExact.lowlevelSource !== undefined) return "rootExact 携带 lowlevelSource（与 identity-bound class 矛盾）";
  } else {
    if (proof.lowlevelSource !== rootExact.lowlevelSource) return "lowlevel source 不一致";
    if (rootExact.contractDigest !== undefined || rootExact.authorizationCohortDigest !== undefined) {
      return "rootExact 携带 contract/cohort（与 lowlevel class 矛盾）";
    }
  }
  const summaryProfile = treasuryIdentityProfileOfFacts({
    digest: rootExact.digest,
    ...(rootExact.contractDigest !== undefined ? { contractDigest: rootExact.contractDigest } : {}),
    ...(rootExact.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: rootExact.authorizationCohortDigest } : {}),
    ...(rootExact.durableIdentityDigest !== undefined ? { durableIdentityDigest: rootExact.durableIdentityDigest } : {}),
    ...(rootExact.lowlevelSource !== undefined ? { lowlevelSource: rootExact.lowlevelSource } : {}),
  });
  if (summaryProfile === null || summaryProfile !== proof.identityProfile) return "identity profile 不一致";
  const proofParsedRoot = parseTreasuryIssuedInitialAttemptId(proof.rootTransactionId);
  const summaryParsedRoot = parseTreasuryIssuedInitialAttemptId(summary.rootTransactionId);
  if (proofParsedRoot === null || summaryParsedRoot === null || proofParsedRoot.namespace !== summaryParsedRoot.namespace) {
    return "root issuer domain 不一致（ti1_/ti2_ 是两个独立发行域）";
  }
  return null;
}

/**
 * 【X 工作流 F / G7】exact 依赖检查：仍依赖该 proof 的 active cleanup /
 * tombstone / lineage 事实在位（或相关 store 不可信）→ 不得驱逐。全部
 * health-complete（损坏 = 依赖在位，fail closed）。返回 null = 无依赖。
 */
function generationProofDependenciesActive(proof: Readonly<TreasuryGenerationRetirementProof>): string | null {
  const journalHealth = peekTreasuryResolutionCleanupHealth();
  if (!journalHealth.healthy) return `cleanup journal store unhealthy（fail closed）: ${journalHealth.detail ?? ""}`;
  if (readTreasuryResolutionCleanupEntry(proof.transactionId) !== undefined) return `cleanup journal 引用 ${proof.transactionId.slice(0, 24)}`;
  const tombstoneHealth = peekTreasuryResolutionStoreHealth();
  if (!tombstoneHealth.healthy) return `resolution store unhealthy（fail closed）: ${tombstoneHealth.detail ?? ""}`;
  if (readTreasuryResolutionTombstone(proof.transactionId) !== undefined) return `resolution tombstone 在位（exact consumer——${proof.transactionId.slice(0, 24)}）`;
  if (generationLineageProbe === null) return "attempt lineage probe 未装配（fail closed——依赖不可判定）";
  if (!generationLineageProbe.lineageStoreHealthy()) return "attempt lineage store unhealthy（fail closed）";
  const lineage = generationLineageProbe.lineageOf(proof.transactionId);
  if (
    lineage !== undefined &&
    lineage.state !== "chain_committed" &&
    lineage.state !== "non_rearmable_retired" &&
    lineage.state !== "forensic_isolated"
  ) {
    return `active lineage 仍引用（state=${String(lineage.state)}）`;
  }
  return null;
}

/**
 * 有界（≤硬容量）eligible 扫描：驱逐被 matching exact current summary 真正
 * 接管 retirement 语义的 root 代 proof（【X 工作流 F】verifyTreasury
 * SummaryReplacement 全维度 + generationProofDependenciesActive 依赖关闭双
 * 门禁）。【XI 工作流 D】每条删除统一经 releaseGenerationProofDestructive
 * （mode="summary_superseded"——replacement relation 在 primitive 内部重验，
 * 外层扫描只是候选枚举，不构成授权）。索引维护与 read-back 恢复由 primitive
 * 统一承载（G6/G11）。返回驱逐数。
 */
function evictGenerationProofsSupersededBySummary(runtime: {
  store: { entries: Record<string, TreasuryGenerationRetirementProof>; entryCount: number; updatedAt: number };
  byAttempt: Map<string, string>;
  byLineage: Map<string, Set<string>>;
}): number {
  if (generationSummaryProbe === null) return 0;
  if (!generationSummaryProbe.summaryStoreHealthy()) return 0;
  let evicted = 0;
  for (const [key, proof] of Object.entries(runtime.store.entries)) {
    if (proof.generation !== 0) continue; // 只有 root 代可由 summary 的 rootExact 接管
    const summary = generationSummaryProbe.summaryOfLineageId(proof.lineageId);
    if (summary === undefined) continue;
    const relationError = verifyTreasuryGenerationSummaryReplacement(proof, summary);
    if (relationError !== null) continue; // exact relation 不一致（G1-G6）——不驱逐，继续扫描
    const dependency = generationProofDependenciesActive(proof);
    if (dependency !== null) continue; // exact consumer 仍依赖（G7）——不驱逐
    const outcome = releaseGenerationProofDestructive(runtime, key, "summary_superseded");
    if (outcome.status !== "released") break; // read-back 失败已恢复 / 权威阻断——停止本批
    evicted += 1;
    if (runtime.store.entryCount < TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES) break;
  }
  return evicted;
}

// ──【IX 工作流 E 8.3】统一 lifecycle owner resolver 的 GRA 维度（terminal
//    authority——O4：proof 在位时序号不得退休）。GRA import resolutionStore
//    （proof release 注册），不能被 resolver 顶层 import——经 probe 注入。
import { registerTreasuryLifecycleGenerationProofProbeForAssembly as __registerGenerationProbe } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
__registerGenerationProbe({
  proofOfAttempt: (transactionId) => lookupTreasuryGenerationRetirementProofByAttemptId(transactionId),
  proofStoreHealthy: () => peekTreasuryGenerationRetirementHealth().healthy,
});
