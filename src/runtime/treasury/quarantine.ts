/**
 * Treasury durable quarantine（第六轮建立、第七轮升级为版本化持久权威）。
 *
 * 语义（不变量）：
 * - Game 结果未知（endTick 时 executing、callback 抛错、非 OK 后 abort 失败）
 *   或 commit 写故障（faulted）的 prepared transaction 在 tick 边界**不得**按
 *   普通 prepared 释放——先落 durable quarantine（Memory 持久，跨 global
 *   reset 与 service 重建存活），再清理 heap tentative（占用由持久
 *   quarantine 接替）；
 * - quarantine 继续占用资源、容量与 transaction identity：授权计算计入其
 *   流出量（facade.query committed），容量按保守方向占用（正净流入减少
 *   free capacity，负流出不增加），同一 transactionId 在 quarantine 未解决
 *   前不得再次 prepare（transaction_quarantined）；
 * - **全局 write blocker（第七轮）**：存在任何 unresolved entry 或 legacy
 *   overflowed 标志时，一切新 transaction 的 prepare 在 Game callback 之前
 *   被拒（quarantine_write_blocked）——write-fault marker 不是唯一锁来源；
 * - **fault-slot 预留（第七轮）**：prepare admission 保证 持久 entryCount +
 *   active handle 数 < MAX——第 65 条 fault 在它 prepare 时已被拒绝，本模块
 *   的写入路径在正常情况下永不触达容量上限（防御分支返回 rejected 并保持
 *   store 不变，绝不"置 overflowed 但不保存 entry"）；
 * - quarantine 不进入 committed projection（不写 journal/overlay/receipt）；
 * - **版本化健康契约（第七轮，schema v1）**：store 携带 version/entryCount
 *   元数据；global reset 后首次 load 全量验证（key 编码与 transactionId
 *   一致、digest/phase/locationKind/resource 枚举、delta 非零安全整数、
 *   聚合防溢出）——任何损坏 fatal fail closed（原数据不删、health
 *   unhealthy、新 prepare 阻断、resolution 拒绝、聚合返回空但 blockers 报
 *   blocking）；后续读取走 heap health cache（O(1)）；
 * - **单一 canonical deltas 事实**：entry 只持久化 resource posting deltas
 *   （roomName/locationKind/resource/delta），容量占用由其派生（per
 *   location 净流入 Σ delta，占用 = max(0, net)）——不存在第二份容量权威；
 * - 解除只有显式 fault resolution（faultResolution.ts）：resolve-as-
 *   committed（补 receipt 后释放）或 resolve-as-not-executed（证据允许时
 *   释放）；legacy overflowed 与无版本 store 只有该模块的显式 repair 可
 *   恢复；本模块不提供任何无条件清空入口（clearTreasuryPersistenceForTest
 *   仅测试）。
 */

import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { TREASURY_WRITE_FAULT_PHASES, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import type { TreasuryAuthorizationCohortFacts } from "@/runtime/treasury/authorization";
import { treasuryDurableIdentitiesMatch } from "@/runtime/treasury/durableIdentity";
import { verifyTreasuryEntryIdentity, type TreasuryIdentityFactsEntry } from "@/runtime/treasury/identityProof";
import { quarantineSemanticViolation } from "@/runtime/treasury/semanticMatrix";
import {
  TREASURY_STRUCTURE_BINDING_KINDS,
  TREASURY_STRUCTURE_BINDING_ROLES,
  TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
  type TreasuryStructureBindingDescriptor,
} from "@/runtime/treasury/types";

/** 单条 quarantine 的 canonical posting 事实（合并腿；prepare 验证过的 merged postings）。 */
export interface TreasuryQuarantineDeltas {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  readonly delta: number;
}

export interface TreasuryQuarantineEntry {
  readonly transactionId: string;
  /** canonical payload digest（16 小写 hex，与 prepare 签发 digest 同源）。 */
  readonly digest: string;
  /** quarantine 建立时所处 tick（prepared/故障发生 tick）。 */
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  /** 故障 phase（write-fault phase 枚举：commit 类 / execution-unknown 类；fault reason）。 */
  readonly phase: string;
  /**
   * 单一 canonical posting 事实（第七轮）：资源流向（正=预期流入、负=流出
   * 占用）。容量占用由此派生，不再持久化独立的 capacityDeltas。
   */
  readonly deltas: readonly TreasuryQuarantineDeltas[];
  readonly recordedAt: number;
  // ── v2（第十轮 5.1 durable authority cohesion）：完整合同事实。 ─────────
  /** execution outcome（事实等级，单调；v1 迁移按 phase 单调推导）。 */
  readonly outcome: string;
  /** settlement workflow state（隔离态恒为 quarantined）。 */
  readonly settlement: string;
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly actionKind?: string;
  readonly adapterVersion?: number;
  /** adapter registration identity（第十二轮：durable identity 重算输入）。 */
  readonly adapterRegistrationId?: string;
  /** 稳定 adapter/reconciler 语义身份（第十二轮 3.5）。 */
  readonly adapterSemanticIdentity?: string;
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  /** authorization bundle digest（contract 路径）。 */
  readonly authorizationDigest?: string;
  readonly ownerIdentity?: string;
  readonly policyIdentity?: string;
  /** structure incarnation facts（有界数组 ≤16）。 */
  readonly structureFacts?: readonly TreasuryQuarantineStructureFact[];
  /** durable authorization cohort 事实（第十一轮 3.13.4；intent 事实转移同源）。 */
  readonly authorizationCohort?: TreasuryAuthorizationCohortFacts;
  /** canonical cohort digest（Treasury 计算；capability/resolution 绑定）。 */
  readonly authorizationCohortDigest?: string;
  /** 统一 durable action identity digest（第十一轮 3.13.5：全 store 幂等/一致性比较）。 */
  readonly durableIdentityDigest?: string;
  /** v1 迁移且无并存 intent 补全合同事实（不参与 contract-backed resolution）。 */
  readonly legacyV1?: boolean;
  /**
   * 【第十二轮 3.8】forensic incomplete authority：intent 缺失时 recovery
   * coordinator 防御性直写的最小 quarantine——缺少现代完整 identity 事实，
   * 不得被当前 adapter reconciler 解释、不得签发普通 capability、不得自动
   * resolve。与 legacyV1（v1 迁移残留）是不同故障来源，诊断必须可区分。
   */
  readonly forensic?: { readonly reason: "intent_missing_fallback"; readonly detail: string };
}

/** quarantine v3 的完整 structure descriptor（第十一轮 3.13.9；与 intent structureFacts 同形状）。 */
export type TreasuryQuarantineStructureFact = TreasuryStructureBindingDescriptor;

export interface TreasuryQuarantineStore {
  /** schema 版本（当前 3；未知版本 fail closed）。 */
  version: 3;
  /** key = "q:"+transactionId（transactionId 字符集受限，前缀无边界歧义，防危险字面量）。 */
  entries: Record<string, TreasuryQuarantineEntry>;
  /** entries 自有键计数（load 校验与 fault-slot admission 的 O(1) 权威）。 */
  entryCount: number;
  /** legacy 溢出标志（第六轮遗留）：存在即永久 fail closed，显式 repair 才可清除。 */
  overflowed?: boolean;
}

export const TREASURY_QUARANTINE_VERSION = 3 as const;
export const TREASURY_QUARANTINE_MAX_ENTRIES = 64;

const QUARANTINE_KEY_PREFIX = "q:";

const VALID_QUARANTINE_PHASES: ReadonlySet<string> = TREASURY_WRITE_FAULT_PHASES;

const VALID_QUARANTINE_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);
const VALID_QUARANTINE_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const QUARANTINE_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const QUARANTINE_KIND_SOURCE_MAX = 128;
const QUARANTINE_DELTAS_MAX = 64;
const QUARANTINE_STRUCTURE_FACTS_MAX = 16;
const QUARANTINE_OUTCOMES: ReadonlySet<string> = new Set<string>([
  "not_started",
  "started_unknown",
  "returned_non_ok",
  "returned_ok",
  "aborted_final",
]);
const QUARANTINE_SETTLEMENTS: ReadonlySet<string> = new Set<string>(["quarantined", "resolving"]);

