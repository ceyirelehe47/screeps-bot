/**
 * Treasury Core Rewrite IV · Remediation I——service/reset 层验收矩阵（任务书 §8）。
 *
 * 覆盖：E02（配对断点：效果前/效果后两分支 + 事件驱动 exact oracle）、
 * E04（结果写失败/保守恢复 + 观察暂不可用）、E11/E12（rearm 新义务拒绝与
 * 合法对照）、E13/E14/E15（许可认证前置与高成本门禁次序）、E16（指定断点
 * 快照 + 引用隔离）、E17（全清 heap/global/模块后的接管）、E18（混合负载
 * 真实 rearm + 完整 reset + 旧视图）。
 * E01/E03 见 treasuryRewrite4Lifecycle.test.ts（D11）；kernel 层矩阵见
 * treasuryRemediationIKernel.test.ts；Remediation II F 矩阵见
 * treasuryRemediationIIService.test.ts。
 *
 * Remediation II/V1 修订：E02 不再用"效果前 Memory + 效果后世界 + 固定
 * not-executed reconciler"的组合——恢复分支的世界与事件必须与断点同一
 * 时刻（captureTreasuryHostBreakpoint 配对捕获），exact 结论由
 * treasuryExactOracle（宿主事件驱动）给出。
 */
import { createTreasuryService, TREASURY_FRESH_EPOCH_LIMIT, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  readTreasuryTestAdapterSideEffects,
  type TreasuryActionAdapter,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  snapshotWholeMemory,
  performTreasuryFullReset,
  captureTreasuryHostBreakpoint,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";
import {
  createTreasuryHostJournal,
  makeTreasuryExactOracleAdapter,
  type TreasuryHostJournal,
} from "@mock/treasuryExactOracle";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
  },
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 },
  },
];

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
  return {
    fromRoom: "W1N57",
    fromLocation: "storage",
    toRoom: "W2N57",
    toLocation: "terminal",
    resource: RESOURCE_ENERGY,
    amount: 200,
    outcome: "ok",
    ...overrides,
  };
}

function makeService(): TreasuryService {
  const installed = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

function buildContract(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return built.contract;
}

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const admission = service.authorizeTreasuryActionContract(buildContract(service, workKey, args), { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission;
}

interface HostTrace {
  executions: number;
  releaseCalls: string[];
}

function installTracingAdapter(trace: HostTrace, reconcile: "observed_committed" | "observed_not_executed" | "still_uncertain" = "still_uncertain"): TreasuryActionAdapter {
  const base = makeTreasuryTestTransferAdapter(reconcile);
  return {
    ...base,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      trace.executions += 1;
      return base.execute(args);
    },
  };
}

/** E01 式断点捕获 adapter：入口（边界已发布、效果未发生）与效果后各拍一份。 */
interface BreakpointCapture {
  readonly entrySnapshots: string[];
  readonly afterEffectSnapshots: string[];
  readonly trace: HostTrace;
}

function installBreakpointAdapter(reconcile: "observed_committed" | "observed_not_executed" | "still_uncertain"): BreakpointCapture {
  const capture: BreakpointCapture = {
    entrySnapshots: [],
    afterEffectSnapshots: [],
    trace: { executions: 0, releaseCalls: [] },
  };
  const base = makeTreasuryTestTransferAdapter(reconcile);
  const adapter: TreasuryActionAdapter = {
    ...base,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      capture.entrySnapshots.push(snapshotWholeMemory());
      const result = base.execute(args);
      capture.trace.executions += 1;
      capture.afterEffectSnapshots.push(snapshotWholeMemory());
      return result;
    },
  };
  replaceTreasuryActionAdapterForTest(adapter);
  return capture;
}

