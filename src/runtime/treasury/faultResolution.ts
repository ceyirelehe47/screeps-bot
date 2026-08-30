/**
 * Treasury 显式 fault resolution 协议（第六轮建立、第七轮重做为
 * post-observation 证据协议）。
 *
 * 背景：write-fault marker / durable quarantine 只证明"Game 结果未知或
 * commit 未完成"，无法证明 Game 动作是否发生。直接删除 marker 解锁会让
 * 资源被错误释放、已执行动作可能被重放。因此解锁必须携带**证据语义**：
 *
 * - resolve-as-committed：依据故障后对账证据（evidence.conclusion =
 *   observed_committed）认定 Game 动作已发生——以 **resolution tick** 写
 *   settlement receipt（完整 5000 retention 窗口——延迟数千年 tick 后
 *   resolution 的 receipt 仍存活完整窗口，下一 tick cleanup 不删）、原
 *   action tick 保留在 resolution tombstone（审计，不缩短 retention）、
 *   释放对应 quarantine、清除匹配的 write-fault marker；防重放由新 receipt
 *   生效；不把历史动作写入当前 tick overlay/journal（避免与 observed 世界
 *   双算）。
 * - resolve-as-not-executed：仅在证据明确（conclusion =
 *   observed_not_executed）且 phase 属于 execution-unknown 类
 *   （action_returned_non_ok_abort_failed / action_threw_execution_unknown /
 *   executing_at_end_tick）时释放——不写 receipt、不生成 committed
 *   projection、显式返回允许重新 prepare。Game 确认 OK 后的 commit 类
 *   phase 一律拒绝（不允许伪造"未执行"——除非更强的外部证据，本轮不提供
 *   该通道）。
 * - still_uncertain：证据不足以判定——保持 quarantine，不解锁，零副作用。
 *
 * 第七轮新增的 resolution 前置检查（缺一拒绝且 fault 不动）：
 * - service-aware guard：transaction 不得仍属于当前 Treasury service 的
 *   active handle registry（active_handle_present）——resolution 后 endTick
 *   不得"刚 resolve 又重新 quarantine"；
 * - 当前 tick 必须大于故障 tick（entry.recordedAt）；
 * - 系统必须已建立至少一个故障发生后的 shared observation
 *   （guard.currentObservationTick > entry.recordedAt）；
 * - evidence.observationTick 必须严格晚于故障 tick（stale_observation 拒绝）
 *   且不晚于当前 tick（未来观察非法）。
 *
 * resolution tombstone（Memory.runtime.treasury.resolutions）：有界幂等
 * 记录（"r:"+transactionId）——receipt retention 过期后的重复管理调用仍能
 * 返回 already_resolved 而非模糊 not_found；写入时惰性清理过期项
 * （resolvedAtTick + 5000），超上限且无可清理时拒绝新 resolution（fail
 * closed，绝不丢弃已存 tombstone）。
 *
 * 安全边界（架构测试守护）：
 * - resolution 幂等（重复调用 already_resolved / 零副作用拒绝）；
 * - 错误 transactionId / digest 不匹配 / 不允许的 resolution → 拒绝且
 *   fault/quarantine 保持不变；
 * - resolution 完成前 write admission 持续锁定（本模块不清除不匹配的
 *   marker；全部 quarantine 解决前全局 blocker 持续）；
 * - 生产 tick 不得自动调用（仅显式管理/修复路径与测试可引用）；
 * - 显式 repair（quarantine store 元数据/legacy 形状修复）只在本模块提供。
 */

