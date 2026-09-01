/**
 * 【第十七轮第五节】durable attempt lineage / retired-attempt store。
 *
 * 背景（Round 16 遗留断链）：same-ID 不可重试目前只依赖 final not-executed
 * tombstone——tombstone 超过 retention 被驱逐后，旧 parent ID 可以再次进入
 * prepare；not-executed retry 语义没有跨 tombstone retention 存续的持久
 * lineage authority。
 *
 * 固定语义：
 * - 每条业务重试链**一个**有界 record（不是无界 attempt 数组）：root/current
 *   attempt ID 与完整 identity、generation、状态、next child、retry semantic
 *   digest、authority class、retirement 三段（lineagePublished /
 *   authorityReleased / markerCleaned）；
 * - 状态机单调（retiring → rearm_ready → capability_issued →
 *   child_intent_pending → child_active → chain_committed；或 non_rearmable_
 *   retired / forensic_isolated），禁止回退、同代不同 child、重复 child、
 *   改变 root / 语义身份 / authority class、复用旧 generation；
 * - 新 root chain 占一个 slot；同 chain 的代际推进更新同一 record 不新增
 *   slot；**普通运行不得自动删除 record**（无自动驱逐）；
 * - 硬容量满载时新 root 拒绝（fail closed）——不驱逐旧安全事实恢复容量；
 * - root/current/next O(1) 索引：global reset 首次 load 一次有界全表验证与
 *   索引重建；索引只是定位器，Memory record 才是权威；不一致 → store
 *   unhealthy；
 * - root attempt ID 只要存在 lineage record 即永久 retired（tombstone 过期
 *   后仍返回 retired/rearm_required 语义）。
 */

import {
  encodeTreasuryCanonicalTuple,
  hashTreasuryCanonicalString,
  isValidTreasuryTransactionId,
} from "@/runtime/treasury/transactionId";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import {
  readTreasuryResolutionTombstone,
  listTreasuryPendingReleaseIds,
  registerTreasuryRetentionLineageLookupForAssembly,
} from "@/runtime/treasury/resolutionStore";
import { registerTreasuryLineageResetHook } from "@/runtime/treasury/receipts";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import {
  readTreasuryIntentEntry,
  releaseTreasuryIntentEntry,
} from "@/runtime/treasury/intents";

/** lineage store schema 版本（持久格式升级时递增；未知版本 fail closed）。 */
export const TREASURY_LINEAGE_VERSION = 1;
/** 硬容量：最多同时存续的重试链数（满载 fail closed，不驱逐）。 */
export const TREASURY_LINEAGE_MAX_ENTRIES = 64;

const LINEAGE_KEY_PREFIX = "l:";
const LINEAGE_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const LINEAGE_ID_BASIS = "treasury-attempt-lineage@v1";
const NON_REARM_REASON_MAX = 96;

/** lineage 状态（单调状态机；语义见模块头注释）。 */
export type TreasuryAttemptLineageState =
  | "retiring"
  | "rearm_ready"
  | "capability_issued"
  | "child_intent_pending"
  | "child_active"
  | "chain_committed"
  | "non_rearmable_retired"
  | "forensic_isolated";

export const TREASURY_ATTEMPT_LINEAGE_STATES: ReadonlySet<string> = new Set<string>([
  "retiring",
  "rearm_ready",
  "capability_issued",
  "child_intent_pending",
  "child_active",
  "chain_committed",
  "non_rearmable_retired",
  "forensic_isolated",
]);

/** current attempt 的 resolution 终态（与 store 状态解耦）。 */
export type TreasuryLineageResolutionState = "unresolved" | "not_executed" | "committed";

/** lineage authority/proof class（与 resolution proofLevel 的可 rearm 子集一致）。 */
export type TreasuryLineageAuthorityClass = "identity-bound" | "lowlevel";

/** attempt identity 的完整视图（root/current 共用形状）。 */
export interface TreasuryAttemptLineageIdentity {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
}

export interface TreasuryAttemptLineageRecord {
  /** 16hex lineage 身份（rootTransactionId + root identity 派生）。 */
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly rootIdentity: TreasuryAttemptLineageIdentity;
  readonly currentTransactionId: string;
  readonly currentIdentity: TreasuryAttemptLineageIdentity;
  /** 当前 attempt 的 action kind（capability actionKind 绑定；不可变）。 */
  readonly actionKind: string;
  /** 稳定 adapter/reconciler 语义身份（capability 匹配用；可选）。 */
  readonly adapterSemanticIdentity?: string;
  /** owner canonical identity（capability 匹配用；可选）。 */
  readonly ownerIdentity?: string;
  /** 非负安全整数；root=0；child 接管完成时 +1。 */
  readonly generation: number;
  readonly state: TreasuryAttemptLineageState;
  readonly resolutionState: TreasuryLineageResolutionState;
  /** rearm 派生的确定性 child ID（capability 签发时写入并冻结）。 */
  readonly nextChildTransactionId?: string;
  /** 当前 current 的重试语义 digest（non-rearmable 缺失）。 */
  readonly retrySemanticDigest?: string;
  readonly authorityClass: TreasuryLineageAuthorityClass;
  readonly lowlevelSource?: string;
  /** 当前 current 为 rearm child 时的 lineage binding digest。 */
  readonly bindingDigest?: string;
  readonly rearmable: boolean;
  readonly nonRearmReason?: string;
  /** retirement 三段完成标志（final not-executed 的 staged 协议）。 */
  readonly retirement: {
    readonly lineagePublished: boolean;
    readonly authorityReleased: boolean;
    readonly markerCleaned: boolean;
  };
  /** 每次成功写入 +1（capability 的 lineage revision 绑定）。 */
  readonly recordRevision: number;
  readonly createdAtTick: number;
  readonly updatedAtTick: number;
}

export interface TreasuryAttemptLineageStore {
  readonly version: number;
  readonly entries: Record<string, TreasuryAttemptLineageRecord>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryLineageBranch {
  attemptLineage?: TreasuryAttemptLineageStore;
}

type RuntimeMemoryWithLineage = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryLineageBranch;
};

function treasuryBranch(): TreasuryLineageBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithLineage;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** 恢复/诊断计数（metrics 聚合用；测试断言 operation-count）。 */
export const lineageStoreEvents = {
  fullScans: 0,
  idleFastPath: 0,
  backfills: 0,
  capabilityExpiries: 0,
  childIntentRollbacks: 0,
  childIntentForensics: 0,
  retirementCompletions: 0,
  indexCorruptions: 0,
  writes: 0,
  writeFailures: 0,
};

