/**
 * 【Round 22 Remediation III 七】settlement proof activation——reservation
 * 激活必须由 matching 持久 proof 证明。
 *
 * Remediation II 的 activateTreasuryResolutionCleanupProof 只按 transaction
 * ID 把 settlementProofDurable 切为 true：不验证 matching tombstone 存在、
 * 不比较 exact identity、不检查 tombstone 状态——调用方声称"proof 已写"
 * 即可激活，reservation 可能在 proof 实际缺席时放行全部后续阶段。
 *
 * 本模块要求激活前完成：
 *  - committed（7.1）：matching resolving/final committed tombstone 存在；
 *    tombstone exact identity 与 journal entry 一致（digest/contract/cohort/
 *    durable/lowlevel/lineage 全维度 + proof class）；tombstone 状态合法
 *    （resolving 或 final）；Resolution store 健康。
 *  - not-executed（7.2）：matching final not-executed tombstone 存在；exact
 *    identity 一致；capability 消费阶段已完成（final tombstone 只在
 *    capability 消费后写入——写入口在 faultResolution 的 consume 之后，
 *    tombstone 存在即消费证明）；Resolution store 健康。
 *
 * 激活（7.3）：写入 settlementProofDurable=true → Memory read-back 确认
 * （identity 未变、阶段未被越级推进）。激活未成功时不 discharge marker、
 * 不 release Authority、不推进任何后续阶段。
 *
 * Recovery（7.4）：global reset 后 reservation 未激活但 matching proof 实际
 * 存在时，恢复器经本函数幂等补激活（同一验证器）；proof 不存在则
 * reservation 保持 pending（或由受控回滚协议撤销——不猜测）。
 *
 * tombstone 读取经装配 probes 注入（避免 resolutionStore ↔ activation 的
 * 模块环）；production 未装配 → fail closed（无法证明 matching proof——
 * 绝不因探测缺失而激活）。
 */