/**
 * write-fault phase → execution outcome 的单调推导（第十轮 3.12.1/5.1）：
 * commit 类 phase 全部发生在 Game callback 已确认 OK 之后 → returned_ok；
 * Game 已明确返回非 OK → returned_non_ok；其余 execution-unknown 类 →
 * started_unknown。未知 phase → null（调用方 fail closed）。
 */
export function outcomeOfTreasuryFaultPhase(
  phase: string,
): "returned_ok" | "returned_non_ok" | "started_unknown" | "not_started" | null {
  if (phase === "action_returned_non_ok_abort_failed") return "returned_non_ok";
  if (phase === "executing_at_end_tick" || phase === "action_threw_execution_unknown") return "started_unknown";
  // 原子 redemption 中断发生在 Game callback 之前——动作确定未执行。
  if (phase === "internal_authorization_fault" || phase === "internal_authorization_fault_forensic") return "not_started";
  if (TREASURY_WRITE_FAULT_PHASES.has(phase)) return "returned_ok";
  return null;
}

interface TreasuryQuarantineBranch {
  quarantine?: TreasuryQuarantineStore;
}

type RuntimeMemoryWithQuarantine = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryQuarantineBranch;
};

function quarantineBranch(): TreasuryQuarantineBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithQuarantine;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** 只读读取原始 store（查询/门禁路径零写；不触发 load/校验）。 */
export function peekTreasuryQuarantineStore(): TreasuryQuarantineStore | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithQuarantine | undefined)?.treasury?.quarantine;
}

function encodeQuarantineKey(transactionId: string): string {
  return QUARANTINE_KEY_PREFIX + transactionId;
}

// ── heap 运行态（health cache + 聚合 revision 缓存） ────────────────────────

interface QuarantineStoreRuntime {
  store: TreasuryQuarantineStore;
  /** 非 null = fail closed（原数据保留，一切写入/聚合拒绝）。 */
  fatal: string | null;
}

let heapRuntime: QuarantineStoreRuntime | null = null;

/** store 变更序号（写入/释放 bump；聚合缓存按此失效，query 复用不全扫）。 */
let storeRevision = 0;

interface QuarantineAggregates {
  revision: number;
  outflow: Map<string, number>;
  capacityOccupancy: Map<string, number>;
}

let aggregateCache: QuarantineAggregates | null = null;

/** 确定性操作计数（heap，global reset 归零；facade metrics 聚合）。 */
const quarantineEvents = {
  fullScans: 0,
  loadValidationEntries: 0,
  admissionRejections: 0,
};

export interface TreasuryQuarantineCounters {
  readonly fullScans: number;
  readonly loadValidationEntries: number;
  readonly admissionRejections: number;
}

export function readTreasuryQuarantineCounters(): TreasuryQuarantineCounters {
  return { ...quarantineEvents };
}

/** store 变更序号只读出口（第八轮授权 token 的 quarantine revision 绑定）。 */
export function readTreasuryQuarantineRevision(): number {
  return storeRevision;
}

