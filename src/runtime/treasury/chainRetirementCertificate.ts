/**
 * 【Round 22 Remediation VII 修复四】chain retirement certificate 与
 * retired range——有界的永久防重放权威（两层历史语义）。
 *
 * Remediation VI 的 historical store 是"一 attempt 一条记录"（384）——一条
 * 300-generation chain 就占用 301/384，不是长期运行方案。对任意外部字符串
 * ID，永久精确记住全部历史与有界 Memory 不可兼得；本模块与 attemptIssuer
 * 一起构成两层结构：
 *
 * 1. bounded exact outcome authority（historical store 384）——为活跃
 *    rearm chain、近期审计和冲突检测保留 exact outcome；chain 终结后可
 *    安全压缩；
 * 2. permanent anti-reuse authority（本模块 + issuer watermark）：
 *    - chain retirement certificate：每条终结 chain 一条（root/final 代/
 *      terminalState——与 generation 数量无关的有界常数 footprint）；
 *    - retired range：发行序号区间（吸收被压缩出 exact 层的 ti1_ root），
 *      相邻区间单调合并，最终收敛为一条 [1..N]——O(1) 空间、区间内 ID
 *      永久拒绝重放（不保留详细 outcome，不猜测、不误判未退休序号）。
 *
 * 压缩后即使详细 outcome 不再逐 attempt 保存，新 execution 仍被 permanent
 * authority 阻止：root ID → certificate / retired range；tr1_ child →
 * certificate 的 generation 区间（chain 外 ID 不 match；tr1_ 命名空间本身
 * 禁止直接 prepare，派生只经 active lineage 单调推进，不回退）。
 *
 * legacy/arbitrary root（非 ti1_）的 certificate 与 historical entry 永久
 * pin（不猜测进 high-watermark；无法安全压缩 → 容量满载 fail closed——
 * production 通道自本轮起只产生 ti1_ / tr1_ ID，legacy 数量有界）。
 */

import { registerTreasuryResolutionCleanupResetHook } from "@/runtime/treasury/receipts";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import {
  parseTreasuryIssuedInitialAttemptId,
  peekTreasuryAttemptIssuerHealth,
  resetTreasuryAttemptIssuerHeapCacheForTest,
} from "@/runtime/treasury/attemptIssuer";
import {
  parseTreasuryRearmChildTransactionIdV2,
  isTreasuryRearmAttemptId,
} from "@/runtime/treasury/transactionId";
import {
  listTreasuryHistoricalCompletionRecords,
  registerTreasuryHistoricalCompactorForAssembly,
  retireTreasuryHistoricalRecordForCompression,
  type TreasuryHistoricalCompletionRecord,
} from "@/runtime/treasury/cleanupSupersessionAuthority";

export const TREASURY_CHAIN_CERTIFICATE_VERSION = 1;
export const TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES = 256;
export const TREASURY_RETIRED_RANGE_VERSION = 1;
export const TREASURY_RETIRED_RANGE_MAX_ENTRIES = 64;
const CERTIFICATE_KEY_PREFIX = "crc:";
const LINEAGE_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 终结 chain 的紧凑永久权威（一条记录覆盖 root + 全部 generation——
 * footprint 与 generation 数量无关）。
 */
export interface TreasuryChainRetirementCertificate {
  readonly schemaVersion: typeof TREASURY_CHAIN_CERTIFICATE_VERSION;
  /** root 发行序号（root 是 ti1_ 时为其 seq；legacy/arbitrary root = -1——永久 pin）。 */
  readonly rootSequence: number;
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly finalAttemptId: string;
  /** final generation（root-only chain = 0）。 */
  readonly finalGeneration: number;
  /** chain_committed（final committed）/ non_rearmable_retired（final not-executed 不可重试）。 */
  readonly terminalState: "chain_committed" | "non_rearmable_retired";
  readonly finalizedAtTick: number;
}

export interface TreasuryChainCertificateStore {
  readonly version: typeof TREASURY_CHAIN_CERTIFICATE_VERSION;
  entries: Record<string, TreasuryChainRetirementCertificate>;
  entryCount: number;
  updatedAt: number;
}

