/**
 * Treasury Core Rewrite IV · Remediation V——service/工具层 I 矩阵（任务书 §5）。
 *
 * V1 来源必备的行为验收：I07（B0 无 eventBranch + 旧栈效果进入 J + 用 J 做
 * exact 恢复——修复后在恢复任何修改前拒绝）、I08（显式旧 memorySnapshot +
 * oracle / 普通数组事件通道拒绝；合法低层 kernel 恢复仍可用且不宣称
 * exact）、I09（正确来源空 B0 / 效果后 B1 / B0 子分支 C→B2 / 错 J 对照——
 * 空分支 ≠ 缺分支、废弃分支事实不重现）、I10（正常当前世界 reset 与完整
 * 同参数父子恢复继续工作——新校验不封死正常路径）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionAdapter,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import {
  captureTreasuryHostBreakpoint,
  performTreasuryFullReset,
  performTreasuryKernelFullReset,
  snapshotWholeMemory,
  type TreasuryFullResetResult,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
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

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
  return { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 100, outcome: "ok", ...overrides };
}

function makeOracleService(journal: TreasuryHostJournal, adapterOverride?: TreasuryActionAdapter): TreasuryService {
  const installed = installRooms(ROOMS);
  replaceTreasuryActionAdapterForTest(adapterOverride ?? makeTreasuryExactOracleAdapter(journal));
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

function admitOracle(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs): { status: "admitted"; attemptId: string; dispatch: unknown } {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission;
}

/** 包装 oracle：在 adapter 进入点（dispatch_start 已发布、效果未发生）捕获断点（捕获方式由参数决定）。 */
function wrapWithEntryCapture(
  journal: TreasuryHostJournal,
  capture: () => TreasuryHostBreakpoint,
  holder: { breakpoint?: TreasuryHostBreakpoint },
): TreasuryActionAdapter {
  const oracle = makeTreasuryExactOracleAdapter(journal);
  return {
    ...oracle,
    execute(args: unknown): { ok: boolean } {
      if (holder.breakpoint === undefined) holder.breakpoint = capture();
      return oracle.execute(args as Parameters<typeof oracle.execute>[0]);
    },
  } as unknown as TreasuryActionAdapter;
}

