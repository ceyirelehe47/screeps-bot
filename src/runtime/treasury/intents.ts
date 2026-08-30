/**
 * Treasury durable intent / WAL（第八轮）——Game API 调用前的最小持久权威。
 *
 * 动机：prepared handle 与 tentative ledger 主要在 heap。若 callback 已产生
 * 副作用、但 receipt/quarantine 尚未落盘时发生执行中断（global reset），下一
 * tick 会丢失这笔动作的身份与 postings。本模块在**调用 Game API 之前**把
 * transaction identity、payload digest、action kind、canonical postings、
 * 授权身份、执行 phase 持久化到 Memory.runtime.treasury.intents——它是
 * recovery 与 quarantine 写失败时的最终保守权威（emergency intent
 * authority）。
 *
 * 语义（不变量）：
 * - **唯一安全顺序**（facade.executePreparedAction 与 contract 执行路径遵守）：
 *   authorize → prepare tentative → 持久化 intent(phase=ready) → 读回验证 →
 *   标记 execution-started(phase=executing) → 调用 adapter 恰好一次 →
 *   非 OK：phase=returned_non_ok → 关闭 intent + abort；OK：phase=
 *   ok_pending_commit → staged commit → finalize（删除 intent）；
 * - **phase 状态机**必须区分"尚未调用 Game API"（ready）与"已进入 callback、
 *   结果未知"（executing 及之后）——绝不混同；
 * - **intent 写入失败**：callback 调用数必须为 0、tentative 与 receipt/
 *   quarantine slot 释放、返回结构化拒绝（intent_store_unavailable）；
 * - **删除仅限四种情形**：transaction 成功 settled / 确认 aborted /
 *   quarantine 完整写入并验证（slot 转换完成）/ resolution 完整 finalized；
 *   quarantine 写失败时 intent 保留完整 postings、继续参与风险占用、不释放
 *   recovery slot；
 * - **slot 统一计数**：一笔 transaction 恒占一个 recovery slot——
 *   recoverySlots = quarantine entryCount + intent entryCount + 无 intent 的
 *   active handle 数；intent 接管 prepare 预留的 slot、fault 时转换为
 *   quarantine entry（quarantine +1、intent −1，守恒）、正常关闭释放；
 * - **健康契约**：版本化（version 1）、entryCount、容量上限 64、key="i:"+
 *   transactionId、entry 全形状校验（canonical postings/phase 枚举/安全整数/
 *   聚合溢出）、global reset 首次 load 全量验证、heap health cache、损坏与
 *   未知版本 fail closed（原数据不删、写入拒绝、writer 阻断、聚合空但
 *   blockers 报 blocking）、显式 repair 并入 faultResolution；
 * - **风险聚合**：unresolved intents 以 per-transaction 保守口径并入授权占用
 *   （与 quarantine 同算法：transaction 内先合并，Σ max(0,−net) 流出 /
 *   Σ max(0,net) 容量，跨 transaction 不抵消），聚合按 store revision 缓存；
 * - 绝不持久化完整 observation、service、journal 或任意大 payload——
 *   postings 是唯一资产事实副本。
 */

import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import {
  TREASURY_STRUCTURE_BINDING_KINDS,
  TREASURY_STRUCTURE_BINDING_ROLES,
  TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
  type TreasuryStructureBindingDescriptor,
} from "@/runtime/treasury/types";
import { TREASURY_WRITE_FAULT_PHASES, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  outcomeOfTreasuryFaultPhase,
  type TreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";

export const TREASURY_INTENT_VERSION = 4 as const;
/** 与 quarantine 同上限——recovery slot 统一计数的前提。 */
export const TREASURY_INTENT_MAX_ENTRIES = 64;

const INTENT_KEY_PREFIX = "i:";

const INTENT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const INTENT_KIND_SOURCE_MAX = 128;
const INTENT_POSTINGS_MAX = 64;
const INTENT_STRUCTURE_FACTS_MAX = 16;
const INTENT_STRUCTURE_ID_MAX = 48;
const VALID_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);
const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);

/**
 * execution outcome（第十轮 3.12.1）：Game API 调用的**事实等级**——单调、
 * 不可回退。已返回 OK 永不退化为 unknown；已返回 non-OK 永不变 OK；故障、
 * 恢复、quarantine 转换与 commit fault 只改 settlement，绝不改 outcome。
 *
 * - not_started：callback 从未被调用（协议保证 execution-started 标记先于
 *   callback——持久化的 not_started 即"Game API 从未被调用"）；
 * - started_unknown：callback 已开始但结果未知（执行中/抛错/中断）；
 * - returned_non_ok / returned_ok：Game 已明确返回的结果事实；
 * - aborted_final：终态专用（仅用于旧 phase "aborted" 的无歧义迁移——
 *   正常 abort 完成不落盘即释放，运行时不产生此值；不冒充任何执行事实）。
 */
export type TreasuryExecutionOutcome =
  | "not_started"
  | "started_unknown"
  | "returned_non_ok"
  | "returned_ok"
  | "aborted_final";

/**
 * settlement workflow state（第十轮 3.12.1）：Treasury 工作流状态（与
 * execution outcome 正交）：ready→executing→pending_abort/pending_commit→
 * finalized 的正常主线；faulted（执行事实未知或已知的故障待隔离）→
 * quarantined（durable 权威转移完成）→resolving（staged resolution）→
 * finalized。
 */
export type TreasurySettlementState =
  | "ready"
  | "executing"
  | "pending_abort"
  | "pending_commit"
  | "quarantined"
  | "resolving"
  | "finalized"
  | "faulted";

/** 持久化 settlement 全集。 */
export const TREASURY_INTENT_SETTLEMENTS: ReadonlySet<string> = new Set<string>([
  "ready",
  "executing",
  "pending_abort",
  "pending_commit",
  "quarantined",
  "resolving",
  "finalized",
  "faulted",
]);

/** 持久化 outcome 全集。 */
export const TREASURY_INTENT_OUTCOMES: ReadonlySet<string> = new Set<string>([
  "not_started",
  "started_unknown",
  "returned_non_ok",
  "returned_ok",
  "aborted_final",
]);

/**
 * outcome 单调迁移表（唯一合法边；aborted_final 仅由旧数据迁移产生）：
 * not_started→started_unknown（execution started）；started_unknown→
 * returned_ok|returned_non_ok（callback 正常返回）。其余一切边非法。
 */
const TREASURY_OUTCOME_PROGRESSION: Readonly<Record<string, readonly string[]>> = {
  not_started: ["started_unknown"],
  started_unknown: ["returned_ok", "returned_non_ok"],
  returned_ok: [],
  returned_non_ok: [],
  aborted_final: [],
};

/**
 * 旧 phase（v1/v2 单一枚举）→ (outcome, settlement) 保守单调迁移表（第十轮
 * 3.12.1）：ok_pending_commit→returned_ok（事实保留）；aborted→aborted_final
 * （无法无歧义区分 not-started abort 与 non-ok abort——显式终态，不冒充事
 * 实）；未知 phase 值不在表中 → store fatal fail closed。
 */
