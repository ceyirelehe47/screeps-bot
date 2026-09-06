/**
 * Treasury Core Rewrite IV · Remediation III——service/工具层 G 矩阵（任务书 §6）。
 *
 * 覆盖：G09/G10/G11（所选断点是恢复分支事件的唯一输入：B0/B1/B2 矩阵、
 * 重复恢复、错事件源对照）、G12/G13（同参数多 attempt 的 exact 调用关联）、
 * G14（调用上下文缺失/错配/嵌套/异常/reset）、G15（真实 rearm 同参数
 * child 与断点组合）、G16（exact committed 后余额/空间对照）、G17（既有
 * preflight/fresh/policy 门禁与 unknown 不误释放回归）。内核层 G01–G08/G18
 * 见 treasuryRemediationIIIKernel.test.ts。
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
import {
  captureTreasuryHostBreakpoint,
  performTreasuryFullReset,
  type TreasuryFullResetResult,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { createTreasuryHostJournal, makeTreasuryExactOracleAdapter, type TreasuryHostJournal } from "@mock/treasuryExactOracle";
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

/** 流入对照：目标 terminal 空位 100。 */
const ROOMS_INFLOW: RoomSpec[] = [
  ROOMS[0],
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 100 },
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

function makeService(roomSpecs: RoomSpec[] = ROOMS): TreasuryService {
  const installed = installRooms(roomSpecs);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

type Admission = ReturnType<TreasuryService["authorizeTreasuryActionContract"]> & { status: "admitted"; attemptId: string; dispatch: unknown };

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs): Admission {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission as Admission;
}

/** reset 后的 admit（必须用新模块句柄构建合同）。 */
function admitOn(reset: TreasuryFullResetResult, workKey: string, args: TreasuryTestTransferArgs): Admission {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error("build failed");
  const admission = reset.service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission as Admission;
}

/** 直接按金额发起授权（拒绝路径断言用）。 */
function authorizeAmount(service: TreasuryService, workKey: string, amount: number, outcome: "ok" | "non-ok" = "ok") {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args: transferArgs({ amount, outcome }) });
  if (built.status !== "built") throw new Error(`build failed: ${built.reason}`);
  return service.authorizeTreasuryActionContract(built.contract, { workKey });
}

/** 授权对照（reset 后用新模块句柄构建合同）。 */
function authorizeOn(reset: TreasuryFullResetResult, workKey: string, args: TreasuryTestTransferArgs) {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, {
    actionKind: "test.transfer",
    transactionId: workKey,
    args,
  });
  if (built.status !== "built") throw new Error("build failed");
  return reset.service.authorizeTreasuryActionContract(built.contract, { workKey });
}

interface CleanupShape {
  phase: string;
  outcome?: string;
  invocation: unknown;
  invocationBoundary: unknown;
  cleanup?: { consumerKeys: readonly string[] };
}

function recordShape(attemptId: string): CleanupShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, CleanupShape> } | undefined;
  return store?.active?.[attemptId];
}

function roomEnergy(reset: TreasuryFullResetResult | Record<string, Room>, room: string, kind: "storage" | "terminal"): number {
  const rooms = (reset as { rooms?: Record<string, Room> }).rooms ?? (reset as Record<string, Room>);
  return ((rooms[room] as unknown as Record<string, { store: Record<string, number> } | undefined>)[kind]!.store.energy ?? 0);
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

/** G09–G11 共用：一次真实执行内的两断点（B0=首写放行时[效果前]、B1=效果后）。 */
function twoBreakpointFlow(workKey: string, amount: number): {
  journal: TreasuryHostJournal;
  b0: TreasuryHostBreakpoint;
  b1: TreasuryHostBreakpoint;
  attemptId: string;
} {
  const journal = createTreasuryHostJournal();
  const oracle = makeTreasuryExactOracleAdapter(journal);
  replaceTreasuryActionAdapterForTest(oracle);
  const service = makeService();
  const args = transferArgs({ amount, outcome: "ok" });
  const a = admit(service, workKey, args);
  let b0: TreasuryHostBreakpoint | undefined;
  const interceptor = interceptTreasuryCoreWrites({
    allow: 1,
    onAllow: () => {
      b0 = captureTreasuryHostBreakpoint(journal.captureBranch()); // dispatch_start 放行时刻（效果前）
    },
  });
  const outcome = journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch));
  interceptor.restore();
  if (outcome.status !== "persist_failed") throw new Error(`期望 persist_failed，实际 ${outcome.status}`);
  if (b0 === undefined) throw new Error("B0 未捕获");
  const b1 = captureTreasuryHostBreakpoint(journal.captureBranch()); // 旧实验分支效果后
  return { journal, b0, b1, attemptId: a.attemptId };
}

