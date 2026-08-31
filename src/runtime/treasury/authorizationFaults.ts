/**
 * Pre-execution authorization fault 的 durable authority（第十一轮 3.13.1）。
 *
 * `internal_authorization_fault` 的固定事实：execution outcome = not_started、
 * authorization 状态已完整回滚（预算/容量/消费标记恢复、bundle 保持 active）、
 * Game callback 未调用。此前只写全局 write-fault marker——该 transaction 无
 * quarantine/intent entry，现有 fault resolution（authority 来自 quarantine/
 * intent）对其 not_found，marker 永不解除 → 永久锁死。
 *
 * 本 store 在 marker 写入前建立有界持久 authority（Memory.runtime.treasury.
 * authorizationFaults，version 1，key "af:"+transactionId，上限 64），保存
 * transaction/contract/cohort 身份、canonical postings、fault tick 与
 * rollback 确认。恢复协议（facade.resolveUnresolvedTransaction 的
 * acknowledge-rolled-back 路由）：不需要 action reconciler（协议已证明 Game
 * 未执行）；验证完整 identity；写 not-executed final tombstone（preExecution
 * 标志）→ 清 marker → 删 entry；幂等；其他 commit/execution fault 不可使用
 * 该通道；无任何无条件 clear-marker 入口。
 */

import type { TreasuryAuthorizationCohortFacts } from "@/runtime/treasury/authorization";
import { validateTreasuryAuthorizationCohortFacts } from "@/runtime/treasury/cohortValidation";
import {
  classifyTreasuryAuthorityLevelForMigration,
  treasuryMigrationLevelAnnotations,
  validateTreasuryAuthorityLevelConsistency,
  TREASURY_LOWLEVEL_SOURCE_RUNTIME,
  type TreasuryAuthorityLevel,
  type TreasuryAuthorityMatrixOptions,
} from "@/runtime/treasury/authorityLevel";
import { validateTreasuryStructureDescriptorArray } from "@/runtime/treasury/structureDescriptorValidation";
import {
  verifyTreasuryEntryIdentity,
  recomputeTreasuryDurableIdentityDigest,
  type TreasuryIdentityFactsEntry,
} from "@/runtime/treasury/identityProof";
import {
  verifyTreasuryDurableCandidateForPublication,
  verifyTreasuryDurablePublicationReadBack,
} from "@/runtime/treasury/durablePublication";
import { compareTreasuryAuthoritySameIdIdentity } from "@/runtime/treasury/authorityIdempotence";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";
import type { TreasuryStructureBindingDescriptor } from "@/runtime/treasury/types";
import {
  TREASURY_STRUCTURE_BINDING_KINDS,
  TREASURY_STRUCTURE_BINDING_ROLES,
  TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
} from "@/runtime/treasury/types";

/**
 * 【第十四轮】authorization-fault v4：lowlevel 严格矩阵（lowlevelSource
 * 来源标记）+ read-back 完整身份比较 + health probe metadata 门禁。
 */
const AUTHORIZATION_FAULT_VERSION = 4 as const;
export const TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES = 64;
const AUTHORIZATION_FAULT_KEY_PREFIX = "af:";
const FAULT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const FAULT_KIND_SOURCE_MAX = 128;
const FAULT_DETAIL_MAX = 192;
const FAULT_POSTINGS_MAX = 32;
const FAULT_VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);