/** 已退休发行序号的区间（相邻单调合并；区间内 ti1_ root 永久拒绝重放）。 */
export interface TreasuryRetiredSequenceRange {
  readonly minSequence: number;
  readonly maxSequence: number;
  readonly mergedAtTick: number;
}

export interface TreasuryRetiredRangeStore {
  readonly version: typeof TREASURY_RETIRED_RANGE_VERSION;
  ranges: TreasuryRetiredSequenceRange[];
  entryCount: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithCertificates {
  chainRetirementCertificates?: TreasuryChainCertificateStore;
  retiredAttemptRanges?: TreasuryRetiredRangeStore;
}

type RuntimeMemoryWithCertificates = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithCertificates;
};

interface CertificateRuntime {
  store: TreasuryChainCertificateStore;
  byLineageId: Map<string, string>;
  fatal: string | null;
}

interface RangeRuntime {
  store: TreasuryRetiredRangeStore;
  fatal: string | null;
}

let heapCertificateRuntime: CertificateRuntime | null = null;
let heapRangeRuntime: RangeRuntime | null = null;

registerTreasuryResolutionCleanupResetHook(() => {
  heapCertificateRuntime = null;
  heapRangeRuntime = null;
  resetTreasuryAttemptIssuerHeapCacheForTest();
});

