/**
 * Remediation III / V2 基线反例（锁定 3f4e701）：
 * 同参数双 attempt（A/B 参数完全相同、不同 workKey、资源足以支撑两笔），
 * 先登记 A 再登记 B，随后实际执行 A 的真许可——基线 argsMap 是
 * stableStringify(args)→attemptId 的单值 Map，B 的登记覆盖 A，A 的
 * entered/effect 事件被归入 B。
 *
 * 本文件只在基线 worktree 运行（--runTestsByPath），不属于仓库测试集。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { createTreasuryHostJournal, makeTreasuryExactOracleAdapter } from "@mock/treasuryExactOracle";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
  },
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 200_000 },
  },
];

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
  return {
    fromRoom: "W1N57",
    fromLocation: "storage",
    toRoom: "W2N57",
    toLocation: "terminal",
    resource: RESOURCE_ENERGY,
    amount: 100,
    outcome: "ok",
    ...overrides,
  };
}

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error("build failed");
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error("admit failed");
  return admission;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  replaceTreasuryActionAdapterForTest(makeTreasuryExactOracleAdapter(createTreasuryHostJournal()));
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("V2 基线反例：同参数多 attempt 的宿主事件归属被覆盖", () => {
  it("登记 A→B 后实际执行 A：entered/effect 只归 A，B 不被误结算", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const argsA = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:v2:a", argsA);
    const b = admit(service, "biz:v2:b", argsA); // 参数完全相同、不同 workKey（合法）
    journal.registerAttempt(argsA, a.attemptId);
    journal.registerAttempt(argsA, b.attemptId); // 后登记覆盖同参数映射
    // 实际执行 A 的真许可（资源足以支撑两笔——1000 ≥ 100+100）。
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    expect(outcome.status).toBe("committed");
    console.log("V2 visibleFor(A):", JSON.stringify(journal.visibleFor(a.attemptId)));
    console.log("V2 visibleFor(B):", JSON.stringify(journal.visibleFor(b.attemptId)));
    // 修复后语义断言（基线上红：事件被归入 B）：
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1);
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1);
    expect(journal.visibleFor(b.attemptId).length).toBe(0); // B 无借用
    expect(oracle.trace.entered).toBe(1);
    expect(oracle.trace.effects).toBe(1); // 宿主余额只变化一笔
    expect((installed.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(900);
  });
});
