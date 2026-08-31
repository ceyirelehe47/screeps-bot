/**
 * 【第十六轮第六节】跨 store execution-fact cohesion 测试。
 *
 * 覆盖：
 * - outcome 对等矩阵：returned_ok + started_unknown（及全部非法组合）→
 *   inconsistent；returned_ok 事实保留；not-executed capability 不签发；
 * - 相同 outcome 合法 workflow 组合（returned_ok faulted→quarantined、
 *   returned_non_ok）可归一化，execution facts 为明确合并结果；
 * - phase 与 outcome 矛盾（returned_ok + executing_at_end_tick、
 *   returned_non_ok + commit_unexpected）→ inconsistent；
 * - intent.settlement=ready + quarantine 存在 → inconsistent；
 * - immutable identity 相同但 execution facts 不同 → 不得合并；
 * - 归一化合并规则（settlement 取更进展一方、phase 取 quarantine）；
 * - capability issuance 与 recovery 面对 fact conflict：零调用/零副作用。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import { writeTreasuryIntentEntry, readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  readTreasuryResolutionTombstone,
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { compareTreasuryExecutionFactCohesion } from "@/runtime/treasury/executionFactCohesion";
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
let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_not_executed";

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

/** 种入 lowlevel quarantine（可指定 phase/outcome/settlement）。 */
function seedQuarantine(
  transactionId: string,
  overrides: { phase?: string; outcome?: string; settlement?: string; digest?: string } = {},
): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest: overrides.digest ?? "0123456789abcdef",
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: SEMANTIC,
    phase: overrides.phase ?? "executing_at_end_tick",
    outcome: overrides.outcome ?? "started_unknown",
    settlement: overrides.settlement ?? "quarantined",
    deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
    recordedAt: Game.time,
  });
  expect(write.status).toBe("written");
  const identity = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  return identity as string;
}

/** 种入与 quarantine 事实一致的并存 intent（可指定 outcome/settlement）。 */
function seedMatchingIntent(
  transactionId: string,
  digest: string,
  overrides: { outcome?: string; settlement?: string } = {},
): void {
  const write = writeTreasuryIntentEntry({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: SEMANTIC,
    postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
    outcome: overrides.outcome ?? "started_unknown",
    settlement: overrides.settlement ?? "executing",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(write.status).toBe("written");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryResolutionStoreForTest();
  reconcilerCalls = 0;
  reconcilerConclusion = "observed_not_executed";
  registerTerminalSendReconciler();
});

describe("纯比较器矩阵（executionFactCohesion）", () => {
  const q = (phase: string, outcome: string, settlement = "quarantined") => ({ outcome, settlement, phase });
  const i = (outcome: string, settlement: string) => ({ outcome, settlement });

  it("outcome 对等矩阵：相同 outcome 合法组合 cohesive", () => {
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("executing_at_end_tick", "started_unknown"), intent: i("started_unknown", "executing") }).status).toBe("cohesive");
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("action_returned_non_ok_abort_failed", "returned_non_ok"), intent: i("returned_non_ok", "pending_abort") }).status).toBe("cohesive");
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("commit_unexpected", "returned_ok"), intent: i("returned_ok", "pending_commit") }).status).toBe("cohesive");
  });

  it("outcome 对等矩阵：全部非法组合 inconsistent（returned_ok 永不被覆盖）", () => {
    const cases: Array<[string, string, string, string, string]> = [
      ["executing_at_end_tick", "started_unknown", "returned_ok", "faulted", "quarantine.outcome=started_unknown 与 intent.returned_ok"],
      ["commit_unexpected", "returned_ok", "started_unknown", "faulted", "quarantine.returned_ok 与 intent.started_unknown"],
      ["commit_unexpected", "returned_ok", "returned_non_ok", "faulted", "returned_ok 与 returned_non_ok"],
      ["executing_at_end_tick", "started_unknown", "not_started", "faulted", "started_unknown 与 not_started"],
    ];
    for (const [qp, qo, io, is, label] of cases) {
      const verdict = compareTreasuryExecutionFactCohesion({ quarantine: q(qp, qo), intent: i(io, is) });
      expect(verdict.status).toBe(label.length > 0 ? "inconsistent" : "cohesive");
    }
  });

  it("aborted_final 与任何运行时事实并存 inconsistent", () => {
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("executing_at_end_tick", "started_unknown"), intent: i("aborted_final", "finalized") }).status).toBe("inconsistent");
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("executing_at_end_tick", "aborted_final"), intent: i("started_unknown", "executing") }).status).toBe("inconsistent");
  });

  it("phase 与 outcome 矛盾（跨类上探并存禁止）", () => {
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("executing_at_end_tick", "returned_ok"), intent: i("returned_ok", "faulted") }).status).toBe("inconsistent");
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("commit_unexpected", "returned_non_ok"), intent: i("returned_non_ok", "faulted") }).status).toBe("inconsistent");
  });

  it("intent.settlement=ready/finalized 与 unresolved quarantine 并存 inconsistent", () => {
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("executing_at_end_tick", "started_unknown"), intent: i("started_unknown", "ready") }).status).toBe("inconsistent");
    expect(compareTreasuryExecutionFactCohesion({ quarantine: q("executing_at_end_tick", "started_unknown"), intent: i("started_unknown", "finalized") }).status).toBe("inconsistent");
  });

  it("归一化合并规则：outcome=共同值、settlement=更进展一方、phase=quarantine", () => {
    const verdict = compareTreasuryExecutionFactCohesion({
      quarantine: q("ok_pending_commit_unresolved", "returned_ok", "quarantined"),
      intent: i("returned_ok", "faulted"),
    });
    expect(verdict.status).toBe("cohesive");
    if (verdict.status === "cohesive") {
      expect(verdict.merged.outcome).toBe("returned_ok");
      expect(verdict.merged.phase).toBe("ok_pending_commit_unresolved");
      // faulted 与 quarantined 同级（3）——取 intent 一侧（细粒度保留）。
      expect(verdict.merged.settlement).toBe("faulted");
    }
    const resolving = compareTreasuryExecutionFactCohesion({
      quarantine: q("ok_pending_commit_unresolved", "returned_ok", "resolving"),
      intent: i("returned_ok", "faulted"),
    });
    if (resolving.status === "cohesive") {
      // resolving（4）比 faulted（3）更进展——取 quarantine 一侧。
      expect(resolving.merged.settlement).toBe("resolving");
    }
  });
});

