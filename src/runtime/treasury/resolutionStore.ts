/**
 * Treasury resolution tombstone store（第八轮建立 staged 状态；第十五轮升级
 * version 5 + 不可逆状态机 + 统一 authority resolver；【第十六轮】升级
 * version 6：lowlevel provenance 绑定 + 持久状态语义矩阵 + pending 恢复
 * O(1) 索引 + final not-executed 残留 marker 安全补完成）。
 *
 * 角色：显式 fault resolution 的有界幂等记录与 staged 状态机载体。独立成
 * 模块（而非内嵌 faultResolution.ts）的原因：facade 需要（a）统一 replay
 * horizon 的 committed tombstone 只读查询（prepare 幂等）、（b）beginTick
 * 的 staged resolution 恢复与（c）capability 签发的 resolving 互斥门禁——
 * 生产代码不得 import faultResolution（架构边界测试守护），本模块只承载
 * store 级语义供两侧共享。
 *
 * 健康契约（与 receipt/quarantine/intent 同款）：
 * - version 6：version/entryCount 元数据 + key="r:"+transactionId + entry
 *   完整形状校验（resolution/stage 枚举、digest 16hex、安全整数、有界
 *   string、forensic provenance 形状、lowlevel provenance 受控枚举）+
 *   **持久状态语义矩阵**（resolutionStateSemantics——stage × resolution ×
 *   proofLevel × provenance × tick 的内在状态合法性）+ 容量上限 256（满时
 *   在**任何原状态变化之前**拒绝）+ 未知版本 fail closed（原数据保留）+
 *   global reset 首次 load 全量验证 + heap cache（含 resolving / pending-
 *   release 索引——轻量 probe 不再全表扫描）；
 * - v1/v2/v3/v4/v5：受支持的可迁移版本（loader 支持集合与轻量 health probe
 *   一致——supported migration pending，不误报 unknown fatal）；迁移原子
 *   替换、幂等；v2-v4 无 stage 的历史 entry 迁移补终态 stage=final；损坏
 *   （含语义非法持久状态）fatal（malformed 旧 tombstone 绝不当可清理垃圾
 *   删除——人工处理）；
 * - 惰性清理只删除 resolvedAtTick 超过 retention（5000）的完整验证条目；
 *   损坏条目不删除；stage=resolving 永不驱逐；
 * - 【第十六轮第九节】语义非法持久状态（resolving not-executed、final
 *   committed 缺 settledAtTick、provenance/proof 矛盾等）→ store unhealthy
 *   ——recovery 不再自动删除（删除非法持久状态不是 repair）。
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
 *
 * 【第十六轮第八节】resolver store_unhealthy → 零副作用（不 refresh receipt、
 * 不释放 authority、不清 marker、不 finalize、不回滚）。
 *
 * 【第十六轮第十三节】heap 运行态索引（resolving transaction IDs + final
 * not-executed pending-release IDs）：Memory tombstone 仍是权威；索引仅用于
 * 定位待处理项（beginTick 无待处理项时 O(1) 直接返回，不扫描历史 final
 * proof）；global reset 首次 load 重建（一次有界全表扫描）；索引缺失/损坏
 * 不得导致 authority 被错误释放。
 */

import { isValidTreasuryTransactionId, isTreasuryRearmAttemptId } from "@/runtime/treasury/transactionId";
import {
  TREASURY_RECEIPT_RETENTION_TICKS,
  readTreasurySettlementProof,
  refreshSettledReceiptForResolution,
  registerTreasuryResolutionResetHook,
} from "@/runtime/treasury/receipts";
import {
  readTreasuryWriteFault,
  TREASURY_EXECUTION_UNKNOWN_PHASES,
} from "@/runtime/treasury/writeFault";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
  treasuryMarkerDischargeExpectedOfFacts,
} from "@/runtime/treasury/markerDischarge";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  completeTreasuryResolutionCleanup,
  readTreasuryResolutionCleanupEntry,
  treasuryResolutionCleanupOpenInputOfFacts,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { treasuryMarkerExactIdentityRelation } from "@/runtime/treasury/markerExactIdentity";
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
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { validateTreasuryResolutionTombstoneState } from "@/runtime/treasury/resolutionStateSemantics";
import { validateTreasuryLowlevelSourceField } from "@/runtime/treasury/authorityLevel";
import { classAwareIdentityOfAttempt } from "@/runtime/treasury/markerAttemptIdentity";
import { treasuryExactAttemptIdentityOfTombstone, treasuryExactAttemptIdentityOfAuthority, treasuryExactAttemptIdentityRelation, type TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";

/**
 * 【第十六轮第十一节】resolution tombstone v6（lowlevel proof 绑定显式
 * provenance——runtime 与 migrated 来源不能互相证明）。
 */
export const TREASURY_RESOLUTION_VERSION = 7 as const;
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
  /**
   * 【第十六轮第十一节 v6】lowlevel proof 的显式 provenance（受控枚举
   * runtime-lowlevel@v1|migrated-lowlevel@v1——attempt identity 的组成
   * 部分：runtime 与 migrated 来源不能互相证明；v5 及更早的低层 tombstone
   * 无此字段 = 来源不可证明的隔离态，不得自动释放当前 lowlevel authority，
   * 也不得猜测为 runtime 来源）。只允许 proofLevel=lowlevel 携带。
   */
  readonly lowlevelSource?: string;
  /**
   * 【第十八轮 24.4 v7】tr1_ rearm attempt 的 lineage proof（intent/
   * quarantine 同源携带）：not-executed final tombstone 的 per-generation
   * replacement verdict 完整比较 binding（lineageId/generation/parent 随
   * store 版本升级补齐）。tr1_ tombstone 缺 proof → 不释放当前 rearm
   * authority（旧 proof 只作 replay blocker）。
   */
  readonly lineageBindingDigest?: string;
  /** 【第十八轮 24.4 v7】tr1_ not-executed tombstone 的完整 lineage proof
   *  （verdict 的 binding/generation 比较；tr1_ 新写必填）。 */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
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
  version: 7;
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
  /**
   * 【第十六轮第十三节】pending 恢复 O(1) 索引（heap 运行态；Memory 才是
   * 权威）：resolving transaction IDs 与 final not-executed pending-release
   * IDs——beginTick 无待处理项时 O(1) 直接返回，有待处理项时只遍历索引
   * 中的 ID，不扫描全部历史 final proof。global reset 首次 load 一次有界
   * 全表扫描重建；索引只用于定位待处理项，不得作为安全 proof。
   */
  resolvingIds: Set<string>;
  pendingReleaseIds: Set<string>;
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
  /** 【第十六轮第八节】store_unhealthy 零副作用阻断计数（resolver 与 marker 补完成）。 */
  storeUnhealthyBlockers: 0,
  /** 【第十六轮第七节】final not-executed 残留 marker 无法安全清除的独立计数。 */
  markerCleanupBlockers: 0,
  /** 【第十六轮第十三节】beginTick O(1) 空闲快路径命中计数。 */
  idleFastPaths: 0,
  /** 【第十七轮第十三节】final not-executed 因 lineage replacement 未完整而被 pin 的计数。 */
  retentionPins: 0,
};