function certificateBranch(): TreasuryMemoryBranchWithCertificates {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithCertificates;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function validateCertificateShape(certificate: unknown, key: string): string | null {
  if (!certificate || typeof certificate !== "object") return `chain certificate ${key.slice(0, 12)} 非对象`;
  const candidate = certificate as Partial<TreasuryChainRetirementCertificate>;
  if (candidate.schemaVersion !== TREASURY_CHAIN_CERTIFICATE_VERSION) {
    return `chain certificate ${key.slice(0, 12)} schemaVersion 非法`;
  }
  if (!Number.isSafeInteger(candidate.rootSequence) || (candidate.rootSequence as number) < -1) {
    return `chain certificate ${key.slice(0, 12)} rootSequence 非法`;
  }
  if (typeof candidate.lineageId !== "string" || !LINEAGE_ID_PATTERN.test(candidate.lineageId)) {
    return `chain certificate ${key.slice(0, 12)} lineageId 非法（须 16 小写 hex）`;
  }
  if (typeof candidate.rootTransactionId !== "string" || candidate.rootTransactionId.length === 0) {
    return `chain certificate ${key.slice(0, 12)} rootTransactionId 非法`;
  }
  if (key !== CERTIFICATE_KEY_PREFIX + candidate.rootTransactionId) {
    return `chain certificate ${key.slice(0, 12)} 键与 rootTransactionId 不一致`;
  }
  if (typeof candidate.finalAttemptId !== "string" || candidate.finalAttemptId.length === 0) {
    return `chain certificate ${key.slice(0, 12)} finalAttemptId 非法`;
  }
  if (!Number.isSafeInteger(candidate.finalGeneration) || (candidate.finalGeneration as number) < 0) {
    return `chain certificate ${key.slice(0, 12)} finalGeneration 非法`;
  }
  if (candidate.terminalState !== "chain_committed" && candidate.terminalState !== "non_rearmable_retired") {
    return `chain certificate ${key.slice(0, 12)} terminalState 非法`;
  }
  if (!Number.isSafeInteger(candidate.finalizedAtTick) || (candidate.finalizedAtTick as number) < 0) {
    return `chain certificate ${key.slice(0, 12)} finalizedAtTick 非法`;
  }
  return null;
}

function validateCertificateStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "chain certificate store 非对象";
  const candidate = store as Partial<TreasuryChainCertificateStore>;
  if (candidate.version !== TREASURY_CHAIN_CERTIFICATE_VERSION) {
    return `chain certificate store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "chain certificate store entries 非对象";
  const proto = Object.getPrototypeOf(candidate.entries);
  if (proto !== Object.prototype && proto !== null) return "chain certificate store entries 原型非普通对象";
  const keys = Object.keys(candidate.entries);
  if (keys.length > TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES) {
    return `chain certificate store 超过硬容量 ${String(TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES)}（实际 ${String(keys.length)}）`;
  }
  for (const key of keys) {
    if (key === "__proto__" || !key.startsWith(CERTIFICATE_KEY_PREFIX)) {
      return `chain certificate store 键 ${key.slice(0, 12)} 缺少前缀`;
    }
    const error = validateCertificateShape(candidate.entries[key], key);
    if (error !== null) return error;
  }
  if (candidate.entryCount !== keys.length) {
    return `chain certificate store entryCount ${String(candidate.entryCount)} != ${String(keys.length)}`;
  }
  return null;
}

function loadCertificateRuntime(): CertificateRuntime {
  if (heapCertificateRuntime !== null) return heapCertificateRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  if (raw === undefined) {
    const store: TreasuryChainCertificateStore = {
      version: TREASURY_CHAIN_CERTIFICATE_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    certificateBranch().chainRetirementCertificates = store;
    heapCertificateRuntime = { store, byLineageId: new Map(), fatal: null };
    return heapCertificateRuntime;
  }
  const shapeError = validateCertificateStoreShape(raw);
  const byLineageId = new Map<string, string>();
  if (shapeError === null) {
    for (const [key, certificate] of Object.entries(raw.entries)) {
      byLineageId.set(certificate.lineageId, key);
    }
  }
  heapCertificateRuntime = { store: raw as unknown as TreasuryChainCertificateStore, byLineageId, fatal: shapeError };
  return heapCertificateRuntime;
}

function validateRangeStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "retired range store 非对象";
  const candidate = store as Partial<TreasuryRetiredRangeStore>;
  if (candidate.version !== TREASURY_RETIRED_RANGE_VERSION) {
    return `retired range store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!Array.isArray(candidate.ranges)) return "retired range store ranges 非数组";
  if (candidate.ranges.length > TREASURY_RETIRED_RANGE_MAX_ENTRIES) {
    return `retired range store 超过硬容量 ${String(TREASURY_RETIRED_RANGE_MAX_ENTRIES)}（实际 ${String(candidate.ranges.length)}）`;
  }
  let previousMax = -1;
  for (const range of candidate.ranges) {
    if (!range || typeof range !== "object") return "retired range entry 非对象";
    if (
      !Number.isSafeInteger(range.minSequence) ||
      !Number.isSafeInteger(range.maxSequence) ||
      range.minSequence < 1 ||
      range.maxSequence < range.minSequence
    ) {
      return `retired range 区间非法（[${String(range.minSequence)}, ${String(range.maxSequence)}]）`;
    }
    if (!Number.isSafeInteger(range.mergedAtTick) || range.mergedAtTick < 0) {
      return "retired range mergedAtTick 非法";
    }
    if (range.minSequence <= previousMax) {
      return "retired range 区间必须严格递增且互不重叠（相邻可合并——重叠即损坏）";
    }
    previousMax = range.maxSequence;
  }
  if (candidate.entryCount !== candidate.ranges.length) {
    return `retired range store entryCount ${String(candidate.entryCount)} != ${String(candidate.ranges.length)}`;
  }
  return null;
}

function loadRangeRuntime(): RangeRuntime {
  if (heapRangeRuntime !== null) return heapRangeRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) {
    const store: TreasuryRetiredRangeStore = {
      version: TREASURY_RETIRED_RANGE_VERSION,
      ranges: [],
      entryCount: 0,
      updatedAt: Game.time,
    };
    certificateBranch().retiredAttemptRanges = store;
    heapRangeRuntime = { store, fatal: null };
    return heapRangeRuntime;
  }
  const shapeError = validateRangeStoreShape(raw);
  heapRangeRuntime = { store: raw as unknown as TreasuryRetiredRangeStore, fatal: shapeError };
  return heapRangeRuntime;
}

export interface TreasuryChainCertificateHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
}

/** 只读健康探测（store 不存在 = 健康空）。 */
export function peekTreasuryChainRetirementCertificateHealth(): TreasuryChainCertificateHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  if (raw === undefined) return { healthy: true, detail: null, entryCount: 0 };
  const shapeError = validateCertificateStoreShape(raw);
  return { healthy: shapeError === null, detail: shapeError, entryCount: shapeError === null ? raw.entryCount : -1 };
}

export interface TreasuryRetiredRangeHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

