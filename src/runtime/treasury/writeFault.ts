/**
 * Treasury write-fault marker 与 write admission 锁（第五轮建立、第七轮
 * 补严 marker 形状契约与 phase 语义拆分）。
 *
 * 语义：Game API 已返回 OK 的 prepared commit 发生理论上不应发生的内部
 * 写故障（receipt/heap/handle 状态发布失败、endTick 时 handle 仍处于
 * executing 等）时，不得当作普通 rejected/aborted——transaction 进入
 * faulted 终态，tentative 预留与 receipt 槽不释放，全部后续 Treasury
 * writer fail closed，直至对账或人工修复。
 *
 * phase 分类（第七轮拆分，resolution 的允许性依赖该分类）：
 * - commit 类（Game callback 已确认 OK，之后的 Treasury 发布故障）：
 *   receipt_publish / heap_publish / journal_publish / overlay_publish /
 *   handle_state / commit_unexpected——Game 动作已发生，绝不允许
 *   resolve-as-not-executed；
 * - execution-unknown 类（Game 副作用未知）：executing_at_end_tick（endTick
 *   时仍在 executing）、action_threw_execution_unknown（callback 抛错——
 *   默认视为 execution unknown，见 facade 状态机）、
 *   action_returned_non_ok_abort_failed（Game 正常返回非 OK 但 abort 未确
 *   认）——配合显式 post-observation 证据可 resolution。
 *
 * marker 形状契约（第七轮）：transactionId/digest/phase/tick/status/
 * recordedAt/kind/source 严格校验 + detail（可选，≤192 字符有界异常摘要）；
 * 读取路径对损坏 marker 一律视为存在 unresolved fault（fail closed，绝不
 * 当作"没有 fault"）——peekTreasuryWriteFaultHealth 提供有界诊断。
 *
 * 持久化：最小、有界、正式类型化的 Memory write-fault marker
 * （Memory.runtime.treasury.writeFault，单条即首个 unresolved 故障的根因
 * 快照），global reset 后仍可发现 Treasury 曾发生 unresolved commit
 * fault。绝不持久化正常 transaction/journal/overlay 全量数据。
 *
 * 解除：第六轮起只有显式 fault resolution 协议（treasury/faultResolution.ts）
 * 可以清除 marker——resolve-as-committed / resolve-as-not-executed 经
 * transactionId+digest 严格匹配（clearTreasuryWriteFaultMarkerForResolution，
 * 仅供该模块调用）后随 resolution 一并解除；无条件删除 marker 的入口已
 * 移除（marker 无法证明 Game 动作是否发生，直接解锁会错误释放资源并
 * 可能重放已执行动作）；测试用清理包含在 clearTreasuryPersistenceForTest。
 */

/** commit 类 phase（Game callback 已确认 OK）：不允许 not-executed resolution。 */
export type TreasuryCommitFaultPhase =
  | "receipt_publish"
  | "heap_publish"
  | "journal_publish"
  | "overlay_publish"
  | "handle_state"
  | "commit_unexpected";

/** execution-unknown 类 phase（Game 副作用未知）：配合显式证据可 resolution。 */
export type TreasuryExecutionUnknownPhase =
  | "executing_at_end_tick"
  /** action callback 抛出异常——副作用未知，默认 execution unknown（第七轮）。 */
  | "action_threw_execution_unknown"
  /** Game 正常返回非 OK 但 abort 未确认——动作未成功，资源仍被占用（第七轮）。 */
  | "action_returned_non_ok_abort_failed";

export type TreasuryWriteFaultPhase = TreasuryCommitFaultPhase | TreasuryExecutionUnknownPhase;

/** 合法 phase 全集（quarantine 形状校验与 resolution 允许性判定的单一权威）。 */
export const TREASURY_WRITE_FAULT_PHASES: ReadonlySet<string> = new Set<string>([
  "receipt_publish",
  "heap_publish",
  "journal_publish",
  "overlay_publish",
  "handle_state",
  "commit_unexpected",
  "executing_at_end_tick",
  "action_threw_execution_unknown",
  "action_returned_non_ok_abort_failed",
]);

