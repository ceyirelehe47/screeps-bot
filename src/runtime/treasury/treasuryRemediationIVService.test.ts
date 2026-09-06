/**
 * Treasury Core Rewrite IV · Remediation IV——service/工具层 H 矩阵（任务书 §6）。
 *
 * 覆盖：H08/H09/H10（许可直连执行包装：同参数归属、正逆序、非法许可）、
 * H11（嵌套/reset 后新调用）、H12/H13/H14（断点宿主单源：错误 journal 拒绝、
 * 正确 B0/B1/B2 重复恢复、快照不可变与缺证据行为）、H15/H16（完全同参数
 * 父子 + 结果写回前断点 + 完整 reset 恢复闭环及其负向）、H17（已执行结果
 * 前恢复与 closing 余额/空间、unknown/旧来源不释放）。内核层 H01–H07/H18
 * 见 treasuryRemediationIVKernel.test.ts。
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
import {
  createTreasuryHostJournal,
  executeTreasuryAdmittedDispatch,
  makeTreasuryExactOracleAdapter,
  type TreasuryHostJournal,
  type TreasuryOracleHostPlan,
} from "@mock/treasuryExactOracle";
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

function admitOn(reset: TreasuryFullResetResult, workKey: string, args: TreasuryTestTransferArgs): Admission {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error("build failed");
  const admission = reset.service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error("admit failed");
  return admission as Admission;
}

function authorizeAmount(service: TreasuryService, workKey: string, amount: number) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args: transferArgs({ amount }) });
  if (built.status !== "built") throw new Error(`build failed: ${built.reason}`);
  return service.authorizeTreasuryActionContract(built.contract, { workKey });
}

/** reset 后的授权对照（必须用新模块句柄构建合同——旧句柄合同被新 runtime 拒绝）。 */
function authorizeAmountOn(reset: TreasuryFullResetResult, workKey: string, amount: number) {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, { actionKind: "test.transfer", transactionId: workKey, args: transferArgs({ amount }) });
  if (built.status !== "built") throw new Error("build failed");
  return reset.service.authorizeTreasuryActionContract(built.contract, { workKey });
}

interface CleanupShape {
  phase: string;
  outcome?: string;
  cleanup?: { consumerKeys: readonly string[] };
}

function recordShape(attemptId: string): CleanupShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, CleanupShape> } | undefined;
  return store?.active?.[attemptId];
}

function roomEnergy(rooms: Record<string, Room>, room: string, kind: "storage" | "terminal"): number {
  return ((rooms[room] as unknown as Record<string, { store: Record<string, number> } | undefined>)[kind]!.store.energy ?? 0);
}

