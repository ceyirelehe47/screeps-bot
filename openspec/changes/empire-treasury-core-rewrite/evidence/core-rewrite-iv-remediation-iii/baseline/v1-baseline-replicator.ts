/**
 * Remediation III / V1 基线反例（锁定 3f4e701）：
 * 首写放行（dispatch_start）时刻捕获 B0（效果前：世界 1000、无该 attempt 事件）；
 * 同一旧实验分支继续执行产生流出 100 → B1（世界 900、entered/effect 可见、
 * 最近 cut 已被 recordCut 推大）。随后明确选择恢复 B0——基线 oracle 仍按
 * 最近一次截断（可变 state.cut=B1 长度）过滤，B1 的效果事件在 B0 恢复分支
 * 可见，错误地对该 attempt 返回 committed。
 *
 * 本文件只在基线 worktree 运行（--runTestsByPath），不属于仓库测试集。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  makeTreasuryTestTransferAdapter,
  buildTreasuryActionContract,
  replaceTreasuryActionAdapterForTest,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { captureTreasuryHostBreakpoint, performTreasuryFullReset, type TreasuryHostBreakpoint } from "@mock/treasuryResetHarness";
import { createTreasuryHostJournal, makeTreasuryExactOracleAdapter } from "@mock/treasuryExactOracle";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";

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

describe("V1 基线反例：恢复较早断点时 oracle 仍采用最近一次截断", () => {
  it("恢复 B0（效果前）：修复后世界/事件均属 B0 分支，结论 not_executed 而非 committed", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:v1:bp", args);
    journal.registerAttempt(args, a.attemptId);
    // B0：首写（dispatch_start）放行时刻——效果尚未发生（世界 1000、事件空）。
    let b0: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        journal.recordCut();
        b0 = captureTreasuryHostBreakpoint(journal.entries);
      },
    });
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    interceptor.restore();
    if (outcome.status !== "persist_failed") throw new Error(`期望 persist_failed，实际 ${outcome.status}`);
    if (b0 === undefined) throw new Error("B0 未捕获");
    expect(b0.world.W1N57?.storage?.resources.energy ?? -1).toBe(1000); // B0 配对世界 = 效果前
    // 旧实验分支已产生流出 100；B1（效果后：世界 900、事件含 entered/effect）。
    journal.recordCut(); // 最近截断推进（基线缺陷数据源）
    const b1 = captureTreasuryHostBreakpoint(journal.entries);
    expect(b1.world.W1N57?.storage?.resources.energy ?? -1).toBe(900);
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // 旧分支现场
    // 明确选择恢复 B0。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryExactOracleAdapter(journal),
      advanceTicks: 1,
      breakpoint: b0,
    });
    // 世界回 B0（1000，不是 900）。
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(1000);
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    const record = (Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, { outcome?: string }>;
    }).active[a.attemptId];
    console.log("V1 B0-restore outcome:", record?.outcome);
    // 修复后语义断言（基线上红：借 B1 效果 → committed）：
    expect(record?.outcome).toBe("not_executed"); // B0 分支无该效果事件（正面未执行对照）
  });

  it("B1 正向对照：恢复 B1（效果后）→ committed（两分支依据各自事实）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:v1:b1", args);
    journal.registerAttempt(args, a.attemptId);
    let b0: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        journal.recordCut();
        b0 = captureTreasuryHostBreakpoint(journal.entries);
      },
    });
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    interceptor.restore();
    if (outcome.status !== "persist_failed") throw new Error("期望 persist_failed");
    if (b0 === undefined) throw new Error("B0 未捕获");
    journal.recordCut();
    const b1 = captureTreasuryHostBreakpoint(journal.entries);
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryExactOracleAdapter(journal),
      advanceTicks: 1,
      breakpoint: b1,
    });
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(900);
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    const record = (Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, { outcome?: string }>;
    }).active[a.attemptId];
    expect(record?.outcome).toBe("committed"); // B1 分支真实效果可见
  });
});
