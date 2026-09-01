/**
 * 【第十七轮第十八节】operation-count fixture——证明 lineage 协议的关键
 * 路径零全表扫描：
 * - retired root prepare 门禁：root/current O(1) 索引命中（lineage store
 *   fullScans 零增量）；
 * - child capability issuance：preflight 与派生均为单 key lookup（零全扫）；
 * - tr1_ capability 门禁 O(1)（WeakSet 对象身份 + 索引读取）；
 * - 空闲 beginTick 不重复全扫 lineage store（idleFastPath）；
 * - chain generation 推进不新增 store slot（entryCount 恒定）；
 * - tombstone retention 驱逐资格只做索引查询（lineage fullScans 零增量）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { makeTreasuryTestTransferAdapter, replaceTreasuryActionAdapterForTest, registerTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import {
  lineageStoreEvents,
  peekTreasuryAttemptLineageHealth,
  TREASURY_LINEAGE_MAX_ENTRIES,
} from "@/runtime/treasury/attemptLineage";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

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

function freshInput(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter("observed_not_executed"), kind: "terminal.send", semanticIdentity: "terminal.send@reconciler-semantics-v1" });
});

/** 制造低层 executing quarantine 并 resolve 为 not-executed（返回 rearm service）。 */
function makeRetiredParent(transactionId: string): TreasuryTestService {
  const service = makeService();
  service.executePreparedAction(freshInput(service, transactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  Game.time += 1;
  const next = makeService();
  const issued = next.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") throw new Error("capability fail");
  const resolved = next.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
  if (resolved.status !== "resolved") throw new Error("resolve fail");
  return next;
}

it("retired root prepare 门禁零全扫（O(1) 索引命中）", () => {
  const next = makeRetiredParent("oc_retired_root");
  const scansBefore = lineageStoreEvents.fullScans;
  const readsBefore = lineageStoreEvents.idleFastPath; // 噪声基线
  void readsBefore;
  // retired root 的 prepare：lineage 索引命中即拒绝（无全表扫描）。
  const prepared = next.prepareTransaction(freshInput(next, "oc_retired_root"));
  expect(prepared.status).toBe("rejected");
  // 多次重复门禁仍零增量（heap 索引缓存命中）。
  for (let i = 0; i < 20; i += 1) {
    void next.prepareTransaction(freshInput(next, "oc_retired_root"));
  }
  expect(lineageStoreEvents.fullScans).toBe(scansBefore);
});

it("child capability issuance 零全扫（preflight 单 key lookup）", () => {
  const next = makeRetiredParent("oc_issue");
  const scansBefore = lineageStoreEvents.fullScans;
  const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "oc_issue" });
  expect(issued.status).toBe("issued");
  expect(lineageStoreEvents.fullScans).toBe(scansBefore);
});

it("tr1_ capability 门禁 O(1)：无 capability 的 tr1_ prepare 零全扫", () => {
  const next = makeService();
  const scansBefore = lineageStoreEvents.fullScans;
  for (let i = 0; i < 20; i += 1) {
    const rejected = next.prepareTransaction(freshInput(next, `tr1_ocprobe${String(i).padStart(4, "0")}`));
    expect(rejected.status).toBe("rejected");
  }
  expect(lineageStoreEvents.fullScans).toBe(scansBefore);
});

it("空闲 beginTick 不重复全扫 lineage store（idleFastPath 计数）", () => {
  makeRetiredParent("oc_idle");
  const scansBefore = lineageStoreEvents.fullScans;
  const idleBefore = lineageStoreEvents.idleFastPath;
  // 连续多个空闲 tick：pending 与 pendingRelease 索引均空 → O(1) 快路径。
  for (let i = 0; i < 5; i += 1) {
    Game.time += 1;
    const next = makeService();
    void next;
  }
  expect(lineageStoreEvents.fullScans).toBe(scansBefore);
  expect(lineageStoreEvents.idleFastPath).toBeGreaterThan(idleBefore);
});

it("chain generation 推进不新增 store slot（entryCount 恒定）", () => {
  const next = makeRetiredParent("oc_chain");
  const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "oc_chain" });
  expect(issued.status).toBe("issued");
  if (issued.status !== "issued") return;
  const countAfterRoot = peekTreasuryAttemptLineageHealth().entryCount;
  expect(countAfterRoot).toBe(1);
  // child B 接管执行 + 独立 resolution + 孙代 issue——全程同 record。
  const executed = next.executePreparedAction(
    freshInput(next, issued.childTransactionId),
    () => {
      next.endTick();
      return { ok: false as const };
    },
    { rearmCapability: issued.capability },
  );
  expect(executed.status).not.toBe("prepare_rejected");
  Game.time += 1;
  const t3 = makeService();
  const bCap = t3.issueTreasuryReconciliationCapability({ transactionId: issued.childTransactionId });
  if (bCap.status !== "issued") throw new Error("b capability fail");
  const bResolved = t3.resolveUnresolvedTransaction({ transactionId: issued.childTransactionId, capability: bCap.capability });
  expect(bResolved.status).toBe("resolved");
  expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
  const grandchild = t3.issueTreasuryRearmCapability({ parentTransactionId: issued.childTransactionId });
  expect(grandchild.status).toBe("issued");
  expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1); // 仍同 record
  expect(peekTreasuryAttemptLineageHealth().entryCount).toBeLessThanOrEqual(TREASURY_LINEAGE_MAX_ENTRIES);
});

it("tombstone retention 驱逐资格只做索引查询（lineage fullScans 零增量）", () => {
  makeRetiredParent("oc_retention");
  const scansBefore = lineageStoreEvents.fullScans;
  // 一次容量探测（store 未满 → 直接返回零扫描；驱逐资格检查只做 lineage
  // 索引查询——满载场景由主测试文件覆盖，此处证明常规路径零全扫）。
  const service = makeService();
  void service;
  expect(lineageStoreEvents.fullScans).toBe(scansBefore);
});
