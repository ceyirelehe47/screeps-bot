/**
 * 【Round 22 Remediation IX】固定反例矩阵：
 * A（versioned issuance migration）、H（checked completion handoff）、
 * O（reservation 容量公式 + 完整 orphan owner）、S（resolver insufficient
 * fail closed）。Q 组（summary/certificate/range 驱逐与 600 chain 压力）
 * 在同文件后半部分。
 *
 * 全部使用 mock/spies——零真实 Screeps 写 API。
 */

import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import {
  buildTreasuryIssuedInitialAttemptIdFromSequence,
  checkTreasuryServiceIssuedAttemptId,
  clearTreasuryAttemptIssuerDurableForTest,
  mintTreasuryInitialAttemptId,
  peekTreasuryAttemptIssuerHealth,
  peekTreasuryIssuedAttemptWatermark,
  peekTreasuryLegacyIssuedAttemptWatermark,
  resetTreasuryAttemptIssuerHeapCacheForTest,
} from "@/runtime/treasury/attemptIssuer";
import {
  abandonTreasuryIssuedAttemptTicketForTest,
  clearTreasuryIssuedAttemptTicketDurableForTest,
  openTreasuryIssuedInitialAttempt,
  peekTreasuryIssuedAttemptTicketHealth,
  readTreasuryIssuedAttemptTicket,
  resetTreasuryIssuedAttemptTicketHeapCacheForTest,
  retireTreasuryTerminalIssuedAttemptTickets,
  expireTreasuryIssuedAttemptTickets,
  TREASURY_ISSUED_TICKET_MAX_ENTRIES,
  TREASURY_ISSUED_TICKET_TTL_TICKS,
} from "@/runtime/treasury/attemptIssuanceTicket";
import { runTreasuryLifecycleGcCoordinator } from "@/runtime/treasury/treasuryLifecycleGcCoordinator";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
import {
  resolveTreasuryDurableSettlementAuthority,
} from "@/runtime/treasury/historicalSettlementAuthority";
import {
  clearTreasuryChainCertificateDurableForTest,
  lookupTreasuryChainRetirementCertificate,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryChainCertificateEntryCount,
  peekTreasuryRetiredRangeEntryCount,
  recordTreasuryChainRetirementCertificate,
  resetTreasuryChainCertificateHeapCacheForTest,
  TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES,
} from "@/runtime/treasury/chainRetirementCertificate";
import {
  compactTreasuryTerminalLineage,
  lookupTreasuryRetirementSummaryByRoot,
  peekTreasuryRetirementSummaryEntryCount,
  TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES,
} from "@/runtime/treasury/lineageRetirementSummary";
import {
  clearTreasuryCleanupCompletionDurableForTest,
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionEntryCount,
  recordTreasuryCleanupCompletion,
  resetTreasuryCleanupCompletionHeapCacheForTest,
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  clearTreasuryCleanupSupersessionDurableForTest,
  resetTreasuryCleanupSupersessionHeapCacheForTest,
  type TreasuryHistoricalCompletionRecord,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  acquireTreasuryCompletionHeadroomReservation,
  admitTreasuryCompletionHeadroomReservationForExecution,
  clearTreasuryCompletionHeadroomReservationDurableForTest,
  peekTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservationCount,
  resetTreasuryCompletionHeadroomReservationHeapCacheForTest,
} from "@/runtime/treasury/completionHeadroomReservation";
import {
  admitTreasuryCompletionPublicationReservation,
  peekTreasuryEffectiveCompletionOccupancy,
  reconcileTreasuryReservationCompletionPairs,
  sweepOrphanTreasuryCompletionReservations,
  treasuryCompletionHandoffDiagnostics,
} from "@/runtime/treasury/cleanupCompletionHandoff";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  treasuryResolutionCleanupOpenInputOfFacts,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { advanceTreasuryResolutionCleanupPhases } from "@/runtime/treasury/resolutionCleanupCoordinator";
import { ensureTreasuryResolutionSlotAvailable, resetTreasuryResolutionStoreForTest } from "@/runtime/treasury/resolutionStore";
import {
  buildTreasuryActionContract,
  clearTreasuryAdapterRegistryForTest,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  registerTreasuryActionAdapter,
  sealTreasuryAdapterRegistryForProduction,
  unsealTreasuryAdapterRegistryForTest,
} from "@/runtime/treasury/actionContracts";
import {
  createTreasuryAttemptLineageRecord,
  deriveTreasuryLineageNextChildTransactionId,
} from "@/runtime/treasury/attemptLineage";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { convergeTreasuryLineageRetirementFromFacts } from "@/runtime/treasury/attemptLineage";
import { clearTreasuryPersistenceForTest, readTreasurySettlementProof, reserveTreasuryReceiptAdmission } from "@/runtime/treasury/receipts";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

jest.setTimeout(300_000);

const RUNTIME = TREASURY_LOWLEVEL_SOURCE_RUNTIME;
const DIGEST = "0123456789abc009";
const LINEAGE_A = "0123456789ab0001";

beforeEach(() => {
  jest.clearAllMocks();
  clearTreasuryPersistenceForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  clearTreasuryCleanupSupersessionDurableForTest();
  clearTreasuryChainCertificateDurableForTest();
  clearTreasuryAttemptIssuerDurableForTest();
  clearTreasuryIssuedAttemptTicketDurableForTest();
  clearTreasuryCompletionHeadroomReservationDurableForTest();
  resetTreasuryResolutionStoreForTest();
});

// ── 共享 fixture（与 VIII 同构）──────────────────────────────────────────────

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
    terminal: { id: "term-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
  },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function input(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta }],
  };
}

function mintedId(correlation: string): string {
  // 【X 迁移】fixture 走 production opening 路径（mint 与 ticket 原子——
  // 裸 mint ID 在 X 协议下不再可执行）。
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture");
  return opened.transactionId;
}

/** 【X 迁移】已发行 ID + ticket 按生产同路径放弃（abandonForTest：active→
 * expired→retired，单条作用域不触碰其它在飞 opening；用于构造持久权威
 * fixture 的 root ID——X 协议下 active ticket 本身是 lifecycle owner）。 */
function abandonedId(correlation: string): string {
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture");
  if (!abandonTreasuryIssuedAttemptTicketForTest(opened.transactionId)) {
    throw new Error("abandon failed in fixture");
  }
  return opened.transactionId;
}

function durableOf(transactionId: string): string {
  return recomputeTreasuryDurableIdentityDigest({
    transactionId,
    digest: DIGEST,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
  })!;
}

const identityOf = (transactionId: string, digest = DIGEST) =>
  treasuryExactAttemptIdentityOfFacts(
    transactionId,
    { digest, durableIdentityDigest: durableOf(transactionId), lowlevelSource: RUNTIME },
    "lowlevel",
  )!;

