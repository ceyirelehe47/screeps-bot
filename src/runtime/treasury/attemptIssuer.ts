/**
 * 【Round 22 Remediation IX 工作流 A】versioned issuance migration——
 * service-issued initial attempt ID authority。
 *
 * Remediation VIII 把协议 hash 升到 v2（只依赖 sequence），但持久 issuer
 * store 仍为 version=1 + ti1_ 命名空间：旧 Memory 的 watermark=100 会被新
 * 协议重算解释为"ti1_1..ti1_100 的新协议完整 ID 全部已合法发行"——产生
 * ghost issued ID（从未被旧代码签发的新格式完整 ID 可进入 production
 * callback）。
 *
 * 本轮建立不可混淆的持久版本边界：
 *
 * - 新 production initial ID 命名空间 `ti2_`（store version=2，协议 tag v3，
 *   hash 仍只依赖 sequence——每个已发行 sequence 恰好一个可验证完整 ID）；
 * - 旧 `ti1_` 一律视为 legacy issued namespace：`check` 判
 *   `legacy_unverified`（旧命名空间不属于当前发行协议），production
 *   contract writer 拒绝其作为新 initial attempt 执行；既有 Receipt /
 *   Tombstone / completion / lineage / retired range 权威中的旧 ti1_ 继续
 *   阻止同 ID 重放（issuer 判定不丢失 blocker）；
 * - v1 → v2 迁移：旧 store 的 watermark **不带入**新命名空间（ti2_ 序列从
 *   0 独立推进），但作为 forensic/anti-reuse 事实保留（`legacy` 子对象——
 *   证明旧序列区间已消耗，不允许清空旧 Memory 完成升级）；迁移是单对象
 *   整体替换 + read-back，global reset 后重读幂等（version=2 即完成，无
 *   第二个 issuer frontier）；
 * - 未知版本 / shape 损坏 → fail closed（不签发、不构建、不验证放行）；
 * - production issuance 不制造裸洞：mint 仅供受控 opening
 *   （attemptIssuanceTicket.openTreasuryIssuedInitialAttempt——watermark 推进
 *   与持久 issued ticket 同一操作），production 调用方不直接 mint。
 */

// 【模块环规避】issuer 不直接依赖 receipts 的 reset hook（receipts →
// actionContracts → attemptIssuer → receipts 成环）；heap 失效由
// chainRetirementCertificate 的清理 hook 一并承载（同链加载）。
import { hashTreasuryCanonicalString, isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";

/** 新 store 版本（v1 → v2 的持久版本边界——不可混淆）。 */
export const TREASURY_ATTEMPT_ISSUER_VERSION = 2;
/** 当前 production initial ID 命名空间前缀（与 ts1_/tt1_/tr1_ 不可重叠）。 */
export const TREASURY_ISSUED_ID_PREFIX = "ti2_";
/** 旧命名空间前缀（legacy issued namespace——不再是当前发行协议）。 */
export const TREASURY_LEGACY_ISSUED_ID_PREFIX = "ti1_";
/** 旧 store 版本（迁移源——仅识别，不再作为当前格式解释）。 */
export const TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION = 1;
/**
 * 签发协议标签。v3：ti2_ 命名空间（v2 的 ti1_ hash 与 v1 watermark 语义
 * 均不延续——新命名空间内 hash 仍只依赖 sequence）。
 */
const ISSUER_PROTOCOL_TAG = "treasury-attempt-issuer@v3";

const ISSUED_ID_PATTERN = /^ti([12])_(\d{1,12})_[0-9a-f]{16}$/;

/** v1 issuer store 的迁移保留视图（forensic / anti-reuse——不参与新签发）。 */
export interface TreasuryAttemptIssuerLegacyRecord {
  readonly version: typeof TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION;
  /** 旧命名空间已消耗的最大序号（ti1_ 序列不可复用于 ti2_ 解释）。 */
  readonly highWatermark: number;
  readonly retiredAtTick: number;
}

export interface TreasuryAttemptIssuerStore {
  readonly version: typeof TREASURY_ATTEMPT_ISSUER_VERSION;
  /** 当前（ti2_）命名空间的持久单调 high-watermark——独立从 0 推进。 */
  highWatermark: number;
  /** v1 store 迁移保留（存在 = 自 v1 迁移；缺省 = 全新安装）。 */
  readonly legacy?: TreasuryAttemptIssuerLegacyRecord;
  /** 迁移/安装完成 tick（version=2 写入即完成——无第二 frontier）。 */
  readonly migratedAtTick: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithIssuer {
  attemptIssuer?: TreasuryAttemptIssuerStore | { version?: unknown; highWatermark?: unknown; updatedAt?: unknown };
}

type RuntimeMemoryWithIssuer = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithIssuer;
};

interface IssuerRuntime {
  store: TreasuryAttemptIssuerStore;
  fatal: string | null;
}

let heapRuntime: IssuerRuntime | null = null;

function issuerBranch(): TreasuryMemoryBranchWithIssuer {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithIssuer;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function issuerStoreOfMemory(): { version?: unknown; highWatermark?: unknown; updatedAt?: unknown; legacy?: unknown; migratedAtTick?: unknown } | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithIssuer | undefined)?.treasury?.attemptIssuer;
}

function validateIssuerStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "attempt issuer store 非对象";
  const candidate = store as Partial<TreasuryAttemptIssuerStore>;
  if (candidate.version !== TREASURY_ATTEMPT_ISSUER_VERSION) {
    return `attempt issuer store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!Number.isSafeInteger(candidate.highWatermark) || (candidate.highWatermark as number) < 0) {
    return "attempt issuer highWatermark 非安全非负整数";
  }
  if (candidate.legacy !== undefined) {
    const legacy = candidate.legacy as Partial<TreasuryAttemptIssuerLegacyRecord> | null;
    if (!legacy || typeof legacy !== "object") return "attempt issuer legacy 记录非对象";
    if (legacy.version !== TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION) {
      return `attempt issuer legacy 版本非法: ${String(legacy.version).slice(0, 16)}`;
    }
    if (!Number.isSafeInteger(legacy.highWatermark) || (legacy.highWatermark as number) < 0) {
      return "attempt issuer legacy highWatermark 非安全非负整数";
    }
    if (!Number.isSafeInteger(legacy.retiredAtTick) || (legacy.retiredAtTick as number) < 0) {
      return "attempt issuer legacy retiredAtTick 非法";
    }
  }
  if (!Number.isSafeInteger(candidate.migratedAtTick) || (candidate.migratedAtTick as number) < 0) {
    return "attempt issuer migratedAtTick 非法";
  }
  if (!Number.isSafeInteger(candidate.updatedAt) || (candidate.updatedAt as number) < 0) {
    return "attempt issuer updatedAt 非法";
  }
  return null;
}

/** v1 store 的迁移前校验（watermark 必须可读——否则不迁移，fail closed）。 */
function validateLegacyIssuerStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "attempt issuer store 非对象";
  const candidate = store as { version?: unknown; highWatermark?: unknown };
  if (candidate.version !== TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION) {
    return `attempt issuer store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!Number.isSafeInteger(candidate.highWatermark) || (candidate.highWatermark as number) < 0) {
    return "attempt issuer highWatermark 非安全非负整数";
  }
  return null;
}

/**
 * 【IX 工作流 A / A6】v1 → v2 迁移：单对象整体替换 + Memory read-back。
 * 旧 watermark 保留为 legacy 记录（不清空旧 Memory），新命名空间 watermark
 * 独立从 0 推进。read-back 失败 → 还原 v1 对象并 fail closed（不产生半迁移
 * 双 frontier）；global reset 后重读：version=2 即迁移完成（幂等——不会再次
 * 推进或重放）。
 */
