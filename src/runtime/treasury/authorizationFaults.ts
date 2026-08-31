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
  verifyTreasuryEntryIdentity,
  type TreasuryIdentityFactsEntry,
} from "@/runtime/treasury/identityProof";
import { treasuryDurableIdentitiesMatch } from "@/runtime/treasury/durableIdentity";
import type { TreasuryStructureBindingDescriptor } from "@/runtime/treasury/types";
import {
  TREASURY_STRUCTURE_BINDING_KINDS,
  TREASURY_STRUCTURE_BINDING_ROLES,
  TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
} from "@/runtime/treasury/types";

const AUTHORIZATION_FAULT_VERSION = 2 as const;
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
  version: 2;
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
    if (!Array.isArray(candidate.structureFacts) || candidate.structureFacts.length > 16) {
      return "structureFacts 非数组或超上限";
    }
    for (const fact of candidate.structureFacts) {
      if (!fact || typeof fact !== "object") return "structureFact 项非对象";
      const typed = fact as Partial<TreasuryStructureBindingDescriptor>;
      if (typeof typed.bindingKind !== "string" || !TREASURY_STRUCTURE_BINDING_KINDS.has(typed.bindingKind)) {
        return `structureFact.bindingKind 非法: ${String(typed.bindingKind).slice(0, 24)}`;
      }
      if (typeof typed.role !== "string" || !TREASURY_STRUCTURE_BINDING_ROLES.has(typed.role)) {
        return `structureFact.role 非法: ${String(typed.role).slice(0, 24)}`;
      }
      if (typeof typed.roomName !== "string" || typed.roomName.length === 0 || typed.roomName.length > 16) return "structureFact.roomName 非法";
      if (typeof typed.locationKind !== "string" || (typed.locationKind !== "storage" && typed.locationKind !== "terminal")) {
        return "structureFact.locationKind 非法";
      }
      if (typeof typed.structureId !== "string" || typed.structureId.length === 0 || typed.structureId.length > 48) return "structureFact.structureId 非法";
      if (typeof typed.required !== "boolean") return "structureFact.required 须为布尔";
      if (typed.version !== TREASURY_STRUCTURE_DESCRIPTOR_VERSION) return "structureFact.version 非法";
    }
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
      const shapeError = validateFaultEntryShape(value);
      if (shapeError !== null) {
        heapFaultRuntime = { store: raw, fatal: `${shapeError}（v1 fault entry 损坏，人工处理；key ${key.slice(0, 48)}）` };
        return heapFaultRuntime;
      }
      const typed = value as TreasuryAuthorizationFaultEntry;
      if (encodeFaultKey(typed.transactionId) !== key) {
        heapFaultRuntime = { store: raw, fatal: `v1 存储键与 transactionId 不一致: ${key.slice(0, 48)}（原数据保留）` };
        return heapFaultRuntime;
      }
      entries[key] = { ...typed, legacyV1: true };
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

/** 健康探测（只读零写；readiness/blockers 用）。 */
export function peekTreasuryAuthorizationFaultHealth(): TreasuryAuthorizationFaultHealth {
  if (heapFaultRuntime?.fatal) {
    const keys = Object.keys(heapFaultRuntime.store.entries ?? {});
    return { healthy: false, detail: heapFaultRuntime.fatal, entryCount: keys.length };
  }
  const store = peekTreasuryAuthorizationFaultStore();
  if (store === undefined) return { healthy: true, detail: null, entryCount: 0 };
  if (store.version !== AUTHORIZATION_FAULT_VERSION && store.version !== 1) {
    return { healthy: false, detail: `未知 authorizationFaults 版本 ${String(store.version)}`, entryCount: 0 };
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
export function writeTreasuryAuthorizationFaultEntry(entry: TreasuryAuthorizationFaultEntry): TreasuryAuthorizationFaultWriteResult {
  const shapeError = validateFaultEntryShape(entry);
  if (shapeError !== null) {
    faultEvents.writeRejections += 1;
    return { status: "rejected", reason: "invalid_entry", detail: shapeError };
  }
  // 【第十二轮 3.6】写入前重算：自带 digest 必须与持久事实重算一致。
  if (entry.legacyV1 !== true) {
    const identityError = verifyTreasuryEntryIdentity(entry as TreasuryIdentityFactsEntry, "authorization fault 写入前重算");
    if (identityError !== null) {
      faultEvents.writeRejections += 1;
      return { status: "rejected", reason: "invalid_entry", detail: identityError };
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
    const existing = runtime.store.entries[key];
    if (!treasuryDurableIdentitiesMatch(existing.durableIdentityDigest, entry.durableIdentityDigest)) {
      faultEvents.writeRejections += 1;
      return {
        status: "rejected",
        reason: "identity_conflict",
        detail: `同 id 已存在不同 durable identity 的 authorization fault（既有 ${String(existing.durableIdentityDigest ?? "(legacy 空)").slice(0, 16)}，新 ${String(entry.durableIdentityDigest ?? "(legacy 空)").slice(0, 16)}）——fail closed，原数据不动`,
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
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  // 【第十二轮 3.1.8】read-back 验证：写入后的持久副本必须与声明 entry 的
  // 完整身份一致——不一致视为 store 不可信（回退写入，不得发布 marker）。
  const readBack = runtime.store.entries[key];
  const readBackConsistent =
    readBack !== undefined &&
    readBack.digest === entry.digest &&
    readBack.durableIdentityDigest === entry.durableIdentityDigest &&
    readBack.authorizationCohortDigest === entry.authorizationCohortDigest &&
    readBack.transactionId === entry.transactionId;
  if (!readBackConsistent) {
    faultEvents.writeFailures += 1;
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.store.updatedAt = Game.time;
    return {
      status: "rejected",
      reason: "store_fatal",
      detail: `authorization fault read-back 身份不一致（${key.slice(0, 48)}）——写入已回退，不得发布 marker`,
    };
  }
  return { status: "written" };
}

/** 单条只读查询（O(1)；fatal store 视为不可信返回 undefined）。 */
export function readTreasuryAuthorizationFaultEntry(transactionId: string): Readonly<TreasuryAuthorizationFaultEntry> | undefined {
  if (peekTreasuryAuthorizationFaultStore() === undefined) return undefined;
  const runtime = loadFaultStoreRuntime();
  if (runtime.fatal) return undefined;
  const entry = runtime.store.entries[encodeFaultKey(transactionId)];
  return entry === undefined ? undefined : Object.freeze({ ...entry, postings: entry.postings.map((leg) => Object.freeze({ ...leg })) });
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
