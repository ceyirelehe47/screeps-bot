/**
 * Remediation V/R1 基线反例（fb5e44b 专用，不入主仓测试树）。
 *
 * 断言的是**修复后**语义（先关窗后恢复回调）。在 fb5e44b 上：
 * - 对照用例（未请求关窗三候选成功）应当绿——证明候选确实合法；
 * - 三个反例用例必须红灯——基线把回调内/发布失败后的业务放行。
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

function recordOf(attemptId: string): { phase: string } | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, { phase: string }> } | undefined;
  return store?.active?.[attemptId];
}

function lastEndTickOf(): number | null {
  return (Memory.runtime?.treasuryCore as unknown as { lifecycle?: { lastEndTick?: number | null } } | undefined)?.lifecycle?.lastEndTick ?? null;
}

/**
 * R1 fixture：旧栈先经真实 service 入口造 retry_ready 父代（non-ok →
 * not_executed → 清理 → retry_ready），再造真实 dispatch_start 断点 A（kernel
 * 面 adapter execute 内捕获——dispatching 已发布、结果未写）。断点 Memory
 * 同时含 retry_ready 父代与 dispatching 的 A。
 */
function buildR1Fixture(): { parentId: string; aId: string; breakpoint: TreasuryHostBreakpoint } {
  const installed = installRooms(SPECS);
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
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
  const a = kernelCapture.admit(kernelAdmitInput("biz:r5:A", "h1.capture"));
  if (a.status !== "admitted") throw new Error("A admit failed");
  void kernelCapture.executeDispatch(a.dispatch);
  if (captured === undefined) throw new Error("断点未捕获");
  return { parentId: parent.attemptId, aId: a.attemptId, breakpoint: captured };
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

/**
 * 完整 kernel reset（runBeginTick:false——第一个恢复入口由用例决定）+ 新模块
 * facade + 计数 adapter。**不调用 service.beginTick()**（不得先把 A 恢复掉）。
 */
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

const TRANSFER_ARGS = { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 10, outcome: "ok" } as const;

interface Candidates {
  contractN: unknown;
  pending: { attemptId: string; dispatch: unknown };
  rearm: { status: string; rearm?: unknown };
  childContract: unknown;
  frontierBefore: number;
}

/**
 * 在窗口开启时准备三个合法候选：真 contract N（authorize 用）、真 pending
 * dispatch 许可 P、真 rearm capability R（父代 retry_ready 在断点 Memory 中）。
 * rearm child 合同按 H15 形态与父代同 transactionId/args 重建。
 */
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
  return { contractN: builtN.contract, pending: { attemptId: pAdmission.attemptId, dispatch: pAdmission.dispatch }, rearm: rearmVerdict, childContract: builtChild.contract, frontierBefore: rt.kernel.metrics().frontier };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

describe("R1 基线反例（fb5e44b）", () => {
  it("对照：未请求关窗时 authorize/dispatch/rearm 三候选全部成功（候选合法性证明）", () => {
    const rt = buildNewRuntime(makeKernelPorts(), buildR1Fixture());
    const c = prepareCandidates(rt);
    const authorizeVerdict = rt.service.authorizeTreasuryActionContract(c.contractN, { workKey: "biz:r5:N" });
    expect(authorizeVerdict.status).toBe("admitted");
    const dispatchOutcome = rt.service.executeAuthorizedDispatch(c.pending.dispatch);
    expect(dispatchOutcome.status).toBe("committed");
    const rearmVerdict = rt.service.executeRearm(c.rearm.rearm, c.childContract);
    expect(rearmVerdict.status).toBe("admitted");
    expect(rt.actionCalls.count).toBe(1);
  });

  it("反例 1：独立 endTick 首个恢复回调内 authorize/dispatch/rearm 必须已被关窗拒绝", () => {
    const inCallback: { authorize: unknown; dispatch: unknown; rearm: unknown; lastEndTickAtCallback: number | null } = {
      authorize: "not-run", dispatch: "not-run", rearm: "not-run", lastEndTickAtCallback: null,
    };
    let asked = false;
    let rtRef: NewRuntime = undefined as unknown as NewRuntime;
    let cRef: Candidates = undefined as unknown as Candidates;
    const ports = makeKernelPorts({
      onEffect: (effect) => {
        if (!asked && (effect as { effect?: string }).effect === "recovered_to_unknown") {
          asked = true;
          // 不额外调用嵌套 endTick——直接经实际 facade 提交三个合法候选。
          inCallback.lastEndTickAtCallback = lastEndTickOf();
          try {
            inCallback.authorize = rtRef.service.authorizeTreasuryActionContract(cRef.contractN, { workKey: "biz:r5:N" });
          } catch (e) { inCallback.authorize = `threw:${String(e)}`; }
          try {
            inCallback.dispatch = rtRef.service.executeAuthorizedDispatch(cRef.pending.dispatch);
          } catch (e) { inCallback.dispatch = `threw:${String(e)}`; }
          try {
            inCallback.rearm = rtRef.service.executeRearm(cRef.rearm.rearm, cRef.childContract);
          } catch (e) { inCallback.rearm = `threw:${String(e)}`; }
        }
      },
    });
    const fx = buildR1Fixture();
    rtRef = buildNewRuntime(ports, fx);
    cRef = prepareCandidates(rtRef);
    const endStats = rtRef.kernel.endTick();
    expect(endStats.recoveredToUnknown).toBe(1); // A 真实恢复（回调确实发生）
    expect(asked).toBe(true);
    // ── 修复后语义（fb5e44b 红灯：基线把三条业务放行）──
    expect(inCallback.lastEndTickAtCallback).toBe(Game.time); // 回调进入前已关窗
    expect(inCallback.authorize).toMatchObject({ status: "rejected", reasonCode: "lifecycle_closed" });
    expect(inCallback.dispatch).toMatchObject({ status: "blocked", reasonCode: "lifecycle_closed" });
    expect(inCallback.rearm).toMatchObject({ status: "rejected", reasonCode: "lifecycle_closed" });
    expect(rtRef.actionCalls.count).toBe(0); // 实际动作调用 0
    expect(rtRef.kernel.metrics().frontier).toBe(cRef.frontierBefore); // 发行增量 0
  });

  it("反例 2：关窗发布失败（全部丢写）后同运行时另一 facade 的合法业务仍必须被拒", () => {
    const rt = buildNewRuntime(makeKernelPorts(), buildR1Fixture());
    prepareCandidates(rt);
    const serviceB = rt.facadeModule.createTreasuryService({ getRooms: () => Object.values(rt.rooms) });
    const ic = interceptTreasuryCoreWrites({ allow: 0 });
    rt.service.endTick();
    ic.restore();
    expect(lastEndTickOf()).not.toBe(Game.time); // 持久关窗确实未发布（丢写事实）
    const builtB = rt.actionContractsModule.buildTreasuryActionContract(serviceB, { actionKind: "test.transfer", transactionId: "biz:r5:B", args: { ...TRANSFER_ARGS } });
    if (builtB.status !== "built") throw new Error("build B failed");
    const verdictB = serviceB.authorizeTreasuryActionContract(builtB.contract, { workKey: "biz:r5:B" });
    // ── 修复后语义（fb5e44b 红灯：基线放行 admitted）──
    expect(verdictB.status).toBe("rejected");
    expect((verdictB as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
    // 恢复正常写后可确认关闭：
    serviceB.endTick();
    expect(lastEndTickOf()).toBe(Game.time);
  });

  it("反例 3：onEffect 抛错后窗口必须仍关闭、guard 可再获取、已发布恢复保留", () => {
    let threw = false;
    const ports = makeKernelPorts({
      onEffect: () => { throw new Error("R1-BASE 回调故障注入"); },
    });
    const fx = buildR1Fixture();
    const rt = buildNewRuntime(ports, fx);
    const c = prepareCandidates(rt);
    try {
      rt.kernel.endTick();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(recordOf(fx.aId)?.phase).toBe("outcome_unknown"); // 已发布恢复事实保留
    const advance = rt.kernel.beginTick(); // guard 已释放（可再获取）
    expect(advance).toBeDefined();
    // ── 修复后语义（fb5e44b 红灯：异常路径尾写被跳过、窗口仍开、业务放行）──
    expect(lastEndTickOf()).toBe(Game.time);
    const verdict = rt.service.authorizeTreasuryActionContract(c.contractN, { workKey: "biz:r5:N" });
    expect(verdict.status).toBe("rejected");
    expect((verdict as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
  });
});
