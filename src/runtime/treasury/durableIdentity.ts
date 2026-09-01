/**
 * 统一 immutable durable action identity（第十一轮 3.13.5）。
 *
 * 全部 store（intent 首写幂等、read-back、intent→quarantine 事实转移、
 * quarantine 幂等、双权威一致性、capability 签发、resolution prevalidation、
 * global reset recovery）比较**同一个** durableAuthorityIdentityDigest：
 *
 * - 输入全部为不可变事实：transaction identity、canonical transaction
 *   digest、contract ID/digest、adapter registration identity、action kind、
 *   canonical postings、完整 structure descriptor、durable payload/version、
 *   authorization cohort digest、owner/policy identity、source；
 * - execution outcome 与 settlement 是可变 workflow 事实，**不进入 identity**
 *  （由语义矩阵与单调状态机保护——identity 变化不得伪装成状态迁移）；
 * - 同 transaction ID 但 identity digest 不同 → identity_conflict（store 原
 *   数据不动、writer fail closed、callback 零调用），永远不是 already_
 *   present 幂等；
 * - legacy entry（迁移时无法补全 cohort/descriptor 输入）identity digest 为
 *   空——空对空才匹配；空对非空按 conflict 处置（保守 fail closed）。
 */

import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import type { TreasuryStructureBindingDescriptor } from "@/runtime/treasury/types";

/** identity 计算输入（contract 路径完整；低层 test path 字段可缺省——编码为占位）。 */
export interface TreasuryDurableIdentityInput {
  readonly transactionId: string;
  readonly digest: string;
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly adapterRegistrationId?: string;
  /** 【第十二轮 3.5】稳定 adapter/reconciler 语义身份（contract 路径携带）。 */
  readonly adapterSemanticIdentity?: string;
  readonly actionKind: string;
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly structureFacts?: readonly TreasuryStructureBindingDescriptor[];
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  readonly authorizationCohortDigest?: string;
  readonly ownerIdentity?: string;
  readonly policyIdentity?: string;
  readonly source: string;
  /**
   * 【第十八轮 24.4】tr1_ rearm attempt 的 lineage proof：rearm attempt 的
   * durable identity 必须包含完整 lineage proof（lineageId/generation/
   * parent/binding）；initial attempt 完全不包含。一方携带、一方缺失 →
   * digest 不同 → conflict/insufficient（不得 match）——tr1_ 缺 proof 的旧
   * entry 不得冒充当前 rearm attempt。
   */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly lineageParentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

function descriptorIdentityText(descriptor: TreasuryStructureBindingDescriptor): string {
  const objectId = descriptor.objectId ?? "-";
  const expectedType = descriptor.expectedType ?? "-";
  const expectedRoom = descriptor.expectedRoom ?? "-";
  return `${descriptor.bindingKind}:${descriptor.role}:${descriptor.roomName}:${descriptor.locationKind}:${objectId}:${expectedType}:${expectedRoom}:${descriptor.required ? "1" : "0"}:${descriptor.structureId}`;
}

/**
 * 计算 durable authority identity digest（与 bounded facts 线性）。
 * 空/缺省字段以 "-" 占位编码（缺省与显式空串可区分：undefined → "-"，
 * 空串 → "e:"）——同 ID 不同输入永不碰撞。
 */
export function computeTreasuryDurableIdentityDigest(input: TreasuryDurableIdentityInput): string {
  const parts: string[] = [
    `t:${String(input.transactionId.length)}:${input.transactionId}`,
    `d:${String(input.digest.length)}:${input.digest}`,
    `cid:${input.contractId === undefined ? "-" : `${String(input.contractId.length)}:${input.contractId}`}`,
    `cd:${input.contractDigest === undefined ? "-" : input.contractDigest}`,
    `ar:${input.adapterRegistrationId === undefined ? "-" : input.adapterRegistrationId}`,
    `asi:${input.adapterSemanticIdentity === undefined ? "-" : `${String(input.adapterSemanticIdentity.length)}:${input.adapterSemanticIdentity}`}`,
    `k:${String(input.actionKind.length)}:${input.actionKind}`,
    `p:${input.postings
      .map((leg) => `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}\u0000${String(leg.delta)}`)
      .sort()
      .map((leg) => String(leg.length) + ":" + leg)
      .join(",")}`,
    `sd:${
      input.structureFacts === undefined
        ? "-"
        : input.structureFacts
            .map(descriptorIdentityText)
            .sort()
            .map((text) => `${String(text.length)}:${text}`)
            .join(",")
    }`,
    `dp:${input.durablePayload === undefined ? "-" : `${String(input.durablePayloadVersion ?? 0)}:${input.durablePayload}`}`,
    `ac:${input.authorizationCohortDigest === undefined ? "-" : input.authorizationCohortDigest}`,
    `o:${input.ownerIdentity === undefined ? "-" : `${String(input.ownerIdentity.length)}:${input.ownerIdentity}`}`,
    `pi:${input.policyIdentity === undefined ? "-" : `${String(input.policyIdentity.length)}:${input.policyIdentity}`}`,
    `s:${String(input.source.length)}:${input.source}`,
    `li:${input.lineageId === undefined ? "-" : input.lineageId}`,
    `lg:${input.lineageGeneration === undefined ? "-" : String(input.lineageGeneration)}`,
    `lp:${input.lineageParentTransactionId === undefined ? "-" : `${String(input.lineageParentTransactionId.length)}:${input.lineageParentTransactionId}`}`,
    `lb:${input.lineageBindingDigest === undefined ? "-" : input.lineageBindingDigest}`,
  ];
  return hashTreasuryCanonicalString(`durable-identity:${parts.join("|")}`);
}

/**
 * 统一 identity 匹配规则（所有 store 共用）：双方 digest 都存在且相等 →
 * 匹配；都为空（legacy entry）→ 匹配；一方存在一方为空/不同 → 不匹配
 * （identity_conflict）。null 输入（entry 无该字段）与 undefined 同义。
 */
export function treasuryDurableIdentitiesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftEmpty = left === undefined || left === null || left === "";
  const rightEmpty = right === undefined || right === null || right === "";
  if (leftEmpty && rightEmpty) return true;
  if (leftEmpty || rightEmpty) return false;
  return left === right;
}