/** execution-unknown 类集合（faultResolution 的 not-executed 允许性用）。 */
export const TREASURY_EXECUTION_UNKNOWN_PHASES: ReadonlySet<string> = new Set<string>([
  "executing_at_end_tick",
  "action_threw_execution_unknown",
  "action_returned_non_ok_abort_failed",
]);

/** marker 异常摘要的有界长度（不持久化完整 Error 对象）。 */
export const TREASURY_WRITE_FAULT_DETAIL_MAX = 192;

const WRITE_FAULT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX = 128;

export interface TreasuryWriteFaultMarker {
  readonly transactionId: string;
  readonly digest: string;
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  readonly phase: TreasuryWriteFaultPhase;
  readonly status: "unresolved";
  readonly recordedAt: number;
  /** 有界异常/故障摘要（可选；绝不持久化完整 Error/stack 对象）。 */
  readonly detail?: string;
}

interface TreasuryWriteFaultBranch {
  writeFault?: TreasuryWriteFaultMarker;
}

type RuntimeMemoryWithTreasuryFault = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryWriteFaultBranch;
};

function treasuryBranch(): TreasuryWriteFaultBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** 只读读取原始 marker（查询/门禁路径零写；不校验形状——校验见 health）。 */
export function readTreasuryWriteFault(): TreasuryWriteFaultMarker | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury?.writeFault;
}

/**
 * marker 形状校验（第七轮）：返回 null = 合法，否则有界错误描述。
 * transactionId/digest/phase/tick/status/recordedAt/kind/source 逐字段。
 */
export function validateTreasuryWriteFaultMarkerShape(marker: unknown): string | null {
  if (!marker || typeof marker !== "object") return "marker 非对象";
  const candidate = marker as Partial<TreasuryWriteFaultMarker>;
  if (
    typeof candidate.transactionId !== "string" ||
    candidate.transactionId.length === 0 ||
    candidate.transactionId.length > WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX
  ) {
    return "marker.transactionId 非法";
  }
  if (typeof candidate.digest !== "string" || !WRITE_FAULT_DIGEST_PATTERN.test(candidate.digest)) {
    return "marker.digest 非法（须为 16 小写 hex）";
  }
  if (typeof candidate.phase !== "string" || !TREASURY_WRITE_FAULT_PHASES.has(candidate.phase)) {
    return `marker.phase 非法（未知枚举）: ${String(candidate.phase).slice(0, 48)}`;
  }
  if (candidate.status !== "unresolved") return "marker.status 非法（须为 unresolved）";
  if (typeof candidate.tick !== "number" || !Number.isSafeInteger(candidate.tick) || candidate.tick < 0) {
    return "marker.tick 非安全整数";
  }
  if (
    typeof candidate.recordedAt !== "number" ||
    !Number.isSafeInteger(candidate.recordedAt) ||
    candidate.recordedAt < 0
  ) {
    return "marker.recordedAt 非安全整数";
  }
  if (
    typeof candidate.kind !== "string" ||
    candidate.kind.length === 0 ||
    candidate.kind.length > WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX
  ) {
    return "marker.kind 非法";
  }
  if (
    typeof candidate.source !== "string" ||
    candidate.source.length === 0 ||
    candidate.source.length > WRITE_FAULT_TRANSACTION_ID_SOURCE_MAX
  ) {
    return "marker.source 非法";
  }
  if (
    candidate.detail !== undefined &&
    (typeof candidate.detail !== "string" || candidate.detail.length > TREASURY_WRITE_FAULT_DETAIL_MAX)
  ) {
    return "marker.detail 非法（须为 ≤192 字符）";
  }
  return null;
}

export interface TreasuryWriteFaultHealth {
  readonly healthy: boolean;
  /** marker 不存在或形状合法时为 null；损坏时有界诊断。 */
  readonly detail: string | null;
}