// ── 形状校验（load 全量验证；entry 级供 repair 复用） ────────────────────────

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** 单条 entry 的完整形状校验（返回 null = 合法，否则有界错误描述）。 */
export function validateTreasuryQuarantineEntryShape(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "entry 非对象";
  const candidate = entry as Partial<TreasuryQuarantineEntry> & {
    deltas?: unknown;
  };
  if (typeof candidate.transactionId !== "string" || !isValidTreasuryTransactionId(candidate.transactionId)) {
    return `transactionId 非法: ${String(candidate.transactionId).slice(0, 48)}`;
  }
  if (typeof candidate.digest !== "string" || !QUARANTINE_DIGEST_PATTERN.test(candidate.digest)) {
    return `digest 非法（须为 16 小写 hex）: ${String(candidate.digest).slice(0, 32)}`;
  }
  if (!isSafeInteger(candidate.tick) || candidate.tick < 0) return "tick 非安全整数";
  if (!isSafeInteger(candidate.recordedAt) || candidate.recordedAt < 0) return "recordedAt 非安全整数";
  if (
    typeof candidate.kind !== "string" || candidate.kind.length === 0 || candidate.kind.length > QUARANTINE_KIND_SOURCE_MAX
  ) {
    return "kind 非法（须为 1..128 字符）";
  }
  if (
    typeof candidate.source !== "string" ||
    candidate.source.length === 0 ||
    candidate.source.length > QUARANTINE_KIND_SOURCE_MAX
  ) {
    return "source 非法（须为 1..128 字符）";
  }
  if (typeof candidate.phase !== "string" || !VALID_QUARANTINE_PHASES.has(candidate.phase)) {
    return `phase 非法（未知枚举）: ${String(candidate.phase).slice(0, 48)}`;
  }
  if (typeof candidate.outcome !== "string" || !QUARANTINE_OUTCOMES.has(candidate.outcome)) {
    return `outcome 非法（未知枚举）: ${String(candidate.outcome).slice(0, 48)}`;
  }
  if (typeof candidate.settlement !== "string" || !QUARANTINE_SETTLEMENTS.has(candidate.settlement)) {
    return `settlement 非法（隔离态允许 quarantined/resolving）: ${String(candidate.settlement).slice(0, 48)}`;
  }
  const semanticError = quarantineSemanticViolation(outcomeOfTreasuryFaultPhase(candidate.phase), candidate.outcome);
  if (semanticError !== null) {
    return `语义矩阵违规: ${semanticError}`;
  }
  if (candidate.contractId !== undefined) {
    if (typeof candidate.contractId !== "string" || candidate.contractId.length === 0 || candidate.contractId.length > 96) {
      return "contractId 非法（须为 1..96 字符）";
    }
  }
  if (candidate.contractDigest !== undefined) {
    if (typeof candidate.contractDigest !== "string" || !QUARANTINE_DIGEST_PATTERN.test(candidate.contractDigest)) {
      return "contractDigest 非法（须为 16 小写 hex）";
    }
  }
  if (candidate.actionKind !== undefined) {
    if (typeof candidate.actionKind !== "string" || candidate.actionKind.length === 0 || candidate.actionKind.length > QUARANTINE_KIND_SOURCE_MAX) {
      return "actionKind 非法（须为 1..128 字符）";
    }
  }
  if (candidate.adapterVersion !== undefined) {
    if (typeof candidate.adapterVersion !== "number" || !Number.isSafeInteger(candidate.adapterVersion) || candidate.adapterVersion <= 0) {
      return "adapterVersion 须为正安全整数";
    }
  }
  if (candidate.adapterRegistrationId !== undefined) {
    if (typeof candidate.adapterRegistrationId !== "string" || !QUARANTINE_DIGEST_PATTERN.test(candidate.adapterRegistrationId)) {
      return "adapterRegistrationId 非法（16 hex）";
    }
  }
  if (candidate.adapterSemanticIdentity !== undefined) {
    if (typeof candidate.adapterSemanticIdentity !== "string" || candidate.adapterSemanticIdentity.length === 0 || candidate.adapterSemanticIdentity.length > QUARANTINE_KIND_SOURCE_MAX) {
      return "adapterSemanticIdentity 非法（1..128 字符）";
    }
  }
  if (candidate.durablePayload !== undefined) {
    if (typeof candidate.durablePayload !== "string" || candidate.durablePayload.length === 0 || candidate.durablePayload.length > 512) {
      return "durablePayload 非法（须为 1..512 字符）";
    }
  }
  if (candidate.durablePayloadVersion !== undefined) {
    if (typeof candidate.durablePayloadVersion !== "number" || !Number.isSafeInteger(candidate.durablePayloadVersion) || candidate.durablePayloadVersion <= 0) {
      return "durablePayloadVersion 须为正安全整数";
    }
  }
  if (candidate.authorizationDigest !== undefined) {
    if (typeof candidate.authorizationDigest !== "string" || !QUARANTINE_DIGEST_PATTERN.test(candidate.authorizationDigest)) {
      return "authorizationDigest 非法（须为 16 小写 hex）";
    }
  }
  if (candidate.ownerIdentity !== undefined) {
    if (typeof candidate.ownerIdentity !== "string" || candidate.ownerIdentity.length === 0 || candidate.ownerIdentity.length > QUARANTINE_KIND_SOURCE_MAX) {
      return "ownerIdentity 非法（须为 1..128 字符）";
    }
  }
  if (candidate.policyIdentity !== undefined) {
    if (typeof candidate.policyIdentity !== "string" || candidate.policyIdentity.length === 0 || candidate.policyIdentity.length > QUARANTINE_KIND_SOURCE_MAX) {
      return "policyIdentity 非法（须为 1..128 字符）";
    }
  }
  if (candidate.structureFacts !== undefined) {
    if (!Array.isArray(candidate.structureFacts) || candidate.structureFacts.length > QUARANTINE_STRUCTURE_FACTS_MAX) {
      return "structureFacts 非数组或超上限";
    }
    for (const fact of candidate.structureFacts) {
      if (!fact || typeof fact !== "object") return "structureFact 项非对象";
      const typed = fact as Partial<TreasuryQuarantineStructureFact>;
      if (typeof typed.bindingKind !== "string" || !TREASURY_STRUCTURE_BINDING_KINDS.has(typed.bindingKind)) {
        return `structureFact.bindingKind 非法: ${String(typed.bindingKind).slice(0, 24)}`;
      }
      if (typeof typed.role !== "string" || !TREASURY_STRUCTURE_BINDING_ROLES.has(typed.role)) {
        return `structureFact.role 非法: ${String(typed.role).slice(0, 24)}`;
      }
      if (typeof typed.roomName !== "string" || typed.roomName.length === 0 || typed.roomName.length > 16) {
        return "structureFact.roomName 非法";
      }
      if (typeof typed.locationKind !== "string" || !VALID_QUARANTINE_LOCATION_KINDS.has(typed.locationKind)) {
        return `structureFact.locationKind 非法: ${String(typed.locationKind).slice(0, 24)}`;
      }
      if (typeof typed.structureId !== "string" || typed.structureId.length === 0 || typed.structureId.length > 48) {
        return "structureFact.structureId 非法（须为 1..48 字符）";
      }
      if (typed.objectId !== undefined && (typeof typed.objectId !== "string" || typed.objectId.length === 0 || typed.objectId.length > 48)) {
        return "structureFact.objectId 非法（须为 1..48 字符）";
      }
      if (typeof typed.required !== "boolean") {
        return "structureFact.required 须为布尔";
      }
      if (typed.version !== TREASURY_STRUCTURE_DESCRIPTOR_VERSION) {
        return `structureFact.version 非法（当前 ${String(TREASURY_STRUCTURE_DESCRIPTOR_VERSION)}）: ${String(typed.version)}`;
      }
    }
  }
  if (candidate.authorizationCohortDigest !== undefined) {
    if (typeof candidate.authorizationCohortDigest !== "string" || !QUARANTINE_DIGEST_PATTERN.test(candidate.authorizationCohortDigest)) {
      return "authorizationCohortDigest 非法（须为 16 小写 hex）";
    }
  }
  if (candidate.durableIdentityDigest !== undefined) {
    if (typeof candidate.durableIdentityDigest !== "string" || !QUARANTINE_DIGEST_PATTERN.test(candidate.durableIdentityDigest)) {
      return "durableIdentityDigest 非法（须为 16 小写 hex）";
    }
  }
  if (candidate.authorizationCohort !== undefined) {
    const cohort = candidate.authorizationCohort as Partial<TreasuryAuthorizationCohortFacts> | undefined;
    if (!cohort || typeof cohort !== "object") return "authorizationCohort 非对象";
    if (typeof cohort.transactionId !== "string" || cohort.transactionId !== candidate.transactionId) {
      return "authorizationCohort.transactionId 与 entry 不一致";
    }
    if (typeof cohort.authorizationDigest !== "string" || !QUARANTINE_DIGEST_PATTERN.test(cohort.authorizationDigest)) {
      return "authorizationCohort.authorizationDigest 非法";
    }
    if (!Array.isArray(cohort.authorizationLegDigests) || cohort.authorizationLegDigests.length === 0 || cohort.authorizationLegDigests.length > 8) {
      return "authorizationCohort.authorizationLegDigests 非法（1..8）";
    }
  }
  if (candidate.forensic !== undefined) {
    const forensic = candidate.forensic as Partial<{ reason: string; detail: string }> | undefined;
    if (!forensic || typeof forensic !== "object" || forensic.reason !== "intent_missing_fallback") {
      return "forensic 标记非法（reason 须为 intent_missing_fallback）";
    }
    if (typeof forensic.detail !== "string" || forensic.detail.length === 0 || forensic.detail.length > 192) {
      return "forensic.detail 非法（1..192 字符）";
    }
  }
  if (!Array.isArray(candidate.deltas) || candidate.deltas.length > QUARANTINE_DELTAS_MAX) {
    return "deltas 非数组或超上限";
  }
  for (const delta of candidate.deltas) {
    if (!delta || typeof delta !== "object") return "delta 项非对象";
    const leg = delta as Partial<TreasuryQuarantineDeltas>;
    if (typeof leg.roomName !== "string" || leg.roomName.length === 0 || leg.roomName.length > 16) {
      return "delta.roomName 非法";
    }
    if (typeof leg.locationKind !== "string" || !VALID_QUARANTINE_LOCATION_KINDS.has(leg.locationKind)) {
      return `delta.locationKind 非法: ${String(leg.locationKind).slice(0, 24)}`;
    }
    if (typeof leg.resource !== "string" || !VALID_QUARANTINE_RESOURCES.has(leg.resource)) {
      return `delta.resource 不在 RESOURCES_ALL: ${String(leg.resource).slice(0, 24)}`;
    }
    if (!isSafeInteger(leg.delta) || leg.delta === 0) return "delta.delta 须为非零安全整数";
  }
  return null;
}