/** pre-execution authorization fault 的 durable authority entry。 */
export interface TreasuryAuthorizationFaultEntry {
  readonly transactionId: string;
  /** 【第十三轮】显式 authority 等级（modern/legacy/lowlevel——不得由字段推断）。 */
  authorityLevel: TreasuryAuthorityLevel;
  /** 【第十四轮第九节】lowlevel 显式来源标记（lowlevel 等级必填）。 */
  lowlevelSource?: string;
  /** canonical payload digest（contract digest 同源）。 */
  readonly digest: string;
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly actionKind?: string;
  /** authorization bundle digest。 */
  readonly authorizationDigest?: string;
  /** canonical authorization cohort digest（有 cohort 时）。 */
  readonly authorizationCohortDigest?: string;
  // ── v2（第十二轮 3.2：完整 durable identity 事实——identity 可由持久事实重算）。 ──
  /** 完整 cohort facts（重算 cohort digest 与 durable identity 的输入）。 */
  readonly authorizationCohort?: TreasuryAuthorizationCohortFacts;
  readonly adapterVersion?: number;
  readonly adapterRegistrationId?: string;
  /** 稳定 adapter/reconciler 语义身份（contract 路径）。 */
  readonly adapterSemanticIdentity?: string;
  readonly ownerIdentity?: string;
  readonly policyIdentity?: string;
  /** structure incarnation facts（有界 ≤16）。 */
  readonly structureFacts?: readonly TreasuryStructureBindingDescriptor[];
  /** 统一 durable action identity digest（由上述事实重算验证）。 */
  readonly durableIdentityDigest?: string;
  /** v1 迁移 entry（身份事实不完整——仅按 digest 匹配的旧协议解除）。 */
  readonly legacyV1?: boolean;
  /** canonical postings（有界 ≤32；资产事实快照）。 */
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly faultTick: number;
  /** 固定事实：outcome = not_started（callback 未调用）。 */
  readonly outcome: "not_started";
  /** 固定事实：authorization 状态已完整回滚。 */
  readonly rollbackConfirmed: true;
  readonly source: string;
  readonly detail?: string;
}

export interface TreasuryAuthorizationFaultStore {
  version: 4;
  entries: Record<string, TreasuryAuthorizationFaultEntry>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryAuthorizationFaultBranch {
  authorizationFaults?: TreasuryAuthorizationFaultStore;
}

type RuntimeMemoryWithFaults = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryAuthorizationFaultBranch;
};

const faultEvents = {
  writeRejections: 0,
  writeFailures: 0,
  releases: 0,
  fullScans: 0,
  loadValidationEntries: 0,
};

export function readTreasuryAuthorizationFaultCounters(): typeof faultEvents {
  return { ...faultEvents };
}

export function resetTreasuryAuthorizationFaultRuntimeForTest(): void {
  heapFaultRuntime = null;
  faultEvents.writeRejections = 0;
  faultEvents.writeFailures = 0;
  faultEvents.releases = 0;
  faultEvents.fullScans = 0;
  faultEvents.loadValidationEntries = 0;
}

function faultBranch(): TreasuryAuthorizationFaultBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithFaults;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** 只读读取原始 store（零写）。 */
export function peekTreasuryAuthorizationFaultStore(): TreasuryAuthorizationFaultStore | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithFaults | undefined)?.treasury?.authorizationFaults;
}

function encodeFaultKey(transactionId: string): string {
  return AUTHORIZATION_FAULT_KEY_PREFIX + transactionId;
}

