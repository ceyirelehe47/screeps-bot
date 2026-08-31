/**
 * Treasury resolution tombstone store（第八轮建立 staged 状态；第十五轮升级
 * version 5 + 不可逆状态机 + 统一 authority resolver）。
 *
 * 角色：显式 fault resolution 的有界幂等记录与 staged 状态机载体。独立成
 * 模块（而非内嵌 faultResolution.ts）的原因：facade 需要（a）统一 replay
 * horizon 的 committed tombstone 只读查询（prepare 幂等）、（b）beginTick
 * 的 staged resolution 恢复与（c）capability 签发的 resolving 互斥门禁——
 * 生产代码不得 import faultResolution（架构边界测试守护），本模块只承载
 * store 级语义供两侧共享。
 *
 * 健康契约（与 receipt/quarantine/intent 同款）：
 * - version 5：version/entryCount 元数据 + key="r:"+transactionId + entry
 *   完整形状校验（resolution/stage 枚举、digest 16hex、安全整数、有界
 *   string、forensic provenance 形状）+ 容量上限 256（满时在**任何原状态
 *   变化之前**拒绝）+ 未知版本 fail closed（原数据保留）+ global reset 首次
 *   load 全量验证 + heap cache（含 resolving 计数——轻量 probe 不再全表
 *   扫描）；
 * - v1/v2/v3/v4：受支持的可迁移版本（loader 支持集合与轻量 health probe
 *   一致——supported migration pending，不误报 unknown fatal）；迁移原子
 *   替换、幂等；损坏 fatal（malformed 旧 tombstone 绝不当可清理垃圾删除
 *   ——人工处理）；
 * - 惰性清理只删除 resolvedAtTick 超过 retention（5000）的完整验证条目；
 *   损坏条目不删除；stage=resolving 永不驱逐。
 *
 * 【第十五轮第六节】写入全部经 resolutionStateMachine（不可逆状态机）判定：
 * absent 只能创建 resolving committed / final not-executed；resolving
 * committed 只能 finalize 为 final committed（全部安全关键字段保持）；final
 * 只允许 exact idempotent 重复写。delete 收敛为仅 resolving 回滚。
 *
 * 【第十五轮第五节】staged 恢复的 authority 读取统一经
 * resolveTreasuryUnresolvedAuthority（`quarantine ?? intent` 旁路删除）；
 * committed 三方 proof 验证统一经 committedProofVerifier（与 immediate
 * resolve-as-committed 复用同一 verifier）。
 */

