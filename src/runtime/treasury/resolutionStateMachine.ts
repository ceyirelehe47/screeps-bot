/**
 * 【第十五轮第六节】resolution tombstone 的不可逆状态机（唯一权威）。
 *
 * 背景：同 ID 覆盖此前只检查 proof level 与三个身份字段——`resolving
 * committed` 可被覆盖为 `final not-executed`（结论可逆）、digest / action
 * tick / 观察身份可漂移、final tombstone 可被改写。本模块把全部合法转换
 * 显式化，resolutionStore 的每次写入（创建 / finalize / 幂等重复）都必须
 * 经 validateTreasuryResolutionTombstoneTransition 判定——任意调用者无法
 * 构造自由状态更新。
 *
 * 合法转换全集：
 *
 * ```text
 * absent ──create──▶ resolving committed ──finalize──▶ final committed
 *    │                                              （保持全部安全关键字段；
 *    │                                                仅 stage 与 resolvedAtTick
 *    └────────create───────▶ final not-executed        单调推进可变）
 *
 * resolving committed ──idempotent──▶ resolving committed（同完整内容）
 * final（committed / not-executed）──idempotent──▶ 同状态（同完整内容）
 * 其余一切转换（resolving committed → final not-executed / resolving
 * not-executed、final → resolving、final committed ↔ final not-executed、
 * 同 ID 改 digest / proofLevel / attempt identity / actionTick / 结论、
 * settledAtTick 降低）一律拒绝——原 tombstone 完全不变。
 * ```
 */

import type { TreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";

export type TreasuryResolutionTransitionVerdict =
  | { readonly status: "allowed_create" }
  | { readonly status: "allowed_finalize" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * finalize / 幂等比较中必须完全一致的安全关键字段（§6.2/§6.4）：结论、
 * digest、proof level、完整 attempt identity、action tick、observation 与
 * reconciler 身份、settledAtTick、forensic/legacy provenance、preExecution
 * 标志。resolvedAtTick 单独按单调规则处理。
 */
const TREASURY_RESOLUTION_INVARIANT_FIELDS: readonly (readonly [
  field: keyof Pick<
    TreasuryResolutionTombstone,
    | "transactionId"
    | "digest"
    | "resolution"
    | "proofLevel"
    | "contractDigest"
    | "authorizationCohortDigest"
    | "durableIdentityDigest"
    | "lowlevelSource"
    | "actionTick"
    | "settledAtTick"
    | "observationTick"
    | "reconcilerKind"
    | "source"
    | "preExecution"
  >,
  describe: string,
])[] = [
  ["transactionId", "transaction ID"],
  ["digest", "digest"],
  ["resolution", "resolution kind"],
  ["proofLevel", "proof level"],
  ["contractDigest", "attempt identity（contractDigest）"],
  ["authorizationCohortDigest", "attempt identity（authorizationCohortDigest）"],
  ["durableIdentityDigest", "attempt identity（durableIdentityDigest）"],
  ["lowlevelSource", "lowlevel provenance（lowlevelSource）"],
  ["actionTick", "action tick"],
  ["settledAtTick", "settledAtTick"],
  ["observationTick", "observation tick"],
  ["reconcilerKind", "reconciler kind"],
  ["source", "source"],
  ["preExecution", "pre-execution 标志"],
];

/** optional 字段的 undefined 规范化比较（null 与 undefined 视为缺失）。 */
function normalizedEqual(left: unknown, right: unknown): boolean {
  return (left === undefined || left === null ? undefined : left) === (right === undefined || right === null ? undefined : right);
}

/** forensic provenance 的有界深度比较（普通对象/数组逐键；无共享可变语义）。 */
function boundedDeepEqual(left: unknown, right: unknown, depth: number): boolean {
  if (depth > 6) return Object.is(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => boundedDeepEqual(item, right[index], depth + 1));
  }
  if (left !== null && typeof left === "object" && right !== null && typeof right === "object" && !Array.isArray(right)) {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      key in (right as Record<string, unknown>) &&
      boundedDeepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1),
    );
  }
  return Object.is(left, right);
}

/** 找到第一个不一致的安全关键字段（null = 全部一致）。 */
function firstInvariantMismatch(
  existing: TreasuryResolutionTombstone,
  next: TreasuryResolutionTombstone,
): readonly [field: string, describe: string] | null {
  for (const [field, describe] of TREASURY_RESOLUTION_INVARIANT_FIELDS) {
    if (!normalizedEqual(existing[field], next[field])) {
      return [field, describe];
    }
  }
  if (!boundedDeepEqual(existing.forensicProvenance, next.forensicProvenance, 0)) {
    return ["forensicProvenance", "forensic provenance"];
  }
  return null;
}