/**
 * write-fault marker 健康探测（只读）：marker 不存在 → healthy；存在且形状
 * 合法 → healthy（存在 unresolved fault 是合法状态——锁语义由
 * isTreasuryWriteAdmissionLocked 表达）；存在但损坏 → unhealthy（fail
 * closed：损坏 marker 不得被当作"没有 fault"）。
 */
export function peekTreasuryWriteFaultHealth(): TreasuryWriteFaultHealth {
  const marker = readTreasuryWriteFault();
  if (marker === undefined) return { healthy: true, detail: null };
  const shapeError = validateTreasuryWriteFaultMarkerShape(marker);
  if (shapeError !== null) return { healthy: false, detail: shapeError };
  return { healthy: true, detail: null };
}

/**
 * write admission 全局锁：存在 marker（无论形状是否合法）即锁定——损坏
 * marker 一律视为存在 unresolved fault（fail closed）。quarantine blocker
 * 独立于本锁（write-fault marker 不是唯一锁来源）。
 */
export function isTreasuryWriteAdmissionLocked(): boolean {
  return readTreasuryWriteFault() !== undefined;
}

/**
 * 记录 write-fault marker：只保留**首个** unresolved 故障（根因快照，
 * 后续故障不覆盖——有界）；heap 侧的重复计数由 facade metrics 负责。
 * detail 为有界异常摘要（≤192 字符，调用方负责截断）。
 */
export function recordTreasuryWriteFault(marker: TreasuryWriteFaultMarker): void {
  const branch = treasuryBranch();
  if (branch.writeFault?.status === "unresolved") return;
  const detail = marker.detail !== undefined ? marker.detail.slice(0, TREASURY_WRITE_FAULT_DETAIL_MAX) : undefined;
  branch.writeFault =
    detail !== undefined ? { ...marker, status: "unresolved", detail } : { ...marker, status: "unresolved" };
}

/**
 * 显式 fault resolution 的受控 marker 清除（第六轮，仅供 faultResolution
 * 模块调用）：transactionId 与 digest **同时匹配**才删除——解决错误的
 * transaction、或 marker 指向其它根因时一律不动。无条件删除 marker 的
 * 入口已在第六轮移除：marker 无法证明 Game 动作是否发生，直接删除解锁
 * 会错误释放资源并可能重放已执行动作。
 */
export function clearTreasuryWriteFaultMarkerForResolution(transactionId: string, digest: string): boolean {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury;
  const marker = branch?.writeFault;
  if (!marker || marker.status !== "unresolved") return false;
  if (marker.transactionId !== transactionId || marker.digest !== digest) return false;
  delete branch.writeFault;
  return true;
}

/**
 * staged commit 的意外故障异常（facade 捕获后统一进入 faulted 终态 +
 * marker + 全局锁）。phase 用于 marker 与故障注入测试断言。
 */
export class TreasuryCommitFaultError extends Error {
  readonly phase: TreasuryWriteFaultPhase;
  constructor(phase: TreasuryWriteFaultPhase, detail: string) {
    super(`Treasury commit fault (${phase}): ${detail}`);
    this.name = "TreasuryCommitFaultError";
    this.phase = phase;
  }
}

/**
 * 可注入故障点（仅测试）：commit 的每个 staged 边界前调用；抛错即模拟
 * 该阶段失败。生产代码不得设置（架构边界测试守护调用面）。
 */
let commitFaultInjector: ((phase: TreasuryWriteFaultPhase) => void) | null = null;

export function setTreasuryCommitFaultInjectorForTest(
  injector: ((phase: TreasuryWriteFaultPhase) => void) | null,
): void {
  commitFaultInjector = injector;
}

/** 注入器抛错时封装为携带 phase 的 TreasuryCommitFaultError（保真故障点）。 */
export function runTreasuryCommitFaultHook(phase: TreasuryWriteFaultPhase): void {
  if (commitFaultInjector === null) return;
  try {
    commitFaultInjector(phase);
  } catch (error) {
    if (error instanceof TreasuryCommitFaultError) throw error;
    throw new TreasuryCommitFaultError(phase, error instanceof Error ? error.message : String(error));
  }
}