function validateFaultEntryShape(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "authorization fault entry 非对象";
  const candidate = entry as Partial<TreasuryAuthorizationFaultEntry>;
  if (typeof candidate.transactionId !== "string" || candidate.transactionId.length === 0 || candidate.transactionId.length > 128) {
    return "transactionId 非法（须为 1..128 字符）";
  }
  if (typeof candidate.digest !== "string" || !FAULT_DIGEST_PATTERN.test(candidate.digest)) {
    return "digest 非法（须为 16 小写 hex）";
  }
  // 【第十三轮第八节】显式 authorityLevel 一致性（fault 矩阵：pre-execution
  // authority 无 durable payload / 独立 structure descriptors——结构事实由
  // contract digest 绑定；cohort facts 与 digest 成对）。
  const levelError = validateTreasuryAuthorityLevelConsistency(
    candidate as unknown as Parameters<typeof validateTreasuryAuthorityLevelConsistency>[0],
    { requireDurablePayload: false, requireStructureFacts: false } satisfies TreasuryAuthorityMatrixOptions,
  );
  if (levelError !== null) return levelError;
  if (candidate.contractId !== undefined && (typeof candidate.contractId !== "string" || candidate.contractId.length === 0 || candidate.contractId.length > 96)) {
    return "contractId 非法";
  }
  if (candidate.contractDigest !== undefined && (typeof candidate.contractDigest !== "string" || !FAULT_DIGEST_PATTERN.test(candidate.contractDigest))) {
    return "contractDigest 非法";
  }
  if (candidate.actionKind !== undefined && (typeof candidate.actionKind !== "string" || candidate.actionKind.length === 0 || candidate.actionKind.length > FAULT_KIND_SOURCE_MAX)) {
    return "actionKind 非法";
  }
  if (candidate.authorizationDigest !== undefined && (typeof candidate.authorizationDigest !== "string" || !FAULT_DIGEST_PATTERN.test(candidate.authorizationDigest))) {
    return "authorizationDigest 非法";
  }
  if (candidate.authorizationCohortDigest !== undefined && (typeof candidate.authorizationCohortDigest !== "string" || !FAULT_DIGEST_PATTERN.test(candidate.authorizationCohortDigest))) {
    return "authorizationCohortDigest 非法";
  }
  if (!Array.isArray(candidate.postings) || candidate.postings.length === 0 || candidate.postings.length > FAULT_POSTINGS_MAX) {
    return "postings 非数组/为空/超上限";
  }
  for (const posting of candidate.postings) {
    if (!posting || typeof posting !== "object") return "posting 项非对象";
    const leg = posting as Partial<{ roomName: string; locationKind: string; resource: string; delta: number }>;
    if (typeof leg.roomName !== "string" || leg.roomName.length === 0 || leg.roomName.length > 16) return "posting.roomName 非法";
    if (typeof leg.locationKind !== "string" || (leg.locationKind !== "storage" && leg.locationKind !== "terminal")) {
      return `posting.locationKind 非法: ${String(leg.locationKind).slice(0, 24)}`;
    }
    if (typeof leg.resource !== "string" || !FAULT_VALID_RESOURCES.has(leg.resource)) {
      return `posting.resource 不在 RESOURCES_ALL: ${String(leg.resource).slice(0, 24)}`;
    }
    if (typeof leg.delta !== "number" || !Number.isSafeInteger(leg.delta) || leg.delta === 0) return "posting.delta 须为非零安全整数";
  }
  if (candidate.adapterVersion !== undefined && (typeof candidate.adapterVersion !== "number" || !Number.isSafeInteger(candidate.adapterVersion) || candidate.adapterVersion <= 0)) {
    return "adapterVersion 须为正安全整数";
  }
  if (candidate.adapterRegistrationId !== undefined && (typeof candidate.adapterRegistrationId !== "string" || !FAULT_DIGEST_PATTERN.test(candidate.adapterRegistrationId))) {
    return "adapterRegistrationId 非法（16 hex）";
  }
  if (candidate.adapterSemanticIdentity !== undefined && (typeof candidate.adapterSemanticIdentity !== "string" || candidate.adapterSemanticIdentity.length === 0 || candidate.adapterSemanticIdentity.length > 128)) {
    return "adapterSemanticIdentity 非法（1..128 字符）";
  }
  if (candidate.ownerIdentity !== undefined && (typeof candidate.ownerIdentity !== "string" || candidate.ownerIdentity.length === 0 || candidate.ownerIdentity.length > 128)) {
    return "ownerIdentity 非法";
  }
  if (candidate.policyIdentity !== undefined && (typeof candidate.policyIdentity !== "string" || candidate.policyIdentity.length === 0 || candidate.policyIdentity.length > 128)) {
    return "policyIdentity 非法";
  }
  if (candidate.durableIdentityDigest !== undefined && (typeof candidate.durableIdentityDigest !== "string" || !FAULT_DIGEST_PATTERN.test(candidate.durableIdentityDigest))) {
    return "durableIdentityDigest 非法（16 hex）";
  }
  if (candidate.structureFacts !== undefined) {
    // 【第十三轮第十节】共享 descriptor validator（此前缺 objectId 校验且不
    // 校验 discriminated union 矛盾——governed_location 携带 objectId 现在
    // 在持久层即拒绝）。
    const descriptorError = validateTreasuryStructureDescriptorArray(candidate.structureFacts, 16);
    if (descriptorError !== null) return descriptorError;
  }
  if (candidate.authorizationCohort !== undefined) {
    // 【第十三轮第九节】共享 cohort validator（唯一权威——全字段 + 异常边界；
    // 替代此前仅 3 项的私有近似副本）。
    const cohortError = validateTreasuryAuthorizationCohortFacts(candidate.authorizationCohort, candidate.transactionId);
    if (cohortError !== null) return cohortError;
  }
  if (!Number.isSafeInteger(candidate.faultTick) || (candidate.faultTick as number) < 0) return "faultTick 非安全整数";
  if (candidate.outcome !== "not_started") {
    return `outcome 非法（pre-execution fault 恒为 not_started）: ${String(candidate.outcome).slice(0, 24)}`;
  }
  if (candidate.rollbackConfirmed !== true) {
    return "rollbackConfirmed 必须为 true（pre-execution fault 协议事实）";
  }
  if (typeof candidate.source !== "string" || candidate.source.length === 0 || candidate.source.length > FAULT_KIND_SOURCE_MAX) {
    return "source 非法";
  }
  if (candidate.detail !== undefined && (typeof candidate.detail !== "string" || candidate.detail.length > FAULT_DETAIL_MAX)) {
    return `detail 非法（≤${String(FAULT_DETAIL_MAX)} 字符）`;
  }
  return null;
}

