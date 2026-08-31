/**
 * 【第十六轮第八节】resolver store_unhealthy 四态语义测试。
 *
 * 覆盖：
 * - Intent store fatal + 无 quarantine：resolver = store_unhealthy（不是
 *   not_found）；
 * - Quarantine store fatal + 无 intent：store_unhealthy；
 * - 一侧 healthy 有 authority、另一侧 fatal：store_unhealthy（不选 healthy
 *   一侧）；
 * - staged committed recovery 遇 store_unhealthy：不 finalize、不清 marker；
 * - final not-executed recovery 遇 store_unhealthy：不释放；
 * - capability issuance 遇 store_unhealthy：reconciler 零调用；
 * - committed verifier 不把 store_unhealthy 当 authority absent。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, resetTreasuryQuarantineRuntimeForTest, TREASURY_QUARANTINE_MAX_ENTRIES } from "@/runtime/treasury/quarantine";
import { writeTreasuryIntentEntry, readTreasuryIntentEntry, resetTreasuryIntentRuntimeForTest, TREASURY_INTENT_MAX_ENTRIES } from "@/runtime/treasury/intents";
import {
  readTreasuryResolutionTombstone,
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { verifyTreasuryCommittedResolutionProof } from "@/runtime/treasury/committedProofVerifier";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

const BASE_POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];
const SEMANTIC = "terminal.send@reconciler-semantics-v1";

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

let reconcilerCalls = 0;
let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_committed";

function registerTerminalSendReconciler(): void {
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: SEMANTIC,
    reconcile: () => {
      reconcilerCalls += 1;
      return reconcilerConclusion;
    },
  });
}

function seedQuarantine(transactionId: string): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest: "0123456789abcdef",
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: SEMANTIC,
    phase: "ok_pending_commit_unresolved",
    outcome: "returned_ok",
    settlement: "quarantined",
    deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
    recordedAt: Game.time,
  });
  expect(write.status).toBe("written");
  const identity = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  return identity as string;
}

/** 将 intent store 灌满至容量以制造 fatal（entryCount 超上限）。 */
function corruptIntentStore(): void {
  const branch = ((Memory.runtime ?? {}) as { treasury?: Record<string, unknown> }).treasury as
    | { intents?: { version?: number; entries?: Record<string, unknown>; entryCount?: number } }
    | undefined;
  if (branch?.intents) {
    branch.intents.entryCount = TREASURY_INTENT_MAX_ENTRIES + 1; // 声明数与实际不符 → load 校验 fatal
  }
  // 破坏后失效 heap 缓存——下一次 ensure/load 重新验证并 fatal。
  resetTreasuryIntentRuntimeForTest();
}

/** 将 quarantine store 元数据破坏以制造 fatal。 */
function corruptQuarantineStore(): void {
  const branch = ((Memory.runtime ?? {}) as { treasury?: Record<string, unknown> }).treasury as
    | { quarantine?: { version?: number; entries?: Record<string, unknown>; entryCount?: number } }
    | undefined;
  if (branch?.quarantine) {
    branch.quarantine.entryCount = TREASURY_QUARANTINE_MAX_ENTRIES + 1;
  }
  resetTreasuryQuarantineRuntimeForTest();
}