import {
  peekTreasuryResolutionCleanupHealth,
  readBackTreasuryResolutionCleanupEntryFromMemory,
  readTreasuryResolutionCleanupEntry,
  type TreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";

export type TreasuryCleanupProofActivationOutcome =
  | "activated"
  | "already_activated"
  | "absent"
  | "proof_absent"
  | "identity_conflict"
  | "proof_insufficient"
  | "store_unhealthy"
  | "read_back_failed";

export interface TreasuryCleanupProofActivationResult {
  readonly outcome: TreasuryCleanupProofActivationOutcome;
  readonly detail: string;
}

/** tombstone 的 structural 视图（避免直接 import resolutionStore 造成环）。 */
export interface TreasuryCleanupProofTombstoneView {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: string;
  readonly stage: string;
  readonly proofLevel: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

/** 装配 probes（facade 注册 resolutionStore 的只读 API；test 可重入）。 */
export interface TreasuryCleanupProofProbes {
  readonly readTombstone: (transactionId: string) => TreasuryCleanupProofTombstoneView | undefined;
  readonly resolutionStoreHealthy: () => boolean;
}

let proofProbes: TreasuryCleanupProofProbes | null = null;

export function registerTreasuryCleanupProofProbesForAssembly(probes: TreasuryCleanupProofProbes | null): void {
  proofProbes = probes;
}

export function peekTreasuryCleanupProofProbes(): TreasuryCleanupProofProbes | null {
  return proofProbes;
}

const TOMBSTONE_IDENTITY_FIELDS = [
  "digest",
  "contractDigest",
  "authorizationCohortDigest",
  "durableIdentityDigest",
  "lowlevelSource",
  "lineageId",
  "lineageGeneration",
  "parentTransactionId",
  "lineageBindingDigest",
] as const;

function tombstoneIdentityMismatch(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
  tombstone: TreasuryCleanupProofTombstoneView,
): string | null {
  for (const field of TOMBSTONE_IDENTITY_FIELDS) {
    if ((tombstone[field] ?? undefined) !== (entry[field] ?? undefined)) {
      return `tombstone identity 字段 ${field} 与 journal entry 不一致（tombstone ${String(tombstone[field]).slice(0, 24)} vs journal ${String(entry[field]).slice(0, 24)}）`;
    }
  }
  // proofLevel ↔ journal proofClass 唯一映射（与 markerDischarge 的 class
  // 归一同一语义）。
  const levelOf: Record<string, string> = {
    "identity-bound": "identity-bound",
    modern: "identity-bound",
    lowlevel: "lowlevel",
    forensic: "forensic",
  };
  if ((levelOf[tombstone.proofLevel] ?? "legacy") !== entry.proofClass) {
    return `tombstone proofLevel ${tombstone.proofLevel} 与 journal proofClass ${entry.proofClass} 不满足唯一合法组合`;
  }
  return null;
}

/**
 * settlement proof activation ack：验证 matching 持久 proof → 写入
 * settlementProofDurable → Memory read-back。reservation（false）之外，
 * 已激活（true）时同样重验 proof 事实（幂等——boolean 撒谎时 fail closed）。
 */
export function acknowledgeTreasuryCleanupSettlementProof(input: {
  readonly transactionId: string;
}): TreasuryCleanupProofActivationResult {
  const health = peekTreasuryResolutionCleanupHealth();
  if (!health.healthy) {
    return { outcome: "store_unhealthy", detail: `cleanup journal unhealthy: ${health.detail ?? "unknown"}` };
  }
  const entry = readTreasuryResolutionCleanupEntry(input.transactionId);
  if (entry === undefined) {
    return { outcome: "absent", detail: `cleanup entry ${input.transactionId.slice(0, 12)} 不存在（store 健康）` };
  }
  if (proofProbes === null) {
    return { outcome: "proof_insufficient", detail: "proof probes 未装配（production fail closed——无法证明 matching proof，不激活）" };
  }
  if (!proofProbes.resolutionStoreHealthy()) {
    return { outcome: "store_unhealthy", detail: "resolution store unhealthy（不激活 reservation）" };
  }
  const tombstone = proofProbes.readTombstone(input.transactionId);
  if (tombstone === undefined) {
    return { outcome: "proof_absent", detail: "matching tombstone 不存在（reservation 保持 pending，不得激活）" };
  }
  if (tombstone.resolution !== entry.resolution) {
    return {
      outcome: "identity_conflict",
      detail: `tombstone resolution ${tombstone.resolution} 与 journal ${entry.resolution} 相反（同 transaction ID 不得激活）`,
    };
  }
  if (entry.resolution === "committed") {
    if (tombstone.stage !== "resolving" && tombstone.stage !== "final") {
      return { outcome: "proof_insufficient", detail: `committed tombstone 阶段 ${tombstone.stage} 非法（resolving/final 之外不构成 settlement proof）` };
    }
  } else {
    if (tombstone.stage !== "final") {
      return { outcome: "proof_insufficient", detail: `not-executed tombstone 阶段 ${tombstone.stage} 非法（只有 final 构成 settlement proof）` };
    }
  }
  const mismatch = tombstoneIdentityMismatch(entry, tombstone);
  if (mismatch !== null) {
    return { outcome: "identity_conflict", detail: `activation 拒绝：${mismatch}` };
  }
  if (entry.settlementProofDurable) {
    return { outcome: "already_activated", detail: "reservation 已激活且 matching proof 复验成立（幂等）" };
  }
  // 写入 settlementProofDurable=true + Memory read-back（identity 未变、
  // 阶段未被越级推进）。
  const store = (Memory.runtime as { treasury?: { resolutionCleanup?: { entries?: Record<string, TreasuryResolutionCleanupEntry>; updatedAt?: number } } } | undefined)
    ?.treasury?.resolutionCleanup;
  const durableEntry = store?.entries[`c:${input.transactionId}`];
  if (store === undefined || durableEntry === undefined) {
    return { outcome: "read_back_failed", detail: "activation 写入前 Memory 中 entry 消失（不激活）" };
  }
  durableEntry.settlementProofDurable = true;
  durableEntry.updatedAt = Game.time;
  store.updatedAt = Game.time;
  const readBack = readBackTreasuryResolutionCleanupEntryFromMemory(input.transactionId);
  if (readBack.status === "store_unhealthy") {
    durableEntry.settlementProofDurable = false;
    return { outcome: "read_back_failed", detail: `activation read-back store unhealthy: ${readBack.detail}` };
  }
  if (readBack.status === "absent" || readBack.entry === undefined) {
    return { outcome: "read_back_failed", detail: "activation read-back 时 entry 消失（写入未持久确认）" };
  }
  if (!readBack.entry.settlementProofDurable) {
    return { outcome: "read_back_failed", detail: "activation read-back settlementProofDurable 仍为 false（写入未持久确认）" };
  }
  for (const field of TOMBSTONE_IDENTITY_FIELDS) {
    if ((readBack.entry[field] ?? undefined) !== (entry[field] ?? undefined)) {
      return { outcome: "read_back_failed", detail: `activation read-back identity 字段 ${field} 发生变化` };
    }
  }
  if (readBack.entry.markerDischarged || readBack.entry.authorityReleased || readBack.entry.outcomeFinalized || readBack.entry.lineageFinalized) {
    return { outcome: "read_back_failed", detail: "activation read-back 发现阶段被越级推进（写入未持久确认）" };
  }
  return { outcome: "activated", detail: "reservation 已激活并经 Memory read-back 确认（matching tombstone 验证成立）" };
}