interface FaultStoreRuntime {
  store: TreasuryAuthorizationFaultStore;
  fatal: string | null;
}

let heapFaultRuntime: FaultStoreRuntime | null = null;

function validateFaultStoreShape(store: TreasuryAuthorizationFaultStore): string | null {
  if (store.version !== AUTHORIZATION_FAULT_VERSION) {
    return `未知 authorizationFaults store 版本 ${String(store.version)}`;
  }
  if (!store.entries || typeof store.entries !== "object") return "authorizationFaults entries 非对象";
  faultEvents.fullScans += 1;
  const ownKeys = Object.keys(store.entries);
  faultEvents.loadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  if (ownKeys.length > TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES) {
    return `entries 超过上限 ${String(TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES)}`;
  }
  for (const key of ownKeys) {
    if (!key.startsWith(AUTHORIZATION_FAULT_KEY_PREFIX)) {
      return `存储键格式非法（须为 "af:"+transactionId）: ${key.slice(0, 48)}`;
    }
    const entry = (store.entries as Record<string, unknown>)[key];
    const shapeError = validateFaultEntryShape(entry);
    if (shapeError !== null) {
      return `${shapeError}（key ${key.slice(0, 48)}）`;
    }
    const typed = entry as TreasuryAuthorizationFaultEntry;
    if (encodeFaultKey(typed.transactionId) !== key) {
      return `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}`;
    }
    // 【第十二轮 3.6】identity 重算验证：现代 entry 的 cohort/durable digest
    // 必须能由持久事实重算一致（legacy v1 entry 无 digest 事实，跳过）。
    if (typed.legacyV1 !== true) {
      const identityError = verifyTreasuryEntryIdentity(typed as TreasuryIdentityFactsEntry, `authorization fault（${key.slice(0, 48)}）`);
      if (identityError !== null) return identityError;
    }
  }
  return null;
}

