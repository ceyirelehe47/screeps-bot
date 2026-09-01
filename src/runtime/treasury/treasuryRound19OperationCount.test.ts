/**
 * 【第十九轮】operation-count 确定性测试（任务 25.9/性能要求 6）。
 *
 * 覆盖：
 * - 多次 lineageId/root/current/next lookup 不增加 fullScans（O(1) 索引）；
 * - summary verdict（record 缺失 + summary 命中）不扫描 active entries
 *   （lineage 与 summary store 的 fullScans 均不增加）；
 * - 空闲 beginTick 保持 O(1) 快路径（不扫描历史 final proof）；
 * - 300 代 chain：active entryCount 保持常数、压缩后历史 tombstone 收敛。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
  peekTreasuryResolutionStoreHealth,
} from "@/runtime/treasury/resolutionStore";
import {
  lineageStoreEvents,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import {
  retirementSummaryEvents,
  lookupTreasuryRetirementSummaryByRoot,
  peekTreasuryRetirementSummaryHealth,
} from "@/runtime/treasury/lineageRetirementSummary";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

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

function freshInput(service: TreasuryTestService, transactionId: string): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  return makeService();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => "observed_not_executed",
  });
});

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

describe("operation-count（第十九轮性能要求）", () => {
  it("多次 lineageId/root/current/next lookup 不增加 fullScans（O(1) 索引）", () => {
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r19_oc_parent"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    const next = advanceTick();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "r19_oc_parent" });
    if (issued.status === "issued") {
      next.resolveUnresolvedTransaction({ transactionId: "r19_oc_parent", capability: issued.capability });
    }
    const cap = next.issueTreasuryRearmCapability({ parentTransactionId: "r19_oc_parent" });
    expect(cap.status).toBe("issued");
    if (cap.status !== "issued") return;
    const scansAfterSetup = lineageStoreEvents.fullScans;
    const lineageId = lookupTreasuryAttemptLineageByAttemptId("r19_oc_parent")!.lineageId;
    for (let i = 0; i < 50; i += 1) {
      // root/current 索引 lookup（capability_issued 的 next child 经 record
      // 字段验证——lookup 语义只覆盖 root ∪ current）。
      expect(lookupTreasuryAttemptLineageByAttemptId("r19_oc_parent")).toBeDefined();
      const record = readTreasuryAttemptLineageRecord(lineageId);
      expect(record?.nextChildTransactionId).toBe(cap.childTransactionId);
      expect(record?.rootTransactionId).toBe("r19_oc_parent");
    }
    expect(lineageStoreEvents.fullScans).toBe(scansAfterSetup);
  });

  it("summary verdict（record 缺失 + summary 命中）不扫描 active entries / summary entries", () => {
    // 构造已压缩 chain（root summary 存在、active record 已删）。
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r19_oc2_root"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    const next = advanceTick();
    const issued0 = next.issueTreasuryReconciliationCapability({ transactionId: "r19_oc2_root" });
    if (issued0.status === "issued") {
      next.resolveUnresolvedTransaction({ transactionId: "r19_oc2_root", capability: issued0.capability });
    }
    const cap = next.issueTreasuryRearmCapability({ parentTransactionId: "r19_oc2_root" });
    expect(cap.status).toBe("issued");
    if (cap.status !== "issued") return;
    // child OK → chain_committed → 压缩（capability 同 tick 有效——用 next）。
    const childExec = next.executePreparedAction(freshInput(next, cap.childTransactionId), () => ({ ok: true as const }), { rearmCapability: cap.capability });
    expect(childExec.status).toBe("executed_committed");
    const t2 = advanceTick();
    void t2;
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId(cap.childTransactionId)).toBeUndefined();
    expect(lookupTreasuryRetirementSummaryByRoot("r19_oc2_root")).toBeDefined();
    // 预热（首次 load summary store 计一次 fullScan）。
    treasuryTombstoneReplacementVerdict({
      transactionId: "r19_oc2_root",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
    });
    const lineageScans = lineageStoreEvents.fullScans;
    const summaryScans = retirementSummaryEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      const verdict = treasuryTombstoneReplacementVerdict({
        transactionId: "r19_oc2_root",
        digest: "1111111111111111",
        resolution: "not-executed",
        stage: "final",
        proofLevel: "lowlevel",
      });
      expect(verdict.verdict).toBe("replacement_match");
    }
    expect(lineageStoreEvents.fullScans).toBe(lineageScans);
    expect(retirementSummaryEvents.fullScans).toBe(summaryScans);
  });

  it("空闲 beginTick 保持 O(1) 快路径（idleFastPath 计数推进）", () => {
    const service = makeService();
    const before = lineageStoreEvents.idleFastPath;
    const next = advanceTick();
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(0);
    expect(lineageStoreEvents.idleFastPath).toBeGreaterThan(before);
    void next;
  });

  it("300 代 chain：active entryCount 恒 1；committed 压缩后 entryCount 收敛 0、resolution store 不满载", () => {
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r19_oc300_root"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    let parent = "r19_oc300_root";
    let currentService = advanceTick();
    const issued0 = currentService.issueTreasuryReconciliationCapability({ transactionId: parent });
    if (issued0.status === "issued") {
      expect(currentService.resolveUnresolvedTransaction({ transactionId: parent, capability: issued0.capability }).status).toBe("resolved");
    }
    for (let generation = 0; generation < 300; generation += 1) {
      const issued = currentService.issueTreasuryRearmCapability({ parentTransactionId: parent });
      expect(issued.status).toBe("issued");
      if (issued.status !== "issued") return;
      expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
      // 低层 non-OK + abort 确认（同步退休 → tombstone + rearm-ready）。
      const childExec = currentService.executePreparedAction(
        freshInput(currentService, issued.childTransactionId),
        () => ({ ok: false as const }),
        { rearmCapability: issued.capability },
      );
      expect(childExec.status).toBe("executed_aborted");
      parent = issued.childTransactionId;
      Game.time += 120; // 逐步超龄：历史代 tombstone 在压力清扫中回收
      currentService = advanceTick();
      // 容量预检（满载时惰性清扫发生在这里——超龄历史代 verdict match 回收）。
      expect(ensureTreasuryResolutionSlotAvailable()).toBeNull();
    }
    // 最终代 commit → 压缩 → entryCount 收敛 0。
    const finalCap = currentService.issueTreasuryRearmCapability({ parentTransactionId: parent });
    expect(finalCap.status).toBe("issued");
    if (finalCap.status !== "issued") return;
    const finalExec = currentService.executePreparedAction(
      freshInput(currentService, finalCap.childTransactionId),
      () => ({ ok: true as const }),
      { rearmCapability: finalCap.capability },
    );
    expect(finalExec.status).toBe("executed_committed");
    advanceTick();
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(0);
    expect(lookupTreasuryRetirementSummaryByRoot("r19_oc300_root")).toBeDefined();
    // 历史代 tombstone 到期可回收（verdict match 后清扫）——store 不因历史
    // child tombstone 永久积累而满载。
    expect(ensureTreasuryResolutionSlotAvailable()).toBeNull();
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBeLessThan(256);
  });
});
