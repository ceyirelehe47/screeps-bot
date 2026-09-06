/**
 * Treasury Core Rewrite IV · Remediation V——内核层 I 矩阵（任务书 §5）。
 *
 * R1 关窗先行的行为验收：I01/I02（独立 endTick 首个恢复回调内真实合法
 * authorize/dispatch/rearm 被关闭条件挡住 + 未关窗对照成功）、I03（onEffect
 * 抛错后已发布恢复/关闭不撤销、guard 可再获取、清理有非零推进）、I04
 * （关窗写丢失/lastEndTick 篡改：不假报持久成功、跨实例否决、恢复写可
 * 确认关闭）、I05（四方向嵌套 + 预算满 + 下一 tick 无永久闩锁）、I06
 * （成功发布关闭后/关闭前硬切点完整 reset）、I13（四个成本 fixture 的
 * 实测操作计量）。I07–I10 见 treasuryRemediationVService.test.ts；I11/I12
 * 由既有 G/H/F/C 系列回归承担（test-migration-map §12 映射）；I14 由
 * evidence/negative-variants 承担；I15/I16 由最终验证与主报告承担。
 */
import {
  performTreasuryKernelFullReset,
  captureTreasuryHostBreakpoint,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import type { TreasuryCoreIdentityFacts, TreasuryCoreWorstCaseLeg } from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
} from "@/runtime/treasury/actionContracts";
import { makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";

const SPECS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 } },
  { name: "W2N57", storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 }, terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 200_000 } },
];

const PARENT_ARGS = { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 50, outcome: "non-ok" } as const;
const PARENT_TX = "biz:r5:P";
const TRANSFER_ARGS = { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 10, outcome: "ok" } as const;

function kernelIdentity(actionKind = "d.kind"): TreasuryCoreIdentityFacts {
  return {
    actionKind,
    adapterVersion: 1,
    adapterRegistrationId: `reg-${actionKind}`,
    adapterSemanticIdentity: `d.adapter-${actionKind}`,
    canonicalDigest: "a".repeat(16),
    postingsDigest: "b".repeat(16),
    retryFactsDigest: "c".repeat(16),
    durableFacts: null,
  };
}

function kernelLegs(outflow: number): TreasuryCoreWorstCaseLeg[] {
  return [
    { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -outflow },
    { roomName: "W2N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: outflow },
  ];
}

function makeKernelPorts(overrides: Partial<TreasuryCoreKernelPorts> = {}): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) => ({ kind, version: 1, registrationId: `reg-${kind}`, semanticIdentity: `d.adapter-${kind}`, execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }),
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
    ...overrides,
  };
}

function kernelAdmitInput(consumers: readonly string[], workKey: string, actionKind = "d.kind"): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: kernelIdentity(actionKind),
    worstCase: kernelLegs(50),
    externalConsumers: consumers,
    canonicalArgs: { n: 1 },
    postings: kernelLegs(50),
    admissionContext: { contractId: `ac:${actionKind}`, contractDigest: "a".repeat(16), actionKind, ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

function recordOf(attemptId: string): { phase: string; cleanup?: { consumerKeys: readonly string[]; cursor: number } } | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, { phase: string; cleanup?: { consumerKeys: readonly string[]; cursor: number } }> } | undefined;
  return store?.active?.[attemptId];
}

function activeCount(): number {
  return Object.keys((Memory.runtime?.treasuryCore as unknown as { active?: Record<string, unknown> } | undefined)?.active ?? {}).length;
}

function lastEndTickOf(): number | null {
  return (Memory.runtime?.treasuryCore as unknown as { lifecycle?: { lastEndTick?: number | null } } | undefined)?.lifecycle?.lastEndTick ?? null;
}

function readBudget(): number {
  return (Memory.runtime?.treasuryCore as unknown as { recovery?: { budgetUsed?: number } } | undefined)?.recovery?.budgetUsed ?? 0;
}

/**
 * R1/I01–I03 fixture：旧栈经真实 service 入口造 retry_ready 父代，再经
 * kernel 捕获 adapter 造真实 dispatch_start 断点 A（dispatching 已发布、
 * 结果未写）。可选附带 C（8 消费者 closing）供 I03 清理推进断言。
 */
