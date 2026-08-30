/**
 * Treasury write-fault marker 与 write admission 锁（第五轮）。
 *
 * 语义：Game API 已返回 OK 的 prepared commit 发生理论上不应发生的内部
 * 写故障（receipt/heap/handle 状态发布失败、endTick 时 handle 仍处于
 * executing 等）时，不得当作普通 rejected/aborted——transaction 进入
 * faulted 终态，tentative 预留与 receipt 槽不释放，全部后续 Treasury
 * writer fail closed，直至对账或人工修复。
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

export type TreasuryWriteFaultPhase =
  | "receipt_publish"
  | "heap_publish"
  | "journal_publish"
  | "overlay_publish"
  | "handle_state"
  | "commit_unexpected"
  | "executing_at_end_tick"
  /** Game callback 抛错且自动 abort 未确认（Game 副作用不可知，保守隔离）。 */
  | "abort_failed";

export interface TreasuryWriteFaultMarker {
  readonly transactionId: string;
  readonly digest: string;
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  readonly phase: TreasuryWriteFaultPhase;
  readonly status: "unresolved";
  readonly recordedAt: number;
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

/** 只读读取（查询/门禁路径零写）。 */
export function readTreasuryWriteFault(): TreasuryWriteFaultMarker | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithTreasuryFault | undefined)?.treasury?.writeFault;
}

/** write admission 全局锁：存在 unresolved marker 即锁定。 */
export function isTreasuryWriteAdmissionLocked(): boolean {
  return readTreasuryWriteFault() !== undefined;
}

/**
 * 记录 write-fault marker：只保留**首个** unresolved 故障（根因快照，
 * 后续故障不覆盖——有界）；heap 侧的重复计数由 facade metrics 负责。
 */
export function recordTreasuryWriteFault(marker: TreasuryWriteFaultMarker): void {
  const branch = treasuryBranch();
  if (branch.writeFault?.status === "unresolved") return;
  branch.writeFault = { ...marker, status: "unresolved" };
}

/**
 * 显式 fault resolution 的受控 marker 清除（第六轮，仅供 faultResolution
 * 模块调用）：transactionId 与 digest **同时匹配**才删除——解决错误的
 * transaction、或 marker 指向其它根因时一律不动。无条件删除 marker 的
 * 入口已在第六轮移除：marker 无法证明 Game
 * 动作是否发生，直接删除解锁会错误释放资源并可能重放已执行动作。
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