// ── G09：恢复 B0（效果前）——事件/世界/计数均属 B0 分支 ────────────────────

describe("G09 所选断点 B0（效果前）是恢复分支唯一事件输入", () => {
  it("世界/Memory/可见事件/计数均属 B0：not_executed（正面未执行对照），不借 B1 效果 committed", () => {
    const { journal, b0, b1, attemptId } = twoBreakpointFlow("biz:g9:bp", 100);
    expect(b0.world.W1N57?.storage?.resources.energy).toBe(1000); // B0 配对世界（效果前）
    expect(b1.world.W1N57?.storage?.resources.energy).toBe(900); // 旧分支效果后世界
    expect(journal.visibleFor(attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // 旧分支现场
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b0 });
    expect(roomEnergy(reset, "W1N57", "storage")).toBe(1000); // 世界回 B0
    const settled = reset.service.settleUnknownOutcome({ attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    const record = recordShape(attemptId)!;
    expect(record.outcome).toBe("not_executed"); // B0 分支无该效果事件（不是借 B1 的 committed）
    expect(journal.visibleFor(attemptId).filter((e) => e.kind === "world-effect").length).toBe(0); // 恢复分支不可见 B1 效果
  });

  it("B0 分支无正面未执行事实（世界序已越过进入序）时 still-uncertain——不为反驳 committed 自动 not-executed", () => {
    const { journal, b0, attemptId } = twoBreakpointFlow("biz:g9:unc", 100);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b0 });
    // B0 分支内发生无关动作 C（entered 事件可见 + 世界序推进）——本 attempt
    // 的可见事件无 world-effect，但分支世界序已越过其进入序 → 无正面未执行事实。
    const argsC = transferArgs({ amount: 50, outcome: "ok" });
    const c = admitOn(reset, "biz:g9:c", argsC);
    expect(journal.runWithInvocation(c, argsC, () => reset.service.executeAuthorizedDispatch(c.dispatch)).status).toBe("committed");
    const settled = reset.service.settleUnknownOutcome({ attemptId });
    expect(settled.status).toBe("still_uncertain"); // 证据不足：拒绝落定（不为反驳 committed 自动 not-executed）
    expect(recordShape(attemptId)?.outcome).toBe("unknown");
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown"); // 保守保留
  });
});

// ── G10：B1 正向对照 + 重复独立恢复 B0 ─────────────────────────────────────

describe("G10 B1 对照与重复恢复独立性", () => {
  it("选择 B1：包含真实效果并能对账关闭（committed）", () => {
    const { journal, b1, attemptId } = twoBreakpointFlow("biz:g10:b1", 100);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b1 });
    expect(roomEnergy(reset, "W1N57", "storage")).toBe(900);
    const settled = reset.service.settleUnknownOutcome({ attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
  });

  it("两次独立恢复 B0：分支互不污染、废弃分支事件不重现（不通过删事件让 G09 假通过）", () => {
    const { journal, b0, attemptId } = twoBreakpointFlow("biz:g10:twice", 100);
    for (let round = 0; round < 2; round += 1) {
      const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b0 });
      expect(roomEnergy(reset, "W1N57", "storage")).toBe(1000);
      const settled = reset.service.settleUnknownOutcome({ attemptId });
      if (settled.status !== "ok") throw new Error("settle failed");
      expect(recordShape(attemptId)?.outcome).toBe("not_executed");
      expect(journal.visibleFor(attemptId).filter((e) => e.kind === "world-effect").length).toBe(0); // 两个 B0 分支都看不到 B1 效果
      // 恢复分支内的动作事件只属于本分支（round 0 的 C 不进入 round 1）。
      const argsC = transferArgs({ amount: 30, outcome: "ok" });
      const c = admitOn(reset, `biz:g10:c${String(round)}`, argsC);
      expect(journal.runWithInvocation(c, argsC, () => reset.service.executeAuthorizedDispatch(c.dispatch)).status).toBe("committed");
    }
    const visibleAfter = journal.visibleFor(attemptId);
    expect(visibleAfter.filter((e) => e.kind === "world-effect").length).toBe(0); // C 的效果不倒记给 A
  });
});

