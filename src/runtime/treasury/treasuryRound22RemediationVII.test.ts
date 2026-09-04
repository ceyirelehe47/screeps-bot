/**
 * 【Round 22 Remediation VII】固定反例矩阵——Global Historical Settlement
 * Integration / Durable Cleanup Headroom Reservation / Bounded Permanent
 * Replay History。
 *
 * 覆盖任务书 T1–T20：
 * - T1–T7：durable settlement authority 接入全局 truth graph（replay
 *   gate / opposite proof / rearm preflight / child occupancy /
 *   reconciliation / store unhealthy fail closed）；
 * - T8：existing historical record 热缓存后篡改 → 删除前拦截；
 * - T9：legacy/forensic 不得 automatic archive；
 * - T10–T16：completion headroom reservation（race / 幂等 / 释放 / execution
 *   unknown / 容量窗口 / tr1_ 顺序 / global reset）；
 * - T17：真实 300-generation chain 的 chain-level 压缩；
 * - T18：超过旧 384 边界仍能继续运行（600 initial attempts）；
 * - T19：service-issued initial ID（watermark 单调 / 防伪 / 防复用）。
 * （T20 架构守护在 treasuryWriteArchitecture.test.ts。）
 *
 * 所有 Game 写动作均使用 mock/spies——不访问真实 Screeps API。
 */

import {
  createTreasuryService,
} from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import {
  mintTreasuryInitialAttemptId,
  peekTreasuryIssuedAttemptWatermark,
  clearTreasuryAttemptIssuerDurableForTest,
  resetTreasuryAttemptIssuerHeapCacheForTest,
  checkTreasuryServiceIssuedAttemptId,
} from "@/runtime/treasury/attemptIssuer";
import {
  abandonTreasuryIssuedAttemptTicketForTest,
  clearTreasuryIssuedAttemptTicketDurableForTest,
  openTreasuryIssuedInitialAttempt,
} from "@/runtime/treasury/attemptIssuanceTicket";
import {
  lookupTreasuryChainRetirementCertificate,
  peekTreasuryChainCertificateEntryCount,
  clearTreasuryChainCertificateDurableForTest,
  compressTreasuryRetirableHistoricalEntries,
  peekTreasuryRetiredRangeEntryCount,
} from "@/runtime/treasury/chainRetirementCertificate";
import {
  resolveTreasuryDurableSettlementAuthority,
} from "@/runtime/treasury/historicalSettlementAuthority";
import {
  archiveTreasuryCleanupCompletionViaAuthority,
  clearTreasuryCleanupSupersessionDurableForTest,
  lookupTreasuryHistoricalCompletion,
  peekTreasuryCleanupSupersessionEntryCount,
  resetTreasuryCleanupSupersessionHeapCacheForTest,
  TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES,
  type TreasuryHistoricalCompletionRecord,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
  clearTreasuryCleanupCompletionDurableForTest,
  peekTreasuryCleanupCompletionEntryCount,
  resetTreasuryCleanupCompletionHeapCacheForTest,
  recordTreasuryCleanupCompletion,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  acquireTreasuryCompletionHeadroomReservation,
  admitTreasuryCompletionHeadroomReservationForExecution,
  clearTreasuryCompletionHeadroomReservationDurableForTest,
  peekTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservationCount,
  resetTreasuryCompletionHeadroomReservationHeapCacheForTest,
  TREASURY_COMPLETION_RESERVATION_TTL_TICKS,
} from "@/runtime/treasury/completionHeadroomReservation";
import {
  checkTreasuryOppositeProofsForCommitted,
  checkTreasuryOppositeProofsForNotExecuted,
} from "@/runtime/treasury/oppositeProofMatrix";
import {
  checkTreasuryChildAttemptOccupancy,
  preflightTreasuryRearmCapability,
} from "@/runtime/treasury/attemptOccupancy";
import { advanceTreasuryResolutionCleanupPhases } from "@/runtime/treasury/resolutionCleanupCoordinator";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  treasuryResolutionCleanupOpenInputOfFacts,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  readTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { executeTreasuryActionContract, buildTreasuryActionContract } from "@/runtime/treasury/actionContracts";
import {
  createTreasuryAttemptLineageRecord,
  deriveTreasuryLineageNextChildTransactionId,
  markTreasuryLineageRetirementStageVerified,
  completeTreasuryLineageRetirement,
  readTreasuryAttemptLineageRecord,
  retireTreasuryLineageCurrentAttempt,
  convergeTreasuryLineageRetirementFromFacts,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
} from "@/runtime/treasury/attemptLineage";
import { compactTreasuryTerminalLineage } from "@/runtime/treasury/lineageRetirementSummary";
import { computeTreasuryLowlevelRetrySemanticDigest } from "@/runtime/treasury/retrySemanticIdentity";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  recordTreasuryChainRetirementCertificate,
} from "@/runtime/treasury/chainRetirementCertificate";
import { lookupTreasuryRetirementSummaryByRoot } from "@/runtime/treasury/lineageRetirementSummary";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import { clearTreasuryPersistenceForTest, readTreasurySettlementProof } from "@/runtime/treasury/receipts";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

jest.setTimeout(180_000);

const RUNTIME = TREASURY_LOWLEVEL_SOURCE_RUNTIME;
const TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST = 5_000;
const DIGEST = "0123456789abc001";

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

// ── 共享 fixture ────────────────────────────────────────────────────────────

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

function seedFinalNotExecutedTombstone(transactionId: string, durable: string, overrides: Record<string, unknown> = {}): void {
  const write = writeTreasuryResolutionTombstone({
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
    ...overrides,
  } as never);
  expect(write.status).not.toBe("rejected");
}

function seedFinalCommittedTombstone(transactionId: string, digest: string, durable: string): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  const entries = branch.resolutions?.entries ?? {};
  entries["r:" + transactionId] = {
    transactionId,
    digest,
    resolution: "committed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
  };
  branch.resolutions = {
    version: 7,
    entries,
    entryCount: Object.keys(entries).length,
    updatedAt: Game.time,
  };
  resetTreasuryResolutionStoreForTest();
}

/** root lineage seed → rearm_ready（converge 正式通道——GRA proof 在位）。 */
function seedRearmReadyRoot(transactionId: string, rearmable = true): string {
  const durable = seedQuarantineEntry(transactionId);
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable,
    identityProfile: "lowlevel",
    ...(rearmable
      ? {
          retrySemanticDigest: computeTreasuryLowlevelRetrySemanticDigest({
            kind: "terminal.send",
            source: "test",
            postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
            lowlevelSource: RUNTIME,
          }) ?? "8888777766665550",
        }
      : { nonRearmReason: "test fixture" }),
  });
  if (created.status !== "written") throw new Error("lineage seed rejected");
  const lineageId = created.record.lineageId;
  seedFinalNotExecutedTombstone(transactionId, durable);
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
  return lineageId;
}

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