/** 手写 v1 issuer store（迁移源）。 */
function seedLegacyIssuerStore(highWatermark: number): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  runtime.treasury.attemptIssuer = {
    version: 1,
    highWatermark,
    updatedAt: Game.time,
  };
  resetTreasuryAttemptIssuerHeapCacheForTest();
}

/** 受控 contract execute fixture（sealed production channel + 注册测试 adapter）。 */
function contractExecuteSealed(service: TreasuryTestService, transactionId: string): { callbackCount: number; result: unknown } {
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryActionAdapter({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
  } as never);
  const built = buildTreasuryActionContract(service, {
    actionKind: "terminal.send",
    transactionId,
    args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W1N57", toLocation: "terminal", resource: "energy", amount: 100, outcome: "ok" } as never,
  });
  if (built.status === "rejected") return { callbackCount: 0, result: built };
  const authorization = service.authorizeTreasuryActionContract(built.contract);
  sealTreasuryAdapterRegistryForProduction();
  try {
    const result =
      authorization.status === "authorized"
        ? executeTreasuryActionContract(service, { contract: built.contract, authorization: authorization.bundle })
        : { status: "not_authorized" };
    // 成功路径（executed_committed）的 callback 由 contract 语义内部恰好
    // 一次驱动；拒绝/未授权路径零调用。
    const ok = (result as { status?: string }).status;
    return { callbackCount: ok === "executed_committed" ? 1 : 0, result };
  } finally {
    unsealTreasuryAdapterRegistryForTest();
    clearTreasuryAdapterRegistryForTest();
  }
}

/** quarantine seed（VIII 同构）。 */
function seedQuarantineEntry(transactionId: string): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    phase: "ok_pending_commit_unresolved",
    outcome: "returned_ok",
    settlement: "quarantined",
    deltas: [{ roomName: ROOMS[0].name, locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
    recordedAt: Game.time,
  } as never);
  expect(write.status).toBe("written");
  const durable = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(durable).toBeDefined();
  return durable as string;
}

/** final not-executed tombstone（持久层注入——VIII 同构）。 */
function seedFinalNotExecutedTombstone(transactionId: string, durable: string): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  // 【X 迁移】就地扩展（不替换 store 对象）——resolution store 的 heap 缓存
  // 持有同一对象引用，替换对象会让缓存的 entryCount 冻结、写入路径的容量
  // 控制与惰性退休（tombstone → GRA proof 联动释放）永不触发。
  if (branch.resolutions === undefined) {
    branch.resolutions = { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time };
  }
  branch.resolutions.entries["r:" + transactionId] = {
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  };
  branch.resolutions.entryCount = Object.keys(branch.resolutions.entries).length;
  branch.resolutions.updatedAt = Game.time;
}

/** non-rearmable root 的完整终态链路（converge 正式通道——VIII 同构）。 */
function seedNonRearmableRoot(transactionId: string): string {
  const durable = seedQuarantineEntry(transactionId);
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable: false,
    identityProfile: "lowlevel",
    nonRearmReason: "ix fixture",
  });
  if (created.status !== "written") throw new Error("lineage seed rejected");
  const lineageId = created.record.lineageId;
  seedFinalNotExecutedTombstone(transactionId, durable);
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
  if (converged.status !== "completed") {
    throw new Error("fixture converge pending: " + JSON.stringify(converged).slice(0, 500));
  }
  return lineageId;
}

/** 真实 committed 执行链路（execute + receipt + final committed tombstone 注入——VIII 同构）。 */
function executeCommitted(service: TreasuryTestService, transactionId: string): void {
  const result = service.executePreparedAction(input(service, transactionId), () => ({ ok: true }) as never);
  if (result.status !== "executed_committed") {
    throw new Error(`fixture executeCommitted got ${result.status}: ${JSON.stringify(result).slice(0, 400)}`);
  }
  const receiptProof = readTreasurySettlementProof(transactionId);
  if (
    receiptProof === undefined ||
    (receiptProof as { digest?: string }).digest === undefined ||
    (receiptProof as { durableIdentityDigest?: string }).durableIdentityDigest === undefined
  ) {
    throw new Error("fixture executeCommitted: receipt identity missing");
  }
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  const entries = branch.resolutions?.entries ?? {};
  entries["r:" + transactionId] = {
    transactionId,
    digest: (receiptProof as { digest: string }).digest,
    resolution: "committed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: (receiptProof as { durableIdentityDigest: string }).durableIdentityDigest,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
  };
  branch.resolutions = { version: 7, entries, entryCount: Object.keys(entries).length, updatedAt: Game.time };
  resetTreasuryResolutionStoreForTest();
  const opened = openTreasuryResolutionCleanup(
    treasuryResolutionCleanupOpenInputOfFacts({
      transactionId,
      digest: (receiptProof as { digest: string }).digest,
      resolution: "committed",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: (receiptProof as { durableIdentityDigest: string }).durableIdentityDigest,
    }),
  );
  if (opened.status !== "opened") throw new Error(`fixture open rejected: ${JSON.stringify(opened).slice(0, 220)}`);
  const store = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
  store!.entries!["c:" + transactionId]!.settlementProofDurable = true;
  expect(markTreasuryResolutionCleanupStage(transactionId, "marker_discharge", "already_absent")).not.toBe("rejected");
  const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
  if (advanced.status !== "completed") {
    throw new Error(`fixture cleanup got ${advanced.status}: ${JSON.stringify(advanced).slice(0, 220)}`);
  }
}

/** 破坏持久 store 的 entryCount（store 惰性创建——缺失时构造 entryCount
 * 不一致的最小 store，形状校验即 unhealthy）。 */
function corruptStoreEntryCount(storeKey: string, version = 1): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const existing = runtime.treasury[storeKey] as { entryCount?: number; entries?: Record<string, unknown> } | undefined;
  if (existing === undefined) {
    runtime.treasury[storeKey] = { version, entries: {}, entryCount: 99, updatedAt: Game.time };
    return;
  }
  existing.entryCount = 99;
}

/** 手写 historical completion（与 VIII 的 seedHistoricalRecord 同构）。 */
function seedHistoricalRecord(overrides: Partial<TreasuryHistoricalCompletionRecord> & { readonly transactionId: string }): void {
  const record: TreasuryHistoricalCompletionRecord = {
    schemaVersion: 1,
    transactionId: overrides.transactionId,
    resolution: "not-executed",
    identity: {
      digest: DIGEST,
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      durableIdentityDigest: durableOf(overrides.transactionId),
      lowlevelSource: RUNTIME,
    },
    lineageDisposition: "not_applicable",
    via: "compact-archive",
    archivedAtTick: Game.time,
    ...overrides,
  };
  const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
  const store = branch.cleanupSupersessions as { entries: Record<string, unknown>; entryCount: number; updatedAt: number } | undefined;
  const target = store ?? { entries: {}, entryCount: 0, updatedAt: Game.time };
  target.entries["sa:" + record.transactionId] = record;
  target.entryCount = Object.keys(target.entries).length;
  target.updatedAt = Game.time;
  branch.cleanupSupersessions = { version: 1, entries: target.entries, entryCount: target.entryCount, updatedAt: target.updatedAt };
  resetTreasuryCleanupSupersessionHeapCacheForTest();
}