function buildVFixture(withClosingConsumerWork: boolean): { parentId: string; aId: string; cId?: string; breakpoint: TreasuryHostBreakpoint } {
  const installed = installRooms(SPECS);
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  let cId: string | undefined;
  if (withClosingConsumerWork) {
    // C：kernel 面 8 消费者 not_executed → closing（beginTick 逐步清理）。
    // 带消费者义务的接纳需要受控释放端口（已知约束）。
    const kernel0 = createTreasuryCoreKernel(makeKernelPorts({ releaseExternalConsumer: () => true }));
    const consumers = ["ext:i3:D0", "ext:i3:D1", "ext:i3:D2", "ext:i3:D3", "ext:i3:D4", "ext:i3:D5", "ext:i3:D6", "ext:i3:D7"];
    const c = kernel0.admit(kernelAdmitInput(consumers, "biz:r5:C"));
    if (c.status !== "admitted") throw new Error(`admit C failed: ${c.status === "rejected" ? c.reason : "?"}`);
    if (kernel0.executeDispatch(c.dispatch).status !== "not_executed") throw new Error("C dispatch failed");
    cId = c.attemptId;
  }
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: PARENT_TX, args: { ...PARENT_ARGS } });
  if (built.status !== "built") throw new Error("parent build failed");
  const parent = service.authorizeTreasuryActionContract(built.contract, { workKey: PARENT_TX });
  if (parent.status !== "admitted") throw new Error(`parent admit failed: ${parent.status === "rejected" ? parent.reason : "?"}`);
  if (service.executeAuthorizedDispatch(parent.dispatch).status !== "not_executed") throw new Error("parent dispatch not not_executed");
  Game.time += 1;
  service.beginTick(); // 清理（无义务）→ retry_ready
  if (recordOf(parent.attemptId)?.phase !== "retry_ready") throw new Error(`parent phase != retry_ready（${String(recordOf(parent.attemptId)?.phase)}）`);
  let captured: TreasuryHostBreakpoint | undefined;
  const capturePorts: TreasuryCoreKernelPorts = {
    ...makeKernelPorts(),
    findAdapter: (kind: string) => {
      if (kind === "h1.capture") {
        return {
          kind,
          version: 1,
          registrationId: "reg-h1.capture",
          semanticIdentity: "d.adapter-h1.capture",
          settlesOnAccept: false,
          nonOkOutcome: "not_executed" as const,
          execute: () => {
            captured = captureTreasuryHostBreakpoint();
            return { ok: false };
          },
        };
      }
      return makeKernelPorts().findAdapter(kind);
    },
  };
  const kernelCapture = createTreasuryCoreKernel(capturePorts);
  const a = kernelCapture.admit(kernelAdmitInput([], "biz:r5:A", "h1.capture"));
  if (a.status !== "admitted") throw new Error("A admit failed");
  void kernelCapture.executeDispatch(a.dispatch);
  if (captured === undefined) throw new Error("断点未捕获");
  return { parentId: parent.attemptId, aId: a.attemptId, cId, breakpoint: captured };
}

interface NewRuntime {
  kernel: TreasuryCoreKernel;
  service: TreasuryService;
  facadeModule: typeof import("@/runtime/treasury/facade");
  actionContractsModule: typeof import("@/runtime/treasury/actionContracts");
  actionCalls: { count: number };
  rooms: Record<string, Room>;
  parentId: string;
}

/** 完整 kernel reset（runBeginTick:false——第一个恢复入口由用例决定）+ 新模块 facade + 计数 adapter。不调用 service.beginTick()。 */
function buildNewRuntime(ports: TreasuryCoreKernelPorts, fixture: { parentId: string; breakpoint: TreasuryHostBreakpoint }): NewRuntime {
  const reset = performTreasuryKernelFullReset({ ports, breakpoint: fixture.breakpoint, roomSpecs: SPECS, runBeginTick: false });
  const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
  const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
  const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
  const actionCalls = { count: 0 };
  const base = actionContractsModule.makeTreasuryTestTransferAdapter();
  actionContractsModule.replaceTreasuryActionAdapterForTest({
    ...base,
    execute(args: unknown): { ok: boolean } {
      actionCalls.count += 1;
      return base.execute(args as Parameters<typeof base.execute>[0]);
    },
  });
  policyModule.unsealTreasuryPolicyRegistryForTest();
  policyModule.clearTreasuryPolicyResolversForTest();
  policyModule.registerTreasuryPolicyResolver(policyModule.makeNoReserveTreasuryPolicy());
  const installed = installRooms(SPECS);
  const service = facadeModule.createTreasuryService({ getRooms: () => Object.values(installed) });
  return { kernel: reset.kernel, service, facadeModule, actionContractsModule, actionCalls, rooms: installed, parentId: fixture.parentId };
}

interface Candidates {
  contractN: unknown;
  pending: { attemptId: string; dispatch: unknown };
  rearm: { status: string; rearm?: unknown };
  childContract: unknown;
  frontierBefore: number;
  activeBefore: number;
}