import {
  commitSettledReceipt,
  hasSettledReceipt,
} from "@/runtime/treasury/receipts";
import {
  clearTreasuryWriteFaultMarkerForResolution,
  readTreasuryWriteFault,
  TREASURY_EXECUTION_UNKNOWN_PHASES,
} from "@/runtime/treasury/writeFault";
import {
  ensureTreasuryQuarantineStoreValidated,
  peekTreasuryQuarantineHealth,
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
  repairTreasuryQuarantineStoreMetadataForResolution,
  type TreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import { recordTreasuryResolutionEvent } from "@/runtime/treasury/resolutionEvents";

export type TreasuryResolutionConclusion = "observed_committed" | "observed_not_executed" | "still_uncertain";

/**
 * 显式 reconciliation evidence：管理员/对账工具基于**故障发生后**的观察
 * 得出的结论。本轮无真实 writer，不实现各 Game API 的业务对账器——evidence
 * 是可扩展协议（后续可携带结构化对账载荷）。
 */
export interface TreasuryResolutionEvidence {
  readonly conclusion: TreasuryResolutionConclusion;
  /** 对账观察所在 tick（必须严格晚于故障 tick，不得晚于当前 tick）。 */
  readonly observationTick: number;
  /** 证据来源标识（有界 string，如 "manual-inspection" / "terminal-audit"）。 */
  readonly source: string;
}

/**
 * service-aware guard（由 facade.treasuryResolutionGuard() 提供）：resolution
 * 不得作用于仍存活于当前 active handle registry 的 transaction；且系统必须
 * 已建立故障后的 shared observation。
 */
export interface TreasuryResolutionGuard {
  readonly activeTransactionIds: ReadonlySet<string>;
  readonly currentObservationTick: number;
}

export interface TreasuryFaultResolutionInput {
  readonly transactionId: string;
  /** 可选 digest 核对（提供时必须与 quarantine entry 一致，否则拒绝）。 */
  readonly digest?: string;
  readonly evidence: TreasuryResolutionEvidence;
  readonly guard: TreasuryResolutionGuard;
}

export type TreasuryFaultResolutionResult =
  | {
      readonly status: "resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
      /** 本次调用是否实际写入 receipt（false = 幂等命中既有结算）。 */
      readonly receiptWritten: boolean;
      /** resolution 后是否允许重新 prepare 该 transactionId。 */
      readonly reprepareAllowed: boolean;
      /** 原 action tick（审计保留；receipt retention 从 settlement tick 起算）。 */
      readonly actionTick: number;
      /** receipt 结算 tick（resolve-as-committed 时存在 = resolution tick）。 */
      readonly settledAtTick?: number;
    }
  | {
      readonly status: "already_resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
    }
  | {
      /** 证据结论为 still_uncertain：保持 quarantine，不解锁，零副作用。 */
      readonly status: "uncertain";
      readonly transactionId: string;
      readonly detail: string;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "not_found"
        | "digest_mismatch"
        | "active_handle_present"
        | "resolution_not_allowed"
        | "stale_observation"
        | "evidence_mismatch"
        | "receipt_store_fatal"
        | "quarantine_store_fatal"
        | "resolution_store_fatal"
        | "resolution_store_full"
        | "invalid_input";
      readonly detail: string;
    };

// ── resolution 计数器（resolutionEvents.ts 承载，facade 只读聚合） ─────────

export type { TreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";
export { readTreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";

function countRejected(): void {
  recordTreasuryResolutionEvent("rejected");
}

// ── resolution tombstone（有界幂等记录） ────────────────────────────────────

const RESOLUTION_KEY_PREFIX = "r:";
export const TREASURY_RESOLUTION_MAX_ENTRIES = 256;
const TREASURY_RESOLUTION_RETENTION_TICKS = 5_000;
const RESOLUTION_SOURCE_MAX = 128;

interface TreasuryResolutionTombstone {
  transactionId: string;
  digest: string;
  resolution: "committed" | "not-executed";
  actionTick: number;
  settledAtTick?: number;
  observationTick: number;
  resolvedAtTick: number;
}

interface TreasuryResolutionBranch {
  resolutions?: {
    version: 1;
    entries: Record<string, TreasuryResolutionTombstone>;
    updatedAt: number;
  };
}

type RuntimeMemoryWithResolutions = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryResolutionBranch;
};

function resolutionStoreBranch(): NonNullable<TreasuryResolutionBranch["resolutions"]> {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithResolutions;
  if (!runtime.treasury) runtime.treasury = {};
  if (!runtime.treasury.resolutions) runtime.treasury.resolutions = { version: 1, entries: {}, updatedAt: Game.time };
  return runtime.treasury.resolutions;
}

function readResolutionTombstone(transactionId: string): TreasuryResolutionTombstone | undefined {
  const store = (Memory.runtime as unknown as RuntimeMemoryWithResolutions | undefined)?.treasury?.resolutions;
  if (!store || typeof store.entries !== "object") return undefined;
  return store.entries[RESOLUTION_KEY_PREFIX + transactionId] as TreasuryResolutionTombstone | undefined;
}

/**
 * 写入 tombstone（写入时惰性清理超过 retention 的过期项；超上限且无可清理
 * → 拒绝新 resolution，fail closed，绝不丢弃已存记录）。
 */
function writeResolutionTombstone(entry: TreasuryResolutionTombstone): { ok: true } | { fatal: string } {
  const store = resolutionStoreBranch();
  if (!store.entries || typeof store.entries !== "object") {
    return { fatal: "resolution tombstone store 形状非法（人工处理）" };
  }
  const key = RESOLUTION_KEY_PREFIX + entry.transactionId;
  if (!Object.prototype.hasOwnProperty.call(store.entries, key)) {
    // 惰性清理：resolvedAtTick 超过 retention 的旧项（写入是低频事件，有界单扫）。
    for (const [existingKey, existing] of Object.entries(store.entries)) {
      const tombstone = existing as TreasuryResolutionTombstone | null;
      if (
        !tombstone ||
        typeof tombstone !== "object" ||
        typeof tombstone.resolvedAtTick !== "number" ||
        tombstone.resolvedAtTick < Game.time - TREASURY_RESOLUTION_RETENTION_TICKS
      ) {
        delete store.entries[existingKey];
      }
    }
    if (Object.keys(store.entries).length >= TREASURY_RESOLUTION_MAX_ENTRIES) {
      return {
        fatal: `resolution tombstone 已达上限 ${String(TREASURY_RESOLUTION_MAX_ENTRIES)} 且无可清理过期项（fail closed）`,
      };
    }
  }
  store.entries[key] = entry;
  store.updatedAt = Game.time;
  return { ok: true };
}

// ── 输入/evidence/guard 形状验证 ───────────────────────────────────────────

function describeInvalidInput(
  input: TreasuryFaultResolutionInput,
): { rejection: TreasuryFaultResolutionResult } | { evidence: TreasuryResolutionEvidence; guard: TreasuryResolutionGuard } {
  if (!input || typeof input !== "object" || typeof input.transactionId !== "string" || input.transactionId.length === 0) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "transactionId 缺失或非法" } };
  }
  if (input.digest !== undefined && (typeof input.digest !== "string" || input.digest.length === 0)) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "digest 非法" } };
  }
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== "object") {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "evidence 缺失" } };
  }
  if (
    evidence.conclusion !== "observed_committed" &&
    evidence.conclusion !== "observed_not_executed" &&
    evidence.conclusion !== "still_uncertain"
  ) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: `evidence.conclusion 非法: ${String(evidence.conclusion)}` } };
  }
  if (typeof evidence.observationTick !== "number" || !Number.isSafeInteger(evidence.observationTick) || evidence.observationTick < 0) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "evidence.observationTick 非安全整数" } };
  }
  if (typeof evidence.source !== "string" || evidence.source.length === 0 || evidence.source.length > RESOLUTION_SOURCE_MAX) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "evidence.source 非法（须为 1..128 字符）" } };
  }
  const guard = input.guard;
  if (!guard || typeof guard !== "object" || !(guard.activeTransactionIds instanceof Set)) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "guard.activeTransactionIds 缺失（须经 facade.treasuryResolutionGuard() 提供）" } };
  }
  if (typeof guard.currentObservationTick !== "number" || !Number.isSafeInteger(guard.currentObservationTick) || guard.currentObservationTick < 0) {
    return { rejection: { status: "rejected", reason: "invalid_input", detail: "guard.currentObservationTick 非安全整数" } };
  }
  return { evidence, guard };
}

