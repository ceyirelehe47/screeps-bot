/**
 * Treasury Core Kernel——持久布局（Memory.runtime.treasuryCore）读写与校验。
 *
 * 契约（design §7.2 / A05 / A21 / A24）：
 * - 读取零写：不初始化、不迁移、不 GC。store 不存在 = 合法的 absent
 *   （首次显式初始化发生在第一次接纳时）；损坏 / 未知版本 / 元信息
 *   不自洽 = unhealthy / incompatible，阻断写入，原数据保留，不自动清库。
 * - 一切写入经 applyTreasuryCoreCommand（kernel.ts 单一写入口）——本模块
 *   只提供底层布局原语与校验，不实现业务转移。
 * - 写后读回：安全关键发布（dispatching、outcome、cleanup 关闭）写后立即
 *   read-back 对比，失败按保守方向处理（视为未发布成功 / 结果未知）。
 * - 旧 Treasury Memory（Memory.runtime.treasury 下的业务 store）只检测、
 *   不解析、不擦除：存在即报告 incompatible，阻断新内核写入。
 */

import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_DURABLE_PAYLOAD_MAX,
  TREASURY_CORE_ERROR_DETAIL_MAX,
  TREASURY_CORE_RING_LIMIT,
  TREASURY_CORE_SCHEMA_VERSION,
  TREASURY_CORE_WORST_CASE_LEGS_MAX,
  TREASURY_CORE_WORK_KEY_MAX,
  TREASURY_CORE_ATTEMPT_ID_PREFIX,
  type TreasuryCoreMemory,
  type TreasuryCorePhase,
  type TreasuryCoreRingEntry,
  type TreasuryCoreStoreHealth,
  type TreasuryCoreWorkRecord,
} from "@/runtime/treasury/kernel/types";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

/** 旧 Treasury 业务 store 的已知子键（存在任一非空即视为旧实现数据）。 */
const LEGACY_TREASURY_STORE_KEYS: readonly string[] = [
  "receipts",
  "intents",
  "quarantine",
  "resolutions",
  "resolutionCleanup",
  "attemptLineage",
  "attemptIssuer",
  "issuedAttemptTickets",
  "writeFault",
  "authorizationFaults",
  "retiredAttemptRanges",
  "cleanupCompletions",
  "cleanupSupersessions",
  "chainRetirementCertificates",
  "generationRetirementProofs",
  "lineageRetirementSummaries",
  "completionHeadroomReservations",
];

/** 旧业务数据检测（不读取内容，只看键的存在性与非空）。 */
export function detectLegacyTreasuryStores(): string[] {
  const runtime = Memory.runtime as (Record<string, unknown> & { treasury?: unknown }) | undefined;
  const treasury = runtime?.treasury;
  if (!treasury || typeof treasury !== "object") return [];
  const present: string[] = [];
  for (const key of LEGACY_TREASURY_STORE_KEYS) {
    const value = (treasury as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && Object.keys(value).length === 0) continue;
    present.push(key);
  }
  return present;
}

function coreMemoryRoot(): TreasuryCoreMemory | undefined {
  return (Memory.runtime as { treasuryCore?: TreasuryCoreMemory } | undefined)?.treasuryCore;
}

