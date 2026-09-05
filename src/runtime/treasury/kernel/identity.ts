/**
 * Treasury Core Kernel——身份铸造与许可签发（Core Rewrite II）。
 *
 * 契约（design II §4.1）：
 * - 外部调用者不能按任意指定 ID 创建、复活或执行 attempt。创建和 rearm
 *   只经内核分配新身份（单调 frontier + 域分离哈希）；分配失败烧掉序号，
 *   frontier 不回退，洞不变成可执行记录，也不为洞建立永久证明。
 * - permit 是 heap-only opaque 对象（私有品牌字段 + WeakSet 注册），跨
 *   tick / runtime generation 失效；字符串或普通对象不是许可。
 * - 【II】签发快照整体深冻结：canonicalArgs、postings 等嵌套内容在签发
 *   后不可替换/改写（真许可可变 = R01）。调用者修改真许可要么抛错（strict
 *   赋值），要么无效；修改后的许可不能执行 5000 或换目标/延寿。
 * - 身份冲突判定比较完整事实（canonicalDigest / postingsDigest /
 *   adapter 语义身份 / retryFactsDigest），“字段可构造”≠“身份匹配”。
 */

import {
  TREASURY_CORE_ATTEMPT_ID_PREFIX,
  TREASURY_CORE_WORK_KEY_MAX,
  TREASURY_CORE_WORK_KEY_PREFIX,
  type TreasuryCoreDispatchPermit,
  type TreasuryCoreIdentityFacts,
  type TreasuryCorePermitPosting,
  type TreasuryCoreRearmPermit,
} from "@/runtime/treasury/kernel/types";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

/** permit 的私有注册表（对象身份即凭证；无法凭字符串伪造）。 */
const issuedPermits = new WeakSet<TreasuryCoreDispatchPermit>();
const issuedRearmPermits = new WeakSet<TreasuryCoreRearmPermit>();

/** 签发快照的深冻结上限（与 canonical encoding 常量同量级——防御兜底）。 */
const ISSUANCE_FREEZE_MAX_DEPTH = 16;
const ISSUANCE_FREEZE_MAX_KEYS = 64;

/**
 * 深克隆 + 深冻结签发值：返回快照与调用方原始对象无任何共享可变引用；
 * 嵌套普通对象/数组逐层 clone+freeze。超深度/超键数的层退化为浅拷贝 +
 * 浅冻结（fail safe，不无限递归）；非普通值（函数等）按标量语义返回。
 * 与 durableSnapshot 的区别：这里同时克隆（签发内容不得回写调用方对象）。
 */
function freezeIssuanceValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= ISSUANCE_FREEZE_MAX_DEPTH) {
    return Array.isArray(value)
      ? Object.freeze([...value])
      : Object.freeze({ ...(value as Record<string, unknown>) });
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeIssuanceValue(item, depth + 1)));
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length > ISSUANCE_FREEZE_MAX_KEYS) {
    return Object.freeze({ ...source });
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    copy[key] = freezeIssuanceValue(source[key], depth + 1);
  }
  return Object.freeze(copy);
}

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

/**
 * 签发 dispatch permit（只经内核 admit/rearm 路径）。签发快照深冻结：
 * canonicalArgs 与 postings 是独立冻结副本，调用方对原 args 对象的后续
 * 修改、对 permit 字段的替换/改写均不影响执行语义（R01）。
 */
export function mintTreasuryCoreDispatchPermit(input: {
  attemptId: string;
  canonicalDigest: string;
  canonicalArgs: unknown;
  postings: readonly TreasuryCorePermitPosting[];
  actionKind: string;
  adapterRegistrationId: string;
  adapterSemanticIdentity: string;
  issuedAtTick: number;
  runtimeGeneration: number;
}): TreasuryCoreDispatchPermit {
  const permit = {
    attemptId: input.attemptId,
    canonicalDigest: input.canonicalDigest,
    canonicalArgs: freezeIssuanceValue(input.canonicalArgs, 0),
    postings: freezeIssuanceValue(input.postings, 0),
    actionKind: input.actionKind,
    adapterRegistrationId: input.adapterRegistrationId,
    adapterSemanticIdentity: input.adapterSemanticIdentity,
    issuedAtTick: input.issuedAtTick,
    runtimeGeneration: input.runtimeGeneration,
  } as TreasuryCoreDispatchPermit;
  Object.freeze(permit);
  issuedPermits.add(permit);
  return permit;
}

