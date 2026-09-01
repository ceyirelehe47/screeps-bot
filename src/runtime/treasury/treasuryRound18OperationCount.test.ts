/**
 * 【第十八轮 24.15】operation-count fixture——确定性断言关键路径零全扫：
 * - lineageId O(1) 读取（不扫描 entries）；
 * - 单个 handoff recovery 不全扫（pendingIds 驱动）；
 * - 单条 tombstone replacement verdict 只做 O(1) 索引查询；
 * - A→B→C 推进不增加 active entryCount；
 * - terminal 压缩释放 active slot；
 * - 空闲 beginTick O(1)（idleFastPath）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
  lineageStoreEvents,
  resetTreasuryLineageRuntimeForTest,
} from "@/runtime/treasury/attemptLineage";
import { retirementSummaryEvents } from "@/runtime/treasury/lineageRetirementSummary";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { readTreasuryGenerationRetirementProof } from "@/runtime/treasury/generationRetirementAuthority";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";

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

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  return makeService();
}

function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

function buildContract(service: TreasuryTestService, transactionId: string, outcome: "ok" | "non-ok" | "throw") {
  const built = buildTreasuryActionContract(service, {
    actionKind: "test.transfer",
    transactionId,
    args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W1N57", toLocation: "terminal", resource: "energy", amount: 500, outcome },
  });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter("observed_not_executed"), kind: "terminal.send", semanticIdentity: "terminal.send@reconciler-semantics-v1" });
});

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

/** 产生 chain 并推进 N 代（non-OK 路径），返回推进后的 parent。 */
function advanceChain(rootId: string, generations: number): string {
  const service = makeService();
  {
    const contract = buildContract(service, rootId, "throw");
    const authorized = service.authorizeTreasuryActionContract(contract);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") throw new Error("auth failed");
    try {
      executeTreasuryActionContract(service, { contract, authorization: authorized.bundle });
    } catch {
      /* expected */
    }
  }
  expect(readTreasuryQuarantineEntry(rootId)).toBeDefined();
  let parent = rootId;
  let current = advanceTick();
  if (resolveNotExecuted(current, parent).status !== "resolved") throw new Error("resolve failed");
  for (let i = 0; i < generations; i += 1) {
    const issued = current.issueTreasuryRearmCapability({ parentTransactionId: parent });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("issue failed");
    const contract = buildContract(current, issued.childTransactionId, "non-ok");
    const authorized = current.authorizeTreasuryActionContract(contract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") throw new Error("auth failed");
    const executed = executeTreasuryActionContract(current, { contract, authorization: authorized.bundle, rearmCapability: issued.capability });
    expect(executed.status).toBe("executed_aborted");
    parent = issued.childTransactionId;
    current = advanceTick();
  }
  return parent;
}

describe("round 18 operation-count（第十八轮 24.15）", () => {
  it("lineageId 读取 O(1)：load 后多次 read 不增加 fullScans", () => {
    advanceChain("r18_op_read", 2);
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_op_read")!;
    const scansBefore = lineageStoreEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      expect(readTreasuryAttemptLineageRecord(record.lineageId)).toBeDefined();
    }
    expect(lineageStoreEvents.fullScans).toBe(scansBefore);
  });

  it("单个 handoff recovery 不全扫（pending lineage 的 beginTick）", () => {
    advanceChain("r18_op_hoff", 1);
    const scansBefore = lineageStoreEvents.fullScans;
    advanceTick();
    // 恢复只处理 pending lineage ID——lineage store 不重新全表扫描。
    expect(lineageStoreEvents.fullScans).toBe(scansBefore);
  });

  it("单条 tombstone replacement verdict：O(1) 索引查询（lineage fullScans 不增）", () => {
    advanceChain("r18_op_verdict", 3);
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_op_verdict")!;
    // 【第二十轮】root（历史代 gen 0）的 verdict 维度取该代 exact retirement
    // proof 的 identity（当前代 currentIdentity 与 root 代不同——代际不可混用）。
    const rootProof = readTreasuryGenerationRetirementProof(record.lineageId, 0)!;
    expect(rootProof).toBeDefined();
    const scansBefore = lineageStoreEvents.fullScans;
    for (let i = 0; i < 30; i += 1) {
      const verdict = treasuryTombstoneReplacementVerdict({
        transactionId: record.rootTransactionId,
        digest: rootProof.digest,
        resolution: "not-executed",
        stage: "final",
        proofLevel: rootProof.authorityClass,
        // 【第二十轮 12.2】完整 attempt identity 维度（exact proof 比较需要）。
        contractDigest: rootProof.contractDigest,
        authorizationCohortDigest: rootProof.authorizationCohortDigest,
        durableIdentityDigest: rootProof.durableIdentityDigest,
        lowlevelSource: rootProof.lowlevelSource,
      });
      expect(verdict.verdict).toBe("replacement_match");
    }
    expect(lineageStoreEvents.fullScans).toBe(scansBefore);
  });

  it("A→B→C 推进不增加 active entryCount", () => {
    const entryCounts: number[] = [];
    const service = makeService();
    const contract = buildContract(service, "r18_op_abc", "throw");
    const authorized = service.authorizeTreasuryActionContract(contract);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    try {
      executeTreasuryActionContract(service, { contract, authorization: authorized.bundle });
    } catch {
      /* expected */
    }
    let parent = "r18_op_abc";
    let current = advanceTick();
    expect(resolveNotExecuted(current, parent).status).toBe("resolved");
    entryCounts.push(peekTreasuryAttemptLineageHealth().entryCount);
    for (let i = 0; i < 3; i += 1) {
      const issued = current.issueTreasuryRearmCapability({ parentTransactionId: parent });
      expect(issued.status).toBe("issued");
      if (issued.status !== "issued") return;
      const childContract = buildContract(current, issued.childTransactionId, "non-ok");
      const childAuth = current.authorizeTreasuryActionContract(childContract, { rearmCapability: issued.capability });
      expect(childAuth.status).toBe("authorized");
      if (childAuth.status !== "authorized") return;
      expect(executeTreasuryActionContract(current, { contract: childContract, authorization: childAuth.bundle, rearmCapability: issued.capability }).status).toBe("executed_aborted");
      parent = issued.childTransactionId;
      current = advanceTick();
      entryCounts.push(peekTreasuryAttemptLineageHealth().entryCount);
    }
    expect(entryCounts).toEqual([1, 1, 1, 1]);
  });

  it("terminal 压缩释放 active slot（compactions 计数 + entryCount 归零）", () => {
    const service = makeService();
    const contract = buildContract(service, "r18_op_cmp", "throw");
    const authorized = service.authorizeTreasuryActionContract(contract);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    try {
      executeTreasuryActionContract(service, { contract, authorization: authorized.bundle });
    } catch {
      /* expected */
    }
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_op_cmp").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_op_cmp" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const childContract = buildContract(next, issued.childTransactionId, "ok");
    const childAuth = next.authorizeTreasuryActionContract(childContract, { rearmCapability: issued.capability });
    expect(childAuth.status).toBe("authorized");
    if (childAuth.status !== "authorized") return;
    expect(executeTreasuryActionContract(next, { contract: childContract, authorization: childAuth.bundle, rearmCapability: issued.capability }).status).toBe("executed_committed");
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    const compactionsBefore = retirementSummaryEvents.compactions;
    advanceTick();
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(0);
    expect(retirementSummaryEvents.compactions).toBe(compactionsBefore + 1);
  });

  it("空闲 beginTick O(1)：无 pending 时 idleFastPath 递增、fullScans 不增", () => {
    makeService();
    const scansBefore = lineageStoreEvents.fullScans;
    const idleBefore = lineageStoreEvents.idleFastPath;
    advanceTick();
    advanceTick();
    expect(lineageStoreEvents.fullScans).toBe(scansBefore);
    expect(lineageStoreEvents.idleFastPath).toBeGreaterThanOrEqual(idleBefore + 2);
  });
});

void resetTreasuryLineageRuntimeForTest;