export interface TreasuryResolutionStoreCounters {
  readonly fullScans: number;
  readonly loadValidationEntries: number;
  readonly recovered: number;
  readonly faulted: number;
  readonly identityConflicts: number;
  readonly identityInsufficientBlockers: number;
  readonly authorityInconsistentBlockers: number;
  readonly storeUnhealthyBlockers: number;
  readonly markerCleanupBlockers: number;
  readonly idleFastPaths: number;
}

export function readTreasuryResolutionStoreCounters(): TreasuryResolutionStoreCounters {
  const { fullScans, loadValidationEntries, recovered, faulted, identityConflicts, identityInsufficientBlockers, authorityInconsistentBlockers, storeUnhealthyBlockers, markerCleanupBlockers, idleFastPaths } = resolutionStoreEvents;
  return { fullScans, loadValidationEntries, recovered, faulted, identityConflicts, identityInsufficientBlockers, authorityInconsistentBlockers, storeUnhealthyBlockers, markerCleanupBlockers, idleFastPaths };
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
  resolutionStoreEvents.storeUnhealthyBlockers = 0;
  resolutionStoreEvents.markerCleanupBlockers = 0;
  resolutionStoreEvents.idleFastPaths = 0;
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
  // 【第十六轮第十一节 v6】lowlevel provenance：存在须为受控枚举，且只允许
  // proofLevel=lowlevel 携带（modern/legacy/forensic proof 不携带低层来源）。
  if (candidate.lowlevelSource !== undefined) {
    const sourceError = validateTreasuryLowlevelSourceField(candidate.lowlevelSource);
    if (sourceError !== null) {
      return sourceError;
    }
    if (candidate.proofLevel !== "lowlevel") {
      return `lowlevelSource 只允许 lowlevel proof 携带（当前 ${String(candidate.proofLevel)}）`;
    }
  }
  // 【第十九轮 A.3】lineage proof 整体性（v7 字段矩阵）：四字段整体存在或
  // 整体缺失；携带时形状完整；非 tr1_ tombstone 禁止携带（initial attempt
  // 不得被 lineage proof 证明——load 上下文同样适用，v6 迁移不产生该形态）。
  {
    const lineageFieldNames = ["lineageId", "lineageGeneration", "parentTransactionId", "lineageBindingDigest"] as const;
    const present = lineageFieldNames.filter((field) => candidate[field] !== undefined);
    if (present.length !== 0 && present.length !== lineageFieldNames.length) {
      return `lineage proof 必须整体存在或整体缺失（部分携带: ${present.join(",")}——形状损坏）`;
    }
    if (present.length === lineageFieldNames.length) {
      if (typeof candidate.lineageId !== "string" || !RESOLUTION_DIGEST_PATTERN.test(candidate.lineageId)) {
        return "lineageId 非法（须 16 小写 hex）";
      }
      if (typeof candidate.lineageGeneration !== "number" || !Number.isSafeInteger(candidate.lineageGeneration) || candidate.lineageGeneration < 1) {
        return "lineageGeneration 非安全正整数";
      }
      if (typeof candidate.parentTransactionId !== "string" || candidate.parentTransactionId.length === 0 || candidate.parentTransactionId.length > 128) {
        return "parentTransactionId 非法（1..128 字符）";
      }
      if (typeof candidate.lineageBindingDigest !== "string" || !RESOLUTION_DIGEST_PATTERN.test(candidate.lineageBindingDigest)) {
        return "lineageBindingDigest 非法（须 16 小写 hex）";
      }
      if (typeof candidate.transactionId === "string" && !isTreasuryRearmAttemptId(candidate.transactionId)) {
        return "非 tr1_ tombstone 不得携带 lineage proof（initial attempt 专属禁带）";
      }
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
    // 【第十六轮第九节】持久状态语义矩阵：形状合法但内在状态非法
    // （resolving not-executed / final committed 缺 settledAtTick /
    // provenance 与 proof 矛盾等）→ store unhealthy（不删除 entry）。
    const stateError = validateTreasuryResolutionTombstoneState(typed, "load");
    if (stateError !== null) {
      return `${stateError}（key ${key.slice(0, 48)}）`;
    }
  }
  return null;
}

function fatalRuntime(store: TreasuryResolutionStore, reason: string): ResolutionStoreRuntime {
  return { store, fatal: reason, resolvingIds: new Set<string>(), pendingReleaseIds: new Set<string>() };
}

/**
 * 【第十六轮第十三节】load 后构建 pending 恢复索引（一次有界全表扫描）：
 * resolving transaction IDs 与 final not-executed pending-release IDs。
 */
function buildRecoveryIndexes(store: TreasuryResolutionStore): { resolvingIds: Set<string>; pendingReleaseIds: Set<string> } {
  const resolvingIds = new Set<string>();
  const pendingReleaseIds = new Set<string>();
  for (const entry of Object.values(store.entries)) {
    if (entry.stage === "resolving") {
      resolvingIds.add(entry.transactionId);
    } else if (entry.stage === "final" && entry.resolution === "not-executed") {
      pendingReleaseIds.add(entry.transactionId);
    }
  }
  return { resolvingIds, pendingReleaseIds };
}

/**
 * 加载（含校验与版本化迁移）：写路径专用。v1/v2/v3/v4/v5 均为受支持的可
 * 迁移版本（与轻量 health probe 的受支持集合一致）；任何损坏（含语义非法
 * 持久状态）→ fatal fail closed（原数据不删、写入拒绝、恢复拒绝）。
 */
function loadResolutionStoreRuntime(): ResolutionStoreRuntime {
  if (heapRuntime) return heapRuntime;
  const raw = resolutionBranch().resolutions;
  if (!raw) {
    const created: TreasuryResolutionStore = { version: TREASURY_RESOLUTION_VERSION, entries: {}, entryCount: 0, updatedAt: Game.time };
    resolutionBranch().resolutions = created;
    heapRuntime = { store: created, fatal: null, resolvingIds: new Set<string>(), pendingReleaseIds: new Set<string>() };
    return heapRuntime;
  }
  if ((raw.version as number) === TREASURY_RESOLUTION_VERSION) {
    const candidate = raw as unknown as TreasuryResolutionStore;
    const shapeError = validateResolutionStoreShape(candidate);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(candidate, `${shapeError}（resolution store fail closed，原数据保留）`);
      return heapRuntime;
    }
    heapRuntime = { store: candidate, fatal: null, ...buildRecoveryIndexes(candidate) };
    return heapRuntime;
  }
  if ((raw.version as number) === TREASURY_RESOLUTION_VERSION - 1) {
    // 【第十八轮 24.4】v6 → v7 迁移：tr1_ tombstone 的 lineage proof 补全
    //（可从 lineage record 安全补全——current 命中 + binding 一致 → 原子补全；
    // 不可证明 → 原 entry 无损保留（binding 缺失 → verdict 永久 pin、
    // preflight 阻断——不释放当前 rearm authority，不猜测））。结构 passthrough
    // + 全量重验证。
    const upgradedV6: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, updatedAt: Game.time };
    const shapeErrorV6 = validateResolutionStoreShape(upgradedV6);
    if (shapeErrorV6 !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeErrorV6}（v6→v7 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgradedV6;
    heapRuntime = { store: upgradedV6, fatal: null, ...buildRecoveryIndexes(upgradedV6) };
    return heapRuntime;
  }
  if (raw.version === 5) {
    // v5 → v6 无损升级（【第十六轮第十一节】新增可选 lowlevelSource 字段
    // ——既有 lowlevel entry 无 provenance = 来源不可证明的隔离态，语义不变，
    // 不猜测 runtime 来源）；损坏 → fatal。
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v5→v6 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, ...buildRecoveryIndexes(upgraded) };
    return heapRuntime;
  }
  if (raw.version === 4) {
    // v4 → v6 无损升级（v5 forensic provenance / v6 lowlevelSource 均为可选
    // 新字段——既有 entry 无新字段 = 隔离/迁移语义不变）；历史无 stage 的
    // entry 补终态 stage=final；损坏 → fatal。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, TreasuryResolutionTombstone> }).entries ?? {})) {
      entries[key] = { ...value, ...(value.stage === undefined ? { stage: "final" as const } : {}) };
    }
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, entries, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v4→v6 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, ...buildRecoveryIndexes(upgraded) };
    return heapRuntime;
  }
  if (raw.version === 3) {
    // v3 → v6 升级（【第十四轮第十一节】显式 proof class 定级，原子）：
    // 三身份字段全在 → identity-bound；全缺 → legacy；部分 → forensic 隔离
    //（不得"尽力猜 modern"）；历史无 stage 的 entry 补终态 stage=final；
    // 升级后矩阵校验失败 → fatal（原数据保留）。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      entries[key] = {
        ...(value as TreasuryResolutionTombstone),
        proofLevel: migrateResolutionProofLevel(value as TreasuryResolutionTombstone),
        ...((value as TreasuryResolutionTombstone).stage === undefined ? { stage: "final" as const } : {}),
      };
    }
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, entries, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v3→v6 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, ...buildRecoveryIndexes(upgraded) };
    return heapRuntime;
  }
  if (raw.version === 2) {
    // v2 → v6 无损升级（无身份字段 → legacy proof——不得证明现代 attempt；
    // 历史无 stage 的 entry 补终态 stage=final）；损坏 → fatal。
    const entries: Record<string, TreasuryResolutionTombstone> = {};
    resolutionStoreEvents.fullScans += 1;
    for (const [key, value] of Object.entries((raw as { entries?: Record<string, unknown> }).entries ?? {})) {
      entries[key] = { ...(value as TreasuryResolutionTombstone), proofLevel: "legacy", stage: "final" };
    }
    const upgraded: TreasuryResolutionStore = { ...(raw as unknown as TreasuryResolutionStore), version: TREASURY_RESOLUTION_VERSION, entries, updatedAt: Game.time };
    const shapeError = validateResolutionStoreShape(upgraded);
    if (shapeError !== null) {
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, `${shapeError}（v2→v6 升级校验失败，原数据保留）`);
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, ...buildRecoveryIndexes(upgraded) };
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
      heapRuntime = fatalRuntime(raw as unknown as TreasuryResolutionStore, "v1→v6 升级自检失败（原数据保留）");
      return heapRuntime;
    }
    resolutionBranch().resolutions = upgraded;
    heapRuntime = { store: upgraded, fatal: null, ...buildRecoveryIndexes(upgraded) };
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