function recordShape(attemptId: string): { phase: string; outcome?: string } | undefined {
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

// ── I07：缺事件分支不能绕过 exact 恢复来源校验 ─────────────────────────────

describe("I07 缺 eventBranch 的 exact 恢复拒绝", () => {
  it("基线错结论路径已封闭：恢复在任何修改前拒绝、零修改、当前运行时仍可用", () => {
    // 旧栈：B0 于 dispatch_start 捕获（**不传事件分支**）；A 继续执行
    //（世界 1000→900，J 新增 A 的 entered/effect）。
    const journal = createTreasuryHostJournal();
    const holder: { breakpoint?: TreasuryHostBreakpoint } = {};
    const service = makeOracleService(journal, wrapWithEntryCapture(journal, () => captureTreasuryHostBreakpoint(), holder));
    const a = admitOracle(service, "biz:v5:A", transferArgs({ amount: 100 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    if (holder.breakpoint === undefined) throw new Error("B0 未捕获");
    expect(holder.breakpoint.eventBranch).toBeUndefined(); // 缺事件分支——I07 场景
    expect(roomEnergy("W1N57", "storage")).toBe(900); // 旧栈效果已发生
    expect(journal.visibleFor(a.attemptId).map((e) => e.kind)).toEqual(["adapter-entered", "world-effect"]);
    const memoryBefore = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
    const worldBefore = JSON.stringify((globalThis as unknown as { Game: { rooms: unknown } }).Game.rooms);
    const eventsBefore = JSON.stringify(journal.visibleFor(a.attemptId));
    const tickBefore = Game.time;
    // 修复后：恢复任何修改前拒绝（"世界 1000 + J 含后来 effect"的组合不可保留）。
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: holder.breakpoint }),
    ).toThrow(/事件分支/);
    // 拒绝时零修改：Memory/世界/事件/tick 均不变（不留半恢复状态）。
    expect(JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory)).toBe(memoryBefore);
    expect(JSON.stringify((globalThis as unknown as { Game: { rooms: unknown } }).Game.rooms)).toBe(worldBefore);
    expect(JSON.stringify(journal.visibleFor(a.attemptId))).toBe(eventsBefore);
    expect(Game.time).toBe(tickBefore);
    expect(roomEnergy("W1N57", "storage")).toBe(900); // 当前运行时仍可正常使用
  });

  it("正确对照：携带 eventBranch 的同一断点恢复正常（空分支按可信宿主事实判未执行）", () => {
    const journal = createTreasuryHostJournal();
    const holder: { breakpoint?: TreasuryHostBreakpoint } = {};
    const service = makeOracleService(journal, wrapWithEntryCapture(journal, () => captureTreasuryHostBreakpoint(journal.captureBranch()), holder));
    const a = admitOracle(service, "biz:v5:A2", transferArgs({ amount: 100 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    if (holder.breakpoint === undefined) throw new Error("B0 未捕获");
    // 携带分支恢复：世界回 1000、J 截断至断点、settle 按截断后事实判 not_executed。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: holder.breakpoint });
    expect(roomEnergy("W1N57", "storage")).toBe(1000);
    expect(journal.visibleFor(a.attemptId)).toEqual([]); // 断点后事件不进入恢复分支
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok");
    expect(recordShape(a.attemptId)?.outcome).toBe("not_executed"); // 空分支 + 边界事实 → 未执行
  });
});

// ── I08：显式旧 memorySnapshot + oracle、普通数组事件通道 ───────────────────

describe("I08 裸快照与普通数组通道拒绝", () => {
  it("显式旧 memorySnapshot + 事件 oracle：拒绝（无世界/事件配对不承担 exact）", () => {
    const journal = createTreasuryHostJournal();
    const service = makeOracleService(journal, makeTreasuryExactOracleAdapter(journal));
    const a = admitOracle(service, "biz:v5:A8", transferArgs({ amount: 100 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    const snapshot = snapshotWholeMemory();
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), memorySnapshot: snapshot }),
    ).toThrow(/memorySnapshot.*配对|配对.*memorySnapshot/);
  });

  it("普通数组事件断点 + oracle：拒绝；非 oracle adapter（无事件来源可错配）不受限", () => {
    const journal = createTreasuryHostJournal();
    const holder: { breakpoint?: TreasuryHostBreakpoint } = {};
    const service = makeOracleService(journal, wrapWithEntryCapture(journal, () => captureTreasuryHostBreakpoint([] as readonly unknown[]), holder));
    const a = admitOracle(service, "biz:v5:A8b", transferArgs({ amount: 100 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    if (holder.breakpoint === undefined) throw new Error("plain bp 未捕获");
    expect(holder.breakpoint.eventBranch).toBeUndefined(); // 普通数组只记录长度，无事件分支
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: holder.breakpoint }),
    ).toThrow(/事件分支/);
    // 非 oracle adapter + 同一裸断点：service 非精确恢复，不受事件来源限制。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryTestTransferAdapter(), breakpoint: holder.breakpoint });
    expect(reset.service).toBeDefined();
  });

  it("合法低层 kernel 恢复仍可用（memorySnapshot + kernel 面不拒）且不宣称 exact", () => {
    const journal = createTreasuryHostJournal();
    const service = makeOracleService(journal, makeTreasuryExactOracleAdapter(journal));
    const a = admitOracle(service, "biz:v5:A8c", transferArgs({ amount: 100 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    const snapshot = snapshotWholeMemory();
    // kernel 面：裸 Memory 安装仍可用（纯预算/调度恢复——无事件来源，不宣称 exact）。
    const reset = performTreasuryKernelFullReset({
      ports: {
        nowTick: () => Game.time,
        runtimeGeneration: () => 1,
        findAdapter: (kind) => ({ kind, version: 1, registrationId: `reg-${kind}`, semanticIdentity: `d.${kind}`, execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }),
        checkAdmissionCapacity: () => null,
      },
      memorySnapshot: snapshot,
      roomSpecs: [],
    });
    expect(reset.kernel.health().status).toBe("healthy"); // kernel 恢复正常可用
    expect(recordShape(a.attemptId)?.phase).toBe("closing"); // 已完成状态随快照恢复（kernel 面不做事件对账）
  });
});

// ── I09：正确来源空 B0 / 效果后 B1 / B0 子分支 C→B2 / 错 J 对照 ────────────

describe("I09 事件分支语义矩阵", () => {
  it("有来源的空 B0 ≠ 缺来源（判未执行）；效果后 B1 对账 committed；B0 子分支 C→B2 废弃事实不重现；错 J 拒绝", () => {
    // ── a) 有来源的空 B0：A 恢复后不可见任何事件 → not_executed ──
    const journal = createTreasuryHostJournal();
    const holderA: { breakpoint?: TreasuryHostBreakpoint } = {};
    const serviceA = makeOracleService(journal, wrapWithEntryCapture(journal, () => captureTreasuryHostBreakpoint(journal.captureBranch()), holderA));
    const a0 = admitOracle(serviceA, "biz:v5:a0", transferArgs({ amount: 30 }));
    expect(executeTreasuryAdmittedDispatch(journal, serviceA, a0).status).toBe("committed");
    if (holderA.breakpoint === undefined) throw new Error("b0Empty 未捕获");
    expect(holderA.breakpoint.eventCut).toBe(0); // 有来源的空事件快照（≠ 没有事件来源）
    const reset0 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: holderA.breakpoint });
    expect(journal.visibleFor(a0.attemptId)).toEqual([]); // 断点后旧栈事件不进入恢复分支
    expect(reset0.service.settleUnknownOutcome({ attemptId: a0.attemptId }).status).toBe("ok");
    expect(recordShape(a0.attemptId)?.outcome).toBe("not_executed"); // 空分支 + 边界事实 → 未执行

    // ── b) 效果后 B1（H15 同型捕获点）：恢复后 exact 对账 committed ──
    const journal1 = createTreasuryHostJournal();
    let b1: TreasuryHostBreakpoint | undefined;
    const oracle1 = makeTreasuryExactOracleAdapter(journal1, {
      results: ["ok"],
      afterWorldEffect: (i) => { if (i === 1) b1 = captureTreasuryHostBreakpoint(journal1.captureBranch()); },
    });
    const service1 = makeOracleService(journal1, oracle1);
    const a1 = admitOracle(service1, "biz:v5:a1", transferArgs({ amount: 40 }));
    expect(executeTreasuryAdmittedDispatch(journal1, service1, a1).status).toBe("committed");
    if (b1 === undefined) throw new Error("B1 未捕获");
    const reset1 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal1), breakpoint: b1 });
    expect(recordShape(a1.attemptId)?.phase).toBe("outcome_unknown"); // dispatch_result 写入前中断
    expect(reset1.service.settleUnknownOutcome({ attemptId: a1.attemptId }).status).toBe("ok");
    expect(recordShape(a1.attemptId)?.outcome).toBe("committed"); // 效果后断点 → exact committed

    // ── c) B0 子分支 C→B2：恢复 B0 后执行 C（新 attempt），效果后捕获 B2；
    //    恢复 B2 时 C 真实效果对账 committed，B0 原分支的废弃效果不重现 ──
    const journal2 = createTreasuryHostJournal();
    const holder2: { breakpoint?: TreasuryHostBreakpoint } = {};
    const service2 = makeOracleService(journal2, wrapWithEntryCapture(journal2, () => captureTreasuryHostBreakpoint(journal2.captureBranch()), holder2));
    const a2 = admitOracle(service2, "biz:v5:a2", transferArgs({ amount: 50 })); // 旧栈 A（效果发生）
    expect(executeTreasuryAdmittedDispatch(journal2, service2, a2).status).toBe("committed");
    if (holder2.breakpoint === undefined) throw new Error("b0Anchor 未捕获");
    const reset2 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal2), breakpoint: holder2.breakpoint });
    expect(journal2.visibleFor(a2.attemptId)).toEqual([]); // B0 分支不见旧栈 A 事件
    // A 在 B0 分支内 settle（尚无本分支世界推进——边界事实可信）：不可见事件
    // + 边界序 ≥ 当前序 → not_executed（不借废弃分支的 effect）。
    expect(reset2.service.settleUnknownOutcome({ attemptId: a2.attemptId }).status).toBe("ok");
    expect(recordShape(a2.attemptId)?.outcome).toBe("not_executed");
    // 恢复分支内执行 C，效果后、结果写回前捕获 B2。
    let b2: TreasuryHostBreakpoint | undefined;
    const oracleC = makeTreasuryExactOracleAdapter(journal2, {
      afterWorldEffect: (i) => { if (i === 1) b2 = captureTreasuryHostBreakpoint(journal2.captureBranch()); },
    });
    reset2.handles.actionContractsModule.replaceTreasuryActionAdapterForTest(oracleC);
    const builtC = reset2.handles.actionContractsModule.buildTreasuryActionContract(reset2.service, { actionKind: "test.transfer", transactionId: "biz:v5:c", args: transferArgs({ amount: 20 }) });
    if (builtC.status !== "built") throw new Error("build C failed");
    const admC = reset2.service.authorizeTreasuryActionContract(builtC.contract, { workKey: "biz:v5:c" });
    if (admC.status !== "admitted") throw new Error("admit C failed");
    expect(executeTreasuryAdmittedDispatch(journal2, reset2.service, admC).status).toBe("committed");
    if (b2 === undefined) throw new Error("B2 未捕获");
    // 恢复 B2：C committed（B0 子分支的真实效果）；A 保守保留（not_executed →
    // closing/retry_ready 有界收尾，不因 B2 重现废弃效果）。
    const reset3 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal2), breakpoint: b2 });
    expect(recordShape(admC.attemptId)?.phase).toBe("outcome_unknown");
    expect(reset3.service.settleUnknownOutcome({ attemptId: admC.attemptId }).status).toBe("ok");
    expect(recordShape(admC.attemptId)?.outcome).toBe("committed");
    const a2Shape = recordShape(a2.attemptId);
    expect(a2Shape === undefined || a2Shape.phase === "closing" || a2Shape.phase === "retry_ready").toBe(true); // 有界保留（不重现为 committed）
    if (a2Shape !== undefined) expect(a2Shape.outcome).toBe("not_executed");

    // ── d) 错 J 对照：J2 捕获的分支 + J1 恢复 → 来源不一致拒绝 ──
    const j1 = createTreasuryHostJournal();
    const j2 = createTreasuryHostJournal();
    const bpWrong = captureTreasuryHostBreakpoint(j2.captureBranch());
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(j1), breakpoint: bpWrong }),
    ).toThrow(/不是同一 journal/);
  });
});