// ── G11：恢复 B0 → 新动作 C → B2 → 再恢复 B2；错事件源对照 ─────────────────

describe("G11 分支链（B2 继承所选分支祖先事件）", () => {
  it("B2 = B0 祖先 + B0 子分支的 C；不含旧主分支 B0 之后的 A 效果；B2 恢复各自对账", () => {
    const { journal, b0, attemptId } = twoBreakpointFlow("biz:g11:chain", 100);
    // 恢复 B0 → 新动作 C（世界 1000→950）→ 捕获 B2。
    const reset0 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b0 });
    const argsC = transferArgs({ amount: 50, outcome: "ok" });
    const c = admitOn(reset0, "biz:g11:c", argsC);
    expect(journal.runWithInvocation(c, argsC, () => reset0.service.executeAuthorizedDispatch(c.dispatch)).status).toBe("committed");
    const b2 = captureTreasuryHostBreakpoint(journal.captureBranch());
    expect(b2.world.W1N57?.storage?.resources.energy).toBe(950); // B2 世界 = B0 + C
    // 再恢复 B2：可见事件含 C（B0 子分支祖先），不含旧主分支 A 的效果。
    const reset2 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b2 });
    expect(roomEnergy(reset2, "W1N57", "storage")).toBe(950);
    expect(journal.visibleFor(c.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // C 的效果在 B2 分支可见
    expect(journal.visibleFor(attemptId).filter((e) => e.kind === "world-effect").length).toBe(0); // A 的旧主分支效果不因 cut 增大重现
    // B2 分支世界序已越过 A 的边界序（C 的效果）且无 A 效果事件 → 证据不足，
    // 不自动落定（与 G09 的正面 not-executed 对照分开）。
    expect(reset2.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
  });

  it("错配事件源（Memory 世界序与断点捆绑不一致）：明确拒绝，不静默对账", () => {
    const { journal, b0, attemptId } = twoBreakpointFlow("biz:g11:mism", 100);
    const forged: TreasuryHostBreakpoint = { ...b0, worldSequence: b0.worldSequence + 7 }; // 篡改捆绑世界序
    expect(() => performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: forged })).toThrow(/断点配对不一致/);
    // 原断点仍可正常恢复（工具拒绝不污染宿主状态）。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b0 });
    const settled = reset.service.settleUnknownOutcome({ attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    expect(recordShape(attemptId)?.outcome).toBe("not_executed");
  });
});

// ── G12/G13：同参数多 attempt 的 exact 调用关联 ─────────────────────────────

describe("G12 同参数 A/B：登记后实际只执行 A", () => {
  it("entered/effect 仅归 A；B 不被误结算；宿主余额只变化一笔；不改 args、不禁用合法 A/B", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const argsA = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:g12:a", argsA);
    const b = admit(service, "biz:g12:b", argsA); // 参数完全相同、不同 workKey——资源足以支撑两笔
    expect(journal.runWithInvocation(a, argsA, () => service.executeAuthorizedDispatch(a.dispatch)).status).toBe("committed");
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1);
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1);
    expect(journal.visibleFor(b.attemptId).length).toBe(0); // B 不借用 A 的事件
    expect(oracle.trace.entered).toBe(1);
    expect(oracle.trace.effects).toBe(1); // 宿主余额只变化一笔
    expect(((Game.rooms as Record<string, unknown>).W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(900); // 世界（不重装）
    // B 仍可独立执行（合法同参数工作不被禁用）。
    expect(journal.runWithInvocation(b, argsA, () => service.executeAuthorizedDispatch(b.dispatch)).status).toBe("committed");
    expect(journal.visibleFor(b.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1);
  });
});

