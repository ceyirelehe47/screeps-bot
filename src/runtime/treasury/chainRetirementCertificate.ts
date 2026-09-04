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

import { lookupTreasurySettledReceipt, registerTreasuryResolutionCleanupResetHook } from "@/runtime/treasury/receipts";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import {
  buildTreasuryIssuedInitialAttemptIdFromSequence,
  parseTreasuryIssuedInitialAttemptId,
  peekTreasuryAttemptIssuerHealth,
  peekTreasuryIssuedAttemptWatermark,
  resetTreasuryAttemptIssuerHeapCacheForTest,
  verifyTreasuryCurrentIssuedIdCanonical,
  buildTreasuryCurrentIssuedIdUnchecked,
} from "@/runtime/treasury/attemptIssuer";
import { lookupTreasuryCleanupCompletion } from "@/runtime/treasury/cleanupCompletionAuthority";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { readTreasuryResolutionCleanupEntry } from "@/runtime/treasury/resolutionCleanupJournal";
import { readTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import { readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import {
  parseTreasuryRearmChildTransactionIdV2,
  treasuryRearmChildIdChecksumOf,
  isTreasuryRearmAttemptId,
} from "@/runtime/treasury/transactionId";
import {
  listTreasuryHistoricalCompletionRecords,
  registerTreasuryHistoricalCompactorForAssembly,
  retireTreasuryHistoricalRecordForCompression,
  type TreasuryHistoricalCompletionRecord,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";

export const TREASURY_CHAIN_CERTIFICATE_VERSION = 1;
export const TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES = 256;
/**
 * 【XII 工作流 E】v3：真实物理分区——current 与 legacy 是同一版本化 store
 * 内的**独立分区**（各自独立数组与硬上限），不再共享单一 ranges 数组的
 * 逻辑 quota。v1（裸 sequence）/ v2（单一 ranges + namespace 标签）经
 * tick-boundary migration owner 显式迁移（query 零写）。
 */
export const TREASURY_RETIRED_RANGE_VERSION = 3;
/**
 * 【XII 工作流 E】current 分区物理硬上限（原定保留预算——legacy 无论多少
 * 条都占不走 current 的容量）。总 Memory 硬上限 = CURRENT + LEGACY_OVERFLOW。
 */
export const TREASURY_RETIRED_RANGE_CURRENT_CAPACITY = 48;
/**
 * legacy 分区的正常配额；v2 存量迁移可能携带超额 legacy（旧协议允许至
 * 64）——超额部分显式标记 legacyOverflow（legacy 新吸收 fail closed、
 * current 分区不受影响、不静默裁剪）。
 */
export const TREASURY_RETIRED_RANGE_LEGACY_QUOTA = 16;
/** legacy 分区物理硬上限（旧协议 v2 单数组的 64 上限——迁移存量的显式上界）。 */
export const TREASURY_RETIRED_RANGE_LEGACY_CAPACITY = 64;
/** 向后兼容别名（XI 语义——current 预算即 48）。 */
export const TREASURY_RETIRED_RANGE_CURRENT_QUOTA = TREASURY_RETIRED_RANGE_CURRENT_CAPACITY;
/** 总 Memory 硬上限（两分区物理上限之和——v3 布局的上界不变量）。 */
export const TREASURY_RETIRED_RANGE_MAX_ENTRIES = TREASURY_RETIRED_RANGE_CURRENT_CAPACITY + TREASURY_RETIRED_RANGE_LEGACY_CAPACITY;
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

/**
 * 已退休发行序号的区间（同一发行域内相邻单调合并）。
 * 【X 工作流 D】区间绑定 issuer domain：ti1_（legacy）与 ti2_（current）的
 * 相同序号是两个不同发行域的独立事实——ti1_ range [1,100] 不得退休新签发
 * 的 ti2_1，ti2_ 的退休也不得自动覆盖 ti1_ 的重放阻断（N1/N2/N3）。
 */
export type TreasuryRetiredRangeNamespace = "legacy" | "current";

export interface TreasuryRetiredSequenceRange {
  readonly namespace: TreasuryRetiredRangeNamespace;
  readonly minSequence: number;
  readonly maxSequence: number;
  readonly mergedAtTick: number;
}

/** 区间数组的确定性排序（namespace 字典序 current < legacy，域内按序号）。 */
function compareRetiredRanges(left: TreasuryRetiredSequenceRange, right: TreasuryRetiredSequenceRange): number {
  if (left.namespace !== right.namespace) return left.namespace < right.namespace ? -1 : 1;
  return left.minSequence - right.minSequence;
}

export interface TreasuryRetiredRangePartition {
  /** 本分区的独立区间数组（条目 namespace 必须与分区一致——校验强制）。 */
  ranges: TreasuryRetiredSequenceRange[];
  entryCount: number;
}

/**
 * 【XII 工作流 E】v3 物理分区布局：current 与 legacy 各自独立数组 + 独立
 * 硬上限（48 / 16，legacy 迁移存量显式溢出至多 64 并标记 legacyOverflow）。
 * 两域不共享可被另一方全部占用的物理 entry 上限；总 Memory 硬上限 = 112。
 */
export interface TreasuryRetiredRangeStore {
  readonly version: typeof TREASURY_RETIRED_RANGE_VERSION;
  current: TreasuryRetiredRangePartition;
  legacy: TreasuryRetiredRangePartition;
  /** legacy 分区超额（> LEGACY_QUOTA 的迁移存量）显式 forensic 标记：legacy 新吸收 fail closed，current 分区不受影响。 */
  legacyOverflow?: boolean;
  updatedAt: number;
}

/** 【XII 工作流 E】v2 单一数组布局（迁移源——读路径只报 migration_required）。 */
interface TreasuryRetiredRangeStoreV2 {
  readonly version: 2;
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
  /** heap 空视图是否已发布到 Memory（absent + 只读查询 → false——零写）。 */
  published: boolean;
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
  return validateCertificateCanonicalRelations(candidate as TreasuryChainRetirementCertificate, key);
}

/**
 * 【Remediation VIII 工作流 C】certificate 的 canonical 关系验证（store
 * load 与单条 lookup 共用——任一违反即整条损坏，不当作在位权威）：
 * 1. finalAttemptId 必须与 root / lineage / finalGeneration 的确定性派生
 *    一致（finalGeneration=0 → finalAttemptId 即 root；≥1 → v2 child 形态
 *    + lineageId/generation 匹配 + checksum 按 rootTransactionId 重算一致）；
 * 2. rootSequence 必须与 rootTransactionId 的发行事实一致（ti1_ root 的
 *    解析序号；legacy root = -1 且不得为 ti1_ 形态）。
 */
function validateCertificateCanonicalRelations(
  certificate: TreasuryChainRetirementCertificate,
  key: string,
): string | null {
  if (certificate.finalGeneration === 0) {
    if (certificate.finalAttemptId !== certificate.rootTransactionId) {
      return `chain certificate ${key.slice(0, 12)} finalGeneration=0 但 finalAttemptId != rootTransactionId`;
    }
  } else {
    const parsedFinal = parseTreasuryRearmChildTransactionIdV2(certificate.finalAttemptId);
    if (parsedFinal === null) {
      return `chain certificate ${key.slice(0, 12)} finalGeneration>=1 但 finalAttemptId 非 v2 child 形态`;
    }
    if (parsedFinal.lineageId !== certificate.lineageId || parsedFinal.generation !== certificate.finalGeneration) {
      return `chain certificate ${key.slice(0, 12)} finalAttemptId 的 lineage/generation 与证书不一致`;
    }
    const expectedChecksum = treasuryRearmChildIdChecksumOf({
      lineageId: certificate.lineageId,
      generation: certificate.finalGeneration,
      rootTransactionId: certificate.rootTransactionId,
    });
    const actualChecksum = certificate.finalAttemptId.slice(certificate.finalAttemptId.length - 8);
    if (expectedChecksum !== actualChecksum) {
      return `chain certificate ${key.slice(0, 12)} finalAttemptId checksum 与确定性派生不一致`;
    }
  }
  const parsedRoot = parseTreasuryIssuedInitialAttemptId(certificate.rootTransactionId);
  if (certificate.rootSequence >= 1) {
    if (parsedRoot === null || parsedRoot.sequence !== certificate.rootSequence) {
      return `chain certificate ${key.slice(0, 12)} rootSequence 与 rootTransactionId 发行序号不一致`;
    }
    // 【XI 工作流 C / C1-C2】current（ti2_）root 的完整 canonical 校验：
    // checksum 按协议 tag v3 确定性重算全等 + rootSequence 与 ID 内 sequence
    // 完全相等 + namespace === current。legacy（ti1_）root 保持隔离语义
    //（不用当前协议重算 legacy checksum、不解释为 current）；宽松 parser
    // 的形态匹配不构成 root 权威。
    if (parsedRoot.namespace === "current") {
      const canonical = verifyTreasuryCurrentIssuedIdCanonical(certificate.rootTransactionId, certificate.rootSequence);
      if ("reason" in canonical) {
        return `chain certificate ${key.slice(0, 12)} rootTransactionId 非 canonical current 发行 ID: ${canonical.reason}`;
      }
    }
  } else if (parsedRoot !== null) {
    return `chain certificate ${key.slice(0, 12)} rootSequence=-1（legacy pin）但 rootTransactionId 是 ti1_ 形态`;
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

/**
 * 【XII 工作流 D / Q1】certificate runtime 加载：store 不存在时——只读
 * 路径（forWrite=false，lookup/health/generation outcome）返回 heap-only
 * 空视图（零写——**不**创建 `chainRetirementCertificates` 分支）；写路径
 * （forWrite=true，record）创建空 store 并发布到 Memory。store 在位 →
 * 全量形状校验（fatal fail closed，原数据保留）。
 */
function loadCertificateRuntime(forWrite = false): CertificateRuntime {
  if (heapCertificateRuntime !== null) return heapCertificateRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  if (raw === undefined) {
    const store: TreasuryChainCertificateStore = {
      version: TREASURY_CHAIN_CERTIFICATE_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    heapCertificateRuntime = { store, byLineageId: new Map(), fatal: null, published: false };
    if (forWrite) {
      certificateBranch().chainRetirementCertificates = store;
      heapCertificateRuntime.published = true;
    }
    return heapCertificateRuntime;
  }
  const shapeError = validateCertificateStoreShape(raw);
  const byLineageId = new Map<string, string>();
  if (shapeError === null) {
    for (const [key, certificate] of Object.entries(raw.entries)) {
      byLineageId.set(certificate.lineageId, key);
    }
  }
  heapCertificateRuntime = { store: raw as unknown as TreasuryChainCertificateStore, byLineageId, fatal: shapeError, published: true };
  return heapCertificateRuntime;
}

/**
 * 【XII 工作流 D / Q1】写前发布（record 路径专用）：只读查询可能已建立
 * heap-only 空视图（published=false）——真实写入前必须发布到 Memory，
 * 否则写入落在 heap 幽灵对象上（Memory 从未收到权威数据）。
 */
function ensureCertificateStorePublished(): void {
  const runtime = loadCertificateRuntime(true);
  if (!runtime.published) {
    certificateBranch().chainRetirementCertificates = runtime.store;
    runtime.published = true;
  }
}

/** 【XII 工作流 E】单分区条目级校验（namespace 与分区一致 + 域内严格递增）。 */
function validateRangePartitionShape(
  partition: unknown,
  expectedNamespace: TreasuryRetiredRangeNamespace,
  capacity: number,
  label: string,
): string | null {
  if (!partition || typeof partition !== "object") return `retired range ${label} 分区非对象`;
  const candidate = partition as Partial<TreasuryRetiredRangePartition>;
  if (!Array.isArray(candidate.ranges)) return `retired range ${label} 分区 ranges 非数组`;
  if (candidate.ranges.length > capacity) {
    return `retired range ${label} 分区超过硬容量 ${String(capacity)}（实际 ${String(candidate.ranges.length)}）`;
  }
  let previousMax = -1;
  for (const range of candidate.ranges) {
    if (!range || typeof range !== "object") return `retired range ${label} 分区间隔非对象`;
    if (range.namespace !== expectedNamespace) {
      return `retired range ${label} 分区混入 ${String(range.namespace).slice(0, 16)} 域区间（分区隔离被破坏）`;
    }
    if (
      !Number.isSafeInteger(range.minSequence) ||
      !Number.isSafeInteger(range.maxSequence) ||
      range.minSequence < 1 ||
      range.maxSequence < range.minSequence
    ) {
      return `retired range ${label} 分区间隔非法（[${String(range?.minSequence)}, ${String(range?.maxSequence)}]）`;
    }
    if (!Number.isSafeInteger(range.mergedAtTick) || range.mergedAtTick < 0) {
      return `retired range ${label} 分区 mergedAtTick 非法`;
    }
    if (range.minSequence <= previousMax) {
      return `retired range ${label} 分区间隔必须严格递增且互不重叠（相邻可合并——重叠即损坏）`;
    }
    previousMax = range.maxSequence;
  }
  if (candidate.entryCount !== candidate.ranges.length) {
    return `retired range ${label} 分区 entryCount ${String(candidate.entryCount)} != ${String(candidate.ranges.length)}`;
  }
  return null;
}

function validateRangeStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "retired range store 非对象";
  const candidate = store as Partial<TreasuryRetiredRangeStore>;
  if (candidate.version !== TREASURY_RETIRED_RANGE_VERSION) {
    return `retired range store 版本非法: ${String(candidate.version).slice(0, 16)}（当前协议 v${String(TREASURY_RETIRED_RANGE_VERSION)}——v1/v2 经 load 迁移或 fail closed）`;
  }
  // legacyOverflow 语义：仅当 legacy 分区超额（> QUOTA）时合法在位；超额
  // 而未标记 / 标记而未超额均为形状错误（显式 forensic 状态不得含糊）。
  const legacyCount = Array.isArray((candidate.legacy as { ranges?: unknown[] })?.ranges) ? (candidate.legacy as { ranges: unknown[] }).ranges.length : -1;
  if (candidate.legacyOverflow === true && legacyCount <= TREASURY_RETIRED_RANGE_LEGACY_QUOTA) {
    return `retired range legacyOverflow 标记存在但 legacy 分区未超额（${String(legacyCount)} ≤ ${String(TREASURY_RETIRED_RANGE_LEGACY_QUOTA)}——显式状态与事实矛盾）`;
  }
  if (candidate.legacyOverflow !== true && legacyCount > TREASURY_RETIRED_RANGE_LEGACY_QUOTA) {
    return `retired range legacy 分区超额（${String(legacyCount)} > ${String(TREASURY_RETIRED_RANGE_LEGACY_QUOTA)}）但未标记 legacyOverflow（迁移不完整或损坏）`;
  }
  const currentError = validateRangePartitionShape(candidate.current, "current", TREASURY_RETIRED_RANGE_CURRENT_CAPACITY, "current");
  if (currentError !== null) return currentError;
  const legacyError = validateRangePartitionShape(candidate.legacy, "legacy", TREASURY_RETIRED_RANGE_LEGACY_CAPACITY, "legacy");
  if (legacyError !== null) return legacyError;
  if (!Number.isSafeInteger(candidate.updatedAt) || (candidate.updatedAt as number) < 0) {
    return "retired range store updatedAt 非法";
  }
  return null;
}

/**
 * 【X 工作流 D / N6】v1 裸 sequence 区间的发行域严格证明（只有能从版本边界
 * 证明时才迁移；不可证明 → fail closed，绝不静默猜测）：
 *  - issuer store 仍是 v1：ti2_ 命名空间尚未诞生 → 全部区间只能是 ti1_ →
 *    legacy（严格：ti2_ ID 的 mint 在 issuer v2 之后才存在）；
 *  - issuer v2 且无 legacy record：账号从 v2 起安装，从未有 ti1_ 发行 →
 *    全部区间只能是 ti2_ → current；
 *  - issuer v2 且有 legacy record：ti2_ absorb 最早只能发生在迁移时刻
 *    （migratedAtTick）之后；v1 store 的 updatedAt（最后写入时间）严格早于
 *    该时刻 → 全部区间都是 ti1_ → legacy（严格）；
 *  - updatedAt ≥ migratedAtTick：区间可能混合两域且区间合并后不可拆分 →
 *    indeterminate → fail closed（forensic，不静默猜测）。
 */
function proveLegacyRetiredRangeDomain(rangeUpdatedAtTick: number):
  | { readonly domain: TreasuryRetiredRangeNamespace; readonly detail: string }
  | { readonly domain: "indeterminate"; readonly detail: string } {
  const issuer = (Memory.runtime as unknown as {
    treasury?: {
      attemptIssuer?: {
        version?: unknown;
        highWatermark?: unknown;
        legacy?: { highWatermark?: unknown } | null;
        migratedAtTick?: unknown;
      };
    } | undefined;
  } | undefined)?.treasury?.attemptIssuer;
  if (issuer === undefined || typeof issuer !== "object") {
    return { domain: "indeterminate", detail: "issuer store 不在位——无法证明 v1 区间的发行域" };
  }
  if (issuer.version === 1) return { domain: "legacy", detail: "issuer 仍为 v1（ti2_ 命名空间未诞生——v1 区间全部属于 ti1_）" };
  if (issuer.version !== 2) {
    return { domain: "indeterminate", detail: `issuer store 版本未知（${String(issuer.version).slice(0, 8)}）——无法证明 v1 区间的发行域` };
  }
  if (issuer.legacy === undefined || issuer.legacy === null) {
    return { domain: "current", detail: "issuer v2 无 legacy record（从未有 ti1_ 发行——v1 区间全部属于 ti2_）" };
  }
  const migratedAtTick = issuer.migratedAtTick;
  const migratedAtTickNumber = typeof migratedAtTick === "number" && Number.isSafeInteger(migratedAtTick) ? migratedAtTick : null;
  if (migratedAtTickNumber !== null && rangeUpdatedAtTick < migratedAtTickNumber) {
    return { domain: "legacy", detail: `v1 区间最后写入（${String(rangeUpdatedAtTick)}）严格早于 issuer v2 迁移时刻（${String(migratedAtTickNumber)}）——ti2_ absorb 不可能发生，全部属于 ti1_` };
  }
  return {
    domain: "indeterminate",
    detail: `v1 区间写入横跨 issuer v2 迁移时刻（updatedAt ${String(rangeUpdatedAtTick)} ≥ migratedAtTick ${String(migratedAtTickNumber)}）——可能混合 ti1_/ti2_ 且区间合并后不可拆分，不可证明（fail closed，不静默猜测）`,
  };
}

/**
 * 【XI 工作流 E】v1 迁移源的完整形状校验（migration owner 前置——source 与
 * target 双侧校验；损坏源不迁移，fail closed 保留原数据）。
 */
export function validateLegacyRetiredRangeStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "v1 retired range store 非对象";
  const candidate = store as { version?: unknown; ranges?: unknown; entryCount?: unknown; updatedAt?: unknown };
  if (candidate.version !== 1) return `v1 retired range store 版本非法: ${String(candidate.version).slice(0, 8)}`;
  if (!Array.isArray(candidate.ranges)) return "v1 retired range store ranges 非数组";
  if ((candidate.ranges as unknown[]).length > TREASURY_RETIRED_RANGE_MAX_ENTRIES) {
    return `v1 retired range store 超过硬容量 ${String(TREASURY_RETIRED_RANGE_MAX_ENTRIES)}（实际 ${String((candidate.ranges as unknown[]).length)}）`;
  }
  for (const range of candidate.ranges as { minSequence?: unknown; maxSequence?: unknown; mergedAtTick?: unknown }[]) {
    if (!range || typeof range !== "object") return "v1 retired range 区间非对象";
    if (
      !Number.isSafeInteger(range.minSequence) ||
      !Number.isSafeInteger(range.maxSequence) ||
      (range.minSequence as number) < 1 ||
      (range.maxSequence as number) < (range.minSequence as number)
    ) {
      return `v1 retired range 区间非法（[${String(range?.minSequence)}, ${String(range?.maxSequence)}]）`;
    }
    if (!Number.isSafeInteger(range.mergedAtTick) || (range.mergedAtTick as number) < 0) {
      return "v1 retired range mergedAtTick 非法";
    }
  }
  if (!Number.isSafeInteger(candidate.updatedAt) || (candidate.updatedAt as number) < 0) {
    return "v1 retired range updatedAt 非法";
  }
  return null;
}

/**
 * 【X 工作流 D / N7 → XI 工作流 E → XII 工作流 E】v1/v2 → v3 迁移（单对象
 * 替换 + read-back；失败还原源）。【XI】迁移唯一 owner 是 lifecycle GC
 * coordinator 的 tick-boundary migration 阶段——query 与写路径（absorb）
 * 不再触发。【XII】v3 是物理分区布局：v1 经发行域证明归入单一分区；v2 按
 * namespace 标签分流（legacy 超额显式标记 legacyOverflow——保留不裁剪）。
 */
export function migrateLegacyRetiredRangeStore(raw: unknown): RangeRuntime {
  const rawVersion = (raw as { version?: unknown })?.version;
  if (rawVersion === 1) {
    const legacyStore = raw as { version: 1; ranges: { minSequence: number; maxSequence: number; mergedAtTick: number }[]; entryCount: number; updatedAt: number };
    const sourceShapeError = validateLegacyRetiredRangeStoreShape(raw);
    if (sourceShapeError !== null) {
      return { store: legacyStore as unknown as TreasuryRetiredRangeStore, fatal: `retired range v1 迁移源形状校验失败: ${sourceShapeError}（fail closed——原数据保留）` };
    }
    const domainProof = proveLegacyRetiredRangeDomain(legacyStore.updatedAt);
    if (domainProof.domain === "indeterminate") {
      return { store: legacyStore as unknown as TreasuryRetiredRangeStore, fatal: `retired range v1 store 发行域不可证明: ${domainProof.detail}（forensic fail closed——不得把它解释成两个 domain）` };
    }
    const migratedRanges = legacyStore.ranges.map((range) => ({ namespace: domainProof.domain, minSequence: range.minSequence, maxSequence: range.maxSequence, mergedAtTick: range.mergedAtTick }));
    const migrated = buildPartitionedRangeStore(
      domainProof.domain === "current" ? migratedRanges : [],
      domainProof.domain === "legacy" ? migratedRanges : [],
    );
    return commitRangeStoreMigration(raw, legacyStore as unknown as TreasuryRetiredRangeStore, migrated, "v1→v3");
  }
  if (rawVersion === 2) {
    const v2Store = raw as TreasuryRetiredRangeStoreV2;
    const sourceShapeError = validateLegacyV2RangeStoreShape(raw);
    if (sourceShapeError !== null) {
      return { store: v2Store as unknown as TreasuryRetiredRangeStore, fatal: `retired range v2 迁移源形状校验失败: ${sourceShapeError}（fail closed——原数据保留）` };
    }
    // 【XII / N5】v2 → v3 分区迁移：按 namespace 标签分流；写入 + read-back
    // + 失败还原；reset 幂等（v3 在位 → coordinator idle 零写）。
    const migrated = buildPartitionedRangeStore(
      v2Store.ranges.filter((range) => range.namespace === "current"),
      v2Store.ranges.filter((range) => range.namespace === "legacy"),
    );
    return commitRangeStoreMigration(raw, v2Store as unknown as TreasuryRetiredRangeStore, migrated, "v2→v3");
  }
  return { store: raw as TreasuryRetiredRangeStore, fatal: `retired range store 版本未知（${String(rawVersion).slice(0, 8)}——不迁移，fail closed）` };
}

/** v2 单数组源形状校验（迁移源专用——与 v2 时代的校验同构）。 */
function validateLegacyV2RangeStoreShape(raw: unknown): string | null {
  const candidate = raw as Partial<TreasuryRetiredRangeStoreV2>;
  if (!candidate || typeof candidate !== "object") return "v2 retired range store 非对象";
  if (candidate.version !== 2) return `v2 retired range store 版本非法: ${String(candidate.version).slice(0, 8)}`;
  if (!Array.isArray(candidate.ranges)) return "v2 retired range store ranges 非数组";
  if (candidate.ranges.length > 64) {
    return `v2 retired range store 超过旧协议硬容量 64（实际 ${String(candidate.ranges.length)}）`;
  }
  let previousNamespace: TreasuryRetiredRangeNamespace | null = null;
  let previousMax = -1;
  for (const range of candidate.ranges) {
    if (!range || typeof range !== "object") return "v2 retired range entry 非对象";
    if (range.namespace !== "legacy" && range.namespace !== "current") {
      return `v2 retired range 区间发行域非法: ${String(range.namespace).slice(0, 16)}`;
    }
    if (
      !Number.isSafeInteger(range.minSequence) ||
      !Number.isSafeInteger(range.maxSequence) ||
      range.minSequence < 1 ||
      range.maxSequence < range.minSequence
    ) {
      return `v2 retired range 区间非法（[${String(range?.minSequence)}, ${String(range?.maxSequence)}]）`;
    }
    if (!Number.isSafeInteger(range.mergedAtTick) || range.mergedAtTick < 0) return "v2 retired range mergedAtTick 非法";
    if (previousNamespace === range.namespace) {
      if (range.minSequence <= previousMax) return "v2 retired range 区间在同域内必须严格递增且互不重叠";
    } else if (previousNamespace !== null && range.namespace < previousNamespace) {
      return "v2 retired range 区间必须按发行域排序（current 在前、legacy 在后）";
    }
    previousNamespace = range.namespace;
    previousMax = range.maxSequence;
  }
  if (candidate.entryCount !== candidate.ranges.length) {
    return `v2 retired range store entryCount ${String(candidate.entryCount)} != ${String(candidate.ranges.length)}`;
  }
  return null;
}

/** 分区 store 构造（合并语义等价迁移；legacy 超额显式标记）。 */
function buildPartitionedRangeStore(
  currentRanges: readonly TreasuryRetiredSequenceRange[],
  legacyRanges: readonly TreasuryRetiredSequenceRange[],
): TreasuryRetiredRangeStore {
  return {
    version: TREASURY_RETIRED_RANGE_VERSION,
    current: { ranges: [...currentRanges], entryCount: currentRanges.length },
    legacy: { ranges: [...legacyRanges], entryCount: legacyRanges.length },
    ...(legacyRanges.length > TREASURY_RETIRED_RANGE_LEGACY_QUOTA ? { legacyOverflow: true } : {}),
    updatedAt: Game.time,
  };
}

/** 迁移提交（单对象替换 + read-back；失败还原源——v1/v2 共用）。 */
function commitRangeStoreMigration(
  rawSource: unknown,
  sourceAsStore: TreasuryRetiredRangeStore,
  migrated: TreasuryRetiredRangeStore,
  label: string,
): RangeRuntime {
  const branch = certificateBranch();
  const rollback = branch.retiredAttemptRanges;
  branch.retiredAttemptRanges = migrated;
  const readBack = branch.retiredAttemptRanges;
  const readBackError = validateRangeStoreShape(readBack);
  if (readBackError !== null) {
    branch.retiredAttemptRanges = rollback;
    return { store: sourceAsStore, fatal: `retired range ${label} 迁移 read-back 失败: ${readBackError}（已还原源 store，fail closed）` };
  }
  // 完整性：迁移后两分区区间总数 == 源区间数（不丢旧事实——N5）。
  const sourceCount = (rawSource as { ranges?: unknown[] }).ranges?.length ?? 0;
  const migratedCount = readBack.current.ranges.length + readBack.legacy.ranges.length;
  if (migratedCount !== sourceCount) {
    branch.retiredAttemptRanges = rollback;
    return { store: sourceAsStore, fatal: `retired range ${label} 迁移区间数不一致（源 ${String(sourceCount)} → 分区 ${String(migratedCount)}——已还原源 store，fail closed）` };
  }
  return { store: readBack, fatal: null };
}

function loadRangeRuntime(): RangeRuntime {
  if (heapRangeRuntime !== null) return heapRangeRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) {
    const store: TreasuryRetiredRangeStore = {
      version: TREASURY_RETIRED_RANGE_VERSION,
      current: { ranges: [], entryCount: 0 },
      legacy: { ranges: [], entryCount: 0 },
      updatedAt: Game.time,
    };
    certificateBranch().retiredAttemptRanges = store;
    heapRangeRuntime = { store, fatal: null };
    return heapRangeRuntime;
  }
  const rawVersion = (raw as { version?: unknown }).version;
  if (rawVersion === 1 || rawVersion === 2) {
    // 【XI 工作流 E → XII 工作流 E】v1/v2 store 不再由 load 触发迁移——迁移
    // 唯一 owner 是 lifecycle GC coordinator 的 tick-boundary migration 阶段
    //（query 零写）；写路径（absorb）同样 fail closed（迁移完成前不吸收）。
    heapRangeRuntime = {
      store: raw as unknown as TreasuryRetiredRangeStore,
      fatal: `retired range store 为 v${String(rawVersion)}（待显式迁移——迁移由 lifecycle GC coordinator 的 tick-boundary migration owner 执行；query 零写，写路径 fail closed）`,
    };
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
  // 【XI 工作流 E / M1】query 零写：不触发 load/迁移/空店初始化。
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return { healthy: true, detail: null };
  const rawVersion = (raw as { version?: unknown }).version;
  if (rawVersion === 1 || rawVersion === 2) {
    // v1/v2 待显式迁移（migration owner 在 tick 边界执行）——probe 视角
    // fail closed（不把 migration_required 折叠为健康/空）。
    return {
      healthy: false,
      detail: `retired range store 为 v${String(rawVersion)}（待 tick-boundary migration owner 显式迁移——query 零写，迁移前 fail closed）`,
    };
  }
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
 * 【Remediation VIII 工作流 C】root ID 的 chain 证书 outcome 查询：
 *  - finalGeneration = 0（root-only chain）：terminalState 直接映射
 *    （chain_committed → root committed；non_rearmable_retired → root
 *    not-executed）；
 *  - finalGeneration ≥ 1（root 被 rearm 替代）：root 一律 not-executed
 *    ——无论 terminalState（chain_committed 的 committed 属于 final 代，
 *    不属于 root——错误映射会破坏 outcome 绑定语义）。
 * 返回的 verdict 携带 proofClass 标记：certificate 是协议推导（identity
 * 不足以构成 exact proof——destructive 路径不得据此 relabel）。
 */
export function lookupTreasuryChainRetirementRootOutcome(
  rootTransactionId: string,
): TreasuryChainGenerationOutcome {
  const runtime = loadCertificateRuntime();
  if (runtime.fatal !== null) {
    return { verdict: "store_unhealthy", detail: `chain certificate store fail-closed: ${runtime.fatal}` };
  }
  const certificate = runtime.store.entries[CERTIFICATE_KEY_PREFIX + rootTransactionId];
  if (certificate === undefined) return { verdict: "absent" };
  const shapeError = validateCertificateShape(certificate, CERTIFICATE_KEY_PREFIX + rootTransactionId);
  if (shapeError !== null) {
    return { verdict: "store_unhealthy", detail: `chain certificate 损坏: ${shapeError}` };
  }
  if (certificate.finalGeneration === 0) {
    const outcome = certificate.terminalState === "chain_committed" ? "committed" : "not-executed";
    return {
      verdict: "match",
      outcome,
      certificate,
      detail: `chain certificate root-only（finalGeneration=0）终态 ${certificate.terminalState}——root ${outcome}`,
    };
  }
  return {
    verdict: "match",
    outcome: "not-executed",
    certificate,
    detail: `chain certificate finalGeneration=${String(certificate.finalGeneration)}——root 已被 rearm 替代，协议确定 not-executed（committed 属于 final 代）`,
  };
}

/**
 * generation-addressable tr1_ child ID 的 chain 内代查询（O(1)：ID 自带
 * (lineageId, generation)）：
 * - 【Remediation VIII 工作流 C】checksum 验证：用 certificate 的
 *   rootTransactionId 重算 child checksum——不一致（伪造/篡改）不 match
 *   （absent——不获得任何权威事实；该 ID 的重放由 tr1_ capability 门禁
 *   阻断，不依赖本查询）；
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
  // 【VIII C3】checksum 必须与 certificate 的 rootTransactionId 确定性派生
  // 一致——改一位即不属于该 chain（不 match）。
  const expectedChecksum = treasuryRearmChildIdChecksumOf({
    lineageId: certificate.lineageId,
    generation: parsed.generation,
    rootTransactionId: certificate.rootTransactionId,
  });
  if (transactionId.slice(transactionId.length - 8) !== expectedChecksum) {
    return { verdict: "absent" };
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

/**
 * ti_ ID 的 retired range 判定（区间扫描 ≤64 有界；同域严格递增）。
 * 【X 工作流 D】按 ID 自带发行域（ti1_=legacy / ti2_=current）匹配区间——
 * 相同序号在两个域是独立事实（N3：ti1_7 retired 不影响 ti2_7 active）。
 */
export function checkTreasuryAttemptRetiredRange(
  transactionId: string,
): { readonly retired: boolean; readonly detail: string } {
  // 【XI 工作流 E / M1-M2】query 零写：直读 Memory（store 不存在 = 健康空，
  // 不初始化；v1/v2 = migration_required → 保守 retired 阻断，不折叠为
  // ordinary absent）。【XII 工作流 E】v3 分区直读（按 ID 自带发行域选分区）。
  const parsed = parseTreasuryIssuedInitialAttemptId(transactionId);
  if (parsed === null) return { retired: false, detail: "" };
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return { retired: false, detail: "" };
  const rawVersion = (raw as { version?: unknown }).version;
  if (rawVersion === 1 || rawVersion === 2) {
    return {
      retired: true,
      detail: `retired range store 为 v${String(rawVersion)}（migration_required——迁移完成前按已退休阻断，fail closed）`,
    };
  }
  const shapeError = validateRangeStoreShape(raw);
  if (shapeError !== null) {
    // store 损坏不得折叠为"未退休"——按 retired 阻断（fail closed）。
    return { retired: true, detail: `retired range store 损坏（fail closed）: ${shapeError}` };
  }
  const partition = parsed.namespace === "current" ? (raw as TreasuryRetiredRangeStore).current : (raw as TreasuryRetiredRangeStore).legacy;
  for (const range of partition.ranges) {
    if (parsed.sequence >= range.minSequence && parsed.sequence <= range.maxSequence) {
      return { retired: true, detail: `[${range.namespace} ${String(range.minSequence)}, ${String(range.maxSequence)}]` };
    }
  }
  return { retired: false, detail: "" };
}

/**
 * 【IX 工作流 C / 6.1】retired range 的结构化查询（destructive eviction/
 * compaction 调用方专用——不得使用把 store unhealthy 折叠为 retired=true 的
 * checkTreasuryAttemptRetiredRange）。四态：
 *  - present：序号在退休区间内（anti-reuse frontier 已接管）；
 *  - absent：序号未退休（且 store 容器/条目均健康）；
 *  - store_unhealthy：容器级损坏（版本/形状/entryCount）；
 *  - malformed：区间数据级损坏（单条区间 shape / 严格递增被破坏）。
 */
export type TreasuryRetiredRangeStructuredLookup =
  | { readonly status: "present"; readonly detail: string }
  | { readonly status: "absent" }
  | { readonly status: "store_unhealthy"; readonly detail: string }
  | { readonly status: "malformed"; readonly detail: string }
  /** 【XI 工作流 E】v1 store 在位且未迁移（query 零写——只报告所需状态，不折叠为 absent）。 */
  | { readonly status: "migration_required"; readonly detail: string };

/** 容器级校验（版本/分区/entryCount——条目级问题归 malformed）。 */
function validateRangeContainerShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "retired range store 非对象";
  const candidate = store as Partial<TreasuryRetiredRangeStore>;
  if (candidate.version !== TREASURY_RETIRED_RANGE_VERSION) {
    return `retired range store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.current || !Array.isArray(candidate.current.ranges)) return "retired range current 分区缺失/非数组";
  if (!candidate.legacy || !Array.isArray(candidate.legacy.ranges)) return "retired range legacy 分区缺失/非数组";
  if (candidate.current.entryCount !== candidate.current.ranges.length) {
    return `retired range current 分区 entryCount ${String(candidate.current.entryCount)} != ${String(candidate.current.ranges.length)}`;
  }
  if (candidate.legacy.entryCount !== candidate.legacy.ranges.length) {
    return `retired range legacy 分区 entryCount ${String(candidate.legacy.entryCount)} != ${String(candidate.legacy.ranges.length)}`;
  }
  return null;
}

/** 条目级校验（分区条目 shape 与域内严格递增——malformed 分类）。 */
function validateRangeEntriesShape(store: TreasuryRetiredRangeStore): string | null {
  for (const [partition, namespace] of [
    [store.current, "current"],
    [store.legacy, "legacy"],
  ] as const) {
    let previousMax = -1;
    for (const range of partition.ranges) {
      if (!range || typeof range !== "object") return `retired range ${namespace} 分区间隔非对象`;
      if (range.namespace !== namespace) {
        return `retired range ${namespace} 分区混入 ${String(range.namespace).slice(0, 16)} 域区间（分区隔离被破坏）`;
      }
      if (
        !Number.isSafeInteger(range.minSequence) ||
        !Number.isSafeInteger(range.maxSequence) ||
        range.minSequence < 1 ||
        range.maxSequence < range.minSequence
      ) {
        return `retired range ${namespace} 分区间隔非法（[${String(range?.minSequence)}, ${String(range?.maxSequence)}]）`;
      }
      if (!Number.isSafeInteger(range.mergedAtTick) || range.mergedAtTick < 0) {
        return `retired range ${namespace} 分区 mergedAtTick 非法`;
      }
      if (range.minSequence <= previousMax) {
        return `retired range ${namespace} 分区间隔必须严格递增且互不重叠（相邻可合并——重叠即损坏）`;
      }
      previousMax = range.maxSequence;
    }
  }
  return null;
}

/** 【IX 工作流 C / 6.1】结构化 retired range 查询（eviction 专用四态）。 */
export function lookupTreasuryRetiredRangeStructured(transactionId: string): TreasuryRetiredRangeStructuredLookup {
  // 【XI 工作流 E / M1】query 零写：v1/v2 只报告 migration_required（迁移由
  // tick-boundary migration owner 执行），不触发 load/迁移/空店初始化。
  const parsed = parseTreasuryIssuedInitialAttemptId(transactionId);
  if (parsed === null) return { status: "absent" };
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return { status: "absent" };
  const rawVersion = (raw as { version?: unknown }).version;
  if (rawVersion === 1 || rawVersion === 2) {
    return {
      status: "migration_required",
      detail: `v${String(rawVersion)} 单数组 store（发行域分区未完成——迁移由 lifecycle GC coordinator 的 tick-boundary migration owner 执行；query 零写）`,
    };
  }
  return lookupRetiredRangeStructuredInStore(raw, parsed);
}

/** v3 store 内的按域分区查询（迁移后 store 与直读 store 共用）。 */
function lookupRetiredRangeStructuredInStore(
  store: TreasuryRetiredRangeStore,
  parsed: { readonly sequence: number; readonly namespace: "legacy" | "current" } | null,
): TreasuryRetiredRangeStructuredLookup {
  if (parsed === null) return { status: "absent" };
  const containerError = validateRangeContainerShape(store);
  if (containerError !== null) return { status: "store_unhealthy", detail: containerError };
  const entryError = validateRangeEntriesShape(store);
  if (entryError !== null) return { status: "malformed", detail: entryError };
  const partition = parsed.namespace === "current" ? store.current : store.legacy;
  for (const range of partition.ranges) {
    if (parsed.sequence >= range.minSequence && parsed.sequence <= range.maxSequence) {
      return { status: "present", detail: `[${range.namespace} ${String(range.minSequence)}, ${String(range.maxSequence)}]` };
    }
  }
  return { status: "absent" };
}

// ──【IX 工作流 C】retirement summary 的 assembly probe（certificate 驱逐前
//    验证"无 matching summary 在位"——summary 以 certificate 为 replacement
//    authority 时不撤走 replacement。注册方：lineageRetirementSummary 模块
//    加载时（本模块在其 import 下游——直接 import 成环）。未装配 → 视为
//    summary 可能在位（fail closed 不驱逐）。
interface TreasuryRetirementSummaryProbe {
  readonly summaryOfRoot: (rootTransactionId: string) => { readonly lineageId?: unknown } | undefined;
  readonly summaryStoreHealthy: () => boolean;
}

let retirementSummaryProbe: TreasuryRetirementSummaryProbe | null = null;

export function registerTreasuryRetirementSummaryProbeForAssembly(probe: TreasuryRetirementSummaryProbe): void {
  retirementSummaryProbe = probe;
}

// ── 写入（compaction 接线调用——state-changing）────────────────────────────

/**
 * 吸收一个已退休发行序号进 retired range（同一发行域内相邻单调合并；写入 +
 * read-back）。【X 工作流 D】必须携带 issuer domain（架构守护：裸 sequence
 * 不再是合法的 destructive 入参——ti1_ 与 ti2_ 的同序号是两个域的独立
 * 事实）。区间满载且无相邻可合 → rejected（fail closed——不合并不相邻
 * 区间，绝不把未退休序号误判为 retired）。
 */
export function absorbTreasuryRetiredSequence(
  namespace: TreasuryRetiredRangeNamespace,
  sequence: number,
): { readonly status: "absorbed" | "idempotent" } | { readonly status: "rejected"; readonly detail: string } {
  if (namespace !== "legacy" && namespace !== "current") {
    return { status: "rejected", detail: `退休序号发行域非法: ${String(namespace).slice(0, 16)}` };
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return { status: "rejected", detail: `退休序号非法: ${String(sequence)}` };
  }
  const runtime = loadRangeRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: `retired range store fail-closed: ${runtime.fatal}` };
  }
  const partition = namespace === "current" ? runtime.store.current : runtime.store.legacy;
  for (const range of partition.ranges) {
    if (sequence >= range.minSequence && sequence <= range.maxSequence) {
      return { status: "idempotent" };
    }
  }
  // 【VIII 工作流 E2/L3】区间满载时先做孤儿 gap coalesce：把"已发行但
  // 从未进入 lifecycle"的洞显式 abandon 吸收进 retired range（mint 不产生
  // 无界永久洞——E2.8），桥接相邻区间腾出槽位；无法收敛 → rejected
  // （fail closed——绝不把在飞/有权威序号误判 retired）。
  // 【X 工作流 D / N5】coalesce 只处理 current 域的 gap（legacy 域缺少
  // canonical ID reconstruction——ti1_ gap 不可用当前 watermark 猜测放弃）。
  // 【XI 工作流 F → XII 工作流 E / Q 组】触发条件含域配额：v3 分区下目标
  // 分区已达硬上限 → current 分区先 coalesce 收敛；legacy 分区直接 fail
  // closed（legacyOverflow 的迁移存量保留不裁剪——只阻断新增区间吸收，
  // current 分区不受影响，N2-N4）。
  const namespaceCapacity = namespace === "current" ? TREASURY_RETIRED_RANGE_CURRENT_CAPACITY : TREASURY_RETIRED_RANGE_LEGACY_QUOTA;
  const namespaceCountBefore = partition.ranges.length;
  const projectedTotal = runtime.store.current.ranges.length + runtime.store.legacy.ranges.length;
  const totalOverflow = projectedTotal + 1 > TREASURY_RETIRED_RANGE_MAX_ENTRIES;
  // 相邻可合并不新增区间数（core 的精确终检以 coalesced 结果为准——此处
  // 只决定是否尝试 coalesce 收敛）。
  const mergeableIntoExisting = partition.ranges.some(
    (range) => sequence === range.minSequence - 1 || sequence === range.maxSequence + 1,
  );
  const namespaceOverflow = !mergeableIntoExisting && namespaceCountBefore + 1 > namespaceCapacity;
  if (totalOverflow || namespaceOverflow) {
    if (namespaceOverflow && namespace !== "current") {
      return {
        status: "rejected",
        detail: `retired range ${namespace} 分区已达容量 ${String(namespaceCapacity)}（新增区间后 ${String(namespaceCountBefore + 1)}${runtime.store.legacyOverflow === true ? "（legacyOverflow 迁移存量在位）" : ""}——超额存量保留不裁剪，两分区互不驱逐，fail closed）`,
      };
    }
    const coalesced = coalesceOrphanGapUnderPressure();
    if (!coalesced.coalesced) {
      return {
        status: "rejected",
        detail: `retired range 分区已达容量（current ${String(runtime.store.current.ranges.length)}/${String(TREASURY_RETIRED_RANGE_CURRENT_CAPACITY)}、legacy ${String(runtime.store.legacy.ranges.length)}/${String(TREASURY_RETIRED_RANGE_LEGACY_CAPACITY)}）且无孤儿 gap 可收敛（${coalesced.detail}——不吸收不相邻序号，fail closed）`,
      };
    }
  }
  return absorbSequenceUnchecked(namespace, sequence);
}

/**
 * gap 中序号的 lifecycle 权威覆盖检查（只读——任一在位即不可 abandon）。
 * 【IX 工作流 E 8.3】不再手工拼部分 store 列表：先查本模块自有的
 * certificate / retired range 维度，其余完整生命周期权威（issued ticket /
 * admission reservation / headroom reservation / intent / quarantine /
 * journal / resolution / fault / marker / lineage / completion / historical /
 * receipt / GRA / summary——O1-O5）统一经 treasuryLifecycleOwnerResolver
 * 判定（任一相关 store unhealthy → 视为有权威，fail closed）。
 */
function sequenceHasLifecycleAuthority(sequence: number): boolean {
  // 【X 工作流 D / N5】coalesce 是 current(ti2_) 域专属：authority 探测构建
  // ti2_ canonical ID（legacy 域缺少 canonical reconstruction——ti1_ gap 不
  // 参与 abandon 判定，见 coalesceOrphanGapUnderPressure 的 current-only 过滤）。
  // 【XI 工作流 E】探测零写：纯构建（不经 issuer load——不初始化空店/不触发
  // v1 迁移），certificate 维度 Memory 直读（store 不存在 = 无 certificate
  // 事实，不初始化）。
  const transactionId = buildTreasuryCurrentIssuedIdUnchecked(sequence);
  if (transactionId === null) return true; // 不可重建 → 保守视为有权威
  // 本模块自有维度：root 已有 chain certificate / 序号已进 retired range
  //（health-complete：certificate/range 读数不可信时视为有权威，不折叠为
  // absent——X 工作流 E / H 组加固）。
  const certificateRaw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.chainRetirementCertificates;
  if (certificateRaw !== undefined) {
    const certificateShapeError = validateCertificateStoreShape(certificateRaw);
    if (certificateShapeError !== null) return true;
    if (certificateRaw.entries[CERTIFICATE_KEY_PREFIX + transactionId] !== undefined) return true;
  }
  const rangeLookup = lookupTreasuryRetiredRangeStructured(transactionId);
  if (rangeLookup.status !== "absent") return true; // present / store_unhealthy / malformed / migration_required 均阻断
  const ownership = resolveTreasuryAttemptLifecycleOwnership(transactionId);
  if (ownership.status === "owned") return true; // active 与 terminal-authority 均阻断 abandon
  return false;
}

/** 单个区间间隙的长度上限（coalesce 扫描有界）。 */
const ORPHAN_GAP_MAX_WIDTH = 512;
/** 最近发行的安全窗口（在途 attempt 保护——mint 后短窗口内不 abandon）。 */
const ORPHAN_GAP_RECENT_WINDOW = 32;

/**
 * 满载压力下的孤儿 gap 收敛：找一个"全部序号均为孤儿"的小区间间隙，
 * 逐个 abandon（吸收进 retired range）——桥接两侧区间，区间数下降。
 * 未完成/未退休序号（任何 lifecycle 权威在位 / 超安全窗口的最近发行 /
 * 未发行）一律不动（E2.7）。
 */
function coalesceOrphanGapUnderPressure(): { readonly coalesced: boolean; readonly detail: string } {
  const runtime = loadRangeRuntime();
  if (runtime.fatal !== null) return { coalesced: false, detail: `range store fail-closed: ${runtime.fatal}` };
  // 【X 工作流 D / N5 → XII 工作流 E】namespace-local：只处理 current(ti2_)
  // 分区的区间间隙。legacy 分区的 gap 永不 coalesce——ti1_ canonical ID
  // 不可重建，无法逐序号证明 lifecycle 权威缺失。
  const ranges = runtime.store.current.ranges;
  if (ranges.length < 2) return { coalesced: false, detail: "current 分区区间数不足（无间隙可桥接；legacy gap 不参与 coalesce）" };
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0) return { coalesced: false, detail: "issuer watermark 不可读（fail closed）" };
  for (let index = 1; index < ranges.length; index += 1) {
    const gapMin = ranges[index - 1]!.maxSequence + 1;
    const gapMax = ranges[index]!.minSequence - 1;
    if (gapMax < gapMin) continue;
    if (gapMax - gapMin >= ORPHAN_GAP_MAX_WIDTH) continue;
    let allOrphan = true;
    for (let sequence = gapMin; sequence <= gapMax; sequence += 1) {
      if (sequence > watermark || watermark - sequence < ORPHAN_GAP_RECENT_WINDOW) {
        allOrphan = false;
        break;
      }
      if (sequenceHasLifecycleAuthority(sequence)) {
        allOrphan = false;
        break;
      }
    }
    if (!allOrphan) continue;
    for (let sequence = gapMin; sequence <= gapMax; sequence += 1) {
      const absorbed = absorbSequenceUnchecked("current", sequence);
      if (absorbed.status === "rejected") {
        return { coalesced: false, detail: `孤儿 gap 吸收中断（seq ${String(sequence)}）: ${absorbed.detail}` };
      }
    }
    return { coalesced: true, detail: `current 分区孤儿 gap [${String(gapMin)}, ${String(gapMax)}] 已 abandon 收敛` };
  }
  return { coalesced: false, detail: "无可收敛的孤儿 gap（全部间隙含在飞/有权威/近期发行序号；legacy gap 不处理）" };
}

/** 【XII 工作流 E】分区内的吸收合并核心（同域 min-1/max+1 相邻合并 + 二次桥接）。 */
function mergePartitionRanges(
  namespace: TreasuryRetiredRangeNamespace,
  sequence: number,
  ranges: readonly TreasuryRetiredSequenceRange[],
): TreasuryRetiredSequenceRange[] {
  const nextRanges: TreasuryRetiredSequenceRange[] = ranges.map((range) => ({ ...range }));
  let merged = false;
  for (let index = 0; index < nextRanges.length; index += 1) {
    const range = nextRanges[index]!;
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
    nextRanges.push({ namespace, minSequence: sequence, maxSequence: sequence, mergedAtTick: Game.time });
    nextRanges.sort(compareRetiredRanges);
  }
  const coalesced: TreasuryRetiredSequenceRange[] = [];
  for (const range of nextRanges) {
    const last = coalesced[coalesced.length - 1];
    if (last !== undefined && range.minSequence <= last.maxSequence + 1) {
      coalesced[coalesced.length - 1] = {
        namespace,
        minSequence: last.minSequence,
        maxSequence: Math.max(last.maxSequence, range.maxSequence),
        mergedAtTick: Game.time,
      };
    } else {
      coalesced.push({ ...range });
    }
  }
  return coalesced;
}

/** 区间写入核心（分区吸收 + 相邻合并 + read-back——不做满载 coalesce，供 absorb 与 coalesce 共用）。 */
function absorbSequenceUnchecked(
  namespace: TreasuryRetiredRangeNamespace,
  sequence: number,
): { readonly status: "absorbed" | "idempotent" } | { readonly status: "rejected"; readonly detail: string } {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return { status: "rejected", detail: `退休序号非法: ${String(sequence)}` };
  }
  const runtime = loadRangeRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", detail: `retired range store fail-closed: ${runtime.fatal}` };
  }
  const partition = namespace === "current" ? runtime.store.current : runtime.store.legacy;
  for (const range of partition.ranges) {
    if (sequence >= range.minSequence && sequence <= range.maxSequence) {
      return { status: "idempotent" };
    }
  }
  const coalesced = mergePartitionRanges(namespace, sequence, partition.ranges);
  // 【XII 工作流 E / Q 组】分区硬上限终检（写入前的权威强制——入口的
  // coalesce 触发只是收敛尝试）：本次吸收新增区间数时——legacyOverflow
  // 显式 forensic 状态下 legacy 新增一律拒绝（超额存量保留、不裁剪、
  // 不再增长）；超过本分区容量 → 拒绝（不删除其它分区事实腾槽；current
  // 分区保留容量不被 legacy 占用，N1-N4）。
  const capacity = namespace === "current"
    ? TREASURY_RETIRED_RANGE_CURRENT_CAPACITY
    : runtime.store.legacyOverflow === true
      ? TREASURY_RETIRED_RANGE_LEGACY_CAPACITY
      : TREASURY_RETIRED_RANGE_LEGACY_QUOTA;
  const addsRangeCount = coalesced.length > partition.ranges.length;
  if (addsRangeCount && namespace === "legacy" && runtime.store.legacyOverflow === true) {
    return {
      status: "rejected",
      detail: `retired range legacy 分区处于 legacyOverflow 显式 forensic 状态（${String(partition.ranges.length)} > ${String(TREASURY_RETIRED_RANGE_LEGACY_QUOTA)} 迁移存量）——新增区间一律 fail closed（存量保留不裁剪，current 分区不受影响）`,
    };
  }
  if (addsRangeCount && coalesced.length > capacity) {
    return {
      status: "rejected",
      detail: `retired range ${namespace} 分区已达容量 ${String(capacity)}（吸收后 ${String(coalesced.length)}——不删除其它分区事实腾槽，fail closed）`,
    };
  }
  const previousRanges = JSON.stringify(partition.ranges);
  partition.ranges = coalesced;
  partition.entryCount = coalesced.length;
  runtime.store.updatedAt = Game.time;
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  const shapeError = rawStore === undefined ? "retired range store 缺失" : validateRangeStoreShape(rawStore);
  if (shapeError !== null) {
    partition.ranges = JSON.parse(previousRanges) as TreasuryRetiredSequenceRange[];
    partition.entryCount = partition.ranges.length;
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
    // 【IX 工作流 C / 6.3】certificate 满载驱逐——有界 eligible 扫描（全部
    // 现代条目按 rootSequence 升序，不只最老一条；Q8：队首不可清理不永久
    // 停机）。eligibility（全部满足才驱逐）：
    //  1. retired range 结构化查询不返回 store_unhealthy/malformed（Q1——
    //     range 损坏时绝不当作 replacement 在位）；
    //  2. root 序号已被 range 吸收（absent 时先 absorb——monotonic 安全：
    //     chain 已终结、序号已消耗；absorb 失败换下一条）；
    //  3. 无 matching retirement summary 在位（summary 以 certificate 为
    //     replacement authority——probe 未装配/store unhealthy 视为在位，
    //     fail closed）。
    // legacy pin（rootSequence=-1）永不驱逐。
    const modern = Object.entries(runtime.store.entries)
      .filter(([, certificate]) => certificate.rootSequence >= 1)
      .sort((left, right) => left[1].rootSequence - right[1].rootSequence);
    let evictedKey: string | null = null;
    let evictedCertificate: TreasuryChainRetirementCertificate | undefined;
    for (const [candidateKey, certificate] of modern) {
      // 【XI 工作流 C】驱逐候选的防御性 canonical 复验（load 后篡改拦截）：
      // current root 不 canonical → 跳过（不吸收该 rootSequence、不删除该
      // certificate——fail closed）。
      const parsedCandidateRoot = parseTreasuryIssuedInitialAttemptId(certificate.rootTransactionId);
      if (
        parsedCandidateRoot !== null &&
        parsedCandidateRoot.namespace === "current" &&
        "reason" in verifyTreasuryCurrentIssuedIdCanonical(certificate.rootTransactionId, certificate.rootSequence)
      ) {
        continue;
      }
      const rangeLookup = lookupTreasuryRetiredRangeStructured(certificate.rootTransactionId);
      if (rangeLookup.status === "store_unhealthy" || rangeLookup.status === "malformed") continue;
      if (rangeLookup.status === "absent") {
        // 【X 工作流 D】吸收域取自 root ID 自带 namespace（ti1_ root 进
        // legacy 域、ti2_ root 进 current 域——同 root 的 retired 事实不
        // 跨域解释，N4/N9）。
        const parsedEvictRoot = parseTreasuryIssuedInitialAttemptId(certificate.rootTransactionId);
        if (parsedEvictRoot === null) continue;
        const absorbed = absorbTreasuryRetiredSequence(parsedEvictRoot.namespace, certificate.rootSequence);
        if (absorbed.status === "rejected") continue;
      }
      if (retirementSummaryProbe === null) break; // fail closed——不驱逐任何条目
      if (!retirementSummaryProbe.summaryStoreHealthy()) break;
      if (retirementSummaryProbe.summaryOfRoot(certificate.rootTransactionId) !== undefined) continue;
      evictedKey = candidateKey;
      evictedCertificate = certificate;
      break;
    }
    if (evictedKey === null || evictedCertificate === undefined) {
      return {
        status: "rejected",
        detail: `chain certificate 已达硬容量 ${String(TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES)} 且无 eligible 条目（range replacement 不在位/损坏或 summary 仍依赖——不删除旧权威，fail closed）`,
      };
    }
    const oldestKey = evictedKey;
    const evicted = evictedCertificate;
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
  // 【XII 工作流 D / Q1】全部校验通过、即将真实写入——先发布 heap 空视图
  // （absent 首写时创建 store；此前的拒绝路径全部零写，I6）。
  ensureCertificateStorePublished();
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
    // 【X 工作流 D / N9】吸收域取自 root ID 自带 namespace（ti1_ 与 ti2_
    // 分别进入匹配域的 anti-reuse authority——同序号不交叉污染）。
    const absorbed = absorbTreasuryRetiredSequence(parsed.namespace, parsed.sequence);
    if (absorbed.status === "rejected") continue;
    if (retireTreasuryHistoricalRecordForCompression(record.transactionId, () => rangeAbsorbsSequence(parsed.namespace, parsed.sequence))) {
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

function rangeAbsorbsSequence(namespace: "legacy" | "current", sequence: number): boolean {
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  // 【XII 工作流 E】v3 分区直读（v1/v2 未迁移 → false——迁移完成前不构成
  // 本域 retirement 证明，fail closed 语义由调用方 health 前置承载）。
  if (rawStore === undefined || (rawStore as { version?: unknown }).version !== TREASURY_RETIRED_RANGE_VERSION) return false;
  const partition = namespace === "current" ? rawStore.current : rawStore.legacy;
  if (partition === undefined || !Array.isArray(partition.ranges)) return false;
  return partition.ranges.some(
    (range) => sequence >= range.minSequence && sequence <= range.maxSequence,
  );
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
  // 【XII 工作流 E】v3 分区计数（两分区之和；v1/v2 未迁移 → -1 fail closed）。
  if ((raw as { version?: unknown }).version !== TREASURY_RETIRED_RANGE_VERSION) return -1;
  return raw.current.ranges.length + raw.legacy.ranges.length;
}

/**
 * 【XII 工作流 E / N8】分区容量只读视图（current/legacy 各自区间数与硬
 * 上限——evidence 与 N 组容量断言共用；v1/v2 未迁移 → null）。
 */
export function peekTreasuryRetiredRangePartitionCounts(): {
  readonly current: number;
  readonly legacy: number;
  readonly legacyOverflow: boolean;
} | null {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithCertificates | undefined)?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return { current: 0, legacy: 0, legacyOverflow: false };
  if ((raw as { version?: unknown }).version !== TREASURY_RETIRED_RANGE_VERSION) return null;
  return {
    current: raw.current.ranges.length,
    legacy: raw.legacy.ranges.length,
    legacyOverflow: raw.legacyOverflow === true,
  };
}