export function resetTreasuryLineageRuntimeForTest(): void {
  heapRuntime = null;
  Object.assign(lineageStoreEvents, {
    fullScans: 0,
    idleFastPath: 0,
    backfills: 0,
    capabilityExpiries: 0,
    childIntentRollbacks: 0,
    childIntentForensics: 0,
    retirementCompletions: 0,
    indexCorruptions: 0,
    writes: 0,
    writeFailures: 0,
  });
}

// 测试清理注册（receipts.clearTreasuryPersistenceForTest 统一调用——模块
// 单向依赖，避免 receipts ↔ attemptLineage 循环 import）。
registerTreasuryLineageResetHook(resetTreasuryLineageRuntimeForTest);

// 【第十七轮第十三节】retention 驱逐资格的 O(1) lineage lookup 注入（模块
// 单向依赖：resolutionStore 不 import 本模块——装配时反向注册）。
registerTreasuryRetentionLineageLookupForAssembly((transactionId) => {
  const record = lookupTreasuryAttemptLineageByAttemptId(transactionId);
  return record === undefined ? undefined : { state: record.state, retirement: record.retirement };
});

// ── heap 运行态（global reset 即丢；首次 load 一次全表验证重建） ───────────

interface TreasuryLineageStoreRuntime {
  readonly store: TreasuryAttemptLineageStore;
  readonly fatal: string | null;
  /** 空 store 是否已发布到 Memory（读取路径零写缓存——写入前必须发布）。 */
  published: boolean;
  /** root/current/next O(1) 索引（key = store key，含前缀）。 */
  readonly rootIndex: Map<string, string>;
  readonly currentIndex: Map<string, string>;
  readonly nextChildIndex: Map<string, string>;
  /** 需要恢复动作的 lineage ID 子集（retiring / capability_issued / child_intent_pending）。 */
  readonly pendingIds: Set<string>;
}

let heapRuntime: TreasuryLineageStoreRuntime | null = null;

// ── 身份派生（纯函数） ──────────────────────────────────────────────────────

/** lineage identity 的合成 digest（capability parentIdentityDigest 等用）。 */
export function computeTreasuryLineageIdentityDigest(identity: TreasuryAttemptLineageIdentity): string {
  return hashTreasuryCanonicalString(
    `lineage-identity:${encodeTreasuryCanonicalTuple([
      identity.digest,
      identity.contractDigest ?? "",
      identity.authorizationCohortDigest ?? "",
      identity.durableIdentityDigest ?? "",
      identity.lowlevelSource ?? "",
    ])}`,
  );
}

/** lineage record 的 lineageId（rootTransactionId + root identity 派生）。 */
export function computeTreasuryAttemptLineageId(
  rootTransactionId: string,
  rootIdentity: TreasuryAttemptLineageIdentity,
): string {
  return hashTreasuryCanonicalString(
    `${LINEAGE_ID_BASIS}:${rootTransactionId}:${computeTreasuryLineageIdentityDigest(rootIdentity)}`,
  );
}

/**
 * 【第十七轮第七节】lineage 的确定性 next-child ID 派生（production 权威
 * 实现——facade issueTreasuryRearmCapability 专用）：canonical tuple 绑定
 * Round 16 rearm 协议版本 + parent ID + parent attempt identity 全部成分，
 * 输出 `tr1_<hash16>`。同 parent identity 幂等、跨 global reset 恒定——与
 * attemptRearm.ts 的 test-only derive helper 同一编码（协议兼容）。
 */
export function deriveTreasuryLineageNextChildTransactionId(
  parentTransactionId: string,
  parentIdentity: TreasuryAttemptLineageIdentity,
): string {
  const canonical = encodeTreasuryCanonicalTuple([
    "treasury-attempt-rearm@v1",
    parentTransactionId,
    parentIdentity.digest,
    parentIdentity.contractDigest ?? "",
    parentIdentity.authorizationCohortDigest ?? "",
    parentIdentity.durableIdentityDigest ?? "",
    parentIdentity.lowlevelSource ?? "",
  ]);
  const childId = "tr1_" + hashTreasuryCanonicalString(canonical);
  if (!isValidTreasuryTransactionId(childId)) {
    throw new Error(`lineage child id 铸造结果不符合 Treasury transactionId 边界: ${childId}`);
  }
  return childId;
}

// ── 形状与语义校验 ──────────────────────────────────────────────────────────

function validateIdentityShape(identity: unknown, label: string): string | null {
  if (!identity || typeof identity !== "object") return `${label} 非对象`;
  const candidate = identity as Partial<TreasuryAttemptLineageIdentity>;
  if (typeof candidate.digest !== "string" || !LINEAGE_DIGEST_PATTERN.test(candidate.digest)) {
    return `${label}.digest 非法（须 16 小写 hex）`;
  }
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !LINEAGE_DIGEST_PATTERN.test(value))) {
      return `${label}.${field} 非法（须 16 小写 hex）`;
    }
  }
  if (candidate.lowlevelSource !== undefined && typeof candidate.lowlevelSource !== "string") {
    return `${label}.lowlevelSource 非字符串`;
  }
  return null;
}

/**
 * record 形状校验（返回 null = 合法）。digest 类字段全部 16hex；generation/
 * recordRevision 非负安全整数；state 枚举；identity-bound 禁 lowlevelSource、
 * lowlevel 必带；lineageId 与 root 派生一致（重算验证——不信任自带字符串）。
 */