function loadFaultStoreRuntime(): FaultStoreRuntime {
  if (heapFaultRuntime) return heapFaultRuntime;
  const raw = faultBranch().authorizationFaults as TreasuryAuthorizationFaultStore | undefined;
  if (!raw) {
    const created: TreasuryAuthorizationFaultStore = {
      version: AUTHORIZATION_FAULT_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    faultBranch().authorizationFaults = created;
    heapFaultRuntime = { store: created, fatal: null };
    return heapFaultRuntime;
  }
  if ((raw.version as number) === 1) {
    // v1 → v2 迁移（第十二轮 3.2，原子）：v1 entry 身份事实不完整——标记
    // legacyV1（仅按 digest 匹配的旧协议解除，不参与现代 identity 幂等）；
    // 任何形状损坏 → fatal（原数据保留，人工处理）。
    const entries: Record<string, TreasuryAuthorizationFaultEntry> = {};
    faultEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const typed = value as TreasuryAuthorizationFaultEntry;
      if (encodeFaultKey(typed.transactionId) !== key) {
        heapFaultRuntime = { store: raw, fatal: `v1 存储键与 transactionId 不一致: ${key.slice(0, 48)}（原数据保留）` };
        return heapFaultRuntime;
      }
      // v1 entry 无 authorityLevel（v3 起必填）——补显式 legacy 等级后按目标
      // 形状校验（其余字段损坏 → fatal 原数据保留）。
      const candidate: TreasuryAuthorizationFaultEntry = { ...typed, authorityLevel: "legacy", legacyV1: true };
      const shapeError = validateFaultEntryShape(candidate);
      if (shapeError !== null) {
        heapFaultRuntime = { store: raw, fatal: `${shapeError}（v1 fault entry 损坏，人工处理；key ${key.slice(0, 48)}）` };
        return heapFaultRuntime;
      }
      entries[key] = candidate;
    }
    const upgraded: TreasuryAuthorizationFaultStore = { version: AUTHORIZATION_FAULT_VERSION, entries, entryCount: Object.keys(entries).length, updatedAt: Game.time };
    const upgradedError = validateFaultStoreShape(upgraded);
    if (upgradedError !== null) {
      heapFaultRuntime = { store: raw, fatal: `${upgradedError}（v1→v2 升级自检失败，authorizationFaults fail closed，原数据保留）` };
      return heapFaultRuntime;
    }
    faultBranch().authorizationFaults = upgraded;
    heapFaultRuntime = { store: upgraded, fatal: null };
    return heapFaultRuntime;
  }
  if ((raw.version as number) === 2) {
    // v2 → v4 迁移（【第十三轮第八节】显式 authorityLevel 定级 + 【第十四轮】
    // strict lowlevel 重构，原子）：legacyV1 → legacy；矩阵全齐（fault 矩阵）
    // 且重算一致 → modern；完全无现代身份事实 → legacy；**部分现代事实 →
    // forensic 隔离（不再 lowlevel）**；cohort 不成对或重算矛盾 → fatal
    // 原数据保留。
    const entries: Record<string, TreasuryAuthorizationFaultEntry> = {};
    faultEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const typed = value as TreasuryAuthorizationFaultEntry;
      const [level, error] = classifyTreasuryAuthorityLevelForMigration(
        typed as unknown as Parameters<typeof classifyTreasuryAuthorityLevelForMigration>[0],
        { requireDurablePayload: false, requireStructureFacts: false },
      );
      if (error !== null || level === null) {
        heapFaultRuntime = { store: raw, fatal: `v2→v4 迁移定级失败（key ${key.slice(0, 48)}）: ${error ?? "未知"}（原数据保留）` };
        return heapFaultRuntime;
      }
      entries[key] = { ...typed, authorityLevel: level, ...treasuryMigrationLevelAnnotations(level) };
    }
    const upgraded: TreasuryAuthorizationFaultStore = { version: AUTHORIZATION_FAULT_VERSION, entries, entryCount: Object.keys(entries).length, updatedAt: Game.time };
    const upgradedError = validateFaultStoreShape(upgraded);
    if (upgradedError !== null) {
      heapFaultRuntime = { store: raw, fatal: `${upgradedError}（v2→v4 升级自检失败，authorizationFaults fail closed，原数据保留）` };
      return heapFaultRuntime;
    }
    faultBranch().authorizationFaults = upgraded;
    heapFaultRuntime = { store: upgraded, fatal: null };
    return heapFaultRuntime;
  }
  if ((raw.version as number) === 3) {
    // v3 → v4 迁移（【第十四轮第九/十节】strict lowlevel 矩阵，原子）：按
    // 显式 priorAuthorityLevel 复验——显式 lowlevel 满足严格矩阵 → lowlevel
    //（补 migrated 来源标记）；不满足或 modern 矩阵缺失 → forensic 隔离；
    // 重算矛盾 → fatal（原数据保留）。
    const entries: Record<string, TreasuryAuthorizationFaultEntry> = {};
    faultEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const typed = value as TreasuryAuthorizationFaultEntry;
      const [level, error] = classifyTreasuryAuthorityLevelForMigration(
        {
          ...(typed as unknown as Record<string, unknown>),
          priorAuthorityLevel: typed.authorityLevel,
        } as unknown as Parameters<typeof classifyTreasuryAuthorityLevelForMigration>[0],
        { requireDurablePayload: false, requireStructureFacts: false },
      );
      if (error !== null || level === null) {
        heapFaultRuntime = { store: raw, fatal: `v3→v4 迁移定级失败（key ${key.slice(0, 48)}）: ${error ?? "未知"}（原数据保留）` };
        return heapFaultRuntime;
      }
      entries[key] = { ...typed, authorityLevel: level, ...treasuryMigrationLevelAnnotations(level) };
    }
    const upgraded: TreasuryAuthorizationFaultStore = { version: AUTHORIZATION_FAULT_VERSION, entries, entryCount: Object.keys(entries).length, updatedAt: Game.time };
    const upgradedError = validateFaultStoreShape(upgraded);
    if (upgradedError !== null) {
      heapFaultRuntime = { store: raw, fatal: `${upgradedError}（v3→v4 升级自检失败，authorizationFaults fail closed，原数据保留）` };
      return heapFaultRuntime;
    }
    faultBranch().authorizationFaults = upgraded;
    heapFaultRuntime = { store: upgraded, fatal: null };
    return heapFaultRuntime;
  }
  const shapeError = validateFaultStoreShape(raw);
  if (shapeError !== null) {
    heapFaultRuntime = { store: raw, fatal: `${shapeError}（authorizationFaults fail closed，原数据保留）` };
    return heapFaultRuntime;
  }
  heapFaultRuntime = { store: raw, fatal: null };
  return heapFaultRuntime;
}

export interface TreasuryAuthorizationFaultHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
}

/**
 * 健康探测（只读零写；readiness/blockers 用）。【第十四轮第十四节】metadata
 * 门禁：store version 受支持集合 / entries 普通对象 / entryCount 非负安全
 * 整数且不超硬容量 / updatedAt 合法安全整数——明显 metadata 矛盾直接
 * unhealthy（readiness fail closed，不等 redemption fault 才发现）。轻量
 * O(1)：不扫描 entries 全表（entry 级损坏由 load 全量验证检出）。
 */
export function peekTreasuryAuthorizationFaultHealth(): TreasuryAuthorizationFaultHealth {
  if (heapFaultRuntime?.fatal) {
    const keys = Object.keys(heapFaultRuntime.store.entries ?? {});
    return { healthy: false, detail: heapFaultRuntime.fatal, entryCount: keys.length };
  }
  const store = peekTreasuryAuthorizationFaultStore();
  if (store === undefined) return { healthy: true, detail: null, entryCount: 0 };
  if (store.version !== AUTHORIZATION_FAULT_VERSION && store.version !== 1 && store.version !== 2 && store.version !== 3) {
    return { healthy: false, detail: `未知 authorizationFaults 版本 ${String(store.version)}`, entryCount: 0 };
  }
  if (!store.entries || typeof store.entries !== "object") {
    return { healthy: false, detail: "authorizationFaults entries 非对象", entryCount: 0 };
  }
  if (typeof store.entryCount !== "number" || !Number.isSafeInteger(store.entryCount) || store.entryCount < 0) {
    return { healthy: false, detail: `authorizationFaults entryCount 非法（须为非负安全整数）: ${String(store.entryCount).slice(0, 24)}`, entryCount: 0 };
  }
  if (store.entryCount > TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES) {
    return { healthy: false, detail: `authorizationFaults entryCount 超过硬上限（${String(store.entryCount)} > ${String(TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES)}）`, entryCount: store.entryCount };
  }
  if (typeof store.updatedAt !== "number" || !Number.isSafeInteger(store.updatedAt) || store.updatedAt < 0) {
    return { healthy: false, detail: `authorizationFaults updatedAt 非法（须为非负安全整数）: ${String(store.updatedAt).slice(0, 24)}`, entryCount: store.entryCount };
  }
  return { healthy: true, detail: null, entryCount: store.entryCount };
}

export type TreasuryAuthorizationFaultWriteResult =
  | { readonly status: "written" }
  | { readonly status: "already_present" }
  | {
      readonly status: "rejected";
      readonly reason: "store_fatal" | "capacity_exhausted" | "invalid_entry" | "identity_conflict";
      readonly detail: string;
    };

/**
 * 写入 pre-execution authorization fault authority（redemption 回滚后、写
 * marker 前）。同 id 已存在 → already_present（幂等重放；durable identity
 * 由 digest/cohort 唯一化，重放同 fault 不产生新 entry）。
 */
