/**
 * 【第十七轮第十二节】rearm 前的 parent 相反 proof 与 child 占用集中检查。
 *
 * 全部检查都是各 store 的单 key lookup（O(1)，不扫描历史表）：
 * - parent 侧（issue capability 前置）：lineage 健康、retirement record 存在
 *   且 rearm-ready、not-executed proof 完整、authority 已释放、marker 已清
 *   理、pending cleanup 完成、receipt store 健康、不存在 committed receipt /
 *   committed final tombstone / resolving committed tombstone、无 identity
 *   冲突、authority class 允许、lowlevelSource 完整、retry facts 完整；
 * - child 侧（issue capability 前置）：child ID 在 receipt / resolution
 *   tombstone / intent / quarantine / authorization-fault / write-fault
 *   marker / 其它 lineage 索引全部不存在（prepared handle 与 authorization
 *   bundle 是 heap 权威——由 facade 注入检查，本模块只覆盖 durable store）。
 *
 * 同时存在 final not-executed + committed proof → proof_conflict（零
 * capability、零 lineage mutation、不删除任何 proof、fail closed）。
 */

import { peekTreasuryReceiptHealth, lookupTreasurySettledReceipt } from "@/runtime/treasury/receipts";
import { readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { readTreasuryIntentEntry, peekTreasuryIntentHealth } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry, peekTreasuryQuarantineHealth } from "@/runtime/treasury/quarantine";
import { readTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import { readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import {
  peekTreasuryAttemptLineageHealth,
  lookupTreasuryAttemptLineageByAttemptId,
  lookupTreasuryAttemptLineageByNextChild,
  type TreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";

export type TreasuryRearmPreflightResult =
  | {
      readonly status: "ready";
      readonly lineage: Readonly<TreasuryAttemptLineageRecord>;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid_input"
        | "lineage_store_unhealthy"
        | "lineage_record_missing"
        | "lineage_not_rearm_ready"
        | "lineage_not_rearmable"
        | "parent_not_resolved"
        | "proof_conflict"
        | "parent_authority_present"
        | "parent_marker_pending"
        | "retirement_incomplete"
        | "receipt_store_unhealthy"
        | "child_identity_occupied";
      readonly detail: string;
    };

/**
 * parent 侧 + durable child 占用的完整 preflight（facade 的
 * issueTreasuryRearmCapability 调用）。heap 侧占用（prepared handle /
 * authorization bundle）由 facade 注入 occupancy 参数补充。
 */
export function preflightTreasuryRearmCapability(input: {
  readonly parentTransactionId: string;
  readonly expectedChildTransactionId?: string;
  /** heap 侧占用检测（facade 注入：prepared handle / bundle 注册表）。 */
  readonly heapChildOccupied?: (childTransactionId: string) => boolean;
}): TreasuryRearmPreflightResult {  if (typeof input.parentTransactionId !== "string" || input.parentTransactionId.length === 0) {
    return { status: "rejected", reason: "invalid_input", detail: "parentTransactionId 缺失或非法" };
  }
  // ── store 健康前置（任一 unhealthy → 零 capability、零 mutation、明确诊断）。
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) {
    return { status: "rejected", reason: "lineage_store_unhealthy", detail: lineageHealth.detail ?? "lineage store 损坏（fail closed）" };
  }
  const receiptHealth = peekTreasuryReceiptHealth();
  if (!receiptHealth.healthy) {
    return { status: "rejected", reason: "receipt_store_unhealthy", detail: receiptHealth.detail ?? "receipt store 损坏（不可信 store 上不得判定 committed proof）" };
  }
  const quarantineHealth = peekTreasuryQuarantineHealth();
  if (!quarantineHealth.healthy) {
    return { status: "rejected", reason: "lineage_store_unhealthy", detail: quarantineHealth.detail ?? "quarantine store 损坏（rearm preflight fail closed）" };
  }
  const intentHealth = peekTreasuryIntentHealth();
  if (!intentHealth.healthy) {
    return { status: "rejected", reason: "lineage_store_unhealthy", detail: intentHealth.detail ?? "intent store 损坏（rearm preflight fail closed）" };
  }
  // ── lineage record：存在 + rearm-ready + rearmable。
  const lineage = lookupTreasuryAttemptLineageByAttemptId(input.parentTransactionId);
  if (lineage === undefined) {
    return {
      status: "rejected",
      reason: "lineage_record_missing",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 无 lineage record（retirement 权威缺失——不存在 final not-executed lineage replacement 或已进入其它状态）`,
    };
  }
  if (lineage.currentTransactionId !== input.parentTransactionId) {
    return {
      status: "rejected",
      reason: "lineage_record_missing",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 不是 lineage 的 current attempt（lineage 已推进到 ${lineage.currentTransactionId.slice(0, 24)}）`,
    };
  }
  if (!lineage.rearmable) {
    return {
      status: "rejected",
      reason: "lineage_not_rearmable",
      detail: `lineage non-rearmable（${lineage.nonRearmReason ?? "未记录原因"}）——不签发 capability`,
    };
  }
  if (lineage.state !== "rearm_ready") {
    return {
      status: "rejected",
      reason: "lineage_not_rearm_ready",
      detail: `lineage 状态 ${String(lineage.state)} 不是 rearm_ready（capability 已签发/接管中/链已关闭）——不可再签发`,
    };
  }
  if (!lineage.retirement.lineagePublished || !lineage.retirement.authorityReleased || !lineage.retirement.markerCleaned) {
    return {
      status: "rejected",
      reason: "retirement_incomplete",
      detail: `lineage retirement 未完整（published=${String(lineage.retirement.lineagePublished)}，released=${String(lineage.retirement.authorityReleased)}，markerCleaned=${String(lineage.retirement.markerCleaned)}）`,
    };
  }
  // ── parent not-executed proof 完整（final tombstone 或 lineage 已接管——
  //    tombstone 可能已被 retention 驱逐，驱逐后 lineage record 即权威）。
  const tombstone = readTreasuryResolutionTombstone(input.parentTransactionId);
  if (tombstone !== undefined) {
    if (tombstone.stage === "resolving") {
      return { status: "rejected", reason: "proof_conflict", detail: "parent 存在 resolving tombstone（resolution 进行中——不可 rearm）" };
    }
    if (tombstone.resolution === "committed") {
      return {
        status: "rejected",
        reason: "proof_conflict",
        detail: `parent 同时存在 not-executed lineage 与 committed tombstone（final not-executed + committed proof 冲突——不删除任何 proof，fail closed）`,
      };
    }
  }
  // ── parent 不存在 committed receipt（final not-executed + committed receipt 冲突）。
  const receiptLookup = lookupTreasurySettledReceipt(input.parentTransactionId);
  if (receiptLookup.status === "modern_committed" || receiptLookup.status === "legacy_committed") {
    return {
      status: "rejected",
      reason: "proof_conflict",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 存在 committed receipt（与 not-executed retirement 冲突——零 capability，不删除任何 proof）`,
    };
  }
  if (receiptLookup.status === "corrupted") {
    return { status: "rejected", reason: "receipt_store_unhealthy", detail: "parent receipt 损坏（不可信 proof 上不得 rearm）" };
  }
  // ── parent authority 已释放 + marker 已清理。
  const parentIntent = readTreasuryIntentEntry(input.parentTransactionId);
  if (parentIntent !== undefined) {
    return { status: "rejected", reason: "parent_authority_present", detail: "parent 仍存在 durable intent authority（rearm 只允许在 authority 完全释放后）" };
  }
  const parentQuarantine = readTreasuryQuarantineEntry(input.parentTransactionId);
  if (parentQuarantine !== undefined) {
    return { status: "rejected", reason: "parent_authority_present", detail: "parent 仍存在 durable quarantine authority（rearm 只允许在 authority 完全释放后）" };
  }
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && marker.transactionId === input.parentTransactionId) {
    return {
      status: "rejected",
      reason: "parent_marker_pending",
      detail: `parent ${input.parentTransactionId.slice(0, 48)} 的 write-fault marker 尚未完成清理——beginTick 补完成或显式处理后才能 rearm`,
    };
  }
  const parentFault = readTreasuryAuthorizationFaultEntry(input.parentTransactionId);
  if (parentFault !== undefined) {
    return { status: "rejected", reason: "parent_authority_present", detail: "parent 仍存在 authorization-fault authority（acknowledge/rollback 完成前不可 rearm）" };
  }
  // ── child 占用（期望 child = lineage.nextChildTransactionId 或注入值）。
  const childId =
    input.expectedChildTransactionId ??
    lineage.nextChildTransactionId ??
    undefined;
  if (childId !== undefined) {
    const occupied = checkTreasuryChildAttemptOccupancy(childId, input.heapChildOccupied, lineage.lineageId);
    if (occupied !== null) {
      return { status: "rejected", reason: "child_identity_occupied", detail: `child ${childId.slice(0, 24)} 已被占用（${occupied}）——不签发 capability、不生成第二个 child` };
    }
  }
  return { status: "ready", lineage };
}

/**
 * child ID 的 durable 占用检测（各 store 单 key lookup；heap 侧由
 * heapChildOccupied 注入）。返回 null = 未占用；否则有界占用描述。
 * excludeLineageId：本 lineage 自身的 next-child/root/current 索引不算
 * 占用（child 就是该 lineage 的派生目标）。
 */
export function checkTreasuryChildAttemptOccupancy(
  childTransactionId: string,
  heapChildOccupied?: (childTransactionId: string) => boolean,
  excludeLineageId?: string,
): string | null {
  const receiptLookup = lookupTreasurySettledReceipt(childTransactionId);
  if (receiptLookup.status !== "absent") {
    return `receipt store（${receiptLookup.status}）`;
  }
  if (readTreasuryResolutionTombstone(childTransactionId) !== undefined) {
    return "resolution tombstone";
  }
  if (readTreasuryIntentEntry(childTransactionId) !== undefined) {
    return "durable intent";
  }
  if (readTreasuryQuarantineEntry(childTransactionId) !== undefined) {
    return "durable quarantine";
  }
  if (readTreasuryAuthorizationFaultEntry(childTransactionId) !== undefined) {
    return "authorization-fault entry";
  }
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && marker.transactionId === childTransactionId) {
    return "write-fault marker";
  }
  const otherLineage = lookupTreasuryAttemptLineageByNextChild(childTransactionId);
  if (otherLineage !== undefined && otherLineage.lineageId !== excludeLineageId) {
    return `另一 lineage 的 next-child 索引（root ${otherLineage.rootTransactionId.slice(0, 24)}）`;
  }
  const asAttempt = lookupTreasuryAttemptLineageByAttemptId(childTransactionId);
  if (asAttempt !== undefined && asAttempt.lineageId !== excludeLineageId) {
    return `另一 lineage 的 current/root 索引（root ${asAttempt.rootTransactionId.slice(0, 24)}）`;
  }
  if (heapChildOccupied !== undefined && heapChildOccupied(childTransactionId)) {
    return "heap prepared handle / authorization bundle";
  }
  return null;
}