export function validateTreasuryAttemptLineageRecordShape(record: unknown): string | null {
  if (!record || typeof record !== "object") return "record 非对象";
  const candidate = record as Partial<TreasuryAttemptLineageRecord>;
  for (const field of ["rootTransactionId", "currentTransactionId"] as const) {
    const value = candidate[field];
    if (typeof value !== "string" || !isValidTreasuryTransactionId(value)) {
      return `record.${field} 非法 transactionId`;
    }
  }
  const rootIdentityError = validateIdentityShape(candidate.rootIdentity, "record.rootIdentity");
  if (rootIdentityError !== null) return rootIdentityError;
  const currentIdentityError = validateIdentityShape(candidate.currentIdentity, "record.currentIdentity");
  if (currentIdentityError !== null) return currentIdentityError;
  const derivedLineageId = computeTreasuryAttemptLineageId(candidate.rootTransactionId!, candidate.rootIdentity!);
  if (candidate.lineageId !== derivedLineageId) {
    return `record.lineageId 与 root identity 重算不一致（entry ${String(candidate.lineageId).slice(0, 16)}，重算 ${derivedLineageId.slice(0, 16)}）`;
  }
  if (candidate.state === undefined || !TREASURY_ATTEMPT_LINEAGE_STATES.has(candidate.state)) {
    return `record.state 非法枚举: ${String(candidate.state).slice(0, 32)}`;
  }
  if (
    candidate.resolutionState === undefined ||
    !["unresolved", "not_executed", "committed"].includes(candidate.resolutionState)
  ) {
    return `record.resolutionState 非法枚举: ${String(candidate.resolutionState).slice(0, 32)}`;
  }
  if (candidate.authorityClass !== "identity-bound" && candidate.authorityClass !== "lowlevel") {
    return `record.authorityClass 非法: ${String(candidate.authorityClass).slice(0, 32)}`;
  }
  if (candidate.authorityClass === "identity-bound" && candidate.lowlevelSource !== undefined) {
    return "record.identity-bound 携带 lowlevelSource（class 矛盾）";
  }
  if (candidate.authorityClass === "lowlevel" && typeof candidate.lowlevelSource !== "string") {
    return "record.lowlevel 缺少 lowlevelSource";
  }
  for (const field of ["generation", "recordRevision", "createdAtTick", "updatedAtTick"] as const) {
    const value = candidate[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return `record.${field} 非安全非负整数`;
    }
  }
  if (typeof candidate.actionKind !== "string" || candidate.actionKind.length === 0 || candidate.actionKind.length > 128) {
    return "record.actionKind 非法（1..128 字符）";
  }
  if (candidate.adapterSemanticIdentity !== undefined && (typeof candidate.adapterSemanticIdentity !== "string" || candidate.adapterSemanticIdentity.length === 0)) {
    return "record.adapterSemanticIdentity 非法";
  }
  if (candidate.ownerIdentity !== undefined && (typeof candidate.ownerIdentity !== "string" || candidate.ownerIdentity.length === 0)) {
    return "record.ownerIdentity 非法";
  }
  if (candidate.nextChildTransactionId !== undefined) {
    if (typeof candidate.nextChildTransactionId !== "string" || !isValidTreasuryTransactionId(candidate.nextChildTransactionId)) {
      return "record.nextChildTransactionId 非法";
    }
  }
  if (candidate.retrySemanticDigest !== undefined && (typeof candidate.retrySemanticDigest !== "string" || !LINEAGE_DIGEST_PATTERN.test(candidate.retrySemanticDigest))) {
    return "record.retrySemanticDigest 非法（须 16 小写 hex）";
  }
  if (candidate.bindingDigest !== undefined && (typeof candidate.bindingDigest !== "string" || !LINEAGE_DIGEST_PATTERN.test(candidate.bindingDigest))) {
    return "record.bindingDigest 非法（须 16 小写 hex）";
  }
  if (typeof candidate.rearmable !== "boolean") return "record.rearmable 非布尔";
  if (candidate.nonRearmReason !== undefined) {
    if (typeof candidate.nonRearmReason !== "string" || candidate.nonRearmReason.length === 0 || candidate.nonRearmReason.length > NON_REARM_REASON_MAX) {
      return "record.nonRearmReason 非法（1..96 字符）";
    }
  }
  if (candidate.rearmable === false && candidate.nonRearmReason === undefined) {
    return "record.non-rearmable 缺少 nonRearmReason";
  }
  if (candidate.rearmable === true && candidate.retrySemanticDigest === undefined) {
    return "record.rearmable 缺少 retrySemanticDigest（无 retry 语义不可 rearm）";
  }
  const retirement = candidate.retirement as Partial<TreasuryAttemptLineageRecord["retirement"]> | undefined;
  if (!retirement || typeof retirement !== "object") return "record.retirement 非对象";
  for (const field of ["lineagePublished", "authorityReleased", "markerCleaned"] as const) {
    if (typeof retirement[field] !== "boolean") return `record.retirement.${field} 非布尔`;
  }
  return null;
}

/** 持久语义矩阵（load / 写入候选共用）。 */
export function validateTreasuryAttemptLineageRecordState(record: unknown): string | null {
  const candidate = record as Partial<TreasuryAttemptLineageRecord>;
  const state = candidate.state;
  switch (state) {
    case "retiring":
      if (candidate.resolutionState !== "not_executed") return "retiring 只能配 not_executed";
      break;
    case "rearm_ready":
      if (candidate.resolutionState !== "not_executed") return "rearm_ready 只能配 not_executed";
      if (!candidate.retirement?.lineagePublished || !candidate.retirement?.authorityReleased || !candidate.retirement?.markerCleaned) {
        return "rearm_ready 必须三段 retirement 全部完成";
      }
      break;
    case "capability_issued":
      if (candidate.resolutionState !== "not_executed") return "capability_issued 只能配 not_executed";
      if (candidate.nextChildTransactionId === undefined) return "capability_issued 必须携带 nextChildTransactionId";
      break;
    case "child_intent_pending":
      if (candidate.nextChildTransactionId === undefined) return "child_intent_pending 必须携带 nextChildTransactionId";
      break;
    case "child_active":
      if (candidate.resolutionState !== "unresolved") return "child_active 只能配 unresolved";
      if (candidate.currentTransactionId === candidate.rootTransactionId) {
        return "child_active 的 current 必须是 child（不得为 root）";
      }
      if (candidate.bindingDigest === undefined) return "child_active 必须携带 bindingDigest";
      break;
    case "chain_committed":
      if (candidate.resolutionState !== "committed") return "chain_committed 只能配 committed";
      break;
    case "non_rearmable_retired":
    case "forensic_isolated":
      if (candidate.rearmable !== false) return `${String(state)} 必须 non-rearmable`;
      break;
  }
  return null;
}

// ── 状态机（单调转换矩阵） ─────────────────────────────────────────────────

export type TreasuryAttemptLineageTransitionResult =
  | { readonly status: "allowed" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly detail: string };