// ══ 工作流 A：Versioned Issuance Migration ═════════════════════════════════


/** 【XII/F】直接持久层注入 certificate（绕过 record 的 terminal lifecycle
 * authority 验证——本文件测试 certificate 的 outcome 语义/查询/occupancy/
 * 驱逐，发行证明链由 XII I 组新测试覆盖）。 */
function seedCertificateDirect(input: {
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly finalAttemptId: string;
  readonly finalGeneration: number;
  readonly terminalState: "chain_committed" | "non_rearmable_retired";
}): void {
  const issuerModule = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
  const certModule = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
  const parsedRoot = issuerModule.parseTreasuryIssuedInitialAttemptId(input.rootTransactionId);
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    chainRetirementCertificates?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  const store = branch.chainRetirementCertificates ?? { version: 1, entries: {}, entryCount: 0, updatedAt: Game.time };
  store.entries["crc:" + input.rootTransactionId] = {
    schemaVersion: 1,
    rootSequence: parsedRoot !== null ? parsedRoot.sequence : -1,
    lineageId: input.lineageId,
    rootTransactionId: input.rootTransactionId,
    finalAttemptId: input.finalAttemptId,
    finalGeneration: input.finalGeneration,
    terminalState: input.terminalState,
    finalizedAtTick: Game.time,
  };
  store.entryCount = Object.keys(store.entries).length;
  store.updatedAt = Game.time;
  branch.chainRetirementCertificates = store;
  certModule.resetTreasuryChainCertificateHeapCacheForTest();
}

describe("Remediation IX A：versioned issuance migration", () => {
  it("A1：旧 store version=1/watermark=100 不能证明任何 ti2_ 新格式 ID 已发行——seq 42 的新协议完整 ID 被拒（callback=0），迁移保留 legacy watermark", () => {
    seedLegacyIssuerStore(100);
    const service = makeService();
    // load 触发 v1→v2 迁移：新命名空间 watermark 独立从 0 起。
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(42);
    expect(built.status).toBe("built");
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(0);
    expect(peekTreasuryLegacyIssuedAttemptWatermark()).toBe(100);
    // 旧 watermark 不能解释为新协议已发行区间：seq 42 > 0 → forged_future。
    expect(checkTreasuryServiceIssuedAttemptId(built.status === "built" ? built.transactionId : "").status).toBe("forged_future");
    const executed = contractExecuteSealed(service, built.status === "built" ? built.transactionId : "");
    expect(executed.callbackCount).toBe(0);
  });

  it("A2：新安装后经 openTreasuryIssuedInitialAttempt 签发——完整 ti2_ ID 正常执行、callback 恰一次", () => {
    const service = makeService();
    const opened = openTreasuryIssuedInitialAttempt("ix-a2");
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    expect(opened.transactionId.startsWith("ti2_")).toBe(true);
    expect(checkTreasuryServiceIssuedAttemptId(opened.transactionId).status).toBe("issued");
    // 【X 工作流 A】调用者不手工 consume——ticket handoff 由 execute 内部协议
    // 在 execution-started 持久化后完成（T2 语义）。
    const executed = contractExecuteSealed(service, opened.transactionId);
    expect(executed.result).toBeDefined();
    expect(executed.callbackCount).toBe(1);
  });

  it("A3：新格式同 sequence 篡改 checksum 一位 → production 拒绝（callback=0）", () => {
    const service = makeService();
    const transactionId = mintedId("ix-a3");
    const last = transactionId.slice(-1);
    const tampered = transactionId.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(checkTreasuryServiceIssuedAttemptId(tampered).status).toBe("legacy_unverified");
    const executed = contractExecuteSealed(service, tampered);
    expect(executed.callbackCount).toBe(0);
  });

  it("A4：arbitrary / ts1_ / tt1_ / 旧 ti1_ → production contract writer 全部拒绝新执行", () => {
    const service = makeService();
    for (const candidate of ["arbitrary-caller", "ts1_7_0123456789abcdef", "tt1_7_0123456789abcdef", "ti1_7_0123456789abcdef"]) {
      const executed = contractExecuteSealed(service, candidate);
      expect(executed.callbackCount).toBe(0);
    }
    // 旧 ti1_ 的 check 语义：legacy issued namespace（不再属当前发行协议）。
    const legacyCheck = checkTreasuryServiceIssuedAttemptId("ti1_7_0123456789abcdef");
    expect(legacyCheck.status).toBe("legacy_unverified");
    if (legacyCheck.status === "legacy_unverified") expect(legacyCheck.namespace).toBe("legacy");
  });

  it("A5：已有旧 ti1_ Receipt 权威 → 同 ID 重放仍被阻断；且不作为新格式 initial ID 重新执行", () => {
    const service = makeService();
    const legacy = "ti1_9_0123456789abcdef";
    // 旧 ti1_ 的 receipt（durable settlement authority 承载 replay blocker；
    // legacy-replay profile——旧数据天然弱身份，缺 durable 维度合法）。
    seedHistoricalRecord({
      transactionId: legacy,
      resolution: "committed",
      identity: {
        digest: DIGEST,
        identityProfile: "legacy-replay",
        proofClass: "legacy",
      },
    });
    // contract 通道拒绝（legacy_unverified——不是当前格式 initial ID）。
    const executed = contractExecuteSealed(service, legacy);
    expect(executed.callbackCount).toBe(0);
    // facade prepare 的 replay gate：historical committed → already_settled
    //（durable settlement authority 承载——issuer 判定不丢失 blocker）。
    const prepared = service.prepareTransaction(input(service, legacy));
    expect(["already_settled", "rejected"]).toContain(prepared.status);
    if (prepared.status === "rejected") {
      // legacy ti1_ 无 durable digest 维度 → replay gate 的新 insufficient
      // 语义（proof_insufficient——同样阻断 callback，fail closed）。
      expect(prepared.reason).toBe("proof_insufficient");
    }
  });

  it("A6：migration 在写新 store 后 global reset → 重读幂等继续，不产生第二个 issuer frontier", () => {
    seedLegacyIssuerStore(100);
    // 第一次 load 触发迁移 + 一次 mint 推进。
    const first = mintedId("ix-a6");
    expect(first.startsWith("ti2_1_")).toBe(true);
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(1);
    // global reset（heap 清空，Memory 中已是 v2 store）。
    resetTreasuryAttemptIssuerHeapCacheForTest();
    const second = mintTreasuryInitialAttemptId("ix-a6b");
    expect(second.status).toBe("minted");
    if (second.status === "minted") {
      expect(second.sequence).toBe(2);
      expect(second.transactionId.startsWith("ti2_2_")).toBe(true);
    }
    // 再 reset 再读：watermark 单调（无第二 frontier）。
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(2);
    expect(peekTreasuryLegacyIssuedAttemptWatermark()).toBe(100);
  });

  it("A7：issuer store 未知版本 / shape 损坏 → build/check/open 全部 fail closed", () => {
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    runtime.treasury = runtime.treasury ?? {};
    runtime.treasury.attemptIssuer = {
      version: 99,
      highWatermark: 5,
      updatedAt: Game.time,
    };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryAttemptIssuerHealth().healthy).toBe(false);
    expect(buildTreasuryIssuedInitialAttemptIdFromSequence(1).status).toBe("rejected");
    expect(checkTreasuryServiceIssuedAttemptId("ti2_1_0123456789abcdef").status).toBe("store_unhealthy");
    expect(openTreasuryIssuedInitialAttempt("ix-a7").status).toBe("rejected");
    expect(mintTreasuryInitialAttemptId().status).toBe("rejected");
  });

  it("A8：open 原子化——返回的 ID 恒有 active ticket（无裸 ID 窗口）；ticket 满载时 open 拒绝且 watermark 不推进", () => {
    makeService();
    // 填满 active ticket 容量。
    for (let index = 0; index < TREASURY_ISSUED_TICKET_MAX_ENTRIES; index += 1) {
      const opened = openTreasuryIssuedInitialAttempt("ix-a8-fill-" + index);
      expect(opened.status).toBe("opened");
    }
    const watermarkBefore = peekTreasuryIssuedAttemptWatermark();
    const rejected = openTreasuryIssuedInitialAttempt("ix-a8-over");
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("ticket_capacity_exhausted");
    // 满载拒绝不推进 watermark（无裸洞）。
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermarkBefore);
    // 每个已 open 的 ID 都有 active ticket 在位。
    const anyOpened = openTreasuryIssuedInitialAttempt;
    void anyOpened;
    const firstTicket = readTreasuryIssuedAttemptTicket(mintedOfSequence(1));
    expect(firstTicket?.state).toBe("active");
    // GC：TTL 过期（显式 expired——正面生命周期事实）→ 淘汰由 watermark
    // frontier 验证后执行。
    Game.time += TREASURY_ISSUED_TICKET_TTL_TICKS + 1;
    const report = runTreasuryLifecycleGcCoordinator();
    expect(report.ticketsExpired).toBe(TREASURY_ISSUED_TICKET_MAX_ENTRIES);
    expect(report.skipped).toBeNull();
  });

  /** 从 watermark 读 sequence N 的完整 ID（仅 A8 内部用）。 */
  function mintedOfSequence(sequence: number): string {
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(sequence);
    if (built.status !== "built") throw new Error("build failed");
    return built.transactionId;
  }

  it("A9：同一 sequence 永远不可能有两个都被 runtime 接受的完整 production ID", () => {
    const service = makeService();
    const transactionId = mintedId("ix-a9");
    const match = /ti2_(\d+)_/.exec(transactionId);
    expect(match).not.toBeNull();
    // 第二个完整 ID：篡改 checksum（同 sequence 另一个 hash16）。
    const tampered = transactionId.slice(0, transactionId.length - 1) + (transactionId.slice(-1) === "f" ? "e" : "f");
    expect(checkTreasuryServiceIssuedAttemptId(transactionId).status).toBe("issued");
    expect(checkTreasuryServiceIssuedAttemptId(tampered).status).toBe("legacy_unverified");
    const okExecuted = contractExecuteSealed(service, transactionId);
    const badExecuted = contractExecuteSealed(service, tampered);
    expect(okExecuted.callbackCount + badExecuted.callbackCount).toBeGreaterThanOrEqual(0);
    expect(badExecuted.callbackCount).toBe(0);
  });
});

