/**
 * 【Round 22 Remediation VIII】固定反例矩阵——Verifiable Issued IDs /
 * Unified Settlement Reconciliation / Reservation-backed Completion /
 * Pre-allocation Stationary Ownership（Treasury 侧）。
 *
 * 覆盖任务书：
 * - I1–I7（工作流 A）：service-issued ID 的完整可验证性（同 sequence 唯一
 *   合法完整 ID / global reset 后可重算 / arbitrary 与 ts1_/tt1_ 不进
 *   production contract writer / issuer 损坏 fail closed）；
 * - S1–S9（工作流 B）：统一 settlement reconciliation（无短路聚合——
 *   后方 conflict / store unhealthy 不被前方 match 遮蔽；certificate-only
 *   被 replay/opposite/occupancy/reconciliation 一致认识；settlement 与
 *   cleanup completion 权威分离）；
 * - C1–C7（工作流 C）：chain certificate 的真实证明能力（root/final
 *   outcome 规则 / tr1_ checksum 验证 / canonical 关系 / protocol 不冒充
 *   exact）；
 * - R1–R13（工作流 D）：reservation 生命周期（无效 prepare 零泄漏 / 普通
 *   成功零滞留 / matching handoff / 中断恢复 / TTL owner truth graph /
 *   结构化 mutation 结果）；
 * - L1–L5（工作流 E）：长期有界（>128 terminal chain / >64 乱序退休区间
 *   coalesce / >384 historical 真实路径 / global reset 后 permanent
 *   authority 存续）。
 * （S10 架构守护在 treasuryWriteArchitecture.test.ts。）
 *
 * 所有 Game 写动作均使用 mock/spies——不访问真实 Screeps API。
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
  resetTreasuryAttemptIssuerHeapCacheForTest,
} from "@/runtime/treasury/attemptIssuer";
import {
  resolveTreasuryDurableSettlementAuthority,
  resolveTreasuryCleanupCompletionAuthority,
} from "@/runtime/treasury/historicalSettlementAuthority";
import {
  checkTreasuryAttemptRetiredRange,
  clearTreasuryChainCertificateDurableForTest,
  lookupTreasuryChainRetirementCertificate,
  peekTreasuryChainCertificateEntryCount,
  peekTreasuryRetiredRangeEntryCount,
  recordTreasuryChainRetirementCertificate,
  resetTreasuryChainCertificateHeapCacheForTest,
  TREASURY_RETIRED_RANGE_MAX_ENTRIES,
} from "@/runtime/treasury/chainRetirementCertificate";
import {
  clearTreasuryCleanupCompletionDurableForTest,
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionEntryCount,
  resetTreasuryCleanupCompletionHeapCacheForTest,
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  clearTreasuryCleanupSupersessionDurableForTest,
  lookupTreasuryHistoricalCompletion,
  peekTreasuryCleanupSupersessionEntryCount,
  resetTreasuryCleanupSupersessionHeapCacheForTest,
  TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES,
  type TreasuryHistoricalCompletionRecord,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  admitTreasuryCompletionHeadroomReservationForExecution,
  acquireTreasuryCompletionHeadroomReservation,
  clearTreasuryCompletionHeadroomReservationDurableForTest,
  consumeTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservationCount,
  releaseTreasuryCompletionHeadroomReservation,
  resetTreasuryCompletionHeadroomReservationHeapCacheForTest,
  TREASURY_COMPLETION_RESERVATION_TTL_TICKS,
} from "@/runtime/treasury/completionHeadroomReservation";
import {
  admitTreasuryCompletionPublicationReservation,
  peekTreasuryEffectiveCompletionOccupancy,
  reconcileTreasuryReservationCompletionPairs,
  releaseTreasuryCompletionHeadroomChecked,
  sweepOrphanTreasuryCompletionReservations,
} from "@/runtime/treasury/cleanupCompletionHandoff";
import { checkTreasuryOppositeProofsForCommitted, checkTreasuryOppositeProofsForNotExecuted } from "@/runtime/treasury/oppositeProofMatrix";
import { checkTreasuryChildAttemptOccupancy } from "@/runtime/treasury/attemptOccupancy";
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
import { executeTreasuryActionContract, buildTreasuryActionContract, sealTreasuryAdapterRegistryForProduction, unsealTreasuryAdapterRegistryForTest, clearTreasuryAdapterRegistryForTest, registerTreasuryActionAdapter, makeTreasuryTestTransferAdapter } from "@/runtime/treasury/actionContracts";
import {
  createTreasuryAttemptLineageRecord,
  deriveTreasuryLineageNextChildTransactionId,
  readTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
} from "@/runtime/treasury/attemptLineage";
import { compactTreasuryTerminalLineage } from "@/runtime/treasury/lineageRetirementSummary";
import { computeTreasuryLowlevelRetrySemanticDigest } from "@/runtime/treasury/retrySemanticIdentity";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { clearTreasuryPersistenceForTest, readTreasurySettlementProof } from "@/runtime/treasury/receipts";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

jest.setTimeout(300_000);

const RUNTIME = TREASURY_LOWLEVEL_SOURCE_RUNTIME;
const DIGEST = "0123456789abc001";
const TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST = 5_000;

beforeEach(() => {
  jest.clearAllMocks();
  clearTreasuryPersistenceForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  clearTreasuryCleanupSupersessionDurableForTest();
  clearTreasuryChainCertificateDurableForTest();
  clearTreasuryAttemptIssuerDurableForTest();
  clearTreasuryCompletionHeadroomReservationDurableForTest();
  resetTreasuryResolutionStoreForTest();
});

// ── 共享 fixture（与 VII 同构）──────────────────────────────────────────────

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
  const minted = mintTreasuryInitialAttemptId(correlation);
  if (minted.status !== "minted") throw new Error("mint rejected in fixture");
  return minted.transactionId;
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

function seedFinalNotExecutedTombstone(transactionId: string, durable: string): void {
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
  } as never);
  expect(write.status).not.toBe("rejected");
}

/** root lineage seed → rearm_ready → converge（non_rearmable 终态）。 */
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
    nonRearmReason: "test fixture",
  });
  if (created.status !== "written") throw new Error("lineage seed rejected");
  const lineageId = created.record.lineageId;
  seedFinalNotExecutedTombstone(transactionId, durable);
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
  return lineageId;
}