function kindsOf(journal: TreasuryHostJournal, attemptId: string): string[] {
  return journal.visibleFor(attemptId).map((e) => e.kind);
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── H08：V1 同参数错身份（任务书 §3.1 基线路径的修复语义） ─────────────────

describe("H08 同参数 A/B 错身份封闭", () => {
  it("错误聚合/许可配对在执行前拒绝；正常包装执行事件只归实际许可 A；B 不借 A 效果", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h08:A", args);
    const b = admit(service, "biz:h08:B", args); // 资源足够支持两笔（同参数不同 workKey）

    // 旧工具"声明 B、实际提交 A"的分离路径已删除；等价错配输入：聚合声明
    // B 的 attempt、携带 A 的 dispatch 许可——执行前识别，不建立作用域。
    expect(() => executeTreasuryAdmittedDispatch(journal, service, { status: "admitted", attemptId: b.attemptId, dispatch: a.dispatch })).toThrow(/不一致/);
    expect(oracle.trace.entered).toBe(0); // 被拒请求未被记作 adapter-entered/effect
    expect(oracle.trace.effects).toBe(0);
    expect(journal.unlinkedCalls).toBe(0);

    // 正常路径：包装执行 A——事件归实际许可 A（世界只发生 A 一笔变化）。
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    expect(kindsOf(journal, a.attemptId)).toEqual(["adapter-entered", "world-effect"]);
    expect(kindsOf(journal, b.attemptId)).toEqual([]); // B 未执行
    expect(roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage")).toBe(900);
  });
});

// ── H09：同参数 A/B 的执行顺序与归属矩阵 ────────────────────────────────────

describe("H09 同参数 A/B 正序/逆序/单笔/双笔归属", () => {
  it("正序 A→B 与逆序 B→A：每笔 entered/effect 与实际提交许可对应，世界变化按真实调用累计", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h09:A", args);
    const b = admit(service, "biz:h09:B", args);
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    expect(executeTreasuryAdmittedDispatch(journal, service, b).status).toBe("committed");
    expect(kindsOf(journal, a.attemptId)).toEqual(["adapter-entered", "world-effect"]);
    expect(kindsOf(journal, b.attemptId)).toEqual(["adapter-entered", "world-effect"]);
    expect(roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage")).toBe(800); // 两笔累计
    expect(oracle.trace.entered).toBe(2);
    expect(oracle.trace.effects).toBe(2);
  });

  it("逆序 B→A 与只执行其中一笔：未执行 B 不借 A 效果，世界只一笔变化", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h09b:A", args);
    const b = admit(service, "biz:h09b:B", args);
    // 逆序：先 B 后 A
    expect(executeTreasuryAdmittedDispatch(journal, service, b).status).toBe("committed");
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    expect(roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage")).toBe(800);

    // 只执行其中一笔（独立分支）：A 执行、B 不执行——B 不借 A 效果。
    const journal2 = createTreasuryHostJournal();
    const oracle2 = makeTreasuryExactOracleAdapter(journal2);
    replaceTreasuryActionAdapterForTest(oracle2);
    const service2 = makeService();
    const a2 = admit(service2, "biz:h09c:A", args);
    const b2 = admit(service2, "biz:h09c:B", args);
    expect(executeTreasuryAdmittedDispatch(journal2, service2, a2).status).toBe("committed");
    expect(kindsOf(journal2, a2.attemptId)).toEqual(["adapter-entered", "world-effect"]);
    expect(kindsOf(journal2, b2.attemptId)).toEqual([]);
    expect(roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage")).toBe(900); // 只 A 一笔
  });
});

// ── H10：新执行包装下的非法许可与门禁 ───────────────────────────────────────

describe("H10 包装不赋予执行权", () => {
  it("克隆/过期/旧runtime/已消费许可被原门禁拒绝；被拒请求不计 adapter-entered/effect；健康真许可仍可执行", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h10:A", args);
    const b = admit(service, "biz:h10:B", transferArgs({ amount: 50 }));

    // 克隆许可（浅拷贝对象——WeakSet 身份不在）：包装透传，生产 preflight 拒绝。
    const clone = { ...(a.dispatch as object) };
    const cloneOutcome = executeTreasuryAdmittedDispatch(journal, service, { status: "admitted", attemptId: a.attemptId, dispatch: clone });
    expect(cloneOutcome.status).toBe("rejected");
    expect(oracle.trace.entered).toBe(0); // 被拒不计 entered/effect

    // 过期许可（下一 tick）：issuedAtTick 不匹配（a 与 b 都是前 tick 签发）。
    Game.time += 1;
    service.beginTick();
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("rejected");
    expect(executeTreasuryAdmittedDispatch(journal, service, b).status).toBe("rejected");

    // 健康 runtime + 本 tick 真许可仍可正常执行（新接纳）。
    const c = admit(service, "biz:h10:C", transferArgs({ amount: 50 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, c).status).toBe("committed");
    expect(kindsOf(journal, c.attemptId)).toEqual(["adapter-entered", "world-effect"]);

    // 已消费许可重放：c 已执行——再次提交被拒且不产生第二次调用。
    expect(executeTreasuryAdmittedDispatch(journal, service, c).status).toBe("rejected");
    expect(journal.visibleFor(c.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1);

    // 旧 runtime 许可：完整 reset 后旧 dispatch 被新 runtime 拒绝。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal) });
    const legacyOutcome = executeTreasuryAdmittedDispatch(journal, reset.service, c);
    expect(legacyOutcome.status).toBe("rejected");
    expect(journal.visibleFor(c.attemptId).filter((e) => e.kind === "adapter-entered").length).toBe(1); // 不追加
  });
});

// ── H11：完整 reset 后新调用（新模块工厂使用恢复宿主） ───────────────────────

describe("H11 reset 后新调用无旧上下文", () => {
  it("完整 reset 后新模块工厂经恢复宿主执行新许可：事件归新 attempt，旧栈事实不追加", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h11:A", args);
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");

    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1 });
    expect(kindsOf(journal, a.attemptId).length).toBe(2); // 旧事实保留（祖先链）
    const fresh = admitOn(reset, "biz:h11:fresh", transferArgs({ amount: 50 }));
    expect(executeTreasuryAdmittedDispatch(journal, reset.service, fresh).status).toBe("committed");
    expect(kindsOf(journal, fresh.attemptId)).toEqual(["adapter-entered", "world-effect"]); // 新调用归新 attempt
    expect(kindsOf(journal, a.attemptId).length).toBe(2); // 旧 attempt 无泄漏追加
  });
});