const TREASURY_LEGACY_PHASE_MIGRATION: Readonly<Record<string, { readonly outcome: TreasuryExecutionOutcome; readonly settlement: TreasurySettlementState }>> = {
  ready: { outcome: "not_started", settlement: "ready" },
  executing: { outcome: "started_unknown", settlement: "executing" },
  returned_non_ok: { outcome: "returned_non_ok", settlement: "pending_abort" },
  ok_pending_commit: { outcome: "returned_ok", settlement: "pending_commit" },
  committed: { outcome: "returned_ok", settlement: "finalized" },
  aborted: { outcome: "aborted_final", settlement: "finalized" },
  execution_unknown: { outcome: "started_unknown", settlement: "faulted" },
  quarantined: { outcome: "started_unknown", settlement: "quarantined" },
  resolution_pending: { outcome: "started_unknown", settlement: "resolving" },
};

/** 旧 phase 迁移表只读出口（quarantine v1 phase → outcome 推导等测试/迁移用）。 */
export function migrateTreasuryLegacyIntentPhase(phase: string): { readonly outcome: TreasuryExecutionOutcome; readonly settlement: TreasurySettlementState } | null {
  return TREASURY_LEGACY_PHASE_MIGRATION[phase] ?? null;
}

/** 恢复语义：outcome=not_started 按协议确认未执行；其余保守处置。 */
export function isTreasuryIntentOutcomeNotExecuted(outcome: string): boolean {
  return outcome === "not_started";
}

/** intent 的 canonical posting 事实（与 quarantine deltas 同形状）。 */
export interface TreasuryIntentPosting {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  readonly delta: number;
}

/** intent 携带的完整 structure descriptor（第十一轮 3.13.9；与 quarantine v3 同形状）。 */
export type TreasuryIntentStructureFact = TreasuryStructureBindingDescriptor;

export interface TreasuryIntentEntry {
  transactionId: string;
  /** canonical payload digest（与 prepare 签发 digest 同源）。 */
  digest: string;
  /** action kind（contract 路径 = adapter kind；直接路径 = input.kind）。 */
  actionKind: string;
  kind: string;
  source: string;
  /** 授权 token 绑定 digest 快照（无授权的测试路径可缺省）。 */
  authorizationDigest?: string;
  /** contract identity（contract 路径必填；直接路径可缺省）。 */
  contractId?: string;
  /** contract digest（第九轮 v2：contract 路径的完整合同身份）。 */
  contractDigest?: string;
  /** adapter version（第九轮 v2：与 contract 同源派生）。 */
  adapterVersion?: number;
  /** 有界 durable reconciliation payload（第九轮 v2：adapter.durableFacts）。 */
  durablePayload?: string;
  /** durable payload 的版本（第九轮 v2：capability 绑定用）。 */
  durablePayloadVersion?: number;
  /** canonical postings（merged；WAL 语义的唯一资产事实副本）。 */
  postings: TreasuryIntentPosting[];
  /** execution outcome（事实等级，单调不可回退；progressTreasuryIntent 迁移）。 */
  outcome: string;
  /** settlement workflow state（Treasury 工作流；与 outcome 正交）。 */
  settlement: string;
  /** 必要的结构 incarnation（有界；contract 路径快照）。 */
  structureId?: string;
  /** structure incarnation facts（第十轮 v3：受控数组 ≤16，转移至 quarantine）。 */
  structureFacts?: TreasuryIntentStructureFact[];
  /** owner canonical identity（第十轮 v3：contract 路径）。 */
  ownerIdentity?: string;
  /** policy capability identity（第十轮 v3：contract 路径）。 */
  policyIdentity?: string;
  /** 有界审计来源。 */
  auditSource?: string;
  createdAtTick: number;
  updatedAtTick: number;
}

export interface TreasuryIntentStore {
  version: 4;
  entries: Record<string, TreasuryIntentEntry>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryIntentBranch {
  intents?: TreasuryIntentStore;
}

type RuntimeMemoryWithIntents = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryIntentBranch;
};

function intentBranch(): TreasuryIntentBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithIntents;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** 只读读取原始 store（查询/门禁路径零写；不触发 load/校验）。 */
export function peekTreasuryIntentStore(): TreasuryIntentStore | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithIntents | undefined)?.treasury?.intents;
}

function encodeIntentKey(transactionId: string): string {
  return INTENT_KEY_PREFIX + transactionId;
}

// ── heap 运行态（health cache + 聚合 revision 缓存 + 事件计数） ─────────────

interface IntentStoreRuntime {
  store: TreasuryIntentStore;
  /** 非 null = fail closed（原数据保留，一切写入/聚合拒绝）。 */
  fatal: string | null;
}

let heapRuntime: IntentStoreRuntime | null = null;
let storeRevision = 0;

interface IntentAggregates {
  revision: number;
  outflow: Map<string, number>;
  capacityOccupancy: Map<string, number>;
}

let aggregateCache: IntentAggregates | null = null;

const intentEvents = {
  fullScans: 0,
  loadValidationEntries: 0,
  writeFailures: 0,
  writeRejections: 0,
  recoveries: 0,
  quarantineConversions: 0,
  /** quarantine 写失败后保留 intent（emergency authority）的次数。 */
  emergencyRetentions: 0,
};

export interface TreasuryIntentCounters {
  readonly fullScans: number;
  readonly loadValidationEntries: number;
  readonly writeFailures: number;
  readonly writeRejections: number;
  readonly recoveries: number;
  readonly quarantineConversions: number;
  readonly emergencyRetentions: number;
}

export function readTreasuryIntentCounters(): TreasuryIntentCounters {
  return { ...intentEvents };
}