function migrateLegacyIssuerStore(raw: {
  version?: unknown;
  highWatermark?: unknown;
  updatedAt?: unknown;
}): IssuerRuntime {
  const legacyError = validateLegacyIssuerStoreShape(raw);
  if (legacyError !== null) {
    return { store: raw as unknown as TreasuryAttemptIssuerStore, fatal: legacyError };
  }
  const legacyWatermark = raw.highWatermark as number;
  const migrated: TreasuryAttemptIssuerStore = {
    version: TREASURY_ATTEMPT_ISSUER_VERSION,
    highWatermark: 0,
    legacy: {
      version: TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION,
      highWatermark: legacyWatermark,
      retiredAtTick: Game.time,
    },
    migratedAtTick: Game.time,
    updatedAt: Game.time,
  };
  issuerBranch().attemptIssuer = migrated;
  const readBack = issuerStoreOfMemory();
  const readBackError =
    readBack === undefined || readBack.version !== TREASURY_ATTEMPT_ISSUER_VERSION
      ? "迁移 read-back 版本不一致"
      : validateIssuerStoreShape(readBack);
  const legacyKept = (readBack as Partial<TreasuryAttemptIssuerStore> | undefined)?.legacy;
  if (
    readBackError !== null ||
    (readBack as TreasuryAttemptIssuerStore).highWatermark !== 0 ||
    legacyKept?.highWatermark !== legacyWatermark
  ) {
    // 还原 v1 对象（不留半迁移状态）并 fail closed。
    issuerBranch().attemptIssuer = raw as never;
    return {
      store: migrated,
      fatal: `issuer v1→v2 迁移 read-back 失败（${readBackError ?? "legacy watermark 未保留"}——已还原 v1，fail closed）`,
    };
  }
  return { store: migrated, fatal: null };
}

function loadIssuerRuntime(): IssuerRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = issuerStoreOfMemory();
  if (raw === undefined) {
    const store: TreasuryAttemptIssuerStore = {
      version: TREASURY_ATTEMPT_ISSUER_VERSION,
      highWatermark: 0,
      migratedAtTick: Game.time,
      updatedAt: Game.time,
    };
    issuerBranch().attemptIssuer = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  if (raw.version === TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION) {
    heapRuntime = migrateLegacyIssuerStore(raw as { version?: unknown; highWatermark?: unknown; updatedAt?: unknown });
    return heapRuntime;
  }
  const shapeError = validateIssuerStoreShape(raw);
  heapRuntime = { store: raw as unknown as TreasuryAttemptIssuerStore, fatal: shapeError };
  return heapRuntime;
}

export interface TreasuryAttemptIssuerHealth {
  readonly healthy: boolean;
  readonly detail: string;
}

/** 只读健康探测（store 不存在 = 健康空；损坏 → unhealthy——不折叠为空）。 */
export function peekTreasuryAttemptIssuerHealth(): TreasuryAttemptIssuerHealth {
  const raw = issuerStoreOfMemory();
  if (raw === undefined) return { healthy: true, detail: "" };
  if (raw.version === TREASURY_ATTEMPT_ISSUER_LEGACY_VERSION) {
    // v1 在位但未迁移（迁移在 load 时发生——探测视角报 unhealthy 触发上层
    // fail closed，调用方需先经 load/open 完成迁移）。
    const legacyError = validateLegacyIssuerStoreShape(raw);
    return legacyError === null
      ? { healthy: false, detail: "attempt issuer store 为 v1（待迁移——经受控 opening 完成迁移前 fail closed）" }
      : { healthy: false, detail: legacyError };
  }
  const shapeError = validateIssuerStoreShape(raw);
  return shapeError === null ? { healthy: true, detail: "" } : { healthy: false, detail: shapeError };
}

/** 当前持久 high-watermark（只读；store 不存在 = 0；不可读/v1 未迁移 = -1）。 */
export function peekTreasuryIssuedAttemptWatermark(): number {
  const raw = issuerStoreOfMemory();
  if (raw === undefined) return 0;
  if (raw.version !== TREASURY_ATTEMPT_ISSUER_VERSION) return -1;
  return Number.isSafeInteger(raw.highWatermark) ? (raw.highWatermark as number) : -1;
}

