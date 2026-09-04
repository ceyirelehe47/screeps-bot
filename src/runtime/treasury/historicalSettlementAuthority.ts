/**
 * 【Round 22 Remediation VII 修复一】durable settlement authority 的单一
 * resolver——historical / compressed completion 权威进入全局事务真相的
 * 唯一语义入口。
 *
 * Remediation VI 建立了 durable historical completion authority，但它只被
 * cleanup coordinator 消费：prepareTransaction 的 same-ID replay gate、
 * opposite proof matrix、rearm preflight、child occupancy、reconciliation
 * 与 current settlement 查询都不认识它——Receipt / Tombstone 因 retention
 * 消失后，已 committed 的 ID 可以再次 prepare 并执行 Game callback（同一
 * ID 永远只代表一个 execution attempt 的核心不变量被破坏）。
 *
 * 本模块是全库 truth graph 接线的单一入口（不得在六个模块里各自手写
 * lookupTreasuryHistoricalCompletion）：
 *
 *   live cleanup completion（journal 已删、尚未归档的完成事实）
 *   → durable historical completion（Remediation VI 归档权威）
 *   → chain retirement certificate / retired range（Remediation VII 修复四
 *      的 chain 级压缩权威——terminal 后按 chain 而非 per-attempt 存续）
 *
 * 返回语义（单一四态）：
 *  - exact：存在可寻址的持久结算权威（outcome 绑定，不可 relabel）；
 *  - retired：ID 已永久退休但详细 outcome 已压缩（重放一律拒绝——修复四
 *    接线后由 certificate / issuer watermark 承载）；
 *  - conflict：权威之间存在身份/outcome 矛盾（fail closed，不选边）；
 *  - absent：无任何持久结算权威；
 *  - store_unhealthy：任一权威 store 损坏（不折叠为 absent）。
 *
 * 本模块只读（query 零写）；live completion 与 historical 的单条 shape
 * 复验由各自 authority 承载（load 全表 + lookup 单条防御性复验）。
 */

import {
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionHealth,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  lookupTreasuryHistoricalCompletion,
  peekTreasuryCleanupSupersessionHealth,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  lookupTreasuryChainRetirementCertificate,
  lookupTreasuryChainRetirementGenerationOutcome,
  peekTreasuryChainRetirementCertificateHealth,
  checkTreasuryAttemptRetiredRange,
  peekTreasuryRetiredRangeHealth,
} from "@/runtime/treasury/chainRetirementCertificate";
import type { TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";

/** durable settlement 权威来源（报告/诊断用——接线方不得按来源选边）。 */
export type TreasuryDurableSettlementSource =
  | "live-completion"
  | "historical-completion"
  | "chain-certificate";

export type TreasuryDurableSettlementResolution =
  | {
      readonly status: "exact";
      readonly outcome: "committed" | "not-executed";
      readonly source: TreasuryDurableSettlementSource;
      /** 完成事实的记录 tick（live=completedAtTick / historical=archivedAtTick / certificate=finalizedAtTick）。 */
      readonly recordedAtTick?: number;
      readonly detail: string;
    }
  | {
      /** ID 已退休（chain 压缩 / retired range）——详细 outcome 不再逐 attempt 保存，重放一律拒绝。 */
      readonly status: "retired";
      readonly source: "chain-certificate" | "retired-range";
      readonly detail: string;
    }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "absent" }
  | { readonly status: "store_unhealthy"; readonly detail: string };

/**
 * 持久结算权威解析（只读；O(1) 单 key 查询链）。
 *
 * expectedOutcome 提供时按该视角验证（相反 outcome → conflict——settlement
 * relabel 阻断）；expected（exact identity）提供时全维度比较。
 */