/** 轻量 probe 的受支持版本集合（与 loader 一致——supported migration pending）。
 * 【第十九轮 F】v6 = loader 的 v6→v7 迁移分支（第十八轮新增时漏加入本
 * 集合——部署环境仍为 v6 的 store 是 migration pending 而非 unknown fatal）。 */
const TREASURY_RESOLUTION_SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([TREASURY_RESOLUTION_VERSION, 6, 5, 4, 3, 2, 1]);

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
      inProgress: heapRuntime.resolvingIds.size,
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
  return runtime.resolvingIds.size > 0;
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
  if (runtime.store.entryCount < TREASURY_RESOLUTION_MAX_ENTRIES) return null;
  // 满载：尝试惰性清理过期项后重判。
  evictExpiredTombstones(runtime.store, runtime);
  if (runtime.store.entryCount < TREASURY_RESOLUTION_MAX_ENTRIES) return null;
  return `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`;
}

/** 惰性清理：只删除 stage=final 且超过 retention 的形状完整条目（第九轮
 *  4.10：stage=resolving 永不被普通垃圾回收驱逐——resolution-intent 丢弃
 *  不可接受，满载 fail closed 由容量预检承担）。【第十六轮第十三节】同步
 *  维护 pending 恢复索引（retention 删除不得遗留幽灵索引项）。
 * 【第十八轮 24.8】final not-executed 的驱逐资格按**该具体 attempt
 *  generation** 判定（lineageGenerationRetirement 注入的 O(1) verdict）：
 *  match（lineage/generation/transaction ID/binding/proof class/identity/
 *  三段完成全部验证）→ 可驱逐；pending/conflict/missing/store unhealthy →
 *  pin（conflict 计数 identityConflicts）。驱逐删除 tombstone 与 pending
 *  索引项，但绝不触碰 lineage record / retirement summary（durable 永久
 *  退休权威）。 */