/** 写入一笔无关 intent（物化 intent store——破坏元数据才有 fatal 对象）。 */
function seedUnrelatedIntent(transactionId: string): void {
  const write = writeTreasuryIntentEntry({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest: "9999999999999999",
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
    outcome: "started_unknown",
    settlement: "executing",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(write.status).toBe("written");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  reconcilerCalls = 0;
  reconcilerConclusion = "observed_committed";
  registerTerminalSendReconciler();
});

describe("resolver 四态语义（store_unhealthy）", () => {
  it("Intent store fatal + 无 quarantine：store_unhealthy（不是 not_found）", () => {
    // 建立合法 intent store 后破坏元数据。
    const write = writeTreasuryIntentEntry({
      transactionId: "sh_seed",
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest: "0123456789abcdef",
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      settlement: "executing",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
    corruptIntentStore();
    const verdict = resolveTreasuryUnresolvedAuthority("sh_other");
    expect(verdict.status).toBe("store_unhealthy");
    if (verdict.status === "store_unhealthy") {
      expect(verdict.intentStoreError).toBeDefined();
      expect(verdict.detail).not.toContain("not_found");
    }
  });

  it("Quarantine store fatal + 无 intent：store_unhealthy", () => {
    seedQuarantine("sh_q_seed");
    corruptQuarantineStore();
    const verdict = resolveTreasuryUnresolvedAuthority("sh_other");
    expect(verdict.status).toBe("store_unhealthy");
    if (verdict.status === "store_unhealthy") expect(verdict.quarantineStoreError).toBeDefined();
  });

  it("一侧 healthy 有 authority、另一侧 fatal：store_unhealthy，不选 healthy 一侧", () => {
    const identity = seedQuarantine("sh_asym");
    seedUnrelatedIntent("sh_asym_noise");
    corruptIntentStore();
    const verdict = resolveTreasuryUnresolvedAuthority("sh_asym");
    expect(verdict.status).toBe("store_unhealthy");
    // 不释放、不选 healthy 一侧（authority 保留原样）。
    expect(readTreasuryQuarantineEntry("sh_asym")).toBeDefined();
    void identity;
  });

  it("staged committed recovery 遇 store_unhealthy：不 finalize、不清 marker、独立计数", () => {
    const identity = seedQuarantine("sh_staged");
    const write = writeTreasuryResolutionTombstone({
      transactionId: "sh_staged",
      digest: "0123456789abcdef",
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: identity,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(write.status).not.toBe("rejected");
    seedUnrelatedIntent("sh_staged_noise");
    corruptIntentStore();
    const report = recoverStagedResolutions();
    expect(report.storeUnhealthy).toBeGreaterThanOrEqual(1);
    expect(report.completed).toBe(0);
    expect(readTreasuryResolutionTombstone("sh_staged")?.stage).toBe("resolving");
    expect(readTreasuryQuarantineEntry("sh_staged")).toBeDefined();
    expect(readTreasuryResolutionStoreCounters().storeUnhealthyBlockers).toBeGreaterThanOrEqual(1);
  });

  it("final not-executed recovery 遇 store_unhealthy：不释放", () => {
    const identity = seedQuarantine("sh_final");
    const write = writeTreasuryResolutionTombstone({
      transactionId: "sh_final",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: identity,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(write.status).not.toBe("rejected");
    corruptQuarantineStore();
    const report = recoverStagedResolutions();
    expect(report.storeUnhealthy).toBeGreaterThanOrEqual(1);
    expect(report.completedRelease).toBe(0);
  });

  it("capability issuance 遇 store_unhealthy：reconciler 零调用、拒绝签发", () => {
    seedQuarantine("sh_issue");
    seedUnrelatedIntent("sh_issue_noise");
    corruptIntentStore();
    Game.time += 1;
    const next = makeService();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "sh_issue" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("authority_store_unhealthy");
    expect(reconcilerCalls).toBe(0);
  });

  it("committed verifier 不把 store_unhealthy 当 authority absent（authority_store_unhealthy verdict）", () => {
    const verdict = verifyTreasuryCommittedResolutionProof({
      tombstone: {
        transactionId: "sh_verifier",
        digest: "0123456789abcdef",
        proofLevel: "lowlevel",
        settledAtTick: Game.time,
        durableIdentityDigest: "0123456789abcdee",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      },
      authorityResolution: { status: "store_unhealthy", detail: "intent store fatal（test）" },
      receiptProof: { level: "modern", settledAtTick: Game.time, digest: "0123456789abcdef", durableIdentityDigest: "0123456789abcdee", lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    });
    expect(verdict.status).toBe("authority_store_unhealthy");
    expect(verdict.status).not.toBe("verified");
  });
});