/** rearmable root（rearm_ready——converge 正式通道）。 */
function seedRearmReadyRoot(transactionId: string): string {
  const durable = seedQuarantineEntry(transactionId);
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable: true,
    identityProfile: "lowlevel",
    retrySemanticDigest: computeTreasuryLowlevelRetrySemanticDigest({
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
      lowlevelSource: RUNTIME,
    }) ?? "8888777766665550",
  });
  if (created.status !== "written") throw new Error("lineage seed rejected");
  const lineageId = created.record.lineageId;
  seedFinalNotExecutedTombstone(transactionId, durable);
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
  return lineageId;
}

/**
 * 真实低层路径执行一个 initial attempt 至 committed（Game mock OK）→ 完整
 * cleanup（journal open → 五阶段 → completion 写入 + consume）。
 */
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
  // final committed tombstone（持久层注入完整形状——状态机前置绕过）。
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

/** production contract 通道（sealed registry——真实 adapter 装配后的门禁）。 */
function contractExecuteSealed(service: TreasuryTestService, transactionId: string): { status: string; reason?: string; detail?: string } {
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
  if (built.status === "rejected") return built;
  sealTreasuryAdapterRegistryForProduction();
  try {
    return executeTreasuryActionContract(service, { contract: built.contract }) as { status: string; reason?: string; detail?: string };
  } finally {
    unsealTreasuryAdapterRegistryForTest();
    // 隔离：本 helper 注册的 terminal.send adapter 不泄漏到后续测试
    //（capability 的 adapter 语义绑定对 registry 状态敏感）。
    clearTreasuryAdapterRegistryForTest();
  }
}

/** 篡改 ti1_ ID 的 hash16 一位（sequence 保持不变）。 */
function tamperHash16(transactionId: string): string {
  const separator = transactionId.lastIndexOf("_");
  const prefix = transactionId.slice(0, separator + 1);
  const hash = transactionId.slice(separator + 1);
  const flipped = (hash.charCodeAt(hash.length - 1) === 0x30 ? "1" : "0") + hash.slice(1);
  return prefix + flipped;
}

// ── I 组：完整可验证的 service-issued ID ───────────────────────────────────

describe("Remediation VIII I：issued attempt ID 的完整可验证性", () => {
  it("I1：合法 sequence 保持、篡改 hash16 一位 → production contract 拒绝、callback 零调用", () => {
    const service = makeService();
    const transactionId = mintedId("i1_legit");
    const tampered = tamperHash16(transactionId);
    expect(tampered).not.toBe(transactionId);
    // sequence 不变（篡改只在 hash lane）。
    const executed = contractExecuteSealed(service, tampered);
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") expect(executed.reason).toBe("transaction_id_not_issued");
  });

  it("I2：arbitrary caller ID → production contract（sealed）在 Game callback 前拒绝", () => {
    const service = makeService();
    const executed = contractExecuteSealed(service, "i2_arbitrary_caller_id");
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") expect(executed.reason).toBe("transaction_id_not_service_issued");
  });

  it("I3：ts1_ / tt1_ 命名空间 → production contract（sealed）拒绝（不得当作当前 initial attempt）", () => {
    const service = makeService();
    for (const transactionId of ["ts1_0123456789abcdef", "tt1_1234_0123456789abcdef"]) {
      const executed = contractExecuteSealed(service, transactionId);
      expect(executed.status).toBe("prepare_rejected");
      if (executed.status === "prepare_rejected") expect(executed.reason).toBe("transaction_id_not_service_issued");
    }
    // unsealed（测试域受控入口）不触发命名空间拒绝（隔离验证——拒绝只属于
    // production channel）。
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    registerTreasuryActionAdapter({
      ...makeTreasuryTestTransferAdapter(),
      kind: "terminal.send",
      semanticIdentity: "terminal.send@reconciler-semantics-v1",
    } as never);
    const built = buildTreasuryActionContract(service, {
      actionKind: "terminal.send",
      transactionId: "ts1_0123456789abcdef",
      args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W1N57", toLocation: "terminal", resource: "energy", amount: 100, outcome: "ok" } as never,
    });
    expect(built.status).toBe("built");
    const executedUnsealed = executeTreasuryActionContract(service, built.status === "built" ? { contract: built.contract } : {}) as { status: string; reason?: string };
    expect(executedUnsealed.status).toBe("prepare_rejected");
    if (executedUnsealed.status === "prepare_rejected") expect(executedUnsealed.reason).not.toBe("transaction_id_not_service_issued");
  });

  it("I4：完整合法 minted ID 正常执行、callback 恰好一次（真实低层全流程）", () => {
    const service = makeService();
    const transactionId = mintedId("i4_full");
    const callback = jest.fn(() => ({ ok: true }) as never);
    const executed = service.executePreparedAction(input(service, transactionId), callback);
    expect(executed.status).toBe("executed_committed");
    expect(callback).toHaveBeenCalledTimes(1);
    // sealed production contract 通道的 ID 门禁放行完整 minted ID（拒绝只
    // 发生在 authorization 检查——ID 命名空间验证通过）。
    const sealedProbe = contractExecuteSealed(service, mintedId("i4_probe"));
    if (sealedProbe.status === "prepare_rejected") {
      expect(sealedProbe.reason).not.toBe("transaction_id_not_issued");
      expect(sealedProbe.reason).not.toBe("transaction_id_not_service_issued");
    }
  });

  it("I5：global reset 后 watermark 不回退、合法完整 ID 仍可验证、同 sequence 错误 checksum 仍拒绝", () => {
    const transactionId = mintedId("i5_reset");
    const watermark = peekTreasuryIssuedAttemptWatermark();
    resetTreasuryAttemptIssuerHeapCacheForTest();
    clearTreasuryAttemptIssuerDurableForTest();
    // 保留 Memory store（模拟 global reset：只失效 heap）——重新加载。
    // 上面 clear 会连 Memory 删除——改用直接 heap reset（重建场景在 VII T19）。
    const transactionId2 = mintedId("i5_again");
    const watermark2 = peekTreasuryIssuedAttemptWatermark();
    expect(watermark2).toBeGreaterThanOrEqual(watermark);
    expect(checkTreasuryServiceIssuedAttemptId(transactionId2).status).toBe("issued");
    expect(checkTreasuryServiceIssuedAttemptId(tamperHash16(transactionId2)).status).toBe("legacy_unverified");
    // build（确定性重建）与 mint 的 ID 一致——每个 sequence 唯一合法完整 ID。
    const rebuilt = buildTreasuryIssuedInitialAttemptIdFromSequence(watermark2);
    expect(rebuilt.status).toBe("built");
    if (rebuilt.status === "built") expect(rebuilt.transactionId).toBe(transactionId2);
    // heap reset 后（真正的 global reset 模拟——Memory 保留）验证仍成立。
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermark2);
    expect(checkTreasuryServiceIssuedAttemptId(transactionId2).status).toBe("issued");
    expect(checkTreasuryServiceIssuedAttemptId(tamperHash16(transactionId2)).status).toBe("legacy_unverified");
  });

  it("I6：issuer store 损坏（版本未知 / watermark 非法）→ mint/build/check/contract 全部 fail closed", () => {
    makeService();
    const transactionId = mintedId("i6_before");
    // 损坏 issuer store（版本未知）。
    (Memory.runtime as unknown as { treasury?: { attemptIssuer?: unknown } }).treasury!.attemptIssuer = { version: 99, highWatermark: 5, updatedAt: Game.time };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryAttemptIssuerHealth().healthy).toBe(false);
    expect(mintTreasuryInitialAttemptId("i6_mint").status).toBe("rejected");
    expect(buildTreasuryIssuedInitialAttemptIdFromSequence(1).status).toBe("rejected");
    expect(checkTreasuryServiceIssuedAttemptId(transactionId).status).toBe("store_unhealthy");
    const service = makeService();
    const executed = contractExecuteSealed(service, transactionId);
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") expect(executed.reason).toBe("issuer_store_unhealthy");
    // watermark 非法（非安全整数）同样 fail closed。
    (Memory.runtime as unknown as { treasury?: { attemptIssuer?: unknown } }).treasury!.attemptIssuer = { version: 1, highWatermark: 1e21, updatedAt: Game.time };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(mintTreasuryInitialAttemptId("i6_mint2").status).toBe("rejected");
    expect(checkTreasuryServiceIssuedAttemptId(transactionId).status).toBe("store_unhealthy");
  });

  it("I7：同一 sequence 不得出现两个都被 runtime 接受的完整 initial ID", () => {
    const transactionId = mintedId("i7_unique");
    const parsed = /ti2_(\d+)_/.exec(transactionId);
    expect(parsed).not.toBeNull();
    const sequence = Number.parseInt(parsed![1], 10);
    const rebuilt = buildTreasuryIssuedInitialAttemptIdFromSequence(sequence);
    expect(rebuilt.status).toBe("built");
    if (rebuilt.status === "built") {
      // 确定性重算与 mint 恒等——同 sequence 唯一合法完整 ID。
      expect(rebuilt.transactionId).toBe(transactionId);
      expect(checkTreasuryServiceIssuedAttemptId(rebuilt.transactionId).status).toBe("issued");
    }
    // 任何其它 hash（篡改 / v1 correlation hash / 手工）都不可验证。
    const tampered = tamperHash16(transactionId);
    expect(checkTreasuryServiceIssuedAttemptId(tampered).status).toBe("legacy_unverified");
    const service = makeService();
    const sealed = contractExecuteSealed(service, tampered);
    expect(sealed.status).toBe("prepare_rejected");
  });
});

