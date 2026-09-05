/**
 * Treasury Core Kernel——身份铸造与许可签发。
 *
 * 契约（design §5.2 / §5.3）：
 * - 外部调用者不能按任意指定 ID 创建、复活或执行 attempt。创建和 rearm
 *   只经内核分配新身份（单调 frontier + 域分离哈希）；分配失败烧掉序号，
 *   frontier 不回退，洞不变成可执行记录，也不为洞建立永久证明。
 * - permit 是 heap-only opaque 对象（私有品牌字段 + WeakSet 注册），跨
 *   tick / runtime generation 失效；字符串或普通对象不是许可。
 * - 身份冲突判定比较完整事实（canonicalDigest / postingsDigest /
 *   adapter 语义身份 / retryFactsDigest），“字段可构造”≠“身份匹配”。
 */

import {
  TREASURY_CORE_ATTEMPT_ID_PREFIX,
  TREASURY_CORE_WORK_KEY_MAX,
  TREASURY_CORE_WORK_KEY_PREFIX,
  type TreasuryCoreDispatchPermit,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreRearmPermit,
} from "@/runtime/treasury/kernel/types";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

/** permit 的私有注册表（对象身份即凭证；无法凭字符串伪造）。 */
const issuedPermits = new WeakSet<TreasuryCoreDispatchPermit>();
const issuedRearmPermits = new WeakSet<TreasuryCoreRearmPermit>();

export function isValidTreasuryCoreWorkKey(workKey: unknown): workKey is string {
  return (
    typeof workKey === "string" &&
    workKey.startsWith(TREASURY_CORE_WORK_KEY_PREFIX) &&
    workKey.length > TREASURY_CORE_WORK_KEY_PREFIX.length &&
    workKey.length <= TREASURY_CORE_WORK_KEY_MAX
  );
}

export function isTreasuryCoreAttemptId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(TREASURY_CORE_ATTEMPT_ID_PREFIX)) return false;
  const rest = value.slice(TREASURY_CORE_ATTEMPT_ID_PREFIX.length);
  // <seq(1..10 数字)>_<hash16>
  return /^\d{1,10}_[0-9a-f]{16}$/.test(rest);
}

/**
 * 铸造新 attempt ID（内核内部）。序号来自单调 frontier；哈希绑定
 * workKey + 序号 + canonicalDigest，使同序号不同语义的 ID 不可能碰撞。
 */
export function mintTreasuryCoreAttemptId(
  frontier: number,
  workKey: string,
  canonicalDigest: string,
): string {
  const seed = hashTreasuryCanonicalString(
    `${TREASURY_CORE_ATTEMPT_ID_PREFIX}${String(frontier)}:${workKey}:${canonicalDigest}`,
  );
  return `${TREASURY_CORE_ATTEMPT_ID_PREFIX}${String(frontier)}_${seed.slice(0, 16)}`;
}

/** 签发 dispatch permit（只经内核 admit/rearm 路径）。 */
export function mintTreasuryCoreDispatchPermit(input: {
  attemptId: string;
  canonicalDigest: string;
  canonicalArgs: unknown;
  actionKind: string;
  adapterRegistrationId: string;
  adapterSemanticIdentity: string;
  issuedAtTick: number;
  runtimeGeneration: number;
}): TreasuryCoreDispatchPermit {
  const permit = {
    attemptId: input.attemptId,
    canonicalDigest: input.canonicalDigest,
    canonicalArgs: input.canonicalArgs,
    actionKind: input.actionKind,
    adapterRegistrationId: input.adapterRegistrationId,
    adapterSemanticIdentity: input.adapterSemanticIdentity,
    issuedAtTick: input.issuedAtTick,
    runtimeGeneration: input.runtimeGeneration,
  } as TreasuryCoreDispatchPermit;
  issuedPermits.add(permit);
  return permit;
}

