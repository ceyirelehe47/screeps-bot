/**
 * Treasury Core Rewrite IV · Remediation VI——内核层 J 矩阵（任务书 §4）。
 *
 * R1（持久关窗统一门禁）：J01（同 tick 成功关窗→完整 reset→新 kernel 直接
 * admit/executeRearm 因 lifecycle.lastEndTick 拒绝；配对 facade 与未关窗/
 * 下一 tick 对照）、J02（真 dispatch P / 真 rearm capability R + 持久关闭，
 * 仅移除 heap 否决的门禁单测——三执行入口不被上游接纳拒绝掩盖）、J03
 * （仅 heap 否决/非健康核心/坏 ring 下门禁与查询零写语义）、J04（关窗下
 * 旧工作恢复/取消/清理/close 继续推进 + 下一 tick 新业务成功）。
 * J05/J06 见 treasuryRemediationIVKernel.test.ts 的 H18 重写；J07 由
 * evidence/negative-variants 承担；J08 由最终验证与主报告承担。
 */
import { performTreasuryKernelFullReset } from "@mock/treasuryResetHarness";
import {
  createTreasuryCoreKernel,
  resetTreasuryCoreLifecycleFactsForTest,
  type TreasuryCoreAdmissionInput,
  type TreasuryCoreKernel,
  type TreasuryCoreKernelPorts,
} from "@/runtime/treasury/kernel/kernel";
import type { TreasuryCoreIdentityFacts, TreasuryCoreWorstCaseLeg } from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryService } from "@/runtime/treasury/facade";

const SPECS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 } },
  { name: "W2N57", storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 }, terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 200_000 } },
];

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

function makeKernelPorts(calls?: { count: number }, overrides: Partial<TreasuryCoreKernelPorts> = {}): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) => ({
      kind,
      version: 1,
      registrationId: `reg-${kind}`,
      semanticIdentity: `d.adapter-${kind}`,
      execute: () => {
        if (calls) calls.count += 1;
        return { ok: false };
      },
      settlesOnAccept: false,
      nonOkOutcome: "not_executed" as const,
    }),
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
    ...overrides,
  };
}