const VALID_PHASES: readonly TreasuryCorePhase[] = [
  "pending",
  "dispatching",
  "outcome_unknown",
  "closing",
  "retry_ready",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validateWorkRecord(attemptId: string, value: unknown): string | null {
  if (!isPlainObject(value)) return `active[${attemptId}] 非对象`;
  const r = value as Record<string, unknown>;
  if (!boundedString(r.workKey, TREASURY_CORE_WORK_KEY_MAX)) return `active[${attemptId}].workKey 非法`;
  if (!boundedString(r.attemptId, 64) || r.attemptId !== attemptId) {
    return `active[${attemptId}].attemptId 与键不一致`;
  }
  if (!r.attemptId.startsWith(TREASURY_CORE_ATTEMPT_ID_PREFIX)) {
    return `active[${attemptId}].attemptId 前缀非法`;
  }
  if (typeof r.generation !== "number" || !Number.isSafeInteger(r.generation) || r.generation < 1) {
    return `active[${attemptId}].generation 非法`;
  }
  if (r.parentAttemptId !== null && typeof r.parentAttemptId !== "string") {
    return `active[${attemptId}].parentAttemptId 非法`;
  }
  if (typeof r.phase !== "string" || !VALID_PHASES.includes(r.phase as TreasuryCorePhase)) {
    return `active[${attemptId}].phase 非法`;
  }
  if (typeof r.admittedAtTick !== "number" || !Number.isSafeInteger(r.admittedAtTick)) {
    return `active[${attemptId}].admittedAtTick 非法`;
  }
  if (typeof r.updatedAtTick !== "number" || !Number.isSafeInteger(r.updatedAtTick)) {
    return `active[${attemptId}].updatedAtTick 非法`;
  }
  const identity = r.identity;
  if (!isPlainObject(identity)) return `active[${attemptId}].identity 非法`;
  if (!boundedString(identity.actionKind, 64)) return `active[${attemptId}].identity.actionKind 非法`;
  if (typeof identity.adapterVersion !== "number" || !Number.isSafeInteger(identity.adapterVersion) || identity.adapterVersion < 1) {
    return `active[${attemptId}].identity.adapterVersion 非法`;
  }
  if (!boundedString(identity.adapterRegistrationId, 128)) return `active[${attemptId}].identity.adapterRegistrationId 非法`;
  if (!boundedString(identity.adapterSemanticIdentity, 128)) return `active[${attemptId}].identity.adapterSemanticIdentity 非法`;
  if (!boundedString(identity.canonicalDigest, 64)) return `active[${attemptId}].identity.canonicalDigest 非法`;
  if (!boundedString(identity.postingsDigest, 64)) return `active[${attemptId}].identity.postingsDigest 非法`;
  if (identity.retryFactsDigest !== null && !boundedString(identity.retryFactsDigest, 64)) {
    return `active[${attemptId}].identity.retryFactsDigest 非法`;
  }
  if (identity.durableFacts !== null) {
    if (
      !isPlainObject(identity.durableFacts) ||
      typeof identity.durableFacts.version !== "number" ||
      !boundedString(identity.durableFacts.payload, TREASURY_CORE_DURABLE_PAYLOAD_MAX)
    ) {
      return `active[${attemptId}].identity.durableFacts 非法`;
    }
  }
  if (!Array.isArray(r.worstCase) || r.worstCase.length > TREASURY_CORE_WORST_CASE_LEGS_MAX) {
    return `active[${attemptId}].worstCase 非法`;
  }
  for (const leg of r.worstCase) {
    if (
      !isPlainObject(leg) ||
      !boundedString(leg.roomName, 64) ||
      !boundedString(leg.locationKind, 32) ||
      !boundedString(leg.resource, 32) ||
      typeof leg.delta !== "number" ||
      !Number.isSafeInteger(leg.delta) ||
      leg.delta === 0
    ) {
      return `active[${attemptId}].worstCase 腿非法`;
    }
  }
  if (r.invocation !== null && !isPlainObject(r.invocation)) return `active[${attemptId}].invocation 非法`;
  if (r.external !== null && !isPlainObject(r.external)) return `active[${attemptId}].external 非法`;
  if (r.outcome !== "unknown" && r.outcome !== "committed" && r.outcome !== "not_executed") {
    return `active[${attemptId}].outcome 非法`;
  }
  if (r.outcomeEvidence !== null && !isPlainObject(r.outcomeEvidence)) {
    return `active[${attemptId}].outcomeEvidence 非法`;
  }
  if (!isPlainObject(r.cleanup) || !Array.isArray(r.cleanup.consumerKeys)) {
    return `active[${attemptId}].cleanup 非法`;
  }
  for (const key of r.cleanup.consumerKeys) {
    if (typeof key !== "string" || key.length === 0 || key.length > 128) {
      return `active[${attemptId}].cleanup.consumerKeys 条目非法`;
    }
  }
  if (typeof r.cleanup.failures !== "number" || !Number.isSafeInteger(r.cleanup.failures) || r.cleanup.failures < 0) {
    return `active[${attemptId}].cleanup.failures 非法`;
  }
  if (r.retryDeadlineTick !== null && typeof r.retryDeadlineTick !== "number") {
    return `active[${attemptId}].retryDeadlineTick 非法`;
  }
  if (r.lastError !== null && typeof r.lastError !== "string") return `active[${attemptId}].lastError 非法`;
  if (r.lastError !== null && (r.lastError as string).length > TREASURY_CORE_ERROR_DETAIL_MAX) {
    return `active[${attemptId}].lastError 超长`;
  }
  return null;
}

function validateRingEntry(value: unknown): string | null {
  if (!isPlainObject(value)) return "ring 条目非对象";
  if (!boundedString(value.attemptId, 64)) return "ring.attemptId 非法";
  if (!boundedString(value.workKey, TREASURY_CORE_WORK_KEY_MAX)) return "ring.workKey 非法";
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    return "ring.generation 非法";
  }
  if (
    value.terminalPhase !== "committed" &&
    value.terminalPhase !== "not_executed" &&
    value.terminalPhase !== "retry_expired" &&
    value.terminalPhase !== "abandoned"
  ) {
    return "ring.terminalPhase 非法";
  }
  if (typeof value.closedAtTick !== "number" || !Number.isSafeInteger(value.closedAtTick)) {
    return "ring.closedAtTick 非法";
  }
  return null;
}