/**
 * store 完整形状自检（global reset 后首次 load 与 repair 共用；一次全表
 * 扫描）：version、entries 对象、entryCount 一致、key 编码与 entry.
 * transactionId 一致、逐 entry 形状、聚合安全整数。返回 null = 合法。
 */
function validateQuarantineStoreShape(store: TreasuryQuarantineStore): string | null {
  if (store.version !== TREASURY_QUARANTINE_VERSION) {
    return `未知 quarantine 版本 ${String(store.version)}`;
  }
  if (!store.entries || typeof store.entries !== "object") return "entries 非对象";
  quarantineEvents.fullScans += 1;
  const ownKeys = Object.keys(store.entries);
  quarantineEvents.loadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  const resourceTotals = new Map<string, number>();
  const capacityTotals = new Map<string, number>();
  const conservativeResourceOutflow = new Map<string, number>();
  const conservativeCapacityOccupancy = new Map<string, number>();
  for (const key of ownKeys) {
    if (!key.startsWith(QUARANTINE_KEY_PREFIX)) {
      return `存储键格式非法（须为 "q:"+transactionId）: ${key.slice(0, 48)}`;
    }
    const entry = (store.entries as Record<string, unknown>)[key];
    const shapeError = validateTreasuryQuarantineEntryShape(entry);
    if (shapeError !== null) {
      return `${shapeError}（key ${key.slice(0, 48)}）`;
    }
    const typed = entry as TreasuryQuarantineEntry;
    if (encodeQuarantineKey(typed.transactionId) !== key) {
      return `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}`;
    }
    // 【第十二轮 3.6】identity 重算验证（篡改事实而未同步 digest → fatal）。
    const identityError = verifyTreasuryEntryIdentity(typed as TreasuryIdentityFactsEntry, `quarantine（${key.slice(0, 48)}）`);
    if (identityError !== null) return identityError;
    // 聚合安全整数（资源 (room,loc,res) 与容量 (room,loc) 双口径预检）：
    // 净额方向与保守方向（第八轮 per-transaction：Σmax(0,−net) 流出 /
    // Σmax(0,net) 容量——保守和可能在大额混合下溢出而净额不溢出）双侧检查。
    for (const leg of typed.deltas) {
      const resourceKey = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      const mergedResource = (resourceTotals.get(resourceKey) ?? 0) + leg.delta;
      if (!Number.isSafeInteger(mergedResource)) return "资源聚合安全整数溢出";
      resourceTotals.set(resourceKey, mergedResource);
      const capacityKey = `${leg.roomName}\u0000${leg.locationKind}`;
      const mergedCapacity = (capacityTotals.get(capacityKey) ?? 0) + leg.delta;
      if (!Number.isSafeInteger(mergedCapacity)) return "容量聚合安全整数溢出";
      capacityTotals.set(capacityKey, mergedCapacity);
    }
    const resourceNet = new Map<string, number>();
    const capacityNet = new Map<string, number>();
    for (const leg of typed.deltas) {
      const resourceKey = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      resourceNet.set(resourceKey, (resourceNet.get(resourceKey) ?? 0) + leg.delta);
      const capacityKey = `${leg.roomName}\u0000${leg.locationKind}`;
      capacityNet.set(capacityKey, (capacityNet.get(capacityKey) ?? 0) + leg.delta);
    }
    for (const [key, net] of resourceNet) {
      const conservativeOutflow = (conservativeResourceOutflow.get(key) ?? 0) + Math.max(0, -net);
      if (!Number.isSafeInteger(conservativeOutflow)) return "资源保守聚合（Σmax(0,−net)）安全整数溢出";
      conservativeResourceOutflow.set(key, conservativeOutflow);
    }
    for (const [key, net] of capacityNet) {
      const conservativeCapacity = (conservativeCapacityOccupancy.get(key) ?? 0) + Math.max(0, net);
      if (!Number.isSafeInteger(conservativeCapacity)) return "容量保守聚合（Σmax(0,net)）安全整数溢出";
      conservativeCapacityOccupancy.set(key, conservativeCapacity);
    }
  }
  if (ownKeys.length > TREASURY_QUARANTINE_MAX_ENTRIES) {
    return `entries 超过上限 ${String(TREASURY_QUARANTINE_MAX_ENTRIES)}（含 ${String(ownKeys.length)} 条）`;
  }
  return null;
}

function fatalRuntime(store: TreasuryQuarantineStore, reason: string): QuarantineStoreRuntime {
  return { store, fatal: reason };
}

/**
 * 旧 structureFacts（v2 及更早三元组形状）补全为完整 descriptor（第十一轮
 * 3.13.9）：缺省 governed_location/auxiliary/required/v1——不伪造缺失字段
 *（由升级后形状校验检出 fatal）。
 */