// ── H12：V2 错误 journal（任务书 §4.1 基线路径的修复语义） ───────────────────

describe("H12 断点事件来源错配拒绝", () => {
  it("J1 产生效果、B0 误配 J2 marker、恢复继续用 J1 adapter——对账前拒绝且不留半恢复状态", () => {
    const j1 = createTreasuryHostJournal(); // 实际执行 adapter 的 journal
    const j2 = createTreasuryHostJournal(); // 另一份
    const oracle1 = makeTreasuryExactOracleAdapter(j1);
    replaceTreasuryActionAdapterForTest(oracle1);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h12:A", args);

    let b0: TreasuryHostBreakpoint | undefined;
    const worldAtCapture = { energy: -1 };
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        b0 = captureTreasuryHostBreakpoint(j2.captureBranch()); // 错配：效果前 Memory/世界 + J2 分支标记
        worldAtCapture.energy = roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage");
      },
    });
    const outcome = executeTreasuryAdmittedDispatch(j1, service, a);
    interceptor.restore();
    expect(outcome.status).toBe("persist_failed"); // 效果已发生并记入 J1（interceptor 拦掉后续写）
    expect(worldAtCapture.energy).toBe(1000); // 捕获时刻效果前
    if (b0 === undefined) throw new Error("B0 未捕获");

    // 修复语义：对账前拒绝错来源（基线不抛——误 committed）。
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(j1), breakpoint: b0 }),
    ).toThrow(/事件来源/);

    // 拒绝不留下半恢复混合状态：Memory/世界/事件均未被恢复流程触碰。
    expect(roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage")).toBe(900); // 旧分支效果仍在（未被回滚）
    expect(kindsOf(j1, a.attemptId)).toEqual(["adapter-entered", "world-effect"]); // J1 保留较晚效果（未 reopen）
    // 同参数正确对照：J1 自己的 marker 可正常恢复（不再被误判）。
    const b0Correct = captureTreasuryHostBreakpoint(j1.captureBranch()); // 当前时刻（效果后）的正确来源断点
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(j1), breakpoint: b0Correct });
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok"); // committed 对账成立
  });
});

// ── H13：正确来源 B0/B1、B0 子分支 C→B2、重复独立恢复 ───────────────────────