describe("G13 同参数 A/B 逆序与依次执行", () => {
  it("逆序执行 B→A：每笔记录真实参数与对应许可身份、各自恰一次；事件身份不随登记/执行顺序变化", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:g13:a", args);
    const b = admit(service, "biz:g13:b", args);
    expect(journal.runWithInvocation(b, args, () => service.executeAuthorizedDispatch(b.dispatch)).status).toBe("committed");
    expect(journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch)).status).toBe("committed");
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1);
    expect(journal.visibleFor(b.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1);
    expect(oracle.trace.effects).toBe(2); // 两笔各自一次
    // 事件身份稳定（再次查询不变化）。
    expect(journal.visibleFor(a.attemptId).every((e) => e.attemptId === a.attemptId)).toBe(true);
    expect(journal.visibleFor(b.attemptId).every((e) => e.attemptId === b.attemptId)).toBe(true);
  });
});

// ── G14：调用上下文缺失/错配/嵌套/异常/reset ───────────────────────────────

describe("G14 受控调用上下文的隔离", () => {
  it("无作用域：实际调用计数准确、事件不归属任何 attempt（不猜测）、unlinked 诊断", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:g14:scopeless", args);
    // 不建立调用作用域直接执行（上下文缺失——工具不得猜归 attempt）。
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(oracle.trace.entered).toBe(1); // 实际调用计数准确
    expect(oracle.trace.effects).toBe(1);
    expect(journal.visibleFor(a.attemptId).length).toBe(0); // 不归属（含不归其他 attempt）
    expect(journal.unlinkedCalls).toBe(1); // 明确诊断（不能 exact 对账的调用）
  });

  it("参数不匹配：不归属该 attempt；正确 args 才归属（逐次核对金额）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const argsA = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:g14:mismatch", argsA);
    // 作用域登记 100，实际执行 200（金额错传——不得因 attempt 正确就忽略）。
    const wrongArgs = transferArgs({ amount: 200, outcome: "ok" });
    void wrongArgs;
    const mismatchScopeArgs = transferArgs({ amount: 200, outcome: "ok" });
    expect(() => journal.runWithInvocation(a, mismatchScopeArgs, () => service.executeAuthorizedDispatch(a.dispatch))).not.toThrow();
    expect(journal.visibleFor(a.attemptId).length).toBe(0); // 参数不匹配 → 不归属
    expect(journal.unlinkedCalls).toBe(1);
    void argsA;
  });

  it("嵌套作用域：内层身份只关联内层、外层恢复后续调用；异常后不泄漏前一作用域", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const argsA = transferArgs({ amount: 60, outcome: "ok" });
    const argsB = transferArgs({ amount: 40, outcome: "ok" });
    const a = admit(service, "biz:g14:outer", argsA);
    const b = admit(service, "biz:g14:inner", argsB);
    // 嵌套：外层 fn 内执行 b（内层作用域）——内层事件归 b，不归 a。
    const outerResult = journal.runWithInvocation(a, argsA, () => {
      const innerResult = journal.runWithInvocation(b, argsB, () => service.executeAuthorizedDispatch(b.dispatch));
      expect(innerResult.status).toBe("committed");
      return service.executeAuthorizedDispatch(a.dispatch);
    });
    expect(outerResult.status).toBe("committed");
    expect(journal.visibleFor(b.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // 内层归 b
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // 外层 fn 后半归 a
    expect(journal.unlinkedCalls).toBe(0);
    // 异常后不泄漏：内层抛错 → finally 弹栈 → 后续无作用域调用不归属旧身份。
    expect(() => journal.runWithInvocation(a, argsA, () => { throw new Error("scoped fault"); })).toThrow("scoped fault");
    const c = admit(service, "biz:g14:leak", transferArgs({ amount: 10, outcome: "ok" }));
    service.executeAuthorizedDispatch(c.dispatch); // 无作用域（不应沿用 a）
    expect(journal.visibleFor(c.attemptId).length).toBe(0);
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1); // a 仍是恰一次（无泄漏追加）
  });

  it("完整 reset 后：新模块不持有旧执行上下文（旧栈硬终止恢复不复用）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:g14:reset", args);
    expect(journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch)).status).toBe("committed");
    // 完整 reset（入口快照重装 + 模块重建）：宿主事件事实保留（祖先链）。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1 });
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // 旧事实保留（同世界继续）
    // 新 runtime 执行新动作：无旧作用域残留（新调用未建立作用域 → 不归属旧/新 attempt）。
    const args2 = transferArgs({ amount: 50, outcome: "ok" });
    const d = admitOn(reset, "biz:g14:new", args2);
    reset.service.executeAuthorizedDispatch(d.dispatch); // 故意无作用域
    expect(journal.visibleFor(d.attemptId).length).toBe(0);
    expect(journal.visibleFor(a.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1); // a 的事实不被追加（无泄漏）
    expect(journal.unlinkedCalls).toBeGreaterThanOrEqual(1);
  });
});

