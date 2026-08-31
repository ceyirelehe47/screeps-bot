/**
 * 【第十七轮第十一节】lineage/rearm binding digest——rearm child attempt 的
 * 稳定 lineage 身份，进入全部 durable proof 链。
 *
 * 派生：lineageId + child generation + parent transaction ID + child
 * transaction ID（canonical 编码 + 稳定 hash，16hex 定长）。绑定规则：
 * - 不同 lineage、不同 generation、不同 parent/child 的 proof 不能互相证明；
 * - 同 child ID 但 lineage digest 不同 → identity conflict；
 * - initial 非 rearm attempt 不得携带 lineage binding；
 * - tr1_ attempt 缺少 lineage binding → modern/lowlevel store unhealthy 或
 *   forensic，不得自动解释成普通 attempt。
 */

import { encodeTreasuryCanonicalTuple, hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

const LINEAGE_BINDING_PROTOCOL = "treasury-lineage-binding@v1";

export function computeTreasuryLineageBindingDigest(input: {
  readonly lineageId: string;
  readonly generation: number;
  readonly parentTransactionId: string;
  readonly childTransactionId: string;
}): string {
  return hashTreasuryCanonicalString(
    `${LINEAGE_BINDING_PROTOCOL}:${encodeTreasuryCanonicalTuple([
      input.lineageId,
      input.generation,
      input.parentTransactionId,
      input.childTransactionId,
    ])}`,
  );
}

/**
 * binding 一致性比较（intent/quarantine/receipt/tombstone/marker 的
 * cross-store 验证共用）：双方都存在且相等 → 一致；双方都缺失 → 一致
 * （均非 rearm attempt）；一方存在一方缺失 → 不一致（conflict——tr1_
 * attempt 缺 binding 不得解释成普通 attempt；普通 attempt 携带 binding
 * 同样是身份矛盾）。
 */
export function treasuryLineageBindingsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftEmpty = left === undefined || left === null || left === "";
  const rightEmpty = right === undefined || right === null || right === "";
  if (leftEmpty && rightEmpty) return true;
  if (leftEmpty || rightEmpty) return false;
  return left === right;
}