function upgradeLegacyStructureFacts(entry: { structureFacts?: unknown }): void {
  const legacyFacts = entry.structureFacts;
  if (!Array.isArray(legacyFacts)) return;
  (entry as { structureFacts?: unknown }).structureFacts = legacyFacts.map((fact) => {
    const typed = fact as Partial<TreasuryQuarantineStructureFact>;
    return {
      bindingKind: typed.bindingKind ?? "governed_location",
      role: typed.role ?? "auxiliary",
      roomName: typed.roomName,
      locationKind: typed.locationKind,
      structureId: typed.structureId,
      ...(typed.objectId !== undefined ? { objectId: typed.objectId } : {}),
      ...(typed.expectedType !== undefined ? { expectedType: typed.expectedType } : {}),
      ...(typed.expectedRoom !== undefined ? { expectedRoom: typed.expectedRoom } : {}),
      required: typed.required ?? true,
      version: typed.version ?? TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
    } as TreasuryQuarantineStructureFact;
  });
}

/**
 * 加载（含校验）：写入/聚合路径专用（可能写 Memory——空 store 初始化）。
 * 校验失败（版本未知/元数据不符/entry 损坏/聚合溢出）→ fatal fail closed：
 * 不删数据、写入拒绝、聚合空、blockers 报 blocking，直至 faultResolution
 * 的显式 repair 或人工处理。
 */
function loadQuarantineStoreRuntime(): QuarantineStoreRuntime {
  if (heapRuntime) return heapRuntime;
  const raw = quarantineBranch().quarantine as TreasuryQuarantineStore | undefined;
  if (!raw) {
    const created: TreasuryQuarantineStore = { version: TREASURY_QUARANTINE_VERSION, entries: {}, entryCount: 0 };
    quarantineBranch().quarantine = created;
    heapRuntime = { store: created, fatal: null };
    return heapRuntime;
  }
  if (raw.version === TREASURY_QUARANTINE_VERSION) {
    const shapeError = validateQuarantineStoreShape(raw);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw, `${shapeError}（quarantine fail closed，原数据保留）`);
      return heapRuntime;
    }
    heapRuntime = { store: raw, fatal: null };
    return heapRuntime;
  }
  if ((raw.version as number) === 1) {
    // v1 → v2 迁移（第十轮 5.1，原子）：逐 entry 将 phase 单调推导为
    // (outcome, settlement=quarantined)；合同事实从并存 intent entry 合并
    //（digest 不一致 → fatal）；无并存 intent → legacyV1 标记（不参与
    // contract-backed capability 签发）。未知 phase → fatal（原数据保留）。
    const intentsRaw = (Memory.runtime as { treasury?: { intents?: { entries?: Record<string, unknown> } } } | undefined)
      ?.treasury?.intents?.entries;
    const entries: Record<string, TreasuryQuarantineEntry> = {};
    for (const key of Object.keys((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const legacy = ((raw as { entries?: Record<string, unknown> }).entries ?? {})[key] as Partial<TreasuryQuarantineEntry>;
      const derivedOutcome = outcomeOfTreasuryFaultPhase(String(legacy.phase));
      if (derivedOutcome === null) {
        heapRuntime = fatalRuntime(raw, `v1 phase 无法单调推导 outcome（${String(legacy.phase).slice(0, 48)}）——quarantine fail closed，原数据保留`);
        return heapRuntime;
      }
      const intentRecord = intentsRaw?.["i:" + String(legacy.transactionId)] as Partial<TreasuryQuarantineEntry> | undefined;
      if (intentRecord !== undefined && intentRecord.digest !== legacy.digest) {
        heapRuntime = fatalRuntime(raw, `v1→v2 迁移：同 id 并存 intent digest 不一致（${String(legacy.transactionId).slice(0, 48)}）——fail closed，原数据保留`);
        return heapRuntime;
      }
      entries[key] = {
        ...(legacy as TreasuryQuarantineEntry),
        outcome: derivedOutcome,
        settlement: "quarantined",
        ...(intentRecord?.contractId !== undefined ? { contractId: intentRecord.contractId } : {}),
        ...(intentRecord?.contractDigest !== undefined ? { contractDigest: intentRecord.contractDigest } : {}),
        ...(intentRecord?.adapterVersion !== undefined ? { adapterVersion: intentRecord.adapterVersion } : {}),
        ...(intentRecord?.durablePayload !== undefined ? { durablePayload: intentRecord.durablePayload } : {}),
        ...(intentRecord?.durablePayloadVersion !== undefined ? { durablePayloadVersion: intentRecord.durablePayloadVersion } : {}),
        ...(intentRecord?.authorizationDigest !== undefined ? { authorizationDigest: intentRecord.authorizationDigest } : {}),
        ...(intentRecord === undefined ? { legacyV1: true } : {}),
      };
      upgradeLegacyStructureFacts(entries[key] as Partial<TreasuryQuarantineEntry>);
    }
    const upgraded: TreasuryQuarantineStore = { ...(raw as TreasuryQuarantineStore), version: TREASURY_QUARANTINE_VERSION, entries };
    const shapeError = validateQuarantineStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw, `${shapeError}（v1→v2 升级校验失败，quarantine fail closed，原数据保留）`);
      return heapRuntime;
    }
    quarantineBranch().quarantine = upgraded;
    heapRuntime = { store: upgraded, fatal: null };
    return heapRuntime;
  }
  if ((raw.version as number) === 2) {
    // v2 → v3 迁移（第十一轮 3.13.9，原子）：structureFacts 三元组补全为
    // 完整 descriptor；损坏字段由升级后校验检出 fatal（原数据保留）。
    const entries: Record<string, TreasuryQuarantineEntry> = {};
    for (const key of Object.keys((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const legacy = ((raw as { entries?: Record<string, unknown> }).entries ?? {})[key] as Partial<TreasuryQuarantineEntry>;
      upgradeLegacyStructureFacts(legacy);
      entries[key] = legacy as TreasuryQuarantineEntry;
    }
    const upgradedV2: TreasuryQuarantineStore = { ...(raw as TreasuryQuarantineStore), version: TREASURY_QUARANTINE_VERSION, entries };
    const shapeErrorV2 = validateQuarantineStoreShape(upgradedV2);
    if (shapeErrorV2 !== null) {
      heapRuntime = fatalRuntime(raw, `${shapeErrorV2}（v2→v3 升级校验失败，quarantine fail closed，原数据保留）`);
      return heapRuntime;
    }
    quarantineBranch().quarantine = upgradedV2;
    heapRuntime = { store: upgradedV2, fatal: null };
    return heapRuntime;
  }
  if (raw.version === undefined) {
    // 第六轮 legacy 无版本 store：空 entries 且无 overflowed → 无损升级 v1；
    // 非空 → 交显式 repair（不猜测迁移，不静默清空）。
    if (
      raw.entries &&
      typeof raw.entries === "object" &&
      Object.keys(raw.entries).length === 0 &&
      raw.overflowed !== true
    ) {
      const upgraded: TreasuryQuarantineStore = {
        version: TREASURY_QUARANTINE_VERSION,
        entries: raw.entries,
        entryCount: 0,
      };
      quarantineBranch().quarantine = upgraded;
      heapRuntime = { store: upgraded, fatal: null };
      return heapRuntime;
    }
    heapRuntime = fatalRuntime(raw, "legacy quarantine store 缺失 version 且非空（显式 repair 处理，原数据保留）");
    return heapRuntime;
  }
  heapRuntime = fatalRuntime(raw, `未知 quarantine 版本 ${String(raw.version)}（原数据保留，fail closed）`);
  return heapRuntime;
}

export interface TreasuryQuarantineHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  /** 已验证的持久条目数（fatal 时为实际条目数的尽力计数；未 load 时轻量探测）。 */
  readonly entryCount: number;
  readonly overflowed: boolean;
}

