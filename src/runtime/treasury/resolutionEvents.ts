/**
 * Treasury fault resolution 事件计数器（第七轮）——独立于 faultResolution
 * 协议模块（生产代码不得 import faultResolution：架构测试守护只有显式
 * 管理/修复路径可引用 resolution 入口；facade metrics 聚合只读本模块）。
 */

const resolutionEvents = {
  committed: 0,
  notExecuted: 0,
  uncertain: 0,
  rejected: 0,
  /** 【第二十轮 13.6】chain_committed 推进写失败（保持可恢复 pending——beginTick 幂等补完成）。 */
  chainCommitPendingRetries: 0,
};

export interface TreasuryResolutionCounters {
  readonly committed: number;
  readonly notExecuted: number;
  readonly uncertain: number;
  readonly rejected: number;
  /** 【第二十轮 13.6】chain_committed 推进写失败计数（保持 pending）。 */
  readonly chainCommitPendingRetries: number;
}

/** 只读读取（零写）。 */
export function readTreasuryResolutionCounters(): TreasuryResolutionCounters {
  return { ...resolutionEvents };
}

/** faultResolution 协议内部累加（唯一写入口）。 */
export function recordTreasuryResolutionEvent(kind: keyof TreasuryResolutionCounters): void {
  resolutionEvents[kind] += 1;
}

/** 仅供测试：清零（clearTreasuryPersistenceForTest 调用）。 */
export function resetTreasuryResolutionEventsForTest(): void {
  resolutionEvents.committed = 0;
  resolutionEvents.notExecuted = 0;
  resolutionEvents.uncertain = 0;
  resolutionEvents.rejected = 0;
  resolutionEvents.chainCommitPendingRetries = 0;
}