/** store 变更序号只读出口（第八轮授权 token 的 intent revision 绑定）。 */
export function readTreasuryIntentRevision(): number {
  return storeRevision;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

// ── 形状校验（写入前重验 + load 全量验证共用） ──────────────────────────────

/**
 * 单条 intent entry 的完整形状校验（返回 null = 合法，否则有界错误描述）。
 * 写入路径对本函数重验调用方传入的 entry——绝不假设调用方传入的是 prepare
 * 验证过的安全对象。
 */
export function validateTreasuryIntentEntryShape(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "intent entry 非对象";
  const candidate = entry as Partial<TreasuryIntentEntry>;
  if (typeof candidate.transactionId !== "string" || !isValidTreasuryTransactionId(candidate.transactionId)) {
    return `transactionId 非法: ${String(candidate.transactionId).slice(0, 48)}`;
  }
  if (typeof candidate.digest !== "string" || !INTENT_DIGEST_PATTERN.test(candidate.digest)) {
    return `digest 非法（须为 16 小写 hex）: ${String(candidate.digest).slice(0, 32)}`;
  }
  for (const field of ["actionKind", "kind", "source"] as const) {
    const value = candidate[field];
    if (typeof value !== "string" || value.length === 0 || value.length > INTENT_KIND_SOURCE_MAX) {
      return `${field} 非法（须为 1..128 字符）`;
    }
  }
  if (candidate.authorizationDigest !== undefined) {
    if (typeof candidate.authorizationDigest !== "string" || !INTENT_DIGEST_PATTERN.test(candidate.authorizationDigest)) {
      return "authorizationDigest 非法（须为 16 小写 hex）";
    }
  }
  if (candidate.contractId !== undefined) {
    if (typeof candidate.contractId !== "string" || candidate.contractId.length === 0 || candidate.contractId.length > 96) {
      return "contractId 非法（须为 1..96 字符）";
    }
  }
  if (candidate.contractDigest !== undefined) {
    if (typeof candidate.contractDigest !== "string" || !INTENT_DIGEST_PATTERN.test(candidate.contractDigest)) {
      return "contractDigest 非法（须为 16 小写 hex）";
    }
  }
  if (candidate.adapterVersion !== undefined) {
    if (typeof candidate.adapterVersion !== "number" || !Number.isSafeInteger(candidate.adapterVersion) || candidate.adapterVersion <= 0) {
      return "adapterVersion 须为正安全整数";
    }
  }
  if (candidate.durablePayload !== undefined) {
    if (typeof candidate.durablePayload !== "string" || candidate.durablePayload.length === 0 || candidate.durablePayload.length > 512) {
      return "durablePayload 非法（须为 1..512 字符）";
    }
  }
  if (candidate.durablePayloadVersion !== undefined) {
    if (
      typeof candidate.durablePayloadVersion !== "number" ||
      !Number.isSafeInteger(candidate.durablePayloadVersion) ||
      candidate.durablePayloadVersion <= 0
    ) {
      return "durablePayloadVersion 须为正安全整数";
    }
  }
  if (typeof candidate.outcome !== "string" || !TREASURY_INTENT_OUTCOMES.has(candidate.outcome)) {
    return `outcome 非法（未知枚举）: ${String(candidate.outcome).slice(0, 48)}`;
  }
  if (typeof candidate.settlement !== "string" || !TREASURY_INTENT_SETTLEMENTS.has(candidate.settlement)) {
    return `settlement 非法（未知枚举）: ${String(candidate.settlement).slice(0, 48)}`;
  }
  if (candidate.structureId !== undefined) {
    if (typeof candidate.structureId !== "string" || candidate.structureId.length === 0 || candidate.structureId.length > INTENT_STRUCTURE_ID_MAX) {
      return "structureId 非法（须为 1..48 字符）";
    }
  }
  if (candidate.structureFacts !== undefined) {
    if (!Array.isArray(candidate.structureFacts) || candidate.structureFacts.length > INTENT_STRUCTURE_FACTS_MAX) {
      return "structureFacts 非数组或超上限";
    }
    for (const fact of candidate.structureFacts) {
      if (!fact || typeof fact !== "object") return "structureFact 项非对象";
      const typed = fact as Partial<TreasuryIntentStructureFact>;
      if (typeof typed.bindingKind !== "string" || !TREASURY_STRUCTURE_BINDING_KINDS.has(typed.bindingKind)) {
        return `structureFact.bindingKind 非法: ${String(typed.bindingKind).slice(0, 24)}`;
      }
      if (typeof typed.role !== "string" || !TREASURY_STRUCTURE_BINDING_ROLES.has(typed.role)) {
        return `structureFact.role 非法: ${String(typed.role).slice(0, 24)}`;
      }
      if (typeof typed.roomName !== "string" || typed.roomName.length === 0 || typed.roomName.length > 16) {
        return "structureFact.roomName 非法";
      }
      if (typeof typed.locationKind !== "string" || !VALID_LOCATION_KINDS.has(typed.locationKind)) {
        return `structureFact.locationKind 非法: ${String(typed.locationKind).slice(0, 24)}`;
      }
      if (typeof typed.structureId !== "string" || typed.structureId.length === 0 || typed.structureId.length > INTENT_STRUCTURE_ID_MAX) {
        return "structureFact.structureId 非法（须为 1..48 字符）";
      }
      if (typed.objectId !== undefined && (typeof typed.objectId !== "string" || typed.objectId.length === 0 || typed.objectId.length > INTENT_STRUCTURE_ID_MAX)) {
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
  if (candidate.ownerIdentity !== undefined) {
    if (typeof candidate.ownerIdentity !== "string" || candidate.ownerIdentity.length === 0 || candidate.ownerIdentity.length > INTENT_KIND_SOURCE_MAX) {
      return "ownerIdentity 非法（须为 1..128 字符）";
    }
  }
  if (candidate.policyIdentity !== undefined) {
    if (typeof candidate.policyIdentity !== "string" || candidate.policyIdentity.length === 0 || candidate.policyIdentity.length > INTENT_KIND_SOURCE_MAX) {
      return "policyIdentity 非法（须为 1..128 字符）";
    }
  }
  if (candidate.auditSource !== undefined) {
    if (typeof candidate.auditSource !== "string" || candidate.auditSource.length === 0 || candidate.auditSource.length > INTENT_KIND_SOURCE_MAX) {
      return "auditSource 非法（须为 1..128 字符）";
    }
  }
  if (!isSafeInteger(candidate.createdAtTick) || candidate.createdAtTick < 0) return "createdAtTick 非安全整数";
  if (!isSafeInteger(candidate.updatedAtTick) || candidate.updatedAtTick < 0) return "updatedAtTick 非安全整数";
  if (!Array.isArray(candidate.postings) || candidate.postings.length === 0 || candidate.postings.length > INTENT_POSTINGS_MAX) {
    return "postings 非数组/为空/超上限";
  }
  for (const posting of candidate.postings) {
    if (!posting || typeof posting !== "object") return "posting 项非对象";
    const leg = posting as Partial<TreasuryIntentPosting>;
    if (typeof leg.roomName !== "string" || leg.roomName.length === 0 || leg.roomName.length > 16) {
      return "posting.roomName 非法";
    }
    if (typeof leg.locationKind !== "string" || !VALID_LOCATION_KINDS.has(leg.locationKind)) {
      return `posting.locationKind 非法: ${String(leg.locationKind).slice(0, 24)}`;
    }
    if (typeof leg.resource !== "string" || !VALID_RESOURCES.has(leg.resource)) {
      return `posting.resource 不在 RESOURCES_ALL: ${String(leg.resource).slice(0, 24)}`;
    }
    if (!isSafeInteger(leg.delta) || leg.delta === 0) return "posting.delta 须为非零安全整数";
  }
  return null;
}

/** 聚合溢出预检（per-transaction 保守口径的每步安全整数）。 */
function validateIntentAggregateOverflow(postings: readonly TreasuryIntentPosting[]): string | null {
  const resourceTotals = new Map<string, number>();
  const capacityTotals = new Map<string, number>();
  for (const leg of postings) {
    const resourceKey = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
    const mergedResource = (resourceTotals.get(resourceKey) ?? 0) + leg.delta;
    if (!Number.isSafeInteger(mergedResource)) return "intent 资源聚合安全整数溢出";
    resourceTotals.set(resourceKey, mergedResource);
    const capacityKey = `${leg.roomName}\u0000${leg.locationKind}`;
    const mergedCapacity = (capacityTotals.get(capacityKey) ?? 0) + leg.delta;
    if (!Number.isSafeInteger(mergedCapacity)) return "intent 容量聚合安全整数溢出";
    capacityTotals.set(capacityKey, mergedCapacity);
  }
  return null;
}

/**
 * store 完整形状自检（global reset 后首次 load 与 repair 共用；一次全表
 * 扫描）：version、entries 对象、entryCount 一致、key 编码与 entry.
 * transactionId 一致、逐 entry 形状、聚合安全整数、容量上限。
 */
function validateIntentStoreShape(store: TreasuryIntentStore): string | null {
  if (store.version !== TREASURY_INTENT_VERSION) {
    return `未知 intent store 版本 ${String(store.version)}`;
  }
  if (!store.entries || typeof store.entries !== "object") return "intent entries 非对象";
  intentEvents.fullScans += 1;
  const ownKeys = Object.keys(store.entries);
  intentEvents.loadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  if (ownKeys.length > TREASURY_INTENT_MAX_ENTRIES) {
    return `entries 超过上限 ${String(TREASURY_INTENT_MAX_ENTRIES)}（含 ${String(ownKeys.length)} 条）`;
  }
  const resourceTotals = new Map<string, number>();
  const capacityTotals = new Map<string, number>();
  for (const key of ownKeys) {
    if (!key.startsWith(INTENT_KEY_PREFIX)) {
      return `存储键格式非法（须为 "i:"+transactionId）: ${key.slice(0, 48)}`;
    }
    const entry = (store.entries as Record<string, unknown>)[key];
    const shapeError = validateTreasuryIntentEntryShape(entry);
    if (shapeError !== null) {
      return `${shapeError}（key ${key.slice(0, 48)}）`;
    }
    const typed = entry as TreasuryIntentEntry;
    if (encodeIntentKey(typed.transactionId) !== key) {
      return `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}`;
    }
    // 跨 transaction 聚合溢出预检（与运行时聚合同 key）。
    for (const leg of typed.postings) {
      const resourceKey = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      const mergedResource = resourceTotals.get(resourceKey) === undefined ? leg.delta : (resourceTotals.get(resourceKey) as number) + leg.delta;
      if (!Number.isSafeInteger(mergedResource)) return "intent 跨 transaction 资源聚合安全整数溢出";
      resourceTotals.set(resourceKey, mergedResource);
      const capacityKey = `${leg.roomName}\u0000${leg.locationKind}`;
      const mergedCapacity = capacityTotals.get(capacityKey) === undefined ? leg.delta : (capacityTotals.get(capacityKey) as number) + leg.delta;
      if (!Number.isSafeInteger(mergedCapacity)) return "intent 跨 transaction 容量聚合安全整数溢出";
      capacityTotals.set(capacityKey, mergedCapacity);
    }
  }
  return null;
}

function fatalRuntime(store: TreasuryIntentStore, reason: string): IntentStoreRuntime {
  return { store, fatal: reason };
}

/**
 * 旧 structureFacts（v3 及更早的三元组形状）补全为完整 descriptor（第十一轮
 * 3.13.9）：缺省 bindingKind=governed_location、role=auxiliary、required=true、
 * version=1——不伪造 object identity（缺失字段由升级后形状校验检出 fatal）。
 */
function upgradeLegacyStructureFacts(entry: { structureFacts?: unknown }): void {
  const legacyFacts = entry.structureFacts;
  if (!Array.isArray(legacyFacts)) return;
  (entry as { structureFacts?: unknown }).structureFacts = legacyFacts.map((fact) => {
    const typed = fact as Partial<TreasuryIntentStructureFact>;
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
    } as TreasuryIntentStructureFact;
  });
}

/**
 * 加载（含校验）：写入/聚合路径专用（可能写 Memory——空 store 初始化或
 * v1→v2 无损升级）。校验失败 → fatal fail closed：不删数据、写入拒绝、
 * 聚合空、blockers 报 blocking，直至 faultResolution 的显式 repair 或人工
 * 处理。v1（第九轮前，无 contractDigest/adapterVersion/durablePayload 字段）
 * 全量验证通过后无损升级 v2（新字段全 optional，entries 原样保留）。
 */
function loadIntentStoreRuntime(): IntentStoreRuntime {
  if (heapRuntime) return heapRuntime;
  const raw = intentBranch().intents as TreasuryIntentStore | undefined;
  if (!raw) {
    const created: TreasuryIntentStore = { version: TREASURY_INTENT_VERSION, entries: {}, entryCount: 0, updatedAt: Game.time };
    intentBranch().intents = created;
    heapRuntime = { store: created, fatal: null };
    return heapRuntime;
  }
  const rawVersion = raw.version as number;
  if (rawVersion === 1 || rawVersion === 2) {
    // v1/v2 → v3 迁移（第十轮 3.12.1，原子）：逐 entry 将旧 phase 按保守
    // 单调表映射为 (outcome, settlement) 并删除 phase 字段；未知 phase 值
    // → fatal fail closed（原数据保留）。v1 entry 的 contract 字段全
    // optional，形状校验自然通过。
    const entries: Record<string, TreasuryIntentEntry> = {};
    for (const key of Object.keys((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const legacy = ((raw as { entries?: Record<string, unknown> }).entries ?? {})[key] as Partial<TreasuryIntentEntry> & { phase?: string };
      const mapped = typeof legacy.phase === "string" ? TREASURY_LEGACY_PHASE_MIGRATION[legacy.phase] : undefined;
      if (mapped === undefined) {
        heapRuntime = fatalRuntime(raw as unknown as TreasuryIntentStore, `旧 phase 无法无歧义迁移（${String(legacy.phase).slice(0, 48)}）——intent store fail closed，原数据保留`);
        return heapRuntime;
      }
      const { phase: _dropped, ...rest } = legacy as Partial<TreasuryIntentEntry> & { phase: string };
      upgradeLegacyStructureFacts(rest);
      entries[key] = { ...(rest as TreasuryIntentEntry), outcome: mapped.outcome, settlement: mapped.settlement };
    }
    const upgraded: TreasuryIntentStore = { version: TREASURY_INTENT_VERSION, entries, entryCount: Object.keys(entries).length, updatedAt: Game.time };
    const shapeError = validateIntentStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryIntentStore, `${shapeError}（v${String(rawVersion)} 升级校验失败，intent store fail closed，原数据保留）`);
      return heapRuntime;
    }
    intentBranch().intents = upgraded;
    heapRuntime = { store: upgraded, fatal: null };
    return heapRuntime;
  }
  if ((rawVersion as number) === 3) {
    // v3 → v4 迁移（第十一轮 3.13.9，原子）：structureFacts 三元组补全为
    // 完整 descriptor；损坏字段由升级后校验检出 fatal（原数据保留）。
    const entries: Record<string, TreasuryIntentEntry> = {};
    for (const key of Object.keys((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      const legacy = ((raw as { entries?: Record<string, unknown> }).entries ?? {})[key] as Partial<TreasuryIntentEntry>;
      upgradeLegacyStructureFacts(legacy);
      entries[key] = legacy as TreasuryIntentEntry;
    }
    const upgradedV3: TreasuryIntentStore = { ...(raw as TreasuryIntentStore), version: TREASURY_INTENT_VERSION, entries, updatedAt: Game.time };
    const shapeErrorV3 = validateIntentStoreShape(upgradedV3);
    if (shapeErrorV3 !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryIntentStore, `${shapeErrorV3}（v3 升级校验失败，intent store fail closed，原数据保留）`);
      return heapRuntime;
    }
    intentBranch().intents = upgradedV3;
    heapRuntime = { store: upgradedV3, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateIntentStoreShape(raw);
  if (shapeError !== null) {
    heapRuntime = fatalRuntime(raw, `${shapeError}（intent store fail closed，原数据保留）`);
    return heapRuntime;
  }
  heapRuntime = { store: raw, fatal: null };
  return heapRuntime;
}

export interface TreasuryIntentHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  readonly entryCount: number;
}

/**
 * intent store 健康探测（只读零写；prepare 门禁/readiness/blockers 用）：
 * heap 已 load 且 fatal → unhealthy；未 load 时轻量形状探测（version 可识别/
 * entries 对象/entryCount 数字）——entry 级损坏由下一次 load 显式检出。
 */
export function peekTreasuryIntentHealth(): TreasuryIntentHealth {
  if (heapRuntime?.fatal) {
    const keys = Object.keys(heapRuntime.store.entries ?? {});
    return { healthy: false, detail: heapRuntime.fatal, entryCount: keys.length };
  }
  const store = peekTreasuryIntentStore();
  if (store === undefined) return { healthy: true, detail: null, entryCount: 0 };
  if (
    store.version !== TREASURY_INTENT_VERSION &&
    (store.version as number) !== 1 &&
    (store.version as number) !== 2 &&
    (store.version as number) !== 3
  ) {
    return {
      healthy: false,
      detail: `未知 intent store 版本 ${String(store.version)}`,
      entryCount: 0,
    };
  }
  if (!store.entries || typeof store.entries !== "object") {
    return { healthy: false, detail: "intent entries 非对象", entryCount: 0 };
  }
  if (!isSafeInteger(store.entryCount) || store.entryCount < 0) {
    return { healthy: false, detail: "intent entryCount 非法", entryCount: 0 };
  }
  return { healthy: true, detail: null, entryCount: store.entryCount };
}

/** 显式触发 load 全量验证（写入/恢复路径用）：返回 fatal 描述（null = 可用）。 */
export function ensureTreasuryIntentStoreValidated(): string | null {
  const runtime = loadIntentStoreRuntime();
  return runtime.fatal;
}

/** 冻结深拷贝的单条 entry（快照封闭——外部修改不影响内部权威）。 */
function freezeIntentCopy(entry: TreasuryIntentEntry): Readonly<TreasuryIntentEntry> {
  return Object.freeze({
    ...entry,
    postings: entry.postings.map((leg) => Object.freeze({ ...leg })),
    ...(entry.structureFacts !== undefined
      ? { structureFacts: entry.structureFacts.map((fact) => Object.freeze({ ...fact })) }
      : {}),
  }) as Readonly<TreasuryIntentEntry>;
}

/**
 * 单条只读查询（O(1)；快照封闭）。fatal store 一律视为不可信；store 尚不
 * 存在时零写返回 undefined——查询路径不隐式创建 store。
 */
export function readTreasuryIntentEntry(transactionId: string): Readonly<TreasuryIntentEntry> | undefined {
  if (peekTreasuryIntentStore() === undefined) return undefined;
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) return undefined;
  const entry = runtime.store.entries[encodeIntentKey(transactionId)];
  return entry === undefined ? undefined : freezeIntentCopy(entry);
}

/** 全部条目的冻结快照（诊断/resolution 枚举；fatal store 返回空）。 */
export function listTreasuryIntentEntries(): readonly Readonly<TreasuryIntentEntry>[] {
  if (peekTreasuryIntentStore() === undefined) return Object.freeze([]);
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) return Object.freeze([]);
  return Object.freeze(Object.values(runtime.store.entries).map(freezeIntentCopy));
}

export type TreasuryIntentWriteResult =
  | { readonly status: "written" }
  | { readonly status: "already_present" }
  | {
      readonly status: "rejected";
      readonly reason: "store_fatal" | "capacity_exhausted" | "invalid_entry";
      readonly detail: string;
    };

/**
 * 写入 durable intent（Game API 调用前）。写入前对 entry **重新完整验证**
 * （绝不假设调用方传入 prepare 验证过的安全对象）。同 id 重复写入幂等保留
 * 首条；容量已满时 rejected（绝不丢 identity——prepare 的统一 slot admission
 * 已保证此分支在正常路径不可达；防御性拒绝保持 store 不变，调用方阻断
 * callback 并释放预留）。
 */
export function writeTreasuryIntentEntry(entry: TreasuryIntentEntry): TreasuryIntentWriteResult {
  const shapeError = validateTreasuryIntentEntryShape(entry);
  if (shapeError !== null) {
    intentEvents.writeRejections += 1;
    return { status: "rejected", reason: "invalid_entry", detail: shapeError };
  }
  const overflowError = validateIntentAggregateOverflow(entry.postings);
  if (overflowError !== null) {
    intentEvents.writeRejections += 1;
    return { status: "rejected", reason: "invalid_entry", detail: overflowError };
  }
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) {
    intentEvents.writeFailures += 1;
    return { status: "rejected", reason: "store_fatal", detail: runtime.fatal };
  }
  const key = encodeIntentKey(entry.transactionId);
  if (Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) {
    return { status: "already_present" };
  }
  if (runtime.store.entryCount >= TREASURY_INTENT_MAX_ENTRIES) {
    intentEvents.writeFailures += 1;
    return {
      status: "rejected",
      reason: "capacity_exhausted",
      detail: `intent store 容量已满（${String(TREASURY_INTENT_MAX_ENTRIES)} 条；统一 slot admission 不变量被破坏，阻断 callback）`,
    };
  }
  runtime.store.entries[key] = { ...entry, postings: entry.postings.map((leg) => ({ ...leg })) };
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  storeRevision += 1;
  return { status: "written" };
}

export type TreasuryIntentPhaseUpdateResult =
  | { readonly status: "marked" }
  | {
      readonly status: "rejected";
      readonly reason: "not_found" | "store_fatal" | "invalid_phase" | "predecessor_mismatch" | "identity_mismatch" | "outcome_regression";
      readonly detail: string;
    };

/** intent 进展迁移请求（第十轮 3.12.1）：目标两轴 + settlement 合法前序 + identity。 */
export interface TreasuryIntentProgression {
  /** 目标 execution outcome（单调表内建校验）。 */
  readonly outcome: TreasuryExecutionOutcome;
  /** 目标 settlement workflow state。 */
  readonly settlement: TreasurySettlementState;
  /** settlement 合法前序集合（当前 settlement 必须在其中，或已等于目标——幂等）。 */
  readonly fromSettlement?: readonly TreasurySettlementState[];
  /** identity 校验：提供时必须与 entry 的 digest 一致。 */
  readonly digest?: string;
  /** identity 校验：提供时必须与 entry 的 contractId 一致。 */
  readonly contractId?: string;
}

/**
 * intent 进展迁移（第十轮 3.12.1）：**一次原子写入** outcome + settlement
 * 两轴——outcome 走内建单调表（not_started→started_unknown→{returned_ok|
 * returned_non_ok}；已记录的执行事实绝不回退），settlement 走调用方声明的
 * 合法前序集合。identity 校验（digest/contractId）先于前序校验；幂等仅限
 * 同 identity 且 outcome/settlement 均已处于目标；非法前序
 * （predecessor_mismatch）/outcome 非单调（outcome_regression）/identity
 * 不一致（identity_mismatch）/entry 不存在（not_found）/store 损坏
 * （store_fatal）一律拒绝——调用方（facade）在这些结果上必须按分支语义
 * 处置（callback 零调用或保留事实进入 fault）。
 */
export function progressTreasuryIntent(
  transactionId: string,
  progression: TreasuryIntentProgression,
): TreasuryIntentPhaseUpdateResult {
  if (!TREASURY_INTENT_OUTCOMES.has(progression.outcome)) {
    return { status: "rejected", reason: "invalid_phase", detail: `outcome ${progression.outcome} 未知` };
  }
  if (!TREASURY_INTENT_SETTLEMENTS.has(progression.settlement)) {
    return { status: "rejected", reason: "invalid_phase", detail: `settlement ${progression.settlement} 未知` };
  }
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) {
    return { status: "rejected", reason: "store_fatal", detail: runtime.fatal };
  }
  const key = encodeIntentKey(transactionId);
  const entry = runtime.store.entries[key];
  if (entry === undefined) {
    return { status: "rejected", reason: "not_found", detail: "intent entry 不存在（已释放或从未写入）" };
  }
  // identity 校验（digest/contract）先于前序校验。
  if (progression.digest !== undefined && entry.digest !== progression.digest) {
    return {
      status: "rejected",
      reason: "identity_mismatch",
      detail: `intent digest ${entry.digest} 与迁移请求 ${progression.digest} 不一致（同 id 不得迁移不同 payload）`,
    };
  }
  if (progression.contractId !== undefined && (entry.contractId ?? "") !== progression.contractId) {
    return {
      status: "rejected",
      reason: "identity_mismatch",
      detail: `intent contractId ${entry.contractId ?? "(无)"} 与迁移请求 ${progression.contractId} 不一致`,
    };
  }
  const outcomeSettled = entry.outcome === progression.outcome;
  const settlementSettled = entry.settlement === progression.settlement;
  if (outcomeSettled && settlementSettled) {
    // 幂等：同 identity 且两轴均已处于目标。
    return { status: "marked" };
  }
  // outcome 单调校验（内建表）：目标必须是当前 outcome 的合法后继（或已相等）。
  if (!outcomeSettled) {
    const allowed = TREASURY_OUTCOME_PROGRESSION[entry.outcome] ?? [];
    if (!allowed.includes(progression.outcome)) {
      return {
        status: "rejected",
        reason: "outcome_regression",
        detail: `outcome ${entry.outcome} → ${progression.outcome} 非法（执行事实单调不可回退；合法后继：${allowed.length > 0 ? allowed.join("|") : "无（终态）"}）`,
      };
    }
  }
  // settlement 前序校验（调用方声明的合法前序集合）。
  if (!settlementSettled) {
    const fromSettlement = progression.fromSettlement ?? [];
    if (!(fromSettlement as readonly string[]).includes(entry.settlement)) {
      return {
        status: "rejected",
        reason: "predecessor_mismatch",
        detail: `settlement ${entry.settlement} 不是 ${progression.settlement} 的合法前序（期望 ${fromSettlement.length > 0 ? fromSettlement.join("|") : "(无)"}）`,
      };
    }
  }
  entry.outcome = progression.outcome;
  entry.settlement = progression.settlement;
  entry.updatedAtTick = Game.time;
  runtime.store.updatedAt = Game.time;
  storeRevision += 1;
  return { status: "marked" };
}

/**
 * 释放单条 intent（返回是否确有条目被释放）。合法调用情形：transaction
 * settled / 确认 aborted / quarantine 完整写入并验证 / resolution finalized。
 */
export function releaseTreasuryIntentEntry(transactionId: string): boolean {
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) return false;
  const key = encodeIntentKey(transactionId);
  if (!Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
  storeRevision += 1;
  return true;
}

export interface TreasuryIntentBlockers {
  readonly blocking: boolean;
  readonly unresolvedCount: number;
  readonly unhealthyDetail: string | null;
}

/**
 * 授权/写入阻断状态（authorizationSafe、write readiness 与 prepare 全局
 * 门禁共用；只读零写——store 不存在时视为空且健康，不隐式创建）：blocking =
 * 存在任一未完成 entry 或 store 损坏。未完成 intent 阻断一切新 writer。
 */
export function treasuryIntentBlockers(): TreasuryIntentBlockers {
  if (heapRuntime?.fatal) {
    const keys = Object.keys(heapRuntime.store.entries ?? {});
    return { blocking: true, unresolvedCount: keys.length, unhealthyDetail: heapRuntime.fatal };
  }
  const health = peekTreasuryIntentHealth();
  return {
    blocking: !health.healthy || health.entryCount > 0,
    unresolvedCount: health.entryCount,
    unhealthyDetail: health.healthy ? null : health.detail,
  };
}

// ── per-transaction 保守风险聚合（与 quarantine 同口径；revision 缓存） ─────

function computeAggregates(): { outflow: Map<string, number>; capacityOccupancy: Map<string, number> } {
  const outflow = new Map<string, number>();
  const capacityOccupancy = new Map<string, number>();
  for (const entry of listTreasuryIntentEntries()) {
    // transaction 内先按 (room,location,resource) / (room,location) 合并。
    const resourceNets = new Map<string, number>();
    const capacityNets = new Map<string, number>();
    for (const leg of entry.postings) {
      const resourceKey = `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}`;
      const mergedResource = (resourceNets.get(resourceKey) ?? 0) + leg.delta;
      if (!Number.isSafeInteger(mergedResource)) return { outflow: new Map(), capacityOccupancy: new Map() };
      resourceNets.set(resourceKey, mergedResource);
      const capacityKey = `${leg.roomName}\u0000${leg.locationKind}`;
      const mergedCapacity = (capacityNets.get(capacityKey) ?? 0) + leg.delta;
      if (!Number.isSafeInteger(mergedCapacity)) return { outflow: new Map(), capacityOccupancy: new Map() };
      capacityNets.set(capacityKey, mergedCapacity);
    }
    // 跨 transaction 保守求和：正流入不抵消另一笔负流出、流出只累计净流出。
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

function ensureAggregates(): IntentAggregates | null {
  if (aggregateCache && aggregateCache.revision === storeRevision) return aggregateCache;
  const computed = computeAggregates();
  aggregateCache = { revision: storeRevision, ...computed };
  return aggregateCache;
}

/**
 * unresolved intents 的资源流出占用（只读、per-transaction 保守、按 store
 * revision 缓存）：(room,location,resource) → Σ_transactions max(0, −net)。
 * 聚合溢出或 fatal store → 空 Map（消费方 blockers 已 fail closed，不以聚合
 * 数值放宽）。返回新建 Map 快照——不泄漏内部缓存引用。
 */
export function treasuryIntentOutflowOccupancy(): ReadonlyMap<string, number> {
  if (peekTreasuryIntentStore() === undefined) return new Map();
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) return new Map();
  const aggregates = ensureAggregates();
  return aggregates === null ? new Map() : new Map(aggregates.outflow);
}

/**
 * unresolved intents 的容量占用（只读、缓存、快照封闭）：
 * (room,location) → Σ_transactions max(0, net)。零写契约同 outflow。
 */
export function treasuryIntentCapacityOccupancy(): ReadonlyMap<string, number> {
  if (peekTreasuryIntentStore() === undefined) return new Map();
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) return new Map();
  const aggregates = ensureAggregates();
  return aggregates === null ? new Map() : new Map(aggregates.capacityOccupancy);
}

// ── global reset / tick 边界恢复 ────────────────────────────────────────────

export interface TreasuryIntentRecoveryReport {
  /** ready 相按协议确认未执行而释放的条数。 */
  recoveredNotExecuted: number;
  /** 保守转 execution-unknown quarantine 的条数。 */
  convertedToQuarantine: number;
  /** quarantine 写失败而保留（emergency authority）的条数。 */
  retainedForAuthority: number;
  storeFatal: string | null;
}

/**
 * tick 边界（beginTick 显式分支，先于一切 planner/writer）的 intent 恢复
 * （第十轮 3.12.1 按 (outcome, settlement) 事实等级分级——已知 Game 返回
 * OK 不降级为"可能未执行"，事实单调性）：
 * - (not_started, ready)：协议保证 execution-started 标记先于 callback——
 *   持久化的 not_started 即"Game API 从未被调用"，确认未执行关闭（释放
 *   slot、不写 receipt、不进 quarantine），计 intentRecoveries；
 * - outcome=returned_non_ok：Game 已明确返回非 OK——保留该事实转 quarantine
 *   （phase=action_returned_non_ok_abort_failed，仍属 execution-unknown 类
 *   ——abort 未完成或终态未落盘；不得当作 callback 仍在执行）；
 * - outcome=returned_ok：Game 已明确返回 OK——commit 类隔离
 *   （phase=ok_pending_commit_unresolved；后续 resolution 只能
 *   resolve-as-committed，永不允许 not-executed）；
 * - 其余（started_unknown 各 settlement）：无法确认 action 是否执行——
 *   保守转 execution-unknown quarantine（phase=executing_at_end_tick，
 *   postings 完整携带）；
 * - settlement=finalized（outcome=returned_ok/aborted_final）：终态残留
 *   （正常路径随关闭即删）——幂等释放（receipt/abort 已完成，事实明确）；
 * 各等级转 quarantine 后释放 intent（slot 守恒：quarantine +1、intent −1）；
 * - quarantine 写失败（store fatal/容量分支）：intent **保留**（emergency
 *   intent authority——postings/风险占用/slot 不丢，phase 原样保留等价
 *   参与等级），下一 tick 重试；
 * - store fatal：不删任何数据，report 携带诊断（writer 由 blockers 阻断）。
 * 恢复幂等（重复调用对已处理条目 no-op）。
 */
/**
 * intent → quarantine 的 durable 事实转移协议（第十轮 5.1）：将 entry 的
 * 全部合同事实（contract ID/digest、actionKind、adapterVersion、durable
 * payload/version、authorizationDigest、owner/policy identity、structure
 * facts、execution outcome、settlement）原子写入 quarantine v2；**读回验证
 * 一致后**才释放 intent slot——任何写入被拒或读回不一致都保留 intent
 * （emergency authority，slot 守恒语义：转移完成前不删除源事实）。
 *
 * outcome 合并规则（单调，终态优先）：intent 已落盘的终态事实
 * （returned_ok/returned_non_ok/aborted_final）优先保留；否则按 fault phase
 * 单调推导（commit 类 → returned_ok——修复"OK 事实只存在于 faultPhase 而未
 * 落盘"的窗口）。settlement 恒为 quarantined（隔离态语义）。
 */
export function transferTreasuryIntentToQuarantine(
  entry: Readonly<TreasuryIntentEntry>,
  quarantinePhase: TreasuryWriteFaultPhase,
): { readonly status: "transferred" } | { readonly status: "retained"; readonly detail: string } {
  const derived = outcomeOfTreasuryFaultPhase(quarantinePhase);
  if (derived === null) {
    return { status: "retained", detail: `未知 fault phase ${quarantinePhase}（outcome 无法单调推导）` };
  }
  const terminalOutcome =
    entry.outcome === "returned_ok" || entry.outcome === "returned_non_ok" || entry.outcome === "aborted_final";
  const outcome = terminalOutcome ? entry.outcome : derived;
  const write = quarantineTreasuryTransaction({
    transactionId: entry.transactionId,
    digest: entry.digest,
    tick: entry.createdAtTick,
    kind: entry.kind,
    source: entry.source,
    phase: quarantinePhase,
    deltas: entry.postings.map((leg) => ({ ...leg })),
    recordedAt: entry.updatedAtTick,
    outcome,
    settlement: "quarantined",
    ...(entry.contractId !== undefined ? { contractId: entry.contractId } : {}),
    ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
    ...(entry.actionKind !== undefined ? { actionKind: entry.actionKind } : {}),
    ...(entry.adapterVersion !== undefined ? { adapterVersion: entry.adapterVersion } : {}),
    ...(entry.durablePayload !== undefined ? { durablePayload: entry.durablePayload } : {}),
    ...(entry.durablePayloadVersion !== undefined ? { durablePayloadVersion: entry.durablePayloadVersion } : {}),
    ...(entry.authorizationDigest !== undefined ? { authorizationDigest: entry.authorizationDigest } : {}),
    ...(entry.ownerIdentity !== undefined ? { ownerIdentity: entry.ownerIdentity } : {}),
    ...(entry.policyIdentity !== undefined ? { policyIdentity: entry.policyIdentity } : {}),
    ...(entry.structureFacts !== undefined ? { structureFacts: entry.structureFacts.map((fact) => ({ ...fact })) } : {}),
  } as TreasuryQuarantineEntry);
  if (write.status === "rejected") {
    return { status: "retained", detail: `quarantine 写入被拒（${write.reason}）: ${write.detail}` };
  }
  // 读回验证（事实安全转移的放行条件）：关键字段与写入声明一致才释放 intent。
  const readBack = readTreasuryQuarantineEntry(entry.transactionId);
  const consistent =
    readBack !== undefined &&
    readBack.digest === entry.digest &&
    readBack.outcome === outcome &&
    readBack.settlement === "quarantined" &&
    readBack.deltas.length === entry.postings.length &&
    readBack.deltas.every(
      (leg, index) =>
        leg.roomName === entry.postings[index].roomName &&
        leg.locationKind === entry.postings[index].locationKind &&
        leg.resource === entry.postings[index].resource &&
        leg.delta === entry.postings[index].delta,
    ) &&
    (readBack.contractDigest ?? undefined) === entry.contractDigest &&
    (readBack.adapterVersion ?? undefined) === entry.adapterVersion &&
    (readBack.durablePayloadVersion ?? undefined) === entry.durablePayloadVersion;
  if (!consistent) {
    return { status: "retained", detail: "quarantine 读回验证不一致（store 不可信）——intent 保留为 emergency authority" };
  }
  releaseTreasuryIntentEntry(entry.transactionId);
  return { status: "transferred" };
}

export function recoverTreasuryIntentsAtTickBoundary(): TreasuryIntentRecoveryReport {
  const report: TreasuryIntentRecoveryReport = {
    recoveredNotExecuted: 0,
    convertedToQuarantine: 0,
    retainedForAuthority: 0,
    storeFatal: null,
  };
  if (peekTreasuryIntentStore() === undefined) return report;
  const runtime = loadIntentStoreRuntime();
  if (runtime.fatal) {
    report.storeFatal = runtime.fatal;
    return report;
  }
  for (const entry of Object.values(runtime.store.entries)) {
    if (entry.outcome === "not_started" && entry.settlement === "ready") {
      if (releaseTreasuryIntentEntry(entry.transactionId)) {
        intentEvents.recoveries += 1;
        report.recoveredNotExecuted += 1;
      }
      continue;
    }
    if (entry.settlement === "finalized") {
      // 终态残留（正常路径随关闭即删——receipt/abort 已完成）：幂等释放。
      if (releaseTreasuryIntentEntry(entry.transactionId)) {
        intentEvents.recoveries += 1;
        report.recoveredNotExecuted += 1;
      }
      continue;
    }
    // 事实等级映射：保留"Game 已返回非 OK / OK"的 outcome 事实（不降级为
    // executing_at_end_tick 的模糊 unknown）。
    const quarantinePhase =
      entry.outcome === "returned_non_ok"
        ? ("action_returned_non_ok_abort_failed" as const)
        : entry.outcome === "returned_ok"
          ? ("ok_pending_commit_unresolved" as const)
          : ("executing_at_end_tick" as const);
    const transferred = transferTreasuryIntentToQuarantine(entry, quarantinePhase);
    if (transferred.status === "retained") {
      // emergency intent authority：保留 entry（postings/占用/slot 不丢，
      // phase 原样保留——下一 tick 按同一等级重试）。
      intentEvents.emergencyRetentions += 1;
      report.retainedForAuthority += 1;
      continue;
    }
    intentEvents.quarantineConversions += 1;
    report.convertedToQuarantine += 1;
  }
  return report;
}

/** 仅供测试：失效 heap 缓存与计数（clearTreasuryPersistenceForTest 调用）。 */
export function resetTreasuryIntentRuntimeForTest(): void {
  heapRuntime = null;
  aggregateCache = null;
  storeRevision = 0;
  intentEvents.fullScans = 0;
  intentEvents.loadValidationEntries = 0;
  intentEvents.writeFailures = 0;
  intentEvents.writeRejections = 0;
  intentEvents.recoveries = 0;
  intentEvents.quarantineConversions = 0;
  intentEvents.emergencyRetentions = 0;
}

/**
 * 显式 repair 内部实现（仅供 faultResolution 的 repair 入口调用）：全量验证
 * 现存 entries 合法后修复 store 元数据（version/entryCount 重算）。任何
 * entry 损坏 → 拒绝（原数据不动）。绝不删除任何 entry。
 */
export function repairTreasuryIntentStoreMetadataForResolution(): { status: "repaired" | "rejected"; detail: string } {
  const raw = intentBranch().intents as TreasuryIntentStore | undefined;
  if (!raw) return { status: "rejected", detail: "intent store 不存在（无需 repair）" };
  if (!raw.entries || typeof raw.entries !== "object") {
    return { status: "rejected", detail: "intent entries 非对象（人工处理）" };
  }
  const ownKeys = Object.keys(raw.entries);
  intentEvents.fullScans += 1;
  intentEvents.loadValidationEntries += ownKeys.length;
  for (const key of ownKeys) {
    const entry = (raw.entries as Record<string, unknown>)[key];
    const shapeError = validateTreasuryIntentEntryShape(entry);
    if (shapeError !== null) {
      return { status: "rejected", detail: `${shapeError}（key ${key.slice(0, 48)}；原数据保留）` };
    }
    const typed = entry as TreasuryIntentEntry;
    if (encodeIntentKey(typed.transactionId) !== key) {
      return { status: "rejected", detail: `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}` };
    }
    const overflow = validateIntentAggregateOverflow(typed.postings);
    if (overflow !== null) {
      return { status: "rejected", detail: `${overflow}（key ${key.slice(0, 48)}；原数据保留）` };
    }
  }
  if (ownKeys.length > TREASURY_INTENT_MAX_ENTRIES) {
    return {
      status: "rejected",
      detail: `entries 超过上限 ${String(TREASURY_INTENT_MAX_ENTRIES)}（先 resolution 部分条目再 repair）`,
    };
  }
  raw.version = TREASURY_INTENT_VERSION;
  raw.entryCount = ownKeys.length;
  raw.updatedAt = Game.time;
  heapRuntime = { store: raw, fatal: null };
  storeRevision += 1;
  return { status: "repaired", detail: `intent store repair 完成（${String(ownKeys.length)} 条 entry 保留）` };
}

/** 诊断：合法 settlement 集合是否包含给定值（测试与 guard 用）。 */
export function isValidTreasuryIntentSettlement(settlement: string): settlement is TreasurySettlementState {
  return TREASURY_INTENT_SETTLEMENTS.has(settlement);
}

/** 诊断：合法 outcome 集合是否包含给定值（测试与 guard 用）。 */
export function isValidTreasuryIntentOutcome(outcome: string): outcome is TreasuryExecutionOutcome {
  return TREASURY_INTENT_OUTCOMES.has(outcome);
}

/** 诊断导出：write-fault phase 合法集（与 quarantine 校验同一权威）。 */
export const TREASURY_INTENT_FAULT_PHASES: ReadonlySet<string> = TREASURY_WRITE_FAULT_PHASES;
