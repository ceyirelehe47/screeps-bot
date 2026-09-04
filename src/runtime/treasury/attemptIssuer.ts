/**
 * 【Round 22 Remediation VII 修复四】service-issued initial attempt ID
 * authority——受保护命名空间 `ti1_` 与持久单调 high-watermark。
 *
 * 对任意外部字符串 ID，若要求永久、精确、零误判地记住全部历史，同时
 * Memory 有界，就不可能按"一 ID 一条永久记录"实现。本模块是首选方案的
 * 签发侧：
 *
 * - production 真实 writer 不再接受任意调用方字符串作为权威 transaction
 *   ID（enforcement 在 actionContracts 的 production contract 通道）；
 * - Treasury 签发受保护的 initial attempt ID（`ti1_<seq>_<hash16>`）；
 * - seq 来自持久单调 high-watermark：global reset 后不回退、不复用——
 *   任何 seq ≤ watermark 的 ti1_ ID 都是"已发行"，O(1) 判定，零 per-ID
 *   持久占用；
 * - 调用方业务键只作为 correlation metadata 参与 hash lane（不成为
 *   replay authority）；
 * - 手工伪造（seq > watermark）在 production 通道被拒绝；复用（seq ≤
 *   watermark）由 durable settlement authority / retired range 阻断。
 *
 * mint 顺序：watermark 递增 → 写回 → Memory read-back 相等确认 → 返回
 * ID。store 不存在 = 健康空（从 1 开始）；未知版本 / 非安全整数 →
 * fail closed（不签发）。
 */

import { registerTreasuryResolutionCleanupResetHook } from "@/runtime/treasury/receipts";
import { hashTreasuryCanonicalString, isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";

export const TREASURY_ATTEMPT_ISSUER_VERSION = 1;
/** ti1_ 命名空间前缀（与 ts1_/tt1_/tr1_ 不可重叠）。 */
export const TREASURY_ISSUED_ID_PREFIX = "ti1_";
/** 签发协议标签（协议升级时递增——hash lane 成分）。 */
const ISSUER_PROTOCOL_TAG = "treasury-attempt-issuer@v1";

const ISSUED_ID_PATTERN = /^ti1_(\d{1,12})_[0-9a-f]{16}$/;

export interface TreasuryAttemptIssuerStore {
  readonly version: typeof TREASURY_ATTEMPT_ISSUER_VERSION;
  /** 持久单调 high-watermark（已发行的最大序号——永不回退）。 */
  highWatermark: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithIssuer {
  attemptIssuer?: TreasuryAttemptIssuerStore;
}

type RuntimeMemoryWithIssuer = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithIssuer;
};

interface IssuerRuntime {
  store: TreasuryAttemptIssuerStore;
  fatal: string | null;
}

let heapRuntime: IssuerRuntime | null = null;

registerTreasuryResolutionCleanupResetHook(() => {
  heapRuntime = null;
});

function issuerBranch(): TreasuryMemoryBranchWithIssuer {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithIssuer;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
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
  if (!Number.isSafeInteger(candidate.updatedAt) || (candidate.updatedAt as number) < 0) {
    return "attempt issuer updatedAt 非法";
  }
  return null;
}

function loadIssuerRuntime(): IssuerRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithIssuer | undefined)?.treasury?.attemptIssuer;
  if (raw === undefined) {
    const store: TreasuryAttemptIssuerStore = { version: TREASURY_ATTEMPT_ISSUER_VERSION, highWatermark: 0, updatedAt: Game.time };
    issuerBranch().attemptIssuer = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateIssuerStoreShape(raw);
  heapRuntime = { store: raw as unknown as TreasuryAttemptIssuerStore, fatal: shapeError };
  return heapRuntime;
}

export interface TreasuryAttemptIssuerHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/** 只读健康探测（store 不存在 = 健康空；损坏 → unhealthy——不折叠为空）。 */
export function peekTreasuryAttemptIssuerHealth(): TreasuryAttemptIssuerHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithIssuer | undefined)?.treasury?.attemptIssuer;
  if (raw === undefined) return { healthy: true, detail: null };
  const shapeError = validateIssuerStoreShape(raw);
  return shapeError === null ? { healthy: true, detail: null } : { healthy: false, detail: shapeError };
}

/** 当前持久 high-watermark（只读；store 不存在 = 0）。 */
export function peekTreasuryIssuedAttemptWatermark(): number {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithIssuer | undefined)?.treasury?.attemptIssuer;
  if (raw === undefined) return 0;
  return Number.isSafeInteger(raw.highWatermark) ? raw.highWatermark : -1;
}

export type TreasuryInitialAttemptMintResult =
  | { readonly status: "minted"; readonly transactionId: string; readonly sequence: number }
  | { readonly status: "rejected"; readonly reason: "store_unhealthy"; readonly detail: string };

/**
 * 签发新的 initial attempt ID（production writer 的唯一合法来源）。
 * correlation 是调用方业务键（只参与 hash lane——不成为 replay authority）。
 */
export function mintTreasuryInitialAttemptId(correlation?: string): TreasuryInitialAttemptMintResult {
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
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithIssuer | undefined)?.treasury?.attemptIssuer;
  if (rawStore === undefined || rawStore.highWatermark !== sequence) {
    // 回滚 heap 视图并 fail closed（不签发可能回退的 ID）。
    runtime.store.highWatermark = sequence - 1;
    return { status: "rejected", reason: "store_unhealthy", detail: "watermark 写入后 Memory read-back 不一致（不签发——fail closed）" };
  }
  const correlationLane = typeof correlation === "string" && correlation.length > 0 ? correlation : "";
  const transactionId =
    TREASURY_ISSUED_ID_PREFIX +
    String(sequence) +
    "_" +
    hashTreasuryCanonicalString(`${ISSUER_PROTOCOL_TAG}:${String(sequence)}:${correlationLane}`);
  if (!isValidTreasuryTransactionId(transactionId)) {
    return { status: "rejected", reason: "store_unhealthy", detail: `铸造结果不符合 transactionId 边界: ${transactionId}` };
  }
  return { status: "minted", transactionId, sequence };
}

/** ti1_ ID 解析（格式非法 → null——不猜测）。 */
export function parseTreasuryIssuedInitialAttemptId(
  transactionId: string,
): { readonly sequence: number } | null {
  if (typeof transactionId !== "string") return null;
  const match = ISSUED_ID_PATTERN.exec(transactionId);
  if (match === null) return null;
  const sequence = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { sequence };
}

export type TreasuryIssuedAttemptCheck =
  | { readonly status: "issued"; readonly sequence: number }
  /** seq > watermark：手工伪造的未来 ID（production 通道拒绝）。 */
  | { readonly status: "forged_future"; readonly sequence: number }
  /** 非 ti1_ 命名空间（arbitrary / legacy——不是 service-issued 权威 ID）。 */
  | { readonly status: "not_service_issued" }
  | { readonly status: "store_unhealthy"; readonly detail: string };

/**
 * ti1_ ID 的发行事实判定（O(1)：seq 与持久 watermark 比较——不依赖任何
 * per-ID 记录）。issuer store 损坏 → fail closed（不签发也不放行）。
 */
export function checkTreasuryServiceIssuedAttemptId(transactionId: string): TreasuryIssuedAttemptCheck {
  const parsed = parseTreasuryIssuedInitialAttemptId(transactionId);
  if (parsed === null) return { status: "not_service_issued" };
  const health = peekTreasuryAttemptIssuerHealth();
  if (!health.healthy) {
    return { status: "store_unhealthy", detail: `attempt issuer store unhealthy: ${health.detail}` };
  }
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0) {
    return { status: "store_unhealthy", detail: "attempt issuer watermark 不可读（fail closed）" };
  }
  if (parsed.sequence <= watermark) return { status: "issued", sequence: parsed.sequence };
  return { status: "forged_future", sequence: parsed.sequence };
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
