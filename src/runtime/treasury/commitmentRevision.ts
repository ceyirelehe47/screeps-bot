/**
 * Treasury 承诺索引 revision——mutation 侧失效通知。
 *
 * 跨 tick 承诺（transfer tasks / production reservations）的权威在 Memory，
 * 任何 mutation（创建/合并/取消/阻塞/进度/续租/释放/GC）都必须调用
 * bumpTreasuryCommitmentRevision，使 facade 在下一次 commitments()/query()
 * 时重建索引——同 tick mutation 后不可再读到陈旧快照。
 *
 * revision 只需在单次 heap 生命周期内单调递增：global reset 后模块闭包与
 * facade 缓存同时归零，不存在跨 reset 的陈旧缓存，因此无需 global 槽或
 * Memory 持久化（避免第二份状态副本）。
 *
 * treasuryCommitmentInvalidationBoundaries 守护权威写入口的失效委托链；
 * treasuryCommitmentInvalidation 使用真实 facade 验证同 tick 取消后重查。
 */

let commitmentRevision = 0;

export function bumpTreasuryCommitmentRevision(): void {
  commitmentRevision += 1;
}

export function readTreasuryCommitmentRevision(): number {
  return commitmentRevision;
}

/** 仅供测试：复位 revision（配合 TreasuryService.resetForTest 使用）。 */
export function resetTreasuryCommitmentRevisionForTest(): void {
  commitmentRevision = 0;
}