/**
 * 判定 tombstone 写入请求相对既有 entry 的转换合法性（纯函数）：
 * - existing === undefined：只允许 absent → resolving committed 与
 *   absent → final not-executed（其余任何"直接造 final committed /
 *   resolving not-executed"的创建拒绝）；
 * - existing.stage === "resolving"（唯一合法形态 resolving committed）：
 *   - next 同为 resolving committed 且全部字段（含 resolvedAtTick）一致 →
 *     idempotent；
 *   - next 为 final committed 且全部安全关键字段一致、resolvedAtTick 单调
 *     不降 → allowed_finalize；
 *   - 其余（结论 / digest / identity / settledAtTick 变化、resolving
 *     not-executed、降 resolvedAtTick）→ rejected；
 * - existing.stage === "final"：next 与既有全部字段（含 resolvedAtTick）
 *   完全一致 → idempotent（exact idempotence，非覆盖写）；任何差异 →
 *   rejected（final 不可回退、不可改结论、不可降 tick）。
 */
export function validateTreasuryResolutionTombstoneTransition(
  existing: TreasuryResolutionTombstone | undefined,
  next: TreasuryResolutionTombstone,
): TreasuryResolutionTransitionVerdict {
  if (existing === undefined) {
    if (next.stage === "resolving" && next.resolution === "committed") {
      return { status: "allowed_create" };
    }
    if (next.stage === "final" && next.resolution === "not-executed") {
      return { status: "allowed_create" };
    }
    return {
      status: "rejected",
      detail: `非法创建：absent 只能创建 resolving committed 或 final not-executed（got stage=${next.stage} resolution=${next.resolution}）——不得直接构造 final committed / resolving not-executed`,
    };
  }
  if (existing.stage === "final") {
    const mismatch = firstInvariantMismatch(existing, next);
    if (mismatch !== null) {
      return {
        status: "rejected",
        detail: `final tombstone 不可改写：${mismatch[1]}（${mismatch[0]}）与既有不一致——fail closed，原数据不动`,
      };
    }
    if (existing.resolvedAtTick !== next.resolvedAtTick) {
      return {
        status: "rejected",
        detail: `final tombstone 不可改写：resolvedAtTick（既有 ${String(existing.resolvedAtTick)}，新 ${String(next.resolvedAtTick)}）——final 幂等只允许完整内容一致`,
      };
    }
    if (next.stage !== "final") {
      return {
        status: "rejected",
        detail: `final → ${next.stage} 非法（resolution 终态不可回退到 resolving）——fail closed，原数据不动`,
      };
    }
    return { status: "idempotent" };
  }
  // existing.stage === "resolving"：唯一合法进行中形态是 resolving committed。
  if (existing.resolution !== "committed") {
    return {
      status: "rejected",
      detail: `resolving ${existing.resolution} 为非法持久形态（防御——只允许 resolving committed），拒绝一切后续写入`,
    };
  }
  const mismatch = firstInvariantMismatch(existing, next);
  if (mismatch !== null) {
    return {
      status: "rejected",
      detail: `resolving committed 的更新改变了 ${mismatch[1]}（${mismatch[0]}）——finalize 只允许 stage 与 resolvedAtTick 推进，fail closed，原数据不动`,
    };
  }
  if (next.stage === "resolving") {
    if (next.resolution !== "committed") {
      return {
        status: "rejected",
        detail: "resolving committed → resolving not-executed 非法（结论不可改变）——fail closed，原数据不动",
      };
    }
    if (next.resolvedAtTick !== existing.resolvedAtTick) {
      return {
        status: "rejected",
        detail: `resolving 重写的 resolvedAtTick 漂移（既有 ${String(existing.resolvedAtTick)}，新 ${String(next.resolvedAtTick)}）——幂等只允许完整内容一致`,
      };
    }
    return { status: "idempotent" };
  }
  // next.stage === "final"：唯一合法 finalize 目标是 final committed。
  if (next.resolution !== "committed") {
    return {
      status: "rejected",
      detail: `resolving committed → final ${next.resolution} 非法（resolving committed 只能 finalize 为 final committed；结论不可逆）——fail closed，原数据不动`,
    };
  }
  if (next.resolvedAtTick < existing.resolvedAtTick) {
    return {
      status: "rejected",
      detail: `finalize 的 resolvedAtTick 降低（既有 ${String(existing.resolvedAtTick)}，新 ${String(next.resolvedAtTick)}）——只允许单调推进`,
    };
  }
  return { status: "allowed_finalize" };
}