/**
 * 共享前置验证链：形状 → quarantine health → 定位 entry（含 tombstone/receipt
 * 幂等）→ digest → active handle → tick 时序 → post-observation →
 * evidence 时序。返回 entry 或拒绝/uncertain 结果。
 */
function prevalidate(
  input: TreasuryFaultResolutionInput,
): { entry: TreasuryQuarantineEntry; evidence: TreasuryResolutionEvidence } | { stop: TreasuryFaultResolutionResult } {
  const parsed = describeInvalidInput(input);
  if ("rejection" in parsed) {
    countRejected();
    return { stop: parsed.rejection };
  }
  // resolution 是写路径：显式触发一次 load 全量验证（entry 级损坏在轻量
  // health 探测下不可见，必须由 load 检出——不可信 store 上不得执行）。
  const loadFatal = ensureTreasuryQuarantineStoreValidated();
  const quarantineHealth = loadFatal !== null ? { healthy: false, detail: loadFatal } : peekTreasuryQuarantineHealth();
  if (!quarantineHealth.healthy) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "quarantine_store_fatal",
        detail: quarantineHealth.detail ?? "quarantine store 损坏（不可信 store 上不得执行 resolution）",
      },
    };
  }
  const entry = readTreasuryQuarantineEntry(input.transactionId);
  if (entry === undefined) {
    // 幂等：先查 tombstone（receipt retention 过期后仍可判定），再查 receipt。
    const tombstone = readResolutionTombstone(input.transactionId);
    if (tombstone !== undefined) {
      return {
        stop: { status: "already_resolved", resolution: tombstone.resolution, transactionId: input.transactionId },
      };
    }
    if (hasSettledReceipt(input.transactionId) !== undefined) {
      return { stop: { status: "already_resolved", resolution: "committed", transactionId: input.transactionId } };
    }
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "not_found",
        detail: `transactionId ${input.transactionId.slice(0, 48)} 不在 durable quarantine（可能已解决或从未隔离）`,
      },
    };
  }
  if (input.digest !== undefined && entry.digest !== input.digest) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "digest_mismatch",
        detail: `digest 不匹配（quarantine ${entry.digest}，请求 ${input.digest}）——拒绝以避免解决错误 transaction`,
      },
    };
  }
  if (parsed.guard.activeTransactionIds.has(input.transactionId)) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "active_handle_present",
        detail: "transaction 仍属于当前 Treasury service 的 active handle registry（resolution 后 endTick 会重新 quarantine——必须等 handle 终态化/服务重建后再 resolution）",
      },
    };
  }
  if (Game.time <= entry.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: `当前 tick ${String(Game.time)} 未晚于故障 tick ${String(entry.recordedAt)}（同 tick 不得 resolution）`,
      },
    };
  }
  if (parsed.guard.currentObservationTick <= entry.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "resolution_not_allowed",
        detail: `系统尚未建立故障后的 shared observation（当前 observation tick ${String(parsed.guard.currentObservationTick)} ≤ 故障 tick ${String(entry.recordedAt)}）`,
      },
    };
  }
  if (parsed.evidence.observationTick <= entry.recordedAt) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "stale_observation",
        detail: `evidence 观察 tick ${String(parsed.evidence.observationTick)} 不晚于故障 tick ${String(entry.recordedAt)}（必须基于故障后的对账观察）`,
      },
    };
  }
  if (parsed.evidence.observationTick > Game.time) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "invalid_input",
        detail: `evidence 观察 tick ${String(parsed.evidence.observationTick)} 晚于当前 tick ${String(Game.time)}（未来观察非法）`,
      },
    };
  }
  if (parsed.evidence.conclusion === "still_uncertain") {
    recordTreasuryResolutionEvent("uncertain");
    return {
      stop: {
        status: "uncertain",
        transactionId: input.transactionId,
        detail: "对账证据结论为 still_uncertain——保持 quarantine 与全部占用，不解锁",
      },
    };
  }
  return { entry, evidence: parsed.evidence };
}

