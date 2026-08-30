/**
 * Treasury canonical transaction snapshot 与 payload digest。
 *
 * 两阶段 prepare 的安全基座（第五轮新增）：
 * - prepare 不得保存调用方可修改的原 input 引用——canonical snapshot 对
 *   输入做深复制（transactionId/kind/source/decision/postings 逐字段复制），
 *   postings 按 (room, location, resource) 字典序规范排序后逐层冻结；
 *   prepare 之后调用方原地修改原数组/对象不影响 Treasury 内部的 canonical
 *   transaction；
 * - payload digest 覆盖 transaction identity、kind、source、decision epoch
 *   （scope/epochSeq/observedAtTick）与全部 canonical postings（规范排序后
 *   逐腿编码）——相同 transactionId 重复 prepare 时：digest 相同 → 幂等
 *   返回同一 handle；digest 不同 → prepare_conflict。digest 复用
 *   transactionId 的稳定 hash 核（双 lane FNV-1a 64 位，16 hex 定长）。
 */

import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import type {
  TreasuryLocationKind,
  TreasuryObservationScope,
  TreasuryTransactionInput,
} from "@/runtime/treasury/types";

export interface TreasuryCanonicalPosting {
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  readonly delta: number;
}

/** 深复制 + 规范排序 + 冻结的 transaction snapshot（prepare 的权威载荷）。 */
export interface TreasuryCanonicalTransaction {
  readonly transactionId: string;
  readonly kind: string;
  readonly source: string;
  readonly decisionScope: TreasuryObservationScope;
  readonly decisionEpochSeq: number;
  readonly decisionObservedAtTick: number;
  /** 规范排序（room/location/resource 字典序）后的冻结 postings 副本。 */
  readonly postings: readonly TreasuryCanonicalPosting[];
}

function canonicalPostingKey(posting: TreasuryCanonicalPosting): string {
  return `${posting.roomName}\u0000${posting.locationKind}\u0000${posting.resource}`;
}

/**
 * 构建 canonical snapshot：逐字段深复制（不保留调用方任何可变引用），
 * postings 按 (room, location, resource) 排序后逐条冻结并冻结数组。
 * 排序保证相同 postings 集合的 digest 与输入顺序无关（canonical 排序
 * 结果本身就是 digest 的一部分）。
 */
export function buildTreasuryCanonicalTransaction(input: TreasuryTransactionInput): TreasuryCanonicalTransaction {
  const postings = input.postings
    .map((posting) =>
      Object.freeze({
        roomName: posting.roomName,
        locationKind: posting.locationKind,
        resource: posting.resource,
        delta: posting.delta,
      }),
    )
    .sort((a, b) => (canonicalPostingKey(a) < canonicalPostingKey(b) ? -1 : canonicalPostingKey(a) > canonicalPostingKey(b) ? 1 : 0));
  return Object.freeze({
    transactionId: input.transactionId,
    kind: input.kind,
    source: input.source,
    decisionScope: input.decision.scope,
    decisionEpochSeq: input.decision.epochSeq,
    decisionObservedAtTick: input.decision.observedAtTick,
    postings: Object.freeze(postings),
  });
}

/**
 * canonical payload digest（16 hex 定长）：覆盖 identity/kind/source/
 * decision epoch（scope + epochSeq + observedAtTick）/全部 canonical
 * postings（规范排序后逐腿 room/location/resource/delta 编码）。
 */
export function computeTreasuryPayloadDigest(canonical: TreasuryCanonicalTransaction): string {
  let encoded = `D1`;
  encoded += `s:${String(canonical.transactionId.length)}:${canonical.transactionId}`;
  encoded += `s:${String(canonical.kind.length)}:${canonical.kind}`;
  encoded += `s:${String(canonical.source.length)}:${canonical.source}`;
  encoded += `s:${String(canonical.decisionScope.length)}:${canonical.decisionScope}`;
  encoded += `n:${String(canonical.decisionEpochSeq)}`;
  encoded += `n:${String(canonical.decisionObservedAtTick)}`;
  for (const posting of canonical.postings) {
    encoded += `s:${String(posting.roomName.length)}:${posting.roomName}`;
    encoded += `s:${String(posting.locationKind.length)}:${posting.locationKind}`;
    encoded += `s:${String(posting.resource.length)}:${posting.resource}`;
    encoded += `n:${String(posting.delta)}`;
  }
  return hashTreasuryCanonicalString(encoded);
}