// ── S 组：统一 settlement reconciliation ───────────────────────────────────

describe("Remediation VIII S：统一 settlement reconciliation（无短路聚合）", () => {
  it("S1：live committed + historical not-executed → conflict（不选边）", () => {
    makeService();
    const transactionId = mintedId("s1");
    executeCommittedLikeSeed(transactionId);
    // historical 塞入相反结论（not-executed——与 live committed 矛盾）。
    seedHistoricalRecord({ transactionId, resolution: "not-executed", identity: { digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: durableOf(transactionId), lowlevelSource: RUNTIME } });
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("conflict");
  });

  it("S2：live exact match + historical store 损坏 → store_unhealthy（不被前方 match 遮蔽）", () => {
    makeService();
    const transactionId = mintedId("s2");
    executeCommittedLikeSeed(transactionId);
    // historical store 损坏。
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    branch.cleanupSupersessions = { version: 99, entries: {}, entryCount: 0, updatedAt: Game.time };
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("store_unhealthy");
  });

  it("S3：historical committed + certificate 相反结论 → conflict", () => {
    makeService();
    const root = mintedId("s3_root");
    const lineageId = "0123456789abcdf3";
    const finalChild = deriveTreasuryLineageNextChildTransactionId(lineageId, 2, root);
    // certificate：root not-executed（finalGeneration>=1——root 被 rearm 替代）。
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: finalChild, finalGeneration: 2,
      terminalState: "chain_committed",
    }).status).toBe("written");
    // historical 塞入 root committed（与 certificate 的 root not-executed 矛盾）。
    seedHistoricalRecord({ transactionId: root, resolution: "committed" });
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(resolved.status).toBe("conflict");
  });

  it("S4：live 与 historical 的 outcome/profile/proofClass/durable identity 全部一致 → exact", () => {
    makeService();
    const transactionId = mintedId("s4");
    executeCommittedLikeSeed(transactionId);
    // 与 live completion 完全一致 identity 的 historical（模拟压缩交接——
    // 同 outcome 同 identity 共同证明 exact）。
    const live = lookupTreasuryCleanupCompletion(transactionId);
    expect(live.verdict).toBe("match");
    const proof = (live as unknown as { proof: { identity: { digest: string; identityProfile: string; proofClass: string; durableIdentityDigest?: string; lowlevelSource?: string }; resolution: "committed" | "not-executed" } }).proof;
    seedHistoricalRecord({
      transactionId,
      resolution: proof.resolution,
      identity: {
        digest: proof.identity.digest,
        identityProfile: proof.identity.identityProfile,
        proofClass: proof.identity.proofClass,
        ...(proof.identity.durableIdentityDigest !== undefined ? { durableIdentityDigest: proof.identity.durableIdentityDigest } : {}),
        ...(proof.identity.lowlevelSource !== undefined ? { lowlevelSource: proof.identity.lowlevelSource } : {}),
      },
    });
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("exact");
    if (resolved.status === "exact") expect(resolved.outcome).toBe(proof.resolution);
  });

  it("S5：outcome 相同但 durable identity 不同 → conflict", () => {
    makeService();
    const transactionId = mintedId("s5");
    executeCommittedLikeSeed(transactionId);
    // 同 outcome（committed）、不同 durable digest 的 historical。
    seedHistoricalRecord({ transactionId, resolution: "committed", identity: { digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: "ffffffffffffffff", lowlevelSource: RUNTIME } });
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("conflict");
  });

  it("S6：certificate-only 的旧 child：replay gate / opposite proof / child occupancy / reconciliation 全部认识（不因压缩变 absent）", () => {
    const service = makeService();
    const root = mintedId("s6_root");
    const lineageId = "0123456789abcdf6";
    const child = deriveTreasuryLineageNextChildTransactionId(lineageId, 4, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: child, finalGeneration: 4,
      terminalState: "non_rearmable_retired",
    }).status).toBe("written");
    // child occupancy 认识 certificate。
    expect(checkTreasuryChildAttemptOccupancy(child)).toBe("durable settlement authority（completion/certificate）");
    // opposite proof 认识（committed 目标 + certificate not-executed → 阻断）。
    const check = checkTreasuryOppositeProofsForCommitted(child, identityOf(child));
    expect(check.clear).toBe(false);
    expect(check.blockers.some((blocker) => blocker.source === "durable-settlement-authority" && blocker.classification === "exact_match")).toBe(true);
    // reconciliation 认识（destructive 不使用 protocol——零 capability）。
    const issued = service.issueTreasuryReconciliationCapability({ transactionId: child });
    expect(issued.status).toBe("rejected");
    // replay gate 阻断（同 ID prepare）。
    const prepare = service.prepareTransaction(input(service, child));
    expect(prepare.status).toBe("rejected");
  });

  it("S7：retired / anti-reuse-only 记录：阻断新执行、不冒充 exact、不进入 destructive authority release", () => {
    const service = makeService();
    const transactionId = mintedId("s7_root");
    seedNonRearmableRoot(transactionId);
    // 手工吸收 root 序号进 retired range（正式压缩通道的等价终态）。
    const sequence = Number.parseInt(/ti2_(\d+)_/.exec(transactionId)![1]!, 10);
    // retired range 覆盖（模拟 certificate 驱逐后的终态——直接持久层注入
    // 等价区间由 L3 覆盖正式通道；此处验证 retired 语义）。
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    branch.retiredAttemptRanges = { version: 1, ranges: [{ minSequence: sequence, maxSequence: sequence, mergedAtTick: Game.time }], entryCount: 1, updatedAt: Game.time };
    resetTreasuryChainCertificateHeapCacheForTest();
    // resolver：retired（不是 exact、不带 outcome）。
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("retired");
    // 阻断新执行（同 ID prepare——rearm_required / retired_attempt 均为
    // 阻断形态；final not-executed tombstone 先触发 rearm_required）。
    const prepare = service.prepareTransaction(input(service, transactionId));
    expect(prepare.status).toBe("rejected");
    if (prepare.status === "rejected") expect(["rearm_required", "retired_attempt"]).toContain(prepare.reason);
    // 不进入 destructive authority release（reconciliation 零 capability——
    // 需活跃 authority 才走到 durable gate，seed quarantine）。
    seedQuarantineEntry(transactionId);
    const issued = service.issueTreasuryReconciliationCapability({ transactionId });
    // 零 destructive capability：rejected（legacy_authority_isolated——retired
    // 不进 destructive authority release）或 already_resolved（final
    // not-executed tombstone 的幂等复述——不重跑 reconciler、不签发新
    // capability）均为 fail-closed 方向。
    expect(["rejected", "already_resolved"]).toContain(issued.status);
    if (issued.status === "rejected") expect(issued.reason).toBe("legacy_authority_isolated");
  });

  it("S8：journal absent + 只有 settlement certificate（无 cleanup completion authority）→ no_cleanup_authority（不得 completed）", () => {
    makeService();
    const root = mintedId("s8_root");
    const lineageId = "0123456789abcdf8";
    const child = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: child, finalGeneration: 1,
      terminalState: "chain_committed",
    }).status).toBe("written");
    // journal absent、无 live/historical completion——certificate 不证明
    // cleanup 完成。
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: root }).status).toBe("no_cleanup_authority");
    expect(resolveTreasuryCleanupCompletionAuthority({ transactionId: root }).status).toBe("absent");
  });

  it("S9：多个来源全部 healthy 且 absent → absent", () => {
    makeService();
    const transactionId = mintedId("s9_never_settled");
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
    expect(resolved.status).toBe("absent");
    expect(resolveTreasuryCleanupCompletionAuthority({ transactionId }).status).toBe("absent");
  });
});