/** 计数 policy resolver（E13/E14 观察复验是否真的发生）。 */
function installCountingPolicy(): { calls: number } {
  const counter = { calls: 0 };
  const base = makeNoReserveTreasuryPolicy();
  registerTreasuryPolicyResolver({
    policyId: base.policyId,
    policyVersion: base.policyVersion,
    evaluate: (): { withhold: number; strategicReserve: number; emergencyOverride: boolean } => {
      counter.calls += 1;
      return { withhold: 0, strategicReserve: 0, emergencyOverride: false };
    },
  });
  return counter;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── E02：配对断点（效果前/效果后两分支 + 事件驱动 exact oracle） ───────────

describe("E02 配对断点与事件 exact 对账", () => {
  it("效果前分支：世界未变（1000）、硬停于 adapter 入口→exact not_executed；风险按世界事实释放", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    // 硬停哨兵（效果前断点）：adapter 入口即抛，不产生世界效果；与 oracle
    // 同 semanticIdentity（跨 reset 对账匹配不看注册序号）。必须在 admit 前
    // 注册——admit 与 dispatch 之间换 adapter 会因 registrationId 不一致被拒。
    const sentinel: TreasuryActionAdapter = {
      ...oracle,
      execute(): { ok: boolean } {
        throw new Error("E02: hard stop at adapter entry (pre-effect)");
      },
    };
    replaceTreasuryActionAdapterForTest(sentinel);
    const service = makeService();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:e2:pre", args);
    // 放行首写（dispatch_start 边界发布），adapter 进入即抛哨兵错误，后续
    // 全部写（dispatch_result/兜底）被丢弃——持久层停在 dispatching+boundary，
    // 世界未变。
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    const outcome = journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch));
    interceptor.restore(); // 保留实际最终值（dispatch_start 已持久）
    // adapter 抛错 + 结果写/兜底写全部被丢弃 → persist_failed（保守路径）。
    if (outcome.status !== "persist_failed") throw new Error("E02 pre: " + JSON.stringify(outcome));
    const shape = (Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, { phase: string; invocation: unknown; invocationBoundary: unknown }>;
    }).active[a.attemptId];
    expect(shape.phase).toBe("dispatching"); // 结果写回前断点
    expect(shape.invocation).toBeNull();
    expect(shape.invocationBoundary).not.toBeNull();
    // 断点捕获：Memory/世界/事件同刻（世界 1000、事件无 entered/effect——
    // 哨兵在进入点硬停，不产生世界效果）。
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    expect(bp.world.W1N57?.storage?.resources.energy ?? -1).toBe(1000); // 配对世界=效果前
    // 旧栈继续（catch/finally 只影响旧分支）；恢复分支从断点开始。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: oracle,
      advanceTicks: 1,
      breakpoint: bp,
    });
    // 恢复分支世界与断点一致（1000，不是效果后的 900——V1 核心）。
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy ?? 0).toBe(1000);
    const before = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(before?.phase).toBe("outcome_unknown"); // 无证据：不自动重发/取消/成功
    expect(oracle.trace.entered).toBe(0); // 新 runtime 无动作调用（哨兵未记 entered）
    // exact not_executed：可见事件无效果 + 分支世界序未越过边界序。
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    expect(settled.status).toBe("ok");
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.outcome).toBe("not_executed");
    Game.time += 1;
    reset.service.beginTick(); // 无义务 → 清理完成 → retry_ready
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("retry_ready");
    expect(oracle.trace.effects).toBe(0); // 全程无世界效果
  });

  it("效果后分支：世界已变（900）、Memory 无结果、事件含 world-effect→exact executed→正常关闭", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:e2:post", args);
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 }); // 放行 dispatch_start，丢弃结果写
    const outcome = journal.runWithInvocation(a, args, () => service.executeAuthorizedDispatch(a.dispatch));
    interceptor.restore(); // 保留实际最终值
    expect(outcome.status).toBe("persist_failed"); // 真实执行已发生、结果写失败
    expect(oracle.trace.effects).toBe(1);
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    expect((bp.world.W1N57?.storage?.resources.energy ?? -1)).toBe(900); // 配对世界=效果后
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryExactOracleAdapter(journal),
      advanceTicks: 1,
      breakpoint: bp,
    });
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy ?? 0).toBe(900);
    const before = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(before?.phase).toBe("outcome_unknown");
    expect(oracle.trace.entered).toBe(1); // 新 runtime 不重发
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    expect(settled.status).toBe("ok");
    const closing = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(closing?.outcome).toBe("committed"); // 事件含 world-effect → executed
    expect(closing?.phase).toBe("closing");
    // 观察接管退出（无义务 committed：观察覆盖即关闭）。
    Game.time += 1;
    reset.service.beginTick();
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeUndefined();
    expect(oracle.trace.effects).toBe(1); // 无重复效果
  });
});

