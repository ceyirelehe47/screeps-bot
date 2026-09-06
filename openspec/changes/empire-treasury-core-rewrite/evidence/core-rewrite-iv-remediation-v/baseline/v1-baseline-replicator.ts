/**
 * Remediation V/V1 基线反例（fb5e44b 专用，不入主仓测试树）。
 *
 * 场景（任务书 §3.1 固定反例）：
 *   正常接纳 A（oracle J）→ dispatch_start 发布时捕获 B0（**不传事件分支**）
 *   → 旧栈继续执行 A（世界 1000→900，J 新增 entered/effect）
 *   → 选择 B0 恢复，仍传使用 J 的 oracle。
 *
 * - TRACE 用例在 fb5e44b 上**绿**：真实复现错结论路径（世界回 1000 + J 保留
 *   较晚 effect + settle 误得 committed）——这是缺陷存在的直接证据；
 * - REJECT 用例在 fb5e44b 上**红**：断言修复后语义（恢复任何修改前拒绝）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionAdapter,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { captureTreasuryHostBreakpoint, performTreasuryFullReset, type TreasuryHostBreakpoint } from "@mock/treasuryResetHarness";
import {
  createTreasuryHostJournal,
  executeTreasuryAdmittedDispatch,
  makeTreasuryExactOracleAdapter,
  type TreasuryHostJournal,
} from "@mock/treasuryExactOracle";

const ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 } },
  { name: "W2N57", storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 }, terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 200_000 } },
];

const ARGS = { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 100, outcome: "ok" } as const;

function makeOracleService(journal: TreasuryHostJournal, adapterOverride?: TreasuryActionAdapter): TreasuryService {
  const installed = installRooms(ROOMS);
  replaceTreasuryActionAdapterForTest(adapterOverride ?? makeTreasuryExactOracleAdapter(journal));
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

/** 旧实验栈：接纳并执行 A；dispatch_start 已发布、世界效果发生前捕获 B0（无事件分支）。 */
function runOldStack(): { journal: TreasuryHostJournal; b0: TreasuryHostBreakpoint; aId: string } {
  const journal = createTreasuryHostJournal();
  let b0: TreasuryHostBreakpoint | undefined;
  // 包装 oracle：adapter 进入点（dispatch_start 已发布、效果未发生）即捕获
  // B0——**不传 captureBranch**（缺事件分支正是本反例）。
  const oracle = makeTreasuryExactOracleAdapter(journal);
  const wrapped: TreasuryActionAdapter = {
    ...oracle,
    execute(args: unknown): { ok: boolean } {
      if (b0 === undefined) b0 = captureTreasuryHostBreakpoint();
      return oracle.execute(args as Parameters<typeof oracle.execute>[0]);
    },
  } as unknown as TreasuryActionAdapter;
  const service = makeOracleService(journal, wrapped);
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:v1:A", args: { ...ARGS } });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey: "biz:v1:A" });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  const outcome = executeTreasuryAdmittedDispatch(journal, service, admission);
  if (outcome.status !== "committed") throw new Error(`old stack A outcome=${String(outcome.status)}`);
  if (b0 === undefined) throw new Error("B0 未捕获");
  // 旧栈继续执行后的事实：世界 1000→900；J 含 A 的 entered/effect。
  if (journal.visibleFor(admission.attemptId).length !== 2) throw new Error("J 未记录 A 的 entered/effect");
  return { journal, b0, aId: admission.attemptId };
}

function recordOf(attemptId: string): { phase: string; outcome?: string } | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, { phase: string; outcome?: string }> } | undefined;
  return store?.active?.[attemptId];
}

function roomEnergy(room: string, kind: "storage" | "terminal"): number {
  const rooms = (globalThis as unknown as { Game: { rooms: Record<string, Room> } }).Game.rooms;
  return ((rooms[room] as unknown as Record<string, { store: Record<string, number> } | undefined>)[kind]!.store.energy ?? 0);
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  clearTreasuryPolicyResolversForTest();
});

describe("V1 基线反例（fb5e44b）", () => {
  it("TRACE：缺 eventBranch 恢复得到『世界 1000 + J 含后来 effect + settle committed』错结论（基线缺陷事实）", () => {
    const { journal, b0, aId } = runOldStack();
    expect(roomEnergy("W1N57", "storage")).toBe(900); // 旧栈效果已发生
    // 选择 B0 恢复（仍传使用 J 的 oracle）——fb5e44b 不校验缺失来源。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: b0 });
    // 世界被断点回滚到 1000（效果在恢复分支中不存在）……
    expect(roomEnergy("W1N57", "storage")).toBe(1000);
    // ……但 J 仍保留 B0 之后的 entered/effect 事件（未随断点截断）。
    expect(journal.visibleFor(aId).map((e) => e.kind)).toEqual(["adapter-entered", "world-effect"]);
    // A 在 reset 的 beginTick 中被恢复为 unknown；继续 settle → 误得 committed。
    expect(recordOf(aId)?.phase).toBe("outcome_unknown");
    const settle = reset.service.settleUnknownOutcome({ attemptId: aId });
    expect(settle.status).toBe("ok"); // ← 错误结论：恢复分支世界无效果，却按旧日志判 executed
    expect(recordOf(aId)?.phase).toBe("closing");
    expect(recordOf(aId)?.outcome).toBe("committed");
  });

  it("REJECT：缺 eventBranch 的 exact 恢复必须在对账前、任何状态修改前拒绝（修复后语义）", () => {
    const { journal, b0, aId } = runOldStack();
    const memoryBefore = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
    const worldBefore = JSON.stringify((globalThis as unknown as { Game: { rooms: unknown } }).Game.rooms);
    const eventsBefore = JSON.stringify(journal.visibleFor(aId));
    const tickBefore = Game.time;
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: b0 }),
    ).toThrow(/事件分支|eventBranch|来源/);
    // 拒绝时零修改：Memory/世界/事件/tick 均不变。
    expect(JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory)).toBe(memoryBefore);
    expect(JSON.stringify((globalThis as unknown as { Game: { rooms: unknown } }).Game.rooms)).toBe(worldBefore);
    expect(JSON.stringify(journal.visibleFor(aId))).toBe(eventsBefore);
    expect(Game.time).toBe(tickBefore);
  });
});