/**
 * 读取持久布局健康状态（纯读）。absent / healthy / unhealthy / incompatible
 * 四态互斥——不可把损坏折叠为缺失（R2/A05）。
 */
export function readTreasuryCoreStoreHealth(): TreasuryCoreStoreHealth {
  const root = coreMemoryRoot();
  if (root === undefined) return { status: "absent" };
  if (!isPlainObject(root)) {
    return { status: "unhealthy", reason: "Memory.runtime.treasuryCore 非对象" };
  }
  if (root.version === TREASURY_CORE_SCHEMA_VERSION) {
    const problems = validateCoreMemoryContents(root);
    if (problems !== null) return { status: "unhealthy", reason: problems };
    return { status: "healthy", memory: root as unknown as TreasuryCoreMemory };
  }
  if (typeof root.version === "number") {
    return {
      status: "incompatible",
      reason: `treasuryCore schema v${String(root.version)} ≠ 支持版本 v${String(TREASURY_CORE_SCHEMA_VERSION)}`,
    };
  }
  return { status: "unhealthy", reason: "treasuryCore.version 缺失或非数字" };
}

function validateCoreMemoryContents(root: Record<string, unknown>): string | null {
  if (!boundedString(root.installEpochId, 32)) return "installEpochId 非法";
  const issuance = root.issuance;
  if (!isPlainObject(issuance)) return "issuance 非法";
  if (
    typeof issuance.frontier !== "number" ||
    !Number.isSafeInteger(issuance.frontier) ||
    issuance.frontier < 0 ||
    issuance.frontier > 9_999_999_999
  ) {
    return "issuance.frontier 非法（溢出即拒绝分配，不回绕）";
  }
  if (typeof issuance.burned !== "number" || !Number.isSafeInteger(issuance.burned) || issuance.burned < 0) {
    return "issuance.burned 非法";
  }
  if (!isPlainObject(root.lifecycle)) return "lifecycle 非法";
  if (!isPlainObject(root.active)) return "active 非法";
  const attemptIds = Object.keys(root.active);
  if (attemptIds.length > TREASURY_CORE_ACTIVE_LIMIT) return "active 超过容量上限";
  for (const attemptId of attemptIds) {
    const problem = validateWorkRecord(attemptId, root.active[attemptId]);
    if (problem !== null) return problem;
  }
  if (!Array.isArray(root.ring) || root.ring.length > TREASURY_CORE_RING_LIMIT) return "ring 非法";
  for (const entry of root.ring) {
    const problem = validateRingEntry(entry);
    if (problem !== null) return problem;
  }
  if (
    typeof root.ringCursor !== "number" ||
    !Number.isSafeInteger(root.ringCursor) ||
    root.ringCursor < 0 ||
    (root.ring.length > 0 && root.ringCursor > root.ring.length)
  ) {
    return "ringCursor 非法";
  }
  if (!isPlainObject(root.counters)) return "counters 非法";
  for (const value of Object.values(root.counters)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "counters 值非法";
  }
  return null;
}