/** 签发 rearm permit（深冻结：前代/工作/期限字段签发后不可改）。 */
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
  Object.freeze(permit);
  issuedRearmPermits.add(permit);
  return permit;
}

/** 校验 permit 是本 runtime 签发、未跨 tick/generation、且签发快照未被替换。 */
export function validateTreasuryCoreDispatchPermit(
  permit: unknown,
  nowTick: number,
  runtimeGeneration: number,
): { status: "valid"; permit: TreasuryCoreDispatchPermit } | { status: "invalid"; reason: string } {
  if (typeof permit !== "object" || permit === null || !issuedPermits.has(permit as TreasuryCoreDispatchPermit)) {
    return { status: "invalid", reason: "dispatch 许可非本 runtime 签发（字符串/普通对象不可执行）" };
  }
  const typed = permit as TreasuryCoreDispatchPermit;
  // 签发快照整体冻结：非冻结的“注册对象”不存在（mint 即冻结）；克隆/拼接
  // 的对象不在私有 WeakSet 中。双重校验防御注册表被替换的极端情形。
  if (!Object.isFrozen(typed) || !Object.isFrozen(typed.postings)) {
    return { status: "invalid", reason: "dispatch 许可签发快照不可信（未冻结）" };
  }
  if (typeof typed.runtimeGeneration !== "number" || typed.runtimeGeneration !== runtimeGeneration) {
    return { status: "invalid", reason: "dispatch 许可来自不同 runtime generation（global reset 后失效）" };
  }
  if (typeof typed.issuedAtTick !== "number" || typed.issuedAtTick !== nowTick) {
    return { status: "invalid", reason: "dispatch 许可跨 tick 失效" };
  }
  if (typeof typed.attemptId !== "string" || typeof typed.canonicalDigest !== "string") {
    return { status: "invalid", reason: "dispatch 许可身份字段不可信" };
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
  if (!Object.isFrozen(typed)) {
    return { status: "invalid", reason: "rearm 许可签发快照不可信（未冻结）" };
  }
  if (typeof typed.runtimeGeneration !== "number" || typed.runtimeGeneration !== runtimeGeneration) {
    return { status: "invalid", reason: "rearm 许可来自不同 runtime generation" };
  }
  if (typeof typed.issuedAtTick !== "number" || typed.issuedAtTick !== nowTick) {
    return { status: "invalid", reason: "rearm 许可跨 tick 失效" };
  }
  if (typeof typed.parentAttemptId !== "string" || typeof typed.workKey !== "string") {
    return { status: "invalid", reason: "rearm 许可身份字段不可信" };
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

/**
 * 许可与聚合身份的完整比对（executeDispatch 执行前重验——§4.1）。
 * 许可的可信签发快照与持久聚合的当前事实必须逐项一致：任何不匹配都
 * 拒绝执行（不消费许可、不推进状态）。
 */
export function treasuryCorePermitRecordConflicts(
  permit: Pick<TreasuryCoreDispatchPermit, "attemptId" | "canonicalDigest" | "actionKind" | "adapterRegistrationId" | "adapterSemanticIdentity">,
  identity: TreasuryCoreIdentityFacts,
): string | null {
  if (permit.attemptId.length === 0) return "attemptId 缺失";
  if (permit.canonicalDigest !== identity.canonicalDigest) return "canonicalDigest 不一致";
  if (permit.actionKind !== identity.actionKind) return "actionKind 不一致";
  if (permit.adapterRegistrationId !== identity.adapterRegistrationId) return "adapterRegistrationId 不一致";
  if (permit.adapterSemanticIdentity !== identity.adapterSemanticIdentity) return "adapterSemanticIdentity 不一致";
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
