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
import { registerTreasuryGenerationProofReleaseForAssembly } from "@/runtime/treasury/resolutionStore";

export const TREASURY_GENERATION_RETIREMENT_VERSION = 1;
/** 硬容量（evidence 记录推导：256 tombstone 依赖上界 + 64 active 当前代 + 余量）。 */
export const TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES = 384;

const PROOF_KEY_PREFIX = "gr:";
const DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/** exact per-generation retirement proof（可独立验证的该代退休权威）。 */
export interface TreasuryGenerationRetirementProof {
  readonly schemaVersion: 1;
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
  if (store.version !== TREASURY_GENERATION_RETIREMENT_VERSION) {
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
  const store = branch.generationRetirementProofs as unknown as TreasuryGenerationRetirementStore;
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
    generationRetirementEvents.writeFailures += 1;
    return {
      status: "rejected",
      detail: `generation retirement store 已达硬容量 ${String(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES)}（fail closed——不驱逐被依赖 proof；retirement 保持 retiring）`,
    };
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

/**
 * tombstone 驱逐联动释放（resolutionStore.evictExpiredTombstones 注入调用）：
 * 该 attempt 的 tombstone 已按 replacement_match 驱逐 → 对应代 proof 的
 * 唯一长期依赖消失（root 门禁由 summary 承担）→ 释放。store unhealthy 时
 * 不释放（fail closed）。
 */
export function releaseTreasuryGenerationRetirementProofOfAttempt(transactionId: string): { readonly status: "released" } | { readonly status: "absent" } | { readonly status: "rejected"; readonly detail: string } {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) return { status: "rejected", detail: runtime.fatal };
  // 【第二十轮 10.1】byAttempt O(1) 索引：root（gen 0，非 tr1_）与 tr1_ child
  // 的 tombstone 驱逐联动释放统一路径（root 门禁由 retirement summary 承担）。
  const key = runtime.byAttempt.get(transactionId);
  if (key === undefined) return { status: "absent" };
  const proof = runtime.store.entries[key];
  if (proof === undefined) return { status: "absent" };
  // 当前代 proof 是下一代 capability 签发门禁（10.3）的依据——chain 仍活跃
  //（record 存在且 generation 相同）时不得因 tombstone 驱逐释放（只有历史代
  // 的 proof 在其 tombstone 驱逐后才是孤儿）。
  const activeRecord = peekTreasurySemanticLineageRecordSource()?.readByLineageId(proof.lineageId);
  if (activeRecord !== undefined && activeRecord.generation === proof.generation) {
    return { status: "absent" };
  }
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  runtime.byAttempt.delete(transactionId);
  const keys = runtime.byLineage.get(proof.lineageId);
  if (keys !== undefined) {
    keys.delete(key);
    if (keys.size === 0) runtime.byLineage.delete(proof.lineageId);
  }
  generationRetirementEvents.releases += 1;
  return { status: "released" };
}

/**
 * chain 压缩后的孤儿清理（lineageRetirementSummary 压缩编排调用）：该
 * lineage 中"tombstone 已不存在"的历史代 proof 释放（summary 已写入——
 * root 门禁不依赖本 store）。per-chain 有界遍历（≤ 该 chain 代数 ≤ 容量）。
 */
export function releaseOrphanTreasuryGenerationRetirementProofs(
  lineageId: string,
  tombstoneExists: (generation: number, proof: Readonly<TreasuryGenerationRetirementProof>) => boolean,
): number {
  const runtime = loadGenerationRetirementRuntime();
  if (runtime.fatal !== null) return 0;
  const keys = runtime.byLineage.get(lineageId);
  if (keys === undefined) return 0;
  let released = 0;
  for (const key of [...keys]) {
    const proof = runtime.store.entries[key];
    if (proof === undefined) {
      keys.delete(key);
      continue;
    }
    if (tombstoneExists(proof.generation, proof)) continue;
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.store.updatedAt = Game.time;
    runtime.byAttempt.delete(proof.transactionId);
    keys.delete(key);
    released += 1;
  }
  if (keys.size === 0) runtime.byLineage.delete(lineageId);
  generationRetirementEvents.orphanReleases += released;
  return released;
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
  registerTreasuryGenerationProofReleaseForAssembly((transactionId) => {
    void releaseTreasuryGenerationRetirementProofOfAttempt(transactionId);
  });
}
registerTreasuryGenerationRetirementSemanticSourceForAssembly();