export function peekTreasuryRetiredRangeHealth(): TreasuryRetiredRangeHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return { healthy: true, detail: null };
  const shapeError = validateRangeStoreShape(raw);
  return { healthy: shapeError === null, detail: shapeError };
}

/** root ID → certificate（O(1) 单 key）。 */
export function lookupTreasuryChainRetirementCertificate(
  rootTransactionId: string,
): TreasuryChainRetirementCertificate | undefined {
  const runtime = loadCertificateRuntime();
  if (runtime.fatal !== null) return undefined;
  const certificate = runtime.store.entries[CERTIFICATE_KEY_PREFIX + rootTransactionId];
  if (certificate === undefined) return undefined;
  // 防御性单条复验（load 后篡改拦截——损坏不当作在位权威）。
  const shapeError = validateCertificateShape(certificate, CERTIFICATE_KEY_PREFIX + rootTransactionId);
  if (shapeError !== null) return undefined;
  return certificate;
}

export type TreasuryChainGenerationOutcome =
  | {
      readonly verdict: "match";
      readonly outcome: "committed" | "not-executed";
      readonly certificate: TreasuryChainRetirementCertificate;
      readonly detail: string;
    }
  | { readonly verdict: "absent" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/**
 * generation-addressable tr1_ child ID 的 chain 内代查询（O(1)：ID 自带
 * (lineageId, generation)）：
 * - generation ≤ finalGeneration：属于已退休 chain——非 final 代协议确定
 *   not-executed（重试语义：中间代全部被下一代替代）；final 代 outcome 由
 *   terminalState 确定；
 * - generation > finalGeneration：不在链内（不 match——不猜测）。
 */
export function lookupTreasuryChainRetirementGenerationOutcome(
  transactionId: string,
): TreasuryChainGenerationOutcome {
  if (!isTreasuryRearmAttemptId(transactionId)) return { verdict: "absent" };
  const parsed = parseTreasuryRearmChildTransactionIdV2(transactionId);
  if (parsed === null) {
    // 旧 v1 child ID（不携带 lineageId/generation）——不可寻址，不猜测。
    return { verdict: "absent" };
  }
  const runtime = loadCertificateRuntime();
  if (runtime.fatal !== null) {
    return { verdict: "store_unhealthy", detail: `chain certificate store fail-closed: ${runtime.fatal}` };
  }
  const key = runtime.byLineageId.get(parsed.lineageId);
  if (key === undefined) return { verdict: "absent" };
  const certificate = runtime.store.entries[key];
  if (certificate === undefined) return { verdict: "absent" };
  const shapeError = validateCertificateShape(certificate, key);
  if (shapeError !== null) {
    return { verdict: "store_unhealthy", detail: `chain certificate 损坏: ${shapeError}` };
  }
  if (parsed.generation > certificate.finalGeneration) {
    return { verdict: "absent" };
  }
  if (parsed.generation === certificate.finalGeneration) {
    const outcome = certificate.terminalState === "chain_committed" ? "committed" : "not-executed";
    return {
      verdict: "match",
      outcome,
      certificate,
      detail: `chain certificate（lineage ${parsed.lineageId.slice(0, 8)}）final generation ${String(parsed.generation)} 终态 ${certificate.terminalState}`,
    };
  }
  return {
    verdict: "match",
    outcome: "not-executed",
    certificate,
    detail: `chain certificate（lineage ${parsed.lineageId.slice(0, 8)}）generation ${String(parsed.generation)} < final ${String(certificate.finalGeneration)}——中间代协议确定 not-executed`,
  };
}

/** ti1_ ID 的 retired range 判定（区间扫描 ≤64 有界；区间必须严格递增）。 */
export function checkTreasuryAttemptRetiredRange(
  transactionId: string,
): { readonly retired: boolean; readonly detail: string } {
  const parsed = parseTreasuryIssuedInitialAttemptId(transactionId);
  if (parsed === null) return { retired: false, detail: "" };
  const runtime = loadRangeRuntime();
  if (runtime.fatal !== null) {
    // store 损坏不得折叠为"未退休"——按 retired 阻断（fail closed；resolver
    // 侧的 health 检查已在入口拦截，此处防御性兜底）。
    return { retired: true, detail: `retired range store 损坏（fail closed）: ${runtime.fatal}` };
  }
  for (const range of runtime.store.ranges) {
    if (parsed.sequence >= range.minSequence && parsed.sequence <= range.maxSequence) {
      return { retired: true, detail: `[${String(range.minSequence)}, ${String(range.maxSequence)}]` };
    }
  }
  return { retired: false, detail: "" };
}

// ── 写入（compaction 接线调用——state-changing）────────────────────────────

/**
 * 吸收一个已退休发行序号进 retired range（相邻单调合并；写入 + read-back）。
 * 区间满载且无相邻可合 → rejected（fail closed——不合并不相邻区间，绝不
 * 把未退休序号误判为 retired）。
 */
export function absorbTreasuryRetiredSequence(sequence: number): { readonly status: "absorbed" | "idempotent" } | { readonly status: "rejected"; readonly detail: string } {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return { status: "rejected", detail: `退休序号非法: ${String(sequence)}` };
  }
  const runtime = loadRangeRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: `retired range store fail-closed: ${runtime.fatal}` };
  }
  const ranges = runtime.store.ranges;
  for (const range of ranges) {
    if (sequence >= range.minSequence && sequence <= range.maxSequence) {
      return { status: "idempotent" };
    }
  }
  const nextRanges: TreasuryRetiredSequenceRange[] = ranges.map((range) => ({ ...range }));
  // 插入并吸收相邻区间（min-1 / max+1 相邻者合并——单调收敛）。
  let merged = false;
  for (let index = 0; index < nextRanges.length; index += 1) {
    const range = nextRanges[index];
    if (sequence === range.minSequence - 1) {
      nextRanges[index] = { ...range, minSequence: sequence, mergedAtTick: Game.time };
      merged = true;
      break;
    }
    if (sequence === range.maxSequence + 1) {
      nextRanges[index] = { ...range, maxSequence: sequence, mergedAtTick: Game.time };
      merged = true;
      break;
    }
  }
  if (!merged) {
    nextRanges.push({ minSequence: sequence, maxSequence: sequence, mergedAtTick: Game.time });
    nextRanges.sort((left, right) => left.minSequence - right.minSequence);
  }
  // 相邻区间二次合并（扩展后可能桥接两个旧区间）。
  const coalesced: TreasuryRetiredSequenceRange[] = [];
  for (const range of nextRanges) {
    const last = coalesced[coalesced.length - 1];
    if (last !== undefined && range.minSequence <= last.maxSequence + 1) {
      coalesced[coalesced.length - 1] = {
        minSequence: last.minSequence,
        maxSequence: Math.max(last.maxSequence, range.maxSequence),
        mergedAtTick: Game.time,
      };
    } else {
      coalesced.push({ ...range });
    }
  }
  if (coalesced.length > TREASURY_RETIRED_RANGE_MAX_ENTRIES) {
    return {
      status: "rejected",
      detail: `retired range 已达硬容量 ${String(TREASURY_RETIRED_RANGE_MAX_ENTRIES)} 且无相邻区间可合并（不吸收不相邻序号——fail closed）`,
    };
  }
  const previous = JSON.stringify(runtime.store.ranges);
  runtime.store.ranges = coalesced;
  runtime.store.entryCount = coalesced.length;
  runtime.store.updatedAt = Game.time;
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  const shapeError = rawStore === undefined ? "retired range store 缺失" : validateRangeStoreShape(rawStore);
  if (shapeError !== null) {
    runtime.store.ranges = JSON.parse(previous) as TreasuryRetiredSequenceRange[];
    runtime.store.entryCount = runtime.store.ranges.length;
    runtime.store.updatedAt = Game.time;
    return { status: "rejected", detail: `retired range read-back 失败: ${shapeError}` };
  }
  return { status: "absorbed" };
}