export function resolveTreasuryDurableSettlementAuthority(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryExactAttemptIdentity;
  readonly expectedOutcome?: "committed" | "not-executed";
}): TreasuryDurableSettlementResolution {
  // 1) live cleanup completion（最近完成的 attempt——尚未归档）。
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  if (!completionHealth.healthy) {
    return { status: "store_unhealthy", detail: `live completion store unhealthy: ${completionHealth.detail}` };
  }
  const completion = lookupTreasuryCleanupCompletion(input.transactionId, input.expected, input.expectedOutcome);
  if (completion.verdict === "store_unhealthy") {
    return { status: "store_unhealthy", detail: `live completion store unhealthy: ${completion.detail}` };
  }
  if (completion.verdict === "conflict") {
    return { status: "conflict", detail: `live completion 权威冲突: ${completion.detail}` };
  }
  if (completion.verdict === "match") {
    return {
      status: "exact",
      outcome: completion.proof.resolution,
      source: "live-completion",
      recordedAtTick: completion.proof.completedAtTick,
      detail: `live cleanup completion 在位（outcome=${completion.proof.resolution}）`,
    };
  }
  // 2) durable historical completion（Remediation VI 归档权威——跨 GRA/
  //    tombstone retention 存续）。
  const supersessionHealth = peekTreasuryCleanupSupersessionHealth();
  if (!supersessionHealth.healthy) {
    return { status: "store_unhealthy", detail: `historical completion store unhealthy: ${supersessionHealth.detail}` };
  }
  const historical = lookupTreasuryHistoricalCompletion(input.transactionId, input.expected, input.expectedOutcome);
  if (historical.verdict === "store_unhealthy") {
    return { status: "store_unhealthy", detail: `historical completion store unhealthy: ${historical.detail}` };
  }
  if (historical.verdict === "conflict") {
    return { status: "conflict", detail: `historical completion 权威冲突: ${historical.detail}` };
  }
  if (historical.verdict === "match") {
    return {
      status: "exact",
      outcome: historical.record.resolution,
      source: "historical-completion",
      recordedAtTick: historical.record.archivedAtTick,
      detail: `durable historical completion 在位（outcome=${historical.record.resolution}，via=${historical.record.via}）`,
    };
  }
  // 3) chain retirement certificate（terminal 压缩后的 chain 级权威——修复四）。
  const certificateHealth = peekTreasuryChainRetirementCertificateHealth();
  if (!certificateHealth.healthy) {
    return { status: "store_unhealthy", detail: `chain retirement certificate store unhealthy: ${certificateHealth.detail}` };
  }
  const certificate = lookupTreasuryChainRetirementCertificate(input.transactionId);
  if (certificate !== undefined) {
    // root ID 命中 certificate：terminal 终态即权威 outcome。
    const outcome = certificate.terminalState === "chain_committed" ? "committed" : "not-executed";
    if (input.expectedOutcome !== undefined && outcome !== input.expectedOutcome) {
      return {
        status: "conflict",
        detail: `chain certificate settlement=${outcome} 与查询视角 ${input.expectedOutcome} 不一致（outcome 绑定——不得 relabel）`,
      };
    }
    return {
      status: "exact",
      outcome,
      source: "chain-certificate",
      recordedAtTick: certificate.finalizedAtTick,
      detail: `chain retirement certificate 在位（terminal=${certificate.terminalState}，finalGeneration=${String(certificate.finalGeneration)}）`,
    };
  }
  // 4) generation-addressable tr1_ child（certificate 的 chain 内代查询）。
  const generationOutcome = lookupTreasuryChainRetirementGenerationOutcome(input.transactionId);
  if (generationOutcome.verdict === "match") {
    if (input.expectedOutcome !== undefined && generationOutcome.outcome !== input.expectedOutcome) {
      return {
        status: "conflict",
        detail: `chain certificate generation settlement=${generationOutcome.outcome} 与查询视角 ${input.expectedOutcome} 不一致（outcome 绑定）`,
      };
    }
    return {
      status: "exact",
      outcome: generationOutcome.outcome,
      source: "chain-certificate",
      recordedAtTick: generationOutcome.certificate.finalizedAtTick,
      detail: generationOutcome.detail,
    };
  }
  if (generationOutcome.verdict === "conflict") {
    return { status: "conflict", detail: generationOutcome.detail };
  }
  if (generationOutcome.verdict === "store_unhealthy") {
    return { status: "store_unhealthy", detail: generationOutcome.detail };
  }
  // 5) retired range（certificate 已被压缩为区间——ID 永久退休，无详细 outcome）。
  const rangeHealth = peekTreasuryRetiredRangeHealth();
  if (!rangeHealth.healthy) {
    return { status: "store_unhealthy", detail: `retired range store unhealthy: ${rangeHealth.detail}` };
  }
  const retiredRange = checkTreasuryAttemptRetiredRange(input.transactionId);
  if (retiredRange.retired) {
    return {
      status: "retired",
      source: "retired-range",
      detail: `attempt 已进入 retired range（发行序号 ${retiredRange.detail}）——详细 outcome 已压缩，重放一律拒绝`,
    };
  }
  return { status: "absent" };
}