interface LowlevelInput {
  readonly transactionId: string;
  readonly delta?: number;
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

/** ti1_ minted initial ID（真实 issuer 通道——非 bypass）。 */
function mintedId(correlation: string): string {
  // 【X 迁移】fixture 走 production opening 路径（mint 与 ticket 原子）。
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

/**
 * 真实低层路径执行一个 initial attempt 至 committed（Game mock 返回 OK），
 * 再走完整 cleanup（journal open → 五阶段 → completion 写入）。
 */
function executeCommitted(service: TreasuryTestService, transactionId: string): void {
  const result = service.executePreparedAction(input(service, transactionId), () => ({ ok: true }) as never);
  if (result.status !== "executed_committed") {
    throw new Error(`fixture executeCommitted got ${result.status}: ${JSON.stringify(result).slice(0, 220)}`);
  }
  // 真实 receipt 的 identity 事实（journal open 的 exact identity 匹配源）。
  const receiptProof = readTreasurySettlementProof(transactionId);
  if (
    receiptProof === undefined ||
    (receiptProof as { digest?: string }).digest === undefined ||
    (receiptProof as { durableIdentityDigest?: string }).durableIdentityDigest === undefined
  ) {
    throw new Error("fixture executeCommitted: receipt identity missing");
  }
  // committed settlement 权威（final committed tombstone——outcome
  // finalization 的外部 proof）。正式写入有状态机前置（resolving → final）
  // ——fixture 持久层注入完整形状（与 faultResolution 测试同模式），
  // identity 与 receipt 同源。
  seedFinalCommittedTombstone(
    transactionId,
    (receiptProof as { digest: string }).digest,
    (receiptProof as { durableIdentityDigest: string }).durableIdentityDigest,
  );
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

function durableOf(transactionId: string): string {
  return recomputeTreasuryDurableIdentityDigest({
    transactionId,
    digest: DIGEST,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
  })!;
}

/** 直接注入一条 shape 合法的 historical record（绕过 archive 的持久层 fixture）。 */
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

/** completion store 持久层直写 fixture（shape 合法的满载/占用场景）。 */
function seedCompletionEntry(transactionId: string, resolution: "committed" | "not-executed" = "not-executed"): void {
  const written = recordTreasuryCleanupCompletion({
    entry: {
      transactionId,
      digest: DIGEST,
      resolution,
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
  if (written.status === "rejected") throw new Error(`seedCompletionEntry rejected: ${written.detail}`);
}

/** resolution store 塞满（触发惰性驱逐——retention 到期的 filler）。 */
function fillResolutionStoreWithExpiredFillers(prefix: string): void {
  Game.time += TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST + 1;
  const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
  const resolutions = branch.resolutions as { entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  for (let index = 0; resolutions.entryCount < 256; index += 1) {
    const fillerId = `${prefix}_${index}`;
    resolutions.entries["r:" + fillerId] = {
      transactionId: fillerId, digest: DIGEST, resolution: "committed", stage: "final",
      proofLevel: "legacy", actionTick: Game.time - TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST - 2,
      settledAtTick: Game.time - TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST - 2,
      observationTick: Game.time - TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST - 2,
      resolvedAtTick: Game.time - TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST - 2,
      reconcilerKind: "terminal.send",
    };
    resolutions.entryCount += 1;
  }
  resolutions.updatedAt = Game.time;
  resetTreasuryResolutionStoreForTest();
}

// ── T1：historical committed 在短期 proof GC 后仍阻止 replay ───────────────

describe("Remediation VII T1：Receipt/Tombstone GC 后 historical committed 仍阻止 replay", () => {
  it("完整生命周期：committed → cleanup → 压缩归档 → receipt retention 到期 → tombstone 驱逐 → global reset → 同 ID prepare already_settled、execute callback 零调用", () => {
    const service = makeService();
    const transactionId = mintedId("t1_replay");
    executeCommitted(service, transactionId);
    // cleanup 完成后 completion 在 live store；压缩归档（compact-archive）。
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(1);
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" }).status).toBe("archived");
    // 短期 proof 全部按正式生命周期回收：receipt retention 到期 + resolution
    // store 塞满触发惰性驱逐（filler 全部过期 committed → 驱逐包括本 ID）。
    fillResolutionStoreWithExpiredFillers("t1_filler");
    const dummy = writeTreasuryResolutionTombstone({
      transactionId: "t1_dummy", digest: DIGEST, resolution: "not-executed", stage: "final",
      proofLevel: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: "0123456789abc099",
      actionTick: Game.time, observationTick: Game.time, resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send", source: "test",
    } as never);
    expect(dummy.status).not.toBe("rejected");
    expect(readTreasuryResolutionTombstone(transactionId)).toBeUndefined();
    // global reset 模拟（heap 全部失效）。
    resetTreasuryCleanupCompletionHeapCacheForTest();
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    // durable settlement authority：historical committed 在位。
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("exact");
    if (resolved.status === "exact") expect(resolved.outcome).toBe("committed");
    // 同 ID 再 prepare → already_settled（durable 权威，不依赖 receipt/tombstone）。
    const prepare = service.prepareTransaction(input(service, transactionId));
    expect(prepare.status).toBe("already_settled");
    // execute → callback 零调用、不创建新 Intent、不创建 receipt reservation。
    const beforeReservationCount = peekTreasuryCompletionHeadroomReservationCount();
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, transactionId), callback);
    expect(executed.status).toBe("already_settled");
    expect(callback).not.toHaveBeenCalled();
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(beforeReservationCount);
    // 历史权威未被覆盖。
    const historical = lookupTreasuryHistoricalCompletion(transactionId);
    expect(historical.verdict).toBe("match");
    if (historical.verdict === "match") expect(historical.record.resolution).toBe("committed");
  });
});

// ── T2：historical not-executed 同 ID 只能 rearm ───────────────────────────

describe("Remediation VII T2：historical not-executed 同 ID 只能 rearm", () => {
  it("direct prepare parent ID → rearm_required；伪造 tr1_ child ID / 旧 child ID 拒绝", () => {
    const service = makeService();
    const transactionId = mintedId("t2_parent");
    // not-executed historical（持久层注入——lineage/summary 均无的独立事实）。
    seedHistoricalRecord({ transactionId, resolution: "not-executed" });
    const prepare = service.prepareTransaction(input(service, transactionId));
    expect(prepare.status).toBe("rejected");
    if (prepare.status === "rejected") expect(prepare.reason).toBe("rearm_required");
    // 手工构造 tr1_ ID 直接 prepare → capability 门禁拒绝（无 capability）。
    const forgedChild = deriveTreasuryLineageNextChildTransactionId("0123456789abcdef", 1, "t2_root");
    const childPrepare = service.prepareTransaction(input(service, forgedChild));
    expect(childPrepare.status).toBe("rejected");
    if (childPrepare.status === "rejected") expect(childPrepare.reason).toBe("rearm_capability_required");
    // matching capability 的正常 child 流程由 T15 覆盖（tr1_ reservation 顺序）。
  });
});

// ── T3：historical opposite proof ───────────────────────────────────────────

describe("Remediation VII T3：historical opposite proof 双方向", () => {
  const expected = (transactionId: string) =>
    treasuryExactAttemptIdentityOfFacts(
      transactionId,
      { digest: DIGEST, durableIdentityDigest: durableOf(transactionId), lowlevelSource: RUNTIME },
      "lowlevel",
    )!;

  it("A：historical committed + 目标 not-executed → 相反 proof 阻断", () => {
    const transactionId = mintedId("t3a");
    seedHistoricalRecord({ transactionId, resolution: "committed" });
    const check = checkTreasuryOppositeProofsForNotExecuted(transactionId, expected(transactionId));
    expect(check.clear).toBe(false);
    expect(check.blockers.some((blocker) => blocker.source === "durable-settlement-authority" && blocker.classification === "exact_match")).toBe(true);
  });

  it("B：historical not-executed + 目标 committed → 相反 proof 阻断", () => {
    const transactionId = mintedId("t3b");
    seedHistoricalRecord({ transactionId, resolution: "not-executed" });
    const check = checkTreasuryOppositeProofsForCommitted(transactionId, expected(transactionId));
    expect(check.clear).toBe(false);
    expect(check.blockers.some((blocker) => blocker.source === "durable-settlement-authority" && blocker.classification === "exact_match")).toBe(true);
  });

  it("同方向（非相反 outcome）的 historical 权威不构成 opposite proof", () => {
    const transactionId = mintedId("t3c");
    seedHistoricalRecord({ transactionId, resolution: "not-executed" });
    const check = checkTreasuryOppositeProofsForNotExecuted(transactionId, expected(transactionId));
    expect(check.blockers.some((blocker) => blocker.source === "historical-authority")).toBe(false);
  });
});

// ── T4：historical 与 rearm-ready lineage 冲突 ─────────────────────────────

describe("Remediation VII T4：historical committed 与 rearm-ready lineage 同 ID 冲突", () => {
  it("rearm preflight → proof_conflict、零 capability、零 mutation", () => {
    const root = "vii_t4_root";
    const lineageId = seedRearmReadyRoot(root);
    expect(readTreasuryAttemptLineageRecord(lineageId)!.state).toBe("rearm_ready");
    // historical committed 与 rearm-ready lineage 同 ID 共存 → proof_conflict。
    seedHistoricalRecord({ transactionId: root, resolution: "committed" });
    const preflight = preflightTreasuryRearmCapability({ parentTransactionId: root });
    expect(preflight.status).toBe("rejected");
    if (preflight.status === "rejected") expect(preflight.reason).toBe("proof_conflict");
    // 零 mutation：lineage 状态保持（未推进、未消费）。
    expect(readTreasuryAttemptLineageRecord(lineageId)!.state).toBe("rearm_ready");
  });
});

// ── T5：historical child occupancy ─────────────────────────────────────────

describe("Remediation VII T5：historical/证书中的 child ID 属于 occupied", () => {
  it("historical exact authority 中的 child ID → occupied", () => {
    makeService();
    const lineageId = "0123456789abcdee";
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 7, "vii_t5_root");
    expect(checkTreasuryChildAttemptOccupancy(childId)).toBeNull();
    seedHistoricalRecord({
      transactionId: childId,
      resolution: "not-executed",
      identity: {
        digest: DIGEST,
        identityProfile: "lowlevel",
        proofClass: "lowlevel",
        durableIdentityDigest: durableOf(childId),
        lowlevelSource: RUNTIME,
        lineageId,
        lineageGeneration: 7,
        parentTransactionId: "vii_t5_parent",
        lineageBindingDigest: "0123456789abcde1",
      },
    });
    expect(checkTreasuryChildAttemptOccupancy(childId)).toBe("durable settlement authority（completion/certificate）");
  });

  it("chain certificate 覆盖的 generation → resolver protocol（VIII C4：certificate 是协议推导，identity 不足不冒充 exact）；child occupancy 认识 certificate（S6——不再 absent）", () => {
    const lineageId = "0123456789abcdef";
    const root = mintedId("t5_root");
    const certChild = deriveTreasuryLineageNextChildTransactionId(lineageId, 3, root);
    // certificate 写入（正式接口）。
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: certChild, finalGeneration: 3,
      terminalState: "non_rearmable_retired",
    }).status).toBe("written");
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: certChild });
    expect(resolved.status).toBe("protocol");
    if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    // 【S6】certificate-only 的 child 属于 occupied（occupancy 认识压缩后权威）。
    expect(checkTreasuryChildAttemptOccupancy(certChild)).toBe("durable settlement authority（completion/certificate）");
    // 中间代协议确定 not-executed（同样 protocol——不冒充 exact）。
    const gen2 = deriveTreasuryLineageNextChildTransactionId(lineageId, 2, root);
    const resolved2 = resolveTreasuryDurableSettlementAuthority({ transactionId: gen2 });
    expect(resolved2.status).toBe("protocol");
    if (resolved2.status === "protocol") expect(resolved2.outcome).toBe("not-executed");
    // 错误 outcome → conflict；超出 final generation → absent。
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: certChild, expectedOutcome: "committed" }).status).toBe("conflict");
    const beyond = deriveTreasuryLineageNextChildTransactionId(lineageId, 9, root);
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: beyond }).status).toBe("absent");
    // 【C4】篡改 checksum 一位的 child ID：不得获得 certificate 匹配。
    const tampered = certChild.slice(0, certChild.length - 1) + (certChild.slice(-1) === "0" ? "1" : "0");
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: tampered }).status).toBe("absent");
  });
});

