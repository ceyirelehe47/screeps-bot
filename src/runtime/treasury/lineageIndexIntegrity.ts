/**
 * 【第十八轮 24.6】lineage store 跨索引完整性判定（纯函数——attemptLineage
 * 的 load 全表验证与写入前预检共用同一语义）。
 *
 * 不变量：
 * - lineageId / root attempt ID / current attempt ID / next child ID 四个键
 *   全局唯一（跨 record 不得重复出现在任一索引语义中）；
 * - root ≠ 任何 record 的 current/next；current ≠ 任何 record 的 root/next；
 *   next ≠ 任何 record 的 root/current/next；
 * - 同 record 内：next ≠ root、next ≠ current、generation===0 ⟺ current===root。
 *
 * 发现冲突 → 返回有界 detail（调用侧据此把整个 store 判 unhealthy 或拒绝
 * 写入候选——绝不由 Map.set 静默覆盖、绝不自动删除任一 record）。
 */

/** 索引判定的最小 record 视图（避免全量 record 类型耦合）。 */
export interface TreasuryLineageIndexRecordView {
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly currentTransactionId: string;
  readonly nextChildTransactionId?: string;
  readonly generation: number;
}

/**
 * 【第十九轮 D.1】same-record 判定改用 store entry identity（root
 * transaction ID——store key 的派生），不再用 lineageId 相等：两个不同
 * entry 携带相同 lineageId 是 duplicate 冲突而非同一 record（Round 18 用
 * lineageId 判同 record 导致该冲突被静默跳过）。
 */
function sameRecord(
  left: Pick<TreasuryLineageIndexRecordView, "lineageId" | "rootTransactionId">,
  right: Pick<TreasuryLineageIndexRecordView, "lineageId" | "rootTransactionId">,
): boolean {
  return left.rootTransactionId === right.rootTransactionId;
}

/** 单 record 内部组合的状态语义检查（load 与写入候选共用）。 */
export function validateTreasuryLineageRecordIndexCombination(
  record: TreasuryLineageIndexRecordView,
): string | null {
  if (record.nextChildTransactionId !== undefined) {
    if (record.nextChildTransactionId === record.rootTransactionId) {
      return `record.nextChildTransactionId 等于 root（${record.rootTransactionId.slice(0, 24)}）——child 不得指向本链 root`;
    }
    if (record.nextChildTransactionId === record.currentTransactionId) {
      return `record.nextChildTransactionId 等于 current（${record.currentTransactionId.slice(0, 24)}）——child 不得指向当前代自身`;
    }
  }
  const currentIsRoot = record.currentTransactionId === record.rootTransactionId;
  if (record.generation === 0 && !currentIsRoot) {
    return "record.generation=0 但 current 不是 root（代际与 attempt 组合矛盾）";
  }
  if (record.generation > 0 && currentIsRoot) {
    return `record.generation=${String(record.generation)} 但 current 仍是 root（child 接管未发生）`;
  }
  return null;
}

/**
 * 全表跨索引冲突检测（global reset 首次 load 用）：返回 null = 一致；否则
 * 第一处冲突的有界描述。
 */