/** v1 迁移保留的旧命名空间 watermark（只读；无 legacy 记录 = 0；不可读 = -1）。 */
export function peekTreasuryLegacyIssuedAttemptWatermark(): number {
  const raw = issuerStoreOfMemory();
  if (raw === undefined) return 0;
  if (raw.version !== TREASURY_ATTEMPT_ISSUER_VERSION) return -1;
  const legacy = raw.legacy as Partial<TreasuryAttemptIssuerLegacyRecord> | undefined;
  if (legacy === undefined) return 0;
  return Number.isSafeInteger(legacy.highWatermark) ? (legacy.highWatermark as number) : -1;
}

/**
 * 【IX 工作流 A】sequence → 完整 authoritative ID 的确定性一一映射（v3
 * 协议标签 + sequence——新命名空间内每个 sequence 恰好一个合法完整 ID）。
 */
function authoritativeIdOfSequence(sequence: number): string {
  return (
    TREASURY_ISSUED_ID_PREFIX +
    String(sequence) +
    "_" +
    hashTreasuryCanonicalString(`${ISSUER_PROTOCOL_TAG}:${String(sequence)}`)
  );
}

export type TreasuryIssuedAttemptBuildResult =
  | { readonly status: "built"; readonly transactionId: string }
  | { readonly status: "rejected"; readonly reason: "store_unhealthy" | "sequence_invalid"; readonly detail: string };

/**
 * 从 sequence 确定性构建完整 authoritative ID（验证与受控重建共用——不是
 * 签发：watermark 不推进）。issuer store 损坏 / v1 未迁移 → fail closed
 * （构建出的 ID 无法验证发行事实，拒绝输出）。
 */
export function buildTreasuryIssuedInitialAttemptIdFromSequence(sequence: number): TreasuryIssuedAttemptBuildResult {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return { status: "rejected", reason: "sequence_invalid", detail: `sequence ${String(sequence)} 非安全正整数` };
  }
  const runtime = loadIssuerRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `attempt issuer store fail-closed: ${runtime.fatal}` };
  }
  const transactionId = authoritativeIdOfSequence(sequence);
  if (!isValidTreasuryTransactionId(transactionId)) {
    return { status: "rejected", reason: "store_unhealthy", detail: `构建结果不符合 transactionId 边界: ${transactionId}` };
  }
  return { status: "built", transactionId };
}

export type TreasuryInitialAttemptMintResult =
  | { readonly status: "minted"; readonly transactionId: string; readonly sequence: number }
  | { readonly status: "rejected"; readonly reason: "store_unhealthy"; readonly detail: string };

/**
 * 签发新的 initial attempt ID。**受控 opening 专用**（attemptIssuanceTicket
 * 的 openTreasuryIssuedInitialAttempt——watermark 推进与持久 ticket 同一
 * 操作）；production 调用方不直接调用本函数（架构守护）。测试域保留为受控
 * mint helper（与 production channel 隔离）。correlation 只是 metadata——
 * 不参与 authoritative hash。
 */
export function mintTreasuryInitialAttemptId(correlation?: string): TreasuryInitialAttemptMintResult {
  void correlation;
  const runtime = loadIssuerRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `attempt issuer store fail-closed: ${runtime.fatal}` };
  }
  const sequence = runtime.store.highWatermark + 1;
  if (!Number.isSafeInteger(sequence)) {
    return { status: "rejected", reason: "store_unhealthy", detail: "highWatermark 溢出安全整数（issuer store fail closed）" };
  }
  runtime.store.highWatermark = sequence;
  runtime.store.updatedAt = Game.time;
  // Memory read-back：watermark 必须持久化为期望值（global reset 后不得回退）。
  const rawStore = issuerStoreOfMemory();
  if (rawStore === undefined || (rawStore as TreasuryAttemptIssuerStore).highWatermark !== sequence) {
    // 回滚 heap 视图并 fail closed（不签发可能回退的 ID）。
    runtime.store.highWatermark = sequence - 1;
    return { status: "rejected", reason: "store_unhealthy", detail: "watermark 写入后 Memory read-back 不一致（不签发——fail closed）" };
  }
  const transactionId = authoritativeIdOfSequence(sequence);
  if (!isValidTreasuryTransactionId(transactionId)) {
    return { status: "rejected", reason: "store_unhealthy", detail: `铸造结果不符合 transactionId 边界: ${transactionId}` };
  }
  return { status: "minted", transactionId, sequence };
}