/** 单次状态转换的合法边（forensic_isolated 允许从任意状态进入——隔离）。 */
const ALLOWED_TRANSITIONS: Readonly<Record<TreasuryAttemptLineageState, readonly TreasuryAttemptLineageState[]>> = {
  retiring: ["rearm_ready", "non_rearmable_retired", "forensic_isolated"],
  rearm_ready: ["capability_issued", "forensic_isolated"],
  capability_issued: ["child_intent_pending", "rearm_ready", "forensic_isolated"],
  child_intent_pending: ["child_active", "rearm_ready", "forensic_isolated"],
  child_active: ["chain_committed", "retiring", "forensic_isolated"],
  chain_committed: ["forensic_isolated"],
  non_rearmable_retired: [],
  forensic_isolated: [],
};

/**
 * 转换校验（写入与 load 全表校验共用）：状态边合法 + 不可变事实（root、
 * lineageId、authorityClass、retry semantic 身份）不得变化 + generation 只
 * 允许在 child_active 推进时 +1 + exact idempotent（全部字段一致）。
 */
export function validateTreasuryAttemptLineageTransition(
  existing: TreasuryAttemptLineageRecord | undefined,
  next: TreasuryAttemptLineageRecord,
): TreasuryAttemptLineageTransitionResult {
  if (existing === undefined) {
    // 新建：retiring（staged publication 起点）或终局 non-rearmable/forensic。
    if (next.state !== "retiring" && next.state !== "non_rearmable_retired" && next.state !== "forensic_isolated") {
      return { status: "rejected", detail: `新建 lineage 只能从 retiring/non_rearmable_retired/forensic_isolated 开始（got ${String(next.state)}）` };
    }
    return { status: "allowed" };
  }
  // 不可变事实。
  if (existing.rootTransactionId !== next.rootTransactionId) {
    return { status: "rejected", detail: "root attempt 不可改变" };
  }
  if (computeTreasuryLineageIdentityDigest(existing.rootIdentity) !== computeTreasuryLineageIdentityDigest(next.rootIdentity)) {
    return { status: "rejected", detail: "root identity 不可改变" };
  }
  if (existing.authorityClass !== next.authorityClass || existing.lowlevelSource !== next.lowlevelSource) {
    return { status: "rejected", detail: "authority class / lowlevelSource 不可改变" };
  }
  if (existing.retrySemanticDigest !== next.retrySemanticDigest) {
    return { status: "rejected", detail: "retry semantic identity 不可改变（child 必须是 parent 动作的语义重试）" };
  }
  if (next.generation < existing.generation) {
    return { status: "rejected", detail: "generation 不可回退" };
  }
  if (next.generation > existing.generation + 1) {
    return { status: "rejected", detail: "generation 只允许逐代 +1" };
  }
  if (existing.generation === next.generation && next.generation > 0) {
    // 同代更新：current 不得变化（同代不同 attempt = 复用旧 generation）。
    if (existing.currentTransactionId !== next.currentTransactionId) {
      return { status: "rejected", detail: "同 generation 不得更换 current attempt" };
    }
  }
  if (next.state === "capability_issued" || next.state === "child_intent_pending") {
    if (existing.nextChildTransactionId !== undefined && existing.nextChildTransactionId !== next.nextChildTransactionId) {
      return { status: "rejected", detail: "同一 generation 不得派生不同 child" };
    }
  }
  if (next.recordRevision !== existing.recordRevision + 1) {
    return { status: "rejected", detail: `recordRevision 必须严格 +1（${String(existing.recordRevision)} → ${String(next.recordRevision)}）` };
  }
  if (existing.state === next.state) {
    const existingJson = JSON.stringify({ ...existing });
    const nextJson = JSON.stringify({ ...next });
    if (existingJson === nextJson) return { status: "idempotent" };
    return { status: "rejected", detail: "同状态只允许 exact idempotent 重复写" };
  }
  if (!ALLOWED_TRANSITIONS[existing.state].includes(next.state)) {
    return { status: "rejected", detail: `非法状态转换 ${String(existing.state)} → ${String(next.state)}` };
  }
  return { status: "allowed" };
}

// ── store 运行态 load / 验证 / 索引 ────────────────────────────────────────

/** 空 store 发布到 Memory（写入路径权威初始化——读取路径零写缓存解除）。 */
function publishLineageStoreToMemory(runtime: TreasuryLineageStoreRuntime): void {
  const target = ((Memory.runtime ??= {} as NonNullable<Memory["runtime"]>) as unknown as RuntimeMemoryWithLineage);
  const branch = (target.treasury ??= {});
  if (branch.attemptLineage === undefined) {
    branch.attemptLineage = runtime.store as unknown as NonNullable<(typeof branch)["attemptLineage"]>;
  }
  runtime.published = true;
}