export function findTreasuryLineageCrossIndexConflicts(
  records: readonly TreasuryLineageIndexRecordView[],
): string | null {
  const byLineageId = new Map<string, TreasuryLineageIndexRecordView>();
  const byRoot = new Map<string, TreasuryLineageIndexRecordView>();
  const byCurrent = new Map<string, TreasuryLineageIndexRecordView>();
  const byNext = new Map<string, TreasuryLineageIndexRecordView>();
  for (const record of records) {
    const combinationError = validateTreasuryLineageRecordIndexCombination(record);
    if (combinationError !== null) {
      return `lineage ${record.lineageId.slice(0, 12)}: ${combinationError}`;
    }
    const clash = (label: string, value: string, index: Map<string, TreasuryLineageIndexRecordView>): string | null => {
      const owner = index.get(value);
      if (owner !== undefined && !sameRecord(owner, record)) {
        return `${label} ${value.slice(0, 24)} 同时属于 lineage ${owner.lineageId.slice(0, 12)} 与 ${record.lineageId.slice(0, 12)}（跨索引冲突）`;
      }
      return null;
    };
    const lineageClash = clash("lineageId", record.lineageId, byLineageId);
    if (lineageClash !== null) {
      // 【第十九轮 D.2】duplicate lineageId：两个不同 root 的 entry 携带相同
      // lineageId——lineage 身份是 proof 链的锚，重复即整个 store unhealthy。
      return `duplicate lineageId ${record.lineageId.slice(0, 12)}（lineage ${byLineageId.get(record.lineageId)!.lineageId.slice(0, 12)} 的 root ${byLineageId.get(record.lineageId)!.rootTransactionId.slice(0, 24)} 与 ${record.rootTransactionId.slice(0, 24)}——同一 lineage 身份不得属于两个 entry）`;
    }
    const rootClash = clash("root", record.rootTransactionId, byRoot);
    if (rootClash !== null) return rootClash;
    const rootAsCurrent = byCurrent.get(record.rootTransactionId);
    if (rootAsCurrent !== undefined && !sameRecord(rootAsCurrent, record)) {
      return `root ${record.rootTransactionId.slice(0, 24)} 与 lineage ${rootAsCurrent.lineageId.slice(0, 12)} 的 current 冲突`;
    }
    const rootAsNext = byNext.get(record.rootTransactionId);
    if (rootAsNext !== undefined && !sameRecord(rootAsNext, record)) {
      return `root ${record.rootTransactionId.slice(0, 24)} 与 lineage ${rootAsNext.lineageId.slice(0, 12)} 的 next-child 冲突`;
    }
    const currentClash = clash("current", record.currentTransactionId, byCurrent);
    if (currentClash !== null) return currentClash;
    const currentAsRoot = byRoot.get(record.currentTransactionId);
    if (currentAsRoot !== undefined && !sameRecord(currentAsRoot, record)) {
      return `current ${record.currentTransactionId.slice(0, 24)} 与 lineage ${currentAsRoot.lineageId.slice(0, 12)} 的 root 冲突`;
    }
    const currentAsNext = byNext.get(record.currentTransactionId);
    if (currentAsNext !== undefined && !sameRecord(currentAsNext, record)) {
      return `current ${record.currentTransactionId.slice(0, 24)} 与 lineage ${currentAsNext.lineageId.slice(0, 12)} 的 next-child 冲突`;
    }
    if (record.nextChildTransactionId !== undefined) {
      const nextClash = clash("next-child", record.nextChildTransactionId, byNext);
      if (nextClash !== null) return nextClash;
      const nextAsRoot = byRoot.get(record.nextChildTransactionId);
      if (nextAsRoot !== undefined && !sameRecord(nextAsRoot, record)) {
        return `next-child ${record.nextChildTransactionId.slice(0, 24)} 与 lineage ${nextAsRoot.lineageId.slice(0, 12)} 的 root 冲突`;
      }
      const nextAsCurrent = byCurrent.get(record.nextChildTransactionId);
      if (nextAsCurrent !== undefined && !sameRecord(nextAsCurrent, record)) {
        return `next-child ${record.nextChildTransactionId.slice(0, 24)} 与 lineage ${nextAsCurrent.lineageId.slice(0, 12)} 的 current 冲突`;
      }
      byNext.set(record.nextChildTransactionId, record);
    }
    byLineageId.set(record.lineageId, record);
    byRoot.set(record.rootTransactionId, record);
    byCurrent.set(record.currentTransactionId, record);
  }
  return null;
}

/**
 * 写入候选的跨 record 冲突预检（existing 为被替换的 record 或 undefined——
 * 同一 record 自身的键不算冲突）。返回 null = 无冲突。
 */
export function treasuryLineageCandidateConflictsWith(
  candidate: TreasuryLineageIndexRecordView,
  others: readonly TreasuryLineageIndexRecordView[],
): string | null {
  const combinationError = validateTreasuryLineageRecordIndexCombination(candidate);
  if (combinationError !== null) return combinationError;
  const candidateKeys = [candidate.lineageId, candidate.rootTransactionId, candidate.currentTransactionId];
  if (candidate.nextChildTransactionId !== undefined) candidateKeys.push(candidate.nextChildTransactionId);
  for (const other of others) {
    if (sameRecord(other, candidate)) continue;
    const otherKeys = [other.lineageId, other.rootTransactionId, other.currentTransactionId];
    if (other.nextChildTransactionId !== undefined) otherKeys.push(other.nextChildTransactionId);
    for (const candidateKey of candidateKeys) {
      if (otherKeys.includes(candidateKey)) {
        return `候选键 ${candidateKey.slice(0, 24)} 与既有 lineage ${other.lineageId.slice(0, 12)} 的索引冲突（跨索引唯一性破坏——写入拒绝，原 store 不变）`;
      }
    }
  }
  return null;
}