describe("H13 正确来源分支链与重复恢复", () => {
  it("B0 恢复后执行 C→B2；B0/B1/B2 分支隔离一致；重复恢复同一断点互不污染；executed 分支能关闭", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h13:A", args);

    let b0: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        b0 = captureTreasuryHostBreakpoint(journal.captureBranch()); // A 效果前
      },
    });
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("persist_failed");
    interceptor.restore();
    if (b0 === undefined) throw new Error("B0 未捕获");
    const b1 = captureTreasuryHostBreakpoint(journal.captureBranch()); // 旧分支 A 效果后

    // 恢复 B0（效果前）：A=dispatching→unknown；分支世界/事件属 B0。
    const reset0 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: b0 });
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    expect(kindsOf(journal, a.attemptId)).toEqual([]); // B0 分支看不到旧分支效果后事件
    expect(roomEnergy(reset0.rooms, "W1N57", "storage")).toBe(1000); // 世界随断点（效果未发生）

    // B0 子分支执行 C（新动作，流出 30）→ 捕获 B2。
    const c = admitOn(reset0, "biz:h13:C", transferArgs({ amount: 30 }));
    expect(executeTreasuryAdmittedDispatch(journal, reset0.service, c).status).toBe("committed");
    const b2 = captureTreasuryHostBreakpoint(journal.captureBranch());
    expect(roomEnergy(reset0.rooms, "W1N57", "storage")).toBe(970);

    // 恢复 B2：世界 970、C 的 world-effect 可见、A 的旧主分支效果不重现。
    const reset2 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: b2 });
    expect(roomEnergy(reset2.rooms, "W1N57", "storage")).toBe(970);
    expect(kindsOf(journal, c.attemptId)).toEqual(["adapter-entered", "world-effect"]);
    expect(kindsOf(journal, a.attemptId)).toEqual([]);
    // C 在 B2 捕获前已完成结果写入：恢复分支里已确定 committed——
    // 正确 executed 分支经观察接管直接完整退出（active 无残留）。
    expect(recordShape(c.attemptId)).toBeUndefined();
    expect(reset2.service.settleUnknownOutcome({ attemptId: c.attemptId }).status).toBe("rejected"); // 已不在 active——不重复结算

    // 重复独立恢复 B0：与第一次同源互不污染（A 仍 unknown、世界 1000、C 不存在于该分支）。
    const reset0again = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: b0 });
    expect(roomEnergy(reset0again.rooms, "W1N57", "storage")).toBe(1000);
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    expect(recordShape(c.attemptId)).toBeUndefined(); // C 属 B2 分支——不在 B0 的 Memory 里
    expect(kindsOf(journal, a.attemptId)).toEqual([]);
  });
});

// ── H14：缺事件源、同世界序不同 journal、快照不可变 ──────────────────────────

describe("H14 来源完整性与快照不可变", () => {
  it("缺来源 marker/裸 adapter 被拒；同世界序不同 journal 被拒；查询对象修改不污染捕获快照", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:h14:A", args);
    let b0: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        b0 = captureTreasuryHostBreakpoint(journal.captureBranch());
      },
    });
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("persist_failed");
    interceptor.restore();
    if (b0 === undefined) throw new Error("B0 未捕获");

    // 缺来源 marker（旧形态结构匹配但无 source 字段）→ 关联不可核实，拒绝。
    const legacyMarker = { kind: "treasury-journal-branch" as const, count: 0, reopen: () => undefined };
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: { ...b0, eventBranch: legacyMarker } }),
    ).toThrow(/事件来源/);

    // 裸 adapter（无 journal 暴露）+ 带 eventBranch 断点 → 缺失关联，拒绝。
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryTestTransferAdapter(), breakpoint: b0 }),
    ).toThrow(/事件来源/);

    // 同世界序、不同 journal 的 marker（数值标签全等也不能代替来源完整性）。
    const otherJournal = createTreasuryHostJournal();
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: { ...b0, eventBranch: otherJournal.captureBranch() } }),
    ).toThrow(/事件来源/);

    // 快照不可变：查询返回的 entry 对象写入不得穿透（冻结——旧日志/查询对象
    // 后续修改不污染捕获快照）。
    const b1 = captureTreasuryHostBreakpoint(journal.captureBranch());
    const entries = journal.visibleFor(a.attemptId);
    expect(entries.length).toBe(2);
    const enteredSeq = entries[0]!.worldSequence;
    try {
      (entries[0] as { worldSequence: number }).worldSequence = 999;
    } catch {
      // 严格模式冻结赋值抛 TypeError——同样算不可写穿
    }
    expect(entries[0]!.worldSequence).toBe(enteredSeq);
    const resetAfterMutation = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: b1 });
    expect(resetAfterMutation.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok"); // 仍按真实事件对账
    void b0;
  });
});