/**
 * quarantine store 健康探测（只读零写；prepare 门禁/readiness/blockers 用）：
 * - heap 已 load 且 fatal → unhealthy；
 * - 未 load 时轻量形状探测（version 可识别 / entries 对象 / entryCount 数字 /
 *   overflowed 标志）——不做全表扫描（entry 级损坏由下一次 load 显式检出）；
 * - legacy overflowed=true 一律 unhealthy（显式 repair 才可清除）。
 */
export function peekTreasuryQuarantineHealth(): TreasuryQuarantineHealth {
  if (heapRuntime?.fatal) {
    const keys = Object.keys(heapRuntime.store.entries ?? {});
    return {
      healthy: false,
      detail: heapRuntime.fatal,
      entryCount: keys.length,
      overflowed: heapRuntime.store.overflowed === true,
    };
  }
  const store = peekTreasuryQuarantineStore();
  if (store === undefined) return { healthy: true, detail: null, entryCount: 0, overflowed: false };
  if (store.version !== TREASURY_QUARANTINE_VERSION) {
    if (store.version === undefined) {
      const count = store.entries && typeof store.entries === "object" ? Object.keys(store.entries).length : 0;
      const overflowed = store.overflowed === true;
      if (count === 0 && !overflowed) return { healthy: true, detail: null, entryCount: 0, overflowed: false };
      return {
        healthy: false,
        detail: "legacy quarantine store 缺失 version 且非空（fail closed）",
        entryCount: count,
        overflowed,
      };
    }
    return {
      healthy: false,
      detail: `未知 quarantine 版本 ${String(store.version)}`,
      entryCount: 0,
      overflowed: store.overflowed === true,
    };
  }
  if (!store.entries || typeof store.entries !== "object") {
    return { healthy: false, detail: "quarantine entries 非对象", entryCount: 0, overflowed: store.overflowed === true };
  }
  if (!isSafeInteger(store.entryCount) || store.entryCount < 0) {
    return {
      healthy: false,
      detail: "quarantine entryCount 非法",
      entryCount: 0,
      overflowed: store.overflowed === true,
    };
  }
  if (store.overflowed === true) {
    return { healthy: false, detail: "legacy quarantine overflowed 标志存在（显式 repair 前永久阻断）", entryCount: store.entryCount, overflowed: true };
  }
  return { healthy: true, detail: null, entryCount: store.entryCount, overflowed: false };
}

/** 冻结深拷贝的单条 entry（快照封闭——外部修改不影响内部权威）。 */
function freezeQuarantineCopy(entry: TreasuryQuarantineEntry): Readonly<TreasuryQuarantineEntry> {
  return Object.freeze({
    ...entry,
    deltas: entry.deltas.map((leg) => Object.freeze({ ...leg })),
    ...(entry.structureFacts !== undefined
      ? { structureFacts: entry.structureFacts.map((fact) => Object.freeze({ ...fact })) }
      : {}),
  }) as Readonly<TreasuryQuarantineEntry>;
}

/**
 * 单条只读查询（O(1)；prepare 同 id 门禁用；fatal store 一律视为不可信；
 * store 尚不存在时零写返回 undefined——查询路径不隐式创建 store）。
 * 快照封闭：返回冻结深拷贝，绝不泄漏 store 内部对象。
 */
export function readTreasuryQuarantineEntry(transactionId: string): Readonly<TreasuryQuarantineEntry> | undefined {
  if (peekTreasuryQuarantineStore() === undefined) return undefined;
  const runtime = loadQuarantineStoreRuntime();
  if (runtime.fatal) return undefined;
  const entry = runtime.store.entries[encodeQuarantineKey(transactionId)];
  return entry === undefined ? undefined : freezeQuarantineCopy(entry);
}

/**
 * legacy quarantine 只读诊断（第十一轮 3.13.7）：列出 legacyV1 隔离 entry
 * 的冻结快照（transactionId/phase/outcome/digest）——显式人工 migration/
 * reconciliation 的输入；本函数零写入（entry 原样保留）。
 */
export interface TreasuryLegacyQuarantineDiagnostic {
  readonly transactionId: string;
  readonly digest: string;
  readonly phase: string;
  readonly outcome: string;
  readonly recordedAt: number;
}

export function treasuryLegacyQuarantineDiagnostics(): readonly TreasuryLegacyQuarantineDiagnostic[] {
  const store = peekTreasuryQuarantineStore();
  if (store === undefined) return Object.freeze([]);
  const diagnostics: TreasuryLegacyQuarantineDiagnostic[] = [];
  for (const entry of Object.values(store.entries ?? {})) {
    if ((entry as { legacyV1?: boolean }).legacyV1 === true) {
      diagnostics.push({
        transactionId: entry.transactionId,
        digest: entry.digest,
        phase: entry.phase,
        outcome: entry.outcome,
        recordedAt: entry.recordedAt,
      });
    }
  }
  return Object.freeze(diagnostics);
}

/**
 * 【第十二轮 3.8】forensic incomplete authority 只读诊断：列出被隔离的
 * 防御性最小 quarantine（authority 来源 / 缺少的证明 / 隔离原因）。零写入。
 */
export interface TreasuryForensicQuarantineDiagnostic {
  readonly transactionId: string;
  readonly digest: string;
  readonly phase: string;
  readonly outcome: string;
  readonly recordedAt: number;
  readonly reason: string;
  readonly detail: string;
}

export function treasuryForensicQuarantineDiagnostics(): readonly TreasuryForensicQuarantineDiagnostic[] {
  const store = peekTreasuryQuarantineStore();
  if (store === undefined) return Object.freeze([]);
  const diagnostics: TreasuryForensicQuarantineDiagnostic[] = [];
  for (const entry of Object.values(store.entries ?? {})) {
    if ((entry as { forensic?: { reason: string; detail: string } }).forensic !== undefined) {
      const forensic = (entry as { forensic: { reason: string; detail: string } }).forensic;
      diagnostics.push({
        transactionId: entry.transactionId,
        digest: entry.digest,
        phase: entry.phase,
        outcome: entry.outcome,
        recordedAt: entry.recordedAt,
        reason: forensic.reason,
        detail: forensic.detail,
      });
    }
  }
  return Object.freeze(diagnostics);
}