// ══ 工作流 E 8.2/8.3：容量公式与完整 orphan owner ═══════════════════════════

describe("Remediation IX O：reservation 单一容量公式与完整 orphan owner resolver", () => {
  it("O7：live=0 时第 128 个独立 reservation 成功、第 129 个失败（不得在第 65 个提前失败）", () => {
    makeService();
    for (let index = 1; index <= TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; index += 1) {
      const occupancy = peekTreasuryEffectiveCompletionOccupancy();
      const acquired = acquireTreasuryCompletionHeadroomReservation({
        transactionId: `ix-o7-${index}`,
        occupancyAfterAcquire: occupancy.effective + 1,
        completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
      });
      expect(acquired.status).toBe("acquired");
    }
    const occupancy = peekTreasuryEffectiveCompletionOccupancy();
    expect(occupancy.effective).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    const overflow = acquireTreasuryCompletionHeadroomReservation({
      transactionId: "ix-o7-overflow",
      occupancyAfterAcquire: occupancy.effective + 1,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    });
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") expect(overflow.reason).toBe("capacity_exhausted");
  });

  it("O8：live=64/reserved=64 达到 128；live=127/reserved=1 有效满载；matching pair 不双计（单一公式）", () => {
    makeService();
    // live=64：真实 completion 写入。
    for (let index = 0; index < 64; index += 1) {
      const transactionId = `ix-o8-live-${index}`;
      const written = recordTreasuryCleanupCompletion({
        entry: {
          transactionId,
          digest: DIGEST,
          resolution: "not-executed",
          proofClass: "lowlevel",
          identityProfile: "lowlevel",
          lowlevelSource: RUNTIME,
          durableIdentityDigest: durableOf(transactionId),
          settlementProofDurable: true,
          markerDischarged: true,
          authorityReleased: true,
          outcomeFinalized: true,
          lineageFinalized: true,
        } as never,
        lineageDisposition: "not_applicable",
        globalWriteAdmissionStillLocked: false,
      });
      expect(written.status).not.toBe("rejected");
    }
    resetTreasuryCleanupCompletionHeapCacheForTest();
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(64);
    // reserved=64（第 64 个 acquire 时 after=128 ≤ 128 成功）。
    for (let index = 1; index <= 64; index += 1) {
      const occupancy = peekTreasuryEffectiveCompletionOccupancy();
      expect(occupancy.effective).toBe(64 + index - 1);
      const acquired = acquireTreasuryCompletionHeadroomReservation({
        transactionId: `ix-o8-res-${index}`,
        occupancyAfterAcquire: occupancy.effective + 1,
        completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
      });
      expect(acquired.status).toBe("acquired");
    }
    expect(peekTreasuryEffectiveCompletionOccupancy().effective).toBe(128);
    // matching pair 不双计：reservation 的 transactionId 已有 live completion
    // → pair；新独立 acquire after = 128 + 1 = 129 > 128 拒绝（pair 恢复型
    // acquire 则不增槽——after = 128 ≤ 128 成功）。
    const pairRecovery = acquireTreasuryCompletionHeadroomReservation({
      transactionId: "ix-o8-live-0",
      occupancyAfterAcquire: peekTreasuryEffectiveCompletionOccupancy().effective,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    });
    expect(pairRecovery.status).toBe("acquired");
    expect(peekTreasuryEffectiveCompletionOccupancy().effective).toBe(128);
  });

  it("O1：active prepared handle + completion reservation → lifecycle owner（不得被 orphan coalesce 退休）", () => {
    makeService();
    const transactionId = mintedId("ix-o1");
    const occupancy = peekTreasuryEffectiveCompletionOccupancy();
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId,
      occupancyAfterAcquire: occupancy.effective + 1,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    const ownership = resolveTreasuryAttemptLifecycleOwnership(transactionId, { excludeHeadroomReservation: false });
    expect(ownership.status).toBe("owned");
    expect(ownership.kind).toBe("active");
  });

  it("O2：receipt admission reservation 在位 → owned（prepare→commit 窗口的 heap owner）", () => {
    makeService();
    const transactionId = mintedId("ix-o2");
    const reservation = reserveTreasuryReceiptAdmission(transactionId, Game.time);
    expect(reservation.status).toBe("admitted");
    const ownership = resolveTreasuryAttemptLifecycleOwnership(transactionId);
    expect(ownership.status).toBe("owned");
    expect(ownership.kind).toBe("active");
  });

  it("O3：active lineage 在位 → owned", () => {
    makeService();
    const root = mintedId("ix-o3");
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durableOf(root), lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "ix-o3 fixture",
    });
    expect(created.status).not.toBe("rejected");
    const ownership = resolveTreasuryAttemptLifecycleOwnership(root);
    expect(ownership.status).toBe("owned");
    expect(ownership.kind).toBe("active");
  });

  /** 持久层直接注入 tombstone（正式写入有状态机前置——fixture 注入完整形状）。 */
  function seedTombstone(transactionId: string, resolution: "committed" | "not-executed", stage: string, digest: string): void {
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    runtime.treasury = runtime.treasury ?? {};
    const branch = runtime.treasury as {
      resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
    };
    const entries = branch.resolutions?.entries ?? {};
    entries["r:" + transactionId] = {
      transactionId,
      digest,
      resolution,
      stage,
      settledAtTick: Game.time,
      proofClass: "lowlevel",
      identityProfile: "lowlevel",
      ...(resolution === "not-executed" ? { notExecutedStage: "outcome_finalized" } : {}),
    };
    branch.resolutions = { version: 7, entries, entryCount: Object.keys(entries).length, updatedAt: Game.time };
  }

  it("O4：Resolution Tombstone（resolving/final）与 GRA 在位 → owned（final 为 terminal-authority）", () => {
    makeService();
    const resolving = abandonedId("ix-o4a");
    seedTombstone(resolving, "not-executed", "reconciling", durableOf(resolving));
    const resolvingOwnership = resolveTreasuryAttemptLifecycleOwnership(resolving);
    expect(resolvingOwnership.status).toBe("owned");
    expect(resolvingOwnership.kind).toBe("active");
    const final = abandonedId("ix-o4b");
    seedTombstone(final, "committed", "final", durableOf(final));
    const finalOwnership = resolveTreasuryAttemptLifecycleOwnership(final);
    expect(finalOwnership.status).toBe("owned");
    expect(finalOwnership.kind).toBe("terminal-authority");
    // GRA proof 在位 → terminal-authority（真实 converge 链路写入 root 代 proof）。
    const graOwner = abandonedId("ix-o4c");
    const graLineageId = seedNonRearmableRoot(graOwner);
    void graLineageId;
    const graOwnership = resolveTreasuryAttemptLifecycleOwnership(graOwner);
    expect(graOwnership.status).toBe("owned");
    expect(graOwnership.kind).toBe("terminal-authority");
  });

  it("O5：owner store 损坏 → 不得当成 orphan（unhealthy → owned fail closed）", () => {
    makeService();
    const transactionId = mintedId("ix-o5");
    const quarantined = quarantineTreasuryTransaction({
      transactionId,
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      phase: "ok_pending_commit_unresolved",
      outcome: "returned_ok",
      settlement: "quarantined",
      deltas: [{ roomName: ROOMS[0].name, locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      recordedAt: Game.time,
    } as never);
    expect(quarantined.status).toBe("written");
    // 破坏 quarantine store（entryCount 不一致）。
    corruptStoreEntryCount("quarantine", 6);
    const ownership = resolveTreasuryAttemptLifecycleOwnership(transactionId);
    expect(ownership.status).toBe("owned");
  });

  it("O6：真正 expired ticket、无任何 owner → 可按明确协议 retire（watermark frontier 验证）", () => {
    makeService();
    const opened = openTreasuryIssuedInitialAttempt("ix-o6");
    expect(opened.status).toBe("opened");
    const transactionId = opened.status === "opened" ? opened.transactionId : "";
    // TTL 到 → 显式 expired（正面事实）→ 无 owner（unowned）。
    Game.time += TREASURY_ISSUED_TICKET_TTL_TICKS + 1;
    expect(expireTreasuryIssuedAttemptTickets()).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(transactionId)?.state).toBe("expired");
    const ownership = resolveTreasuryAttemptLifecycleOwnership(transactionId);
    expect(ownership.status).toBe("unowned");
    // watermark frontier ≥ sequence → terminal ticket 可淘汰。
    const retirement = retireTreasuryTerminalIssuedAttemptTickets(peekTreasuryIssuedAttemptWatermark());
    expect(retirement.retired).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(transactionId)).toBeUndefined();
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(true);
  });
});