describe("resolver cohesion 集成（unresolvedAuthority）", () => {
  it("quarantine.started_unknown + intent.returned_ok：resolver inconsistent；returned_ok 不丢失；capability 零签发（reconciler 零调用）", () => {
    const digest = "0123456789abcdef";
    seedQuarantine("ef_ok_start", { phase: "executing_at_end_tick", outcome: "started_unknown" });
    seedMatchingIntent("ef_ok_start", digest, { outcome: "returned_ok", settlement: "faulted" });
    const verdict = resolveTreasuryUnresolvedAuthority("ef_ok_start");
    expect(verdict.status).toBe("inconsistent");
    if (verdict.status === "inconsistent") expect(verdict.detail).toContain("execution");
    // 两份 authority 全保留。
    expect(readTreasuryQuarantineEntry("ef_ok_start")).toBeDefined();
    expect(readTreasuryIntentEntry("ef_ok_start")).toBeDefined();
    // not-executed capability 不签发（fact conflict → 不调用 reconciler）。
    const next = makeService();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "ef_ok_start" });
    expect(issued.status).toBe("rejected");
    expect(reconcilerCalls).toBe(0);
  });

  it("quarantine.returned_ok + intent.started_unknown：inconsistent", () => {
    seedQuarantine("ef_ok_q", { phase: "commit_unexpected", outcome: "returned_ok" });
    seedMatchingIntent("ef_ok_q", "0123456789abcdef", { outcome: "started_unknown", settlement: "executing" });
    expect(resolveTreasuryUnresolvedAuthority("ef_ok_q").status).toBe("inconsistent");
  });

  it("相同 returned_ok 且合法 faulted→quarantined 组合：可归一化（execution facts 合并）", () => {
    seedQuarantine("ef_ok_both", { phase: "ok_pending_commit_unresolved", outcome: "returned_ok" });
    seedMatchingIntent("ef_ok_both", "0123456789abcdef", { outcome: "returned_ok", settlement: "faulted" });
    const verdict = resolveTreasuryUnresolvedAuthority("ef_ok_both");
    expect(verdict.status).toBe("ok");
    if (verdict.status === "ok") {
      expect(verdict.authority.outcome).toBe("returned_ok");
      expect(verdict.authority.phase).toBe("ok_pending_commit_unresolved");
    }
  });

  it("相同 returned_non_ok 且合法 workflow 组合：可归一化", () => {
    seedQuarantine("ef_non_ok", { phase: "action_returned_non_ok_abort_failed", outcome: "returned_non_ok" });
    seedMatchingIntent("ef_non_ok", "0123456789abcdef", { outcome: "returned_non_ok", settlement: "pending_abort" });
    expect(resolveTreasuryUnresolvedAuthority("ef_non_ok").status).toBe("ok");
  });

  it("immutable identity 相同但 execution facts 不同：不得合并", () => {
    const digest = "0123456789abcdef";
    // 双方 postings/digest/identity 完全一致，仅 outcome 事实不同。
    seedQuarantine("ef_id_same", { phase: "executing_at_end_tick", outcome: "started_unknown", digest });
    seedMatchingIntent("ef_id_same", digest, { outcome: "returned_ok", settlement: "faulted" });
    expect(resolveTreasuryUnresolvedAuthority("ef_id_same").status).toBe("inconsistent");
  });

  it("recovery 面对 fact conflict：零 release、零 refresh", () => {
    const digest = "0123456789abcdef";
    const identity = seedQuarantine("ef_recovery", { phase: "executing_at_end_tick", outcome: "started_unknown" });
    seedMatchingIntent("ef_recovery", digest, { outcome: "returned_ok", settlement: "faulted" });
    // resolving committed tombstone（合法形态）。
    const write = writeTreasuryResolutionTombstone({
      transactionId: "ef_recovery",
      digest,
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
    const report = recoverStagedResolutions();
    expect(report.authorityInconsistent).toBeGreaterThanOrEqual(1);
    expect(report.completed).toBe(0);
    expect(readTreasuryQuarantineEntry("ef_recovery")).toBeDefined();
    expect(readTreasuryIntentEntry("ef_recovery")).toBeDefined();
    expect(readTreasuryResolutionTombstone("ef_recovery")?.stage).toBe("resolving");
    expect(readTreasuryResolutionStoreCounters().authorityInconsistentBlockers).toBeGreaterThanOrEqual(1);
  });
});
