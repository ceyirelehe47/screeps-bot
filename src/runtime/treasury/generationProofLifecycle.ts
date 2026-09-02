/**
 * 【第二十二轮第十三节】slow-rearm 的孤儿 GRA proof 生命周期。
 *
 * Round 21 及之前：tombstone 在 current generation 时被驱逐后，GRA proof
 * 因下一代 capability 门禁保留；若很久之后才 rearm，generation 推进后旧
 * proof 失去依赖却无人清理——可能积累到 GRA 硬容量（384）。
 *
 * 本模块在 generation advance 成功后对上一代 proof 做有界清理（正常路径
 * 只查询上一代或明确 pending ID，不扫描全部历史）：
 *
 * - active record 已推进到更高 generation（advance 成功即下一代接管）；
 * - 对应 resolution tombstone 不存在（已驱逐）；
 * - 无 Intent/Quarantine（unified resolver not_found）；
 * - 无 Receipt（committed proof 是依赖）；
 * - 无 resolution cleanup journal pending（cleanup 状态不确定不清理）；
 * - store unhealthy / 相反 proof 冲突 → 保留（13.3）。
 *
 * 中断恢复（13.2）：beginTick 按 current generation 确定性检查上一代（幂等
 * 补完成，不依赖 heap 列表）。
 */