/** mint 成功后的回滚（受控 opening 的失败路径——watermark 不回退，仅诊断用）。 */
export function noteTreasuryIssuerMintRolledBack(sequence: number): void {
  void sequence;
}

/** ti1_/ti2_ ID 解析（格式非法 → null——不猜测）。 */
export function parseTreasuryIssuedInitialAttemptId(
  transactionId: string,
): { readonly sequence: number; readonly namespace: "legacy" | "current" } | null {
  if (typeof transactionId !== "string") return null;
  const match = ISSUED_ID_PATTERN.exec(transactionId);
  if (match === null) return null;
  const sequence = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { sequence, namespace: match[1] === "1" ? "legacy" : "current" };
}

export type TreasuryIssuedAttemptCheck =
  | { readonly status: "issued"; readonly sequence: number }
  /** seq > watermark：手工伪造的未来 ID（production 通道拒绝）。 */
  | { readonly status: "forged_future"; readonly sequence: number }
  /**
   * 旧 ti1_ 命名空间，或 ti2_ seq ≤ watermark 但完整 ID 与 v3 确定性重算
   * 不匹配（篡改 checksum）。二者都不得当作当前格式的合法新 initial ID；
   * replay blocker 语义由 durable settlement authority / retired range 按
   * ID 承载（不因 issuer 判定丢失）。
   */
  | { readonly status: "legacy_unverified"; readonly sequence: number; readonly namespace: "legacy" | "current" }
  /** 非 ti1_/ti2_ 命名空间（arbitrary / legacy——不是 service-issued 权威 ID）。 */
  | { readonly status: "not_service_issued" }
  | { readonly status: "store_unhealthy"; readonly detail: string };

/**
 * service-issued ID 的完整发行事实判定（O(1)：watermark + 确定性重算——
 * 不依赖任何 per-ID 记录或 heap 对象）。当前命名空间（ti2_）内每个已发行
 * sequence 只有一个可验证的完整 authoritative ID；旧 ti1_ 一律
 * legacy_unverified（A4/A5：不作为新 initial attempt 执行）；issuer store
 * 损坏 / v1 未迁移 → fail closed（不签发也不放行）。
 */
export function checkTreasuryServiceIssuedAttemptId(transactionId: string): TreasuryIssuedAttemptCheck {
  const parsed = parseTreasuryIssuedInitialAttemptId(transactionId);
  if (parsed === null) return { status: "not_service_issued" };
  if (parsed.namespace === "legacy") {
    // 【IX 工作流 A】旧命名空间不属于当前发行协议——无论旧 watermark 多少，
    // ti1_ 都不再作为当前格式的合法新 initial ID（A1/A4/A5）。
    return { status: "legacy_unverified", sequence: parsed.sequence, namespace: "legacy" };
  }
  const runtime = loadIssuerRuntime();
  if (runtime.fatal !== null) {
    return { status: "store_unhealthy", detail: `attempt issuer store unhealthy: ${runtime.fatal}` };
  }
  const watermark = runtime.store.highWatermark;
  if (parsed.sequence > watermark) return { status: "forged_future", sequence: parsed.sequence };
  if (transactionId === authoritativeIdOfSequence(parsed.sequence)) {
    return { status: "issued", sequence: parsed.sequence };
  }
  return { status: "legacy_unverified", sequence: parsed.sequence, namespace: "current" };
}

/** test-only：删除 Memory 中的 issuer store（heap 一并失效）。 */
export function clearTreasuryAttemptIssuerDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithIssuer | undefined)?.treasury;
  if (branch !== undefined) delete branch.attemptIssuer;
  heapRuntime = null;
}

/** test-only：只清 heap 缓存（模拟 global reset 后从 Memory 恢复）。 */
export function resetTreasuryAttemptIssuerHeapCacheForTest(): void {
  heapRuntime = null;
}