function evictExpiredTombstones(store: TreasuryResolutionStore, indexes?: { resolvingIds: Set<string>; pendingReleaseIds: Set<string> }): number {
  let removed = 0;
  resolutionStoreEvents.fullScans += 1;
  for (const [key, entry] of Object.entries(store.entries)) {
    if (validateTreasuryResolutionTombstoneShape(entry) !== null) continue; // 损坏不删除
    if (entry.stage === "resolving") continue; // resolving 永不驱逐（第九轮 4.10）
    if (entry.resolvedAtTick < Game.time - TREASURY_RESOLUTION_RETENTION_TICKS) {
      if (entry.resolution === "not-executed") {
        // 驱逐资格 = 该 attempt generation 的 replacement proof 完整接管永久
        // retirement 门禁（装配注入的 O(1) verdict；未注册时保守 pin）。
        const verdict =
          retentionReplacementVerdict?.({
            transactionId: entry.transactionId,
            digest: entry.digest,
            resolution: entry.resolution,
            stage: entry.stage,
            proofLevel: entry.proofLevel,
            ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
            ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
            ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
            ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
            // 【第二十轮 12.2】完整 attempt identity 维度一并进入 verdict
            //（exact retirement proof 与 record current 的完整比较需要）。
            ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
            ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
            ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
            ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          }) ?? { verdict: "replacement_missing", detail: "verdict 未注册（保守 pin）" } as TreasuryRetentionReplacementVerdict;
        if (verdict.verdict !== "replacement_match") {
          if (verdict.verdict === "replacement_conflict") {
            resolutionStoreEvents.identityConflicts += 1;
          }
          resolutionStoreEvents.retentionPins += 1;
          continue;
        }
      }
      delete store.entries[key];
      store.entryCount -= 1;
      removed += 1;
      if (indexes !== undefined) indexes.pendingReleaseIds.delete(entry.transactionId);
      // 【第二十轮 10.1】not-executed 驱逐后联动释放该代 exact retirement
      // proof（依赖消失——root 门禁由 retirement summary 承担；committed
      // 条目无 proof 不涉及）。
      if (entry.resolution === "not-executed") {
        generationProofReleaser?.(entry.transactionId);
      }
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
 *
 * 【第十六轮第九节】写入候选额外经持久状态语义矩阵（write 上下文——新
 * lowlevel proof 必须携带 lowlevelSource）。
 *
 * 【第十六轮第十节】写入 Memory 前构造完全独立的有界深拷贝（含嵌套
 * forensicProvenance / lowlevelSource）——调用方输入与 Memory 无任何共享
 * 可变引用。
 */
export function writeTreasuryResolutionTombstone(entry: TreasuryResolutionTombstone): TreasuryResolutionTombstoneWriteResult {
  const shapeError = validateTreasuryResolutionTombstoneShape(entry);
  if (shapeError !== null) {
    return { status: "rejected", detail: `拒绝写入非法 tombstone: ${shapeError}` };
  }
  const stateError = validateTreasuryResolutionTombstoneState(entry, "write");
  if (stateError !== null) {
    return { status: "rejected", detail: `拒绝写入语义非法 tombstone: ${stateError}` };
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
    evictExpiredTombstones(runtime.store, runtime);
    if (runtime.store.entryCount >= TREASURY_RESOLUTION_MAX_ENTRIES) {
      return {
        status: "rejected",
        detail: `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`,
      };
    }
  }
  // 【第十六轮第十节】发布顺序：clone 输入 →（形状/状态已验证）→ Memory 写入
  // clone——不存调用方对象引用（嵌套 forensicProvenance 一并深拷贝）。
  runtime.store.entries[key] = cloneTreasuryDurableValue(entry);
  runtime.store.updatedAt = Game.time;
  if (transition.status === "allowed_create") {
    runtime.store.entryCount += 1;
    if (entry.stage === "resolving") runtime.resolvingIds.add(entry.transactionId);
    if (entry.stage === "final" && entry.resolution === "not-executed") runtime.pendingReleaseIds.add(entry.transactionId);
    return { status: "written" };
  }
  // allowed_finalize：resolving committed → final committed。
  runtime.resolvingIds.delete(entry.transactionId);
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
  runtime.resolvingIds.delete(transactionId);
  runtime.store.updatedAt = Game.time;
  return true;
}

/**
 * 【第十六轮第十三节】final not-executed 补完成收尾：immediate resolution
 * 路径成功释放 authority + 清 marker 后将 transactionId 移出 pending-release
 * 索引（幂等；Memory tombstone 仍是权威——索引只用于定位待处理项）。
 */
export function markTreasuryPendingReleaseCompleted(transactionId: string): void {
  if (heapRuntime === null) return;
  heapRuntime.pendingReleaseIds.delete(transactionId);
}

/**
 * 【第十七轮第五节】pending-release 索引只读快照（attemptLineage 的
 * beginTick backfill 用——检测无 lineage record 的 final not-executed）。
 * 索引只是定位器；调用方必须以 Memory tombstone 为权威复核。
 */
export function listTreasuryPendingReleaseIds(): readonly string[] {
  if (heapRuntime === null) return [];
  return [...heapRuntime.pendingReleaseIds];
}

/**
 * 【第十八轮 24.8】驱逐资格的 per-generation replacement verdict 注入（模块
 * 单向依赖：resolutionStore 不 import lineage 模块——lineageGenerationRetirement
 * 模块装配时把 O(1) verdict 注册进来；未注册时（部分单元测试直接构造）视为
 * 无 replacement → pin 保守）。
 */
export type TreasuryRetentionReplacementVerdict =
  | { readonly verdict: "replacement_match" }
  | { readonly verdict: "replacement_pending"; readonly detail: string }
  | { readonly verdict: "replacement_conflict"; readonly detail: string }
  | { readonly verdict: "replacement_missing"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/** verdict 输入的最小 tombstone 视图（lineageGenerationRetirement 定义完整语义）。 */
export interface TreasuryRetentionTombstoneView {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: string;
  readonly stage: string;
  readonly proofLevel: string;
  readonly lineageBindingDigest?: string;
  /** 【第十九轮 E.1】完整 lineage proof（压缩后按 lineageId 定位 summary）。 */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
}

let retentionReplacementVerdict: ((tombstone: TreasuryRetentionTombstoneView) => TreasuryRetentionReplacementVerdict) | null = null;

export function registerTreasuryRetentionLineageLookupForAssembly(
  lookup: ((tombstone: TreasuryRetentionTombstoneView) => TreasuryRetentionReplacementVerdict) | null,
): void {
  retentionReplacementVerdict = lookup;
}

/**
 * 【第二十轮 10.1】exact generation retirement proof 的驱逐联动释放注入
 * （generationRetirementAuthority 模块加载注册——模块单向依赖）：final
 * not-executed tombstone 按 replacement_match 驱逐后，对应代 proof 的唯一
 * 长期依赖消失（root 门禁由 retirement summary 承担）→ 释放。
 */
let generationProofReleaser: ((transactionId: string) => void) | null = null;

export function registerTreasuryGenerationProofReleaseForAssembly(release: (transactionId: string) => void): void {
  generationProofReleaser = release;
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
  /** 【第十六轮第九节】resolving 无进展/防御分支：保留 tombstone 的阻断条数（不再自动删除）。 */
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
  /** 【第十六轮第八节】store_unhealthy 零副作用阻断的条数（intent/quarantine store fatal）。 */
  storeUnhealthy: number;
  /** 【第十六轮第七节】final not-executed 残留 marker 无法安全清除的条数（conflict/insufficient/他属）。 */
  markerCleanupBlocked: number;
  /** 【第十六轮第十三节】beginTick O(1) 空闲快路径命中（无 resolving 且无 pending-release）。 */
  idleFastPath: boolean;
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
 * 【第十六轮第十三节】O(1) 空闲快路径：无 resolving 且无 pending-release
 * 索引项时直接返回（不扫描 resolution entries）；有待处理项时只遍历索引
 * 中的 transaction ID，不扫描全部历史 final proof。索引由 load 一次有界
 * 全表扫描重建、由写入/补完成/retention 删除维护；Memory 仍是权威——索引
 * 中的 ID 在 Memory 已不存在/状态已变时直接清理（不作为安全 proof）。
 *
 * - **authority inconsistent**：intent / quarantine / tombstone / marker 全
 *   保留，authorityInconsistent 独立计数，write readiness 保持阻断，零
 *   release、零 receipt refresh、零 stage 变化（不任选其一）；
 * - **store_unhealthy**（第十六轮第八节）：intent/quarantine store fatal →
 *   零副作用保留（不 refresh receipt、不释放 authority、不清 marker、不
 *   finalize、不回滚），独立计数——store 损坏绝不当作 authority 已释放；
 * - **authority not_found**（前一阶段已释放、finalize 前中断）：committed
 *   仍须 receipt ↔ tombstone identity match 且 tick 足够才补完成 finalize
 *   （不伪造新 authority）；final not-executed 走【第十六轮第七节】marker
 *   补完成（见 validatePendingReleaseMarkerCompletion）；
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
 * - stage=resolving 但无 settledAtTick / 非 committed（防御分支，load 语义
 *   矩阵后理论不可达）：【第十六轮第九节】**保留 tombstone 与计数阻断，
 *   不再自动删除**（删除非法持久状态不是 repair）；
 * - store fatal：不删任何数据，报告诊断（resolution 路径拒绝）。
 */

/** authority entry → attempt identity 视图（final not-executed 补完成比较；
 *  【第二十轮 8】exact attempt identity 单一构造——lineage 四字段与 proof
 *  class 不再在视图里丢弃）。 */
function attemptIdentityOf(authority: {
  readonly transactionId: string;
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly authorityLevel?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): TreasuryExactAttemptIdentity {
  const exact = treasuryExactAttemptIdentityOfAuthority(authority);
  if (exact !== null) return exact;
  // 视图构造失败（tr1_ 缺完整 lineage / digest 缺失——防御）：退化为空
  // digest 视图，exact relation 对 digest 缺失方判 conflict（fail closed）。
  return { transactionId: authority.transactionId, digest: "", proofClass: "legacy" };
}

/**
 * 【第二十轮 13.4】tr1_ tombstone 的 semantic lineage verdict（verifier 调用方
 * 先行计算）：tombstone 自身四字段完整（v7 shape 矩阵）时验证其语义真实性
 * ——child ID 派生/parent/binding 重算/active-terminal authority 状态。
 */
function semanticLineageVerdictOfTombstone(entry: TreasuryResolutionTombstone): { readonly verdict: string; readonly detail?: string } | undefined {
  if (!isTreasuryRearmAttemptId(entry.transactionId)) return undefined;
  if (
    entry.lineageId === undefined || entry.lineageGeneration === undefined ||
    entry.parentTransactionId === undefined || entry.lineageBindingDigest === undefined
  ) {
    return { verdict: "insufficient", detail: "tr1_ resolving tombstone 缺完整 lineage proof（形状层应已拦截——防御）" };
  }
  const semantic = validateTreasurySemanticLineage({
    transactionId: entry.transactionId,
    proof: {
      lineageId: entry.lineageId,
      lineageGeneration: entry.lineageGeneration,
      parentTransactionId: entry.parentTransactionId,
      lineageBindingDigest: entry.lineageBindingDigest,
    },
    purpose: entry.resolution === "committed" ? "committed_settlement" : "not_executed_retirement",
    identity: {
      digest: entry.digest,
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
      ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
    },
  });
  return semantic.verdict === "match"
    ? { verdict: "match" }
    : { verdict: semantic.verdict, detail: "detail" in semantic ? semantic.detail : undefined };
}

/**
 * 【第十六轮第七节】final not-executed + authority 已释放时残留 marker 的
 * 安全补完成判定（返回 null = 可安全清除 marker，否则有界阻断原因）：
 * - marker 不存在：释放与清理均已完成；
 * - transaction/attempt ID 匹配 + digest 匹配 + attemptIdentity 完整且与
 *   tombstone identity relation=match + phase 与 not-executed 结论兼容
 *   （preExecution 矩阵）+ tombstone proof level 与 marker identity 兼容，
 *   才可清除；
 * - marker 属于另一 attempt / identity conflict / identity insufficient /
 *   phase 不兼容：保留 marker + 保留 tombstone、write readiness 继续阻断、
 *   记录独立诊断、不伪造 authority。
 */
function validatePendingReleaseMarkerCompletion(
  marker: { readonly transactionId: string; readonly digest: string; readonly phase: string; readonly markerProtocol?: number; readonly markerVersion?: number; readonly identityProfile?: string; readonly authorityClass?: string; readonly contractDigest?: string; readonly authorizationCohortDigest?: string; readonly durableIdentityDigest?: string; readonly lowlevelSource?: string; readonly lineageId?: string; readonly lineageGeneration?: number; readonly attemptGeneration?: number; readonly parentTransactionId?: string; readonly lineageBindingDigest?: string; readonly attemptIdentity?: { readonly contractDigest?: string; readonly authorizationCohortDigest?: string; readonly durableIdentityDigest?: string } },
  entry: TreasuryResolutionTombstone,
): string | null {
  if (marker.transactionId !== entry.transactionId || marker.digest !== entry.digest) {
    return `marker 属于另一 attempt（marker ${marker.transactionId.slice(0, 48)}/${marker.digest.slice(0, 16)}，tombstone ${entry.transactionId.slice(0, 48)}/${entry.digest.slice(0, 16)}）`;
  }
  // 【第二十二轮第六节】identity 检查改用统一 marker exact relation（顶层
  // class-aware v2/v3/v4 marker 均可证明——不再强制旧式嵌套
  // attemptIdentity；v1 legacy marker 同 transaction 无法证明 → 由 relation
  // 判 insufficient fail closed）。phase 兼容矩阵保留。
  const markerRelation = treasuryMarkerExactIdentityRelation(
    treasuryMarkerDischargeExpectedOfFacts({
      transactionId: entry.transactionId,
      digest: entry.digest,
      proofClass: entry.proofLevel,
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
      ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
      ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
      ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
      ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
      ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
    }),
    marker,
  );
  if (markerRelation.kind !== "match") {
    return `marker 与 tombstone 的 exact relation=${markerRelation.kind}（${markerRelation.detail}）`;
  }
  // phase 与 not-executed 结论兼容矩阵：preExecution tombstone 只配
  // internal authorization fault 类 phase；普通 not-executed 只配
  // execution-unknown 类 phase（commit 类 phase 与 not-executed 结论矛盾）。
  const phaseCompatible = entry.preExecution === true
    ? marker.phase === "internal_authorization_fault" || marker.phase === "internal_authorization_fault_forensic"
    : TREASURY_EXECUTION_UNKNOWN_PHASES.has(marker.phase);
  if (!phaseCompatible) {
    return `marker phase ${marker.phase} 与 not-executed 结论不兼容（preExecution=${String(entry.preExecution === true)} 的合法 phase 类不匹配）`;
  }
  return null;
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
    storeUnhealthy: 0,
    markerCleanupBlocked: 0,
    idleFastPath: false,
    storeFatal: null,
  };
  const runtime = loadResolutionStoreRuntime();
  if (runtime.fatal) {
    report.storeFatal = runtime.fatal;
    resolutionStoreEvents.faulted += 1;
    return report;
  }
  // 【第十六轮第十三节】O(1) 空闲快路径：无待处理项时不扫描 resolution
  // entries（不遍历历史 final proof）。
  if (runtime.resolvingIds.size === 0 && runtime.pendingReleaseIds.size === 0) {
    report.idleFastPath = true;
    resolutionStoreEvents.idleFastPaths += 1;
    return report;
  }
  // 只遍历索引中的 transaction ID（Memory 权威；索引中的 ID 若已不存在或
  // 状态已变则清理索引项——索引不是安全 proof）。
  for (const transactionId of runtime.resolvingIds) {
    const key = RESOLUTION_KEY_PREFIX + transactionId;
    const entry = runtime.store.entries[key];
    if (entry === undefined || entry.stage !== "resolving") {
      runtime.resolvingIds.delete(transactionId);
      continue;
    }
    resolutionStoreEvents.inProgressRecoveries += 1;
    if (entry.resolution === "committed" && entry.settledAtTick !== undefined) {
      // ── 第 1 步【第十五轮第五节】：先统一 unresolved authority resolver
      //    （不再 quarantine ?? intent——双 authority 不一致在此拦截）。
      //    inconsistent → 立即零副作用保留；store_unhealthy（第十六轮）→
      //    同样零副作用保留（独立计数）。
      const authorityResolution = resolveTreasuryUnresolvedAuthority(transactionId);
      if (authorityResolution.status === "inconsistent") {
        resolutionStoreEvents.faulted += 1;
        report.authorityInconsistent += 1;
        resolutionStoreEvents.authorityInconsistentBlockers += 1;
        continue;
      }
      if (authorityResolution.status === "store_unhealthy") {
        resolutionStoreEvents.faulted += 1;
        report.storeUnhealthy += 1;
        resolutionStoreEvents.storeUnhealthyBlockers += 1;
        continue;
      }
      // ── 第 2 步：读取完整 receipt proof（tick 足够与否都读——identity
      //    校验不以 tick 充分为由跳过）。
      let receiptProof = readTreasurySettlementProof(transactionId);
      if (receiptProof === undefined || receiptProof.settledAtTick < entry.settledAtTick) {
        // receipt 未刷新到位（旧 action tick 的 receipt 或不存在）：幂等
        // 续做 identity-aware refresh 至原定 settledAtTick——绝不缩短
        // replay horizon。blocked（legacy/冲突/证明不足）与 fatal 同样
        // 保留 resolving + authority（fail closed）。
        const refresh = refreshSettledReceiptForResolution(transactionId, entry.settledAtTick, {
          digest: entry.digest,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined
            ? { authorizationCohortDigest: entry.authorizationCohortDigest }
            : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          // 【第十九轮 A.7】staged recovery 与 immediate resolve-as-committed 同
          // 一 lineage-aware refresh 语义（tr1_ resolving tombstone 的 proof 是
          // 续做 refresh 的权威来源）。
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
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
        receiptProof = readTreasurySettlementProof(transactionId);
      }
      // ── 第 3 步：共用三方 verifier（receipt 时间证明、modern level、
      //    receipt ↔ tombstone、proof level 自动释放矩阵、tombstone/receipt
      //    ↔ authority 全部由此承载）。【第二十轮 13.4】tr1_ 另附 semantic
      //    lineage verdict——三方互相 match 不自动代表真实 generation。
      const semanticVerdict = semanticLineageVerdictOfTombstone(entry);
      const verdict = verifyTreasuryCommittedResolutionProof({
        tombstone: entry,
        authorityResolution,
        receiptProof,
        ...(semanticVerdict !== undefined ? { semanticLineageVerdict: semanticVerdict } : {}),
      });
      if (verdict.status !== "verified") {
        resolutionStoreEvents.faulted += 1;
        if (verdict.status === "authority_inconsistent") {
          report.authorityInconsistent += 1;
          resolutionStoreEvents.authorityInconsistentBlockers += 1;
        } else if (verdict.status === "authority_store_unhealthy") {
          report.storeUnhealthy += 1;
          resolutionStoreEvents.storeUnhealthyBlockers += 1;
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
      // ── 第 4 步【Round 22 remediation B.2】：cleanup journal 接入 + 严格
      //    顺序 discharge（read-back）→ release → authority read-back →
      //    finalize。marker discharge 未完成前不得释放 Intent/Quarantine——
      //    journal store fatal / identity 冲突同样阻断 finalize 与索引移除。
      const committedCleanupOpen = openTreasuryResolutionCleanup(
        treasuryResolutionCleanupOpenInputOfFacts({
          transactionId,
          digest: entry.digest,
          resolution: "committed",
          proofClass: entry.proofLevel,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        }),
      );
      if (committedCleanupOpen.status === "rejected" || committedCleanupOpen.status === "conflict") {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      const committedCleanup = readTreasuryResolutionCleanupEntry(transactionId);
      if (committedCleanup === undefined) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      // 【Remediation II D.4】marker 阶段布尔不是安全证明——resolver ok 时
      // 无条件重跑 discharge（already_absent/matching_cleared 幂等；boolean
      // 撒谎但 matching marker 仍存在时按 exact relation 安全补清除）。
      {
        const committedDischarge = dischargeTreasuryMarkerForAttempt(
          treasuryMarkerDischargeExpectedOfFacts({
            transactionId,
            digest: entry.digest,
            proofClass: entry.proofLevel,
            ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
            ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
            ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
            ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
            ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
            ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
            ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
            ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
          }),
        );
        if (!treasuryMarkerDischargeCompletesAttemptPhase(committedDischarge.outcome)) {
          // marker 清理未完成：authority 与 resolving tombstone 保留（不释放、
          // 不 finalize——beginTick journal 恢复幂等重试 discharge）。
          resolutionStoreEvents.faulted += 1;
          report.markerCleanupBlocked += 1;
          resolutionStoreEvents.markerCleanupBlockers += 1;
          continue;
        }
        if (!markTreasuryResolutionCleanupStage(transactionId, "marker_discharge", committedDischarge.outcome)) {
          resolutionStoreEvents.faulted += 1;
          report.markerCleanupBlocked += 1;
          resolutionStoreEvents.markerCleanupBlockers += 1;
          continue;
        }
      }
      // resolver 第 1 步已确认 authority 在场（ok）。journal 阶段布尔不是
      // 安全证明（【Remediation II D.4】同款语义：authorityReleased=true 而
      // authority 在场 = 持久矛盾——幂等重释放 + read-back，不跳过）。
      releaseTreasuryQuarantineEntry(transactionId);
      releaseTreasuryIntentEntry(transactionId);
      if (resolveTreasuryUnresolvedAuthority(transactionId).status !== "not_found") {
        // 释放后 read-back 未确认 not_found：resolving 保留（journal 阶段
        // 不推进，下一 tick 幂等重试）。
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      // 【Remediation II B.4】阶段写入失败同样阻断 finalize（journal 阶段
      // 未推进——不得进入 outcome finalization）。
      if (!markTreasuryResolutionCleanupStage(transactionId, "authority_release")) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      // 【Remediation II B.4】finalize 经统一状态机写入（不绕过
      // writeTreasuryResolutionTombstone 的形状/语义/容量校验）；写入被拒
      // 保留 resolving（journal outcome 阶段不推进）。resolvedAtTick 单调
      // 推进至 settledAtTick——staged 目标结算 tick 允许晚于创建时刻
      //（resolving 语义），final 终态要求 settledAtTick ≤ resolvedAtTick。
      const finalEntry: TreasuryResolutionTombstone = {
        ...entry,
        stage: "final",
        resolvedAtTick: Math.max(entry.resolvedAtTick, entry.settledAtTick ?? entry.resolvedAtTick),
      };
      const transition = validateTreasuryResolutionTombstoneTransition(entry, finalEntry);
      if (transition.status !== "allowed_finalize") {
        // 防御：resolving entry 自身形态与 finalize 目标矛盾（不应发生——
        // load 已校验形状与语义）：保留原状态，计数阻断。
        resolutionStoreEvents.faulted += 1;
        report.identityInsufficient += 1;
        resolutionStoreEvents.identityInsufficientBlockers += 1;
        continue;
      }
      // 【Remediation II B.4】finalize 经统一状态机写入（不绕过
      // writeTreasuryResolutionTombstone 的形状/语义/容量校验）；写入被拒
      // 保留 resolving（journal outcome 阶段不推进）。
      const committedFinalizeWrite = writeTreasuryResolutionTombstone(finalEntry);
      if (committedFinalizeWrite.status === "rejected") {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      if (!markTreasuryResolutionCleanupStage(transactionId, "outcome_finalization")) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      // lineage finalization：initial attempt（无 lineageId）当场 not_
      // applicable 完成并删除 entry（journal 不积压）；tr1_ 的 chain close
      // 由 beginTick journal recovery（顺序在本函数之后）按同一阶段顺序
      // 补完成。
      const committedAfterOutcome = readTreasuryResolutionCleanupEntry(transactionId);
      if (committedAfterOutcome !== undefined && committedAfterOutcome.lineageId === undefined) {
        markTreasuryResolutionCleanupStage(transactionId, "lineage_finalization");
        completeTreasuryResolutionCleanup(transactionId);
      }
      runtime.resolvingIds.delete(transactionId);
      runtime.store.updatedAt = Game.time;
      resolutionStoreEvents.recovered += 1;
      report.completed += 1;
    } else {
      // 防御分支【第十六轮第九节】：resolving 无 settledAtTick 或非
      // committed——load 持久状态语义矩阵后理论不可达；保留 tombstone 与
      // 独立计数阻断（**不再自动删除**——删除非法持久状态不是 repair，
      // 原 entry 交人工处理）。
      resolutionStoreEvents.faulted += 1;
      report.rolledBack += 1;
    }
  }
  // ── final not-executed pending-release 补完成【第十五轮第五节 / 第十六轮
  //    第七节】：authority 仍存在 → 校验后补释放；authority not_found →
  //    检查 write-fault marker（不存在=完成；存在且 match=清除；conflict/
  //    insufficient=保留阻断）。
  for (const transactionId of runtime.pendingReleaseIds) {
    const key = RESOLUTION_KEY_PREFIX + transactionId;
    const entry = runtime.store.entries[key];
    if (entry === undefined || entry.stage !== "final" || entry.resolution !== "not-executed") {
      runtime.pendingReleaseIds.delete(transactionId);
      continue;
    }
    const authorityResolution = resolveTreasuryUnresolvedAuthority(transactionId);
    if (authorityResolution.status === "store_unhealthy") {
      resolutionStoreEvents.faulted += 1;
      report.storeUnhealthy += 1;
      resolutionStoreEvents.storeUnhealthyBlockers += 1;
      continue;
    }
    if (authorityResolution.status === "not_found") {
      // 【第十六轮第七节 + Round 22 remediation B】authority 已释放的历史
      // 遗留窗口：检查 write-fault marker 的安全补完成——marker 不存在=
      // 释放与清理均完成；存在且全部匹配才清除；conflict/insufficient/
      // 他属一律保留（write readiness 继续阻断）。journal 幂等补开
      // （settlement proof = final tombstone 已持久化）；store fatal /
      // identity 冲突不折叠为"已完成"。
      const notFoundCleanupOpen = openTreasuryResolutionCleanup(
        treasuryResolutionCleanupOpenInputOfFacts({
          transactionId: entry.transactionId,
          digest: entry.digest,
          resolution: "not-executed",
          proofClass: entry.proofLevel,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        }),
      );
      if (notFoundCleanupOpen.status === "rejected" || notFoundCleanupOpen.status === "conflict") {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
        const marker = readTreasuryWriteFault();
        if (marker === undefined) {
          const pendingEntry = readTreasuryResolutionCleanupEntry(entry.transactionId);
          if (pendingEntry !== undefined && !pendingEntry.markerDischarged) {
            markTreasuryResolutionCleanupStage(entry.transactionId, "marker_discharge", "already_absent");
          }
          // authority read-back 已是 not_found；outcome proof = final tombstone
          //（本分支的存在前提）。lineage 阶段由 beginTick journal recovery 补完成。
          // 【Remediation II B.4】阶段写入失败不得移除 pending-release 索引
          //（下一 tick 幂等重试）。
          const progressedEntry = readTreasuryResolutionCleanupEntry(entry.transactionId);
          if (
            progressedEntry !== undefined &&
            (!progressedEntry.authorityReleased || !progressedEntry.outcomeFinalized)
          ) {
            const authorityStageAdvanced =
              progressedEntry.authorityReleased || markTreasuryResolutionCleanupStage(entry.transactionId, "authority_release");
            const outcomeStageAdvanced =
              progressedEntry.outcomeFinalized || markTreasuryResolutionCleanupStage(entry.transactionId, "outcome_finalization");
            if (!authorityStageAdvanced || !outcomeStageAdvanced) {
              resolutionStoreEvents.faulted += 1;
              report.markerCleanupBlocked += 1;
              resolutionStoreEvents.markerCleanupBlockers += 1;
              continue;
            }
          }
          const progressedAfterStages = readTreasuryResolutionCleanupEntry(entry.transactionId);
          // initial attempt（无 lineageId）当场完成 lineage 并删除 entry；
          // tr1_ 留 journal recovery 补完成（converge / exact proof）。
          if (progressedAfterStages !== undefined && progressedAfterStages.lineageId === undefined) {
            if (
              !markTreasuryResolutionCleanupStage(entry.transactionId, "lineage_finalization") ||
              !completeTreasuryResolutionCleanup(entry.transactionId)
            ) {
              resolutionStoreEvents.faulted += 1;
              report.markerCleanupBlocked += 1;
              resolutionStoreEvents.markerCleanupBlockers += 1;
              continue;
            }
          }
          runtime.pendingReleaseIds.delete(transactionId);
          continue;
        }
      const markerBlock = validatePendingReleaseMarkerCompletion(marker, entry);
      if (markerBlock !== null) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      // 【第二十二轮第六节】marker 补完成改用统一 exact relation +
      // discharge（不再强制旧式嵌套 attemptIdentity——顶层 class-aware
      // v2/v3/v4 marker 均可证明）。未完成不移除 pending 索引。
      const notExecutedDischarge = dischargeTreasuryMarkerForAttempt(
        treasuryMarkerDischargeExpectedOfFacts({
          transactionId: entry.transactionId,
          digest: entry.digest,
          proofClass: entry.proofLevel,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        }),
      );
      if (!treasuryMarkerDischargeCompletesAttemptPhase(notExecutedDischarge.outcome)) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      const completedEntry = readTreasuryResolutionCleanupEntry(entry.transactionId);
      if (completedEntry !== undefined) {
        // 【Remediation II B.4】任一阶段写入失败不移除 pending-release 索引
        //（保持强制前置顺序，下一 tick 幂等重试）。
        const markerStageAdvanced =
          completedEntry.markerDischarged || markTreasuryResolutionCleanupStage(entry.transactionId, "marker_discharge", notExecutedDischarge.outcome);
        const authorityStageAdvanced =
          completedEntry.authorityReleased || markTreasuryResolutionCleanupStage(entry.transactionId, "authority_release");
        const outcomeStageAdvanced =
          completedEntry.outcomeFinalized || markTreasuryResolutionCleanupStage(entry.transactionId, "outcome_finalization");
        if (!markerStageAdvanced || !authorityStageAdvanced || !outcomeStageAdvanced) {
          resolutionStoreEvents.faulted += 1;
          report.markerCleanupBlocked += 1;
          resolutionStoreEvents.markerCleanupBlockers += 1;
          continue;
        }
        // initial attempt（无 lineageId）当场完成 lineage 并删除 entry；
        // tr1_ 留 journal recovery 补完成。
        if (completedEntry.lineageId === undefined) {
          if (
            !markTreasuryResolutionCleanupStage(entry.transactionId, "lineage_finalization") ||
            !completeTreasuryResolutionCleanup(entry.transactionId)
          ) {
            resolutionStoreEvents.faulted += 1;
            report.markerCleanupBlocked += 1;
            resolutionStoreEvents.markerCleanupBlockers += 1;
            continue;
          }
        }
      }
      runtime.pendingReleaseIds.delete(transactionId);
      resolutionStoreEvents.recovered += 1;
      report.completedRelease += 1;
      continue;
    }
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
    // 【第十六轮第十一节】lowlevel provenance 严格绑定：tombstone 缺
    // lowlevelSource（v5 及更早的旧 proof）→ 来源不可证明 → 隔离不释放；
    // 来源不同（runtime vs migrated）→ conflict 不释放。
    if (entry.proofLevel === "lowlevel" && authority.authorityLevel === "lowlevel") {
      if (entry.lowlevelSource === undefined) {
        resolutionStoreEvents.faulted += 1;
        report.identityInsufficient += 1;
        resolutionStoreEvents.identityInsufficientBlockers += 1;
        continue;
      }
      if (authority.lowlevelSource !== undefined && entry.lowlevelSource !== authority.lowlevelSource) {
        resolutionStoreEvents.faulted += 1;
        report.identityConflicts += 1;
        resolutionStoreEvents.identityConflicts += 1;
        continue;
      }
    }
    const relation = treasuryExactAttemptIdentityRelation(
      treasuryExactAttemptIdentityOfTombstone(entry) ?? attemptIdentityOf({ transactionId: entry.transactionId, digest: entry.digest }),
      attemptIdentityOf(authority),
    );
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
    // final tombstone 已写但释放未完成【Round 22 remediation B.2】：journal
    // 接入 + 严格顺序 discharge（read-back）→ release → authority read-back
    // → 阶段推进。marker discharge 未完成前不得释放 Intent/Quarantine。
    const authorityPresentCleanupOpen = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId,
        digest: entry.digest,
        resolution: "not-executed",
        proofClass: entry.proofLevel,
        ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
        ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
        ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
        ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
        ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
        ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
        ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
        ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
      }),
    );
    if (authorityPresentCleanupOpen.status === "rejected" || authorityPresentCleanupOpen.status === "conflict") {
      resolutionStoreEvents.faulted += 1;
      report.markerCleanupBlocked += 1;
      resolutionStoreEvents.markerCleanupBlockers += 1;
      continue;
    }
    const authorityPresentCleanup = readTreasuryResolutionCleanupEntry(transactionId);
    if (authorityPresentCleanup === undefined) {
      resolutionStoreEvents.faulted += 1;
      report.markerCleanupBlocked += 1;
      resolutionStoreEvents.markerCleanupBlockers += 1;
      continue;
    }
    // 【Remediation II D.4】marker 阶段布尔不是安全证明——authority 在场时
    // 无条件重跑 discharge（幂等；boolean 撒谎时安全补清除）。
    {
      const authorityPresentDischarge = dischargeTreasuryMarkerForAttempt(
        treasuryMarkerDischargeExpectedOfFacts({
          transactionId,
          digest: entry.digest,
          proofClass: entry.proofLevel,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        }),
      );
      if (!treasuryMarkerDischargeCompletesAttemptPhase(authorityPresentDischarge.outcome)) {
        // marker 清理未完成：authority（quarantine/intent）保留、pending
        // 索引保留——不释放（beginTick journal 恢复幂等重试）。
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
      if (!markTreasuryResolutionCleanupStage(transactionId, "marker_discharge", authorityPresentDischarge.outcome)) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
    }
    // resolver 已确认 authority 在场——journal 阶段布尔不是安全证明
    //（【Remediation II D.4】同款语义：幂等重释放 + read-back 确认 not_found
    // 才推进阶段；read-back 非 not_found 或阶段写入失败都保留 pending 索引）。
    releaseTreasuryQuarantineEntry(transactionId);
    releaseTreasuryIntentEntry(transactionId);
    if (resolveTreasuryUnresolvedAuthority(transactionId).status !== "not_found") {
      resolutionStoreEvents.faulted += 1;
      report.markerCleanupBlocked += 1;
      resolutionStoreEvents.markerCleanupBlockers += 1;
      continue;
    }
    if (!markTreasuryResolutionCleanupStage(transactionId, "authority_release")) {
      resolutionStoreEvents.faulted += 1;
      report.markerCleanupBlocked += 1;
      resolutionStoreEvents.markerCleanupBlockers += 1;
      continue;
    }
    if (!authorityPresentCleanup.outcomeFinalized) {
      // outcome proof = final not-executed tombstone（本分支的存在前提）。
      if (!markTreasuryResolutionCleanupStage(transactionId, "outcome_finalization")) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
    }
    // initial attempt（无 lineageId）当场完成 lineage 并删除 entry；tr1_
    // 留 journal recovery 补完成（converge / exact proof）。
    const authorityPresentAfterOutcome = readTreasuryResolutionCleanupEntry(transactionId);
    if (authorityPresentAfterOutcome !== undefined && authorityPresentAfterOutcome.lineageId === undefined) {
      if (
        !markTreasuryResolutionCleanupStage(transactionId, "lineage_finalization") ||
        !completeTreasuryResolutionCleanup(transactionId)
      ) {
        resolutionStoreEvents.faulted += 1;
        report.markerCleanupBlocked += 1;
        resolutionStoreEvents.markerCleanupBlockers += 1;
        continue;
      }
    }
    runtime.pendingReleaseIds.delete(transactionId);
    resolutionStoreEvents.recovered += 1;
    report.completedRelease += 1;
  }
  return report;
}