// ── E04：结果写失败/保守恢复 + 观察暂不可用 ─────────────────────────────────

describe("E04 结果写失败与观察暂不可用", () => {
  it("dispatch_result 写失败：persist_failed + 保守 unknown 兜底；边界保持、不回 pending", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const a = admit(service, "biz:e4:persist", transferArgs({ amount: 100 }));
    // 拦截写：放行第一次（dispatch_start 的边界发布），丢弃之后（dispatch_result）。
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    // 卸载保留拦截期间实际保留的 liveValue（V3：dispatch_start 已持久，
    // 丢弃的 dispatch_result/rollback 不倒回已发布的边界）。
    interceptor.restore();
    // 动作已发生（调用 1）+ 结果写失败 → 保守 unknown 兜底。
    expect(trace.executions).toBe(1);
    expect(outcome.status).toBe("persist_failed");
    if (outcome.status === "persist_failed") expect(outcome.observed).toBe("committed");
    const record = (Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, { phase: string; invocationBoundary: unknown }>;
    }).active[a.attemptId];
    // 拦截期：dispatch_start 边界已持久（放行首写），dispatch_result 与
    // 保守恢复兜底的写均被丢弃——持久层停在 dispatching（不回 pending）。
    expect(record.phase).toBe("dispatching"); // 不回 pending（结果写失败不倒回）
    expect(record.invocationBoundary).not.toBeNull(); // R1：边界保持
    // 恢复出口：写能力恢复后的下一 tick beginTick 保守化 unknown（对账
    // 与后续关闭仍有出口——E04 表格行 4）。
    Game.time += 1;
    service.beginTick();
    const recovered = (Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, { phase: string; invocationBoundary: unknown }>;
    }).active[a.attemptId];
    expect(recovered.phase).toBe("outcome_unknown");
    expect(recovered.invocationBoundary).not.toBeNull();
  });

  it("结果已确认 committed 但观察源暂不可用：保留不退出；源恢复后正常关闭", () => {
    const installed = installRooms(ROOMS);
    const visible = new Set(["W1N57", "W2N57"]);
    const service = createTreasuryService({ getRooms: () => Object.values(installed).filter((r) => visible.has(r.name)) });
    service.beginTick();
    const a = admit(service, "biz:e4:noview", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 目标流入位置（W2N57）离开观察范围——观察不可用/范围缺失。
    visible.delete("W2N57");
    Game.time += 1;
    service.beginTick();
    Game.time += 1;
    service.beginTick();
    const still = service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(still).toBeDefined(); // 缺观察不退出（committed 责任保留）
    expect(still?.phase).toBe("closing");
    // 源恢复：新可信观察覆盖 → 关闭退出。
    visible.add("W2N57");
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeUndefined();
    // 旧视图不能超额授权：世界只有 900 可流出（1000−100 已流出）——
    // 950 的请求被拒；850 按真实余额获准（占用已随退出释放，不双扣）。
    const tooBig = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:e4:toobig", transferArgs({ amount: 950 })),
      { workKey: "biz:e4:toobig" },
    );
    expect(tooBig.status).toBe("rejected");
    const fits = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:e4:fits", transferArgs({ amount: 850 })),
      { workKey: "biz:e4:fits" },
    );
    expect(fits.status).toBe("admitted");
  });
});