import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import {
  TREASURY_RECEIPT_RETENTION_TICKS,
  readTreasurySettlementProof,
  refreshSettledReceiptForResolution,
  registerTreasuryResolutionResetHook,
} from "@/runtime/treasury/receipts";
import { clearTreasuryWriteFaultMarkerForResolution } from "@/runtime/treasury/writeFault";
import { releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { releaseTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
import { validateTreasuryResolutionTombstoneTransition } from "@/runtime/treasury/resolutionStateMachine";
import {
  treasuryProofLevelAutoReleasesAuthorityLevel,
  verifyTreasuryCommittedResolutionProof,
} from "@/runtime/treasury/committedProofVerifier";
import {
  validateTreasuryForensicProvenanceShape,
  type TreasuryForensicProvenance,
} from "@/runtime/treasury/forensicProvenance";
import { treasuryBoundedDeepFreezeSnapshot } from "@/runtime/treasury/durableSnapshot";

/** 【第十五轮第六节】resolution tombstone v5（新增可选 forensic provenance）。 */
export const TREASURY_RESOLUTION_VERSION = 5 as const;
export const TREASURY_RESOLUTION_MAX_ENTRIES = 256;
const TREASURY_RESOLUTION_RETENTION_TICKS = 5_000;
const RESOLUTION_KEY_PREFIX = "r:";
const RESOLUTION_SOURCE_MAX = 128;
const RESOLUTION_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

export type TreasuryResolutionKind = "committed" | "not-executed";
export type TreasuryResolutionStage = "resolving" | "final";

/**
 * 【第十四轮第十一节】resolution tombstone 的显式 proof class（不再由
 * optional 身份字段的存在性隐式猜测 modern/legacy）：
 * - identity-bound：modern contract authority 的完整 attempt identity 绑定
 *   proof——required：digest + contractDigest + authorizationCohortDigest +
 *   durableIdentityDigest（任一缺失 → store unhealthy，绝不降级 legacy）；
 *   唯一可释放 modern authority 的 proof class；
 * - lowlevel：低层 authority 的 proof——required：digest +
 *   durableIdentityDigest；禁止 contract/cohort digest（低层无这些事实）；
 *   可释放 lowlevel authority，不得释放 modern authority；
 * - legacy：legacy replay-only proof——禁止任何现代身份字段；只能作为保守
 *   历史诊断与 replay blocker，不得释放 modern/lowlevel authority，不得被
 *   自动补齐现代身份；
 * - forensic：显式 forensic 管理协议的隔离 proof——只能服务显式 forensic
 *   流程，不参与普通 capability resolution，不证明 modern/lowlevel authority。
 */
export type TreasuryResolutionProofLevel = "identity-bound" | "lowlevel" | "legacy" | "forensic";

export const TREASURY_RESOLUTION_PROOF_LEVELS: ReadonlySet<string> = new Set<string>([
  "identity-bound",
  "lowlevel",
  "legacy",
  "forensic",
]);

export interface TreasuryResolutionTombstone {
  transactionId: string;
  digest: string;
  resolution: TreasuryResolutionKind;
  /** staged 状态：resolving = resolution 进行中（可恢复）；final = 完成。 */
  stage: TreasuryResolutionStage;
  /** 【第十一轮 v3】attempt identity 绑定字段（语义由 proofLevel 显式声明）。 */
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  /** 【第十四轮 v4】显式 proof class（required/forbidden 矩阵见上）。 */
  proofLevel: TreasuryResolutionProofLevel;
  /**
   * 【第十五轮第八节 v5】显式 forensic 管理协议 provenance（仅显式管理流程
   * 可携带；migration-derived forensic 无此字段 → 永久隔离，不得由普通
   * beginTick 自动释放）。
   */
  readonly forensicProvenance?: TreasuryForensicProvenance;
  /** 原 action tick（审计保留；receipt retention 从 settledAtTick 起算）。 */
  actionTick: number;
  /** receipt 结算 tick（resolve-as-committed = resolution tick）。 */
  settledAtTick?: number;
  /** 对账观察 tick（capability 签发时点）。 */
  observationTick: number;
  resolvedAtTick: number;
  reconcilerKind?: string;
  source?: string;
  /** pre-execution authorization fault 的 acknowledge-rolled-back resolution（第十一轮 3.13.1）。 */
  preExecution?: boolean;
}

export interface TreasuryResolutionStore {
  version: 5;
  entries: Record<string, TreasuryResolutionTombstone>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryResolutionBranch {
  resolutions?: {
    version?: number;
    entries?: Record<string, TreasuryResolutionTombstone>;
    entryCount?: number;
    updatedAt?: number;
  };
}

type RuntimeMemoryWithResolutions = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryResolutionBranch;
};

function resolutionBranch(): TreasuryResolutionBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithResolutions;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

// ── heap 运行态 + 计数 ──────────────────────────────────────────────────────

interface ResolutionStoreRuntime {
  store: TreasuryResolutionStore;
  fatal: string | null;
  /** 【第十五轮第十节】resolving 计数 heap 缓存（轻量 probe 不再全表扫描）。 */
  inProgress: number;
}

let heapRuntime: ResolutionStoreRuntime | null = null;

const resolutionStoreEvents = {
  fullScans: 0,
  loadValidationEntries: 0,
  inProgressRecoveries: 0,
  recovered: 0,
  faulted: 0,
  /** 【第十三轮】staged recovery 的 identity relation 独立计数（conflict 与 insufficient 分离）。 */
  identityConflicts: 0,
  identityInsufficientBlockers: 0,
  /** 【第十五轮第五节】双 authority inconsistent 的独立阻断计数。 */
  authorityInconsistentBlockers: 0,
};

export interface TreasuryResolutionStoreCounters {
  readonly fullScans: number;
  readonly loadValidationEntries: number;
  readonly recovered: number;
  readonly faulted: number;
  readonly identityConflicts: number;
  readonly identityInsufficientBlockers: number;
  readonly authorityInconsistentBlockers: number;
}

export function readTreasuryResolutionStoreCounters(): TreasuryResolutionStoreCounters {
  const { fullScans, loadValidationEntries, recovered, faulted, identityConflicts, identityInsufficientBlockers, authorityInconsistentBlockers } = resolutionStoreEvents;
  return { fullScans, loadValidationEntries, recovered, faulted, identityConflicts, identityInsufficientBlockers, authorityInconsistentBlockers };
}

/**
 * 仅供测试：清零（经 receipts 的注册钩子随 clearTreasuryPersistenceForTest
 * 调用——模块加载时自注册，避免 receipts ↔ resolutionStore 循环依赖）。
 */
export function resetTreasuryResolutionStoreForTest(): void {
  heapRuntime = null;
  resolutionStoreEvents.fullScans = 0;
  resolutionStoreEvents.loadValidationEntries = 0;
  resolutionStoreEvents.inProgressRecoveries = 0;
  resolutionStoreEvents.recovered = 0;
  resolutionStoreEvents.faulted = 0;
  resolutionStoreEvents.identityConflicts = 0;
  resolutionStoreEvents.identityInsufficientBlockers = 0;
  resolutionStoreEvents.authorityInconsistentBlockers = 0;
}

registerTreasuryResolutionResetHook(resetTreasuryResolutionStoreForTest);

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** 单条 tombstone 完整形状校验（返回 null = 合法，否则有界错误描述）。 */
export function validateTreasuryResolutionTombstoneShape(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "tombstone 非对象";
  const candidate = entry as Partial<TreasuryResolutionTombstone>;
  if (typeof candidate.transactionId !== "string" || !isValidTreasuryTransactionId(candidate.transactionId)) {
    return `transactionId 非法: ${String(candidate.transactionId).slice(0, 48)}`;
  }
  if (typeof candidate.digest !== "string" || !RESOLUTION_DIGEST_PATTERN.test(candidate.digest)) {
    return "digest 非法（须为 16 小写 hex）";
  }
  if (candidate.resolution !== "committed" && candidate.resolution !== "not-executed") {
    return `resolution 非法（未知枚举）: ${String(candidate.resolution).slice(0, 24)}`;
  }
  if (candidate.stage !== undefined && candidate.stage !== "resolving" && candidate.stage !== "final") {
    return `stage 非法（未知枚举）: ${String(candidate.stage).slice(0, 24)}`;
  }
  // 【第十四轮第十一节】显式 proof class：缺失/未知枚举 → 拒绝（不再由
  // optional 身份字段存在性隐式猜测）。
  if (typeof candidate.proofLevel !== "string" || !TREASURY_RESOLUTION_PROOF_LEVELS.has(candidate.proofLevel)) {
    return `proofLevel 非法（须为显式枚举 identity-bound|lowlevel|legacy|forensic）: ${String(candidate.proofLevel).slice(0, 24)}`;
  }
  if (!isSafeInteger(candidate.actionTick) || candidate.actionTick < 0) return "actionTick 非安全整数";
  if (candidate.settledAtTick !== undefined && (!isSafeInteger(candidate.settledAtTick) || candidate.settledAtTick < 0)) {
    return "settledAtTick 非安全整数";
  }
  if (!isSafeInteger(candidate.observationTick) || candidate.observationTick < 0) return "observationTick 非安全整数";
  if (!isSafeInteger(candidate.resolvedAtTick) || candidate.resolvedAtTick < 0) return "resolvedAtTick 非安全整数";
  if (candidate.reconcilerKind !== undefined) {
    if (typeof candidate.reconcilerKind !== "string" || candidate.reconcilerKind.length === 0 || candidate.reconcilerKind.length > RESOLUTION_SOURCE_MAX) {
      return "reconcilerKind 非法（须为 1..128 字符）";
    }
  }
  if (candidate.source !== undefined) {
    if (typeof candidate.source !== "string" || candidate.source.length === 0 || candidate.source.length > RESOLUTION_SOURCE_MAX) {
      return "source 非法（须为 1..128 字符）";
    }
  }
  // attempt identity 绑定字段（存在须为 16 hex）。
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !RESOLUTION_DIGEST_PATTERN.test(value))) {
      return `${field} 非法（须为 16 小写 hex）`;
    }
  }
  // 【第十五轮第八节 v5】显式 forensic 管理 provenance（存在须形状完整）。
  if (candidate.forensicProvenance !== undefined) {
    const provenanceError = validateTreasuryForensicProvenanceShape(candidate.forensicProvenance);
    if (provenanceError !== null) {
      return provenanceError;
    }
  }
  // 【第十四轮第十一节】proof class required/forbidden 矩阵。
  const proofLevel = candidate.proofLevel;
  if (proofLevel === "identity-bound") {
    const missing = (["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const).filter(
      (field) => candidate[field] === undefined,
    );
    if (missing.length > 0) {
      return `identity-bound tombstone 缺少 required 身份字段: ${missing.join(",")}（不得降级 legacy——store unhealthy）`;
    }
  } else if (proofLevel === "lowlevel") {
    if (candidate.durableIdentityDigest === undefined) {
      return "lowlevel tombstone 缺少 durableIdentityDigest（低层 proof 必须绑定低层 durable identity）";
    }
    const forbidden = (["contractDigest", "authorizationCohortDigest"] as const).filter(
      (field) => candidate[field] !== undefined,
    );
    if (forbidden.length > 0) {
      return `lowlevel tombstone 禁止携带 modern 身份字段: ${forbidden.join(",")}`;
    }
  } else if (proofLevel === "legacy") {
    const forbidden = (["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const).filter(
      (field) => candidate[field] !== undefined,
    );
    if (forbidden.length > 0) {
      return `legacy tombstone 禁止携带部分现代身份字段: ${forbidden.join(",")}（legacy proof 不得隐式冒充 modern——显式 forensic 处理）`;
    }
  }
  // forensic：允许部分身份字段（与 forensic marker 绑定或明确不足），无矩阵。
  return null;
}

/**
 * 【第十四轮第十一节 11.4】v3（无 proofLevel）tombstone 的迁移定级：
 * - 全部三个身份字段完整 → identity-bound；
 * - 全部缺失 → legacy；
 * - 部分存在（任何组合）→ forensic（隔离——不得"尽力猜 modern"，也不得
 *   自动降级 legacy）。
 */
function migrateResolutionProofLevel(entry: {
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
}): TreasuryResolutionProofLevel {
  const present =
    (entry.contractDigest !== undefined ? 1 : 0) +
    (entry.authorizationCohortDigest !== undefined ? 1 : 0) +
    (entry.durableIdentityDigest !== undefined ? 1 : 0);
  if (present === 3) return "identity-bound";
  if (present === 0) return "legacy";
  return "forensic";
}

/** store 完整形状自检（load 与 v1 升级共用；一次全表扫描）。 */
function validateResolutionStoreShape(store: TreasuryResolutionStore): string | null {
  if (store.version !== TREASURY_RESOLUTION_VERSION) {
    return `未知 resolution store 版本 ${String(store.version)}`;
  }
  if (!store.entries || typeof store.entries !== "object") return "resolution entries 非对象";
  resolutionStoreEvents.fullScans += 1;
  const ownKeys = Object.keys(store.entries);
  resolutionStoreEvents.loadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  if (ownKeys.length > TREASURY_RESOLUTION_MAX_ENTRIES) {
    return `entries 超过上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)}（含 ${String(ownKeys.length)} 条）`;
  }
  for (const key of ownKeys) {
    if (!key.startsWith(RESOLUTION_KEY_PREFIX)) {
      return `存储键格式非法（须为 "r:"+transactionId）: ${key.slice(0, 48)}`;
    }
    const entry = (store.entries as Record<string, unknown>)[key];
    const shapeError = validateTreasuryResolutionTombstoneShape(entry);
    if (shapeError !== null) {
      return `${shapeError}（key ${key.slice(0, 48)}）`;
    }
    const typed = entry as TreasuryResolutionTombstone;
    if (RESOLUTION_KEY_PREFIX + typed.transactionId !== key) {
      return `存储键与 entry.transactionId 不一致: ${key.slice(0, 48)}`;
    }
  }
  return null;
}

function fatalRuntime(store: TreasuryResolutionStore, reason: string): ResolutionStoreRuntime {
  return { store, fatal: reason, inProgress: 0 };
}

/** resolving 计数（load 后缓存；轻量 probe / readiness O(1) 读取）。 */
function countResolvingEntries(store: TreasuryResolutionStore): number {
  let inProgress = 0;
  for (const entry of Object.values(store.entries)) {
    if (entry.stage === "resolving") inProgress += 1;
  }
  return inProgress;
}

/**
 * 加载（含校验与版本化迁移）：写路径专用。v1/v2/v3/v4 均为受支持的可迁移
 * 版本（与轻量 health probe 的受支持集合一致）；任何损坏 → fatal fail
 * closed（原数据不删、写入拒绝、恢复拒绝）。
 */
function loadResolutionStoreRuntime(): ResolutionStoreRuntime {
  if (heapRuntime) return heapRuntime;
  const raw = resolutionBranch().resolutions;
  if (!raw) {
    const created: TreasuryResolutionStore = { version: TREASURY_RESOLUTION_VERSION, entries: {}, entryCount: 0, updatedAt: Game.time };
    resolutionBranch().resolutions = created;
    heapRuntime = { store: created, fatal: null, inProgress: 0 };
    return heapRuntime;
  }
  if ((raw.version as number) === TREASURY_RESOLUTION_VERSION) {
    const candidate = raw as unknown as TreasuryResolutionStore;
    const shapeError = validateResolutionStoreShape(candidate);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(candidate, `${shapeError}（resolution store fail closed，原数据保留）`);
      return heapRuntime;
    }
    heapRuntime = { store: candidate, fatal: null, inProgress: countResolvingEntries(candidate) };
    return heapRuntime;
  }
  if (raw.version === 4) {
    // v4 → v5 无损升级（【第十五轮第八节】新增可选 forensic provenance 字段
    // ——既有 entry 无 provenance = migration-derived，语义不变）；损坏 → fatal。
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v4→v5 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, inProgress: countResolvingEntries(upgraded) };
    return heapRuntime;
  }
  if (raw.version === 3) {
    // v3 → v5 升级（【第十四轮第十一节】显式 proof class 定级，原子）：
    // 三身份字段全在 → identity-bound；全缺 → legacy；部分 → forensic 隔离
    //（不得"尽力猜 modern"）；升级后矩阵校验失败 → fatal（原数据保留）。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      entries[key] = {
        ...(value as TreasuryResolutionTombstone),
        proofLevel: migrateResolutionProofLevel(value as TreasuryResolutionTombstone),
      };
    }
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, entries, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v3→v5 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, inProgress: countResolvingEntries(upgraded) };
    return heapRuntime;
  }
  if (raw.version === 2) {
    // v2 → v5 无损升级（无身份字段 → legacy proof——不得证明现代 attempt）；
    // 损坏 → fatal。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      entries[key] = { ...(value as TreasuryResolutionTombstone), proofLevel: "legacy" };
    }
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, entries, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v2→v5 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, inProgress: countResolvingEntries(upgraded) };
    return heapRuntime;
  }
  if (raw.version === 1) {
    // v1 无损升级：全量验证 → 补 entryCount/stage=final/proofLevel=legacy → 原子替换。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    let entryCount = 0;
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries(raw.entries ?? {})) {
      const shapeError = validateTreasuryResolutionTombstoneShape({ ...(value as object), proofLevel: "legacy" });
      if (shapeError !== null) {
        heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v1 tombstone 损坏，人工处理；key ${key.slice(0, 48)}）`);
        return heapRuntime;
      }
      if (RESOLUTION_KEY_PREFIX + value.transactionId !== key) {
        heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `v1 存储键与 transactionId 不一致: ${key.slice(0, 48)}`);
        return heapRuntime;
      }
      entries[key] = { ...value, stage: "final", proofLevel: "legacy" };
      entryCount += 1;
    }
    const upgraded: TreasuryResolutionStore = { version: TREASURY_RESOLUTION_VERSION, entries, entryCount, updatedAt: Game.time };
    if (validateResolutionStoreShape(upgraded) !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, "v1→v5 升级自检失败（原数据保留）");
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, inProgress: countResolvingEntries(upgraded) };
    return heapRuntime;
  }
  heapRuntime = fatalRuntime(
    raw as unknown as TreasuryResolutionStore,
    `未知 resolution store 版本 ${String(raw.version)}（原数据保留，fail closed）`,
  );
  return heapRuntime;
}

export interface TreasuryResolutionStoreHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
  /** 当前 resolving（进行中）条数（gauge；heap 缓存——未 load 时为 0）。 */
  readonly inProgress: number;
  readonly entryCount: number;
}

/** 轻量 probe 的受支持版本集合（与 loader 一致——supported migration pending）。 */
const TREASURY_RESOLUTION_SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([TREASURY_RESOLUTION_VERSION, 4, 3, 2, 1]);

/**
 * 健康探测（只读零写；轻量——**未 load 时不全表扫描**，resolving 计数走
 * heap 缓存；entry 级损坏由 load 检出）。v1/v2/v3/v4 为受支持的可迁移版本
 * （healthy + migration pending），只有未知版本 fail closed。
 */
export function peekTreasuryResolutionStoreHealth(): TreasuryResolutionStoreHealth {
  if (heapRuntime) {
    return {
      healthy: heapRuntime.fatal === null,
      detail: heapRuntime.fatal,
      inProgress: heapRuntime.inProgress,
      entryCount: Object.keys(heapRuntime.store.entries ?? {}).length,
    };
  }
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions;
  if (raw === undefined) return { healthy: true, detail: null, inProgress: 0, entryCount: 0 };
  if (!TREASURY_RESOLUTION_SUPPORTED_VERSIONS.has(raw.version as number)) {
    return { healthy: false, detail: `未知 resolution store 版本 ${String(raw.version)}`, inProgress: 0, entryCount: 0 };
  }
  if (!raw.entries || typeof raw.entries !== "object") {
    return { healthy: false, detail: "resolution entries 非对象", inProgress: 0, entryCount: 0 };
  }
  // 未 load：不做全表扫描（inProgress 未知 → 0；write readiness 走
  // treasuryResolutionResolvingInProgress 触发完整 load 后读取缓存）。
  return { healthy: true, detail: null, inProgress: 0, entryCount: raw.entryCount ?? 0 };
}

/**
 * 【第十五轮第十节】write readiness 的 resolving blocker：store 存在时触发
 * 完整 load/migration（首次有界全表扫描、heap 缓存后 O(1)）后读取缓存
 * resolving 计数；store 不存在时零写返回 false（查询路径不隐式创建 store）。
 */
export function treasuryResolutionResolvingInProgress(): boolean {
  if ((Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions === undefined) {
    return false;
  }
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) return true; // store 损坏 → fail closed 阻断
  return runtime.inProgress > 0;
}

/** 显式触发 load 验证（写路径）：返回 fatal 描述（null = 可用）。 */
export function ensureTreasuryResolutionStoreValidated(): string | null {
  const runtime = loadResolutionStoreRuntime();
  return runtime.fatal;
}

// ── 读写 ────────────────────────────────────────────────────────────────────

/** 只读读取单条（有界深冻结快照——嵌套 forensic provenance 同样封闭；不触发创建）。 */
export function readTreasuryResolutionTombstone(transactionId: string): Readonly<TreasuryResolutionTombstone> | undefined {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions;
  if (!raw || !raw.entries || typeof raw.entries !== "object") return undefined;
  const entry = raw.entries[RESOLUTION_KEY_PREFIX + transactionId];
  return entry === undefined ? undefined : (treasuryBoundedDeepFreezeSnapshot(entry) as Readonly<TreasuryResolutionTombstone>);
}

/** 零写探测：持久 resolution store 是否存在（不触发 load/迁移/创建）。 */
export function peekTreasuryResolutionStoreEntry(): { readonly version?: number } | undefined {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions;
  return raw === undefined ? undefined : { version: raw.version as number | undefined };
}

/**
 * 容量预检（staged 流程第一步——在任何原状态变化之前执行）：已满且无可
 * 清理过期项 → 拒绝（fail closed）。返回 null = 可写。
 */
export function ensureTreasuryResolutionSlotAvailable(): string | null {
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) return runtime.fatal;
  const key = RESOLUTION_KEY_PREFIX; // 通用预检（不含具体 id 时按新条目判断）
  void key;
  if (runtime.store.entryCount < TREASURY_RESOLUTION_MAX_ENTRIES) return null;
  // 满载：尝试惰性清理过期项后重判。
  evictExpiredTombstones(runtime.store);
  if (runtime.store.entryCount < TREASURY_RESOLUTION_MAX_ENTRIES) return null;
  return `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`;
}

/** 惰性清理：只删除 stage=final 且超过 retention 的形状完整条目（第九轮
 *  4.10：stage=resolving 永不被普通垃圾回收驱逐——resolution-intent 丢弃
 *  不可接受，满载 fail closed 由容量预检承担）。 */
function evictExpiredTombstones(store: TreasuryResolutionStore): number {
  let removed = 0;
  resolutionStoreEvents.fullScans += 1;
  for (const [key, entry] of Object.entries(store.entries)) {
    if (validateTreasuryResolutionTombstoneShape(entry) !== null) continue; // 损坏不删除
    if (entry.stage === "resolving") continue; // resolving 永不驱逐（第九轮 4.10）
    if (entry.resolvedAtTick < Game.time - TREASURY_RESOLUTION_RETENTION_TICKS) {
      delete store.entries[key];
      store.entryCount -= 1;
      removed += 1;
    }
  }
  if (removed > 0) store.updatedAt = Game.time;
  return removed;
}

export type TreasuryResolutionTombstoneWriteResult =
  | { readonly status: "written" }
  | { readonly status: "updated" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * 写入/更新 tombstone（形状校验 + 容量约束 + 惰性清理）。【第十五轮第六节】
 * 全部写入经 resolutionStateMachine 不可逆状态机判定：
 * - absent 只能创建 resolving committed / final not-executed；
 * - resolving committed 只能 finalize 为 final committed（全部安全关键字段
 *   保持，仅 stage 与 resolvedAtTick 单调推进）；
 * - final（与 resolving 的幂等重复写）只允许全部安全关键字段完全一致的
 *   exact idempotent 重复写（非覆盖写）；
 * - 其余一切转换拒绝且原 tombstone 完全不变。
 */
export function writeTreasuryResolutionTombstone(entry: TreasuryResolutionTombstone): TreasuryResolutionTombstoneWriteResult {
  const shapeError = validateTreasuryResolutionTombstoneShape(entry);
  if (shapeError !== null) {
    return { status: "rejected", detail: `拒绝写入非法 tombstone: ${shapeError}` };
  }
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) {
    return { status: "rejected", detail: runtime.fatal };
  }
  const key = RESOLUTION_KEY_PREFIX + entry.transactionId;
  const existing = Object.prototype.hasOwnProperty.call(runtime.store.entries, key)
    ? runtime.store.entries[key]
    : undefined;
  const transition = validateTreasuryResolutionTombstoneTransition(existing, entry);
  if (transition.status === "rejected") {
    return { status: "rejected", detail: `同 id resolution tombstone 状态机拒绝: ${transition.detail}` };
  }
  if (transition.status === "idempotent") {
    return { status: "idempotent" };
  }
  if (existing === undefined && runtime.store.entryCount >= TREASURY_RESOLUTION_MAX_ENTRIES) {
    evictExpiredTombstones(runtime.store);
    if (runtime.store.entryCount >= TREASURY_RESOLUTION_MAX_ENTRIES) {
      return {
        status: "rejected",
        detail: `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`,
      };
    }
  }
  runtime.store.entries[key] = { ...entry };
  runtime.store.updatedAt = Game.time;
  if (transition.status === "allowed_create") {
    runtime.store.entryCount += 1;
    if (entry.stage === "resolving") runtime.inProgress += 1;
    return { status: "written" };
  }
  // allowed_finalize：resolving committed → final committed。
  runtime.inProgress = Math.max(0, runtime.inProgress - 1);
  return { status: "updated" };
}

/**
 * 删除单条（staged 回滚专用：resolving 无进展时）。【第十五轮第六节】只
 * 允许删除 stage=resolving 的进行中 tombstone——final 终态不可删除（retention
 * 清理走独立的 evictExpiredTombstones 通道）。
 */
export function deleteTreasuryResolutionTombstone(transactionId: string): boolean {
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) return false;
  const key = RESOLUTION_KEY_PREFIX + transactionId;
  if (!Object.prototype.hasOwnProperty.call(runtime.store.entries, key)) return false;
  const existing = runtime.store.entries[key];
  if (existing.stage !== "resolving") {
    resolutionStoreEvents.faulted += 1;
    return false;
  }
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.inProgress = Math.max(0, runtime.inProgress - 1);
  runtime.store.updatedAt = Game.time;
  return true;
}

// ── 统一 replay horizon（prepare 幂等与 receipt 同一规则） ─────────────────

/**
 * committed resolution tombstone 的防重放窗口查询：resolution=committed 且
 * settledAtTick + retention ≥ Game.time 时返回 settledAtTick（prepare 须将其
 * 视为已结算——receipt 过期但 committed tombstone 仍在窗口内时不得当全新
 * 动作）；不在窗口或非 committed 返回 undefined。与 receipt 使用同一
 * retention 常量（统一 replay horizon）。
 */
export function committedResolutionSettledAtTick(transactionId: string): number | undefined {
  const tombstone = readTreasuryResolutionTombstone(transactionId);
  if (tombstone === undefined || tombstone.resolution !== "committed") return undefined;
  if (tombstone.settledAtTick === undefined) return undefined;
  if (tombstone.settledAtTick < Game.time - TREASURY_RECEIPT_RETENTION_TICKS) return undefined;
  return tombstone.settledAtTick;
}

// ── staged 恢复（beginTick 显式分支调用；幂等） ────────────────────────────

export interface TreasuryResolutionRecoveryReport {
  /** resolving-committed 且 receipt 已刷新至 settledAtTick → 完成 finalize 的条数。 */
  completed: number;
  /** resolving 无进展且不可恢复（防御分支）→ 回滚删除 tombstone 的条数。 */
  rolledBack: number;
  /** final not-executed 但 authority 仍存在 → 补完成释放的条数。 */
  completedRelease: number;
  /** receipt 不可写：resolving 保留（刷新未完成，绝不 finalize——第九轮 4.9）。 */
  refreshBlocked: number;
  /** 【第十三轮】identity conflict 保留 authority 的条数（独立诊断/计数）。 */
  identityConflicts: number;
  /** 【第十三轮】legacy/insufficient proof 保留 authority 的条数（独立诊断/计数）。 */
  identityInsufficient: number;
  /** 【第十五轮第五节】双 authority inconsistent 零释放保留的条数（独立计数）。 */
  authorityInconsistent: number;
  storeFatal: string | null;
}

/**
 * staged resolution 恢复（global reset / 中断后；幂等）。【第十五轮第五/十三节】
 * authority 读取统一经 resolveTreasuryUnresolvedAuthority（`quarantine ??
 * intent` 旁路删除）；committed 三方 proof 验证统一经
 * verifyTreasuryCommittedResolutionProof（与 immediate resolve-as-committed
 * 复用同一 verifier）：
 *
 *   unified unresolved authority ──┐
 *   resolution tombstone           ├── 三方严格 match 才能释放 authority
 *   settlement receipt proof ──────┘
 *
 * - **authority inconsistent**：intent / quarantine / tombstone / marker 全
 *   保留，authorityInconsistent 独立计数，write readiness 保持阻断，零
 *   release、零 receipt refresh、零 stage 变化（不任选其一）；
 * - **authority not_found**（前一阶段已释放、finalize 前中断）：committed
 *   仍须 receipt ↔ tombstone identity match 且 tick 足够才补完成 finalize
 *   （不伪造新 authority）；final not-executed 视为释放已完成（跳过）；
 * - **receipt 时间证明**：receipt.settledAtTick ≥ tombstone.settledAtTick
 *   （tick 足够 ≠ receipt 属于当前 attempt——两个独立条件）；
 * - **receipt ↔ tombstone identity**：无论 tick 是否足够都读取完整 receipt
 *   proof 并按 tombstone 完整 attempt identity 验证（旧 attempt 的 proof /
 *   legacy proof 均 fail closed）；
 * - **proof level 自动释放矩阵**（普通自动 recovery）：只允许
 *   identity-bound → modern 与 lowlevel → lowlevel；legacy / forensic 不自动
 *   释放（forensic 无显式 provenance 永久隔离——【第十五轮第八节】）；
 * - receipt 不存在或 tick 不足：identity-aware refresh（携带 tombstone 完整
 *   attempt identity）→ 成功后**重新读取持久 proof** 再执行完整验证——不得
 *   仅凭 refresh 返回 written/refreshed 释放 authority；
 * - 全部成立才：释放 quarantine + intent、清除匹配 marker、经状态机校验后
 *   finalize（stage=final）；read-back mismatch 保留 resolving tombstone 与
 *   全部 authority；
 * - stage=resolving 但无 settledAtTick / 非 committed（防御）→ 回滚删除
 *   tombstone（原状态未变，resolution 可重试）；
 * - store fatal：不删任何数据，报告诊断（resolution 路径拒绝）。
 */

/** authority entry → attempt identity 视图（final not-executed 补完成比较）。 */
function attemptIdentityOf(authority: {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
}): TreasuryAttemptIdentity {
  return {
    digest: authority.digest,
    ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
    ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
    ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
  };
}

export function recoverStagedResolutions(): TreasuryResolutionRecoveryReport {
  const report: TreasuryResolutionRecoveryReport = {
    completed: 0,
    rolledBack: 0,
    completedRelease: 0,
    refreshBlocked: 0,
    identityConflicts: 0,
    identityInsufficient: 0,
    authorityInconsistent: 0,
    storeFatal: null,
  };
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) {
    report.storeFatal = runtime.fatal;
    resolutionStoreEvents.faulted += 1;
    return report;
  }
  resolutionStoreEvents.fullScans += 1;
  for (const [key, entry] of Object.entries(runtime.store.entries)) {
    if (entry.stage === "resolving") {
      resolutionStoreEvents.inProgressRecoveries += 1;
      if (entry.resolution === "committed" && entry.settledAtTick !== undefined) {
        // ── 第 1 步：读取完整 receipt proof（tick 足够与否都读——identity
        //    校验不以 tick 充分为由跳过）。
        let receiptProof = readTreasurySettlementProof(entry.transactionId);
        if (receiptProof === undefined || receiptProof.settledAtTick < entry.settledAtTick) {
          // receipt 未刷新到位（旧 action tick 的 receipt 或不存在）：幂等
          // 续做 identity-aware refresh 至原定 settledAtTick——绝不缩短
          // replay horizon。blocked（legacy/冲突/证明不足）与 fatal 同样
          // 保留 resolving + authority（fail closed）。
          const refresh = refreshSettledReceiptForResolution(entry.transactionId, entry.settledAtTick, {
            digest: entry.digest,
            ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
            ...(entry.authorizationCohortDigest !== undefined
              ? { authorizationCohortDigest: entry.authorizationCohortDigest }
              : {}),
            ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          });
          if (refresh.status === "fatal" || refresh.status === "blocked") {
            resolutionStoreEvents.faulted += 1;
            report.refreshBlocked += 1;
            if (refresh.status === "blocked" && refresh.reason === "identity_conflict") {
              report.identityConflicts += 1;
              resolutionStoreEvents.identityConflicts += 1;
            } else if (refresh.status === "blocked") {
              report.identityInsufficient += 1;
              resolutionStoreEvents.identityInsufficientBlockers += 1;
            }
            continue;
          }
          // refresh 成功：重新读取持久 proof（不信任 refresh 返回值本身）。
          receiptProof = readTreasurySettlementProof(entry.transactionId);
        }
        // ── 第 2 步：【第十五轮第五节】统一 unresolved authority resolver
        //    （不再 quarantine ?? intent——双 authority 不一致在此拦截）+
        //    共用三方 verifier（receipt 时间证明、modern level、receipt ↔
        //    tombstone、proof level 自动释放矩阵、tombstone/receipt ↔
        //    authority 全部由此承载）。
        const authorityResolution = resolveTreasuryUnresolvedAuthority(entry.transactionId);
        const verdict = verifyTreasuryCommittedResolutionProof({
          tombstone: entry,
          authorityResolution,
          receiptProof,
        });
        if (verdict.status !== "verified") {
          resolutionStoreEvents.faulted += 1;
          if (verdict.status === "authority_inconsistent") {
            report.authorityInconsistent += 1;
            resolutionStoreEvents.authorityInconsistentBlockers += 1;
          } else if (verdict.status === "conflict") {
            report.identityConflicts += 1;
            resolutionStoreEvents.identityConflicts += 1;
          } else if (verdict.status === "receipt_absent" || verdict.status === "receipt_stale") {
            report.refreshBlocked += 1;
          } else {
            report.identityInsufficient += 1;
            resolutionStoreEvents.identityInsufficientBlockers += 1;
          }
          continue;
        }
        // ── 第 3 步：三方 match（或 authority 已释放且 receipt ↔ tombstone
        //    match）→ 释放 + finalize（幂等——authority 释放与 marker 清除
        //    均为幂等操作；finalize 经状态机校验）。
        releaseTreasuryQuarantineEntry(entry.transactionId);
        releaseTreasuryIntentEntry(entry.transactionId);
        clearTreasuryWriteFaultMarkerForResolution(entry.transactionId, entry.digest);
        const finalEntry: TreasuryResolutionTombstone = { ...entry, stage: "final" };
        const transition = validateTreasuryResolutionTombstoneTransition(entry, finalEntry);
        if (transition.status !== "allowed_finalize") {
          // 防御：resolving entry 自身形态与 finalize 目标矛盾（不应发生——
          // load 已校验形状）：保留原状态，计数阻断。
          resolutionStoreEvents.faulted += 1;
          report.identityInsufficient += 1;
          resolutionStoreEvents.identityInsufficientBlockers += 1;
          continue;
        }
        runtime.store.entries[key] = finalEntry;
        runtime.inProgress = Math.max(0, runtime.inProgress - 1);
        runtime.store.updatedAt = Game.time;
        resolutionStoreEvents.recovered += 1;
        report.completed += 1;
      } else {
        // 防御分支：resolving 无 settledAtTick 或非 committed——回滚
        // tombstone（原状态未变，resolution 可重试）。
        delete runtime.store.entries[key];
        runtime.store.entryCount -= 1;
        runtime.inProgress = Math.max(0, runtime.inProgress - 1);
        resolutionStoreEvents.faulted += 1;
        report.rolledBack += 1;
      }
      continue;
    }
    if (entry.stage === "final" && entry.resolution === "not-executed") {
      // 【第十五轮第五节】补完成释放同样统一经 resolver：inconsistent → 零
      // 释放全保留；not_found → 释放已完成（跳过）。
      const authorityResolution = resolveTreasuryUnresolvedAuthority(entry.transactionId);
      if (authorityResolution.status === "not_found") continue;
      if (authorityResolution.status === "inconsistent") {
        resolutionStoreEvents.faulted += 1;
        report.authorityInconsistent += 1;
        resolutionStoreEvents.authorityInconsistentBlockers += 1;
        continue;
      }
      const authority = authorityResolution.authority;
      // 【第十五轮第八节】proof level 自动释放矩阵：legacy / forensic 不自动
      // 释放（普通自动 recovery 只允许 identity-bound → modern、lowlevel →
      // lowlevel——forensic 无显式 provenance 永久隔离）。
      if (!treasuryProofLevelAutoReleasesAuthorityLevel(entry.proofLevel, authority.authorityLevel)) {
        resolutionStoreEvents.faulted += 1;
        report.identityInsufficient += 1;
        resolutionStoreEvents.identityInsufficientBlockers += 1;
        continue;
      }
      const relation = treasuryAttemptIdentityRelation(entry, attemptIdentityOf(authority));
      if (relation !== "match") {
        resolutionStoreEvents.faulted += 1;
        if (relation === "conflict") {
          report.identityConflicts += 1;
          resolutionStoreEvents.identityConflicts += 1;
        } else {
          report.identityInsufficient += 1;
          resolutionStoreEvents.identityInsufficientBlockers += 1;
        }
        continue;
      }
      // final tombstone 已写但释放未完成：补完成（幂等——resolver 判 ok 时
      // quarantine 与 intent 身份一致，一并释放安全）。
      releaseTreasuryQuarantineEntry(entry.transactionId);
      releaseTreasuryIntentEntry(entry.transactionId);
      clearTreasuryWriteFaultMarkerForResolution(entry.transactionId, entry.digest);
      resolutionStoreEvents.recovered += 1;
      report.completedRelease += 1;
    }
  }
  return report;
}
