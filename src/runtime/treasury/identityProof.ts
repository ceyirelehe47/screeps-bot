/**
 * 【第十二轮 3.6】统一的 durable identity / cohort digest 重算验证。
 *
 * 原则：digest 是持久事实的**派生证明**，不是可被独立信任的事实。所有
 * store（intent / quarantine / authorization-fault / resolution proof /
 * receipt settlement proof）在写入前、写入后 read-back、global reset 首次
 * load、migration、intent → quarantine 转移、双 authority 一致性、
 * capability 签发与 resolution prevalidation 都必须**从持久事实重算并比较**
 * ——不信任 entry 自带的 digest 字符串。事实被篡改而 digest 未同步变化
 * → 判定 store unhealthy / identity conflict / authority inconsistent
 * （fail closed，绝不自动覆盖 digest 修复）。
 *
 * 复用单一 canonical helper（durableIdentity / authorization），各 store
 * 不得自行实现近似算法。
 */

import {
  computeTreasuryDurableIdentityDigest,
  type TreasuryDurableIdentityInput,
} from "@/runtime/treasury/durableIdentity";
import {
  computeTreasuryAuthorizationCohortDigest,
  type TreasuryAuthorizationCohortFacts,
} from "@/runtime/treasury/authorization";
import type { TreasuryStructureBindingDescriptor } from "@/runtime/treasury/types";
import { validateTreasuryStructureDescriptorArray } from "@/runtime/treasury/structureDescriptorValidation";

/** intent / quarantine / authorization-fault entry 的共同身份事实视图。 */
export interface TreasuryIdentityFactsEntry {
  readonly transactionId: string;
  readonly digest: string;
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly adapterVersion?: number;
  readonly adapterRegistrationId?: string;
  readonly adapterSemanticIdentity?: string;
  readonly actionKind?: string;
  readonly kind?: string;
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  readonly structureFacts?: readonly (TreasuryStructureBindingDescriptor | { readonly [key: string]: unknown })[];
  readonly authorizationCohort?: TreasuryAuthorizationCohortFacts;
  readonly authorizationCohortDigest?: string;
  readonly ownerIdentity?: string;
  readonly policyIdentity?: string;
  readonly source?: string;
  readonly postings?:
    | readonly { roomName: string; locationKind: string; resource: string; delta: number }[]
    | readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly deltas?: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly durableIdentityDigest?: string;
}

/**
 * 从 entry 的持久不可变事实重算 durable identity digest（不信任 entry 自带
 * 的 durableIdentityDigest；postings 缺失时返回 null——无法重算即无法证明）。
 */
export function recomputeTreasuryDurableIdentityDigest(entry: TreasuryIdentityFactsEntry): string | null {
  // 【第十三轮第九节】重算异常边界：malformed/throwing facts（含
  // structureFacts 的脏 descriptor——canonical 文本直接解引用字段）一律
  // 返回 null（身份不可证明），绝不抛出中断 tick。
  try {
    const postings = entry.postings ?? entry.deltas;
    if (postings === undefined) return null;
    // 【第十三轮第十节】structureFacts 前置共享 descriptor 校验：脏
    // descriptor（union 矛盾/缺字段）不得进入 identity 计算——无法重算。
    if (entry.structureFacts !== undefined && validateTreasuryStructureDescriptorArray(entry.structureFacts, 16) !== null) {
      return null;
    }
    const input: TreasuryDurableIdentityInput = {
      transactionId: entry.transactionId,
      digest: entry.digest,
      actionKind: entry.actionKind ?? entry.kind ?? "",
      postings: postings.map((leg) => ({ ...leg })),
      source: entry.source ?? "",
      ...(entry.contractId !== undefined ? { contractId: entry.contractId } : {}),
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.adapterRegistrationId !== undefined ? { adapterRegistrationId: entry.adapterRegistrationId } : {}),
      ...(entry.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: entry.adapterSemanticIdentity } : {}),
      ...(entry.durablePayload !== undefined ? { durablePayload: entry.durablePayload } : {}),
      ...(entry.durablePayloadVersion !== undefined ? { durablePayloadVersion: entry.durablePayloadVersion } : {}),
      ...(entry.structureFacts !== undefined
        ? { structureFacts: entry.structureFacts as readonly TreasuryStructureBindingDescriptor[] }
        : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.ownerIdentity !== undefined ? { ownerIdentity: entry.ownerIdentity } : {}),
      ...(entry.policyIdentity !== undefined ? { policyIdentity: entry.policyIdentity } : {}),
    };
    if (input.actionKind === "" || input.source === "") return null;
    return computeTreasuryDurableIdentityDigest(input);
  } catch {
    return null;
  }
}

/**
 * 从持久化的 canonical cohort facts 重算 cohort digest（不重新执行 policy
 * resolver、不信任 entry 自带的 authorizationCohortDigest）。cohort facts
 * 缺失或重算异常（throwing Proxy/malformed——canonical 文本直接解引用全部
 * 字段）都返回 null——重算永不抛出（【第十三轮第九节】异常边界）。
 */