function loadLineageStoreRuntime(forWrite = false): TreasuryLineageStoreRuntime {
  if (heapRuntime !== null) return heapRuntime;
  lineageStoreEvents.fullScans += 1;
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  if (branch?.attemptLineage === undefined) {
    // 读取路径返回空运行态（零写）；写入路径创建空 store 并发布到 Memory
    //（否则后续写入落在 heap 幽灵对象上——Memory 从未收到权威数据）。
    const store: TreasuryAttemptLineageStore = {
      version: TREASURY_LINEAGE_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    heapRuntime = {
      store,
      fatal: null,
      published: false,
      rootIndex: new Map(),
      currentIndex: new Map(),
      nextChildIndex: new Map(),
      pendingIds: new Set(),
    };
    if (forWrite) publishLineageStoreToMemory(heapRuntime);
    return heapRuntime;
  }
  const store = branch.attemptLineage as unknown as TreasuryAttemptLineageStore;
  const fatal = validateLineageStoreShape(store);
  const runtime: TreasuryLineageStoreRuntime = {
    store,
    fatal,
    published: true,
    rootIndex: new Map(),
    currentIndex: new Map(),
    nextChildIndex: new Map(),
    pendingIds: new Set(),
  };
  if (fatal === null) buildLineageIndexes(runtime);
  heapRuntime = runtime;
  return runtime;
}

function validateLineageStoreShape(store: TreasuryAttemptLineageStore): string | null {
  if (!store || typeof store !== "object") return "lineage store 非对象";
  if (store.version !== TREASURY_LINEAGE_VERSION) {
    return `lineage store 版本未知（${String(store.version)}，期望 ${String(TREASURY_LINEAGE_VERSION)}）——fail closed`;
  }
  if (!store.entries || typeof store.entries !== "object") return "lineage store.entries 非对象";
  const ownKeys = Object.keys(store.entries);
  if (ownKeys.length !== store.entryCount) {
    return `lineage entryCount 不一致（ownKeys ${String(ownKeys.length)}，entryCount ${String(store.entryCount)}）`;
  }
  if (store.entryCount > TREASURY_LINEAGE_MAX_ENTRIES) {
    return `lineage store 超过硬容量（${String(store.entryCount)} > ${String(TREASURY_LINEAGE_MAX_ENTRIES)}）`;
  }
  const seenRoot = new Set<string>();
  for (const key of ownKeys) {
    if (!key.startsWith(LINEAGE_KEY_PREFIX)) return `lineage key 非法（须 ${LINEAGE_KEY_PREFIX} 前缀）: ${key.slice(0, 24)}`;
    const record = store.entries[key];
    const shapeError = validateTreasuryAttemptLineageRecordShape(record);
    if (shapeError !== null) return `lineage entry 损坏（${key.slice(0, 24)}）: ${shapeError}`;
    const stateError = validateTreasuryAttemptLineageRecordState(record);
    if (stateError !== null) return `lineage entry 语义非法（${key.slice(0, 24)}）: ${stateError}`;
    if (key !== LINEAGE_KEY_PREFIX + record.rootTransactionId) {
      return `lineage key 与 rootTransactionId 不一致（${key.slice(0, 24)}）`;
    }
    if (seenRoot.has(record.rootTransactionId)) return `lineage root 重复（${record.rootTransactionId.slice(0, 24)}）`;
    seenRoot.add(record.rootTransactionId);
  }
  return null;
}

function buildLineageIndexes(runtime: TreasuryLineageStoreRuntime): void {
  runtime.rootIndex.clear();
  runtime.currentIndex.clear();
  runtime.nextChildIndex.clear();
  runtime.pendingIds.clear();
  for (const [key, record] of Object.entries(runtime.store.entries)) {
    runtime.rootIndex.set(record.rootTransactionId, key);
    runtime.currentIndex.set(record.currentTransactionId, key);
    if (record.nextChildTransactionId !== undefined) runtime.nextChildIndex.set(record.nextChildTransactionId, key);
    if (record.state === "retiring" || record.state === "capability_issued" || record.state === "child_intent_pending") {
      runtime.pendingIds.add(record.lineageId);
    }
  }
}

export interface TreasuryAttemptLineageHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
  readonly pendingCount: number;
}

/** 零写健康探测（不触发创建；对已存在 store 触发 load validation）。 */
export function peekTreasuryAttemptLineageHealth(): TreasuryAttemptLineageHealth {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  if (branch?.attemptLineage === undefined) {
    return { healthy: true, detail: null, entryCount: 0, pendingCount: 0 };
  }
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) {
    return { healthy: false, detail: runtime.fatal, entryCount: 0, pendingCount: 0 };
  }
  return { healthy: true, detail: null, entryCount: runtime.store.entryCount, pendingCount: runtime.pendingIds.size };
}

/** 写路径健康门禁（返回 null = 可写）。 */
export function ensureTreasuryAttemptLineageStoreValidated(): string | null {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithLineage | undefined)?.treasury;
  if (branch?.attemptLineage === undefined) return null;
  return loadLineageStoreRuntime().fatal;
}

// ── 读取（冻结快照） ────────────────────────────────────────────────────────

function freezeRecord(record: TreasuryAttemptLineageRecord): Readonly<TreasuryAttemptLineageRecord> {
  return treasuryBoundedDeepFreezeSnapshot(record) as Readonly<TreasuryAttemptLineageRecord>;
}

export function readTreasuryAttemptLineageRecord(lineageId: string): Readonly<TreasuryAttemptLineageRecord> | undefined {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return undefined;
  for (const record of Object.values(runtime.store.entries)) {
    if (record.lineageId === lineageId) return freezeRecord(record);
  }
  return undefined;
}

/** root ∪ current 索引 O(1) 查询（prepare 门禁的 retired 检测）。 */
export function lookupTreasuryAttemptLineageByAttemptId(transactionId: string): Readonly<TreasuryAttemptLineageRecord> | undefined {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.rootIndex.get(transactionId) ?? runtime.currentIndex.get(transactionId);
  if (key === undefined) return undefined;
  const record = runtime.store.entries[key];
  if (record === undefined) {
    lineageStoreEvents.indexCorruptions += 1;
    return undefined;
  }
  return freezeRecord(record);
}

/** next-child 索引 O(1) 查询（child 占用检测的一部分）。 */
export function lookupTreasuryAttemptLineageByNextChild(childTransactionId: string): Readonly<TreasuryAttemptLineageRecord> | undefined {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return undefined;
  const key = runtime.nextChildIndex.get(childTransactionId);
  if (key === undefined) return undefined;
  const record = runtime.store.entries[key];
  if (record === undefined) {
    lineageStoreEvents.indexCorruptions += 1;
    return undefined;
  }
  return freezeRecord(record);
}

// ── 容量预检 ────────────────────────────────────────────────────────────────

/**
 * 容量预检（新 root chain 前执行；在任何原状态变化之前）：同 root 已存在
 * 不占新 slot；满载拒绝（fail closed——**不驱逐**旧 record）。
 */
export function ensureTreasuryLineageSlotAvailable(rootTransactionId?: string): string | null {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return runtime.fatal;
  if (rootTransactionId !== undefined && runtime.rootIndex.has(rootTransactionId)) return null;
  if (runtime.store.entryCount < TREASURY_LINEAGE_MAX_ENTRIES) return null;
  return `attempt lineage store 已达硬容量 ${String(TREASURY_LINEAGE_MAX_ENTRIES)}（fail closed——不驱逐安全事实；显式归档协议不属于本轮）`;
}

// ── 写入（clone → 校验 → 转换 → 发布 → read-back → 回滚） ─────────────────

export type TreasuryAttemptLineageWriteResult =
  | { readonly status: "written"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly status: "updated"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly status: "idempotent"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly status: "rejected"; readonly detail: string };

