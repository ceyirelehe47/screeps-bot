/**
 * 第十一轮 3.13.7：legacy quarantine 版本化隔离测试。
 *
 * - legacyV1 authority 拒绝当前 adapter reconciler（capability 签发
 *   legacy_authority_isolated；resolution 防御拒绝）；
 * - 显式只读诊断列出隔离 entry（零写入——entry 原样保留）；
 * - 新 adapter version 不解释 legacy action（version mismatch）；
 * - legacy 路径不伪造 contract/cohort identity（迁移 entry 无合同字段）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
  treasuryLegacyQuarantineDiagnostics,
  type TreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import { makeTreasuryTestTransferAdapter, registerTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { registerTreasuryPolicyResolver, makeNoReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";

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

/** 构造 legacyV1 quarantine entry（v1 迁移产物形态：无 contract 字段 + legacyV1 标记）。 */
function seedLegacyQuarantine(transactionId: string, adapterVersion?: number): void {
  const write = quarantineTreasuryTransaction({
    transactionId,
    digest: "0123456789abcdef",
    tick: Game.time,
    kind: "test.transfer",
    source: "test",
    phase: "commit_unexpected",
    deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
    recordedAt: Game.time,
    outcome: "returned_ok",
    settlement: "quarantined",
    ...(adapterVersion !== undefined ? { adapterVersion } : {}),
    // legacyV1 标志检查走既有隔离分支（显式 legacy 等级拦截由 Round 13 测试覆盖）。
    authorityLevel: "lowlevel",
    legacyV1: true,
  } as TreasuryQuarantineEntry);
  expect(write.status).toBe("written");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("legacy quarantine 版本化隔离（第十一轮 3.13.7）", () => {
  it("legacyV1 authority 拒绝当前 adapter reconciler（capability 签发隔离）", () => {
    seedLegacyQuarantine("lg_iso");
    Game.time += 2;
    const service = makeService();
    const capability = service.issueTreasuryReconciliationCapability({ transactionId: "lg_iso" });
    expect(capability.status).toBe("rejected");
    if (capability.status === "rejected") {
      expect(capability.reason).toBe("legacy_authority_isolated");
      expect(capability.detail).toContain("legacy v1 quarantine");
    }
  });

  it("新 adapter version 不解释 legacy action（version mismatch 防线）", () => {
    seedLegacyQuarantine("lg_version", 1);
    // registry 当前 test.transfer v1：同版本时 legacy 标记先拒；构造 version
    // 不一致（entry 记 v99）验证版本防线语义仍在。
    clearTreasuryPersistenceForTest();
    const write = quarantineTreasuryTransaction({
      transactionId: "lg_version2",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "action_threw_execution_unknown",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      actionKind: "test.transfer",
      adapterVersion: 99,
      authorityLevel: "lowlevel",
    } as TreasuryQuarantineEntry);
    expect(write.status).toBe("written");
    Game.time += 2;
    const service = makeService();
    const capability = service.issueTreasuryReconciliationCapability({ transactionId: "lg_version2" });
    expect(capability.status).toBe("rejected");
    if (capability.status === "rejected") {
      expect(capability.reason).toBe("adapter_version_mismatch");
    }
  });

  it("显式只读诊断列出隔离 entry；entry 原样保留（零写入）", () => {
    seedLegacyQuarantine("lg_diag");
    const diagnostics = treasuryLegacyQuarantineDiagnostics();
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]).toMatchObject({ transactionId: "lg_diag", outcome: "returned_ok", phase: "commit_unexpected" });
    // 诊断零写入：entry 原样保留（无 contract/cohort 字段被伪造）。
    const entry = readTreasuryQuarantineEntry("lg_diag");
    expect(entry).toBeDefined();
    expect((entry as { contractId?: string }).contractId).toBeUndefined();
    expect((entry as { authorizationCohortDigest?: string }).authorizationCohortDigest).toBeUndefined();
    expect((entry as { legacyV1?: boolean }).legacyV1).toBe(true);
    // 再次诊断幂等。
    expect(treasuryLegacyQuarantineDiagnostics().length).toBe(1);
  });

  it("resolution 防御：legacy authority 即使到达 resolution 也拒绝", () => {
    seedLegacyQuarantine("lg_resolve");
    Game.time += 2;
    const service = makeService();
    // capability 无法签发（隔离）——resolution 入口以伪造 capability 尝试。
    const attempted = service.resolveUnresolvedTransaction({
      transactionId: "lg_resolve",
      capability: { __brand: "treasury-reconciliation-capability" } as never,
    });
    expect(attempted.status).toBe("rejected");
    // entry 保持不动。
    expect(readTreasuryQuarantineEntry("lg_resolve")).toBeDefined();
    void resetTreasuryQuarantineRuntimeForTest;
  });
});