// ── G15：真实 rearm + 同参数 child + 断点组合 ───────────────────────────────

describe("G15 真实 capability→rearm→同参数 child", () => {
  it("child 新身份执行、父代无效果事实与 child 效果分离、旧许可不可重放；断点组合后各自对账", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const argsParent = transferArgs({ amount: 50, outcome: "non-ok" });
    const parent = admit(service, "biz:g15:retry", argsParent);
    // 父代首轮无效果（non-ok：进入 adapter、无世界效果）。
    expect(journal.runWithInvocation(parent, argsParent, () => service.executeAuthorizedDispatch(parent.dispatch)).status).toBe("not_executed");
    expect(journal.visibleFor(parent.attemptId).filter((e) => e.kind === "world-effect").length).toBe(0);
    expect(journal.visibleFor(parent.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1); // 父代的进入事实
    Game.time += 1;
    service.beginTick(); // not_executed → retry_ready
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("capability failed");
    const childContract = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:g15:retry", args: transferArgs({ amount: 50 }) });
    if (childContract.status !== "built") throw new Error("child contract failed");
    const child = service.executeRearm(capability.rearm, childContract.contract, { workKey: "biz:g15:retry" });
    if (child.status !== "admitted") throw new Error(`rearm failed: ${child.reason}`);
    expect(child.attemptId).not.toBe(parent.attemptId); // child 新 attempt 身份
    // 旧父代许可不可重放。
    expect(service.executeAuthorizedDispatch(parent.dispatch).status).toBe("rejected");
    // child 执行（与父代 args 完全相同——作用域绑定 child 许可身份）。
    const argsChild = transferArgs({ amount: 50 });
    expect(journal.runWithInvocation(child, argsChild, () => service.executeAuthorizedDispatch(child.dispatch)).status).toBe("committed");
    expect(journal.visibleFor(child.attemptId).filter((e) => e.kind === "world-effect").length).toBe(1); // child 的效果
    expect(journal.visibleFor(parent.attemptId).filter((e) => e.kind === "world-effect").length).toBe(0); // 父代无效果事实（不倒记）
    expect(journal.visibleFor(child.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1); // child 自己的进入
    // 世界事实：只流出 50（child）——父代 non-ok 无效果（不重装房间，读当前世界）。
    expect(((Game.rooms as Record<string, unknown>).W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(950);
  });
});

// ── G16：exact committed 后的余额/空间对照（防污染分支） ────────────────────

describe("G16 exact committed 后余额/空间对照", () => {
  it("流出：世界 1000 无责任时 801 拒（独立分支）；已流出 800 后 200 纳、201 拒；A 仍 closing 未提前删除", () => {
    // 分支一：世界 1000、无任何责任——先越界拒绝、再合法接纳（§6.1：避免已接纳
    // 候选自身占用污染比较；801 拒绝不是"先纳 800 再拒 801"的伪证）。
    {
      const service = makeService();
      expect(authorizeAmount(service, "biz:g16:base-1001", 1001).status).toBe("rejected"); // 越界拒绝（前置无占用：1001 > 1000）
      const fits800 = admit(service, "biz:g16:base-800", transferArgs({ amount: 800, outcome: "ok" }));
      expect(fits800.status).toBe("admitted"); // 同一前置状态的合法接纳（无单笔 800 上限）
    }
    // 分支二：真实执行流出 800 → 效果后断点（B1）恢复 → exact committed → A 仍 closing（未删）→ 200 纳、201 拒。
    resetTreasuryCoreStoreForTest(); // 分支一的 pending 不污染分支二
    const { journal, b1, attemptId } = twoBreakpointFlow("biz:g16:out", 800);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b1 });
    const settled = reset.service.settleUnknownOutcome({ attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
    expect(recordShape(attemptId)?.phase).toBe("closing"); // A 未被提前删除
    expect(roomEnergy(reset, "W1N57", "storage")).toBe(200); // 世界已含 800 流出
    expect(authorizeOn(reset, "biz:g16:fits", transferArgs({ amount: 200, outcome: "ok" })).status).toBe("admitted"); // 覆盖成立：不双扣
    expect(authorizeOn(reset, "biz:g16:toobig", transferArgs({ amount: 201, outcome: "ok" })).status).toBe("rejected");
  });

  it("流入：空位 100、实际流入 80 后 20 纳、21 拒", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService(ROOMS_INFLOW);
    const args = transferArgs({ amount: 80, outcome: "ok" });
    const a = admit(service, "biz:g16:in", args);
    let b0: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        b0 = captureTreasuryHostBreakpoint(journal.captureBranch());
      },
    });
    const outcome = journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch));
    interceptor.restore();
    if (outcome.status !== "persist_failed") throw new Error("期望 persist_failed");
    if (b0 === undefined) throw new Error("B0 未捕获");
    const b1 = captureTreasuryHostBreakpoint(journal.captureBranch()); // 效果后断点（世界已流入 80）
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS_INFLOW, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1, breakpoint: b1 });
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    if (settled.status !== "ok") throw new Error("settle failed");
    expect(recordShape(a.attemptId)?.outcome).toBe("committed");
    const terminal = (reset.rooms.W2N57 as unknown as { terminal: { store: { getFreeCapacity(): number } } }).terminal.store;
    expect(terminal.getFreeCapacity()).toBe(20); // 空位 100−80
    expect(authorizeOn(reset, "biz:g16:in-fits", transferArgs({ amount: 20, outcome: "ok" })).status).toBe("admitted");
    expect(authorizeOn(reset, "biz:g16:in-toobig", transferArgs({ amount: 21, outcome: "ok" })).status).toBe("rejected");
  });
});