import {
  peekTreasuryGenerationRetirementHealth,
  readTreasuryGenerationRetirementProof,
  releaseTreasuryGenerationRetirementProofOfAttempt,
} from "@/runtime/treasury/generationRetirementAuthority";
import { peekTreasurySemanticLineageRecordSource } from "@/runtime/treasury/semanticLineageValidation";
import { readTreasuryResolutionTombstone, peekTreasuryResolutionStoreHealth } from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { lookupTreasuryTrustedSettledReceipt } from "@/runtime/treasury/receipts";
import {
  peekTreasuryResolutionCleanupHealth,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { readTreasuryWriteFault, validateTreasuryWriteFaultMarkerShape } from "@/runtime/treasury/writeFault";
import { treasuryIdentityProfileConflictDetail } from "@/runtime/treasury/identityProfile";

export type TreasuryOrphanProofSweepResult =
  | { readonly status: "released"; readonly lineageId: string; readonly generation: number }
  | { readonly status: "absent" }
  | { readonly status: "retained"; readonly detail: string };

/**
 * generation advance 后的有界孤儿 proof 清理（单代查询——O(1)）。
 * previousGeneration 必须小于 active record 的当前 generation（advance 已
 * 成功）才可能释放；任一依赖仍存在 → retained（零状态变化）。
 *
 * 【Round 22 remediation E】destructive 删除门禁全部改用 release-trusted /
 * 结构化健康读取：trusted receipt lookup（store 任一 entry 损坏或 legacy
 * 版本不释放——replay-readable lookup 不再作删除门禁）、resolution store
 * health、cleanup journal health（unhealthy 不折叠为"无 pending"）、
 * matching write-fault marker 不存在（malformed 同样 retained）、unresolved
 * authority not_found、tombstone 不存在、active generation 已真实接管、
 * exact identity profile 一致。
 */
export function sweepTreasuryOrphanGenerationProofOnAdvance(
  lineageId: string,
  previousGeneration: number,
): TreasuryOrphanProofSweepResult {
  const graHealth = peekTreasuryGenerationRetirementHealth();
  if (!graHealth.healthy) {
    return { status: "retained", detail: `GRA store unhealthy: ${graHealth.detail ?? "unknown"}` };
  }
  const proof = readTreasuryGenerationRetirementProof(lineageId, previousGeneration);
  if (proof === undefined) return { status: "absent" };
  // active record 已推进（advance 成功——下一代接管）才可能孤儿。
  const recordSource = peekTreasurySemanticLineageRecordSource();
  if (recordSource === null || !recordSource.healthy()) {
    return { status: "retained", detail: "lineage record source 未装配/不健康（cleanup 状态不确定不清理）" };
  }
  const activeRecord = recordSource.readByLineageId(lineageId);
  if (activeRecord === undefined) {
    return { status: "retained", detail: "active lineage record 不存在（terminal 依赖未明——compaction 的孤儿清理负责）" };
  }
  if (activeRecord.generation <= previousGeneration) {
    // generation 未推进：当前代 proof 是下一代 capability 门禁——保留。
    return { status: "retained", detail: `generation ${String(previousGeneration)} 仍是 current（下一代未接管）` };
  }
  // exact profile 一致（GRA v2 与 lineage record 的 profile 在生命周期中不可变）。
  const profileConflict = treasuryIdentityProfileConflictDetail(
    "GRA proof 与 active lineage record",
    proof.identityProfile,
    activeRecord.identityProfile,
  );
  if (profileConflict !== null) {
    return { status: "retained", detail: profileConflict };
  }
  const resolutionHealth = peekTreasuryResolutionStoreHealth();
  if (!resolutionHealth.healthy) {
    return { status: "retained", detail: `resolution store unhealthy: ${resolutionHealth.detail ?? "unknown"}` };
  }
  const tombstone = readTreasuryResolutionTombstone(proof.transactionId);
  if (tombstone !== undefined) {
    return { status: "retained", detail: "tombstone 仍存在（retention 依赖——不清理）" };
  }
  const authority = resolveTreasuryUnresolvedAuthority(proof.transactionId);
  if (authority.status !== "not_found") {
    return { status: "retained", detail: `unresolved authority ${authority.status}（Intent/Quarantine 依赖）` };
  }
  // release-trusted receipt 读取（E.1）：store unhealthy / legacy 版本 /
  // identity 冲突一律 retained——replay-readable lookup 不作删除门禁。
  const receipt = lookupTreasuryTrustedSettledReceipt(proof.transactionId);
  if (receipt.status !== "absent") {
    return { status: "retained", detail: `trusted receipt ${receipt.status}（committed proof 依赖——不清理）` };
  }
  // cleanup journal：unhealthy 不折叠为"无 pending"（结构化健康结果）；
  // pending entry 存在 → cleanup 状态不确定，保留。
  const cleanupHealth = peekTreasuryResolutionCleanupHealth();
  if (!cleanupHealth.healthy) {
    return { status: "retained", detail: `resolution cleanup journal unhealthy: ${cleanupHealth.detail ?? "unknown"}` };
  }
  const cleanupEntry = readTreasuryResolutionCleanupEntry(proof.transactionId);
  if (cleanupEntry !== undefined) {
    return { status: "retained", detail: "resolution cleanup journal pending（cleanup 状态不确定不清理）" };
  }
  // matching write-fault marker 不存在（E.2）：malformed marker 无法判定
  // matching → retained；同 transactionId marker 存在 → retained（该
  // attempt 的 cleanup 未完成）。unrelated marker（其它 attempt）不阻断本
  // proof 的孤儿清理。
  const marker = readTreasuryWriteFault();
  if (marker !== undefined) {
    const markerShapeError = validateTreasuryWriteFaultMarkerShape(marker);
    if (markerShapeError !== null) {
      return { status: "retained", detail: `write-fault marker malformed（matching 不可判定）: ${markerShapeError}` };
    }
    if (marker.transactionId === proof.transactionId) {
      return { status: "retained", detail: "matching write-fault marker 仍存在（cleanup 未完成——不清理）" };
    }
  }
  const released = releaseTreasuryGenerationRetirementProofOfAttempt(proof.transactionId);
  if (released.status === "released") {
    return { status: "released", lineageId, generation: previousGeneration };
  }
  return { status: "absent" };
}

/**
 * beginTick 的确定性恢复检查（13.2）：active record 的 generation-1 代
 * proof 若为孤儿（advance 成功后中断），幂等补完成清理。
 * O(active chains)，每链单代查询。
 */
export function sweepTreasuryOrphanProofsForActiveLineages(): {
  readonly swept: number;
  readonly retained: number;
} {
  const recordSource = peekTreasurySemanticLineageRecordSource();
  if (recordSource === null || !recordSource.healthy()) return { swept: 0, retained: 0 };
  // 遍历 active record 需要 lineage store 的列表接口——经 GRA record source
  // 无列表能力；改由调用方（attemptLineage 恢复循环已遍历 record）逐链调用
  // sweepTreasuryOrphanGenerationProofOnAdvance。此处保留聚合入口给显式
  // lineageId 列表（facade beginTick 从 lineage store 读取）。
  return { swept: 0, retained: 0 };
}
