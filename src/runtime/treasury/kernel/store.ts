/**
 * Treasury Core Kernel——持久布局（Memory.runtime.treasuryCore）读写与校验。
 *
 * 契约（design II §4.2 / §6.4 / §6.5）：
 * - 读取零写：不初始化、不迁移、不 GC。store 不存在 = 合法的 absent；
 *   损坏 / 未知版本 / 安全元信息不自洽 = unhealthy / incompatible，阻断
 *   写入，原数据保留，不自动清库。
 * - 安全校验与 ring（非权威历史）分层：ring 超限/损坏/重复/与 active
 *   重叠只产生 ringDegraded 诊断，不阻断健康安全权威的恢复与收尾（R10）。
 * - 发布确认（publication acknowledgement）：写 = clone 基线 → mutate 草稿
 *   → 基线漂移检查（重入保护）→ 写入 → 读回与草稿深度精确比较 + 安全校验。
 *   读回是另一份合法旧值 / 单安全字段未更新 / 写被丢弃一律视为失败并回滚
 *   （R02）。shape validation（合法形状）≠ publication ack（本次发布成功）。
 * - 完整字段上限：consumerKeys 数量、未知字段（顶层/嵌套）拒绝、计数器
 *   饱和、总序列化预算（R09）。
 * - 旧 Treasury Memory（Memory.runtime.treasury 下的业务 store）只检测、
 *   不解析、不擦除：存在即报告 incompatible，阻断新内核写入。
 */

import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_ADAPTER_VERSION_MAX,
  TREASURY_CORE_ATTEMPT_ID_PREFIX,
  TREASURY_CORE_CONSUMER_KEY_MAX,
  TREASURY_CORE_CONSUMER_KEYS_MAX,
  TREASURY_CORE_COUNTER_SATURATION,
  TREASURY_CORE_DURABLE_PAYLOAD_MAX,
  TREASURY_CORE_ERROR_DETAIL_MAX,
  TREASURY_CORE_EVIDENCE_SOURCE_MAX,
  TREASURY_CORE_GENERATION_MAX,
  TREASURY_CORE_IDENTITY_FIELD_MAX,
  TREASURY_CORE_IDENTITY_LONG_FIELD_MAX,
  TREASURY_CORE_RECOVERY_BUDGET_PER_TICK,
  TREASURY_CORE_RING_LIMIT,
  TREASURY_CORE_ROOM_NAME_MAX,
  TREASURY_CORE_SCHEMA_VERSION,
  TREASURY_CORE_WORST_CASE_LEGS_MAX,
  TREASURY_CORE_WORK_KEY_MAX,
  type TreasuryCoreMemory,
  type TreasuryCorePhase,
  type TreasuryCoreRingEntry,
  type TreasuryCoreSettlementEvidenceKind,
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

const VALID_EVIDENCE_KINDS: readonly TreasuryCoreSettlementEvidenceKind[] = [
  "adapter_execution_semantics",
  "adapter_reconcile",
  "pending_cancellation",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * 受控标识字符集（v3/§8.3）：字母/数字/`_.:@-`——不含引号、反斜杠与
 * 控制字符，JSON 序列化零转义膨胀（槽位上界可精确推导）。
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:@-]+$/;

/** 受控标识字段（零转义膨胀；长度上限之外再加字符集约束）。 */
function boundedIdentifier(value: unknown, max: number): boolean {
  return boundedString(value, max) && IDENTIFIER_PATTERN.test(value as string);
}

/** durable payload 字符集：可打印 ASCII 且排除 `"` 与 `\`（零转义膨胀）。 */
const PAYLOAD_PATTERN = /^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/;

/** 非负安全整数（tick 类字段）。 */
function nonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 未知字段拒绝：结构必须与 schema 完全一致（超限对象不能夹带穿过 validator）。 */
function rejectUnknownFields(value: Record<string, unknown>, label: string, allowed: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return `${label} 含未知字段 ${key}（拒绝，不静默删字段）`;
  }
  return null;
}

const WORK_RECORD_FIELDS = [
  "workKey", "attemptId", "generation", "parentAttemptId", "phase", "admittedAtTick",
  "updatedAtTick", "identity", "worstCase", "invocation", "external", "outcome",
  "outcomeEvidence", "cleanup", "retryDeadlineTick", "lastError",
] as const;
const IDENTITY_FIELDS = [
  "actionKind", "adapterVersion", "adapterRegistrationId", "adapterSemanticIdentity",
  "canonicalDigest", "postingsDigest", "retryFactsDigest", "durableFacts",
] as const;
const LEG_FIELDS = ["roomName", "locationKind", "resource", "delta"] as const;
const EVIDENCE_FIELDS = ["kind", "conclusion", "source", "atTick"] as const;
const CLEANUP_FIELDS = ["consumerKeys", "failures"] as const;