function writeLineageRecord(candidate: TreasuryAttemptLineageRecord): TreasuryAttemptLineageWriteResult {
  const shapeError = validateTreasuryAttemptLineageRecordShape(candidate);
  if (shapeError !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `拒绝写入非法 lineage record: ${shapeError}` };
  }
  const stateError = validateTreasuryAttemptLineageRecordState(candidate);
  if (stateError !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `拒绝写入语义非法 lineage record: ${stateError}` };
  }
  const runtime = loadLineageStoreRuntime(true);
  if (!runtime.published) publishLineageStoreToMemory(runtime);
  if (runtime.fatal !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: runtime.fatal };
  }
  // 写入目标 store 是 runtime.store（同一引用——fatal 为 null 时可信）。
  const store = runtime.store;
  const key = LINEAGE_KEY_PREFIX + candidate.rootTransactionId;
  const existing = Object.prototype.hasOwnProperty.call(store.entries, key) ? store.entries[key] : undefined;
  const transition = validateTreasuryAttemptLineageTransition(existing, candidate);
  if (transition.status === "rejected") {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `lineage 状态机拒绝: ${transition.detail}` };
  }
  if (transition.status === "idempotent") {
    return { status: "idempotent", record: freezeRecord(existing!) };
  }
  if (existing === undefined) {
    // 新 root：占用新 slot——满载 fail closed（预检之外的双保险）。
    if (store.entryCount >= TREASURY_LINEAGE_MAX_ENTRIES) {
      lineageStoreEvents.writeFailures += 1;
      return {
        status: "rejected",
        detail: `attempt lineage store 已达硬容量 ${String(TREASURY_LINEAGE_MAX_ENTRIES)}（fail closed——不驱逐安全事实）`,
      };
    }
  }
  // 深拷贝发布（调用方输入与 Memory 无共享引用）。
  const previous = existing === undefined ? undefined : cloneTreasuryDurableValue(existing);
  store.entries[key] = cloneTreasuryDurableValue(candidate);
  store.updatedAt = Game.time;
  // read-back 重算验证（发布失败完整回滚）。
  const readBack = store.entries[key];
  const readBackError =
    validateTreasuryAttemptLineageRecordShape(readBack) === null && validateTreasuryAttemptLineageRecordState(readBack) === null && readBack!.lineageId === candidate.lineageId
      ? null
      : "lineage read-back 验证失败";
  if (readBackError !== null) {
    if (previous === undefined) delete store.entries[key];
    else store.entries[key] = previous;
    store.updatedAt = Game.time;
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: readBackError };
  }
  if (existing === undefined) store.entryCount += 1;
  // 索引同步维护。
  if (existing !== undefined) {
    runtime.currentIndex.delete(existing.currentTransactionId);
    if (existing.nextChildTransactionId !== undefined) runtime.nextChildIndex.delete(existing.nextChildTransactionId);
    runtime.pendingIds.delete(existing.lineageId);
  }
  runtime.rootIndex.set(readBack!.rootTransactionId, key);
  runtime.currentIndex.set(readBack!.currentTransactionId, key);
  if (readBack!.nextChildTransactionId !== undefined) runtime.nextChildIndex.set(readBack!.nextChildTransactionId, key);
  if (readBack!.state === "retiring" || readBack!.state === "capability_issued" || readBack!.state === "child_intent_pending") {
    runtime.pendingIds.add(readBack!.lineageId);
  }
  lineageStoreEvents.writes += 1;
  return {
    status: existing === undefined ? "written" : "updated",
    record: freezeRecord(readBack!),
  };
}

/** 新建 root chain 的 retiring record（final not-executed staged publication）。 */
export function createTreasuryAttemptLineageRecord(input: {
  readonly rootTransactionId: string;
  readonly rootIdentity: TreasuryAttemptLineageIdentity;
  readonly actionKind: string;
  readonly authorityClass: TreasuryLineageAuthorityClass;
  readonly lowlevelSource?: string;
  readonly rearmable: boolean;
  readonly retrySemanticDigest?: string;
  readonly nonRearmReason?: string;
  readonly adapterSemanticIdentity?: string;
  readonly ownerIdentity?: string;
}): TreasuryAttemptLineageWriteResult {
  const slotError = ensureTreasuryLineageSlotAvailable(input.rootTransactionId);
  if (slotError !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: slotError };
  }
  // 统一从 retiring 开始（rearmable 与否）——retirement 三段完成后由
  // complete/backfill 推进到 rearm_ready 或 non_rearmable_retired 终态。
  const now = Game.time;
  return writeLineageRecord({
    lineageId: computeTreasuryAttemptLineageId(input.rootTransactionId, input.rootIdentity),
    rootTransactionId: input.rootTransactionId,
    rootIdentity: cloneTreasuryDurableValue(input.rootIdentity),
    currentTransactionId: input.rootTransactionId,
    currentIdentity: cloneTreasuryDurableValue(input.rootIdentity),
    actionKind: input.actionKind,
    ...(input.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: input.adapterSemanticIdentity } : {}),
    ...(input.ownerIdentity !== undefined ? { ownerIdentity: input.ownerIdentity } : {}),
    generation: 0,
    state: "retiring",
    resolutionState: "not_executed",
    ...(input.retrySemanticDigest !== undefined ? { retrySemanticDigest: input.retrySemanticDigest } : {}),
    authorityClass: input.authorityClass,
    ...(input.lowlevelSource !== undefined ? { lowlevelSource: input.lowlevelSource } : {}),
    rearmable: input.rearmable,
    ...(input.nonRearmReason !== undefined ? { nonRearmReason: input.nonRearmReason } : {}),
    retirement: { lineagePublished: false, authorityReleased: false, markerCleaned: false },
    recordRevision: 0,
    createdAtTick: now,
    updatedAtTick: now,
  });
}

/**
 * 受控状态推进（capability 签发 / child 接管 / 终态 / 三段补完成的唯一
 * mutation 入口）：next 必须通过状态机与不可变事实校验。
 */
export function updateTreasuryAttemptLineageRecord(
  lineageId: string,
  mutate: (current: Readonly<TreasuryAttemptLineageRecord>) => TreasuryAttemptLineageRecord,
): TreasuryAttemptLineageWriteResult {
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: runtime.fatal };
  }
  const existing = readTreasuryAttemptLineageRecord(lineageId);
  if (existing === undefined) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: `lineage ${lineageId.slice(0, 16)} 不存在（不可凭空推进）` };
  }
  const next = mutate(existing);
  if (next.recordRevision !== existing.recordRevision + 1) {
    lineageStoreEvents.writeFailures += 1;
    return { status: "rejected", detail: "mutation 必须基于最新 record 推进 recordRevision+1" };
  }
  return writeLineageRecord(next);
}