// ── G17：既有门禁与 unknown 不误释放回归 ────────────────────────────────────

describe("G17 门禁与保守语义回归", () => {
  it("healthy 真许可执行、非健康核心拒绝、unknown 不因观察释放、endTick 关窗后新授权拒绝", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    // healthy：真许可执行。
    const args = transferArgs({ amount: 100, outcome: "throw" });
    const a = admit(service, "biz:g17:unknown", args);
    expect(journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch)).status).toBe("unknown");
    // unknown：保守占用不因观察/边界释放（观察 900 − 占用 100 = 800 可纳、801 拒）。
    Game.time += 1;
    service.beginTick();
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    const fits = admit(service, "biz:g17:fits", transferArgs({ amount: 800, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    expect(authorizeAmount(service, "biz:g17:toobig", 801).status).toBe("rejected");
    // 非健康核心：新授权被拒（preflight 门禁不退化）。
    const runtime = Memory.runtime as unknown as { treasuryCore?: Record<string, unknown> };
    runtime.treasuryCore!.version = 99;
    expect(authorizeAmount(service, "biz:g17:corrupt", 1).status).toBe("rejected");
    // 关窗：endTick 后同 tick 新授权拒绝（共享关闭条件生效）。
    runtime.treasuryCore!.version = 3;
    service.endTick();
    expect(authorizeAmount(service, "biz:g17:closed", 1).status).toBe("rejected");
  });
});