function validateWorkRecord(attemptId: string, value: unknown): string | null {
  if (!isPlainObject(value)) return `active[${attemptId}] 非对象`;
  const r = value;
  let problem = rejectUnknownFields(r, `active[${attemptId}]`, WORK_RECORD_FIELDS);
  if (problem !== null) return problem;
  if (!boundedIdentifier(r.workKey, TREASURY_CORE_WORK_KEY_MAX)) return `active[${attemptId}].workKey 非法`;
  if (!boundedIdentifier(r.attemptId, TREASURY_CORE_IDENTITY_FIELD_MAX) || r.attemptId !== attemptId) {
    return `active[${attemptId}].attemptId 与键不一致`;
  }
  if (!r.attemptId.startsWith(TREASURY_CORE_ATTEMPT_ID_PREFIX)) {
    return `active[${attemptId}].attemptId 前缀非法`;
  }
  if (typeof r.generation !== "number" || !Number.isSafeInteger(r.generation) || r.generation < 1) {
    return `active[${attemptId}].generation 非法`;
  }
  if (r.generation > TREASURY_CORE_GENERATION_MAX) {
    return `active[${attemptId}].generation 超过上限 ${String(TREASURY_CORE_GENERATION_MAX)}（真实强制——槽位上界与 validator 一致）`;
  }
  if (r.parentAttemptId !== null && !boundedIdentifier(r.parentAttemptId, TREASURY_CORE_IDENTITY_FIELD_MAX)) {
    return `active[${attemptId}].parentAttemptId 非法`;
  }
  if (typeof r.phase !== "string" || !VALID_PHASES.includes(r.phase as TreasuryCorePhase)) {
    return `active[${attemptId}].phase 非法`;
  }
  if (!nonNegativeSafeInteger(r.admittedAtTick)) {
    return `active[${attemptId}].admittedAtTick 非法`;
  }
  if (!nonNegativeSafeInteger(r.updatedAtTick)) {
    return `active[${attemptId}].updatedAtTick 非法`;
  }
  const identity = r.identity;
  if (!isPlainObject(identity)) return `active[${attemptId}].identity 非法`;
  problem = rejectUnknownFields(identity, `active[${attemptId}].identity`, IDENTITY_FIELDS);
  if (problem !== null) return problem;
  if (!boundedIdentifier(identity.actionKind, TREASURY_CORE_IDENTITY_FIELD_MAX)) return `active[${attemptId}].identity.actionKind 非法`;
  if (
    typeof identity.adapterVersion !== "number" || !Number.isSafeInteger(identity.adapterVersion) ||
    identity.adapterVersion < 1 || identity.adapterVersion > TREASURY_CORE_ADAPTER_VERSION_MAX
  ) {
    return `active[${attemptId}].identity.adapterVersion 非法（1..${String(TREASURY_CORE_ADAPTER_VERSION_MAX)}）`;
  }
  if (!boundedIdentifier(identity.adapterRegistrationId, TREASURY_CORE_IDENTITY_LONG_FIELD_MAX)) return `active[${attemptId}].identity.adapterRegistrationId 非法`;
  if (typeof identity.adapterSemanticIdentity !== "string" || !boundedIdentifier(identity.adapterSemanticIdentity, TREASURY_CORE_IDENTITY_LONG_FIELD_MAX)) {
    return `active[${attemptId}].identity.adapterSemanticIdentity 非法`;
  }
  if (!boundedIdentifier(identity.canonicalDigest, TREASURY_CORE_IDENTITY_FIELD_MAX)) return `active[${attemptId}].identity.canonicalDigest 非法`;
  if (!boundedIdentifier(identity.postingsDigest, TREASURY_CORE_IDENTITY_FIELD_MAX)) return `active[${attemptId}].identity.postingsDigest 非法`;
  if (identity.retryFactsDigest !== null && !boundedIdentifier(identity.retryFactsDigest, TREASURY_CORE_IDENTITY_FIELD_MAX)) {
    return `active[${attemptId}].identity.retryFactsDigest 非法`;
  }
  if (identity.durableFacts !== null) {
    // durableFacts 白名单 + 完整值校验（R8：不允许在允许字段内夹带无界对象）。
    if (!isPlainObject(identity.durableFacts)) return `active[${attemptId}].identity.durableFacts 非法`;
    problem = rejectUnknownFields(identity.durableFacts, `active[${attemptId}].identity.durableFacts`, ["version", "payload"]);
    if (problem !== null) return problem;
    if (
      typeof identity.durableFacts.version !== "number" ||
      !Number.isSafeInteger(identity.durableFacts.version) ||
      identity.durableFacts.version < 1 ||
      identity.durableFacts.version > 9_999
    ) {
      return `active[${attemptId}].identity.durableFacts.version 非法`;
    }
    if (
      typeof identity.durableFacts.payload !== "string" ||
      !PAYLOAD_PATTERN.test(identity.durableFacts.payload) ||
      identity.durableFacts.payload.length > TREASURY_CORE_DURABLE_PAYLOAD_MAX
    ) {
      return `active[${attemptId}].identity.durableFacts.payload 非法（受控可打印字符集，≤${String(TREASURY_CORE_DURABLE_PAYLOAD_MAX)}）`;
    }
  }
  if (!Array.isArray(r.worstCase) || r.worstCase.length > TREASURY_CORE_WORST_CASE_LEGS_MAX) {
    return `active[${attemptId}].worstCase 非法`;
  }
  for (const leg of r.worstCase) {
    if (!isPlainObject(leg)) return `active[${attemptId}].worstCase 腿非法`;
    problem = rejectUnknownFields(leg, `active[${attemptId}].worstCase 腿`, LEG_FIELDS);
    if (problem !== null) return problem;
    if (
      !boundedIdentifier(leg.roomName, TREASURY_CORE_ROOM_NAME_MAX) ||
      (leg.locationKind !== "storage" && leg.locationKind !== "terminal") ||
      !boundedIdentifier(leg.resource, 32) ||
      typeof leg.delta !== "number" ||
      !Number.isSafeInteger(leg.delta) ||
      leg.delta === 0
    ) {
      return `active[${attemptId}].worstCase 腿非法`;
    }
  }
  if (r.invocation !== null) {
    if (!isPlainObject(r.invocation)) return `active[${attemptId}].invocation 非法`;
    problem = rejectUnknownFields(r.invocation, `active[${attemptId}].invocation`, ["atTick", "worldSequence"]);
    if (problem !== null) return problem;
    if (!nonNegativeSafeInteger(r.invocation.atTick)) return `active[${attemptId}].invocation.atTick 非法`;
    if (r.invocation.worldSequence !== undefined && !nonNegativeSafeInteger(r.invocation.worldSequence)) {
      return `active[${attemptId}].invocation.worldSequence 非法`;
    }
  }
  if (r.external !== null) {
    if (!isPlainObject(r.external)) return `active[${attemptId}].external 非法`;
    problem = rejectUnknownFields(r.external, `active[${attemptId}].external`, ["accepted", "atTick"]);
    if (problem !== null) return problem;
    if (typeof r.external.accepted !== "boolean") return `active[${attemptId}].external.accepted 非法`;
    if (!nonNegativeSafeInteger(r.external.atTick)) return `active[${attemptId}].external.atTick 非法`;
  }
  if (r.outcome !== "unknown" && r.outcome !== "committed" && r.outcome !== "not_executed") {
    return `active[${attemptId}].outcome 非法`;
  }
  if (r.outcomeEvidence !== null) {
    if (!isPlainObject(r.outcomeEvidence)) return `active[${attemptId}].outcomeEvidence 非法`;
    problem = rejectUnknownFields(r.outcomeEvidence, `active[${attemptId}].outcomeEvidence`, EVIDENCE_FIELDS);
    if (problem !== null) return problem;
    const evidence = r.outcomeEvidence;
    if (!VALID_EVIDENCE_KINDS.includes(evidence.kind as TreasuryCoreSettlementEvidenceKind)) {
      return `active[${attemptId}].outcomeEvidence.kind 非法（external_settlement_receipt 已退役）`;
    }
    if (
      evidence.conclusion !== "executed" &&
      evidence.conclusion !== "not_executed" &&
      evidence.conclusion !== "still_uncertain"
    ) {
      return `active[${attemptId}].outcomeEvidence.conclusion 非法`;
    }
    if (!boundedIdentifier(evidence.source, TREASURY_CORE_EVIDENCE_SOURCE_MAX)) {
      return `active[${attemptId}].outcomeEvidence.source 非法`;
    }
    if (!nonNegativeSafeInteger(evidence.atTick)) {
      return `active[${attemptId}].outcomeEvidence.atTick 非法`;
    }
  }
  // 结构矛盾 fail closed（A06/A07/B21/IV §6.4）：结果确定必须有结论一致
  // 的证据；not_executed 与 committed 相反证据 / 缺失证据都不构成合法状态。
  if (r.phase === "closing" || r.phase === "retry_ready") {
    if (r.outcome === "unknown" || r.outcomeEvidence === null) {
      return `active[${attemptId}] 阶段 ${r.phase} 但结果未确定或无证据（结构矛盾）`;
    }
    const expected = r.outcome === "committed" ? "executed" : "not_executed";
    const conclusion = (r.outcomeEvidence as { conclusion: unknown }).conclusion;
    if (conclusion !== expected) {
      return `active[${attemptId}] outcome=${r.outcome} 与证据结论 ${String(conclusion)} 相反（结构矛盾）`;
    }
  }
  // retry_ready 只能是 not_executed + 清理义务已闭合（IV/§6.4）：
  // committed+retry_ready、非空义务+retry_ready 是本地可识别矛盾——安全
  // 读取/命令边界拒绝，不自动升级、不修成空集合。
  if (r.phase === "retry_ready" && r.outcome !== "not_executed") {
    return `active[${attemptId}] retry_ready 但 outcome=${r.outcome}（只允许 not_executed）`;
  }
  if (r.outcome === "unknown" && r.phase !== "pending" && r.phase !== "dispatching" && r.phase !== "outcome_unknown") {
    return `active[${attemptId}] outcome=unknown 但阶段 ${r.phase}（结构矛盾）`;
  }
  if (!isPlainObject(r.cleanup)) return `active[${attemptId}].cleanup 非法`;
  problem = rejectUnknownFields(r.cleanup, `active[${attemptId}].cleanup`, CLEANUP_FIELDS);
  if (problem !== null) return problem;
  if (!Array.isArray(r.cleanup.consumerKeys)) return `active[${attemptId}].cleanup.consumerKeys 非法`;
  // 数量上限（R09）：超限整体拒绝，不截断一半义务。
  if (r.cleanup.consumerKeys.length > TREASURY_CORE_CONSUMER_KEYS_MAX) {
    return `active[${attemptId}].cleanup.consumerKeys 超过上限 ${String(TREASURY_CORE_CONSUMER_KEYS_MAX)}`;
  }
  // IV/§6.4：retry_ready ⇒ 清理义务必须已闭合（空集合）——非空义务 +
  // retry_ready 是本地可识别矛盾，拒绝而不自动清空。
  if (r.phase === "retry_ready" && r.cleanup.consumerKeys.length > 0) {
    return `active[${attemptId}] retry_ready 但清理义务非空（${String(r.cleanup.consumerKeys.length)} 项——矛盾状态）`;
  }
  for (const key of r.cleanup.consumerKeys) {
    if (typeof key !== "string" || key.length === 0 || key.length > TREASURY_CORE_CONSUMER_KEY_MAX || !IDENTIFIER_PATTERN.test(key)) {
      return `active[${attemptId}].cleanup.consumerKeys 条目非法`;
    }
  }
  if (typeof r.cleanup.failures !== "number" || !Number.isSafeInteger(r.cleanup.failures) || r.cleanup.failures < 0) {
    return `active[${attemptId}].cleanup.failures 非法`;
  }
  if (r.retryDeadlineTick !== null && !nonNegativeSafeInteger(r.retryDeadlineTick)) {
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
  const problem = rejectUnknownFields(value, "ring 条目", ["attemptId", "workKey", "generation", "terminalPhase", "closedAtTick"]);
  if (problem !== null) return problem;
  if (!boundedIdentifier(value.attemptId, TREASURY_CORE_IDENTITY_FIELD_MAX)) return "ring.attemptId 非法";
  if (!boundedIdentifier(value.workKey, TREASURY_CORE_WORK_KEY_MAX)) return "ring.workKey 非法";
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
  if (!nonNegativeSafeInteger(value.closedAtTick)) {
    return "ring.closedAtTick 非法";
  }
  return null;
}

/**
 * 安全权威层校验（安装/发行/生命周期/recovery/active/counters）。
 * 返回 null = 安全层健康；非 null = unhealthy（阻断）。
 */
function validateSafetyCore(root: Record<string, unknown>): string | null {
  let problem = rejectUnknownFields(
    root,
    "treasuryCore",
    ["version", "installEpochId", "issuance", "lifecycle", "recovery", "active", "ring", "ringCursor", "counters"],
  );
  if (problem !== null) return problem;
  if (!boundedIdentifier(root.installEpochId, 32)) return "installEpochId 非法";
  const issuance = root.issuance;
  if (!isPlainObject(issuance)) return "issuance 非法";
  problem = rejectUnknownFields(issuance, "issuance", ["frontier", "burned"]);
  if (problem !== null) return problem;
  if (
    typeof issuance.frontier !== "number" ||
    !Number.isSafeInteger(issuance.frontier) ||
    issuance.frontier < 0 ||
    issuance.frontier > TREASURY_CORE_COUNTER_SATURATION
  ) {
    return "issuance.frontier 非法（溢出即拒绝分配，不回绕）";
  }
  if (
    typeof issuance.burned !== "number" ||
    !Number.isSafeInteger(issuance.burned) ||
    issuance.burned < 0 ||
    issuance.burned > TREASURY_CORE_COUNTER_SATURATION
  ) {
    return "issuance.burned 非法";
  }
  if (!isPlainObject(root.lifecycle)) return "lifecycle 非法";
  problem = rejectUnknownFields(root.lifecycle, "lifecycle", ["lastBeginTick", "lastEndTick"]);
  if (problem !== null) return problem;
  for (const key of ["lastBeginTick", "lastEndTick"] as const) {
    const value = root.lifecycle[key];
    if (value !== null && !nonNegativeSafeInteger(value)) return `lifecycle.${key} 非法`;
  }
  const recovery = root.recovery;
  if (!isPlainObject(recovery)) return "recovery 非法（v2 调度区缺失）";
  problem = rejectUnknownFields(recovery, "recovery", ["sweepCursor", "cleanupCursor", "budgetTick", "budgetUsed"]);
  if (problem !== null) return problem;
  for (const key of ["sweepCursor", "cleanupCursor", "budgetTick", "budgetUsed"] as const) {
    const value = recovery[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return `recovery.${key} 非法`;
    }
  }
  if (((recovery as Record<string, unknown>).budgetUsed as number) > TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) {
    return "recovery.budgetUsed 非法（超本 tick 预算记账）";
  }
  if (!isPlainObject(root.active)) return "active 非法";
  const attemptIds = Object.keys(root.active);
  if (attemptIds.length > TREASURY_CORE_ACTIVE_LIMIT) return "active 超过容量上限";
  for (const attemptId of attemptIds) {
    problem = validateWorkRecord(attemptId, root.active[attemptId]);
    if (problem !== null) return problem;
  }
  if (!isPlainObject(root.counters)) return "counters 非法";
  problem = rejectUnknownFields(
    root.counters,
    "counters",
    ["admitted", "dispatched", "settledCommitted", "settledNotExecuted", "unknown", "rearmings", "rejectedAdmissions", "recoveryAdvances", "cleanupFailures"],
  );
  if (problem !== null) return problem;
  for (const value of Object.values(root.counters)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "counters 值非法";
    if (value > TREASURY_CORE_COUNTER_SATURATION) return "counters 值超过饱和上限";
  }
  return null;
}

/**
 * ring（非权威历史）层校验：返回 null（正常）或有界诊断（degraded）。
 * ring 声称的关闭事实不构成独立 settlement 证据——与 active 重叠或重复
 * 只标记 degraded，不阻断核心（design II §6.5）。
 */
function validateRingLayer(root: Record<string, unknown>): string | null {
  if (!Array.isArray(root.ring)) return "ring 非数组";
  if (root.ring.length > TREASURY_CORE_RING_LIMIT) return `ring 超限（${String(root.ring.length)} > ${String(TREASURY_CORE_RING_LIMIT)}）`;
  const seen = new Set<string>();
  for (const entry of root.ring) {
    const problem = validateRingEntry(entry);
    if (problem !== null) return problem;
    const attemptId = (entry as { attemptId: string }).attemptId;
    if (root.active[attemptId] !== undefined) {
      return `ring 与 active 重叠（${attemptId}）——历史明细不可信，以 active 为准`;
    }
    if (seen.has(attemptId)) return `ring 中 attemptId ${attemptId} 重复`;
    seen.add(attemptId);
  }
  if (
    typeof root.ringCursor !== "number" ||
    !Number.isSafeInteger(root.ringCursor) ||
    root.ringCursor < 0 ||
    (root.ring.length > 0 && root.ringCursor > root.ring.length)
  ) {
    return "ringCursor 非法";
  }
  return null;
}

/**
 * 读取持久布局健康状态（纯读）。absent / healthy / unhealthy / incompatible
 * 四态互斥——不可把损坏折叠为缺失（R2/A05）。ring 层问题只附加
 * ringDegraded 诊断，不影响安全四态（R10/B20）。
 */
export function readTreasuryCoreStoreHealth(): TreasuryCoreStoreHealth {
  const root = coreMemoryRoot();
  if (root === undefined) return { status: "absent" };
  if (!isPlainObject(root)) {
    return { status: "unhealthy", reason: "Memory.runtime.treasuryCore 非对象" };
  }
  if (root.version === TREASURY_CORE_SCHEMA_VERSION) {
    const safetyProblem = validateSafetyCore(root);
    if (safetyProblem !== null) return { status: "unhealthy", reason: safetyProblem };
    const ringProblem = validateRingLayer(root);
    return { status: "healthy", memory: root as unknown as TreasuryCoreMemory, ringDegraded: ringProblem };
  }
  if (typeof root.version === "number") {
    return {
      status: "incompatible",
      reason: `treasuryCore schema v${String(root.version)} ≠ 支持版本 v${String(TREASURY_CORE_SCHEMA_VERSION)}`,
    };
  }
  return { status: "unhealthy", reason: "treasuryCore.version 缺失或非数字" };
}

/**
 * 显式初始化（只在第一次接纳时由内核调用；查询路径绝不触发）。
 * 已存在（任意状态）时返回 false，绝不覆盖。初始化本身使用 exact 发布
 * 确认：读回必须与构造的安装目标深度一致。
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
    recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: nowTick, budgetUsed: 0 },
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
  // 独立预期快照（R4/§5.1：初始化与全部安全发布同一契约——预期目标不与
  // 写入载荷共享可变引用）。
  const expected = cloneTreasuryDurableValue(fresh);
  runtime.treasuryCore = fresh;
  const readBack = runtime.treasuryCore;
  if (readBack !== fresh || !treasuryCoreStateEquals(readBack, expected) || validateSafetyCore(readBack as Record<string, unknown>) !== null) {
    // 条件删除（§5.2）：只有当前值仍属于本次失败安装时才撤销；若期间已被
    // 其他合法路径安装/推进，保留该事实、不误删新根。
    const currentNow = runtime.treasuryCore;
    if (currentNow === fresh || (currentNow !== undefined && treasuryCoreStateEquals(currentNow, fresh))) {
      delete runtime.treasuryCore;
    }
    return {
      initialized: false,
      reason: `初始化读回失败：${readBack !== fresh && currentNow === undefined ? "缺失" : "读回与安装目标不一致"}`,
    };
  }
  return { initialized: true };
}

/**
 * 深度结构精确相等（限定 plain data 布局；合法 treasuryCore 是有限深度树）。
 * 用于发布确认：读回对象与预期目标安全快照的逐字段一致，不是引用比较，
 * 也不是只比 phase/revision。
 */
export function treasuryCoreStateEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!treasuryCoreStateEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!treasuryCoreStateEquals(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * 受控写入 + 发布确认（R02/R4/§5.1–§5.2）。角色分离：
 * 1. baseline = 可信旧安全状态快照（失败回滚参考）；
 * 2. draft = 独立草稿，mutate 在其上求得目标；
 * 3. expected = mutate 之后的**独立预期安全快照**（与 draft/读回对象不共享
 *    任何可变嵌套引用）——发布确认的比较目标；
 * 4. draft 作为写入载荷交给存储边界；
 * 5. 读回当前状态与 expected 深度精确比较 + 安全校验。
 *
 * 原地污染防御（R4）：写入边界若原地把载荷改写（如 dispatching→pending）
 * 并返回同一引用，readback === draft 时与 draft 比较自身恒等——因此比较
 * 目标必须是独立快照 expected，而不是载荷本身。
 *
 * 失败回滚是**条件性**的（§5.2）：仅当当前持久值仍属于本次失败发布
 * （与写入载荷深度一致或缺失）时才恢复 baseline；已出现更新的合法安全
 * 推进时不覆盖、保留可判定事实并报告失败。
 */
export function writeTreasuryCoreMemory(
  mutate: (root: TreasuryCoreMemory) => void,
  onRollback: (snapshot: TreasuryCoreMemory | undefined) => void,
): { status: "written"; memory: TreasuryCoreMemory } | { status: "failed"; reason: string } {
  const runtime = Memory.runtime as Record<string, unknown> | undefined;
  if (!runtime || typeof runtime !== "object") return { status: "failed", reason: "Memory.runtime 不可用" };
  const current0 = runtime.treasuryCore as TreasuryCoreMemory | undefined;
  if (current0 === undefined) {
    return { status: "failed", reason: "treasuryCore 未初始化（写入必须先经显式初始化）" };
  }
  const baseline = cloneTreasuryDurableValue(current0);
  const draft = cloneTreasuryDurableValue(current0);
  mutate(draft);
  // 独立预期安全快照：在 draft 可能被写入边界原地污染之前固定下来。
  const expected = cloneTreasuryDurableValue(draft);
  // 基线漂移：mutate 期间（可能重入）持久根被替换或修改 → 拒绝旧草稿。
  const nowValue = runtime.treasuryCore;
  if (nowValue !== current0 || !treasuryCoreStateEquals(nowValue, baseline)) {
    return { status: "failed", reason: "目标基线在写入前已变化（重入保护：拒绝陈旧草稿覆盖）" };
  }
  runtime.treasuryCore = draft;
  const readback = runtime.treasuryCore;
  const exact = treasuryCoreStateEquals(readback, expected);
  const safety = exact ? validateSafetyCore(readback as Record<string, unknown>) : "读回与目标安全状态不一致";
  if (!exact || safety !== null) {
    // 条件回滚（§5.2）：只有当前持久值仍属于本次失败发布时才恢复旧值；
    // 若期间已有更新的合法安全推进（重入推进），保留该事实、不覆盖。
    // 写前 current0 存在、写后缺失（currentNow === undefined）只能由本次
    // 失败发布（丢写/清空）造成——同样属于本次失败发布，恢复 baseline。
    const currentNow = runtime.treasuryCore;
    const stillOurs =
      currentNow === undefined ||
      currentNow === draft ||
      (currentNow !== undefined && treasuryCoreStateEquals(currentNow, draft));
    if (stillOurs) {
      runtime.treasuryCore = baseline;
    }
    onRollback(stillOurs ? baseline : (currentNow as TreasuryCoreMemory | undefined));
    return {
      status: "failed",
      reason: `发布确认失败：${!exact ? "读回与独立预期安全快照不一致（丢写/旧值/原地污染/字段未更新）" : safety}${stillOurs ? "" : "（检测到更新安全状态，保留不覆盖）"}`,
    };
  }
  return { status: "written", memory: readback as TreasuryCoreMemory };
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

/**
 * 重建损坏的 ring 层（丢弃非权威明细；由命令路径在下一次成功写入前调用，
 * 查询路径不修复）。固定大小诊断由调用方记录。
 */
export function resetTreasuryCoreRingLayer(memory: TreasuryCoreMemory): void {
  memory.ring = [];
  memory.ringCursor = 0;
}

/** 当前序列化体积（字符数 = JSON.stringify 长度）。 */
export function treasuryCoreSerializedChars(memory: TreasuryCoreMemory): number {
  try {
    return JSON.stringify(memory).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// ── 逐槽完整生命周期序列化上界（IV/§7.1——构造器实测法） ─────────────────────
//
// III 轮手写公式系统性低估（字段键名两侧引号每处 -2、数字统一按 13 位计
// 而 validator 允许 16 位安全整数（负 delta 17 位）、漏计 invocation.
// worldSequence），按公式常量修正重算后合计 ≈373,226 已超 360,000——上界
// 推导与实际表示漂移不可再靠手算维护。IV 轮改为：构造完整最坏**合法**
// 记录（全部字段取 validator 允许的极值；generation/adapterVersion ≤9,999
// 与腿数 ≤12 由 validator 真实强制），对其做真实 JSON.stringify——上界本身
// 就是一次真实序列化，键引号/冒号/逗号/括号/active 键/数字位宽全部按实际
// 表示计入，不存在推导盲区。合法性由 D21 对照断言（构造器记录过 validator）
// 与逐字段极值单测双向验证；手写公式退役删除。

const WORST_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const WORST_IDENTIFIER_FILLER = "a";

function worstIdentifier(max: number): string {
  return WORST_IDENTIFIER_FILLER.repeat(max);
}

function worstAttemptId(): string {
  // tk1_(4) + 9 位数字 + _(1) + 补齐到 IDENTITY_FIELD_MAX。
  return `tk1_${"9".repeat(9)}_${WORST_IDENTIFIER_FILLER.repeat(TREASURY_CORE_IDENTITY_FIELD_MAX - 14)}`;
}

function worstConsumerKey(index: number): string {
  // ≤CONSUMER_KEY_MAX 且区分条目（尾号不缩短长度上界）。
  return `${WORST_IDENTIFIER_FILLER.repeat(TREASURY_CORE_CONSUMER_KEY_MAX - 2)}${String(index % 10)}${String(index % 10)}`;
}

/**
 * 单活跃聚合完整生命周期最坏合法记录（全部字段取 validator 允许极值；
 * closing+not_executed+非空义务是合法组合中体积最大的形态——evidence/
 * worstCase/invocation/cleanup 全部同时取最大）。
 */
export function buildTreasuryCoreWorstWorkRecord(): TreasuryCoreWorkRecord {
  return {
    workKey: `biz:${worstIdentifier(TREASURY_CORE_WORK_KEY_MAX - 4)}`,
    attemptId: worstAttemptId(),
    generation: TREASURY_CORE_GENERATION_MAX,
    parentAttemptId: worstAttemptId(),
    phase: "closing",
    admittedAtTick: WORST_SAFE_INTEGER,
    updatedAtTick: WORST_SAFE_INTEGER,
    identity: {
      actionKind: worstIdentifier(TREASURY_CORE_IDENTITY_FIELD_MAX),
      adapterVersion: TREASURY_CORE_ADAPTER_VERSION_MAX,
      adapterRegistrationId: worstIdentifier(TREASURY_CORE_IDENTITY_LONG_FIELD_MAX),
      adapterSemanticIdentity: worstIdentifier(TREASURY_CORE_IDENTITY_LONG_FIELD_MAX),
      canonicalDigest: worstIdentifier(TREASURY_CORE_IDENTITY_FIELD_MAX),
      postingsDigest: worstIdentifier(TREASURY_CORE_IDENTITY_FIELD_MAX),
      retryFactsDigest: worstIdentifier(TREASURY_CORE_IDENTITY_FIELD_MAX),
      durableFacts: { version: 9_999, payload: worstIdentifier(TREASURY_CORE_DURABLE_PAYLOAD_MAX) },
    },
    worstCase: Array.from({ length: TREASURY_CORE_WORST_CASE_LEGS_MAX }, () => ({
      roomName: worstIdentifier(TREASURY_CORE_ROOM_NAME_MAX),
      locationKind: "storage",
      resource: worstIdentifier(32),
      delta: -WORST_SAFE_INTEGER,
    })),
    invocation: { atTick: WORST_SAFE_INTEGER, worldSequence: WORST_SAFE_INTEGER },
    external: { accepted: true, atTick: WORST_SAFE_INTEGER },
    outcome: "not_executed",
    outcomeEvidence: {
      kind: "adapter_execution_semantics",
      conclusion: "not_executed",
      source: worstIdentifier(TREASURY_CORE_EVIDENCE_SOURCE_MAX),
      atTick: WORST_SAFE_INTEGER,
    },
    cleanup: {
      consumerKeys: Array.from({ length: TREASURY_CORE_CONSUMER_KEYS_MAX }, (_, i) => worstConsumerKey(i)),
      failures: WORST_SAFE_INTEGER,
    },
    retryDeadlineTick: WORST_SAFE_INTEGER,
    lastError: " ".repeat(TREASURY_CORE_ERROR_DETAIL_MAX),
  };
}

/** 单历史（ring）槽最坏合法条目。 */
export function buildTreasuryCoreWorstRingEntry(): TreasuryCoreRingEntry {
  return {
    attemptId: worstAttemptId(),
    workKey: `biz:${worstIdentifier(TREASURY_CORE_WORK_KEY_MAX - 4)}`,
    generation: TREASURY_CORE_GENERATION_MAX,
    terminalPhase: "retry_expired",
    closedAtTick: WORST_SAFE_INTEGER,
  };
}

/** 根安全/调度元信息最坏合法形态（counters 饱和、tick 极值、空 active/ring 骨架）。 */
function buildTreasuryCoreWorstMeta(): TreasuryCoreMemory {
  return {
    version: TREASURY_CORE_SCHEMA_VERSION,
    installEpochId: worstIdentifier(32),
    issuance: { frontier: TREASURY_CORE_COUNTER_SATURATION, burned: TREASURY_CORE_COUNTER_SATURATION },
    lifecycle: { lastBeginTick: WORST_SAFE_INTEGER, lastEndTick: WORST_SAFE_INTEGER },
    recovery: {
      sweepCursor: TREASURY_CORE_ACTIVE_LIMIT,
      cleanupCursor: TREASURY_CORE_ACTIVE_LIMIT,
      budgetTick: WORST_SAFE_INTEGER,
      budgetUsed: TREASURY_CORE_RECOVERY_BUDGET_PER_TICK,
    },
    active: {},
    ring: [],
    ringCursor: TREASURY_CORE_RING_LIMIT,
    counters: {
      admitted: TREASURY_CORE_COUNTER_SATURATION,
      dispatched: TREASURY_CORE_COUNTER_SATURATION,
      settledCommitted: TREASURY_CORE_COUNTER_SATURATION,
      settledNotExecuted: TREASURY_CORE_COUNTER_SATURATION,
      unknown: TREASURY_CORE_COUNTER_SATURATION,
      rearmings: TREASURY_CORE_COUNTER_SATURATION,
      rejectedAdmissions: TREASURY_CORE_COUNTER_SATURATION,
      recoveryAdvances: TREASURY_CORE_COUNTER_SATURATION,
      cleanupFailures: TREASURY_CORE_COUNTER_SATURATION,
    },
  };
}

let slotWorstCharsCache: number | undefined;
let ringSlotWorstCharsCache: number | undefined;
let metaWorstCharsCache: number | undefined;

/** 单活跃槽完整生命周期最坏序列化字符（真实 JSON 实测，含 active 键）。 */
export function treasuryCoreSlotWorstChars(): number {
  if (slotWorstCharsCache === undefined) {
    const record = buildTreasuryCoreWorstWorkRecord();
    slotWorstCharsCache = JSON.stringify({ [record.attemptId]: record }).length;
  }
  return slotWorstCharsCache;
}

/** 单历史槽最坏序列化字符（真实 JSON 实测，含数组内逗号份额）。 */
export function treasuryCoreRingSlotWorstChars(): number {
  if (ringSlotWorstCharsCache === undefined) {
    ringSlotWorstCharsCache = JSON.stringify(buildTreasuryCoreWorstRingEntry()).length + 1; // 数组分隔逗号
  }
  return ringSlotWorstCharsCache;
}

/** 根安全元信息最坏序列化字符（真实 JSON 实测）。 */
export function treasuryCoreMetaWorstChars(): number {
  if (metaWorstCharsCache === undefined) {
    metaWorstCharsCache = JSON.stringify(buildTreasuryCoreWorstMeta()).length;
  }
  return metaWorstCharsCache;
}