export function isTreasuryTransactionQuarantined(transactionId: string): boolean {
  return readTreasuryQuarantineEntry(transactionId) !== undefined;
}

/**
 * 显式触发 load 全量验证（resolution 等写路径用）：返回 fatal 描述
 * （null = 健康或 store 不存在——不存在时零写，不隐式创建）。
 */
export function ensureTreasuryQuarantineStoreValidated(): string | null {
  if (peekTreasuryQuarantineStore() === undefined) return null;
  const runtime = loadQuarantineStoreRuntime();
  return runtime.fatal;
}

export type TreasuryQuarantineWriteResult =
  | { readonly status: "written" }
  | { readonly status: "already_present" }
  | {
      readonly status: "rejected";
      readonly reason: "store_fatal" | "capacity_exhausted" | "identity_conflict";
      readonly detail: string;
    };

/**
 * 写入 durable quarantine（tick 边界分类路径与立即隔离路径专用）。
 * 同 id 重复写入幂等保留首条（根因快照语义与 write-fault marker 一致）；
 * 容量已满时返回 rejected（**绝不**置 overflowed 丢 identity——prepare 的
 * fault-slot admission 已保证此分支在正常路径不可达；防御性拒绝保持 store
 * 不变，调用方维持 write-fault marker 锁定并计数）。
 */
export function quarantineTreasuryTransaction(entry: TreasuryQuarantineEntry): TreasuryQuarantineWriteResult {
  // 写入前重新完整验证 entry（快照封闭配套——不假设调用方传入 prepare
  // 验证过的安全对象）。
  const shapeError = validateTreasuryQuarantineEntryShape(entry);
  if (shapeError !== null) {
    quarantineEvents.admissionRejections += 1;
    return { status: "rejected", reason: "store_fatal", detail: `拒绝写入非法 entry: ${shapeError}` };
  }
  const runtime = loadQuarantineStoreRuntime();
  if (runtime.fatal) {
    return { status: "rejected", reason: "store_fatal", detail: runtime.fatal };
  }
  const key = encodeQuarantineKey(entry.transactionId);
  if (Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) {
    // 【第十一轮 3.13.5】同 ID 幂等仅限统一 durable identity 一致。
    const existing = runtime.store.entries[key];
    if (!treasuryDurableIdentitiesMatch(existing.durableIdentityDigest, entry.durableIdentityDigest)) {
      quarantineEvents.admissionRejections += 1;
      return {
        status: "rejected",
        reason: "identity_conflict",
        detail: `同 id 已存在不同 durable identity 的 quarantine entry（既有 ${String(existing.durableIdentityDigest ?? "(legacy 空)").slice(0, 16)}，新 ${String(entry.durableIdentityDigest ?? "(legacy 空)").slice(0, 16)}）——fail closed，原数据不动`,
      };
    }
    return { status: "already_present" };
  }
  if (runtime.store.entryCount >= TREASURY_QUARANTINE_MAX_ENTRIES) {
    quarantineEvents.admissionRejections += 1;
    return {
      status: "rejected",
      reason: "capacity_exhausted",
      detail: `quarantine 容量已满（${String(TREASURY_QUARANTINE_MAX_ENTRIES)} 条；fault-slot admission 不变量被破坏，保持 marker 锁定）`,
    };
  }
  runtime.store.entries[key] = entry;
  runtime.store.entryCount += 1;
  storeRevision += 1;
  return { status: "written" };
}