// ── T6：reconciliation outcome conflict ─────────────────────────────────────

describe("Remediation VII T6：historical outcome 相反的 reconciliation 阻断", () => {
  it("historical committed 的 ID → already_resolved（committed）——不签发 not-executed capability；幂等不重复 destructive", () => {
    const service = makeService();
    const transactionId = mintedId("t6_committed");
    seedHistoricalRecord({ transactionId, resolution: "committed" });
    // 该 ID 无活跃 quarantine/intent → not_found 在 authority 解析（historical
    // 不构成 unresolved authority）——durable gate 在 authority 之后。
    const issued = service.issueTreasuryReconciliationCapability({ transactionId });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("not_found");
    // 活跃 authority 场景（quarantine 在）+ historical committed → 幂等 already_resolved。
    const quarantined = mintedId("t6_active");
    seedHistoricalRecord({ transactionId: quarantined, resolution: "committed" });
    seedQuarantineEntry(quarantined);
    Game.time += 1;
    const resolved = service.issueTreasuryReconciliationCapability({ transactionId: quarantined });
    expect(resolved.status).toBe("already_resolved");
    if (resolved.status === "already_resolved") expect(resolved.resolution).toBe("committed");
  });
});

// ── T7：historical store unhealthy 全局 fail closed ─────────────────────────