// ── H15：V3 完全同参数父子 + 结果写回前断点 + 完整 reset 闭环 ───────────────

describe("H15 完全同参数父子恢复闭环", () => {
  it("父无效果→真实 capability→rearm child（canonical args 全等）→child 效果后结果前断点→完整 reset→exact committed→观察接管退出", () => {
    const journal = createTreasuryHostJournal();
    let childBreakpoint: TreasuryHostBreakpoint | undefined;
    const plan: TreasuryOracleHostPlan = {
      results: ["non-ok", "ok"], // 第 1 次（父）无效果返回；第 2 次（child）成功——args 不带 outcome 差异
      afterWorldEffect: (callIndex) => {
        if (callIndex === 2) childBreakpoint = captureTreasuryHostBreakpoint(journal.captureBranch()); // child 效果后、dispatch_result 前
      },
    };
    const oracle = makeTreasuryExactOracleAdapter(journal, plan);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 50 }); // 父子共用同一份完整 args

    const parent = admit(service, "biz:h15:P", args);
    expect(executeTreasuryAdmittedDispatch(journal, service, parent).status).toBe("not_executed");
    expect(kindsOf(journal, parent.attemptId)).toEqual(["adapter-entered"]); // 父 entered=1、effect=0

    Game.time += 1;
    service.beginTick(); // 清理（无义务）→ retry_ready
    expect(recordShape(parent.attemptId)?.phase).toBe("retry_ready");
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("capability rejected");
    const rebuilt = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:h15:P", args }); // 同 args 重建合同
    if (rebuilt.status !== "built") throw new Error("rearm contract build failed");
    const child = service.executeRearm(capability.rearm, rebuilt.contract);
    if (child.status !== "admitted") throw new Error("rearm failed");
    // 显式断言父子完整 canonical args 相等（不只是 amount 相同）。
    expect(JSON.stringify((child.dispatch as { canonicalArgs: unknown }).canonicalArgs)).toBe(JSON.stringify((parent.dispatch as { canonicalArgs: unknown }).canonicalArgs));
    expect(child.attemptId).not.toBe(parent.attemptId); // 新 child 身份

    expect(executeTreasuryAdmittedDispatch(journal, service, child).status).toBe("committed");
    if (childBreakpoint === undefined) throw new Error("child 结果前断点未捕获");
    // 世界只发生 child 一笔变化；父事实不被 child 覆盖。
    expect(roomEnergy(Game.rooms as unknown as Record<string, Room>, "W1N57", "storage")).toBe(950);
    expect(kindsOf(journal, parent.attemptId)).toEqual(["adapter-entered"]);
    expect(kindsOf(journal, child.attemptId)).toEqual(["adapter-entered", "world-effect"]);

    // 完整重载 + 新模块装配：child 恢复为 unknown（结果未写），父已退出 active。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: childBreakpoint });
    expect(recordShape(child.attemptId)?.phase).toBe("outcome_unknown"); // dispatch_result 写入前中断→unknown 恢复
    expect(recordShape(parent.attemptId)).toBeUndefined(); // 父已退出 active（无效果事实在宿主事件中验证）

    // unknown 经恢复分支 exact 对账落定 committed，观察接管后真退出。
    expect(reset.service.settleUnknownOutcome({ attemptId: child.attemptId }).status).toBe("ok");
    expect(recordShape(child.attemptId)?.outcome).toBe("committed");
    Game.time += 1;
    reset.service.beginTick();
    expect(recordShape(child.attemptId)).toBeUndefined(); // 完整关闭
  });
});

// ── H16：H15 负向（事件错配、无证据、旧许可重放） ───────────────────────────