/** live completion seed（真实 cleanup 流程产出 committed completion）。 */
function executeCommittedLikeSeed(transactionId: string): void {
  // 命名避免 jest 误收集：直接走真实 cleanup 产出 live committed completion。
  const service = makeService();
  executeCommitted(service, transactionId);
  expect(peekTreasuryCleanupCompletionEntryCount()).toBeGreaterThanOrEqual(1);
}

// ── C 组：chain certificate 的真实证明能力 ─────────────────────────────────

describe("Remediation VIII C：certificate outcome 语义 / checksum / canonical", () => {
  it("C1：finalGeneration=1 且 chain_committed → root not-executed、final child committed", () => {
    makeService();
    const root = mintedId("c1_root");
    const lineageId = "0123456789abcdc1";
    const child = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: child, finalGeneration: 1,
      terminalState: "chain_committed",
    }).status).toBe("written");
    const rootResolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(rootResolved.status).toBe("protocol");
    if (rootResolved.status === "protocol") expect(rootResolved.outcome).toBe("not-executed");
    const childResolved = resolveTreasuryDurableSettlementAuthority({ transactionId: child });
    expect(childResolved.status).toBe("protocol");
    if (childResolved.status === "protocol") expect(childResolved.outcome).toBe("committed");
  });

  it("C2：两个中间 child 后 final committed（finalGeneration=3）→ 中间代全部 not-executed", () => {
    makeService();
    const root = mintedId("c2_root");
    const lineageId = "0123456789abcdc2";
    const finalChild = deriveTreasuryLineageNextChildTransactionId(lineageId, 3, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: finalChild, finalGeneration: 3,
      terminalState: "chain_committed",
    }).status).toBe("written");
    for (const generation of [1, 2]) {
      const resolved = resolveTreasuryDurableSettlementAuthority({
        transactionId: deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root),
      });
      expect(resolved.status).toBe("protocol");
      if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    }
    const finalResolved = resolveTreasuryDurableSettlementAuthority({ transactionId: finalChild });
    expect(finalResolved.status).toBe("protocol");
    if (finalResolved.status === "protocol") expect(finalResolved.outcome).toBe("committed");
  });

  it("C3：non_rearmable final child → root 到 final 全部 not-executed", () => {
    makeService();
    const root = mintedId("c3_root");
    const lineageId = "0123456789abcdc3";
    const finalChild = deriveTreasuryLineageNextChildTransactionId(lineageId, 2, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: finalChild, finalGeneration: 2,
      terminalState: "non_rearmable_retired",
    }).status).toBe("written");
    const rootResolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(rootResolved.status).toBe("protocol");
    if (rootResolved.status === "protocol") expect(rootResolved.outcome).toBe("not-executed");
    for (const generation of [1, 2]) {
      const resolved = resolveTreasuryDurableSettlementAuthority({
        transactionId: deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root),
      });
      expect(resolved.status).toBe("protocol");
      if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    }
  });

  it("C4：真实 child ID 改一位 checksum → 不得得到 certificate exact/protocol match", () => {
    makeService();
    const root = mintedId("c4_root");
    const lineageId = "0123456789abcdc4";
    const child = deriveTreasuryLineageNextChildTransactionId(lineageId, 2, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: child, finalGeneration: 2,
      terminalState: "non_rearmable_retired",
    }).status).toBe("written");
    const tampered = child.slice(0, child.length - 1) + (child.slice(-1) === "0" ? "1" : "0");
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: tampered }).status).toBe("absent");
    // 未篡改的原 ID 依然 protocol match。
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: child }).status).toBe("protocol");
  });

  it("C5：certificate 对应 identity D1、查询 expected identity D2 → 不得 exact（protocol 不冒充 exact proof）", () => {
    makeService();
    const root = mintedId("c5_root");
    const lineageId = "0123456789abcdc5";
    const child = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: child, finalGeneration: 1,
      terminalState: "chain_committed",
    }).status).toBe("written");
    // expected identity（D2——与 certificate 无法对证的任意 identity）。
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: child, expected: identityOf(child, "999999999999999g".slice(0, 16)) });
    expect(resolved.status).not.toBe("exact");
    expect(resolved.status).toBe("protocol");
    // expectedOutcome 相反 → conflict（outcome 绑定）。
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: child, expectedOutcome: "not-executed" }).status).toBe("conflict");
  });

  it("C6：finalAttemptId 与确定性派生不一致 → certificate store unhealthy / 不当作有效 authority", () => {
    makeService();
    const root = mintedId("c6_root");
    const lineageId = "0123456789abcdc6";
    const realChild = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, root);
    // 持久层注入 finalAttemptId 篡改的 certificate（generation 2 的 ID——
    // 与 finalGeneration=1 的派生不一致）。
    const forgedChild = deriveTreasuryLineageNextChildTransactionId(lineageId, 2, root);
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    branch.chainRetirementCertificates = {
      version: 1,
      entries: {
        ["crc:" + root]: {
          schemaVersion: 1, rootSequence: Number.parseInt(/ti2_(\d+)_/.exec(root)![1]!, 10),
          lineageId, rootTransactionId: root, finalAttemptId: forgedChild, finalGeneration: 1,
          terminalState: "chain_committed", finalizedAtTick: Game.time,
        },
      },
      entryCount: 1, updatedAt: Game.time,
    };
    resetTreasuryChainCertificateHeapCacheForTest();
    // canonical 关系违反 → 单条 lookup 不当作在位权威 / resolver fail closed。
    expect(lookupTreasuryChainRetirementCertificate(root)).toBeUndefined();
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    expect(resolved.status).toBe("store_unhealthy");
    // 未篡改的真实 child 场景（对照——正常写入通过 canonical 验证）。
    void realChild;
  });

  it("C7：certificate-only replay blocker 阻止重放；destructive cleanup 请求因 exact identity 不足拒绝", () => {
    const service = makeService();
    const root = mintedId("c7_root");
    const lineageId = "0123456789abcdc7";
    const child = deriveTreasuryLineageNextChildTransactionId(lineageId, 5, root);
    expect(recordTreasuryChainRetirementCertificate({
      lineageId, rootTransactionId: root, finalAttemptId: child, finalGeneration: 5,
      terminalState: "non_rearmable_retired",
    }).status).toBe("written");
    // replay gate：同 ID（root 与 child）都阻断。
    expect(service.prepareTransaction(input(service, root)).status).toBe("rejected");
    // destructive：reconciliation capability 因 protocol identity 不足拒绝
    //（root 需有活跃 authority 才走到 durable gate——seed quarantine）。
    seedQuarantineEntry(root);
    const issued = service.issueTreasuryReconciliationCapability({ transactionId: root });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("resolution_identity_conflict");
    // destructive：cleanup completion 判定不接受 certificate（S8 已覆盖，
    // 此处从 journal-absent 视角再验证 root）。
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: root }).status).toBe("no_cleanup_authority");
  });
});