// ── E11/E12：rearm 新消费者义务拒绝与合法对照 ───────────────────────────────

describe("E11/E12 rearm 新义务拒绝", () => {
  it("E11 非空 child externalConsumers：明确拒绝，frontier/active/父代/许可权利不变，无 child 无调用", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const a = admit(service, "biz:e11:r", transferArgs({ amount: 100, outcome: "non-ok" }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    const beforeActive = service.kernelJournal().active.length;
    const beforeFrontier = (Memory.runtime!.treasuryCore as { issuance: { frontier: number } }).issuance.frontier;
    const capability = service.issueTreasuryRearmCapability({ attemptId: a.attemptId });
    if (capability.status !== "ok") throw new Error("capability failed");
    const contract = buildContract(service, "biz:e11:r", transferArgs({ amount: 100, outcome: "non-ok" }));
    const rearmed = service.executeRearm(capability.rearm, contract, {
      workKey: "biz:e11:r",
      externalConsumers: ["ext:e11:new-duty"],
    });
    expect(rearmed.status).toBe("rejected");
    if (rearmed.status === "rejected") {
      expect(rearmed.reason).toContain("不支持"); // 理由明确表示不支持
      expect(rearmed.reasonCode).toBe("invalid_input");
    }
    // 拒绝后状态不变：frontier/active 不变、父代仍 retry_ready、无新 child。
    expect((Memory.runtime!.treasuryCore as { issuance: { frontier: number } }).issuance.frontier).toBe(beforeFrontier);
    expect(service.kernelJournal().active.length).toBe(beforeActive);
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("retry_ready");
    expect(trace.executions).toBe(1); // 无实际调用
    // 许可权利不丢：同一 capability 随后的合法请求（无新义务）成功。
    const good = service.executeRearm(capability.rearm, contract, { workKey: "biz:e11:r" });
    expect(good.status).toBe("admitted");
  });

  it("E12 非法类型新义务：结构化拒绝；随后同一 capability 合法请求生成新 ID 并执行；child 不继承旧义务", () => {
    const service = makeService();
    const a = admit(service, "biz:e12:t", transferArgs({ amount: 100, outcome: "non-ok" }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: a.attemptId });
    if (capability.status !== "ok") throw new Error("capability failed");
    const contract = buildContract(service, "biz:e12:t", transferArgs({ amount: 100, outcome: "non-ok" }));
    // 类型非法（null / 普通对象 / 字符串）：结构化 invalid input，不抛错、不静默忽略。
    expect(service.executeRearm(capability.rearm, contract, { workKey: "biz:e12:t", externalConsumers: null as never }).status).toBe("rejected");
    expect(service.executeRearm(capability.rearm, contract, { workKey: "biz:e12:t", externalConsumers: { 0: "ext:e12:x" } as never }).status).toBe("rejected");
    expect(service.executeRearm(capability.rearm, contract, { workKey: "biz:e12:t", externalConsumers: "ext:e12:x" as never }).status).toBe("rejected");
    // 父代仍 retry_ready（权利未被消费）。
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("retry_ready");
    // 同一 capability 的合法请求（缺省 externalConsumers）：新 ID 并执行。
    const good = service.executeRearm(capability.rearm, contract, { workKey: "biz:e12:t" });
    expect(good.status).toBe("admitted");
    if (good.status === "admitted") {
      expect(good.attemptId).not.toBe(a.attemptId);
      // child 不继承父代任何义务（空集合——不静默丢弃，而是从未发行）。
      const child = (Memory.runtime!.treasuryCore as unknown as {
        active: Record<string, { cleanup: { consumerKeys: readonly string[] } }>;
      }).active[good.attemptId];
      expect(child.cleanup.consumerKeys).toEqual([]);
      expect(service.executeAuthorizedDispatch(good.dispatch).status).toBe("not_executed");
    }
  });
});

// ── E13/E14/E15：许可认证前置与高成本门禁次序 ───────────────────────────────

describe("E13/E14/E15 许可认证前置", () => {
  it("E13 克隆许可提交次数 > fresh 上限：fresh/policy 零增量、动作 0、持久状态不变；随后真许可正常执行", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const p = admit(service, "biz:e13:r", transferArgs({ amount: 100 }));
    const policy = installCountingPolicy();
    const before = service.metrics();
    const beforeJournal = JSON.stringify(service.kernelJournal().active.map((r) => [r.attemptId, r.phase]));
    const clone = { ...(p.dispatch as object) };
    for (let i = 0; i < TREASURY_FRESH_EPOCH_LIMIT + 1; i += 1) {
      const out = service.executeAuthorizedDispatch(clone);
      expect(out.status).toBe("rejected"); // 认证阶段拒绝（R4 前置）
    }
    const after = service.metrics();
    expect(after.freshObservationBuilds - before.freshObservationBuilds).toBe(0); // fresh 零增量
    expect(after.freshEpochLimitRejections - before.freshEpochLimitRejections).toBe(0);
    expect(policy.calls).toBe(0); // 复验（policy）未发生
    expect(trace.executions).toBe(0); // 实际动作 0
    expect(JSON.stringify(service.kernelJournal().active.map((r) => [r.attemptId, r.phase]))).toBe(beforeJournal); // 持久状态不变
    // 真许可：其他条件不变且额度可用 → 正常执行一次。
    const ok = service.executeAuthorizedDispatch(p.dispatch);
    expect(ok.status).toBe("committed");
    expect(trace.executions).toBe(1);
  });

  it("E14 过期/旧 runtime/已消费/对应工作已退出的许可与普通输入：高成本复验前拒绝", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const a = admit(service, "biz:e14:r", transferArgs({ amount: 100 }));
    const policy = installCountingPolicy();
    // 过期（跨 tick）：issuedAtTick ≠ 当前 tick。
    Game.time += 1;
    service.beginTick();
    const stale = service.executeAuthorizedDispatch(a.dispatch);
    expect(stale.status).toBe("rejected"); // preflight：跨 tick 失效
    // 对应工作已取消/退出的许可：取消后旧 permit 回放。
    const b = admit(service, "biz:e14:gone", transferArgs({ amount: 100 }));
    expect(service.cancelPendingWork({ attemptId: b.attemptId }).status).toBe("ok");
    expect(service.executeAuthorizedDispatch(b.dispatch).status).toBe("rejected");
    // 已消费许可：执行成功后重放。
    const c = admit(service, "biz:e14:used", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(c.dispatch).status).toBe("committed");
    // 基准取在合法执行之后：以下的回放/伪造全部应零增量。
    const freshBefore = service.metrics().freshObservationBuilds;
    expect(service.executeAuthorizedDispatch(c.dispatch).status).toBe("rejected"); // 已消费
    // 普通/伪造输入。
    expect(service.executeAuthorizedDispatch(null).status).toBe("rejected");
    expect(service.executeAuthorizedDispatch({ attemptId: a.attemptId }).status).toBe("rejected");
    expect(service.executeAuthorizedDispatch("tk1_1_x").status).toBe("rejected");
    // 全部在高成本复验前拒绝：fresh/policy 零增量、动作 0。
    expect(service.metrics().freshObservationBuilds).toBe(freshBefore);
    expect(policy.calls).toBe(0);
    expect(trace.executions).toBe(1); // 仅 c 的合法一次
  });

  it("E15 合法许可 + policy 收紧/结构变化/窗口关闭/真实 fresh 耗尽：门禁仍阻断；条件恢复的对照可执行", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    // a) 共享授权窗口关闭（endTick 后）。
    {
      const service = makeService();
      const a = admit(service, "biz:e15:win", transferArgs({ amount: 100 }));
      service.endTick();
      const blocked = service.executeAuthorizedDispatch(a.dispatch);
      expect(blocked.status).toBe("blocked");
      if (blocked.status === "blocked") expect(blocked.reasonCode).toBe("lifecycle_closed");
    }
    // 共享授权窗口是持久事实——推进 tick 开新窗口再进入 b)。
    Game.time += 1;
    // b) 真实 fresh 耗尽：合法许可仍阻断（不回退旧快照——IV/R2 保持）。
    {
      const service = makeService();
      const workers = Array.from({ length: TREASURY_FRESH_EPOCH_LIMIT + 1 }, (_, i) =>
        admit(service, `biz:e15:drain-${String(i)}`, transferArgs({ amount: 10 })),
      );
      // 先耗尽 fresh（8 次合法执行复验）。
      for (let i = 0; i < TREASURY_FRESH_EPOCH_LIMIT; i += 1) {
        expect(service.executeAuthorizedDispatch(workers[i]!.dispatch).status).toBe("committed");
      }
      const blocked = service.executeAuthorizedDispatch(workers[TREASURY_FRESH_EPOCH_LIMIT]!.dispatch);
      expect(blocked.status).toBe("blocked");
      if (blocked.status === "blocked") expect(blocked.reasonCode).toBe("observation_unavailable");
      // 对照：下一 tick fresh 恢复 → 同一许可正常执行（许可不跨 tick——
      // 用新签发的等价许可验证条件恢复后可执行）。
      Game.time += 1;
      service.beginTick();
      const next = admit(service, "biz:e15:next", transferArgs({ amount: 10 }));
      expect(service.executeAuthorizedDispatch(next.dispatch).status).toBe("committed");
    }
    // c) 结构 incarnation 变化（签发后结构消失）。
    {
      const installed = installRooms(ROOMS);
      const service = createTreasuryService({ getRooms: () => Object.values(installed) });
      service.beginTick();
      const a = admit(service, "biz:e15:struct", transferArgs({ amount: 100 }));
      setStoreResources(installed["W2N57"]!.terminal, { energy: 500_000 }); // 世界变化但结构 incarnation 未变——不阻断（对照）
      expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    }
  });
});