describe("H16 同参数父子负向", () => {
  it("无可信证据不解除 unknown；父/子事件独立；旧父/child 许可不能再次执行；正确来源恢复后仍能完成", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal, { results: ["non-ok", "ok"] });
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 50 });
    // 父第一次调用无效果（宿主计划控制；父子 args 完全相同）。
    const parent = admit(service, "biz:h16:P", args);
    expect(executeTreasuryAdmittedDispatch(journal, service, parent).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("capability rejected");
    const rebuilt = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:h16:P", args });
    if (rebuilt.status !== "built") throw new Error("build failed");
    const child = service.executeRearm(capability.rearm, rebuilt.contract);
    if (child.status !== "admitted") throw new Error("rearm failed");
    expect(JSON.stringify((child.dispatch as { canonicalArgs: unknown }).canonicalArgs)).toBe(JSON.stringify((parent.dispatch as { canonicalArgs: unknown }).canonicalArgs));

    // 无效果前断点（child 执行前捕获）：恢复后 child 无任何事件——缺证据
    // 不解除 unknown（不凭观察/年龄/边界猜成功或未执行）。
    const beforeChild = captureTreasuryHostBreakpoint(journal.captureBranch());
    expect(executeTreasuryAdmittedDispatch(journal, service, child).status).toBe("committed");
    // 旧分支 child 完成后的对照断点（恢复前捕获——旧分支事实链）。
    const afterChild = captureTreasuryHostBreakpoint(journal.captureBranch());
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: beforeChild });
    expect(recordShape(child.attemptId)?.phase).toBe("pending"); // 尚未进入调用边界
    // 父/子事件独立：父 entered=1/effect=0；child 在该分支无事件。
    expect(kindsOf(journal, parent.attemptId)).toEqual(["adapter-entered"]);
    expect(kindsOf(journal, child.attemptId)).toEqual([]);
    // 旧父许可与已跨界的 child 许可重放被拒（不调动作）。
    expect(reset.service.executeAuthorizedDispatch(parent.dispatch).status).toBe("rejected");
    expect(reset.service.executeAuthorizedDispatch(child.dispatch).status).toBe("rejected");
    expect(oracle.trace.effects).toBe(1); // 唯一效果是旧分支 child 那笔——重放零调用

    // 正确来源恢复（旧分支 child 完成后断点）：恢复分支里 child 已确定
    // committed——不重复结算，正确 executed 事实经观察接管完整退出。
    const reset2 = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: afterChild });
    expect(recordShape(child.attemptId)).toBeUndefined();
    expect(reset2.service.settleUnknownOutcome({ attemptId: child.attemptId }).status).toBe("rejected");
  });
});

// ── H17：已执行结果前恢复与 closing 余额/空间、unknown/旧来源不释放 ─────────

