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

/**
 * runtime input 形状验证（第六轮）：在读取、遍历、digest 或 canonicalize
 * 输入**之前**执行——TypeScript 类型在 Screeps runtime 中不构成实际防线。
 *
 * 防卫范围（最小防 throw 集）：只拦截会让后续读取/canonicalize **抛出
 * TypeError** 的形状（input 非对象、transactionId/kind/source 非字符串、
 * decision 缺失或非对象或 scope 非字符串、postings 非数组、posting 非对象）。
 * 字段值语义（transactionId 边界字符、resource 合法性、delta 非零安全整数、
 * decision 数值关系等）仍由既有 deep validation / epoch 注册表结构化拒绝
 * （invalid_transaction_id / invalid_posting_* / stale_epoch 等 reason 保持
 * 兼容——前置层不吞并更精确的语义 reason）。
 *
 * mode：
 * - "prepare"（默认）：两阶段 prepare/executePreparedAction——canonical
 *   builder 会读取 decision.scope，缺失/非字符串会 throw，必须前置拦截；
 * - "record"：单阶段兼容入口——decision 语义校验由 facade epoch 注册表
 *   负责（缺失 → stale_epoch 既有语义），前置只拦其余防 throw 项。
 *
 * 返回 null = 形状合法；否则有界静态错误描述（调用方转结构化 rejection，
 * 绝不 rethrow）。
 */
export type TreasuryInputGuardMode = "prepare" | "record";

export function validateTreasuryTransactionInputShape(
  input: unknown,
  mode: TreasuryInputGuardMode = "prepare",
): string | null {
  if (input === null || input === undefined || typeof input !== "object") {
    return "input 缺失或非对象";
  }
  const candidate = input as {
    transactionId?: unknown;
    kind?: unknown;
    source?: unknown;
    decision?: unknown;
    postings?: unknown;
  };
  if (typeof candidate.transactionId !== "string") {
    return "transactionId 非字符串";
  }
  if (typeof candidate.kind !== "string") {
    return "kind 非字符串";
  }
  if (typeof candidate.source !== "string") {
    return "source 非字符串";
  }
  if (mode === "prepare") {
    const decision = candidate.decision as { scope?: unknown } | null | undefined;
    if (decision === null || decision === undefined || typeof decision !== "object") {
      return "decision 缺失或非对象";
    }
    if (typeof decision.scope !== "string") {
      return "decision.scope 非字符串";
    }
  }
  if (!Array.isArray(candidate.postings)) {
    return "postings 非数组";
  }
  for (const posting of candidate.postings as unknown[]) {
    if (posting === null || posting === undefined || typeof posting !== "object") {
      return "posting 为 null/非对象";
    }
  }
  return null;
}

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