/** 清除与本 transaction 匹配的 write-fault marker（不匹配的根因 marker 不动）。 */
function clearMatchingMarker(transactionId: string, digest: string): void {
  clearTreasuryWriteFaultMarkerForResolution(transactionId, digest);
}

/**
 * resolve-as-committed：以 resolution tick 写 receipt（完整 retention 窗口）、
 * 原 action tick 保留在 tombstone、释放 quarantine、清除匹配 marker、防重放。
 */
export function resolveTreasuryQuarantinedTransactionAsCommitted(
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const pre = prevalidate(input);
  if ("stop" in pre) return pre.stop;
  const { entry, evidence } = pre;
  if (evidence.conclusion !== "observed_committed") {
    countRejected();
    return {
      status: "rejected",
      reason: "evidence_mismatch",
      detail: `resolve-as-committed 需要 observed_committed 证据（got ${evidence.conclusion}）`,
    };
  }
  const receipt = commitSettledReceipt(entry.transactionId, Game.time);
  if (receipt.status === "fatal") {
    // receipt store 不可写（损坏/fail-closed）：拒绝，quarantine/marker 不动。
    countRejected();
    return { status: "rejected", reason: "receipt_store_fatal", detail: receipt.detail };
  }
  releaseTreasuryQuarantineEntry(entry.transactionId);
  clearMatchingMarker(entry.transactionId, entry.digest);
  const tombstoneWrite = writeResolutionTombstone({
    transactionId: entry.transactionId,
    digest: entry.digest,
    resolution: "committed",
    actionTick: entry.tick,
    settledAtTick: Game.time,
    observationTick: evidence.observationTick,
    resolvedAtTick: Game.time,
  });
  if ("fatal" in tombstoneWrite) {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: tombstoneWrite.fatal };
  }
  recordTreasuryResolutionEvent("committed");
  return {
    status: "resolved",
    resolution: "committed",
    transactionId: entry.transactionId,
    receiptWritten: receipt.status === "written",
    reprepareAllowed: false, // receipt 已写入：同 id 重放命中 already_settled（防重放）
    actionTick: entry.tick,
    settledAtTick: Game.time,
  };
}