// ── beginTick 恢复 ──────────────────────────────────────────────────────────

export interface TreasuryLineageRecoveryResult {
  readonly skipped: string | null;
  readonly capabilityExpiries: number;
  readonly childIntentRollbacks: number;
  readonly childIntentForensics: number;
  readonly retirementCompletions: number;
  readonly backfills: number;
}

/**
 * 【第十七轮第五节/第十三节】beginTick lineage 恢复（挂 facade performBeginTick，
 * 位于 recoverStagedResolutions 之后——释放/清 marker 的补完成先行，lineage
 * 三段随最终持久事实收敛）：
 * - capability_issued（跨 tick/global reset）：heap capability 已失效 → 回退
 *   rearm_ready（保留 nextChildTransactionId——child ID 确定性不变，可重签）；
 * - child_intent_pending：intent 缺失或一致 not_started → 回滚 rearm_ready
 *   （一致时先释放 intent）；intent identity 不一致 / 非初始状态 → forensic；
 * - retiring：按 resolver 四态与 marker 终态补完成三段（release/marker 的
 *   实际动作由 recoverStagedResolutions 承担——这里只收敛 durable 标志）；
 * - pendingRelease 索引中无 lineage record 的 final not-executed tombstone：
 *   backfill（Round 16 遗留——authority 仍在场可取 retry facts 则 rearmable
 *   candidate，否则 non-rearmable retired；不猜测）。
 * 空闲（pendingIds 与 pendingRelease 索引均空）→ O(1) 快路径，不扫描 entries。
 */
export function recoverTreasuryAttemptLineageAtTickBoundary(pendingReleaseSnapshot?: readonly string[]): TreasuryLineageRecoveryResult {
  const empty: TreasuryLineageRecoveryResult = {
    skipped: null,
    capabilityExpiries: 0,
    childIntentRollbacks: 0,
    childIntentForensics: 0,
    retirementCompletions: 0,
    backfills: 0,
  };
  const runtime = loadLineageStoreRuntime();
  if (runtime.fatal !== null) return { ...empty, skipped: runtime.fatal };
  // facade 在 recoverStagedResolutions 之前传入快照（补完成会移除索引项）；
  // 缺省时自行读取（独立调用兼容）。
  const pendingReleaseIds = pendingReleaseSnapshot ?? listTreasuryPendingReleaseIds();
  if (runtime.pendingIds.size === 0 && pendingReleaseIds.length === 0) {
    lineageStoreEvents.idleFastPath += 1;
    return empty;
  }
  let result: TreasuryLineageRecoveryResult = empty;
  // 1) 现有 record 的恢复动作。
  for (const lineageId of [...runtime.pendingIds]) {
    const record = readTreasuryAttemptLineageRecord(lineageId);
    if (record === undefined) {
      // 索引项失效（Memory 已无该 record）——索引只是定位器，清理。
      runtime.pendingIds.delete(lineageId);
      lineageStoreEvents.indexCorruptions += 1;
      continue;
    }
    if (record.state === "capability_issued") {
      const updated = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
        ...current,
        state: "rearm_ready",
        updatedAtTick: Game.time,
        recordRevision: current.recordRevision + 1,
      }));
      if (updated.status !== "rejected") {
        lineageStoreEvents.capabilityExpiries += 1;
        result = { ...result, capabilityExpiries: result.capabilityExpiries + 1 };
      }
      continue;
    }
    if (record.state === "child_intent_pending") {
      const childId = record.nextChildTransactionId!;
      const intent = readTreasuryIntentEntry(childId);
      if (intent === undefined) {
        const rolled = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
          ...current,
          state: "rearm_ready",
          updatedAtTick: Game.time,
          recordRevision: current.recordRevision + 1,
        }));
        if (rolled.status !== "rejected") {
          lineageStoreEvents.childIntentRollbacks += 1;
          result = { ...result, childIntentRollbacks: result.childIntentRollbacks + 1 };
        }
        continue;
      }
      const bindingConsistent =
        (intent.lineageBindingDigest === undefined && record.bindingDigest === undefined) ||
        intent.lineageBindingDigest === record.bindingDigest;
      if (intent.outcome === "not_started" && intent.settlement === "ready" && bindingConsistent) {
        // callback 从未开始：释放 intent 并回滚 lineage（capability 已随
        // tick/global reset 失效，可重签同一 child ID）。
        releaseTreasuryIntentEntry(childId);
        const rolled = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
          ...current,
          state: "rearm_ready",
          updatedAtTick: Game.time,
          recordRevision: current.recordRevision + 1,
        }));
        if (rolled.status !== "rejected") {
          lineageStoreEvents.childIntentRollbacks += 1;
          result = { ...result, childIntentRollbacks: result.childIntentRollbacks + 1 };
        }
        continue;
      }
      // intent 非初始状态或 binding 不一致：child_intent_pending 窗口内 callback
      // 不可能开始——持久状态违反不变量，forensic 隔离（不猜测）。
      const isolated = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
        ...current,
        state: "forensic_isolated",
        rearmable: false,
        nonRearmReason: "child_intent_pending 窗口 intent 状态非法（callback 前不得离开 not_started/ready 或改变 binding）",
        updatedAtTick: Game.time,
        recordRevision: current.recordRevision + 1,
      }));
      if (isolated.status !== "rejected") {
        lineageStoreEvents.childIntentForensics += 1;
        result = { ...result, childIntentForensics: result.childIntentForensics + 1 };
      }
      continue;
    }
    if (record.state === "retiring") {
      // 三段补完成：release/marker 的实际补动作由 recoverStagedResolutions 完成
      //（顺序在前）——这里按最终持久事实收敛标志。
      const authorityResolution = resolveTreasuryUnresolvedAuthority(record.currentTransactionId);
      const authorityReleased =
        authorityResolution.status === "not_found"
          ? true
          : authorityResolution.status === "ok"
            ? false
            : null; // inconsistent/store_unhealthy → 不可判定，保持 pending。
      let markerCleaned: boolean | null;
      if (record.retirement.markerCleaned) {
        markerCleaned = true;
      } else {
        // marker 属于其它 attempt 或不存在 → 清理完成；属于本 attempt 且仍
        // unresolved → 未完成（recoverStagedResolutions 已尝试过清除）。
        markerCleaned = null; // 由调用侧 marker 终态判定（见下）。
      }
      if (markerCleaned === null) {
        // 只读检查 marker 是否仍指向本 attempt（未深度 import writeFault 的
        // 清除语义——恢复只收敛标志，清除动作由 resolution 恢复承担）。
        const marker = readLineageRecoveryMarker();
        markerCleaned =
          marker === undefined ||
          marker.transactionId !== record.currentTransactionId ||
          marker.digest !== record.currentIdentity.digest;
      }
      if (authorityReleased === true && markerCleaned === true) {
        const completed = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
          ...current,
          state: current.rearmable ? "rearm_ready" : "non_rearmable_retired",
          retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
          updatedAtTick: Game.time,
          recordRevision: current.recordRevision + 1,
        }));
        if (completed.status !== "rejected") {
          lineageStoreEvents.retirementCompletions += 1;
          result = { ...result, retirementCompletions: result.retirementCompletions + 1 };
        }
      }
      continue;
    }
  }
  // 2) pendingRelease 索引中无 lineage record 的 final not-executed（Round 16
  //    遗留 / lineage 写失败中断）——backfill。
  for (const transactionId of pendingReleaseIds) {
    const existing = lookupTreasuryAttemptLineageByAttemptId(transactionId);
    if (existing !== undefined) continue;
    const tombstone = readTreasuryResolutionTombstone(transactionId);
    if (tombstone === undefined || tombstone.stage !== "final" || tombstone.resolution !== "not-executed") continue;
    const backfilled = backfillLineageFromTombstone(transactionId, tombstone);
    if (backfilled) {
      lineageStoreEvents.backfills += 1;
      result = { ...result, backfills: result.backfills + 1 };
    }
  }
  return result;
}