describe("Remediation VII T7：historical store unhealthy 时全部入口 fail closed", () => {
  function corruptHistoricalStore(): void {
    if (!Memory.runtime) Memory.runtime = {};
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    if (!runtime.treasury) runtime.treasury = {};
    runtime.treasury.cleanupSupersessions = { version: 99, entries: {}, entryCount: 0, updatedAt: Game.time };
    resetTreasuryCleanupSupersessionHeapCacheForTest();
  }

  it("prepare → 拒绝（不把损坏解释成无权威）", () => {
    const service = makeService();
    const transactionId = mintedId("t7_prepare");
    corruptHistoricalStore();
    const prepare = service.prepareTransaction(input(service, transactionId));
    expect(prepare.status).toBe("rejected");
    if (prepare.status === "rejected") expect(prepare.reason).toBe("completion_store_unhealthy");
  });

  it("opposite proof（两方向）→ store_unhealthy blocker", () => {
    const transactionId = mintedId("t7_opposite");
    const expected = treasuryExactAttemptIdentityOfFacts(
      transactionId,
      { digest: DIGEST, durableIdentityDigest: durableOf(transactionId), lowlevelSource: RUNTIME },
      "lowlevel",
    )!;
    corruptHistoricalStore();
    const committedCheck = checkTreasuryOppositeProofsForCommitted(transactionId, expected);
    expect(committedCheck.blockers.some((blocker) => blocker.source === "durable-settlement-authority" && blocker.classification === "store_unhealthy")).toBe(true);
    const notExecutedCheck = checkTreasuryOppositeProofsForNotExecuted(transactionId, expected);
    expect(notExecutedCheck.blockers.some((blocker) => blocker.source === "durable-settlement-authority" && blocker.classification === "store_unhealthy")).toBe(true);
  });

  it("rearm preflight → 零 capability（lineage_store_unhealthy）", () => {
    const root = "vii_t7_root";
    seedRearmReadyRoot(root);
    corruptHistoricalStore();
    const preflight = preflightTreasuryRearmCapability({ parentTransactionId: root });
    expect(preflight.status).toBe("rejected");
    if (preflight.status === "rejected") expect(preflight.reason).toBe("lineage_store_unhealthy");
  });

  it("child occupancy → unhealthy 阻断（不折叠为未占用）", () => {
    corruptHistoricalStore();
    const childId = deriveTreasuryLineageNextChildTransactionId("0123456789abcdf0", 1, "vii_t7_root");
    expect(checkTreasuryChildAttemptOccupancy(childId)).toBe("durable settlement authority store unhealthy（fail closed）");
  });
});

// ── T8：existing historical record 热缓存后被篡改 ──────────────────────────

describe("Remediation VII T8：existing historical record 热缓存后篡改 → 删除前拦截", () => {
  function seedArchivableScene(tag: string): string {
    const transactionId = mintedId("t8_" + tag);
    seedCompletionEntry(transactionId);
    seedHistoricalRecord({ transactionId });
    // 热缓存（load 后再篡改——validateHistoricalRecordShape 的单条复验抓）。
    expect(lookupTreasuryHistoricalCompletion(transactionId).verdict).toBe("match");
    return transactionId;
  }

  function tamperHistorical(transactionId: string, mutate: (record: Record<string, unknown>) => void): void {
    const raw = (Memory.runtime as unknown as { treasury?: { cleanupSupersessions?: { entries?: Record<string, Record<string, unknown>> } } })
      .treasury!.cleanupSupersessions!.entries!;
    mutate(raw["sa:" + transactionId]!);
  }

  it.each([
    ["schemaVersion=99", (record: Record<string, unknown>) => { record.schemaVersion = 99; }],
    ["archivedAtTick=NaN", (record: Record<string, unknown>) => { record.archivedAtTick = Number.NaN; }],
    ["非法 via", (record: Record<string, unknown>) => { record.via = "unknown-channel"; }],
    ["profile/class 冲突（forensic-isolated + lowlevel class）", (record: Record<string, unknown>) => {
      (record.identity as Record<string, unknown>).identityProfile = "forensic-isolated";
    }],
    ["outcome 被改为 committed", (record: Record<string, unknown>) => { record.resolution = "committed"; }],
    ["durableIdentityDigest 修改", (record: Record<string, unknown>) => {
      (record.identity as Record<string, unknown>).durableIdentityDigest = "9999999999abc001";
    }],
    ["lineageDisposition 非法", (record: Record<string, unknown>) => { record.lineageDisposition = "final?"; }],
  ])("篡改 %s → archive blocked、completion 保留、无 destructive deletion", (_name, mutate) => {
    const transactionId = seedArchivableScene("x");
    tamperHistorical(transactionId, mutate);
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    expect(archived.status).toBe("blocked");
    // live completion 保留（零删除）。
    const completion = (Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, unknown> } } })
      .treasury!.cleanupCompletions!.entries!;
    expect(completion["cc:" + transactionId]).toBeDefined();
  });
});

// ── T9：legacy / forensic 不得 automatic archive ────────────────────────────