export type TreasuryChainCertificateRecordResult =
  | { readonly status: "written" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * chain certificate 写入（terminal compaction 成功后调用）：写入 + 单 key
 * Memory read-back；同 root 幂等要求全部字段一致（不覆盖）。容量满载时先
 * 把最老的非 legacy certificate（rootSequence 最小的 ti1_ chain）压缩进
 * retired range（吸收其 root 序号 + 删除该 certificate——该 chain 的查询
 * 退化为 retired，永久防重放不丢）；全部为 legacy pin 无法压缩 → fail
 * closed（不删除旧权威）。
 */
export function recordTreasuryChainRetirementCertificate(input: {
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly finalAttemptId: string;
  readonly finalGeneration: number;
  readonly terminalState: "chain_committed" | "non_rearmable_retired";
}): TreasuryChainCertificateRecordResult {
  const issuerHealth = peekTreasuryAttemptIssuerHealth();
  if (!issuerHealth.healthy) {
    return { status: "rejected", detail: `attempt issuer store unhealthy: ${issuerHealth.detail}（root 序号不可判定——不写 certificate）` };
  }
  const parsedRoot = parseTreasuryIssuedInitialAttemptId(input.rootTransactionId);
  const rootSequence = parsedRoot !== null ? parsedRoot.sequence : -1;
  const runtime = loadCertificateRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: `chain certificate store fail-closed: ${runtime.fatal}` };
  }
  const candidate: TreasuryChainRetirementCertificate = cloneTreasuryDurableValue({
    schemaVersion: TREASURY_CHAIN_CERTIFICATE_VERSION,
    rootSequence,
    lineageId: input.lineageId,
    rootTransactionId: input.rootTransactionId,
    finalAttemptId: input.finalAttemptId,
    finalGeneration: input.finalGeneration,
    terminalState: input.terminalState,
    finalizedAtTick: Game.time,
  });
  const shapeError = validateCertificateShape(candidate, CERTIFICATE_KEY_PREFIX + input.rootTransactionId);
  if (shapeError !== null) {
    return { status: "rejected", detail: `chain certificate candidate 非法: ${shapeError}` };
  }
  const key = CERTIFICATE_KEY_PREFIX + input.rootTransactionId;
  const existing = runtime.store.entries[key];
  if (existing !== undefined) {
    const same =
      existing.rootSequence === candidate.rootSequence &&
      existing.lineageId === candidate.lineageId &&
      existing.rootTransactionId === candidate.rootTransactionId &&
      existing.finalAttemptId === candidate.finalAttemptId &&
      existing.finalGeneration === candidate.finalGeneration &&
      existing.terminalState === candidate.terminalState;
    return same
      ? { status: "idempotent" }
      : { status: "rejected", detail: "同 root 已存在不同 identity 的 chain certificate（不覆盖旧权威）" };
  }
  if (runtime.store.entryCount >= TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES) {
    // 满载压缩：最老的非 legacy certificate → root 序号进 retired range。
    let oldestKey: string | null = null;
    let oldestSequence = Infinity;
    for (const [candidateKey, certificate] of Object.entries(runtime.store.entries)) {
      if (certificate.rootSequence >= 1 && certificate.rootSequence < oldestSequence) {
        oldestSequence = certificate.rootSequence;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === null) {
      return {
        status: "rejected",
        detail: `chain certificate 已达硬容量 ${String(TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES)} 且全部为 legacy pin（不删除旧权威——fail closed）`,
      };
    }
    const absorbed = absorbTreasuryRetiredSequence(oldestSequence);
    if (absorbed.status === "rejected") {
      return { status: "rejected", detail: `certificate 满载压缩失败（retired range）: ${absorbed.detail}` };
    }
    const evicted = runtime.store.entries[oldestKey];
    delete runtime.store.entries[oldestKey];
    runtime.store.entryCount -= 1;
    runtime.store.updatedAt = Game.time;
    runtime.byLineageId.delete(evicted.lineageId);
    const rawEvict = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
    if (rawEvict === undefined || rawEvict.entries[oldestKey] !== undefined || rawEvict.entryCount !== runtime.store.entryCount) {
      // 驱逐 read-back 失败：恢复 entry（保守——certificate 不写）。
      runtime.store.entries[oldestKey] = evicted;
      runtime.store.entryCount += 1;
      runtime.byLineageId.set(evicted.lineageId, oldestKey);
      return { status: "rejected", detail: "certificate 满载驱逐 read-back 失败（不写新 certificate——fail closed）" };
    }
  }
  runtime.store.entries[key] = cloneTreasuryDurableValue(candidate);
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  runtime.byLineageId.set(candidate.lineageId, key);
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  if (rawStore === undefined) {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.byLineageId.delete(candidate.lineageId);
    return { status: "rejected", detail: "chain certificate 写入后 Memory read-back store 缺失（已回滚）" };
  }
  const readBack = rawStore.entries[key];
  const readBackError = readBack === undefined ? "read-back certificate 缺失" : validateCertificateShape(readBack, key);
  if (readBackError !== null) {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.byLineageId.delete(candidate.lineageId);
    return { status: "rejected", detail: `chain certificate read-back 失败: ${readBackError}（已回滚）` };
  }
  const readBackCertificate = readBack as TreasuryChainRetirementCertificate;
  if (
    readBackCertificate.rootSequence !== candidate.rootSequence ||
    readBackCertificate.lineageId !== candidate.lineageId ||
    readBackCertificate.finalAttemptId !== candidate.finalAttemptId ||
    readBackCertificate.finalGeneration !== candidate.finalGeneration ||
    readBackCertificate.terminalState !== candidate.terminalState
  ) {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.byLineageId.delete(candidate.lineageId);
    return { status: "rejected", detail: "chain certificate read-back 字段不一致（已回滚）" };
  }
  return { status: "written" };
}