export function writeTreasuryAuthorizationFaultEntry(
  entryInput: Omit<TreasuryAuthorizationFaultEntry, "authorityLevel"> & { authorityLevel?: TreasuryAuthorityLevel },
): TreasuryAuthorizationFaultWriteResult {
  // 【第十四轮第九节】authorityLevel 缺省 lowlevel + runtime 来源标记；生产
  // contract redemption 路径由 authorizationLedger 显式声明 modern（矩阵校验
  // 通过才允许）——contract 路径不得写 lowlevel（不变量破坏 → forensic）。
  // 低层 durable identity 为事实的确定性派生——调用方未携带时由 store 在
  // 写入前从候选事实派生。
  const declaredLowlevel =
    (entryInput.authorityLevel === undefined || entryInput.authorityLevel === "lowlevel") && entryInput.legacyV1 !== true;
  const derivedLowlevelIdentity =
    declaredLowlevel && entryInput.durableIdentityDigest === undefined
      ? recomputeTreasuryDurableIdentityDigest(entryInput as unknown as TreasuryIdentityFactsEntry)
      : null;
  const entry: TreasuryAuthorizationFaultEntry = {
    ...entryInput,
    authorityLevel: entryInput.authorityLevel ?? "lowlevel",
    ...(declaredLowlevel ? { lowlevelSource: entryInput.lowlevelSource ?? TREASURY_LOWLEVEL_SOURCE_RUNTIME } : {}),
    ...(derivedLowlevelIdentity !== null ? { durableIdentityDigest: derivedLowlevelIdentity } : {}),
  };
  const shapeError = validateFaultEntryShape(entry);
  if (shapeError !== null) {
    faultEvents.writeRejections += 1;
    return { status: "rejected", reason: "invalid_entry", detail: shapeError };
  }
  // 【第十二轮 3.6 / 第十四轮第十二节】写入前重算：自带 digest 必须与持久
  // 事实重算一致（durablePublication 统一协议）。
  if (entry.legacyV1 !== true) {
    const candidateError = verifyTreasuryDurableCandidateForPublication(entry, `authorization fault 候选（${entry.transactionId.slice(0, 48)}）`);
    if (candidateError !== null) {
      faultEvents.writeRejections += 1;
      return { status: "rejected", reason: "invalid_entry", detail: candidateError };
    }
  }
  const runtime = loadFaultStoreRuntime();
  if (runtime.fatal) {
    faultEvents.writeFailures += 1;
    return { status: "rejected", reason: "store_fatal", detail: runtime.fatal };
  }
  const key = encodeFaultKey(entry.transactionId);
  if (Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) {
    // 【第十二轮 3.2】同 ID 幂等仅限完整 durable identity 一致；identity
    // 不同 → identity_conflict（原数据不动）。
    // 【第十五轮第九节】按 authority class 的 same-ID 幂等（含 faultTick、
    // legacy signature、forensic facts——不再以 durable digest 空对空为通用
    // 幂等证明）；既有非 legacy entry 自身 identity 不可重算 → store fatal
    // （与 intent/quarantine 对齐——被篡改的既有 entry 不得吞掉新写入）。
    const existing = runtime.store.entries[key];
    if (existing.legacyV1 !== true) {
      const existingIdentityError = verifyTreasuryDurableCandidateForPublication(
        existing,
        `authorization fault 既有 entry（${key.slice(0, 48)}）`,
      );
      if (existingIdentityError !== null) {
        faultEvents.writeFailures += 1;
        return { status: "rejected", reason: "store_fatal", detail: existingIdentityError };
      }
    }
    const sameId = compareTreasuryAuthoritySameIdIdentity(
      { ...existing, postings: existing.postings },
      { ...entry, postings: entry.postings },
      `authorization fault 同 id（${key.slice(0, 48)}）`,
    );
    if (sameId.verdict !== "same") {
      faultEvents.writeRejections += 1;
      return {
        status: "rejected",
        reason: "identity_conflict",
        detail: `${sameId.detail}——fail closed，原数据不动`,
      };
    }
    return { status: "already_present" };
  }
  if (runtime.store.entryCount >= TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES) {
    faultEvents.writeFailures += 1;
    return {
      status: "rejected",
      reason: "capacity_exhausted",
      detail: `authorizationFaults 容量已满（${String(TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES)} 条）`,
    };
  }
  runtime.store.entries[key] = {
    ...entry,
    postings: entry.postings.map((leg) => ({ ...leg })),
    ...(entry.structureFacts !== undefined ? { structureFacts: entry.structureFacts.map((fact) => ({ ...fact })) } : {}),
    ...(entry.authorizationCohort !== undefined
      ? {
          authorizationCohort: {
            ...entry.authorizationCohort,
            revisions: { ...entry.authorizationCohort.revisions },
            authorizationLegDigests: [...entry.authorizationCohort.authorizationLegDigests],
          },
        }
      : {}),
  };
  const previousUpdatedAt = runtime.store.updatedAt;
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  // 【第十二轮 3.1.8 / 第十四轮第十二节】read-back 验证升级为完整身份比较：
  // 从持久副本重算 identity + 与声明 entry 的全部结构化身份字段逐项比较
  //（不再只是 digest/durableIdentityDigest/cohortDigest/transactionId 四项）
  // ——不一致视为 store 不可信（回退写入并恢复 entryCount/updatedAt，不得
  // 发布 marker）。
  // 【第十五轮第十节】注入 authorization-fault 的 store-specific 语义校验
  //（outcome 恒 not_started、rollbackConfirmed 恒 true、faultTick、source、
  // detail 边界、authority 矩阵）+ 回滚恢复原 updatedAt（不再错写
  // Game.time）。
  const readBackError = verifyTreasuryDurablePublicationReadBack(
    runtime.store.entries[key],
    entry,
    `authorization fault 发布（${key.slice(0, 48)}）`,
    (persisted, label) => {
      const shapeError = validateFaultEntryShape(persisted);
      return shapeError === null ? null : `${label}: ${shapeError}`;
    },
  );
  if (readBackError !== null) {
    faultEvents.writeFailures += 1;
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.store.updatedAt = previousUpdatedAt;
    return {
      status: "rejected",
      reason: "store_fatal",
      detail: `${readBackError}——写入已回退（updatedAt 恢复原值），不得发布 marker`,
    };
  }
  return { status: "written" };
}

