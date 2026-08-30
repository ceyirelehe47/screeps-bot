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
 * 输入**之前**执行——TypeScript 类型在 Screeps runtime 中不构成实际防线，
 * malformed input（null/undefined、postings 非数组或含 null、decision 缺失
 * 或形状错误、数值非有限整数等）若直接进入 canonical builder 会抛出
 * TypeError 中断整个 tick。返回 null = 形状合法；否则有界静态错误描述
 * （调用方转结构化 rejection，绝不 rethrow）。
 */
export function validateTreasuryTransactionInputShape(input: unknown): string | null {
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
  if (typeof candidate.transactionId !== "string" || candidate.transactionId.length === 0) {
    return "transactionId 缺失或非字符串";
  }
  if (typeof candidate.kind !== "string" || candidate.kind.length === 0) {
    return "kind 缺失或非字符串";
  }
  if (typeof candidate.source !== "string" || candidate.source.length === 0) {
    return "source 缺失或非字符串";
  }
  const decision = candidate.decision as
    | { scope?: unknown; epochSeq?: unknown; observedAtTick?: unknown }
    | null
    | undefined;
  if (decision === null || decision === undefined || typeof decision !== "object") {
    return "decision 缺失或非对象";
  }
  if (decision.scope !== "shared" && decision.scope !== "market-fresh") {
    return "decision.scope 非法";
  }
  if (
    typeof decision.epochSeq !== "number" ||
    !Number.isSafeInteger(decision.epochSeq) ||
    decision.epochSeq <= 0
  ) {
    return "decision.epochSeq 非法（须为正安全整数）";
  }
  if (
    typeof decision.observedAtTick !== "number" ||
    !Number.isSafeInteger(decision.observedAtTick) ||
    decision.observedAtTick < 0
  ) {
    return "decision.observedAtTick 非法（须为非负安全整数）";
  }
  if (!Array.isArray(candidate.postings) || candidate.postings.length === 0) {
    return "postings 缺失或非非空数组";
  }
  for (const posting of candidate.postings as unknown[]) {
    if (posting === null || posting === undefined || typeof posting !== "object") {
      return "posting 为 null/非对象";
    }
    const p = posting as { roomName?: unknown; locationKind?: unknown; resource?: unknown; delta?: unknown };
    if (typeof p.roomName !== "string" || p.roomName.length === 0) {
      return "posting.roomName 缺失或非字符串";
    }
    if (p.locationKind !== "storage" && p.locationKind !== "terminal") {
      return "posting.locationKind 非法";
    }
    if (typeof p.resource !== "string" || p.resource.length === 0) {
      return "posting.resource 缺失或非字符串";
    }
    if (
      typeof p.delta !== "number" ||
      !Number.isFinite(p.delta) ||
      !Number.isInteger(p.delta)
    ) {
      return "posting.delta 非有限整数";
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
