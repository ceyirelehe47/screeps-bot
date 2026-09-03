/**
 * 【Round 22 Remediation IV 七】exact authority discharge——Authority 释放
 * 的唯一实现（gate 验证与 release 位于同一同步窗口）。
 *
 * Remediation III 的 authorityRelease handler 按 transactionId 解析后直接
 * releaseTreasuryQuarantineEntry / releaseTreasuryIntentEntry——本模块把
 * 释放收敛为"先完整 gate、后释放、再 read-back"：
 *
 *   pre-release gate（journal ↔ proof ↔ opposite ↔ lineage ↔ authority 全
 *   exact match，或合法中断窗口的 authority_absent_recoverable）
 *     → Intent/Quarantine：release + resolver read-back 必须 not_found
 *     → Authorization Fault：完整 exact match 后 release + read-back absent
 *     → gate 任一失败：零 release（同 transaction ID 的身份冲突 Authority
 *       不得被当作另一合法 attempt 删除）
 *
 * TOCTOU 防护：gate 与 release 在同一同步调用栈内完成；release 前不信任
 * 任何外部传入的 gate 结论（handler 每次重验）。marker 阶段已 ack 是
 * release 的前置阶段偏序（journal 阶段偏序由 coordinator 承载，本模块
 * 只在 gate 的 absent-recoverable 判定中复验）。
 */

import { gateTreasuryPreReleaseSettlement } from "@/runtime/treasury/preReleaseSettlementGate";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { releaseTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  readTreasuryAuthorizationFaultEntry,
  releaseTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import type { TreasuryResolutionCleanupEntry } from "@/runtime/treasury/resolutionCleanupJournal";

export type TreasuryExactAuthorityDischargeResult =
  | { readonly status: "released"; readonly detail: string; readonly authoritySource: "intent-quarantine" | "authorization-fault" }
  | { readonly status: "already_absent"; readonly detail: string }
  | { readonly status: "blocked"; readonly gateStatus: string; readonly detail: string };

/**
 * 释放属于 journal entry 同一 exact attempt 的 Authority（唯一 release
 * 入口——stage handler 委托；任何其它路径不得直接按 transactionId 释放）。
 */
export function dischargeTreasuryExactAuthorityForCleanup(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
): TreasuryExactAuthorityDischargeResult {
  const gate = gateTreasuryPreReleaseSettlement(entry);
  switch (gate.status) {
    case "verified": {
      if (gate.authoritySource === "authorization-fault") {
        releaseTreasuryAuthorizationFaultEntry(entry.transactionId);
        if (readTreasuryAuthorizationFaultEntry(entry.transactionId) !== undefined) {
          return { status: "blocked", gateStatus: gate.status, detail: "authorization fault 释放后 read-back 仍存在（重试）" };
        }
        return { status: "released", authoritySource: "authorization-fault", detail: "authorization fault entry 已释放并 read-back 确认消失" };
      }
      releaseTreasuryQuarantineEntry(entry.transactionId);
      releaseTreasuryIntentEntry(entry.transactionId);
      const readBack = resolveTreasuryUnresolvedAuthority(entry.transactionId);
      if (readBack.status !== "not_found") {
        // release 后仍存在 / inconsistent / store unhealthy：authority 阶段
        // 不得 ack（read-back 非 not_found 即阻断——outcome 不推进）。
        return {
          status: "blocked",
          gateStatus: gate.status,
          detail: `release 后 read-back 仍非 not_found（${readBack.status}——authority 阶段不得 ack）`,
        };
      }
      return { status: "released", authoritySource: "intent-quarantine", detail: "已释放并 read-back 确认 not_found" };
    }
    case "authority_absent_recoverable":
      // resolver not_found + authorization fault 不存在 + marker 已 ack +
      // target proof 匹配 + opposite 确证 absent + store 健康（gate 已验）。
      return { status: "already_absent", detail: gate.detail };
    default:
      return { status: "blocked", gateStatus: gate.status, detail: `${gate.status}: ${gate.detail}` };
  }
}