/**
 * resolve-as-not-executed：仅在证据明确（observed_not_executed）且 phase 属于
 * execution-unknown 类时释放——不写 receipt、不生成 committed projection、
 * 允许重新 prepare。Game 确认 OK 后的 commit 类 phase 一律拒绝。
 */
export function resolveTreasuryQuarantinedTransactionAsNotExecuted(
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const pre = prevalidate(input);
  if ("stop" in pre) return pre.stop;
  const { entry, evidence } = pre;
  if (evidence.conclusion !== "observed_not_executed") {
    countRejected();
    return {
      status: "rejected",
      reason: "evidence_mismatch",
      detail: `resolve-as-not-executed 需要 observed_not_executed 证据（got ${evidence.conclusion}）`,
    };
  }
  if (!TREASURY_EXECUTION_UNKNOWN_PHASES.has(entry.phase)) {
    countRejected();
    return {
      status: "rejected",
      reason: "resolution_not_allowed",
      detail: `phase ${entry.phase} 表示 Game callback 已确认成功（commit 路径故障）——不允许 resolve-as-not-executed；只能 resolve-as-committed`,
    };
  }
  releaseTreasuryQuarantineEntry(entry.transactionId);
  clearMatchingMarker(entry.transactionId, entry.digest);
  const tombstoneWrite = writeResolutionTombstone({
    transactionId: entry.transactionId,
    digest: entry.digest,
    resolution: "not-executed",
    actionTick: entry.tick,
    observationTick: evidence.observationTick,
    resolvedAtTick: Game.time,
  });
  if ("fatal" in tombstoneWrite) {
    countRejected();
    return { status: "rejected", reason: "resolution_store_full", detail: tombstoneWrite.fatal };
  }
  recordTreasuryResolutionEvent("notExecuted");
  return {
    status: "resolved",
    resolution: "not-executed",
    transactionId: entry.transactionId,
    receiptWritten: false, // 绝不写 receipt / committed projection
    reprepareAllowed: true, // Game 未执行：允许以同 id 重新 prepare
    actionTick: entry.tick,
  };
}

/**
 * 显式 repair（第七轮）：quarantine store 元数据/legacy 形状修复——全量验证
 * 现存 entries 合法后修复 version/entryCount、清除 legacy overflowed 标志；
 * 任何 entry 损坏 → 拒绝（原数据不动，交人工处理）。绝不删除任何 entry。
 */
export function repairTreasuryQuarantineStoreForResolution(): { status: "repaired" | "rejected"; detail: string } {
  return repairTreasuryQuarantineStoreMetadataForResolution();
}

/** 诊断：当前 unresolved write-fault marker（只读）。 */
export function currentTreasuryWriteFaultMarker(): ReturnType<typeof readTreasuryWriteFault> {
  return readTreasuryWriteFault();
}