/** test-only：删除两个 durable store（heap 一并失效）。 */
export function clearTreasuryChainCertificateDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury;
  if (branch !== undefined) {
    delete branch.chainRetirementCertificates;
    delete branch.retiredAttemptRanges;
  }
  heapCertificateRuntime = null;
  heapRangeRuntime = null;
}

// ──【Remediation VII 修复四】historical 压缩（bounded exact outcome 层 →
//    permanent anti-reuse 层的退休通道）────────────────────────────────────

/** 压缩保留窗口：最近归档的 exact outcome 保留供审计/冲突检测（不做即时压缩）。 */
export const TREASURY_HISTORICAL_RETAINED_RECENT = 64;

/**
 * chain 压缩（terminal compaction 成功、certificate 写入 read-back 之后
 * 调用）：该 chain 的全部 per-attempt historical entries 退休——cert 已
 * 承载 root + final 代 exact outcome 与全部中间代的协议性 not-executed，
 * chain 级永久 footprint 与 generation 数量无关（T17：301 → certificate
 * 一条）。每条退休前 Memory 直读复验 + certificate 在位 guard。
 */
export function compressTreasuryChainHistoricalEntries(input: {
  readonly rootTransactionId: string;
  readonly lineageId: string;
}): { readonly retired: number } {
  const certificateKey = CERTIFICATE_KEY_PREFIX + input.rootTransactionId;
  const certificateInPlace = (): boolean => {
    const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
    const certificate = rawStore?.entries[certificateKey];
    return certificate !== undefined && certificate.lineageId === input.lineageId;
  };
  if (!certificateInPlace()) return { retired: 0 };
  let retired = 0;
  for (const record of listTreasuryHistoricalCompletionRecords()) {
    const inChain =
      record.transactionId === input.rootTransactionId ||
      (record.identity.lineageId !== undefined && record.identity.lineageId === input.lineageId);
    if (!inChain) continue;
    // guard：certificate 仍在位（每条独立验证——证书中途被逐出则停止删除）。
    if (retireTreasuryHistoricalRecordForCompression(record.transactionId, certificateInPlace)) {
      retired += 1;
    }
  }
  return { retired };
}