export function recomputeTreasuryCohortDigest(entry: TreasuryIdentityFactsEntry): string | null {
  if (entry.authorizationCohort === undefined) return null;
  try {
    return computeTreasuryAuthorizationCohortDigest(entry.authorizationCohort);
  } catch {
    return null;
  }
}

/**
 * entry 身份一致性验证（load 全量校验 / 写入前 / read-back / capability
 * 签发 / resolution prevalidation 共用）：
 * - cohort：facts 与 digest 双方都存在时必须重算一致（只有一方 = legacy，
 *   不判损坏）；
 * - durableIdentityDigest：存在时必须能从事实重算且一致（无法重算或
 *   不一致 = 身份不可证明 → fail closed）。
 * 返回 null = 一致（或全部 legacy 缺省），否则有界错误描述。
 */
export function verifyTreasuryEntryIdentity(entry: TreasuryIdentityFactsEntry, label: string): string | null {
  const recomputedCohort = recomputeTreasuryCohortDigest(entry);
  if (recomputedCohort !== null && entry.authorizationCohortDigest !== undefined && recomputedCohort !== entry.authorizationCohortDigest) {
    return `${label} authorizationCohortDigest 与持久 cohort facts 重算不一致（entry ${entry.authorizationCohortDigest.slice(0, 16)}，重算 ${recomputedCohort.slice(0, 16)}）——身份不可证明，fail closed`;
  }
  if (entry.durableIdentityDigest !== undefined) {
    const recomputed = recomputeTreasuryDurableIdentityDigest(entry);
    if (recomputed === null) {
      return `${label} durableIdentityDigest 存在但持久事实不足以重算（fail closed，不得信任自带 digest）`;
    }
    if (recomputed !== entry.durableIdentityDigest) {
      return `${label} durableIdentityDigest 与持久事实重算不一致（entry ${entry.durableIdentityDigest.slice(0, 16)}，重算 ${recomputed.slice(0, 16)}）——fail closed`;
    }
  }
  return null;
}

/**
 * attempt identity（tombstone / receipt settlement proof / finalized proof 的绑定形状）。
 * 【第十六轮第十一节】lowlevelSource 是 lowlevel attempt identity 的组成
 * 部分：runtime-lowlevel 与 migrated-lowlevel 不能互相证明。
 */
export interface TreasuryAttemptIdentity {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  /** lowlevel provenance（受控枚举；modern attempt 不携带）。 */
  readonly lowlevelSource?: string;
}

/**
 * 证明载体（tombstone / settlement proof）是否绑定与 attempt 完全一致的
 * 身份（3.3/3.4）：attempt 携带的每个身份成分，proof 必须同样携带且相等；
 * attempt 无现代身份成分（legacy attempt）时退化为 digest 精确匹配。
 * mismatch = "conflict"（同 id 不同 attempt，不得 already_resolved / 释放）；
 * "insufficient" = proof 缺少现代身份事实（legacy proof，不能证明现代
 * attempt）；null = 匹配。
 *
 * 【第十六轮第十一节】lowlevel provenance 绑定（单向）：attempt 携带
 * lowlevelSource 时 proof 必须同样携带且相等（缺失 = insufficient——旧
 * proof 来源不可证明，隔离不释放；不等 = conflict——runtime 与 migrated
 * 不能互相证明）；attempt 不携带时不比较该维度（marker attemptIdentity
 * 等部分身份视图无 provenance 字段——proof 更完整不构成矛盾；低层 proof
 * 不得证明非低层 attempt由 capability prevalidate 的显式等级校验承载）。
 */
export function treasuryAttemptIdentityRelation(
  proof: { readonly digest: string; readonly contractDigest?: string; readonly authorizationCohortDigest?: string; readonly durableIdentityDigest?: string; readonly lowlevelSource?: string },
  attempt: TreasuryAttemptIdentity,
): "match" | "conflict" | "insufficient" {
  if (proof.digest !== attempt.digest) return "conflict";
  if (attempt.lowlevelSource !== undefined) {
    if (proof.lowlevelSource === undefined) return "insufficient";
    if (proof.lowlevelSource !== attempt.lowlevelSource) return "conflict";
  }
  const attemptModern =
    attempt.durableIdentityDigest !== undefined || attempt.authorizationCohortDigest !== undefined;
  if (!attemptModern) {
    if (attempt.contractDigest !== undefined && proof.contractDigest !== attempt.contractDigest) return "conflict";
    return "match";
  }
  if (attempt.durableIdentityDigest !== undefined) {
    if (proof.durableIdentityDigest === undefined) return "insufficient";
    if (proof.durableIdentityDigest !== attempt.durableIdentityDigest) return "conflict";
  }
  if (attempt.authorizationCohortDigest !== undefined) {
    if (proof.authorizationCohortDigest === undefined) return "insufficient";
    if (proof.authorizationCohortDigest !== attempt.authorizationCohortDigest) return "conflict";
  }
  if (attempt.contractDigest !== undefined && proof.contractDigest !== attempt.contractDigest) return "conflict";
  return "match";
}