describe("Remediation VII T9：隔离 profile 的 completion 不参与 automatic archive", () => {
  function seedIsolatedCompletion(transactionId: string, identityProfile: "legacy-replay" | "forensic-isolated"): void {
    // legacy-replay：digest-only（无 durable/contract/cohort/lowlevel——合法遗留形状）。
    // forensic-isolated：forensic class（profile↔class 唯一组合）。
    const identity = identityProfile === "forensic-isolated"
      ? { digest: DIGEST, identityProfile, proofClass: "forensic" }
      : { digest: DIGEST, identityProfile, proofClass: "legacy" };
    const entry = {
      transactionId,
      digest: DIGEST,
      resolution: "not-executed" as const,
      proofClass: identity.proofClass,
      identityProfile,
      settlementProofDurable: true,
      markerDischarged: true,
      authorityReleased: true,
      outcomeFinalized: true,
      lineageFinalized: true,
      lowlevelSource: undefined,
      durableIdentityDigest: undefined,
    };
    const written = recordTreasuryCleanupCompletion({
      entry: entry as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    if (written.status === "rejected") throw new Error("seed rejected: " + written.detail);
  }

  it.each(["legacy-replay", "forensic-isolated"] as const)(
    "%s completion：compact-archive / headroom reclaim → blocked profile_isolated、completion 保留",
    (profile) => {
      const transactionId = mintedId("t9_" + profile);
      seedIsolatedCompletion(transactionId, profile);
      // compact-archive（headroom reclaim 的回收通道）→ blocked。
      const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
      expect(archived.status).toBe("blocked");
      if (archived.status === "blocked") expect(archived.reason).toBe("profile_isolated");
      // completion 保留；historical 零写入。
      expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
      const completion = (Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, unknown> } } })
        .treasury!.cleanupCompletions!.entries!;
      expect(completion["cc:" + transactionId]).toBeDefined();
    },
  );

  it("隔离 profile 填满 completion store → headroom 回收不删除、新 writer fail closed（callback 零调用）", () => {
    const service = makeService();
    // 隔离 profile 塞满 live store（128）。
    for (let index = 0; index < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; index += 1) {
      seedIsolatedCompletion(abandonedId("t9_fill_" + index), index % 2 === 0 ? "legacy-replay" : "forensic-isolated");
    }
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    // 新 writer：prepare 拒绝（headroom exhausted——隔离项不可回收）。
    const fresh = mintedId("t9_fresh");
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, fresh), callback);
    expect(executed.status).toBe("prepare_rejected");
    expect(callback).not.toHaveBeenCalled();
    // completion 均保留（无自动回收）。
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
  });
});

// ── T10：真正的 reservation race ────────────────────────────────────────────

describe("Remediation VII T10：独占 reservation 的容量竞争", () => {
  it("live=MAX-1：prepare A 持有最后一个 reservation → B 无法抢占 → A execute callback 恰一次；live+reserved 从未超过 MAX", () => {
    const service = makeService();
    // live completion 填到 MAX-1。
    for (let index = 0; index < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES - 1; index += 1) {
      seedCompletionEntry(abandonedId("t10_fill_" + index));
    }
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES - 1);
    // prepare A → 独占 reservation（live 127 + reserved 1 = 128）。
    const a = mintedId("t10_a");
    const preparedA = service.prepareTransaction(input(service, a));
    expect(preparedA.status).toBe("prepared");
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(1);
    expect(peekTreasuryCleanupCompletionEntryCount() + peekTreasuryCompletionHeadroomReservationCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    // B 无法偷走 A 的 reservation：【IX 工作流 E 8.1 单一公式】下 B 的
    // prepare 先被拒（127+1+1=129>128）→ 低层 ensureHeadroom 的 bounded
    // reclaim 腾出 1 个 live 槽（127→126）→ B 合法取得（126+1+1=128≤MAX
    // ——不侵占 A 的独占槽；旧的双重计数口径会在 reclaim 后仍误拒）。
    const b = mintedId("t10_b");
    const preparedB = service.prepareTransaction(input(service, b));
    expect(peekTreasuryCompletionHeadroomReservation(a)).toBeDefined();
    expect(peekTreasuryCleanupCompletionEntryCount() + peekTreasuryCompletionHeadroomReservationCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    void preparedB;
    // A execute：reservation 在位 → callback 恰一次、committed。
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, a), callback);
    expect(executed.status).toBe("executed_committed");
    expect(callback).toHaveBeenCalledTimes(1);
    // 恒成立：live + reserved ≤ MAX。
    expect(peekTreasuryCleanupCompletionEntryCount() + peekTreasuryCompletionHeadroomReservationCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    // 【Remediation VIII D3 语义更新】普通成功 commit（无 cleanup journal/
    // unresolved authority 接管）→ reservation 立即释放，不得滞留至 TTL
    //（R5）；后续需要写 completion 的 cleanup 经 handoff owner 的 recovery
    // acquire 重新取得（R6/B 场景由 VIII 测试覆盖）。
    expect(peekTreasuryCompletionHeadroomReservation(a)).toBeUndefined();
    // B 的 reservation（若经 reclaim 取得）仍在位——live+reserved ≤ MAX 恒成立。
    expect(peekTreasuryCleanupCompletionEntryCount() + peekTreasuryCompletionHeadroomReservationCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
  });
});

function preparedRejected(result: { status: string }): boolean {
  return result.status === "rejected";
}

// ── T11：重复 prepare 不重复 reservation ────────────────────────────────────

describe("Remediation VII T11：重复 prepare 的 reservation 幂等", () => {


  it("同 ID 同 payload 重复 prepare → 同一 handle 语义、reservation 单条；不同 payload → prepare_conflict、原 reservation 保留", () => {
    const service = makeService();
    const transactionId = mintedId("t11");
    const first = service.prepareTransaction(input(service, transactionId));
    expect(first.status).toBe("prepared");
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(1);
    const again = service.prepareTransaction(input(service, transactionId));
    expect(again.status).toBe("prepared");
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(1);
    // 不同 payload（不同 delta）→ prepare_conflict；reservation 不被释放给他人。
    const conflicting = service.prepareTransaction(input(service, transactionId, -501));
    expect(conflicting.status).toBe("rejected");
    if (conflicting.status === "rejected") expect(conflicting.reason).toBe("prepare_conflict");
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(1);
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
  });
});

// ── T12：Reservation 安全释放 ───────────────────────────────────────────────

describe("Remediation VII T12：确定未开始路径的 reservation 释放", () => {
  it("explicit abort → reservation 释放", () => {
    const service = makeService();
    const transactionId = mintedId("t12_abort");
    const prepared = service.prepareTransaction(input(service, transactionId));
    if (prepared.status !== "prepared") throw new Error("prepare rejected");
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
    expect(service.abortPreparedTransaction(prepared.handle).status).toBe("aborted");
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
  });

  it("cross-tick expired handle（endTick invalidate）→ reservation 释放", () => {
    const service = makeService();
    const transactionId = mintedId("t12_expire");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    service.endTick();
    // invalidate（prepared → expired）：reservation 随 tick 边界释放。
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
  });

  it("invalid authorization（execute redemption 失败）→ callback 零调用、reservation 释放", () => {
    const service = makeService();
    const transactionId = mintedId("t12_auth");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    const callback = jest.fn(() => ({ ok: true }) as never);
    // 伪造 bundle（未授权对象）→ redemption 拒绝。
    const forgedBundle = { __brand: "treasury-authorization-bundle" } as never;
    const executed = service.executePreparedAction(
      input(service, transactionId),
      callback,
      { authorizationBundle: forgedBundle } as never,
    );
    expect(executed.status).toBe("prepare_rejected");
    expect(callback).not.toHaveBeenCalled();
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
  });

  it("exact identity binding 失败（reservation 已绑定不同 digest）→ 拒绝、零 Intent、reservation 释放", () => {
    const service = makeService();
    const transactionId = mintedId("t12_bind");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    // 篡改 reservation 的 boundIdentityDigest（模拟损坏/不同 identity 绑定）。
    const raw = (Memory.runtime as unknown as { treasury?: { completionHeadroomReservations?: { entries?: Record<string, { boundIdentityDigest?: string }> } } })
      .treasury!.completionHeadroomReservations!.entries!;
    raw["hr:" + transactionId]!.boundIdentityDigest = "ffffffffffff0001";
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, transactionId), callback);
    expect(executed.status).toBe("prepare_rejected");
    expect(callback).not.toHaveBeenCalled();
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    // 零 Intent（callback 确定未开始）。
    const intents = (Memory.runtime as unknown as { treasury?: { intents?: { entries?: Record<string, unknown> } } }).treasury?.intents?.entries ?? {};
    expect(intents["i:" + transactionId]).toBeUndefined();
  });
});