/**
 * 显式初始化（只在第一次接纳时由内核调用；查询路径绝不触发）。
 * 已存在（任意状态）时返回 false，绝不覆盖。
 */
export function initializeTreasuryCoreStore(nowTick: number): { initialized: boolean; reason?: string } {
  const existing = readTreasuryCoreStoreHealth();
  if (existing.status !== "absent") {
    return { initialized: false, reason: existing.status === "healthy" ? "already_initialized" : existing.reason };
  }
  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  const runtime = Memory.runtime as Record<string, unknown> & { treasuryCore?: unknown };
  const epochSeed = hashTreasuryCanonicalString(`treasury-core-install:${String(nowTick)}:${String(Math.random())}`);
  const fresh: TreasuryCoreMemory = {
    version: TREASURY_CORE_SCHEMA_VERSION,
    installEpochId: epochSeed.slice(0, 16),
    issuance: { frontier: 0, burned: 0 },
    lifecycle: { lastBeginTick: null, lastEndTick: null },
    active: {},
    ring: [],
    ringCursor: 0,
    counters: {
      admitted: 0,
      dispatched: 0,
      settledCommitted: 0,
      settledNotExecuted: 0,
      unknown: 0,
      rearmings: 0,
      rejectedAdmissions: 0,
      recoveryAdvances: 0,
      cleanupFailures: 0,
    },
  };
  runtime.treasuryCore = fresh;
  const readBack = readTreasuryCoreStoreHealth();
  if (readBack.status !== "healthy") {
    delete runtime.treasuryCore;
    return { initialized: false, reason: `初始化读回失败：${readBack.status === "absent" ? "缺失" : readBack.reason}` };
  }
  return { initialized: true };
}

/**
 * 写入辅助：受控写入回调 + 读回校验。回调返回要持久化的完整 record/
 * 结构；本函数 clone 隔离调用方引用，写后按 validator 语义读回。
 * 失败时调用 onRollback（恢复原值）并返回 false——安全关键发布绝不
 * 在读回失败后继续。
 */
export function writeTreasuryCoreMemory(
  mutate: (root: TreasuryCoreMemory) => void,
  onRollback: (snapshot: TreasuryCoreMemory | undefined) => void,
): { status: "written"; memory: TreasuryCoreMemory } | { status: "failed"; reason: string } {
  const runtime = Memory.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime !== "object") return { status: "failed", reason: "Memory.runtime 不可用" };
  const current = runtime.treasuryCore as TreasuryCoreMemory | undefined;
  const snapshot = current === undefined ? undefined : cloneTreasuryDurableValue(current);
  let next: TreasuryCoreMemory;
  if (current === undefined) {
    return { status: "failed", reason: "treasuryCore 未初始化（写入必须先经显式初始化）" };
  }
  next = cloneTreasuryDurableValue(current);
  mutate(next);
  runtime.treasuryCore = next;
  const health = readTreasuryCoreStoreHealth();
  if (health.status !== "healthy") {
    if (snapshot === undefined) delete runtime.treasuryCore;
    else runtime.treasuryCore = snapshot;
    onRollback(snapshot);
    return { status: "failed", reason: `写后读回失败：${health.status === "absent" ? "缺失" : health.reason}` };
  }
  return { status: "written", memory: health.memory };
}

/** 追加近期明细环（满覆盖最旧；ring 故障不阻断安全完成）。 */
export function appendTreasuryCoreRingEntry(memory: TreasuryCoreMemory, entry: TreasuryCoreRingEntry): void {
  if (memory.ring.length < TREASURY_CORE_RING_LIMIT) {
    memory.ring.push(entry);
    memory.ringCursor = memory.ring.length % TREASURY_CORE_RING_LIMIT;
    return;
  }
  memory.ring[memory.ringCursor % TREASURY_CORE_RING_LIMIT] = entry;
  memory.ringCursor = (memory.ringCursor + 1) % TREASURY_CORE_RING_LIMIT;
}