/**
 * 满载压缩（archive capacity 分支经 assembly 注入触发；有界 ≤ 硬容量）：
 * 只退休已有 permanent anti-reuse 接管的 entry——
 *  - 非 tr1_ root 且是 ti1_ service-issued ID：retired range 先吸收其
 *    发行序号（read-back）再删除（独立 initial attempt 的终结 completion
 *    已完整验证——exact outcome 压缩为 retired 事实，重放由 range 阻断）；
 *  - tr1_ child：其 chain 的 certificate 在位才可退休（chain 未终结不碰）；
 *  - legacy/arbitrary root（非 ti1_）：永久保留（replay blocker——不猜测
 *    进 high-watermark）；
 *  - 最近 TREASURY_HISTORICAL_RETAINED_RECENT 条保留（审计窗口）。
 * 任一条目退休失败（range 写入/直读复验）→ 跳过该条继续（fail closed
 * 单条不阻塞其它），调用方按剩余容量决定是否拒绝。
 */
export function compressTreasuryRetirableHistoricalEntries(): { readonly retired: number } {
  const records = listTreasuryHistoricalCompletionRecords();
  if (records.length === 0) return { retired: 0 };
  // 保留最近归档的 N 条（archivedAtTick 降序取前 N 的 transactionId 集合）。
  const recentIds = new Set(
    records
      .slice()
      .sort((left, right) => right.archivedAtTick - left.archivedAtTick)
      .slice(0, TREASURY_HISTORICAL_RETAINED_RECENT)
      .map((record) => record.transactionId),
  );
  const issuerHealth = peekTreasuryAttemptIssuerHealth();
  const issuerHealthy = issuerHealth.healthy;
  let retired = 0;
  for (const record of records) {
    if (retired >= TREASURY_HISTORICAL_RETAINED_RECENT) break; // 压缩量有界（每次 ≤ 保留窗口大小）
    if (recentIds.has(record.transactionId)) continue;
    if (isTreasuryRearmAttemptId(record.transactionId)) {
      // tr1_ child：chain certificate 在位才退休（guard 每条验证）。
      const parsed = parseTreasuryRearmChildTransactionIdV2(record.transactionId);
      if (parsed === null) continue;
      const certificateKey = lookupCertificateKeyByLineageId(parsed.lineageId);
      if (certificateKey === null) continue;
      if (retireTreasuryHistoricalRecordForCompression(record.transactionId, () => certificateKeyInPlace(certificateKey, parsed.lineageId))) {
        retired += 1;
      }
      continue;
    }
    // 独立 initial attempt：issuer 损坏时零压缩（fail closed）；root 序号
    // 先进 retired range（read-back）再删除。
    const parsed = parseTreasuryIssuedInitialAttemptId(record.transactionId);
    if (parsed === null) continue; // legacy/arbitrary root：永久保留
    if (!issuerHealthy) continue;
    const absorbed = absorbTreasuryRetiredSequence(parsed.sequence);
    if (absorbed.status === "rejected") continue;
    if (retireTreasuryHistoricalRecordForCompression(record.transactionId, () => rangeAbsorbsSequence(parsed.sequence))) {
      retired += 1;
    }
  }
  return { retired };
}