// ── T13：execution unknown 保留 reservation ─────────────────────────────────

describe("Remediation VII T13：execution unknown 的 reservation 保留", () => {
  it("callback 抛错 → rethrow、reservation 保留（TTL 后 quarantine 在仍不释放）", () => {
    const service = makeService();
    const transactionId = mintedId("t13");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    expect(() =>
      service.executePreparedAction(input(service, transactionId), () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // execution unknown：reservation 保留（不得提前释放）。
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
    // TTL 之后 sweep：quarantine 接管 → 仍保留（resolution cleanup 后才消费）。
    Game.time += TREASURY_COMPLETION_RESERVATION_TTL_TICKS + 1;
    const { sweepExpiredTreasuryCompletionHeadroomReservations } = require("@/runtime/treasury/completionHeadroomReservation") as typeof import("@/runtime/treasury/completionHeadroomReservation");
    sweepExpiredTreasuryCompletionHeadroomReservations(new Set());
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
  });
});

// ── T14：Prepared handle 后容量变化窗口 ─────────────────────────────────────

describe("Remediation VII T14：prepare 后容量变化窗口", () => {
  it("A 持有合法 reservation：其它 writer 占满 live store → A 仍能安全执行（reservation 保证）", () => {
    const service = makeService();
    const transactionId = mintedId("t14_a");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    // 其它状态变化：live completion 被填满（128/128——普通 headroom 检查会
    // 认为不足，但 A 的独占 reservation 已经把一个槽锁给 A）。
    for (let index = 0; index < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; index += 1) {
      seedCompletionEntry(abandonedId("t14_fill_" + index));
    }
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, transactionId), callback);
    expect(executed.status).toBe("executed_committed");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("A reservation 失效（缺失）→ callback 零调用、Intent 未写入", () => {
    const service = makeService();
    const transactionId = mintedId("t14_b");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    // reservation 失效（持久层删除——entryCount 同步保持 shape 一致）。
    const store = (Memory.runtime as unknown as { treasury?: { completionHeadroomReservations?: { entries?: Record<string, unknown>; entryCount?: number } } })
      .treasury!.completionHeadroomReservations!;
    delete store.entries!["hr:" + transactionId];
    store.entryCount = Object.keys(store.entries!).length;
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, transactionId), callback);
    expect(executed.status).toBe("prepare_rejected");
    expect(callback).not.toHaveBeenCalled();
    // 零 Intent（final admission 前移——Intent 尚未写入）。
    const intents = (Memory.runtime as unknown as { treasury?: { intents?: { entries?: Record<string, unknown> } } }).treasury?.intents?.entries ?? {};
    expect(intents["i:" + transactionId]).toBeUndefined();
  });
});


// ── T15：tr1_ reservation 顺序 ──────────────────────────────────────────────

describe("Remediation VII T15：tr1_ 的 final admission 顺序（reservation → capability 消费 → child_active → callback）", () => {
  it("reservation 失败注入 → capability 保持未消费、lineage 停在可恢复前置状态、callback 零调用", () => {
    const service = makeService();
    const root = "vii_t15_root";
    const lineageId = seedRearmReadyRoot(root);
    const issued = service.issueTreasuryRearmCapability({ parentTransactionId: root });
    if (issued.status !== "issued") throw new Error("capability issue rejected: " + JSON.stringify(issued).slice(0, 200));
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    // prepare 持有 handle + reservation；随后删除 reservation（失效注入）。
    const prepared = service.prepareTransaction(input(service, childId), { rearmCapability: issued.capability } as never);
    expect(prepared.status).toBe("prepared");
    const store = (Memory.runtime as unknown as { treasury?: { completionHeadroomReservations?: { entries?: Record<string, unknown>; entryCount?: number } } })
      .treasury!.completionHeadroomReservations!;
    delete store.entries!["hr:" + childId];
    store.entryCount = Object.keys(store.entries!).length; // shape 一致（missing 语义而非损坏）
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, childId), callback, { rearmCapability: issued.capability } as never);
    expect(executed.status).toBe("prepare_rejected");
    expect(callback).not.toHaveBeenCalled();
    if (executed.status === "prepare_rejected") {
      // final admission 的结构化 reason（reservation missing——prepare 幂等
      // 返回后 reservation 已被删除，admit 拒绝）。
      expect(executed.reason).toBe("completion_headroom_exhausted");
    }
    // capability 保持未消费、lineage 未推进（消费成功会立即 child_active）：
    // 停在可恢复前置状态 child_intent_pending（beginTick 回滚 rearm_ready，
    // 同代 child 保留可重签）。
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    // 可恢复前置状态（rearm_ready / capability_issued / child_intent_pending
    // 任一——绝不是 child_active）。
    expect(["rearm_ready", "capability_issued", "child_intent_pending"]).toContain(record.state);
    expect(record.currentTransactionId).toBe(root);
    // 零 Intent（final admission 前移——Intent 尚未写入）。
    const intents = (Memory.runtime as unknown as { treasury?: { intents?: { entries?: Record<string, unknown> } } }).treasury?.intents?.entries ?? {};
    expect(intents["i:" + childId]).toBeUndefined();
  });
});