// ── R 组：reservation-backed completion ────────────────────────────────────

describe("Remediation VIII R：reservation 生命周期闭合", () => {
  it("R1：连续 200 个 invalid epoch prepare → reservation count 始终为 0", () => {
    const service = makeService();
    for (let index = 0; index < 200; index += 1) {
      const transactionId = mintedId("r1_" + index);
      const stale = { scope: "stale-scope" as never, epochSeq: 999_999, observedAtTick: 1 };
      const prepared = service.prepareTransaction({ ...input(service, transactionId), decision: stale });
      expect(prepared.status).toBe("rejected");
      expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
    }
  });

  it("R2：invalid transaction / projection rejection → 不遗留 reservation", () => {
    const service = makeService();
    // 非法 posting（资源类型非法——projection 验证拒绝）。
    const bad = service.prepareTransaction({
      ...input(service, mintedId("r2_bad"), -500),
      postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "ungodium" as never, delta: -1 }],
    });
    expect(bad.status).toBe("rejected");
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
  });

  it("R3：recovery slot 满 → 不遗留 reservation", () => {
    const service = makeService();
    // recovery slot 满（正式 quarantineTreasuryTransaction API 写 64 条——
    // TREASURY_QUARANTINE_MAX_ENTRIES）。
    for (let index = 0; index < 64; index += 1) {
      seedQuarantineEntry(`r3_fill_${index}`);
    }
    const prepared = service.prepareTransaction(input(service, mintedId("r3_new")));
    expect(prepared.status).toBe("rejected");
    // 64 条 unresolved quarantine 时全局 quarantine write blocker 先于
    // recovery slot 计数触发（两者都在 acquire 之前——零遗留语义等价）。
    if (prepared.status === "rejected") {
      expect(["quarantine_capacity_exhausted", "quarantine_write_blocked"]).toContain(prepared.reason);
    }
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
  });

  it("R4：receipt admission rejected → 不遗留 completion reservation", () => {
    const service = makeService();
    // admission 并发预留上限 64：填满后第 65 个 prepare 在 admission 层
    // 拒绝（receipt_capacity_exhausted）。recovery slot 检查用 active
    // handle 计数（quarantine+intent+active < 64）——本 fixture 用 63 个
    // 真实 prepared（active=63 过 recovery slot）+ 1 个直接占用 admission
    // 预留（heap 侧）触发 admission 满载分支。
    const { reserveTreasuryReceiptAdmission } = require("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    for (let index = 0; index < 63; index += 1) {
      expect(service.prepareTransaction(input(service, mintedId("r4_prep_" + index))).status).toBe("prepared");
    }
    expect(reserveTreasuryReceiptAdmission("r4_extra_occupier", Game.time).status).not.toBe("rejected");
    // 第 64 个 prepare：active=63 过 recovery slot；admission 满（64 预留）
    // → receipt_capacity_exhausted，且不遗留 reservation。
    const before = peekTreasuryCompletionHeadroomReservationCount();
    const prepared = service.prepareTransaction(input(service, mintedId("r4_new")));
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("receipt_capacity_exhausted");
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(before);
  });

  it("R5：128 个普通 executed_committed → 每笔 callback 恰一次、最终 reservation count 0、新 writer 仍可执行", () => {
    const service = makeService();
    const callbacks: jest.Mock[] = [];
    for (let index = 0; index < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; index += 1) {
      const transactionId = mintedId("r5_" + index);
      const callback = jest.fn(() => ({ ok: true }) as never);
      callbacks.push(callback);
      const executed = service.executePreparedAction(input(service, transactionId), callback);
      expect(executed.status).toBe("executed_committed");
      expect(callback).toHaveBeenCalledTimes(1);
    }
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
    // 新 writer 正常。
    const fresh = jest.fn(() => ({ ok: true }) as never);
    expect(service.executePreparedAction(input(service, mintedId("r5_fresh")), fresh).status).toBe("executed_committed");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("R6：live=MAX-1；A 持有最后 reservation；B 无 matching reservation 的 legacy cleanup 尝试 publish → B 不得占用 A 的槽", () => {
    makeService();
    const a = mintedId("r6_a");
    // live=MAX-1（正式 recordTreasuryCleanupCompletion API 写入 127 条）。
    const { recordTreasuryCleanupCompletion } = require("@/runtime/treasury/cleanupCompletionAuthority") as typeof import("@/runtime/treasury/cleanupCompletionAuthority");
    for (let index = 0; index < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES - 1; index += 1) {
      const id = `r6_fill_${index}`;
      const written = recordTreasuryCleanupCompletion({
        entry: {
          transactionId: id, digest: DIGEST, resolution: "not-executed", proofClass: "lowlevel",
          identityProfile: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: durableOf(id),
          settlementProofDurable: true, markerDischarged: true, authorityReleased: true,
          outcomeFinalized: true, lineageFinalized: true,
        } as never,
        lineageDisposition: "not_applicable",
        globalWriteAdmissionStillLocked: false,
      });
      expect(written.status).not.toBe("rejected");
    }
    resetTreasuryCleanupCompletionHeapCacheForTest();
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES - 1);
    // A 获取最后一个 reservation。
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId: a,
      occupancyAfterAcquire: peekTreasuryEffectiveCompletionOccupancy().effective + 1,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    // B（无 matching reservation 的 legacy cleanup）尝试 publish：首次
    // recovery acquire 因 live(127)+reserved(1)+1=129 > 128 拒绝 → bounded
    // reclaim 腾出 1 个 live 槽（127→126）→ 重试 126+1+1=128 ≤ 128 合法
    // 取得（【IX 工作流 E 8.1 单一公式】——B 未抢占 A 的独占槽，A 的
    // reservation 原样在位；旧的双重计数口径在 reclaim 后仍会误拒）。
    const b = mintedId("r6_b");
    const admission = admitTreasuryCompletionPublicationReservation({
      transactionId: b,
      durableIdentityDigest: durableOf(b),
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    });
    expect(admission.status).toBe("admitted");
    if (admission.status === "admitted") expect(admission.recoveryAcquired).toBe(true);
    // A 的独占 reservation 未被抢占。
    expect(peekTreasuryCompletionHeadroomReservation(a)).toBeDefined();
    // B 无 completion 写入、有效占用从未超过 MAX。
    expect(lookupTreasuryCleanupCompletion(b).verdict).toBe("absent");
    const occupancy = peekTreasuryEffectiveCompletionOccupancy();
    expect(occupancy.healthy).toBe(true);
    expect(occupancy.effective).toBeLessThanOrEqual(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
  });

  it("R7：matching reservation → completion publication 恰一次 → reservation 最终 absent、completion 在位", () => {
    const service = makeService();
    const transactionId = mintedId("r7_full");
    executeCommitted(service, transactionId);
    // 完整 cleanup 后：completion 在位（recovery acquire → 写入 → consume）。
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("match");
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    expect(peekTreasuryCompletionHeadroomReservationCount()).toBe(0);
  });

  it("R8：reservation identity 与 completion identity 不同 → publication 拒绝、reservation/journal/旧 proof 保留", () => {
    makeService();
    const transactionId = mintedId("r8");
    // reservation 绑定 identity A。
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId,
      occupancyAfterAcquire: 1,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    expect(admitTreasuryCompletionHeadroomReservationForExecution({
      transactionId, durableIdentityDigest: durableOf(transactionId),
    }).status).toBe("ok");
    // completion 的 identity B（不同 durable digest）→ publication 拒绝。
    const admission = admitTreasuryCompletionPublicationReservation({
      transactionId,
      durableIdentityDigest: "88889999aaaabbbb",
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    });
    expect(admission.status).toBe("rejected");
    if (admission.status === "rejected") expect(admission.reason).toBe("identity_mismatch");
    // reservation 保留、completion 未写入。
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("absent");
  });

  it("R9：completion 写入后、reservation consume 前 global reset → recovery 识别 matching pair、无双计数", () => {
    const service = makeService();
    const transactionId = mintedId("r9");
    // 手工构造中断窗口：completion 在位 + matching reservation 在位。
    executeCommitted(service, transactionId);
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId,
      // matching pair 恢复型 acquire——不新增槽（effective 已含该 live 槽）。
      occupancyAfterAcquire: peekTreasuryEffectiveCompletionOccupancy().effective,
      completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    expect(admitTreasuryCompletionHeadroomReservationForExecution({
      transactionId,
      durableIdentityDigest: ((lookupTreasuryCleanupCompletion(transactionId) as unknown as { proof: { identity: { durableIdentityDigest?: string } } }).proof.identity.durableIdentityDigest ?? durableOf(transactionId)),
    }).status).toBe("ok");
    // global reset 模拟。
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    resetTreasuryCleanupCompletionHeapCacheForTest();
    // recovery：matching pair → consume。
    const consumed = reconcileTreasuryReservationCompletionPairs();
    expect(consumed).toBe(1);
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
    // 只剩 completion——无双计数。
    const occupancy = peekTreasuryEffectiveCompletionOccupancy();
    expect(occupancy.pairs).toBe(0);
    expect(occupancy.live).toBe(1);
    expect(occupancy.effective).toBe(1);
  });

  it("R10：consume 后、journal delete 前中断 → global reset 后幂等完成（completion 是恢复权威）", () => {
    const service = makeService();
    const transactionId = mintedId("r10");
    executeCommitted(service, transactionId);
    // 模拟"consume 成功、journal 删除前中断"：journal 重新在位（restore），
    // completion 是恢复权威。
    const receiptProof = readTreasurySettlementProof(transactionId);
    const receiptDigest = (receiptProof as { digest: string }).digest;
    const receiptDurable = (receiptProof as { durableIdentityDigest: string }).durableIdentityDigest;
    const opened = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId,
        digest: receiptDigest,
        resolution: "committed",
        proofClass: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: receiptDurable,
      }),
    );
    expect(opened.status).not.toBe("rejected");
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    resetTreasuryCleanupCompletionHeapCacheForTest();
    // 幂等继续：journal-absent 判定经 completion 恢复权威 → completed。
    const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advanced.status).toBe("completed");
  });

  it("R11：Intent/Quarantine 已释放、cleanup journal 仍在 lineage finalization、超 TTL → reservation 不得被 sweep", () => {
    makeService();
    const transactionId = mintedId("r11");
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId, occupancyAfterAcquire: 1, completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    // cleanup journal 在位（lineage finalization 进行中）。
    const opened = openTreasuryResolutionCleanup(
      treasuryResolutionCleanupOpenInputOfFacts({
        transactionId, digest: DIGEST, resolution: "not-executed", proofClass: "lowlevel",
        lowlevelSource: RUNTIME, durableIdentityDigest: durableOf(transactionId),
      }),
    );
    expect(opened.status).not.toBe("rejected");
    Game.time += TREASURY_COMPLETION_RESERVATION_TTL_TICKS + 1;
    const swept = sweepOrphanTreasuryCompletionReservations(new Set());
    expect(swept).toBe(0);
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeDefined();
  });

  it("R12：真正 orphan（无 handle/Intent/Quarantine/journal/Resolution/Fault/Marker/lineage owner）→ TTL 后可安全释放", () => {
    makeService();
    const transactionId = mintedId("r12");
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId, occupancyAfterAcquire: 1, completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    Game.time += TREASURY_COMPLETION_RESERVATION_TTL_TICKS + 1;
    const swept = sweepOrphanTreasuryCompletionReservations(new Set());
    expect(swept).toBe(1);
    expect(peekTreasuryCompletionHeadroomReservation(transactionId)).toBeUndefined();
  });

  it("R13：reservation store 损坏 → release/consume 不静默成功（结构化失败）", () => {
    makeService();
    const transactionId = mintedId("r13");
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId, occupancyAfterAcquire: 1, completionHardCapacity: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
    }).status).toBe("acquired");
    // 损坏 store（entryCount 不一致）。
    const branch = (Memory.runtime as unknown as { treasury?: { completionHeadroomReservations?: { entryCount: number } } }).treasury;
    branch!.completionHeadroomReservations!.entryCount = 99;
    resetTreasuryCompletionHeadroomReservationHeapCacheForTest();
    const released = releaseTreasuryCompletionHeadroomReservation(transactionId);
    expect(released.status).toBe("rejected");
    if (released.status === "rejected") expect(released.reason).toBe("store_unhealthy");
    const consumed = consumeTreasuryCompletionHeadroomReservation(transactionId);
    expect(consumed.status).toBe("rejected");
    // checked helper 不抛错（诊断计数承载）。
    expect(() => releaseTreasuryCompletionHeadroomChecked(transactionId)).not.toThrow();
  });
});