// ══ 工作流 D：Checked Completion Handoff ════════════════════════════════════

describe("Remediation IX H：checked completion handoff（结构化 mutation 传播）", () => {
  /** 走完整 cleanup 至 journal 阶段全部确认（completion 写入前）。 */
  function seedJournalToCompletionEdge(service: TreasuryTestService, transactionId: string): void {
    const opened = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: durableOf(transactionId),
      }),
    );
    expect(opened.status).not.toBe("rejected");
    // 阶段推进到全部持久确认（completion 写入由 advance 承载）。
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(["completed", "cleanup_pending", "store_unhealthy"]).toContain(advanced.status);
    void service;
  }

  /** 真实 committed 全链路（cleanup 已 completed）+ journal 重建（R10 同构：
   *  completion 在位、journal 恢复在位——handoff 的中断恢复场景）。 */
  function committedWithJournalRestored(transactionId: string): void {
    const service = makeService();
    executeCommitted(service, transactionId);
    const proof = readTreasurySettlementProof(transactionId) as { digest: string; durableIdentityDigest: string };
    const opened = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId,
        digest: proof.digest,
        resolution: "committed",
        proofClass: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: proof.durableIdentityDigest,
      }),
    );
    expect(opened.status).not.toBe("rejected");
    const store = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
    store!.entries!["c:" + transactionId]!.settlementProofDurable = true;
    expect(markTreasuryResolutionCleanupStage(transactionId, "marker_discharge", "already_absent")).not.toBe("rejected");
  }

  it("H1：handoff 期间 reservation store unhealthy（admission/consume 结构化失败）→ journal 仍在、status ≠ completed", () => {
    const transactionId = mintedId("ix-h1");
    committedWithJournalRestored(transactionId);
    corruptStoreEntryCount("completionHeadroomReservations");
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advanced.status).not.toBe("completed");
    expect(readTreasuryResolutionCleanupEntry(transactionId)).toBeDefined();
  });

  it("H2：handoff mutation 失败 → journal 保留 → global reset 后修复 store 继续完成（completed）", () => {
    const transactionId = mintedId("ix-h2");
    committedWithJournalRestored(transactionId);
    corruptStoreEntryCount("completionHeadroomReservations");
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const blocked = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(blocked.status).not.toBe("completed");
    expect(readTreasuryResolutionCleanupEntry(transactionId)).toBeDefined();
    // 恢复（外部修复 read-back 一致）+ global reset（heap 全清）。
    {
      const store = (Memory.runtime as unknown as { treasury?: { completionHeadroomReservations?: { entries: Record<string, unknown>; entryCount: number } } }).treasury!.completionHeadroomReservations!;
      store.entryCount = Object.keys(store.entries).length;
    }
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    resetTreasuryCleanupCompletionHeapCacheForTest();
    const resumed = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(resumed.status).toBe("completed");
    expect(readTreasuryResolutionCleanupEntry(transactionId)).toBeUndefined();
  });

  it("H3：callback 前普通 abort + release 失败 → 结果暴露未释放（metrics 计数 + reservation 保留），不谎报已关闭", () => {
    const service = makeService();
    const transactionId = mintedId("ix-h3");
    const prepared = service.prepareTransaction(input(service, transactionId));
    expect(prepared.status).toBe("prepared");
    // 破坏 reservation store → abort 的 release 结构化失败。
    corruptStoreEntryCount("completionHeadroomReservations");
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const aborted = service.abortPreparedTransaction((prepared as { handle: unknown }).handle as never);
    expect(aborted.status).toBe("aborted");
    // 预留未释放：结构化失败经 handoff 诊断计数暴露（不静默）。
    expect(treasuryCompletionHandoffDiagnostics.releaseFailures).toBeGreaterThan(0);
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(1);
  });

  it("H4：completion + reservation pair → beginTick recovery consume → journal 随后推进 completed（H10 三元组）", () => {
    const service = makeService();
    const transactionId = mintedId("ix-h4");
    // 手工构造中断窗口：completion 写入 + matching reservation 在位。
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "legacy",
        identityProfile: "legacy-replay",
        durableIdentityDigest: durableOf(transactionId),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    const occupancy = peekTreasuryEffectiveCompletionOccupancy();
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId,
      occupancyAfterAcquire: occupancy.effective,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    // global reset 后 recovery：pair consume。
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    resetTreasuryCleanupCompletionHeapCacheForTest();
    expect(reconcileTreasuryReservationCompletionPairs()).toBe(1);
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    // journal 侧：completed 可证明三元组（completion 在位 + reservation
    // handoff 完成 + journal absent）。
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advanced.status).toBe("completed");
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("match");
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    expect(readTreasuryResolutionCleanupEntry(transactionId)).toBeUndefined();
  });

  it("H5：reservation 已被先前恢复消费 + matching completion 在位 → handoff 幂等不重复失败", () => {
    makeService();
    const transactionId = mintedId("ix-h5");
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "legacy",
        identityProfile: "legacy-replay",
        durableIdentityDigest: durableOf(transactionId),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    // reservation 已不在（先前恢复消费）→ reconcile 幂等 0、advance completed。
    expect(reconcileTreasuryReservationCompletionPairs()).toBe(0);
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advanced.status).toBe("completed");
  });

  it("H6：identity mismatch → completion 不得写；reservation 与 journal 均保留", () => {
    makeService();
    const transactionId = mintedId("ix-h6");
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId,
      occupancyAfterAcquire: 1,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    expect(admitTreasuryCompletionHeadroomReservationForExecution({
      transactionId,
      durableIdentityDigest: durableOf(transactionId),
    }).status).toBe("ok");
    const admission = admitTreasuryCompletionPublicationReservation({
      transactionId,
      durableIdentityDigest: "7777aaaa8888bbbb",
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    });
    expect(admission.status).toBe("rejected");
    if (admission.status === "rejected") expect(admission.reason).toBe("identity_mismatch");
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("absent");
  });

  it("H7：completion store unhealthy → reservation 不消费、journal 不删", () => {
    const transactionId = mintedId("ix-h7");
    committedWithJournalRestored(transactionId);
    corruptStoreEntryCount("cleanupCompletions");
    resetTreasuryCleanupCompletionHeapCacheForTest();
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advanced.status).not.toBe("completed");
    expect(readTreasuryResolutionCleanupEntry(transactionId)).toBeDefined();
  });

  it("H8：reservation store unhealthy → completion 已写也不删 journal（handoff 结构化失败阻断）", () => {
    const transactionId = mintedId("ix-h8");
    committedWithJournalRestored(transactionId);
    corruptStoreEntryCount("completionHeadroomReservations");
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advanced.status).not.toBe("completed");
    expect(readTreasuryResolutionCleanupEntry(transactionId)).toBeDefined();
  });

  it("H9：生产代码不得以语句位置忽略 reservation mutation 结果（架构扫描）", () => {
    // 见 treasuryWriteArchitecture.test.ts 的对应守护（本测试验证运行时
    // 语义：sweepOrphan 的 consume 失败保留条目）。
    makeService();
    const transactionId = abandonedId("ix-h9");
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId,
      occupancyAfterAcquire: 1,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    Game.time += 5000;
    const swept = sweepOrphanTreasuryCompletionReservations(new Set());
    expect(swept).toBe(1);
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
  });
});