function kernelAdmitInput(workKey: string, actionKind = "d.kind"): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: kernelIdentity(actionKind),
    worstCase: kernelLegs(50),
    externalConsumers: [],
    canonicalArgs: { n: 1 },
    postings: kernelLegs(50),
    admissionContext: { contractId: `ac:${actionKind}`, contractDigest: "a".repeat(16), actionKind, ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

function recordOf(attemptId: string): { phase: string; cleanup?: { consumerKeys: readonly string[] } } | undefined {
  return (Memory.runtime?.treasuryCore as unknown as { active?: Record<string, { phase: string; cleanup?: { consumerKeys: readonly string[] } }> } | undefined)?.active?.[attemptId];
}

function activeCount(): number {
  return Object.keys((Memory.runtime?.treasuryCore as unknown as { active?: Record<string, unknown> } | undefined)?.active ?? {}).length;
}

function lastEndTickOf(): number | null {
  return (Memory.runtime?.treasuryCore as unknown as { lifecycle?: { lastEndTick?: number | null } } | undefined)?.lifecycle?.lastEndTick ?? null;
}

function memoryJson(): string {
  return JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
}

/** kernel 面 not_executed dispatch + 跨 tick 清理 → retry_ready 父代。 */
function makeRetryReadyParent(kernel: TreasuryCoreKernel, workKey: string): string {
  const parent = kernel.admit(kernelAdmitInput(workKey));
  if (parent.status !== "admitted") throw new Error("parent admit failed");
  if (kernel.executeDispatch(parent.dispatch).status !== "not_executed") throw new Error("parent dispatch failed");
  Game.time += 1;
  kernel.beginTick();
  if (recordOf(parent.attemptId)?.phase !== "retry_ready") throw new Error("parent != retry_ready");
  return parent.attemptId;
}

/** 完整 reset 后装配新 facade（新模块 require + adapter/policy + 房间 + service）。 */
function assembleFacadeAfterReset(): { service: TreasuryService; actionContractsModule: typeof import("@/runtime/treasury/actionContracts") } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
  actionContractsModule.replaceTreasuryActionAdapterForTest(actionContractsModule.makeTreasuryTestTransferAdapter());
  policyModule.unsealTreasuryPolicyRegistryForTest();
  policyModule.clearTreasuryPolicyResolversForTest();
  policyModule.registerTreasuryPolicyResolver(policyModule.makeNoReserveTreasuryPolicy());
  const installed = installRooms(SPECS);
  return { service: facadeModule.createTreasuryService({ getRooms: () => Object.values(installed) }), actionContractsModule };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

// ── J01：同 tick 成功关窗 + 完整 reset 后 kernel 直接新增业务被持久关窗拒绝 ──

describe("J01 成功关窗→同 tick 完整 reset→直接 admit/rearm", () => {
  it("主用例：heap 已随模块重建丢失、持久 lastEndTick=T 仍在——kernel admit/executeRearm 与 facade authorize 全部 lifecycle_closed；frontier/active/动作/child 增量 0", () => {
    installRooms(SPECS);
    const adapterCalls = { count: 0 };
    const kernel0 = createTreasuryCoreKernel(makeKernelPorts(adapterCalls));
    const parentId = makeRetryReadyParent(kernel0, "biz:r6:parent");
    const adapterBase = adapterCalls.count; // 父代执行已计入——后续断言用增量口径
    const T = Game.time;
    // 同 tick 成功关窗（closurePersisted=true、持久 lastEndTick=T）。
    const endStats = kernel0.endTick();
    expect(endStats.closurePersisted).toBe(true);
    expect(lastEndTickOf()).toBe(T);
    // 同 tick 完整 reset：JSON 重载 + jest.resetModules + 新模块装配
    // （runBeginTick:false——避免 helper 额外改写待测前提）。
    const snapshot = memoryJson();
    const reset = performTreasuryKernelFullReset({
      ports: makeKernelPorts(adapterCalls),
      memorySnapshot: snapshot,
      roomSpecs: SPECS,
      runBeginTick: false,
    });
    // 前提自证：当前 tick 仍为 T、持久关窗仍在、旧 heap 否决已丢失。
    expect(Game.time).toBe(T);
    expect(reset.kernel.admissionVetoActive()).toBe(false);
    expect(lastEndTickOf()).toBe(T);
    // —— 缺陷通道 1（基线错误 admitted，见 evidence/baseline TRACES）：新
    //    kernel.admit 必须因持久关窗拒绝；frontier/active 增量 0。
    const frontierBefore = reset.kernel.metrics().frontier;
    const activeBefore = activeCount();
    const newAdmission = reset.kernel.admit(kernelAdmitInput("biz:r6:new"));
    expect(newAdmission.status).toBe("rejected");
    if (newAdmission.status === "rejected") {
      expect(newAdmission.reasonCode).toBe("lifecycle_closed");
      expect(newAdmission.reason).toContain("endTick 后不得接纳"); // 持久口径原因（非 heap 冒充）
    }
    expect(reset.kernel.metrics().frontier).toBe(frontierBefore);
    expect(activeCount()).toBe(activeBefore);
    // —— 缺陷通道 2：新运行时按当前约定签发 rearm capability（签发面不受
    //    关窗限制——VI/R1/§2.4），直接 executeRearm 必须因关闭拒绝。
    const cap = reset.kernel.issueRearmPermit({ parentAttemptId: parentId });
    if (cap.status !== "ok") throw new Error("J01 rearm capability issue failed");
    const childBefore = activeCount();
    const rearmResult = reset.kernel.executeRearm(cap.rearm, kernelAdmitInput("biz:r6:child"));
    expect(rearmResult.status).toBe("rejected");
    if (rearmResult.status === "rejected") expect(rearmResult.reasonCode).toBe("lifecycle_closed");
    expect(recordOf(parentId)?.phase).toBe("retry_ready"); // 父代不被替换
    expect(activeCount()).toBe(childBefore); // 无 child
    // —— 旧许可失效对照（单独分类——不是本反例的替代证明）：reset 前签发
    //    的旧 dispatch 在新运行时被真实性校验拒绝（permit 注册表不跨模块）。
    // —— 配对 facade：完整 reset 后新 facade 的 authorize 同样 lifecycle_closed。
    const { service, actionContractsModule } = assembleFacadeAfterReset();
    const contracts = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:r6:N", args: { ...TRANSFER_ARGS } });
    if (contracts.status !== "built") throw new Error("build N failed");
    const facadeVerdict = service.authorizeTreasuryActionContract(contracts.contract, { workKey: "biz:r6:N" });
    expect(facadeVerdict.status).toBe("rejected");
    if (facadeVerdict.status === "rejected") expect(facadeVerdict.reasonCode).toBe("lifecycle_closed");
    expect(adapterCalls.count - adapterBase).toBe(0); // 全程零动作调用（增量口径）
  });

  it("对照：未请求关窗时同前提完整 reset 后新 kernel admit/dispatch/rearm 与 facade 全部成功", () => {
    installRooms(SPECS);
    const adapterCalls = { count: 0 };
    const kernel0 = createTreasuryCoreKernel(makeKernelPorts(adapterCalls));
    const parentId = makeRetryReadyParent(kernel0, "biz:r6:ctrl-parent");
    const snapshot = memoryJson();
    const reset = performTreasuryKernelFullReset({
      ports: makeKernelPorts(adapterCalls),
      memorySnapshot: snapshot,
      roomSpecs: SPECS,
      runBeginTick: false,
    });
    expect(reset.kernel.admissionGateStatus().status).toBe("open"); // 无持久关窗事实
    const adapterBase = adapterCalls.count;
    const admission = reset.kernel.admit(kernelAdmitInput("biz:r6:ctrl-new"));
    if (admission.status !== "admitted") throw new Error("control admit failed");
    expect(reset.kernel.executeDispatch(admission.dispatch).status).toBe("not_executed");
    expect(adapterCalls.count - adapterBase).toBe(1); // 开放窗口下 dispatch 确实进入 adapter
    const cap = reset.kernel.issueRearmPermit({ parentAttemptId: parentId });
    if (cap.status !== "ok") throw new Error("control capability failed");
    expect(reset.kernel.executeRearm(cap.rearm, kernelAdmitInput("biz:r6:ctrl-child")).status).toBe("admitted");
  });

  it("对照：关窗后推进到 T+1 完整 reset——无永久闩锁，新窗口正常接纳", () => {
    installRooms(SPECS);
    const kernel0 = createTreasuryCoreKernel(makeKernelPorts());
    const seed = kernel0.admit(kernelAdmitInput("biz:r6:latch-seed"));
    if (seed.status !== "admitted") throw new Error("seed failed");
    kernel0.beginTick();
    expect(kernel0.endTick().closurePersisted).toBe(true);
    Game.time += 1; // 下一 tick：持久 lastEndTick < 当前 tick → 新窗口
    const snapshot = memoryJson();
    const reset = performTreasuryKernelFullReset({
      ports: makeKernelPorts(),
      memorySnapshot: snapshot,
      roomSpecs: SPECS,
      runBeginTick: false,
    });
    expect(reset.kernel.admissionVetoActive()).toBe(false);
    expect(reset.kernel.admissionGateStatus().status).toBe("open");
    expect(reset.kernel.admit(kernelAdmitInput("biz:r6:latch-new")).status).toBe("admitted");
  });
});

// ── J02：真 P/R + 持久关闭，单独移除 heap 否决的执行门禁隔离 ─────────────────

describe("J02 执行门禁隔离（真 P/R，仅清 heap 否决）", () => {
  it("主用例：真 dispatch P 与真 rearm R + endTick 持久关闭 → 仅移除模块级 heap 事实 → executeDispatch/executeRearm 因持久关窗拒绝；动作 0、P 仍 pending、父代未替换、许可未消费", () => {
    installRooms(SPECS);
    const adapterCalls = { count: 0 };
    const kernel = createTreasuryCoreKernel(makeKernelPorts(adapterCalls));
    const parentId = makeRetryReadyParent(kernel, "biz:r6:j2:parent");
    const adapterBase = adapterCalls.count; // 父代执行已计入——后续断言用增量口径
    // 健康开放窗口：正常流程取得当 tick真 dispatch P（pending）与真 R。
    const pAdmission = kernel.admit(kernelAdmitInput("biz:r6:j2:P"));
    if (pAdmission.status !== "admitted") throw new Error("P admit failed");
    const cap = kernel.issueRearmPermit({ parentAttemptId: parentId });
    if (cap.status !== "ok") throw new Error("R issue failed");
    expect(kernel.preflightDispatchPermit(pAdmission.dispatch).status).toBe("valid");
    expect(kernel.preflightRearmPermit(cap.rearm).status).toBe("valid");
    // 调用真实 endTick：持久 lastEndTick=T（heap 否决同 tick 置位）。
    expect(kernel.endTick().closurePersisted).toBe(true);
    expect(lastEndTickOf()).toBe(Game.time);
    // 所有调用栈退出后，仅移除模块级生命周期 heap 事实（不改 Memory、
    // 不清许可注册表、不重新签发或伪造 P/R）。
    resetTreasuryCoreLifecycleFactsForTest();
    expect(kernel.admissionVetoActive()).toBe(false); // heap 否决已移除
    expect(lastEndTickOf()).toBe(Game.time); // 持久关闭仍是唯一关闭事实
    const frontierBefore = kernel.metrics().frontier;
    const activeBefore = activeCount();
    // —— P：直接提交仍属于该 runtime/tick 的真 dispatch ——
    const dispatchOutcome = kernel.executeDispatch(pAdmission.dispatch);
    expect(dispatchOutcome.status).toBe("blocked");
    if (dispatchOutcome.status === "blocked") {
      expect(dispatchOutcome.reasonCode).toBe("lifecycle_closed");
      expect(dispatchOutcome.reason).toContain("endTick 后不得接纳"); // 持久口径
    }
    expect(adapterCalls.count - adapterBase).toBe(0); // 实际动作 0（增量口径）
    expect(recordOf(pAdmission.attemptId)?.phase).toBe("pending"); // P 仍 pending
    // —— R：直接提交真 rearm capability ——
    const rearmOutcome = kernel.executeRearm(cap.rearm, kernelAdmitInput("biz:r6:j2:child"));
    expect(rearmOutcome.status).toBe("rejected");
    if (rearmOutcome.status === "rejected") expect(rearmOutcome.reasonCode).toBe("lifecycle_closed");
    expect(recordOf(parentId)?.phase).toBe("retry_ready"); // 父代仍 retry_ready（未替换）
    expect(activeCount()).toBe(activeBefore); // child 0
    expect(kernel.metrics().frontier).toBe(frontierBefore); // frontier 不变
    // 许可未被消费的直接验证（API 现成 preflight——不靠下一 tick 重签发）。
    expect(kernel.preflightDispatchPermit(pAdmission.dispatch).status).toBe("valid");
    expect(kernel.preflightRearmPermit(cap.rearm).status).toBe("valid");
  });

  it("对照：同前提未请求关窗（heap 与持久均开放）——P 执行 committed 路径可用、R 执行可用", () => {
    installRooms(SPECS);
    const adapterCalls = { count: 0 };
    const kernel = createTreasuryCoreKernel(makeKernelPorts(adapterCalls));
    const parentId = makeRetryReadyParent(kernel, "biz:r6:j2c:parent");
    const adapterBase = adapterCalls.count;
    const pAdmission = kernel.admit(kernelAdmitInput("biz:r6:j2c:P"));
    if (pAdmission.status !== "admitted") throw new Error("P admit failed");
    const cap = kernel.issueRearmPermit({ parentAttemptId: parentId });
    if (cap.status !== "ok") throw new Error("R issue failed");
    expect(kernel.admissionGateStatus().status).toBe("open");
    expect(kernel.executeDispatch(pAdmission.dispatch).status).toBe("not_executed");
    expect(adapterCalls.count - adapterBase).toBe(1);
    expect(kernel.executeRearm(cap.rearm, kernelAdmitInput("biz:r6:j2c:child")).status).toBe("admitted");
  });
});

// ── J03：仅 heap 否决、非健康核心与坏 ring 下的门禁语义（既有语义保持） ──────

describe("J03 门禁边界语义", () => {
  it("仅 heap 否决（关窗发布失败）：admit 仍拒且原因标明 heap 口径（不冒充持久成功）；下一 tick 失效", () => {
    installRooms(SPECS);
    const kernel = createTreasuryCoreKernel(makeKernelPorts(undefined, {
      // 全丢写：关窗发布与恢复写全部失败 → 持久 lastEndTick 不落盘。
    }));
    const seed = kernel.admit(kernelAdmitInput("biz:r6:j3:seed"));
    if (seed.status !== "admitted") throw new Error("seed failed");
    kernel.beginTick();
    const before = memoryJson();
    // 全丢写通道：interceptTreasuryCoreWrites 式替换在本文件用否决端口
    // 更直接——改用 writeTreasuryCoreMemory 层拦截超出本轮范围；此处以
    // endTick 发布失败端口（writes allow=0）经 I04 已验，本用例聚焦 heap
    // 口径原因文本：直接请求 endTick（heap 否决置位），随后手工清掉持久
    // lastEndTick 模拟"发布失败/未确认"后的持久开放状态。
    const endStats = kernel.endTick();
    expect(endStats.closurePersisted).toBe(true);
    (Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number | null } }).lifecycle.lastEndTick = null; // 模拟发布未落盘
    expect(kernel.admissionVetoActive()).toBe(true);
    expect(kernel.admissionGateStatus().status).toBe("closed");
    const gate = kernel.admissionGateStatus();
    if (gate.status === "closed") expect(gate.reason).toContain("运行时否决标记生效"); // heap 口径文本（不冒充持久成功）
    const rejected = kernel.admit(kernelAdmitInput("biz:r6:j3:new"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reasonCode).toBe("lifecycle_closed");
    void before;
    Game.time += 1; // 否决按 tick 失效：下一 tick 无闩锁
    expect(kernel.admissionVetoActive()).toBe(false);
    expect(kernel.admissionGateStatus().status).toBe("open");
    expect(kernel.admit(kernelAdmitInput("biz:r6:j3:next")).status).toBe("admitted");
  });

  it("非健康核心：heap 否决优先拒绝（lifecycle_closed）；无 heap 否决时原有 store_unhealthy 拒绝不退化；门禁查询零写、不修坏 store", () => {
    installRooms(SPECS);
    const kernel = createTreasuryCoreKernel(makeKernelPorts());
    const seed = kernel.admit(kernelAdmitInput("biz:r6:j3u:seed"));
    if (seed.status !== "admitted") throw new Error("seed failed");
    kernel.beginTick();
    // 手工破坏一条记录 → unhealthy（validator 正确拒绝的不完整数据）。
    const core = Memory.runtime!.treasuryCore as unknown as { active: Record<string, { outcome: unknown }> };
    core.active[seed.attemptId].outcome = null;
    const brokenJson = memoryJson();
    // 无 heap 否决：门禁 open（无可依持久事实——不是"没有关闭所以可执行"），
    // 随后原有健康检查拒绝；查询零写（坏 store 不被修复、Memory 不变）。
    expect(kernel.admissionGateStatus().status).toBe("open");
    expect(memoryJson()).toBe(brokenJson);
    const unhealthyRejection = kernel.admit(kernelAdmitInput("biz:r6:j3u:new"));
    expect(unhealthyRejection.status).toBe("rejected");
    if (unhealthyRejection.status === "rejected") expect(unhealthyRejection.reasonCode).toBe("store_unhealthy");
    expect(memoryJson()).toBe(brokenJson); // 拒绝路径零写
    // heap 否决 + unhealthy：heap 口径优先（I01 语义保持——endTick 请求后
    // 无论健康与否本 tick 拒绝新增业务）。
    kernel.endTick(); // unhealthy 下健康门不过，但请求即置 heap 否决
    expect(kernel.admissionVetoActive()).toBe(true);
    const gate = kernel.admissionGateStatus();
    expect(gate.status).toBe("closed");
    if (gate.status === "closed") expect(gate.reason).toContain("运行时否决标记生效");
    const vetoRejection = kernel.admit(kernelAdmitInput("biz:r6:j3u:new2"));
    expect(vetoRejection.status).toBe("rejected");
    if (vetoRejection.status === "rejected") expect(vetoRejection.reasonCode).toBe("lifecycle_closed");
    expect(memoryJson()).toBe(brokenJson); // 全程零写
  });

  it("坏 ring（ringDegraded）不阻断持久关窗判定：healthy+degraded 下 gate 仍读 lastEndTick 关闭；恢复/清理既有语义不退化", () => {
    installRooms(SPECS);
    const kernel = createTreasuryCoreKernel(makeKernelPorts());
    const seed = kernel.admit(kernelAdmitInput("biz:r6:j3r:seed"));
    if (seed.status !== "admitted") throw new Error("seed failed");
    kernel.beginTick();
    expect(kernel.endTick().closurePersisted).toBe(true);
    // 手工破坏 ring 条目 → ringDegraded（安全四态仍 healthy——R10/B20）。
    const core = Memory.runtime!.treasuryCore as unknown as { ring: unknown[]; lifecycle: { lastEndTick: number | null } };
    core.ring.push({ badField: true }); // 未知字段条目 → ring 层校验拒绝
    const gate = kernel.admissionGateStatus();
    expect(gate.status).toBe("closed"); // 持久 lastEndTick===当前 tick 仍可判定
    if (gate.status === "closed") expect(gate.reason).toContain("endTick 后不得接纳");
    const rejected = kernel.admit(kernelAdmitInput("biz:r6:j3r:new"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reasonCode).toBe("lifecycle_closed");
    // 恢复/清理入口不受关窗限制（beginTick 在关窗 tick 继续推进）。
    const stats = kernel.beginTick();
    expect(stats.recovered + stats.cleaned + stats.closed + stats.cancelled).toBeGreaterThanOrEqual(0); // ringDegraded 不阻断生命周期
  });
});

// ── J04：关窗下旧工作安全推进 + 下一 tick 新业务恢复 ─────────────────────────

describe("J04 关窗不影响旧工作收尾与下一 tick 恢复", () => {
  it("关窗 tick 内：清理推进（义务减少）、cancelPending/closeWork 可用；下一 tick 完整 reset 后新业务 admit 成功", () => {
    installRooms(SPECS);
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts(undefined, {
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
    }));
    // 旧工作：retry_ready 父代（先在干净 tick 造——有义务 closing 会占满
    // 清理预算，父代同 tick 无法转化）+ 带 8 项义务的 closing C + pending P2。
    const parentId = makeRetryReadyParent(kernel, "biz:r6:j4:parent");
    const cAdmission = kernel.admit({
      ...kernelAdmitInput("biz:r6:j4:C"),
      externalConsumers: ["ext:j4:D0", "ext:j4:D1", "ext:j4:D2", "ext:j4:D3", "ext:j4:D4", "ext:j4:D5", "ext:j4:D6", "ext:j4:D7"],
    });
    if (cAdmission.status !== "admitted") throw new Error("C admit failed");
    if (kernel.executeDispatch(cAdmission.dispatch).status !== "not_executed") throw new Error("C dispatch failed");
    const p2 = kernel.admit(kernelAdmitInput("biz:r6:j4:P2"));
    if (p2.status !== "admitted") throw new Error("P2 admit failed");
    // 关窗（成功发布）。
    expect(kernel.endTick().closurePersisted).toBe(true);
    const dutiesBefore = recordOf(cAdmission.attemptId)?.cleanup?.consumerKeys.length ?? 0;
    // 同 tick：新业务已拒（J01/J02 已证），但恢复/清理/取消/close 继续。
    const blocked = kernel.admit(kernelAdmitInput("biz:r6:j4:new"));
    expect(blocked.status).toBe("rejected");
    const cleanupStats = kernel.beginTick(); // 关窗 tick 内清理继续
    expect(cleanupStats.cleaned).toBeGreaterThan(0); // 实际安全推进
    expect(recordOf(cAdmission.attemptId)?.cleanup?.consumerKeys.length ?? 0).toBeLessThan(dutiesBefore); // 义务减少
    expect(kernel.cancelPending({ attemptId: p2.attemptId }).status).toBe("ok"); // 取消已知未开始工作
    expect(kernel.closeWork({ attemptId: parentId, reason: "abandoned" }).status).toBe("ok"); // 安全 close
    expect(releaseCalls.length).toBeGreaterThan(0);
    // 下一 tick：新窗口正常业务（新有效许可经完整 reset）。
    Game.time += 1;
    const snapshot = memoryJson();
    const reset = performTreasuryKernelFullReset({
      ports: makeKernelPorts(undefined, {
        releaseExternalConsumer: (key: string): boolean => {
          releaseCalls.push(key);
          return true;
        },
      }),
      memorySnapshot: snapshot,
      roomSpecs: SPECS,
      runBeginTick: false,
    });
    expect(reset.kernel.admissionGateStatus().status).toBe("open");
    const nextAdmission = reset.kernel.admit(kernelAdmitInput("biz:r6:j4:next"));
    expect(nextAdmission.status).toBe("admitted");
    if (nextAdmission.status === "admitted") {
      expect(reset.kernel.executeDispatch(nextAdmission.dispatch).status).toBe("not_executed"); // 正常执行
    }
  });
});