/** 显式 resolution 路径：释放单条 quarantine（返回是否确有条目被释放）。 */
export function releaseTreasuryQuarantineEntry(transactionId: string): boolean {
  const runtime = loadQuarantineStoreRuntime();
  if (runtime.fatal) return false;
  const key = encodeQuarantineKey(transactionId);
  if (!Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  storeRevision += 1;
  return true;
}

/** 全部条目的冻结快照（诊断/resolution 枚举；fatal store 返回空）。 */
export function listTreasuryQuarantineEntries(): readonly Readonly<TreasuryQuarantineEntry>[] {
  const runtime = loadQuarantineStoreRuntime();
  if (runtime.fatal) return Object.freeze([]);
  return Object.freeze(Object.values(runtime.store.entries).map(freezeQuarantineCopy));
}

export interface TreasuryQuarantineBlockers {
  readonly blocking: boolean;
  readonly unresolvedCount: number;
  readonly overflowed: boolean;
  /** store 损坏（fail closed）时不为 null。 */
  readonly unhealthyDetail: string | null;
}

/**
 * 授权/写入阻断状态（authorizationSafe、write admission readiness 与 prepare
 * 全局门禁共用；只读零写——store 不存在时视为空且健康，不隐式创建）：
 * blocking = 存在任一未解决条目、legacy overflowed 或 store 损坏。
 * write-fault marker 不是唯一锁来源——本判定独立于 marker。
 */
export function treasuryQuarantineBlockers(): TreasuryQuarantineBlockers {
  if (heapRuntime?.fatal) {
    const keys = Object.keys(heapRuntime.store.entries ?? {});
    return {
      blocking: true,
      unresolvedCount: keys.length,
      overflowed: heapRuntime.store.overflowed === true,
      unhealthyDetail: heapRuntime.fatal,
    };
  }
  const health = peekTreasuryQuarantineHealth();
  return {
    blocking: !health.healthy || health.entryCount > 0,
    unresolvedCount: health.entryCount,
    overflowed: health.overflowed,
    unhealthyDetail: health.healthy ? null : health.detail,
  };
}

/**
 * per-transaction 保守聚合（第八轮）：每笔 transaction 内先合并同
 * (room,location,resource) / (room,location) 腿得 net，再跨 transaction
 * 保守求和——outflow(rk) = Σ_tx max(0, −net_tx)、capacity(lk) =
 * Σ_tx max(0, net_tx)。不同 transaction 的正流入不得抵消另一笔负流出、
 * 不得增加 spendable。任一求和步溢出安全整数 → 返回空聚合（fail closed，
 * 不返回乐观数值；load 校验已前置拦截，此为运行时防御）。
 */
function computeAggregates(): { outflow: Map<string, number>; capacityOccupancy: Map<string, number> } {
  const outflow = new Map<string, number>();
  const capacityOccupancy = new Map<string, number>();
  for (const entry of listTreasuryQuarantineEntries()) {
    const resourceNets = new Map<string, number>();
    const capacityNets = new Map<string, number>();
    for (const leg of entry.deltas) {
      const resourceKey = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      const mergedResource = (resourceNets.get(resourceKey) ?? 0) + leg.delta;
      if (!Number.isSafeInteger(mergedResource)) return { outflow: new Map(), capacityOccupancy: new Map() };
      resourceNets.set(resourceKey, mergedResource);
      const capacityKey = `${leg.roomName}\u0000${leg.locationKind}`;
      const mergedCapacity = (capacityNets.get(capacityKey) ?? 0) + leg.delta;
      if (!Number.isSafeInteger(mergedCapacity)) return { outflow: new Map(), capacityOccupancy: new Map() };
      capacityNets.set(capacityKey, mergedCapacity);
    }
    for (const [key, net] of resourceNets) {
      const occupied = Math.max(0, -net);
      if (occupied === 0) continue;
      const summed = (outflow.get(key) ?? 0) + occupied;
      if (!Number.isSafeInteger(summed)) return { outflow: new Map(), capacityOccupancy: new Map() };
      outflow.set(key, summed);
    }
    for (const [key, net] of capacityNets) {
      const occupied = Math.max(0, net);
      if (occupied === 0) continue;
      const summed = (capacityOccupancy.get(key) ?? 0) + occupied;
      if (!Number.isSafeInteger(summed)) return { outflow: new Map(), capacityOccupancy: new Map() };
      capacityOccupancy.set(key, summed);
    }
  }
  return { outflow, capacityOccupancy };
}

function ensureAggregates(): void {
  if (aggregateCache && aggregateCache.revision === storeRevision) return;
  aggregateCache = { revision: storeRevision, ...computeAggregates() };
}

/**
 * quarantine 的授权占用聚合（只读、按 store revision 缓存、快照封闭）：
 * (room,location,resource) → Σ_transactions max(0, −net)（**正**流出占用
 * ——可能已执行的动作占用的资源不得再授权他人；正流入不乐观计入
 * spendable、也不抵消另一笔的流出）。返回新建 Map 快照，不泄漏缓存引用。
 * 零写契约：store 尚不存在（从未有过 quarantine）直接返回空 Map，不隐式
 * 创建；store 存在时执行验证性 load（fatal/聚合溢出 → 空 Map，blockers 已
 * fail closed，不再以聚合数值放宽）。
 */
export function treasuryQuarantineOutflowTotals(): ReadonlyMap<string, number> {
  if (peekTreasuryQuarantineStore() === undefined) return new Map();
  const runtime = loadQuarantineStoreRuntime();
  if (runtime.fatal) return new Map();
  ensureAggregates();
  return new Map(aggregateCache.outflow);
}

/**
 * quarantine 的容量占用（只读、缓存、快照封闭）：(room,location) →
 * Σ_transactions max(0, net)。保守口径（第七轮方向、第八轮 per-transaction
 * 口径）：可能已流入的资源必须减少 free capacity；可能已流出的部分不得
 * 假设空间已释放；不同 transaction 的流入流出不互相抵消。零写契约同
 * outflow。
 */
export function treasuryQuarantineCapacityOccupancy(): ReadonlyMap<string, number> {
  if (peekTreasuryQuarantineStore() === undefined) return new Map();
  const runtime = loadQuarantineStoreRuntime();
  if (runtime.fatal) return new Map();
  ensureAggregates();
  return new Map(aggregateCache.capacityOccupancy);
}

/** 仅供测试/repair：失效 heap 缓存（clearTreasuryPersistenceForTest 调用）。 */
export function resetTreasuryQuarantineRuntimeForTest(): void {
  heapRuntime = null;
  aggregateCache = null;
  storeRevision = 0;
  quarantineEvents.fullScans = 0;
  quarantineEvents.loadValidationEntries = 0;
  quarantineEvents.admissionRejections = 0;
}

/**
 * 显式 repair 内部实现（仅供 faultResolution 的 repair 入口调用）：
 * 全量验证现存 entries 合法后修复 store 元数据——
 * - legacy 无版本 store → 补 version/entryCount（v1）；
 * - entryCount 漂移 → 重算；
 * - legacy overflowed=true → 验证通过且条目数在上限内后清除标志。
 * 任何 entry 损坏 → 拒绝（原数据不动）。绝不删除任何 entry。
 */
export function repairTreasuryQuarantineStoreMetadataForResolution(): { status: "repaired" | "rejected"; detail: string } {
  const raw = quarantineBranch().quarantine as TreasuryQuarantineStore | undefined;
  if (!raw) return { status: "rejected", detail: "quarantine store 不存在（无需 repair）" };
  if (!raw.entries || typeof raw.entries !== "object") {
    return { status: "rejected", detail: "quarantine entries 非对象（人工处理）" };
  }
  const ownKeys = Object.keys(raw.entries);
  quarantineEvents.fullScans += 1;
  quarantineEvents.loadValidationEntries += ownKeys.length;
  for (const key of ownKeys) {
    const entry = (raw.entries as Record<string, unknown>)[key];
    const shapeError = validateTreasuryQuarantineEntryShape(entry);
    if (shapeError !== null) {
      return { status: "rejected", detail: `${shapeError}（key ${key.slice(0, 48)}；原数据保留）` };
    }
    const typed = entry as TreasuryQuarantineEntry;
    if (encodeQuarantineKey(typed.transactionId) !== key) {
      return { status: "rejected", detail: `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}` };
    }
    // 【第十二轮 3.6】repair 不自动覆盖不一致 digest：identity 重算失败 → 拒绝。
    const repairIdentityError = verifyTreasuryEntryIdentity(typed as TreasuryIdentityFactsEntry, `quarantine repair（${key.slice(0, 48)}）`);
    if (repairIdentityError !== null) {
      return { status: "rejected", detail: `${repairIdentityError}（原数据保留，不覆盖 digest）` };
    }
  }
  if (ownKeys.length > TREASURY_QUARANTINE_MAX_ENTRIES) {
    return {
      status: "rejected",
      detail: `entries 超过上限 ${String(TREASURY_QUARANTINE_MAX_ENTRIES)}（先 resolution 部分条目再 repair）`,
    };
  }
  if (raw.overflowed === true && ownKeys.length >= TREASURY_QUARANTINE_MAX_ENTRIES) {
    // 满载 + legacy overflowed：曾有 entry 被丢弃的可能无法排除——清除标志
    // 会掩盖丢 identity 的事实。先 resolution 降到上限以下再 repair。
    return {
      status: "rejected",
      detail: `满载（${String(ownKeys.length)} 条）且存在 legacy overflowed 标志——先 resolution 部分条目再 repair（不得掩盖可能丢失的 identity）`,
    };
  }
  raw.version = TREASURY_QUARANTINE_VERSION;
  raw.entryCount = ownKeys.length;
  delete raw.overflowed;
  heapRuntime = { store: raw, fatal: null };
  storeRevision += 1;
  return { status: "repaired", detail: `repair 完成（${String(ownKeys.length)} 条 entry 保留）` };
}

/** 诊断：合法 phase 集合是否包含给定值（测试与 guard 用）。 */
export function isValidTreasuryQuarantinePhase(phase: string): phase is TreasuryWriteFaultPhase {
  return VALID_QUARANTINE_PHASES.has(phase);
}