/**
 * 显式触发 load 全量验证（【第十四轮第十四节】write readiness / authorization
 * / prepare 门禁用——未验证 store 不得视为可写；损坏 entry 不得等到
 * redemption fault 后才发现）：store 不存在时零写返回 null（不隐式创建）；
 * 存在时触发一次有界全表扫描（heap 缓存，后续 O(1)）。返回 fatal 描述
 * （null = 健康或可写）。
 */
export function ensureTreasuryAuthorizationFaultStoreValidated(): string | null {
  if (peekTreasuryAuthorizationFaultStore() === undefined) return null;
  return loadFaultStoreRuntime().fatal;
}

/**
 * 单条只读查询（O(1)；fatal store 视为不可信返回 undefined）。
 * 【第十五轮第十一节】有界深冻结快照——structureFacts、authorizationCohort
 * （含 revisions / leg digests）等嵌套对象同样封闭，不再泄漏 Memory 引用。
 */
export function readTreasuryAuthorizationFaultEntry(transactionId: string): Readonly<TreasuryAuthorizationFaultEntry> | undefined {
  if (peekTreasuryAuthorizationFaultStore() === undefined) return undefined;
  const runtime = loadFaultStoreRuntime();
  if (runtime.fatal) return undefined;
  const entry = runtime.store.entries[encodeFaultKey(transactionId)];
  return entry === undefined
    ? undefined
    : (treasuryBoundedDeepFreezeSnapshot({
        ...entry,
        postings: entry.postings.map((leg) => ({ ...leg })),
        ...(entry.structureFacts !== undefined ? { structureFacts: entry.structureFacts.map((fact) => ({ ...fact })) } : {}),
        ...(entry.authorizationCohort !== undefined ? { authorizationCohort: { ...entry.authorizationCohort } } : {}),
      }) as Readonly<TreasuryAuthorizationFaultEntry>);
}

/** resolution 路径：释放单条 fault authority（tombstone 写入成功后调用）。 */
export function releaseTreasuryAuthorizationFaultEntry(transactionId: string): boolean {
  const runtime = loadFaultStoreRuntime();
  if (runtime.fatal) return false;
  const key = encodeFaultKey(transactionId);
  if (!Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  faultEvents.releases += 1;
  return true;
}

/** unresolved fault 是否阻断 writer（存在 entry 即阻断——与 marker 同生命周期）。 */
export function treasuryAuthorizationFaultBlockers(): { blocking: boolean; unresolvedCount: number } {
  const health = peekTreasuryAuthorizationFaultHealth();
  if (!health.healthy) return { blocking: true, unresolvedCount: health.entryCount };
  return { blocking: health.entryCount > 0, unresolvedCount: health.entryCount };
}