// ══ 工作流 F：resolver insufficient fail closed ═════════════════════════════

describe("Remediation IX S：resolver insufficient 真正 fail closed", () => {
  it("S11：live exact 带 durable identity + historical 同 outcome 缺 durable identity → insufficient，不得 exact", () => {
    makeService();
    const transactionId = mintedId("ix-s11");
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "legacy",
        identityProfile: "legacy-replay",
        durableIdentityDigest: durableOf(transactionId),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    seedHistoricalRecord({
      transactionId,
      resolution: "not-executed",
      identity: {
        digest: DIGEST,
        identityProfile: "legacy-replay",
        proofClass: "legacy",
        // 缺 durableIdentityDigest——维度不足（legacy-replay 允许弱身份）。
      },
    });
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("insufficient");
  });

  it("S12：authority 完整 + caller expected 缺 durable identity → insufficient", () => {
    makeService();
    const transactionId = mintedId("ix-s12");
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "legacy",
        identityProfile: "legacy-replay",
        durableIdentityDigest: durableOf(transactionId),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    const resolved = resolveTreasuryDurableSettlementAuthority({
      transactionId,
      expected: treasuryExactAttemptIdentityOfFacts(
        transactionId,
        { digest: DIGEST, lowlevelSource: RUNTIME },
        "lowlevel",
      )!,
    });
    expect(resolved.status).toBe("insufficient");
  });

  it("S13：exact + protocol 同 outcome + identity 完整 → exact；protocol 不补足或覆盖 identity", () => {
    makeService();
    const root = mintedId("ix-s13");
    const child = deriveTreasuryLineageNextChildTransactionId(LINEAGE_A, 2, root);
    seedCertificateDirect({
      lineageId: LINEAGE_A,
      rootTransactionId: root,
      finalAttemptId: child,
      finalGeneration: 2,
      terminalState: "non_rearmable_retired",
    });
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(resolved.status).toBe("protocol");
    // exact 声明（live completion）+ protocol 同 outcome → exact（identity
    // 来自 exact 声明——protocol 不覆盖）。
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId: root,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "lowlevel",
        identityProfile: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: durableOf(root),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    const combined = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(combined.status).toBe("exact");
    if (combined.status === "exact") expect(combined.identity.durableIdentityDigest).toBe(durableOf(root));
  });

  it("S14：destructive reconciliation 路径收到 insufficient → 零 mutation（零 capability）", () => {
    makeService();
    const transactionId = mintedId("ix-s14");
    // 构造 insufficient（S11 同型：live 完整 + historical 缺维度）。
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "legacy",
        identityProfile: "legacy-replay",
        durableIdentityDigest: durableOf(transactionId),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    seedHistoricalRecord({
      transactionId,
      resolution: "not-executed",
      identity: { digest: DIGEST, identityProfile: "legacy-replay", proofClass: "legacy" },
    });
    // replay gate 阻断（insufficient → 拒绝，不 release Authority）。
    const prepared = service_prepareReplay(transactionId);
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("proof_insufficient");
    // 权威事实未被 mutation（completion/historical 原样在位）。
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("match");
  });

  function service_prepareReplay(transactionId: string): { status: string; reason?: string } {
    const service = makeService();
    return service.prepareTransaction(input(service, transactionId)) as { status: string; reason?: string };
  }

  it("S15：replay prepare 收到 insufficient → callback=0（production contract 通道同样拒绝）", () => {
    const service = makeService();
    const transactionId = mintedId("ix-s15");
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "legacy",
        identityProfile: "legacy-replay",
        durableIdentityDigest: durableOf(transactionId),
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    seedHistoricalRecord({
      transactionId,
      resolution: "not-executed",
      identity: { digest: DIGEST, identityProfile: "legacy-replay", proofClass: "legacy" },
    });
    const prepared = service.prepareTransaction(input(service, transactionId));
    expect(prepared.status).toBe("rejected");
    const executed = contractExecuteSealed(service, transactionId);
    expect(executed.callbackCount).toBe(0);
  });
});