/** 签发 rearm permit。 */
export function mintTreasuryCoreRearmPermit(input: {
  parentAttemptId: string;
  workKey: string;
  retryFactsDigest: string | null;
  issuedAtTick: number;
  runtimeGeneration: number;
}): TreasuryCoreRearmPermit {
  const permit = {
    parentAttemptId: input.parentAttemptId,
    workKey: input.workKey,
    retryFactsDigest: input.retryFactsDigest,
    issuedAtTick: input.issuedAtTick,
    runtimeGeneration: input.runtimeGeneration,
  } as TreasuryCoreRearmPermit;
  issuedRearmPermits.add(permit);
  return permit;
}

/** 校验 permit 是本 runtime 签发且未跨 tick/generation。 */
export function validateTreasuryCoreDispatchPermit(
  permit: unknown,
  nowTick: number,
  runtimeGeneration: number,
): { status: "valid"; permit: TreasuryCoreDispatchPermit } | { status: "invalid"; reason: string } {
  if (typeof permit !== "object" || permit === null || !issuedPermits.has(permit as TreasuryCoreDispatchPermit)) {
    return { status: "invalid", reason: "dispatch 许可非本 runtime 签发（字符串/普通对象不可执行）" };
  }
  const typed = permit as TreasuryCoreDispatchPermit;
  if (typed.runtimeGeneration !== runtimeGeneration) {
    return { status: "invalid", reason: "dispatch 许可来自不同 runtime generation（global reset 后失效）" };
  }
  if (typed.issuedAtTick !== nowTick) {
    return { status: "invalid", reason: "dispatch 许可跨 tick 失效" };
  }
  return { status: "valid", permit: typed };
}

export function validateTreasuryCoreRearmPermit(
  permit: unknown,
  nowTick: number,
  runtimeGeneration: number,
): { status: "valid"; permit: TreasuryCoreRearmPermit } | { status: "invalid"; reason: string } {
  if (typeof permit !== "object" || permit === null || !issuedRearmPermits.has(permit as TreasuryCoreRearmPermit)) {
    return { status: "invalid", reason: "rearm 许可非本 runtime 签发" };
  }
  const typed = permit as TreasuryCoreRearmPermit;
  if (typed.runtimeGeneration !== runtimeGeneration) {
    return { status: "invalid", reason: "rearm 许可来自不同 runtime generation" };
  }
  if (typed.issuedAtTick !== nowTick) {
    return { status: "invalid", reason: "rearm 许可跨 tick 失效" };
  }
  return { status: "valid", permit: typed };
}

/**
 * 完整身份事实冲突判定：a 与 b 语义身份必须逐项相等；任一不同 → 冲突
 * （原事实保留，调用方拒绝推进——A03/R1）。
 */
export function treasuryCoreIdentityConflicts(
  a: TreasuryCoreIdentityFacts,
  b: TreasuryCoreIdentityFacts,
): string | null {
  if (a.actionKind !== b.actionKind) return "actionKind 不一致";
  if (a.adapterVersion !== b.adapterVersion) return "adapterVersion 不一致";
  if (a.adapterRegistrationId !== b.adapterRegistrationId) return "adapterRegistrationId 不一致";
  if (a.adapterSemanticIdentity !== b.adapterSemanticIdentity) return "adapterSemanticIdentity 不一致";
  if (a.canonicalDigest !== b.canonicalDigest) return "canonicalDigest 不一致";
  if (a.postingsDigest !== b.postingsDigest) return "postingsDigest 不一致";
  if (a.retryFactsDigest !== b.retryFactsDigest) return "retryFactsDigest 不一致";
  if (a.durableFacts?.version !== b.durableFacts?.version || a.durableFacts?.payload !== b.durableFacts?.payload) {
    return "durableFacts 不一致";
  }
  return null;
}

/** 身份事实的统一摘要（诊断与 ring 关联用）。 */
export function treasuryCoreIdentityDigest(facts: TreasuryCoreIdentityFacts): string {
  return hashTreasuryCanonicalString(
    [
      facts.actionKind,
      String(facts.adapterVersion),
      facts.adapterRegistrationId,
      facts.adapterSemanticIdentity,
      facts.canonicalDigest,
      facts.postingsDigest,
      facts.retryFactsDigest ?? "-",
      facts.durableFacts ? `${String(facts.durableFacts.version)}:${facts.durableFacts.payload}` : "-",
    ].join("|"),
  ).slice(0, 16);
}