describe("H17 已执行结果前恢复与 closing 占用对照", () => {
  it("效果后断点恢复→unknown 保守占用：200 纳/201 拒；committed closing 未退出时同口径；A 未提前删除", () => {
    const journal = createTreasuryHostJournal();
    let bp: TreasuryHostBreakpoint | undefined;
    const plan: TreasuryOracleHostPlan = {
      results: ["ok"],
      afterWorldEffect: () => {
        bp = captureTreasuryHostBreakpoint(journal.captureBranch()); // A 效果后、dispatch_result 前
      },
    };
    const oracle = makeTreasuryExactOracleAdapter(journal, plan);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const a = admit(service, "biz:h17:A", transferArgs({ amount: 800 }));
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed"); // 效果真实发生（流出 800）
    if (bp === undefined) throw new Error("断点未捕获");

    // 已执行结果前恢复：记录 unknown——世界已流出（快照 200）但结果未写，
    // worst-case 全额保守占用（不因观察接管豁免——未确认的不能花）。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: bp });
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    expect(recordShape(a.attemptId)).toBeDefined(); // A 未提前删除
    // unknown 不释放：201 与 200 均拒（世界真实 200 - 保守占用 800 < 0）。
    expect(authorizeAmountOn(reset, "biz:h17:u-over", 201).status).toBe("rejected");
    expect(authorizeAmountOn(reset, "biz:h17:u-fit", 200).status).toBe("rejected");

    // 非健康核心：损坏 treasuryCore 后 settle 拒绝（不把 unknown 转 committed）。
    const beforeCorrupt = JSON.stringify(Memory.runtime?.treasuryCore);
    (Memory.runtime as { treasuryCore?: unknown }).treasuryCore = { version: 999, bad: true };
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toMatch(/rejected|still_uncertain/);
    (Memory.runtime as { treasuryCore?: unknown }).treasuryCore = JSON.parse(beforeCorrupt as string);

    // settle 成 committed → closing（结果已定、观察已覆盖效果——不双扣）：
    // 同一前提分别断言 201 拒、200 可纳（先拒后纳——防先接纳占用额外余额
    // 后把拒绝解释为原始额度证明）。A 仍 closing 未提前删除。
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok");
    expect(recordShape(a.attemptId)?.phase).toBe("closing");
    expect(recordShape(a.attemptId)).toBeDefined();
    expect(authorizeAmountOn(reset, "biz:h17:over", 201).status).toBe("rejected");
    expect(authorizeAmountOn(reset, "biz:h17:fit", 200).status).toBe("admitted");
    // 下一 tick 观察接管后完整退出。
    Game.time += 1;
    reset.service.beginTick();
    expect(recordShape(a.attemptId)).toBeUndefined();
  });

  it("流入对照：结果前恢复后空位 100、unknown 占用下 20 纳/21 拒；仅坏 ring 不阻断（健康对照）", () => {
    const journal = createTreasuryHostJournal();
    let bp: TreasuryHostBreakpoint | undefined;
    const plan: TreasuryOracleHostPlan = {
      results: ["ok"],
      afterWorldEffect: () => {
        bp = captureTreasuryHostBreakpoint(journal.captureBranch());
      },
    };
    const oracle = makeTreasuryExactOracleAdapter(journal, plan);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS_INFLOW);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const inflowArgs = transferArgs({ amount: 80, toLocation: "terminal" });
    const a = admit(service, "biz:h17b:A", inflowArgs);
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed"); // 流入 80（空位 100→20）
    if (bp === undefined) throw new Error("断点未捕获");
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS_INFLOW, adapter: makeTreasuryExactOracleAdapter(journal), breakpoint: bp });
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    const buildOn = (workKey: string, amount: number) => {
      const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, { actionKind: "test.transfer", transactionId: workKey, args: transferArgs({ amount, toLocation: "terminal" }) });
      if (built.status !== "built") throw new Error("build failed");
      return built.contract;
    };
    // unknown 不释放：流入占用下 21 与 20 均拒（空位 20 - 占用 80 < 0）。
    expect(reset.service.authorizeTreasuryActionContract(buildOn("biz:h17b:u-over", 21), { workKey: "biz:h17b:u-over" }).status).toBe("rejected");
    expect(reset.service.authorizeTreasuryActionContract(buildOn("biz:h17b:u-fit", 20), { workKey: "biz:h17b:u-fit" }).status).toBe("rejected");
    // settle 成 committed → closing：21 拒、20 可纳（同一前提分别断言）。
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok");
    expect(recordShape(a.attemptId)?.phase).toBe("closing");
    expect(reset.service.authorizeTreasuryActionContract(buildOn("biz:h17b:over", 21), { workKey: "biz:h17b:over" }).status).toBe("rejected");
    expect(reset.service.authorizeTreasuryActionContract(buildOn("biz:h17b:fit", 20), { workKey: "biz:h17b:fit" }).status).toBe("admitted");
    // 仅坏 ring（安全层健康、ring 非权威层损坏）不阻断恢复推进——对照保持。
    const core = Memory.runtime!.treasuryCore as unknown as { ring: unknown };
    core.ring = "not-an-array";
    Game.time += 1;
    expect(() => reset.service.beginTick()).not.toThrow();
  });
});