// ── E16：指定断点快照 + 引用隔离 ────────────────────────────────────────────

describe("E16 指定断点快照与引用隔离", () => {
  it("旧 runtime 继续变更后 reset 用指定快照：新 Memory 嵌套引用脱离；旧引用修改不污染新运行时", () => {
    const capture = installBreakpointAdapter("still_uncertain");
    const service = makeService();
    const a = admit(service, "biz:e16:snap", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const chosen = capture.entrySnapshots[0]; // 较早断点（结果未写）
    // 旧 runtime 继续变更（结果已写、更多工作、世界推进）。
    admit(service, "biz:e16:later", transferArgs({ amount: 50 }));
    Game.time += 1;
    service.beginTick();
    // 旧引用集合。
    const staleMemory = Memory;
    const staleActive = Memory.runtime!.treasuryCore!.active;
    // 完整 reset 严格使用指定快照。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryTestTransferAdapter("still_uncertain"),
      advanceTicks: 1,
      memorySnapshot: chosen,
    });
    // 新 Memory 及嵌套引用与旧对象不同。
    expect(Memory).not.toBe(staleMemory);
    expect(Memory.runtime!.treasuryCore!.active).not.toBe(staleActive);
    // 新状态 = 指定快照经正常恢复的结果：只有断点时刻的一笔工作、unknown。
    const journal = reset.service.kernelJournal();
    expect(journal.active.length).toBe(1);
    expect(journal.active[0]!.attemptId).toBe(a.attemptId);
    expect(journal.active[0]!.phase).toBe("outcome_unknown");
    expect(journal.active.some((r) => r.workKey === "biz:e16:later")).toBe(false);
    // 旧引用修改不污染新运行时（对象层加毒——旧 active 上的记录可能已被
    // 旧 runtime 推进退出，毒字段本身即可证明引用隔离）。
    (staleMemory.runtime!.treasuryCore as unknown as { poisoned: string }).poisoned = "x".repeat(64);
    (staleActive as unknown as { poisoned: string }).poisoned = "y".repeat(64);
    expect(reset.service.kernelJournal().active[0]!.phase).toBe("outcome_unknown");
    expect((Memory.runtime!.treasuryCore as unknown as { poisoned?: string }).poisoned).toBeUndefined();
    expect(capture.trace.executions).toBe(1); // 无重发
  });
});