// ── T16：Global reset 的 reservation 窗口 ──────────────────────────────────

describe("Remediation VII T16：global reset 各窗口的 reservation 一致性", () => {
  it("窗口 1/2：prepare 后（callback 前）global reset → reservation durable 仍在、重放 execute 正常（幂等 acquire 不重复计数）", () => {
    const service = makeService();
    const transactionId = mintedId("t16_w1");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    // global reset 模拟（heap 失效；handle 是 heap 权威——重放走重新 prepare）。
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(1);
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, transactionId), callback);
    expect(executed.status).toBe("executed_committed");
    expect(callback).toHaveBeenCalledTimes(1);
    // 【Remediation VIII D3 语义更新】普通无 cleanup-pending 的 committed
    // 不遗留 reservation（旧预期 1 → 新预期 0——T16 按任务书修正）。
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
  });

  it("窗口 4：callback started_unknown 后 reset → quarantine 接管、reservation 保留（TTL sweep 不释放）", () => {
    const service = makeService();
    const transactionId = mintedId("t16_w4");
    expect(service.prepareTransaction(input(service, transactionId)).status).toBe("prepared");
    expect(() =>
      service.executePreparedAction(input(service, transactionId), () => {
        throw new Error("reset-window");
      }),
    ).toThrow("reset-window");
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    Game.time += TREASURY_COMPLETION_RESERVATION_TTL_TICKS + 1;
    const { sweepExpiredTreasuryCompletionHeadroomReservations } = require("@/runtime/treasury/completionHeadroomReservation") as typeof import("@/runtime/treasury/completionHeadroomReservation");
    sweepExpiredTreasuryCompletionHeadroomReservations(new Set());
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
  });

  it("窗口 6：completion 写入（consume）后 reset → reservation absent（无泄漏）", () => {
    const service = makeService();
    const transactionId = mintedId("t16_w6");
    executeCommitted(service, transactionId);
    // completion 写入路径已 consume。
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
  });
});

// ── T17：真实 300-generation chain 的压缩 ──────────────────────────────────

describe("Remediation VII T17：300-generation chain 的 terminal 压缩（footprint 与 generation 数量无关）", () => {
  it("generation 1..300 实际执行 → terminal compaction → historical 0 条、certificate 1 条、root+全部代 exact 可查", () => {
    const root = "vii_chain_root";
    const rootDurable = seedQuarantineEntry(root);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "8888777766665551",
    });
    if (created.status !== "written") throw new Error("seed rejected");
    const lineageId = created.record.lineageId;
    let currentId = root;
    let currentDurable = rootDurable;
    let currentBinding: string | undefined;
    let currentParent: string | undefined;
    let currentGeneration = 0;
    seedFinalNotExecutedTombstone(root, rootDurable);
    expect(releaseTreasuryQuarantineEntry(root)).toBe(true);

    const settleParentCleanup = (parentId: string, parentDurable: string, generation: number): void => {
      if (readTreasuryResolutionTombstone(parentId) === undefined && generation > 0) {
        seedFinalNotExecutedTombstone(parentId, parentDurable, {
          lineageId,
          lineageGeneration: generation,
          ...(currentParent !== undefined ? { parentTransactionId: currentParent } : {}),
          ...(currentBinding !== undefined ? { lineageBindingDigest: currentBinding } : {}),
        });
      }
      const opened = openTreasuryResolutionCleanup(
        treasuryResolutionCleanupOpenInputOfFacts({
          transactionId: parentId,
          digest: DIGEST,
          resolution: "not-executed",
          proofClass: "lowlevel",
          lowlevelSource: RUNTIME,
          durableIdentityDigest: parentDurable,
          ...(generation > 0
            ? {
                lineageId,
                lineageGeneration: generation,
                ...(currentParent !== undefined ? { parentTransactionId: currentParent } : {}),
                ...(currentBinding !== undefined ? { lineageBindingDigest: currentBinding } : {}),
              }
            : {}),
        }),
      );
      expect(opened.status).toBe("opened");
      const store = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
      store!.entries!["c:" + parentId]!.settlementProofDurable = true;
      expect(markTreasuryResolutionCleanupStage(parentId, "marker_discharge", "already_absent")).not.toBe("rejected");
      expect(advanceTreasuryResolutionCleanupPhases({ transactionId: parentId }).status).toBe("completed");
    };

    for (let generation = 1; generation <= 300; generation++) {
      expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
      settleParentCleanup(currentId, currentDurable, currentGeneration);
      const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root);
      expect(stageTreasuryLineageCapabilityIssued(lineageId, childId).status).not.toBe("rejected");
      expect(stageTreasuryLineageChildIntentPending(lineageId, childId).status).not.toBe("rejected");
      const binding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
      const childDurable = recomputeTreasuryDurableIdentityDigest({
        transactionId: childId, digest: DIGEST, actionKind: "terminal.send", source: "test",
        postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
        lineageId, lineageGeneration: generation, parentTransactionId: currentId, lineageBindingDigest: binding,
      })!;
      expect(activateTreasuryLineageChild(lineageId, { digest: DIGEST, durableIdentityDigest: childDurable, lowlevelSource: RUNTIME }).status).not.toBe("rejected");
      const retired = retireTreasuryLineageCurrentAttempt(
        generation === 300 ? { lineageId, rearmable: false, nonRearmReason: "chain terminal fixture" } : { lineageId },
      );
      expect(retired.status).not.toBe("rejected");
      currentParent = currentId;
      currentBinding = binding;
      currentId = childId;
      currentDurable = childDurable;
      currentGeneration = generation;
      if (generation % 50 === 0) {
        Game.time += TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST + 1;
        resetTreasuryCleanupCompletionHeapCacheForTest();
        resetTreasuryCleanupSupersessionHeapCacheForTest();
      }
    }

    settleParentCleanup(currentId, currentDurable, 300);
    const compacted = compactTreasuryTerminalLineage(lineageId);
    if (compacted.status === "rejected") console.log("T17 COMPACT REJECTED:", JSON.stringify(compacted).slice(0, 500));
    expect(compacted.status).toBe("compacted");
    // terminal 压缩后：historical 不保留 301 条 per-attempt 永久记录；
    // chain 级永久 footprint 与 generation 数量无关（certificate 一条）。
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
    expect(peekTreasuryChainCertificateEntryCount()).toBe(1);
    expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeDefined();
    // root 与 generation 1..300 全部 exact not-executed（certificate 承载，
    // GRA/Tombstone/Receipt GC + heap reset 后仍成立）。
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    const expectResolved = (attemptId: string): void => {
      // 【Remediation VIII C4】压缩后权威是 chain certificate 的协议推导
      //（protocol）——重放阻断等效，identity 不足不冒充 exact。
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: attemptId });
      expect(resolved.status).toBe("protocol");
      if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    };
    expectResolved(root);
    for (let generation = 1; generation <= 300; generation++) {
      expectResolved(deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root));
    }
    // 错误 outcome 视角 / 超出 final generation 不 match。
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: currentId, expectedOutcome: "committed" }).status).toBe("conflict");
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: deriveTreasuryLineageNextChildTransactionId(lineageId, 301, root) }).status).toBe("absent");
  });
});