function lookupCertificateKeyByLineageId(lineageId: string): string | null {
  const runtime = loadCertificateRuntime();
  if (runtime.fatal !== null) return null;
  return runtime.byLineageId.get(lineageId) ?? null;
}

function certificateKeyInPlace(key: string, lineageId: string): boolean {
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  const certificate = rawStore?.entries[key];
  return certificate !== undefined && certificate.lineageId === lineageId;
}

function rangeAbsorbsSequence(sequence: number): boolean {
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (rawStore === undefined || !Array.isArray(rawStore.ranges)) return false;
  return rawStore.ranges.some((range) => sequence >= range.minSequence && sequence <= range.maxSequence);
}

// 模块加载注册（archive 满载压缩回调——cleanupSupersessionAuthority 的
// capacity 分支调用；未装配时该分支 fail closed）。
registerTreasuryHistoricalCompactorForAssembly(compressTreasuryRetirableHistoricalEntries);

/** test-only：只清 heap 缓存（模拟 global reset 后从 Memory 恢复）。 */
export function resetTreasuryChainCertificateHeapCacheForTest(): void {
  heapCertificateRuntime = null;
  heapRangeRuntime = null;
}

/** 【诊断/测试】certificate store entry 数（只读）。 */
export function peekTreasuryChainCertificateEntryCount(): number {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  if (raw === undefined) return 0;
  const keys = raw && typeof raw === "object" ? Object.keys(raw.entries ?? {}) : [];
  return keys.length > TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES ? -1 : keys.length;
}

/** 【诊断/测试】retired range 数（只读）。 */
export function peekTreasuryRetiredRangeEntryCount(): number {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return 0;
  return Array.isArray(raw.ranges) ? raw.ranges.length : -1;
}