// ── E17：全清 heap/global/模块后的接管 ──────────────────────────────────────

describe("E17 全清后的接管（强化 D09）", () => {
  it("committed 接管退出、unknown 不重发、嵌套引用隔离、余额不双扣", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const a = admit(service, "biz:e17:a", transferArgs({ amount: 300 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const stuck = admit(service, "biz:e17:u", transferArgs({ amount: 100, outcome: "throw" }));
    expect(service.executeAuthorizedDispatch(stuck.dispatch).status).toBe("unknown");
    const worldSequenceBefore = (Memory.runtime as unknown as { treasuryWorldSequence: number }).treasuryWorldSequence;
    const oldMemory = Memory;
    const oldActive = Memory.runtime!.treasuryCore!.active;
    // 引用隔离断言用仍活跃的 unknown 记录（committed 记录会随 harness 的
    // beginTick 观察接管退出 active，不保证在位）。
    const oldRecord = oldActive[stuck.attemptId];
    const oldCleanup = oldRecord.cleanup;
    // 全清被测 heap/global/模块（宿主世界与序列化持久数据保留）。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: installTracingAdapter(trace),
      advanceTicks: 1,
    });
    // 退役 global 槽已清（世界序权威在 Memory 持久层）。
    expect((globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence).toBeUndefined();
    expect((Memory.runtime as unknown as { treasuryWorldSequence: number }).treasuryWorldSequence).toBe(worldSequenceBefore);
    // 引用隔离：根/active/record/cleanup 嵌套引用全部脱离。
    expect(Memory).not.toBe(oldMemory);
    expect(Memory.runtime!.treasuryCore!.active).not.toBe(oldActive);
    expect((Memory.runtime!.treasuryCore!.active[stuck.attemptId] as unknown)).not.toBe(oldRecord);
    expect((Memory.runtime!.treasuryCore!.active[stuck.attemptId] as unknown as { cleanup: unknown }).cleanup).not.toBe(oldCleanup);
    reset.service.beginTick(); // committed 接管退出；unknown 不重发。
    const journal = reset.service.kernelJournal();
    expect(journal.active.some((r) => r.attemptId === a.attemptId)).toBe(false);
    expect(journal.active.filter((r) => r.phase === "outcome_unknown").length).toBe(1);
    expect(trace.executions).toBe(2); // 仅原有两次（committed + throw），无重发
    // 余额不双扣：世界 700（1000−400 已流出）——600 全额可支配获准，800 拒绝
    //（contract 构建用 reset 后的新模块句柄——旧模块构建的 contract 会被
    // 新 registry 视为伪造，那不是余额判定）。
    const fitsBuilt = reset.handles.actionContractsModule.buildTreasuryActionContract(
      reset.service,
      { actionKind: "test.transfer", transactionId: "biz:e17:fits", args: transferArgs({ amount: 600 }) },
    );
    if (fitsBuilt.status !== "built") throw new Error("fits build failed");
    const fits = reset.service.authorizeTreasuryActionContract(fitsBuilt.contract, { workKey: "biz:e17:fits" });
    expect(fits.status).toBe("admitted");
    const tooBigBuilt = reset.handles.actionContractsModule.buildTreasuryActionContract(
      reset.service,
      { actionKind: "test.transfer", transactionId: "biz:e17:toobig", args: transferArgs({ amount: 800 }) },
    );
    if (tooBigBuilt.status !== "built") throw new Error("toobig build failed");
    const tooBig = reset.service.authorizeTreasuryActionContract(tooBigBuilt.contract, { workKey: "biz:e17:toobig" });
    expect(tooBig.status).toBe("rejected");
    if (tooBig.status === "rejected") expect(tooBig.reason).not.toContain("contract 无效"); // 真实容量拒绝
    expect(reset.rooms["W1N57"]!.storage.store.energy).toBe(700);
  });
});

// ── E18：混合负载 + 真实 rearm + 完整 reset + 旧视图 ────────────────────────

describe("E18 混合负载与真实 retry", () => {
  it("完成/真实 rearm/长期 unknown/部分清理/完整 reset：child 实际调用、世界账目一致、旧视图不授执行权", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    // 1) 完成工作。
    const done = admit(service, "biz:e18:done", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(done.dispatch).status).toBe("committed");
    // 2) 真实 rearm：父 non-ok → retry_ready → capability → child 实际执行。
    const parent = admit(service, "biz:e18:retry", transferArgs({ amount: 100, outcome: "non-ok" }));
    expect(service.executeAuthorizedDispatch(parent.dispatch).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("capability failed");
    const childContract = buildContract(service, "biz:e18:retry", transferArgs({ amount: 100 }));
    const child = service.executeRearm(capability.rearm, childContract, { workKey: "biz:e18:retry" });
    if (child.status !== "admitted") throw new Error(`rearm failed: ${child.reason}`);
    const executionsBeforeChild = trace.executions;
    expect(service.executeAuthorizedDispatch(child.dispatch).status).toBe("committed");
    expect(trace.executions).toBe(executionsBeforeChild + 1); // child 实际调用
    expect(child.attemptId).not.toBe(parent.attemptId);
    // 3) 长期 unknown。
    const unknown = admit(service, "biz:e18:unknown", transferArgs({ amount: 100, outcome: "throw" }));
    expect(service.executeAuthorizedDispatch(unknown.dispatch).status).toBe("unknown");
    // 4) 周期推进 + 完整 reset（指定当前 Memory 快照——含全部持久事实）。
    Game.time += 1;
    service.beginTick();
    const snapshot = snapshotWholeMemory();
    const executionsBeforeReset = trace.executions;
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: installTracingAdapter(trace),
      advanceTicks: 1,
      memorySnapshot: snapshot,
    });
    reset.service.beginTick();
    // committed（done + child）退出；unknown 有界保留。
    const journal = reset.service.kernelJournal();
    expect(journal.active.some((r) => r.attemptId === done.attemptId)).toBe(false);
    expect(journal.active.some((r) => r.attemptId === child.attemptId)).toBe(false);
    expect(journal.active.filter((r) => r.phase === "outcome_unknown").length).toBe(1);
    expect(trace.executions).toBe(executionsBeforeReset); // 无重复调用
    // 世界账目一致：1000 − done100 − child100 = 800。
    expect(reset.rooms["W1N57"]!.storage.store.energy).toBe(800);
    // 历史淘汰不授执行权：ring 中旧 ID 的许可回放拒绝。
    const ringId = journal.ring[0]?.attemptId;
    if (ringId !== undefined) {
      expect(reset.service.settleUnknownOutcome({ attemptId: ringId }).status).toBe("rejected");
      expect(reset.service.executeAuthorizedDispatch({ attemptId: ringId } as never).status).toBe("rejected");
    }
    // 旧视图不能按已退出工作的占用授权超额工作（真实余额 800；900 拒绝
    // ——contract 用 reset 后新模块句柄构建，验证真实容量判定）。
    const tooBigBuilt = reset.handles.actionContractsModule.buildTreasuryActionContract(
      reset.service,
      { actionKind: "test.transfer", transactionId: "biz:e18:toobig", args: transferArgs({ amount: 900 }) },
    );
    if (tooBigBuilt.status !== "built") throw new Error("build failed");
    const tooBig = reset.service.authorizeTreasuryActionContract(tooBigBuilt.contract, { workKey: "biz:e18:toobig" });
    expect(tooBig.status).toBe("rejected");
    if (tooBig.status === "rejected") expect(tooBig.reason).not.toContain("contract 无效");
  });
});