// ── T18：超过旧 384 边界仍能继续运行 ───────────────────────────────────────

describe("Remediation VII T18：600 initial attempts 跨越旧 384 边界持续运行", () => {
  it("600 个 ti1_ initial attempts：满载压缩循环、旧 ID 全部不可重放、新 writer 正常、permanent authority 有界", () => {
    const TOTAL = 600;
    const allIds: string[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      const transactionId = abandonedId("t18_" + index);
      allIds.push(transactionId);
      seedHistoricalRecord({ transactionId, resolution: index % 3 === 0 ? "committed" : "not-executed" });
      // 满载（384）时正式压缩通道退休旧的（range 吸收）——不人工清库。
      if (peekTreasuryCleanupSupersessionEntryCount() >= TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES) {
        const compressed = compressTreasuryRetirableHistoricalEntries();
        expect(compressed.retired).toBeGreaterThan(0);
        expect(peekTreasuryCleanupSupersessionEntryCount()).toBeLessThan(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES);
      }
    }
    // 全部 600 ID 不可重放：retired range / 保留窗口 exact —— 无一 absent。
    let retired = 0;
    let exact = 0;
    for (const transactionId of allIds) {
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
      expect(resolved.status === "retired" || resolved.status === "exact").toBe(true);
      if (resolved.status === "retired") retired += 1;
      if (resolved.status === "exact") exact += 1;
    }
    expect(retired).toBeGreaterThan(0);
    expect(exact).toBeGreaterThan(0);
    // permanent authority 有界：range ≤ 64、historical ≤ 384、cert = 0。
    expect(peekTreasuryRetiredRangeEntryCount()).toBeLessThanOrEqual(64);
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES);
    expect(peekTreasuryChainCertificateEntryCount()).toBe(0);
    // watermark 单调推进（600 次发行，global reset 后不回退）。
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptWatermark()).toBeGreaterThanOrEqual(TOTAL);
    // 新 writer 正常：minted 新 ID 走真实 prepare → execute（callback 恰一次）。
    const service = makeService();
    const fresh = mintedId("t18_fresh");
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, fresh), callback);
    expect(executed.status).toBe("executed_committed");
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ── T19：Service-issued initial ID ─────────────────────────────────────────

describe("Remediation VII T19：issuer 单调、防伪、防复用、correlation 隔离", () => {
  it("mint 单调递增；global reset（heap 失效）后不回退", () => {
    const first = mintTreasuryInitialAttemptId("a");
    const second = mintTreasuryInitialAttemptId("b");
    expect(first.status).toBe("minted");
    expect(second.status).toBe("minted");
    if (first.status === "minted" && second.status === "minted") {
      expect(second.sequence).toBe(first.sequence + 1);
    }
    const watermark = peekTreasuryIssuedAttemptWatermark();
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermark);
    const third = mintTreasuryInitialAttemptId("c");
    expect(third.status).toBe("minted");
    if (third.status === "minted" && second.status === "minted") {
      expect(third.sequence).toBe(second.sequence + 1);
    }
  });

  it("手工伪造（seq > watermark）→ forged_future；合法发行 → issued；arbitrary → not_service_issued；【VIII A1 更新】seq ≤ watermark + 错误完整 ID → legacy_unverified", () => {
    const minted = mintTreasuryInitialAttemptId("check");
    expect(minted.status).toBe("minted");
    const watermark = peekTreasuryIssuedAttemptWatermark();
    const issued = checkTreasuryServiceIssuedAttemptId(minted.status === "minted" ? minted.transactionId : "");
    expect(issued.status).toBe("issued");
    const forged = `ti2_${String(watermark + 7)}_0123456789abcdef`;
    expect(checkTreasuryServiceIssuedAttemptId(forged).status).toBe("forged_future");
    expect(checkTreasuryServiceIssuedAttemptId("arbitrary-caller-id").status).toBe("not_service_issued");
    // 【Remediation VIII A1】seq ≤ watermark 但 hash16 篡改——不因 sequence
    // 合法而被当作 issued（完整 ID 必须与确定性重算一致）。
    const mintedId0 = minted.status === "minted" ? minted.transactionId : "";
    const separator = mintedId0.lastIndexOf("_");
    const hash = mintedId0.slice(separator + 1);
    const tampered = mintedId0.slice(0, separator + 1) + (hash.charCodeAt(hash.length - 1) === 0x30 ? "1" : "0") + hash.slice(1);
    const tamperedCheck = checkTreasuryServiceIssuedAttemptId(tampered);
    expect(tamperedCheck.status).toBe("legacy_unverified");
    if (tamperedCheck.status === "legacy_unverified") expect(tamperedCheck.sequence).toBe(watermark);
  });

  it("caller correlation 只是 metadata：不同 correlation → 不同 ID；correlation 不影响 issuer 判定", () => {
    const a = mintTreasuryInitialAttemptId("order-42");
    const b = mintTreasuryInitialAttemptId("order-43");
    expect(a.status).toBe("minted");
    expect(b.status).toBe("minted");
    if (a.status === "minted" && b.status === "minted") {
      expect(a.transactionId).not.toBe(b.transactionId);
      expect(checkTreasuryServiceIssuedAttemptId(a.transactionId).status).toBe("issued");
    }
  });

  it("production contract 通道拒绝伪造 ti1_（seq 超过 watermark）", () => {
    const service = makeService();
    const watermark = peekTreasuryIssuedAttemptWatermark();
    const forged = `ti1_${String(watermark + 99)}_0123456789abcdef`;
    const built = buildTreasuryActionContract(service, {
      actionKind: "terminal.send",
      transactionId: forged,
      args: { target: "W1N57", resourceType: "energy", amount: 100 } as never,
    });
    if (built.status === "rejected") return; // build 侧拒绝同样成立
    const executed = executeTreasuryActionContract(service, {
      contract: built.contract,
    });
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") {
      // forged 检查先于 authorization——伪造 ID 的拒绝 reason 唯一确定。
      expect(executed.reason).toBe("transaction_id_not_issued");
    }
  });
});