// ── I10：正常当前世界 reset 与完整同参数父子恢复不封死 ──────────────────────

describe("I10 正常路径保留", () => {
  it("无断点『继续当前世界』reset（oracle 通道）正常工作、世界效果与 journal 一致续用、新业务可接纳", () => {
    const journal = createTreasuryHostJournal();
    const service = makeOracleService(journal, makeTreasuryExactOracleAdapter(journal));
    const done = admitOracle(service, "biz:v5:done", transferArgs({ amount: 70 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, done).status).toBe("committed");
    Game.time += 1;
    // 继续当前世界：入口即时快照（不传 snapshot——oracle 通道不再接受显式旧值）。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1 });
    expect(roomEnergy("W1N57", "storage")).toBe(930); // 世界效果保留
    expect(journal.visibleFor(done.attemptId).map((e) => e.kind)).toEqual(["adapter-entered", "world-effect"]); // journal 一致续用
    const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, { actionKind: "test.transfer", transactionId: "biz:v5:next", args: transferArgs({ amount: 10 }) });
    if (built.status !== "built") throw new Error("build failed");
    const admission = reset.service.authorizeTreasuryActionContract(built.contract, { workKey: "biz:v5:next" });
    expect(admission.status).toBe("admitted");
  });

  it("完整同参数父子恢复（H15 形态重跑）：父 effect0/child effect1、完整 args 相同、真实恢复/对账/退出", () => {
    const journal = createTreasuryHostJournal();
    let childBreakpoint: TreasuryHostBreakpoint | undefined;
    const plan = {
      results: ["non-ok", "ok"] as const,
      afterWorldEffect: (callIndex: number) => {
        if (callIndex === 2) childBreakpoint = captureTreasuryHostBreakpoint(journal.captureBranch());
      },
    };
    const oracle = makeTreasuryExactOracleAdapter(journal, plan);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS);
    registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const args = transferArgs({ amount: 50 });
    const parent = admitOracle(service, "biz:v5:p", args);
    expect(executeTreasuryAdmittedDispatch(journal, service, parent).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    expect(recordShape(parent.attemptId)?.phase).toBe("retry_ready");
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("capability rejected");
    const rebuilt = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:v5:p", args });
    if (rebuilt.status !== "built") throw new Error("rearm contract build failed");
    const child = service.executeRearm(capability.rearm, rebuilt.contract);
    if (child.status !== "admitted") throw new Error(`rearm failed: ${child.status === "rejected" ? child.reason : "?"}`);
    expect(JSON.stringify((child.dispatch as { canonicalArgs: unknown }).canonicalArgs)).toBe(
      JSON.stringify((parent.dispatch as { canonicalArgs: unknown }).canonicalArgs),
    ); // 父子完整 canonical args 相同
    expect(executeTreasuryAdmittedDispatch(journal, service, child).status).toBe("committed");
    if (childBreakpoint === undefined) throw new Error("child 结果前断点未捕获");
    expect(roomEnergy("W1N57", "storage")).toBe(950); // 父 effect0/child effect1
    expect(journal.visibleFor(parent.attemptId).map((e) => e.kind)).toEqual(["adapter-entered"]);
    expect(journal.visibleFor(child.attemptId).map((e) => e.kind)).toEqual(["adapter-entered", "world-effect"]);
    // 完整重载 + 新模块装配：child unknown 恢复 → exact committed → 观察接管退出。
    const reset: TreasuryFullResetResult = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryExactOracleAdapter(journal),
      breakpoint: childBreakpoint,
    });
    expect(recordShape(child.attemptId)?.phase).toBe("outcome_unknown");
    expect(recordShape(parent.attemptId)).toBeUndefined();
    expect(reset.service.settleUnknownOutcome({ attemptId: child.attemptId }).status).toBe("ok");
    expect(recordShape(child.attemptId)?.outcome).toBe("committed");
    Game.time += 1;
    reset.service.beginTick();
    expect(recordShape(child.attemptId)).toBeUndefined(); // 观察接管退出
  });
});