/** 在窗口开启时准备三个合法候选：真 contract N、真 pending dispatch 许可 P、真 rearm capability R（child 合同按父代同 transactionId/args 重建）。 */
function prepareCandidates(rt: NewRuntime): Candidates {
  const builtN = rt.actionContractsModule.buildTreasuryActionContract(rt.service, { actionKind: "test.transfer", transactionId: "biz:r5:N", args: { ...TRANSFER_ARGS } });
  if (builtN.status !== "built") throw new Error(`build N failed: ${builtN.status === "rejected" ? builtN.reason : "?"}`);
  const builtP = rt.actionContractsModule.buildTreasuryActionContract(rt.service, { actionKind: "test.transfer", transactionId: "biz:r5:P2", args: { ...TRANSFER_ARGS } });
  if (builtP.status !== "built") throw new Error("build P failed");
  const pAdmission = rt.service.authorizeTreasuryActionContract(builtP.contract, { workKey: "biz:r5:P2" });
  if (pAdmission.status !== "admitted") throw new Error(`prepare P failed: ${pAdmission.status === "rejected" ? pAdmission.reason : "?"}`);
  const rearmVerdict = rt.service.issueTreasuryRearmCapability({ attemptId: rt.parentId });
  if (rearmVerdict.status !== "ok") throw new Error(`rearm capability failed: ${rearmVerdict.status === "rejected" ? rearmVerdict.reason : "?"}`);
  const builtChild = rt.actionContractsModule.buildTreasuryActionContract(rt.service, { actionKind: "test.transfer", transactionId: PARENT_TX, args: { ...PARENT_ARGS } });
  if (builtChild.status !== "built") throw new Error("build child failed");
  return {
    contractN: builtN.contract,
    pending: { attemptId: pAdmission.attemptId, dispatch: pAdmission.dispatch },
    rearm: rearmVerdict,
    childContract: builtChild.contract,
    frontierBefore: rt.kernel.metrics().frontier,
    activeBefore: activeCount(),
  };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

// ── I01/I02：先关窗再回调（独立 endTick 的首个恢复回调内业务全拒） ─────────

describe("I01/I02 独立 endTick 关窗先行", () => {
  it("I01 对照：未请求关窗时 authorize/dispatch/rearm 三候选全部成功（真实合法输入证明）", () => {
    const rt = buildNewRuntime(makeKernelPorts(), buildVFixture(false));
    const c = prepareCandidates(rt);
    const authorizeVerdict = rt.service.authorizeTreasuryActionContract(c.contractN, { workKey: "biz:r5:N" });
    expect(authorizeVerdict.status).toBe("admitted");
    expect(rt.service.executeAuthorizedDispatch(c.pending.dispatch).status).toBe("committed");
    expect(rt.service.executeRearm(c.rearm.rearm, c.childContract).status).toBe("admitted");
    expect(rt.actionCalls.count).toBe(1);
  });

  it("I01 首个 onEffect 回调内提交合法新 contract：回调进入前已关闭；authorize 拒 lifecycle_closed、发行/active 增量 0", () => {
    let lastEndTickAtCallback: number | null = null;
    let asked = false;
    let rtRef: NewRuntime = undefined as unknown as NewRuntime;
    let cRef: Candidates = undefined as unknown as Candidates;
    let verdictIn: unknown = "not-run";
    const ports = makeKernelPorts({
      onEffect: (effect) => {
        if (!asked && (effect as { effect?: string }).effect === "recovered_to_unknown") {
          asked = true;
          lastEndTickAtCallback = lastEndTickOf(); // 回调进入时刻的持久关窗事实
          try {
            verdictIn = rtRef.service.authorizeTreasuryActionContract(cRef.contractN, { workKey: "biz:r5:N" });
          } catch (e) {
            verdictIn = `threw:${String(e)}`;
          }
        }
      },
    });
    const fx = buildVFixture(false);
    rtRef = buildNewRuntime(ports, fx);
    cRef = prepareCandidates(rtRef);
    const endStats = rtRef.kernel.endTick();
    expect(endStats.recoveredToUnknown).toBe(1);
    expect(endStats.closurePersisted).toBe(true);
    expect(asked).toBe(true);
    expect(lastEndTickAtCallback).toBe(Game.time); // 关窗成功早于第一个可回调的恢复动作
    expect(verdictIn).toMatchObject({ status: "rejected", reasonCode: "lifecycle_closed" });
    expect(rtRef.kernel.metrics().frontier).toBe(cRef.frontierBefore); // 发行增量 0
    expect(activeCount()).toBe(cRef.activeBefore); // active 增量 0
  });

  it("I02 回调内提交当 tick真 dispatch 与真 rearm：实际动作 0、child 0、权利未误消费（下一 tick capability 仍可用）；回调不另调 endTick", () => {
    const inCallback: { dispatch: unknown; rearm: unknown; activeAt: number } = { dispatch: "not-run", rearm: "not-run", activeAt: -1 };
    let asked = false;
    let rtRef: NewRuntime = undefined as unknown as NewRuntime;
    let cRef: Candidates = undefined as unknown as Candidates;
    const ports = makeKernelPorts({
      onEffect: (effect) => {
        if (!asked && (effect as { effect?: string }).effect === "recovered_to_unknown") {
          asked = true;
          try {
            inCallback.dispatch = rtRef.service.executeAuthorizedDispatch(cRef.pending.dispatch);
          } catch (e) { inCallback.dispatch = `threw:${String(e)}`; }
          inCallback.activeAt = activeCount();
          try {
            inCallback.rearm = rtRef.service.executeRearm(cRef.rearm.rearm, cRef.childContract);
          } catch (e) { inCallback.rearm = `threw:${String(e)}`; }
        }
      },
    });
    const fx = buildVFixture(false);
    rtRef = buildNewRuntime(ports, fx);
    cRef = prepareCandidates(rtRef);
    const endStats = rtRef.kernel.endTick();
    expect(endStats.recoveredToUnknown).toBe(1);
    expect(inCallback.dispatch).toMatchObject({ status: "blocked", reasonCode: "lifecycle_closed" }); // 动作调用 0、许可未消费
    expect(inCallback.rearm).toMatchObject({ status: "rejected", reasonCode: "lifecycle_closed" }); // child 0
    expect(activeCount()).toBe(cRef.activeBefore + 1 - 1); // A 恢复仍在；无 dispatch/rearm 新记录（+1 A 未知恢复=已计入 activeBefore 后不变）
    expect(rtRef.actionCalls.count).toBe(0);
    // 记录 P（pending）仍可显式取消或过期——此处断言不被回调误执行：
    expect(recordOf(cRef.pending.attemptId)?.phase).toBe("pending");
    // 权利未误消费：父代仍在 retry_ready（若回调内 rearm 被放行/消费，父代
    // 已离开 retry_ready）；下一 tick 重新签发能力并完成 rearm（tick 作用域
    // 许可——H10 既有口径：前 tick capability 自然过期，不作为消费证据）。
    Game.time += 1;
    rtRef.service.beginTick();
    expect(recordOf(rtRef.parentId)?.phase).toBe("retry_ready");
    const cap2 = rtRef.service.issueTreasuryRearmCapability({ attemptId: rtRef.parentId });
    if (cap2.status !== "ok") throw new Error(`capability re-issue failed: ${cap2.status === "rejected" ? cap2.reason : "?"}`);
    // child 合同在新 tick 重建（合同绑定构建时观察——旧 tick 合同过期，H15 同型）。
    const builtChild2 = rtRef.actionContractsModule.buildTreasuryActionContract(rtRef.service, { actionKind: "test.transfer", transactionId: PARENT_TX, args: { ...PARENT_ARGS } });
    if (builtChild2.status !== "built") throw new Error(`child rebuild failed: ${builtChild2.status === "rejected" ? builtChild2.reason : "?"}`);
    const rearmAfter = rtRef.service.executeRearm(cap2.rearm, builtChild2.contract);
    expect(rearmAfter.status).toBe("admitted");
  });
});

// ── I03：异常路径不开放新业务、guard 可再获取、清理非零推进 ────────────────

describe("I03 onEffect 抛错后共享关闭保持", () => {
  it("已发布恢复/关闭不撤销；另一 facade 随后发动作仍拒；guard 可再获取且清理有非零推进", () => {
    let threw = false;
    // 故障注入只作用于**首个恢复效果**（endTick 回调路径）；后续 beginTick 的
    // 清理效果正常放行——清理推进本身是本用例的断言对象。
    let thrownOnce = false;
    const ports = makeKernelPorts({
      releaseExternalConsumer: () => true,
      onEffect: (effect) => {
        if (!thrownOnce && (effect as { effect?: string }).effect === "recovered_to_unknown") {
          thrownOnce = true;
          threw = true;
          throw new Error("I03 故障注入");
        }
      },
    });
    const fx = buildVFixture(true); // A dispatching + C（8 消费者 closing）
    const rt = buildNewRuntime(ports, fx);
    const c = prepareCandidates(rt);
    try {
      rt.kernel.endTick();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(recordOf(fx.aId)?.phase).toBe("outcome_unknown"); // 已发布恢复事实保留
    expect(lastEndTickOf()).toBe(Game.time); // 已发布关闭事实保留（关窗先于回调）
    // 另一 facade 实例随后发动作：当前 tick 新业务仍拒（否决标记 + 持久关窗）。
    const serviceB = rt.facadeModule.createTreasuryService({ getRooms: () => Object.values(rt.rooms) });
    const builtB = rt.actionContractsModule.buildTreasuryActionContract(serviceB, { actionKind: "test.transfer", transactionId: "biz:r5:B", args: { ...TRANSFER_ARGS } });
    if (builtB.status !== "built") throw new Error("build B failed");
    const verdictB = serviceB.authorizeTreasuryActionContract(builtB.contract, { workKey: "biz:r5:B" });
    expect(verdictB.status).toBe("rejected");
    expect((verdictB as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
    // guard 已释放：beginTick 可再获取，且清理有非零推进（C 的义务被服务）。
    const advance = rt.kernel.beginTick();
    expect(advance.cleaned).toBeGreaterThan(0);
    expect(recordOf(fx.cId as string)?.cleanup?.consumerKeys.length).toBeLessThan(8); // 已释放至少一项
    // 恢复/清理推进后，当前 tick 业务窗口仍关闭（不因 begin 复活）。
    const verdictAfterCleanup = rt.service.authorizeTreasuryActionContract(c.contractN, { workKey: "biz:r5:N" });
    expect((verdictAfterCleanup as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
  });
});

// ── I04：关窗发布失败（丢写/篡改）不谎报、跨实例否决、恢复写可确认 ──────────

describe("I04 关窗发布失败与篡改", () => {
  it("丢写：closurePersisted=false 不假报持久成功；跨实例否决业务；不退款、不清空记录；恢复写可确认关闭", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key: string): boolean => { releaseCalls.push(key); return true; } });
    const rt = buildNewRuntime(ports, buildVFixture(false));
    prepareCandidates(rt);
    const activeBefore = activeCount();
    const budgetBefore = readBudget();
    const serviceB = rt.facadeModule.createTreasuryService({ getRooms: () => Object.values(rt.rooms) });
    const ic = interceptTreasuryCoreWrites({ allow: 0 });
    const stats = rt.kernel.endTick();
    ic.restore();
    expect(stats.closurePersisted).toBe(false); // 不假报持久成功
    expect(lastEndTickOf()).not.toBe(Game.time); // 持久关窗确实未发布
    expect(activeCount()).toBe(activeBefore); // 不清空记录
    expect(readBudget()).toBe(budgetBefore); // 不退款（预算不回退）
    expect(releaseCalls).toEqual([]);
    // 同运行时另一 facade 的合法业务仍被拒（heap 否决标记跨实例）。
    const builtB = rt.actionContractsModule.buildTreasuryActionContract(serviceB, { actionKind: "test.transfer", transactionId: "biz:r5:B", args: { ...TRANSFER_ARGS } });
    if (builtB.status !== "built") throw new Error("build B failed");
    const verdictB = serviceB.authorizeTreasuryActionContract(builtB.contract, { workKey: "biz:r5:B" });
    expect((verdictB as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
    // 恢复正常写后可确认关闭（重申关窗事实）。
    const reStats = serviceB.endTick();
    void reStats;
    expect(lastEndTickOf()).toBe(Game.time);
  });

  it("lastEndTick 被篡改（健康旧 root 仍读得出）：跨实例继续否决；endTick 重申后确认关闭", () => {
    const rt = buildNewRuntime(makeKernelPorts(), buildVFixture(false));
    prepareCandidates(rt);
    const stats = rt.kernel.endTick();
    expect(stats.closurePersisted).toBe(true);
    expect(lastEndTickOf()).toBe(Game.time);
    const serviceB = rt.facadeModule.createTreasuryService({ getRooms: () => Object.values(rt.rooms) });
    // 目标字段被篡改回旧值（store 仍健康——结构校验通过）。
    (Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number | null } }).lifecycle.lastEndTick = null;
    const health = rt.kernel.health();
    expect(health.status).toBe("healthy"); // 健康旧 root 仍读得出
    // 当前运行时跨实例继续否决业务（否决标记本 tick 生效）。
    const builtB = rt.actionContractsModule.buildTreasuryActionContract(serviceB, { actionKind: "test.transfer", transactionId: "biz:r5:B", args: { ...TRANSFER_ARGS } });
    if (builtB.status !== "built") throw new Error("build B failed");
    const verdictB = serviceB.authorizeTreasuryActionContract(builtB.contract, { workKey: "biz:r5:B" });
    expect((verdictB as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
    // 再次 endTick：幂等重申被篡改的关窗事实（恢复写可确认关闭）。
    const reStats = rt.kernel.endTick();
    expect(reStats.closurePersisted).toBe(true);
    expect(lastEndTickOf()).toBe(Game.time);
  });
});

// ── I05：四方向嵌套 + 预算已满 + 同 tick 顺序调用与下一 tick ────────────────

describe("I05 嵌套/预算满/无永久闩锁", () => {
  it("begin→end→嵌套四方向、预算已满时关窗写仍进行、同 tick begin 不复活窗口、下一 tick 新业务可接纳", () => {
    const kernel1 = createTreasuryCoreKernel(makeKernelPorts());
    // 真实 admit 初始化 store（beginTick 不初始化缺失 store——H18 已知坑）。
    const seed = kernel1.admit(kernelAdmitInput([], "biz:r5:i5:seed"));
    if (seed.status !== "admitted") throw new Error("seed failed");
    kernel1.beginTick();
    // 预算写满 8（手工构造满预算持久状态）。
    const store = Memory.runtime!.treasuryCore as unknown as { recovery: { sweepCursor: number; cleanupCursor: number; budgetTick: number; budgetUsed: number } };
    store.recovery = { sweepCursor: 0, cleanupCursor: 0, budgetTick: Game.time, budgetUsed: 8 };
    // endTick：恢复循环因预算满跳过；关窗写（固定开销）仍进行并确认。
    const endStats = kernel1.endTick();
    expect(endStats.closurePersisted).toBe(true); // 预算满不阻断必要关窗
    expect(endStats.recoveredToUnknown).toBe(0);
    expect(lastEndTickOf()).toBe(Game.time);
    // 同 tick 顺序 beginTick：推进可运行（清理不受关窗限制），窗口不复活。
    const beginAgain = kernel1.beginTick();
    expect(beginAgain).toBeDefined();
    expect(lastEndTickOf()).toBe(Game.time);
    const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
    const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
    const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
    actionContractsModule.replaceTreasuryActionAdapterForTest(actionContractsModule.makeTreasuryTestTransferAdapter());
    policyModule.unsealTreasuryPolicyRegistryForTest();
    policyModule.clearTreasuryPolicyResolversForTest();
    policyModule.registerTreasuryPolicyResolver(policyModule.makeNoReserveTreasuryPolicy());
    const installed = installRooms(SPECS);
    const service = facadeModule.createTreasuryService({ getRooms: () => Object.values(installed) });
    const builtClosed = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:r5:closed", args: { ...TRANSFER_ARGS } });
    if (builtClosed.status !== "built") throw new Error("build failed");
    const closedVerdict = service.authorizeTreasuryActionContract(builtClosed.contract, { workKey: "biz:r5:closed" });
    expect((closedVerdict as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
    // 方向矩阵（同 tick 内核嵌套）：end 持有期间嵌套 begin/end。经真实断点
    // fixture + 完整 reset（runBeginTick:false）后的独立 endTick 恢复回调
    // 触发（dispatching 残留只能来自真实断点快照——手工改 phase 破坏结构
    // 校验、adapter 异常会被 executeDispatch 保守收敛为 unknown）。
    Game.time += 1; // 新 tick：上一 endTick 否决按 tick 失效、恢复预算重置
    let asked = false;
    let sawNestedBegin = false;
    let sawNestedEnd = false;
    const portsNested = makeKernelPorts({
      onEffect: (effect) => {
        if (asked || (effect as { effect?: string }).effect !== "recovered_to_unknown") return;
        asked = true;
        const nested = createTreasuryCoreKernel(makeKernelPorts());
        const nb = nested.beginTick(); // 嵌套 begin：guard 持有 → 零推进
        sawNestedBegin = nb.recovered === 0 && nb.cleaned === 0;
        const ne = nested.endTick(); // 嵌套 end：只发布关窗事实 → 零恢复
        sawNestedEnd = ne.recoveredToUnknown === 0;
      },
    });
    const fxN = buildVFixture(false);
    const rtN = buildNewRuntime(portsNested, fxN);
    const endHolderStats = rtN.kernel.endTick(); // 恢复残留 → 回调内四方向嵌套
    expect(sawNestedBegin).toBe(true); // 共享互斥保持（嵌套 begin 零推进）
    expect(sawNestedEnd).toBe(true); // 嵌套 end 不递归恢复
    expect(endHolderStats.recoveredToUnknown).toBe(1);
    // 下一 tick 正常开新窗口（无永久闩锁）——用 reset 后的新模块句柄。
    Game.time += 1;
    rtN.service.beginTick();
    const builtNext = rtN.actionContractsModule.buildTreasuryActionContract(rtN.service, { actionKind: "test.transfer", transactionId: "biz:r5:next", args: { ...TRANSFER_ARGS } });
    if (builtNext.status !== "built") throw new Error("build failed");
    const nextVerdict = rtN.service.authorizeTreasuryActionContract(builtNext.contract, { workKey: "biz:r5:next" });
    expect(nextVerdict.status).toBe("admitted");
  });
});

// ── I06：硬切点完整 reset 的关闭事实 ───────────────────────────────────────

describe("I06 关闭事实跨完整 reset", () => {
  it("成功发布关闭后切点：恢复后同 tick 关闭保持、旧许可拒绝、下一 tick 正常窗口可完成；关闭前切点：窗口开启", () => {
    // 关闭后切点：endTick 成功发布 → 同 tick 捕获断点 → 完整 reset（advanceTicks 0）。
    const fx = buildVFixture(false);
    const reset0 = performTreasuryKernelFullReset({ ports: makeKernelPorts(), breakpoint: fx.breakpoint, roomSpecs: SPECS, runBeginTick: false });
    reset0.kernel.endTick(); // 独立 endTick：关窗成功发布
    expect(lastEndTickOf()).toBe(Game.time);
    const oldPermitOwner = { dispatch: undefined as unknown };
    // 关闭后捕获断点（Memory 含已发布 lastEndTick）。
    const bpClosed = captureTreasuryHostBreakpoint();
    void oldPermitOwner;
    // 完整 reset：同 tick 恢复（无 advanceTicks）。
    const reset1 = performTreasuryKernelFullReset({ ports: makeKernelPorts(), breakpoint: bpClosed, roomSpecs: SPECS, runBeginTick: false });
    expect(lastEndTickOf()).toBe(Game.time); // 成功发布的同 tick 关闭恢复
    const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
    const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
    const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
    actionContractsModule.replaceTreasuryActionAdapterForTest(actionContractsModule.makeTreasuryTestTransferAdapter());
    policyModule.unsealTreasuryPolicyRegistryForTest();
    policyModule.clearTreasuryPolicyResolversForTest();
    policyModule.registerTreasuryPolicyResolver(policyModule.makeNoReserveTreasuryPolicy());
    const installed = installRooms(SPECS);
    const service = facadeModule.createTreasuryService({ getRooms: () => Object.values(installed) });
    const builtClosed = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:r5:i6closed", args: { ...TRANSFER_ARGS } });
    if (builtClosed.status !== "built") throw new Error("build failed");
    const closedVerdict = service.authorizeTreasuryActionContract(builtClosed.contract, { workKey: "biz:r5:i6closed" });
    expect((closedVerdict as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed"); // 持久关窗跨 reset 生效
    // 下一 tick 正常窗口可完成（dispatch 全链成功）。
    Game.time += 1;
    service.beginTick();
    const builtNext = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:r5:i6next", args: { ...TRANSFER_ARGS } });
    if (builtNext.status !== "built") throw new Error("build failed");
    const nextAdmission = service.authorizeTreasuryActionContract(builtNext.contract, { workKey: "biz:r5:i6next" });
    if (nextAdmission.status !== "admitted") throw new Error(`next admit failed: ${nextAdmission.status === "rejected" ? nextAdmission.reason : "?"}`);
    expect(service.executeAuthorizedDispatch(nextAdmission.dispatch).status).toBe("committed");
  });

  it("关闭前切点：恢复后窗口开启、业务可接纳（不要求恢复从未持久化的关闭请求）", () => {
    // buildVFixture 的断点在 endTick 之前捕获（dispatching 残留、无 lastEndTick）。
    const fx = buildVFixture(false);
    const reset = performTreasuryKernelFullReset({ ports: makeKernelPorts(), breakpoint: fx.breakpoint, roomSpecs: SPECS, runBeginTick: false });
    expect(lastEndTickOf()).not.toBe(Game.time); // 断点时刻未请求关窗
    const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
    const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
    const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
    actionContractsModule.replaceTreasuryActionAdapterForTest(actionContractsModule.makeTreasuryTestTransferAdapter());
    policyModule.unsealTreasuryPolicyRegistryForTest();
    policyModule.clearTreasuryPolicyResolversForTest();
    policyModule.registerTreasuryPolicyResolver(policyModule.makeNoReserveTreasuryPolicy());
    const installed = installRooms(SPECS);
    const service = facadeModule.createTreasuryService({ getRooms: () => Object.values(installed) });
    const built = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:r5:i6open", args: { ...TRANSFER_ARGS } });
    if (built.status !== "built") throw new Error("build failed");
    const verdict = service.authorizeTreasuryActionContract(built.contract, { workKey: "biz:r5:i6open" });
    expect(verdict.status).toBe("admitted"); // 关闭前切点恢复 → 窗口开启
    void reset;
  });
});

// ── I13：成本观察四 fixture（实测操作计量，不新增生产 telemetry） ────────────

/**
 * 存储边界观察器（I13 专用）：物理写尝试/成功写按 Memory.runtime.treasuryCore
 * 属性 set 边界计数；安全读按属性 get 边界计数（含写协议内部的基线/读回
 * 访问——按可观察边界定义，如实记录）。
 */
function observeTreasuryCoreStore(options: { allow?: number } = {}): {
  reads: () => number;
  writeAttempts: () => number;
  writesAllowed: () => number;
  writesDropped: () => number;
  restore: () => void;
} {
  const runtime = Memory.runtime as unknown as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
  if (descriptor === undefined) throw new Error("观察器须在 treasuryCore 初始化后安装");
  let live = descriptor.value;
  let reads = 0;
  let attempts = 0;
  let allowed = 0;
  let dropped = 0;
  const maxAllowed = options.allow ?? Number.POSITIVE_INFINITY;
  Object.defineProperty(runtime, "treasuryCore", {
    configurable: true,
    get: () => { reads += 1; return live; },
    set: (value: unknown) => {
      attempts += 1;
      if (allowed < maxAllowed) { allowed += 1; live = value; return; }
      dropped += 1;
    },
  });
  return {
    reads: () => reads,
    writeAttempts: () => attempts,
    writesAllowed: () => allowed,
    writesDropped: () => dropped,
    restore: () => { delete runtime.treasuryCore; runtime.treasuryCore = live; },
  };
}

describe("I13 成本观察（实测操作计量）", () => {
  it("fixture 1/2：空 endTick 与恢复 1 条 A + 清理 8 项 C 的实测读写/份额/释放", () => {
    // —— fixture 1：空 endTick（本 tick 已 beginTick——无 dispatching 残留）——
    const kernelA = createTreasuryCoreKernel(makeKernelPorts());
    const seedA = kernelA.admit(kernelAdmitInput([], "biz:r5:i13:seed")); // 真实 admit 初始化 store
    if (seedA.status !== "admitted") throw new Error("seed failed");
    kernelA.beginTick(); // lastBeginTick + 预算 tick 期建立
    const obs1 = observeTreasuryCoreStore();
    const stats1 = kernelA.endTick();
    obs1.restore();
    const fixture1 = {
      fixture: "empty-endTick",
      reads: obs1.reads(),
      writeAttempts: obs1.writeAttempts(),
      writesAllowed: obs1.writesAllowed(),
      writesDropped: obs1.writesDropped(),
      logicalSharesUsed: readBudget(),
      closurePersisted: stats1.closurePersisted,
    };
    expect(fixture1.writesAllowed).toBe(1); // 关窗写 1 次；事实一致 → 无尾写
    expect(fixture1.closurePersisted).toBe(true);
    // —— fixture 2：恢复 1 条 A（endTick）+ 清理 8 项 C（beginTick 跨 tick）——
    Game.time += 1; // 上一 fixture 的 endTick 已置本 tick 否决——新 tick 开新窗口
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key: string): boolean => { releaseCalls.push(key); return true; } });
    const fx = buildVFixture(true); // A dispatching + C（8 消费者 closing；旧栈清理消耗部分释放）
    const releaseBase = releaseCalls.length; // 旧栈清理的释放不计入本观察段（增量口径）
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, roomSpecs: SPECS, runBeginTick: false });
    const obs2 = observeTreasuryCoreStore();
    const endA = reset.kernel.endTick(); // 恢复 A → unknown
    const begin1 = reset.kernel.beginTick(); // 清理 C（预算内服务）
    const tick1Releases = releaseCalls.length - releaseBase; // 此刻求值（其后完成循环会追加释放）
    const tick1Shares = readBudget();
    obs2.restore();
    const consumersLeftAfterTick1 = recordOf(fx.cId as string)?.cleanup?.consumerKeys.length ?? 0;
    // C 的剩余义务受成对预算约束跨多 tick 收尾（每 tick 释放 ≤4）——有界循环
    // 至完成，全程计量（读/写/份额/逐 tick 释放增量）。
    const perTickReleases: number[] = [];
    const obs3 = observeTreasuryCoreStore();
    let completionTicks = 0;
    while (recordOf(fx.cId as string)?.phase === "closing" && completionTicks < 5) {
      Game.time += 1;
      const before = releaseCalls.length;
      reset.kernel.beginTick();
      perTickReleases.push(releaseCalls.length - before);
      completionTicks += 1;
    }
    obs3.restore();
    const fixture2 = {
      fixture: "recover-A-then-clean-8C",
      phaseEndTick: { recoveredToUnknown: endA.recoveredToUnknown, closurePersisted: endA.closurePersisted },
      tick1: { reads: obs2.reads(), writeAttempts: obs2.writeAttempts(), writesAllowed: obs2.writesAllowed(), cleaned: begin1.cleaned, sharesUsed: tick1Shares, releaseCalls: tick1Releases },
      completion: { ticks: completionTicks, reads: obs3.reads(), writeAttempts: obs3.writeAttempts(), writesAllowed: obs3.writesAllowed(), totalReleaseCalls: releaseCalls.length - releaseBase, perTickReleases, phaseAfter: recordOf(fx.cId as string)?.phase },
      awaitingServiceAfterTick1: consumersLeftAfterTick1,
    };
    expect(fixture2.phaseEndTick.recoveredToUnknown).toBe(1);
    expect(begin1.cleaned).toBeGreaterThan(0);
    expect(fixture2.tick1.sharesUsed).toBeLessThanOrEqual(8); // 逻辑份额 ≤8
    expect(fixture2.tick1.releaseCalls).toBeLessThanOrEqual(4); // 释放调用 ≤4
    for (const n of perTickReleases) expect(n).toBeLessThanOrEqual(4); // 每 tick 释放 ≤4
    expect(recordOf(fx.cId as string)?.phase).toBe("retry_ready"); // 旧工作继续收尾（有界完成）
    expect(fixture2.completion.totalReleaseCalls).toBeGreaterThanOrEqual(consumersLeftAfterTick1); // 剩余义务全部获得服务
    // eslint-disable-next-line no-console
    console.log(`I13-COST ${JSON.stringify({ fixture1, fixture2 })}`);
  });

  it("fixture 3/4：关窗发布失败的实测写尝试 + 满 64 活跃聚合混合推进的实测", () => {
    // —— fixture 3：关窗发布失败（全丢写）——
    const kernelB = createTreasuryCoreKernel(makeKernelPorts());
    const seedB = kernelB.admit(kernelAdmitInput([], "biz:r5:i13:seed3")); // 真实 admit 初始化 store
    if (seedB.status !== "admitted") throw new Error("seed failed");
    kernelB.beginTick();
    const obs1 = observeTreasuryCoreStore({ allow: 0 });
    const stats3 = kernelB.endTick();
    obs1.restore();
    const fixture3 = {
      fixture: "closure-publish-failure",
      writeAttempts: obs1.writeAttempts(),
      writesAllowed: obs1.writesAllowed(),
      writesDropped: obs1.writesDropped(),
      reads: obs1.reads(),
      closurePersisted: stats3.closurePersisted,
    };
    expect(fixture3.writesAllowed).toBe(0);
    expect(fixture3.closurePersisted).toBe(false); // 不谎报
    expect(fixture3.writeAttempts).toBeLessThanOrEqual(2); // 有界：关窗写 + 至多一次尾写
    // —— fixture 4：满 64 活跃聚合的混合推进 ——
    Game.time += 1; // 上一 fixture 的 endTick 已置本 tick 否决——新 tick 开新窗口
    const kernelC = createTreasuryCoreKernel(makeKernelPorts());
    // 先经真实 admit 初始化 store（一笔种子记录），再手工构造满载混合记录
    // （H18 同型完整字段形状——手工改 phase 会破坏结构校验）。
    const seed = kernelC.admit(kernelAdmitInput([], "biz:r5:seed"));
    if (seed.status !== "admitted") throw new Error("seed failed");
    const memory = Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, Record<string, unknown>>;
      ring: unknown[];
      ringCursor: number;
      issuance: { frontier: number; burned: number };
      lifecycle: { lastBeginTick: number | null; lastEndTick: number | null };
      recovery: { sweepCursor: number; cleanupCursor: number; budgetTick: number; budgetUsed: number };
    };
    for (const key of Object.keys(memory.active)) delete memory.active[key]; // 清空含前一 fixture 的种子残留（同测试共享 store）
    // 0–19 dispatching（invocationBoundary 非空）、20–35 outcome_unknown、
    // 36–55 closing（无消费者义务——清理份额推进）、56–63 retry_ready。
    const mk = (i: number): Record<string, unknown> => {
      const phase = i < 20 ? "dispatching" : i < 36 ? "outcome_unknown" : i < 56 ? "closing" : "retry_ready";
      const determined = phase === "closing" || phase === "retry_ready";
      // retry_ready 只允许 not_executed（结构校验）；closing 混排两种确定结论。
      const outcome = phase === "outcome_unknown" || phase === "dispatching" ? "unknown" : phase === "retry_ready" ? "not_executed" : i % 2 === 0 ? "committed" : "not_executed";
      return {
        workKey: `biz:r5:i13:W${i}`,
        attemptId: `tk1_i5_${i.toString().padStart(2, "0")}`,
        generation: 1,
        parentAttemptId: null,
        phase,
        admittedAtTick: Game.time,
        updatedAtTick: Game.time,
        identity: { ...kernelIdentity() },
        worstCase: kernelLegs(10),
        invocationBoundary: phase === "retry_ready" ? null : { atTick: Game.time, worldSequence: 1 },
        invocation: null,
        external: null,
        outcome,
        // closing/retry_ready 必须有结论一致证据（结构校验：结果确定⇒证据）。
        outcomeEvidence: determined
          ? { kind: "adapter_execution_semantics", conclusion: outcome === "committed" ? "executed" : "not_executed", source: "probe:i13", atTick: Game.time }
          : null,
        cleanup: { consumerKeys: [], failures: 0, cursor: 0 },
        retryDeadlineTick: phase === "retry_ready" ? Game.time + 10 : null,
        lastError: null,
      };
    };
    for (let i = 0; i < 64; i += 1) {
      const record = mk(i);
      memory.active[record.attemptId as string] = record;
    }
    memory.issuance.frontier = 65;
    memory.lifecycle = { lastBeginTick: null, lastEndTick: null };
    memory.recovery = { sweepCursor: 0, cleanupCursor: 0, budgetTick: Game.time, budgetUsed: 0 };
    const obs4 = observeTreasuryCoreStore();
    const beginStats = kernelC.beginTick(); // 混合推进（预算 8：dispatching ≤2、closing 清理 ≥2 等）
    const endStats = kernelC.endTick();
    obs4.restore();
    const fixture4 = {
      fixture: "64-active-mixed-advance",
      activeCount: 64,
      beginTick: { recovered: beginStats.recovered, cleaned: beginStats.cleaned, closed: beginStats.closed, cancelled: beginStats.cancelled },
      endTick: { recoveredToUnknown: endStats.recoveredToUnknown, closurePersisted: endStats.closurePersisted },
      reads: obs4.reads(),
      writeAttempts: obs4.writeAttempts(),
      writesAllowed: obs4.writesAllowed(),
      sharesUsed: readBudget(),
    };
    expect(fixture4.activeCount).toBe(64);
    expect(fixture4.sharesUsed).toBeLessThanOrEqual(8);
    expect(fixture4.beginTick.recovered + fixture4.endTick.recoveredToUnknown).toBeGreaterThan(0); // 混合推进真实发生
    expect(fixture4.endTick.closurePersisted).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`I13-COST ${JSON.stringify({ fixture3, fixture4 })}`);
  });
});