/** 恢复路径的 marker 只读视图（避免与 writeFault 清除语义耦合的轻量转发）。 */
let lineageRecoveryMarkerReader: () => { readonly transactionId: string; readonly digest: string } | undefined = () => undefined;

/** facade 装配时注入 marker 读取（保持模块单向依赖：writeFault → 不 import 本模块）。 */
export function setTreasuryLineageRecoveryMarkerReaderForAssembly(
  reader: () => { readonly transactionId: string; readonly digest: string } | undefined,
): void {
  lineageRecoveryMarkerReader = reader;
}

function readLineageRecoveryMarker(): { readonly transactionId: string; readonly digest: string } | undefined {
  return lineageRecoveryMarkerReader();
}

/**
 * Round 16 旧 final not-executed tombstone 的 backfill（任务 6.3）：
 * - authority（intent/quarantine）仍在场且 modern/lowlevel facts 完整：
 *   rearmable candidate（retry semantic facts 从 authority 计算——由调用侧
 *   计算后经 createTreasuryAttemptLineageRecord 传入？不——backfill 保持
 *   non-rearmable 语义：tombstone 自身不携带 action retry 语义，authority
 *   仍释放前的事实不足以重建受控 retry digest（prevalidate 上下文缺失），
 *   统一 non-rearmable retired（永久阻断 parent、不签发 capability）；
 * - identity partial 或矛盾 → forensic_isolated（tombstone 保持 pin）；
 * - 容量不足 → 不写（tombstone 保持 pin，fail closed）。
 */
function backfillLineageFromTombstone(
  transactionId: string,
  tombstone: Readonly<{ transactionId: string; digest: string; proofLevel: string; contractDigest?: string; authorizationCohortDigest?: string; durableIdentityDigest?: string; lowlevelSource?: string }>,
): boolean {
  if (tombstone.proofLevel !== "identity-bound" && tombstone.proofLevel !== "lowlevel") {
    // legacy/forensic proof：不建 rearmable 权威——identity partial 矛盾按
    // forensic 隔离；legacy 无现代身份事实也按 forensic 隔离（不猜测）。
    const authorityClass: TreasuryLineageAuthorityClass = "identity-bound";
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: transactionId,
      rootIdentity: { digest: tombstone.digest },
      actionKind: `backfilled:${String(tombstone.proofLevel)}`,
      authorityClass,
      rearmable: false,
      nonRearmReason: `Round16 backfill：proof level ${String(tombstone.proofLevel)} 不可 rearm（隔离退休）`,
    });
    return created.status !== "rejected";
  }
  const identity: TreasuryAttemptLineageIdentity = {
    digest: tombstone.digest,
    ...(tombstone.contractDigest !== undefined ? { contractDigest: tombstone.contractDigest } : {}),
    ...(tombstone.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: tombstone.authorizationCohortDigest } : {}),
    ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
    ...(tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
  };
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: identity,
    actionKind: `backfilled:${String(tombstone.proofLevel)}`,
    authorityClass: tombstone.proofLevel === "lowlevel" ? "lowlevel" : "identity-bound",
    ...(tombstone.proofLevel === "lowlevel" && tombstone.lowlevelSource !== undefined
      ? { lowlevelSource: tombstone.lowlevelSource }
      : {}),
    // Round 16 tombstone 只有 attempt proof、无 action retry 语义——
    // non-rearmable retired（永久阻断 parent ID 重用；不签发 capability）。
    rearmable: false,
    nonRearmReason: "Round16 backfill：只有 attempt proof、缺少 action retry 语义（non-rearmable retired）",
  });
  if (created.status === "rejected") return false;
  // backfill record 直接落终态（retirement 视 authority/marker 终态收敛——
  // recoverStagedResolutions 已先行补完成释放与清 marker）。
  const record = created.record;
  const authorityResolution = resolveTreasuryUnresolvedAuthority(transactionId);
  const marker = readLineageRecoveryMarker();
  const markerCleaned =
    marker === undefined || marker.transactionId !== transactionId || marker.digest !== tombstone.digest;
  const authorityReleased = authorityResolution.status === "not_found";
  const threeComplete = authorityReleased && markerCleaned;
  const completed = updateTreasuryAttemptLineageRecord(record.lineageId, (current) => ({
    ...current,
    // 三段全完成时收敛终态（Round 16 backfill 全部 non-rearmable）；
    // authority/marker 未清则保持 retiring（beginTick 后续 tick 继续收敛）。
    state: threeComplete ? "non_rearmable_retired" : current.state,
    retirement: { lineagePublished: true, authorityReleased, markerCleaned },
    updatedAtTick: Game.time,
    recordRevision: current.recordRevision + 1,
  }));
  return completed.status !== "rejected";
}