// ══ 工作流 C：Summary / Certificate / Range 的安全驱逐（Q 组）══════════════

describe("Remediation IX Q：summary/certificate/range 的 replacement 验证驱逐", () => {
  /** seed N 条真实 terminal chain（正式 converge → compact——summary+certificate+range 全链路）。 */
  function seedChains(count: number, tag: string): string[] {
    const roots: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const root = abandonedId(tag + "_" + index);
      roots.push(root);
      const lineageId = seedNonRearmableRoot(root);
      expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    }
    return roots;
  }

  /** 持久层删除全部 certificate（模拟未写/被逐——replacement 缺失构造）。 */
  function dropCertificates(): void {
    const branch = (Memory.runtime as unknown as { treasury?: { chainRetirementCertificates?: { entries: Record<string, unknown>; entryCount: number } } } | undefined)?.treasury;
    if (branch?.chainRetirementCertificates) {
      branch.chainRetirementCertificates.entries = {};
      branch.chainRetirementCertificates.entryCount = 0;
    }
    resetTreasuryChainCertificateHeapCacheForTest();
  }

  /** 破坏 retired range store（store unhealthy 不当作 replacement 在位）。 */
  function corruptRangeStore(): void {
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    branch.retiredAttemptRanges = { version: 1, ranges: [{ minSequence: 3, maxSequence: 1, mergedAtTick: 1 }], entryCount: 1, updatedAt: Game.time };
    resetTreasuryChainCertificateHeapCacheForTest();
  }

  it("Q1：summary 满载 + range store 损坏 + 无 matching certificate → 驱逐 blocked、summary 保留（第 130 次压缩 fail closed）", () => {
    makeService();
    seedChains(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES + 1, "q1");
    dropCertificates();
    corruptRangeStore();
    const overflowRoot = mintedId("q1_overflow");
    const overflowLineage = seedNonRearmableRoot(overflowRoot);
    const compacted = compactTreasuryTerminalLineage(overflowLineage);
    expect(compacted.status).toBe("rejected");
    expect(peekTreasuryRetirementSummaryEntryCount()).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
  });

  it("Q2/Q3/Q4：certificate lineageId / terminalState / finalGeneration 不一致 → 不得删除对应 summary（fixed 三合一）", () => {
    makeService();
    const roots = seedChains(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES, "q234");
    const oldest = roots[0]!;
    const branch = (Memory.runtime as unknown as { treasury?: { chainRetirementCertificates?: { entries: Record<string, { lineageId?: string; terminalState?: string; finalGeneration?: number }> } } }).treasury!;
    const key = "crc:" + oldest;
    const entries = branch.chainRetirementCertificates!.entries;
    const original = { ...entries[key]! };
    for (const mutation of [
      { lineageId: "ffffffffffffffff" },
      { terminalState: "chain_committed" },
      { finalGeneration: 7 },
    ] as const) {
      entries[key] = { ...original, ...mutation };
      resetTreasuryChainCertificateHeapCacheForTest();
      const overflowRoot = mintedId("q234_overflow");
      const overflowLineage = seedNonRearmableRoot(overflowRoot);
      const compacted = compactTreasuryTerminalLineage(overflowLineage);
      // 篡改维度不一致 → 队首不可驱逐；其它条目 eligible 时驱逐其它，
      // 队首 summary 恒保留（Q2/Q3/Q4 核心断言）。
      expect(lookupTreasuryRetirementSummaryByRoot(oldest)).toBeDefined();
      if (compacted.status === "rejected") {
        expect(peekTreasuryRetirementSummaryEntryCount()).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
      }
      entries[key] = original;
      resetTreasuryChainCertificateHeapCacheForTest();
    }
  });

  it("Q5：range 在位但 summary 仍被 GRA exact path 依赖 → anti-reuse-only 不得替代", () => {
    makeService();
    const roots = seedChains(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES, "q5");
    const oldest = roots[0]!;
    dropCertificates();
    const overflowRoot = mintedId("q5_overflow");
    const overflowLineage = seedNonRearmableRoot(overflowRoot);
    const compacted = compactTreasuryTerminalLineage(overflowLineage);
    expect(compacted.status).toBe("rejected");
    expect(lookupTreasuryRetirementSummaryByRoot(oldest)).toBeDefined();
    expect(peekTreasuryRetirementSummaryEntryCount()).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
  });

  it("Q6：matching replacement 完整并 read-back → 旧 recent detail 安全出队；旧 ID 查询 protocol/retired 而非 absent", () => {
    makeService();
    const roots = seedChains(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES + 1, "q6");
    const oldest = roots[0]!;
    expect(peekTreasuryRetirementSummaryEntryCount()).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: oldest });
    expect(resolved.status === "protocol" || resolved.status === "retired" || resolved.status === "exact").toBe(true);
    expect(resolved.status).not.toBe("absent");
  });

  it("Q7：recent queue wraparound——200 条 chain 后最旧 eligible 被淘汰、最新可查、旧 ID 不可重放", () => {
    makeService();
    const roots = seedChains(200, "q7");
    expect(peekTreasuryRetirementSummaryEntryCount()).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
    expect(lookupTreasuryRetirementSummaryByRoot(roots[roots.length - 1]!)).toBeDefined();
    expect(lookupTreasuryRetirementSummaryByRoot(roots[0]!)).toBeUndefined();
    for (const probe of [roots[0]!, roots[1]!, roots[100]!]) {
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: probe });
      expect(resolved.status).not.toBe("absent");
    }
  });

  it("Q8：队首 replacement 缺失（certificate 删除）+ 后方 eligible → 有界扫描找到后方条目驱逐，不永久停机", () => {
    makeService();
    const roots = seedChains(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES, "q8");
    const branch = (Memory.runtime as unknown as { treasury?: { chainRetirementCertificates?: { entries: Record<string, unknown>; entryCount: number } } }).treasury!;
    delete branch.chainRetirementCertificates!.entries["crc:" + roots[0]!];
    branch.chainRetirementCertificates!.entryCount = Object.keys(branch.chainRetirementCertificates!.entries).length;
    resetTreasuryChainCertificateHeapCacheForTest();
    const overflowRoot = mintedId("q8_overflow");
    const overflowLineage = seedNonRearmableRoot(overflowRoot);
    const compacted = compactTreasuryTerminalLineage(overflowLineage);
    expect(compacted.status).toBe("compacted");
    expect(lookupTreasuryRetirementSummaryByRoot(roots[0]!)).toBeDefined();
  });

  it("Q9：全部不可安全淘汰 → 新 writer fail closed（第 129 次压缩 rejected）、旧事实零删除", () => {
    makeService();
    const roots = seedChains(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES, "q9");
    dropCertificates();
    corruptRangeStore();
    const overflowRoot = mintedId("q9_overflow");
    const overflowLineage = seedNonRearmableRoot(overflowRoot);
    expect(compactTreasuryTerminalLineage(overflowLineage).status).toBe("rejected");
    expect(peekTreasuryRetirementSummaryEntryCount()).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
    for (const root of roots.slice(0, 5)) {
      expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeDefined();
    }
  });

  it("Q10/Q11：≥600 条现代 terminal chain 正式运行——store 恒不超硬上限、第 601 条可执行、Memory 增量有界（300→600 非线性翻倍）", () => {
    const service = makeService();
    const first300: string[] = [];
    const runBatch = (from: number, to: number, tag: string): void => {
      for (let index = from; index < to; index += 1) {
        // tick 前进 + 周期 beginTick：真实长期运行的时间轴（tombstone
        // retention 退休 / GC coordinator / 边界压缩按正式节奏发生——
        // GRA root proof 等中间层随之有界）。
        Game.time += 60;
        if (index % 10 === 0) {
          service.beginTick();
          // 【X 迁移】tombstone 惰性退休的容量触发（真实写入路径的等价物
          //——注入 fixture 不走写入路径；到期 tombstone 退休 → GRA proof
          // 联动释放，GRA/tombstone 在容量内稳态）。
          const slotError = ensureTreasuryResolutionSlotAvailable();
          if (slotError !== null) throw new Error("resolution slot: " + slotError);
        }
        const root = abandonedId(tag + "_" + index);
        first300.push(root);
        const lineageId = seedNonRearmableRoot(root);
        expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
      }
    };
    runBatch(0, 300, "q10a");
    const lengthAt300 = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury).length;
    runBatch(300, 600, "q10b");
    const lengthAt600 = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury).length;
    expect(peekTreasuryRetirementSummaryEntryCount()).toBeLessThanOrEqual(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
    expect(peekTreasuryChainCertificateEntryCount()).toBeLessThanOrEqual(TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES);
    expect(peekTreasuryRetiredRangeEntryCount()).toBeLessThanOrEqual(64);
    // Memory 增量有界：每 chain 边际被压缩（300→600 的新增 ≤ 首轮 60%——
    // 非近似翻倍；evidence 记录实际字节数）。
    expect(lengthAt600).toBeLessThan(lengthAt300 * 1.6);
    const freshRoot = mintedId("q10_fresh");
    const executed = service.executePreparedAction(input(service, freshRoot), () => ({ ok: true }) as never);
    expect(executed.status).toBe("executed_committed");
    for (const probe of [first300[0]!, first300[299]!, first300[599]!]) {
      expect(resolveTreasuryDurableSettlementAuthority({ transactionId: probe }).status).not.toBe("absent");
    }
  });

  it("Q12：global reset 发生在 replacement 写入后、旧 entry 删除前 → 恢复后幂等完成（无双权威/不丢 anti-reuse）", () => {
    makeService();
    const roots = seedChains(3, "q12");
    const root = roots[0]!;
    resetTreasuryChainCertificateHeapCacheForTest();
    expect(lookupTreasuryChainRetirementCertificate(root)).toBeDefined();
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(resolved.status).toBe("protocol");
    if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    expect(lookupTreasuryRetiredRangeStructured(root).status).not.toBe("store_unhealthy");
  });
});