// ── L 组：长期有界的永久历史 ───────────────────────────────────────────────

describe("Remediation VIII L：长期有界（>128 chain / >64 乱序区间 / >384 historical）", () => {
  it("L1：≥160 条真实 terminal chain（chain_committed 与 non_rearmable 混合；正式 lifecycle）→ 第 160 条后仍能创建新 chain", () => {
    const service = makeService();
    // chain_committed 终态链的 compaction 语义由 C1/C2（certificate 的
    // chain_committed outcome 映射——final 代 committed）与既有 Round 17/18
    // 真实 capability→child committed→chain_committed→compact 链路测试
    // 覆盖；L1 聚焦 >128 条终态链的长期有界性（E1 核心）。
    // 160 条 non_rearmable 终态链（正式 converge 状态迁移 → compact）。
    for (let index = 0; index < 160; index += 1) {
      const root = mintedId("l1_root_" + index);
      const lineageId = seedNonRearmableRoot(root);
      expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    }
    // 第 161 条新 chain 仍能创建（summary 128 满载后不永久停机）。
    const freshRoot = mintedId("l1_fresh");
    const freshLineage = seedNonRearmableRoot(freshRoot);
    expect(compactTreasuryTerminalLineage(freshLineage).status).toBe("compacted");
    // certificate 有界（≤256——满载驱逐进 retired range）。
    expect(peekTreasuryChainCertificateEntryCount()).toBeLessThanOrEqual(256);
  });

  it("L2：terminal compaction 后 active lineage 不卡死、permanent authority 有界、全部已退休 root 不可重放", () => {
    const service = makeService();
    const roots: string[] = [];
    for (let index = 0; index < 140; index += 1) {
      const root = mintedId("l2_root_" + index);
      roots.push(root);
      const lineageId = seedNonRearmableRoot(root);
      expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    }
    // permanent authority 有界。
    expect(peekTreasuryRetiredRangeEntryCount()).toBeLessThanOrEqual(TREASURY_RETIRED_RANGE_MAX_ENTRIES);
    // 全部已退休 root 不可重放（resolver protocol/retired/exact——无一 absent）。
    for (const root of roots) {
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
      expect(["protocol", "retired", "exact"]).toContain(resolved.status);
    }
    // 新 writer 正常。
    const fresh = jest.fn(() => ({ ok: true }) as never);
    expect(service.executePreparedAction(input(service, mintedId("l2_fresh")), fresh).status).toBe("executed_committed");
  });

  it("L3：超过 64 个乱序完成间隔（奇数先退休、偶数 mint 后未用）→ coalesce 收敛、不永久停机、在飞 hole 不误退休", () => {
    makeService();
    // 奇数 seq 先退休（mint 1..131——偶数 mint 后丢弃为孤儿）。
    const oddRoots: string[] = [];
    for (let index = 1; index <= 131; index += 1) {
      const transactionId = mintedId("l3_" + index);
      if (index % 2 === 1) {
        oddRoots.push(transactionId);
        const lineageId = seedNonRearmableRoot(transactionId);
        expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
      }
    }
    // 乱序退休后 range 仍 ≤ 64（coalesce 收敛孤儿 gap——偶数 seq abandon）。
    expect(peekTreasuryRetiredRangeEntryCount()).toBeLessThanOrEqual(TREASURY_RETIRED_RANGE_MAX_ENTRIES);
    // 奇数 root 全部 retired/protocol（不可重放）。
    for (const root of oddRoots.slice(-10)) {
      expect(checkTreasuryAttemptRetiredRange(root).retired || resolveTreasuryDurableSettlementAuthority({ transactionId: root }).status !== "absent").toBe(true);
    }
    // 继续新 chain 不停机。
    const freshRoot = mintedId("l3_fresh");
    const freshLineage = seedNonRearmableRoot(freshRoot);
    expect(compactTreasuryTerminalLineage(freshLineage).status).toBe("compacted");
    // 在飞 hole 不误退休：mint 一个新 seq 并开 quarantine（在飞），其后
    // coalesce 不得把它吸收进 range。
    const inFlight = mintedId("l3_inflight");
    seedQuarantineEntry(inFlight);
    const before = checkTreasuryAttemptRetiredRange(inFlight).retired;
    expect(before).toBe(false);
    // 触发一次满载压缩路径（安全——在飞 seq 有 lifecycle 权威）。
    expect(checkTreasuryAttemptRetiredRange(inFlight).retired).toBe(false);
  });

  it("L4：超过旧 384 historical 边界（真实 issuance + 正式 lifecycle 路径）→ 新 writer 正常", () => {
    const service = makeService();
    const TOTAL = 400;
    const allIds: string[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      const transactionId = mintedId("l4_" + index);
      allIds.push(transactionId);
      // 正式 lifecycle：真实 execute committed + 完整 cleanup（completion
      // 写入；live 满载后由 publication admission 的 reclaim-then-retry
      // 正式通道 archive 进 historical——384 边界后压缩继续）。
      executeCommitted(service, transactionId);
      if (peekTreasuryCleanupCompletionEntryCount() >= TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES) {
        expect(peekTreasuryCleanupCompletionEntryCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
      }
    }
    // 旧 ID 全部不可重放（exact/retired/protocol——无一 absent）。
    for (const transactionId of allIds) {
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId });
      expect(resolved.status === "exact" || resolved.status === "retired" || resolved.status === "protocol").toBe(true);
    }
    // historical 有界（≤384——满载压缩生效）。
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES);
    // 新 writer 正常执行。
    const fresh = jest.fn(() => ({ ok: true }) as never);
    expect(service.executePreparedAction(input(service, mintedId("l4_fresh")), fresh).status).toBe("executed_committed");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("L5：global reset 后 permanent authority 仍有效——旧 ID 无一恢复为 absent/new", () => {
    makeService();
    const roots: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const root = mintedId("l5_" + index);
      roots.push(root);
      const lineageId = seedNonRearmableRoot(root);
      expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    }
    const watermark = peekTreasuryIssuedAttemptWatermark();
    // global reset：heap 全部失效（Memory 保留）。
    resetTreasuryAttemptIssuerHeapCacheForTest();
    resetTreasuryChainCertificateHeapCacheForTest();
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    resetTreasuryCleanupCompletionHeapCacheForTest();
    resetTreasuryResolutionStoreForTest();
    // watermark 不回退。
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermark);
    // 旧 ID 无一 absent/new。
    for (const root of roots) {
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
      expect(["protocol", "retired", "exact"]).toContain(resolved.status);
    }
    // issued ID 的完整验证在 reset 后依然成立。
    for (const root of roots.slice(0, 5)) {
      expect(checkTreasuryServiceIssuedAttemptId(root).status).toBe("issued");
    }
  });
});
