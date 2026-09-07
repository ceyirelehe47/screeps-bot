/**
 * Treasury Core Rewrite IV · Remediation IV——内核层 H 矩阵（任务书 §6）。
 *
 * 覆盖：H01（独立 endTick 反向重入：嵌套零推进/预算不回退/后续正常窗口
 * 真正处理 C）、H02（另一同模块 kernel 重入 + 同 tick 顺序 begin/end）、
 * H03（begin/end 四方向互斥 + 多条 dispatching 恢复）、H04（回调/端口异常
 * 与已推进时关窗）、H05（回调请求 endTick 后 facade 业务阻断）、H06（预扣/
 * 确认/关窗/尾部发布故障 + 硬切点完整 reset）、H07（G01–G08 核心行为抽查）、
 * H18（满载 + 混合负载逐 tick 完整 reset）。service/工具层 H08–H17 见
 * treasuryRemediationIVService.test.ts；H19/H20 由最终验证与 negative-
 * variants 承担。
 */
import {
  performTreasuryKernelFullReset,
  captureTreasuryHostBreakpoint,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import {
  buildTreasuryCoreWorstWorkRecord,
  readTreasuryCoreStoreHealth,
  treasuryCoreSerializedChars,
} from "@/runtime/treasury/kernel/store";
import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_TOTAL_CHAR_BUDGET,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";

/** H05 的 facade 授权观察房间（结构存在——授权判定需真实房间）。 */
const H5_ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 } },
  { name: "W2N57", storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 }, terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 200_000 } },
];

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
    findAdapter: (kind: string) =>
      kind.startsWith("h1.capture")
        ? { kind, version: 1, registrationId: `reg-${kind}`, semanticIdentity: `d.adapter-${kind}`, execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : { kind, version: 1, registrationId: `reg-${kind}`, semanticIdentity: `d.adapter-${kind}`, execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const },
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

interface ActiveShape {
  phase: string;
  outcome?: string;
  cleanup: { consumerKeys: readonly string[]; cursor: number; failures?: number };
}

function activeShape(attemptId: string): ActiveShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, ActiveShape> } | undefined;
  return store?.active?.[attemptId];
}

function readBudget(): number {
  return (Memory.runtime?.treasuryCore as unknown as { recovery?: { budgetUsed?: number } } | undefined)?.recovery?.budgetUsed ?? 0;
}

/** H01/H02/H03 共用 fixture 构造：A=真实执行边界 dispatching 残留、C=closing 8 义务、预算 0。 */
function buildDispatchingAndClosingFixture(ports: TreasuryCoreKernelPorts): { aId: string; cId: string; breakpoint: TreasuryHostBreakpoint } {
  const kernel0 = createTreasuryCoreKernel(ports);
  let captured: TreasuryHostBreakpoint | undefined;
  const capturePorts: TreasuryCoreKernelPorts = {
    ...ports,
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
            captured = captureTreasuryHostBreakpoint(); // dispatch_start 已发布、dispatch_result 未写
            return { ok: false };
          },
        };
      }
      return ports.findAdapter(kind);
    },
  };
  const kernelCapture = createTreasuryCoreKernel(capturePorts);
  const consumers = ["ext:r4:D0", "ext:r4:D1", "ext:r4:D2", "ext:r4:D3", "ext:r4:D4", "ext:r4:D5", "ext:r4:D6", "ext:r4:D7"];
  const c = kernel0.admit(kernelAdmitInput(consumers, "biz:r4:C"));
  if (c.status !== "admitted") throw new Error("admit C failed");
  if (kernel0.executeDispatch(c.dispatch).status !== "not_executed") throw new Error("C dispatch failed");
  const a = kernelCapture.admit(kernelAdmitInput([], "biz:r4:A", "h1.capture"));
  if (a.status !== "admitted") throw new Error("admit A failed");
  void kernelCapture.executeDispatch(a.dispatch);
  if (captured === undefined) throw new Error("断点未捕获");
  return { aId: a.attemptId, cId: c.attemptId, breakpoint: captured };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

// ── H01：独立 endTick 反向重入（R1 主验收） ─────────────────────────────────

describe("H01 独立 endTick 反向重入", () => {
  it("onEffect 重入同 kernel beginTick：嵌套零推进、预算 1→1→7 不回退、累计释放 3、后续正常窗口真正处理 C", () => {
    const releaseCalls: string[] = [];
    const budgetTrace: number[] = [];
    let kernelNow: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let nestedStats: { recovered: number; closed: number; cleaned: number; cancelled: number } | undefined;
    let reentered = false;
    let aId = "";
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
      onEffect: (effect: unknown) => {
        const typed = effect as { effect?: string; attemptId?: string };
        if (typed?.effect === "recovered_to_unknown" && typed.attemptId === aId && !reentered) {
          reentered = true;
          nestedStats = kernelNow.beginTick(); // 回调重入——修复后必须零推进
          budgetTrace.push(readBudget()); // 嵌套返回时刻的持久预算
        }
      },
    });
    const fx = buildDispatchingAndClosingFixture(ports);
    aId = fx.aId;
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, runBeginTick: false });
    kernelNow = reset.kernel;
    expect(activeShape(fx.aId)?.phase).toBe("dispatching"); // A 为真实执行边界残留
    expect(readBudget()).toBe(0); // 选定 tick 持久预算 0

    kernelNow.endTick(); // 独立 endTick（首个生命周期入口）：恢复 A（0→1）
    const afterEnd = readBudget();
    kernelNow.beginTick(); // 同 tick 正常窗口：处理 C（1→7，释放 3 项）
    const afterBegin = readBudget();

    expect(nestedStats).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // 嵌套零推进
    expect(afterEnd).toBeGreaterThanOrEqual(budgetTrace[0] ?? 0); // 预算不回退（外层返回不覆盖较新事实）
    expect(afterEnd).toBe(1); // A 恢复恰耗 1 份
    expect(afterBegin).toBe(7); // 正常窗口 3 项成对消耗
    expect(releaseCalls).toEqual(["ext:r4:D0", "ext:r4:D1", "ext:r4:D2"]); // 累计释放 3（≤4）
    expect(activeShape(fx.cId)?.phase).toBe("closing"); // C 未被禁掉全部清理——仍在推进
    expect(activeShape(fx.cId)?.cleanup.consumerKeys.length).toBe(5); // 剩余义务下一 tick 继续
    // 下一 tick 继续处理剩余义务（不停摆；预算随 tick 重置）。
    Game.time += 1;
    kernelNow.beginTick();
    expect(readBudget()).toBe(8); // 剩余 5 项中清 4 项（8 份）后耗尽停在耗尽处
    expect(releaseCalls.length).toBe(7); // 3 + 4
  });
});

// ── H02：另一同模块 kernel 重入 + 同 tick 顺序 begin/end ────────────────────

describe("H02 跨实例同域互斥", () => {
  it("kernelB 回调内嵌套 begin/end 零推进；外层返回后顺序 beginTick 处理 C、endTick 预算不下降", () => {
    const releaseCalls: string[] = [];
    let kernelB: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let nestedBegin: { recovered: number; closed: number; cleaned: number; cancelled: number } | undefined;
    let reentered = false;
    let aId = "";
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
      onEffect: (effect: unknown) => {
        const typed = effect as { effect?: string; attemptId?: string };
        // 恢复回调内：另一同模块实例请求推进与关窗（guard 不按实例分锁）。
        if (typed?.effect === "recovered_to_unknown" && typed.attemptId === aId && !reentered) {
          reentered = true;
          nestedBegin = kernelB.beginTick();
          kernelB.endTick();
        }
      },
    });
    const fx = buildDispatchingAndClosingFixture(ports);
    aId = fx.aId;
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, runBeginTick: false });
    // 同模块另一实例：reset 后 require 与 harness 用同一新模块缓存（模块级
    // guard 共享；顶层 import 是旧模块副本——不算同模块实例）。
    const kernelModule2 = require("@/runtime/treasury/kernel/kernel") as typeof import("@/runtime/treasury/kernel/kernel");
    kernelB = kernelModule2.createTreasuryCoreKernel(ports); // 不同对象引用、同模块、共享 Memory
    reset.kernel.endTick(); // 独立 endTick：恢复 A（0→1）；回调嵌套零推进
    const afterEnd = readBudget();
    const lastEndAtEnd = (Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number } }).lifecycle.lastEndTick;
    expect(afterEnd).toBe(1); // 嵌套 beginTick 未推进（1 而非 7）
    expect(nestedBegin).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 });
    expect(lastEndAtEnd).toBe(Game.time); // 嵌套/外层关窗都生效
    expect(releaseCalls).toEqual([]); // 嵌套期间零释放

    // 同 tick 顺序调用：beginTick 处理 C（1→7）→ endTick 收尾（7 不下降）。
    kernelB.beginTick();
    const afterBegin = readBudget();
    kernelB.endTick();
    const afterFinalEnd = readBudget();
    expect(afterBegin).toBe(7);
    expect(afterFinalEnd).toBe(7); // 成功预算发布不下降
    expect(releaseCalls.length).toBe(3); // 累计释放 3 ≤4
    expect(readBudget()).toBeLessThanOrEqual(8); // 累计份额 ≤8
  });
});

// ── H03：四方向互斥与多条 dispatching 恢复 ──────────────────────────────────

describe("H03 begin/end 四方向互斥", () => {
  it("begin→begin / begin→end / end→begin / end→end 均非递归推进；关窗仍执行；已恢复记录不重复推进", () => {
    // fixture：A1/A2 两条 dispatching + C closing。
    const releaseCalls: string[] = [];
    const directionStats: { dir: string; stats: unknown }[] = [];
    let kernelA: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let kernelB: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let aIdLocal = "";
    let phase = 0; // 0=首次恢复回调（end→begin + end→end 嵌套）
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
      onEffect: (effect: unknown) => {
        const typed = effect as { effect?: string; attemptId?: string };
        if (typed?.effect !== "recovered_to_unknown") return;
        if (typed.attemptId === aIdLocal && phase === 0) {
          phase = 1;
          // endTick 持有推进期间（外层独立 endTick）：begin→begin 形态（嵌套
          // beginTick 零推进）与 end→begin / end→end（嵌套关窗）。
          directionStats.push({ dir: "end→begin", stats: kernelB.beginTick() });
          kernelB.endTick(); // end→end：嵌套关窗（幂等，只写关窗事实）
        }
      },
    });
    const fx = buildDispatchingAndClosingFixture(ports);
    aIdLocal = fx.aId;
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, runBeginTick: false });
    kernelA = reset.kernel;
    kernelB = (require("@/runtime/treasury/kernel/kernel") as typeof import("@/runtime/treasury/kernel/kernel")).createTreasuryCoreKernel(ports); // 同模块另一实例
    void kernelA;

    const endStats = kernelB.endTick(); // 外层 endTick：恢复 A（0→1）→ onEffect 嵌套（end→begin/end）
    expect(endStats.recoveredToUnknown).toBe(1); // 外层实际恢复 A 一条
    for (const d of directionStats) {
      expect(d.stats).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // end→begin/end 均零推进
    }
    expect(directionStats.length).toBe(1);
    // 关窗在嵌套请求下已生效（不吞关窗）。
    expect((Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number } }).lifecycle.lastEndTick).toBe(Game.time);
    expect(releaseCalls).toEqual([]); // 嵌套期间零释放
    expect(readBudget()).toBe(1); // 仅外层 A 恢复消耗
    // begin→begin / begin→end：beginTick 持有推进期间的嵌套请求（release
    // 回调；与 reset.kernel 同模块——顺序调用正常推进，嵌套零推进）。
    let beginNested: { recovered: number; closed: number; cleaned: number; cancelled: number } | undefined;
    const portsBegin = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        if (key === "ext:r4:D0" && beginNested === undefined) {
          beginNested = kernelB.beginTick(); // begin→begin：嵌套零推进
          kernelB.endTick(); // begin→end：嵌套关窗
        }
        return true;
      },
    });
    const kernelBegin = (require("@/runtime/treasury/kernel/kernel") as typeof import("@/runtime/treasury/kernel/kernel")).createTreasuryCoreKernel(portsBegin);
    kernelBegin.beginTick(); // 处理 C——回调内嵌套 begin/end
    expect(beginNested).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // begin→begin/end 均零推进
    expect(releaseCalls).toEqual(["ext:r4:D0", "ext:r4:D1", "ext:r4:D2"]); // 外层 beginTick 正常清理（3 项）
  });

  it("多条 dispatching 恢复事件逐条推进、事件计数对应", () => {
    Game.time += 1; // 独立 tick（避免与前一用例同 tick 同 workKey 冲突）
    const recoveredEvents: string[] = [];
    let kernel1: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (): boolean => true,
      onEffect: (effect: unknown) => {
        const typed = effect as { effect?: string; attemptId?: string };
        if (typed?.effect === "recovered_to_unknown") recoveredEvents.push(typed.attemptId ?? "?");
      },
    });
    const fx = buildDispatchingAndClosingFixture(ports);
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, runBeginTick: false });
    kernel1 = reset.kernel;
    // 恢复的 Memory 上再放第二条 dispatching 残留（手工记录——与 A 同型）。
    const core = Memory.runtime!.treasuryCore as unknown as { active: Record<string, Record<string, unknown>>; issuance: { frontier: number } };
    const clone = { ...core.active[fx.aId], attemptId: "tk1_h3_second", workKey: "biz:h3:A2" };
    core.active["tk1_h3_second"] = clone;
    core.issuance.frontier += 1;
    const stats = kernel1.endTick();
    expect(stats.recoveredToUnknown).toBe(2); // 两条 dispatching 都恢复（各 1 份）
    expect(recoveredEvents.length).toBe(2); // 事件与实际推进一一对应
    expect(recoveredEvents).toContain(fx.aId);
    expect(recoveredEvents).toContain("tk1_h3_second");
  });
});

// ── H04：回调/端口异常与已推进时关窗 ───────────────────────────────────────

describe("H04 异常路径与关窗共存", () => {
  it("onEffect throw：持久成功写保留、guard 释放、下一正常调用可继续；release throw 不当完成；已推进时 endTick 关窗不覆盖预算", () => {
    const releaseCalls: string[] = [];
    let throwOnce = false;
    let kernel1: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
      onEffect: (effect: unknown) => {
        const typed = effect as { effect?: string };
        if (typed?.effect === "recovered_to_unknown" && !throwOnce) {
          throwOnce = true;
          throw new Error("onEffect 普通异常"); // 写入已完成后的回调异常
        }
      },
    });
    const fx = buildDispatchingAndClosingFixture(ports);
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, runBeginTick: false });
    kernel1 = reset.kernel;
    expect(() => kernel1.endTick()).toThrow("onEffect 普通异常"); // 异常冒泡
    expect(activeShape(fx.aId)?.phase).toBe("outcome_unknown"); // 成功写不被撤销（A 已恢复）
    // guard 已释放：下一正常调用可继续（C 清理推进）。
    const stats = kernel1.beginTick();
    expect(stats.cleaned).toBe(3); // 0+1? 预算——endTick 异常发生在 A 写之后：used 已 1 → 清 3 项（1→7）
    expect(releaseCalls.length).toBe(3);

    // 已推进时再请求关窗：endTick 不递归恢复、关窗生效、不覆盖预算/游标。
    Game.time += 1;
    let nestedDuringBegin = false;
    let cleanedTotal = 0;
    const ports2 = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        if (key === "ext:r4:D3") {
          nestedDuringBegin = true;
          kernel1.endTick(); // 推进持有期间请求关窗
        }
        return key !== "ext:r4:D5" ? true : (() => { throw new Error("release 端口异常"); })();
      },
    });
    // 用 ports2 重建推进（同 Memory 继续清理剩余义务）。
    const kernel2 = createTreasuryCoreKernel(ports2);
    const stats2 = kernel2.beginTick();
    cleanedTotal = stats2.cleaned;
    expect(nestedDuringBegin).toBe(true); // 关窗请求发生在推进中
    expect((Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number } }).lifecycle.lastEndTick).toBe(Game.time); // 关窗及时生效
    expect(readBudget()).toBeGreaterThanOrEqual(2); // 预算未被嵌套关窗清零/回退
    expect(cleanedTotal).toBeGreaterThanOrEqual(1); // 恢复和清理仍可继续
    // release 端口 throw：被当 false（义务不释放、不当完成），不冒泡中断推进。
    expect(activeShape(fx.cId)?.phase).toBe("closing");
  });
});

// ── H05：回调请求 endTick 后共享关窗阻断业务（facade 实际入口） ─────────────

describe("H05 共享关窗阻断业务", () => {
  it("推进回调内请求 endTick：回调内及外层返回后 authorize/dispatch/rearm 全拒；恢复清理继续；同 tick begin 不重开窗口", () => {
    const releaseCalls: string[] = [];
    let kernelMock: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let service: import("@/runtime/treasury/facade").TreasuryService = undefined as unknown as import("@/runtime/treasury/facade").TreasuryService;
    let askedInCallback = false;
    let authorizeInCallback = "";
    let authorizeAfterOuter = "";
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        if (!askedInCallback) {
          askedInCallback = true;
          service.endTick(); // 推进持有期间请求关窗（嵌套 endTick——只写关窗事实）
          const verdict = service.authorizeTreasuryActionContract({
            actionKind: "test.transfer",
            version: 1,
            args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 10, outcome: "ok" },
          }, { workKey: "biz:h5:in-callback" });
          authorizeInCallback = verdict.status === "rejected" ? verdict.reasonCode ?? "rejected" : verdict.status;
        }
        return true;
      },
    });
    const fx = buildDispatchingAndClosingFixture(ports);
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: fx.breakpoint, roomSpecs: H5_ROOMS, runBeginTick: false });
    kernelMock = reset.kernel;
    // facade service（新模块句柄）与 mock kernel 共享 Memory；guard 同模块共享。
    const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
    const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
    const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
    actionContractsModule.replaceTreasuryActionAdapterForTest(actionContractsModule.makeTreasuryTestTransferAdapter());
    policyModule.unsealTreasuryPolicyRegistryForTest();
    policyModule.clearTreasuryPolicyResolversForTest();
    policyModule.registerTreasuryPolicyResolver(policyModule.makeNoReserveTreasuryPolicy());
    const installed = installRooms(H5_ROOMS);
    service = facadeModule.createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick(); // 初始化授权观察（facade 窗口此时开启）

    kernelMock.beginTick(); // 推进：清理回调内请求关窗 + 尝试 authorize
    expect(authorizeInCallback).toBe("lifecycle_closed"); // 回调内业务被共享关窗阻断
    expect(releaseCalls.length).toBe(3); // 实际动作照常（清理推进不受关窗影响）
    // 外层返回后：authorize/rearm 仍拒。
    const builtAfter = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:h5:after", args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 10, outcome: "ok" } });
    if (builtAfter.status !== "built") throw new Error("build failed");
    const afterVerdict = service.authorizeTreasuryActionContract(builtAfter.contract, { workKey: "biz:h5:after" });
    authorizeAfterOuter = afterVerdict.status === "rejected" ? afterVerdict.reasonCode ?? "rejected" : afterVerdict.status;
    expect(authorizeAfterOuter).toBe("lifecycle_closed");
    // 同 tick beginTick 不重新开放窗口（恢复/清理继续，业务仍拒）。
    kernelMock.beginTick();
    const builtAgain = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:h5:again", args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 10, outcome: "ok" } });
    if (builtAgain.status !== "built") throw new Error("build failed");
    const againVerdict = service.authorizeTreasuryActionContract(builtAgain.contract, { workKey: "biz:h5:again" });
    expect(againVerdict.status).toBe("rejected");
    expect((againVerdict as { reasonCode?: string }).reasonCode).toBe("lifecycle_closed");
    // 下一 tick 正常开新窗口。
    Game.time += 1;
    service.beginTick();
    const builtNext = actionContractsModule.buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:h5:next", args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 10, outcome: "ok" } });
    if (builtNext.status !== "built") throw new Error("build failed");
    const nextVerdict = service.authorizeTreasuryActionContract(builtNext.contract, { workKey: "biz:h5:next" });
    expect(nextVerdict.status).not.toBe("rejected"); // 新窗口接纳成功
  });
});

// ── H06：发布故障与硬切点完整 reset ────────────────────────────────────────

describe("H06 预扣/确认/关窗/尾部发布故障与硬切点", () => {
  it("预扣写失败→端口不调用；确认写失败→份额不退、义务仍在；下一 tick 完成；endTick 尾写失败→不假报关窗成功", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const admitted = kernel.admit(kernelAdmitInput(["ext:h6:D0", "ext:h6:D1"], "biz:h6:C"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
    const cId = admitted.attemptId;

    // 预扣写失败：全部 treasuryCore 写被拦 → 端口 0 调用、义务仍在。
    const ic1 = interceptTreasuryCoreWrites({ allow: 0 });
    kernel.beginTick();
    ic1.restore();
    expect(releaseCalls).toEqual([]);
    expect(activeShape(cId)?.cleanup.consumerKeys.length).toBe(2);
    expect(readBudget()).toBe(0);

    // 确认写失败：预扣写（第 1 条）放行、后续全拦 → 端口已调用（份额不退），
    // 确认未写 → 义务仍在（下一 tick 继续）。
    const ic2 = interceptTreasuryCoreWrites({ allow: 1 });
    kernel.beginTick();
    ic2.restore();
    expect(releaseCalls).toEqual(["ext:h6:D0"]); // 端口在预扣成功后调用
    expect(readBudget()).toBe(2); // 预扣两份已持久（不退回）
    expect(activeShape(cId)?.cleanup.consumerKeys.length).toBe(2); // 确认未写——义务仍在
    expect(activeShape(cId)?.phase).toBe("closing");

    // 下一 tick 正常完成剩余义务（cursor 已发布 1——从 D1 起公平续清，D0 因
    // 上次确认未写仍保留、随后轮到）。
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls).toEqual(["ext:h6:D0", "ext:h6:D1", "ext:h6:D0"]); // D0（确认未写重试）经公平轮转
    expect(activeShape(cId)?.phase).toBe("retry_ready");

    // endTick 尾写失败：不假报持久关窗成功（lastEndTick 未写=事实如此）。
    const ic3 = interceptTreasuryCoreWrites({ allow: 0 });
    kernel.endTick();
    ic3.restore();
    expect((Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number | null } }).lifecycle.lastEndTick).not.toBe(Game.time);
  });

  it("选定硬切点（预扣后调用前）完整 reset：预算与下一位置保留、义务仍在、新 runtime guard 不残留、正常窗口完成", () => {
    const releaseCalls: string[] = [];
    let bp: TreasuryHostBreakpoint | undefined;
    let kernel1: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const admitted = kernel.admit(kernelAdmitInput(["ext:h6b:D0", "ext:h6b:D1", "ext:h6b:D2"], "biz:h6b:C"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
    const cId = admitted.attemptId;
    // 硬切点：预扣发布成功后、端口调用前（G07 模式——interceptor 放行首条
    // 预扣写，在放行回调里捕获断点；后续确认写被拦）。
    let callsAtBreakpoint = -1;
    const ic = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        bp = captureTreasuryHostBreakpoint();
        callsAtBreakpoint = releaseCalls.length;
      },
    });
    kernel.beginTick();
    ic.restore();
    if (bp === undefined) throw new Error("硬切点未捕获");
    expect(callsAtBreakpoint).toBe(0); // 断点时刻在端口调用之前（不是 catch 执行后的快照）
    expect(readBudget()).toBe(2); // 快照内：预扣两份已发布保留
    expect((JSON.parse(bp.memorySnapshot) as { runtime?: { treasuryCore?: { recovery?: { budgetUsed?: number } } } }).runtime?.treasuryCore?.recovery?.budgetUsed).toBe(2);

    // 完整 reset（硬切点状态分支）：新 runtime 从持久快照恢复（D0 预扣后
    // 未确认——义务完整保留在快照里）。
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: bp, runBeginTick: false });
    kernel1 = reset.kernel;
    expect(activeShape(cId)?.cleanup.consumerKeys.length).toBe(3); // 义务仍在（断点时刻确认未写）
    kernel1.beginTick(); // 正常窗口继续（新 runtime guard 无残留）
    expect(releaseCalls.slice(-3).sort()).toEqual(["ext:h6b:D0", "ext:h6b:D1", "ext:h6b:D2"]);
    expect(activeShape(cId)?.phase).toBe("retry_ready");
  });
});

// ── H07：原 G01–G08 核心行为抽查（单步确认/严格 true/公平不退化） ───────────

describe("H07 G01–G08 核心行为保留抽查", () => {
  it("当前成员单步确认、已确认项不再调用、错误真值不释放、记录内外公平推进不退化", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        // D0 返回错误真值（truthy 对象——不得被当作释放成功）。
        if (key === "ext:h7:D0") return { ok: false } as unknown as boolean;
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const admitted = kernel.admit(kernelAdmitInput(["ext:h7:D0", "ext:h7:D1", "ext:h7:D2", "ext:h7:D3"], "biz:h7:C"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
    const cId = admitted.attemptId;

    // tick1：8 份预算触达全部 4 项——D0（错误真值）不释放，D1–D3 释放。
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls).toEqual(["ext:h7:D0", "ext:h7:D1", "ext:h7:D2", "ext:h7:D3"]); // 每项恰一次（成对预算 2×4=8）
    expect(activeShape(cId)?.cleanup.consumerKeys.length).toBe(1); // 仅 D0 仍在
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls).toEqual(["ext:h7:D0", "ext:h7:D1", "ext:h7:D2", "ext:h7:D3", "ext:h7:D0"]); // D0 重试（错误真值持续不释放）
    expect(activeShape(cId)?.cleanup.consumerKeys.length).toBe(1);
    expect(activeShape(cId)?.cleanup.failures ?? 0).toBeGreaterThanOrEqual(1); // 失败责任不被删除
    // D0 的重复尝试遵守"同访问不重复尝试刚失败成员"：每 tick 至多一次。
    Game.time += 1;
    kernel.beginTick();
    const d0Calls = releaseCalls.filter((k) => k === "ext:h7:D0").length;
    expect(d0Calls).toBe(3); // 三个 tick 各恰一次（含当前）
  });
});

// ── H18（Remediation VI/V1 重写）：合法满载混合快照的逐 tick 完整 reset ────
//
// 旧 H18 的 fixture 不满足生产结构校验（closing 有确定 outcome 但
// outcomeEvidence=null、retry_ready/pending 的 outcome=null）：validator 正确
// 判 unhealthy → 生命周期静默早退 → 释放 0、零推进，而旧断言（≤4/unknown
// 计数/失败义务在）仍然通过——"没有工作就全绿"（VI/V1/§3.1 基线红灯）。
// 新版用合法且有来源解释的记录（VI/V1/§3.2）：pending 无调用侧事实；
// unknown 的不确定性来自支持的调用边界；closing 的确定结论与证据一致；
// retry_ready 是 exact not-executed 且义务已空。规模构成不变：30 closing
// （各 3 项义务，committed/not_executed 混合 + 1 项持续失败义务）、
// 20 outcome_unknown、10 retry_ready、4 pending，共 64 条。

interface H18Phases {
  closing: number;
  outcome_unknown: number;
  retry_ready: number;
  pending: number;
  other: number;
}

interface H18State {
  phases: H18Phases;
  remaining: number;
  active: number;
  ring: number;
  chars: number;
  budgetUsed: number;
}

function h18PhasesOf(core: { active: Record<string, { phase: string; cleanup?: { consumerKeys: readonly string[] } }>; ring: unknown[] }): H18Phases {
  const phases: H18Phases = { closing: 0, outcome_unknown: 0, retry_ready: 0, pending: 0, other: 0 };
  for (const record of Object.values(core.active)) {
    if (record.phase === "closing" || record.phase === "outcome_unknown" || record.phase === "retry_ready" || record.phase === "pending") {
      phases[record.phase] += 1;
    } else {
      phases.other += 1;
    }
  }
  return phases;
}

function h18StateOf(): H18State {
  const core = Memory.runtime!.treasuryCore as unknown as {
    active: Record<string, { phase: string; cleanup?: { consumerKeys: readonly string[] } }>;
    ring: unknown[];
    recovery: { budgetUsed: number };
  };
  let remaining = 0;
  for (const record of Object.values(core.active)) remaining += record.cleanup?.consumerKeys.length ?? 0;
  return {
    phases: h18PhasesOf(core),
    remaining,
    active: Object.keys(core.active).length,
    ring: core.ring.length,
    chars: treasuryCoreSerializedChars(Memory.runtime!.treasuryCore as never),
    budgetUsed: core.recovery.budgetUsed,
  };
}

/** J06 的进度判别函数：remaining 减少、阶段转移或 active 退出任一发生即真。 */
function h18HasProgress(before: H18State, after: H18State): boolean {
  return (
    after.remaining < before.remaining ||
    after.phases.closing !== before.phases.closing ||
    after.phases.retry_ready !== before.phases.retry_ready ||
    after.phases.pending !== before.phases.pending ||
    after.active !== before.active
  );
}

interface H18Fixture {
  ports: TreasuryCoreKernelPorts;
  releaseCalls: string[];
  failingKey: string;
  closingIds: string[];
  unknownIds: string[];
  retryIds: string[];
  pendingIds: string[];
  /** 宿主恢复失败端口（VI/V1/§3.3 失败恢复段）：此后失败义务返回原始 true。 */
  restoreFailingPort(): void;
}

/**
 * 构造合法满载混合快照（64 条）并返回宿主端口与记录 ID 集合。先经真实
 * admit 初始化 store（beginTick 不初始化缺失 store——须先 admit 一笔），再
 * 手工构造满载记录（业务 admit 走满 64 次受 fresh/policy 门禁干扰且与本
 * 调度测试无关；满载口径与 G18/I13 一致）。手工记录必须被生产 validator
 * 判 healthy（J05 断言）——不通过放宽 validator 过关。
 */
function buildH18MixedLoad(): H18Fixture {
  const releaseCalls: string[] = [];
  const failingKey = "ext:h18:C0:D0"; // C0（committed）的第一项义务持续失败
  let failing = true;
  const ports = makeKernelPorts({
    releaseExternalConsumer: (key: string): boolean => {
      releaseCalls.push(key);
      return !(failing && key === failingKey);
    },
  });
  const kernelInit = createTreasuryCoreKernel(ports);
  const initRecord = kernelInit.admit(kernelAdmitInput([], "biz:h18:init"));
  if (initRecord.status !== "admitted") throw new Error("init admit failed");
  const seedTick = Game.time;
  const idOf = (i: number): string => `tk1_h18_${i.toString().padStart(2, "0")}`;
  const recordOf = (i: number): Record<string, unknown> => {
    const consumers = i < 30 ? [`ext:h18:C${i}:D0`, `ext:h18:C${i}:D1`, `ext:h18:C${i}:D2`] : [];
    const phase = i < 30 ? "closing" : i < 50 ? "outcome_unknown" : i < 60 ? "retry_ready" : "pending";
    // 合法性来源（VI/V1/§3.2）：closing/retry_ready 的确定结论必须有结论
    // 一致的 outcomeEvidence；retry_ready 只允许 not_executed 且义务已空；
    // pending 不得持有任何调用侧事实；unknown 的不确定性来自调用边界。
    const outcome = phase === "closing" ? (i % 2 === 0 ? "committed" : "not_executed") : phase === "retry_ready" ? "not_executed" : "unknown";
    return {
      workKey: `biz:h18:W${i}`,
      attemptId: idOf(i),
      generation: 1,
      parentAttemptId: null,
      phase,
      admittedAtTick: seedTick,
      updatedAtTick: seedTick,
      identity: { ...kernelIdentity() },
      worstCase: kernelLegs(50),
      invocationBoundary: phase === "retry_ready" || phase === "pending" ? null : { atTick: seedTick, worldSequence: 1 },
      invocation: null,
      external: null,
      outcome,
      outcomeEvidence:
        phase === "closing" || phase === "retry_ready"
          ? { kind: "adapter_execution_semantics", conclusion: outcome === "committed" ? "executed" : "not_executed", source: "probe:h18", atTick: seedTick }
          : null,
      cleanup: { consumerKeys: consumers, failures: 0, cursor: 0 },
      retryDeadlineTick: phase === "retry_ready" ? seedTick + 40 : null,
      lastError: null,
    };
  };
  const memory = Memory.runtime!.treasuryCore as unknown as {
    active: Record<string, Record<string, unknown>>;
    ring: unknown[];
    ringCursor: number;
    issuance: { frontier: number; burned: number };
    lifecycle: { lastBeginTick: number | null; lastEndTick: number | null };
    recovery: { sweepCursor: number; cleanupCursor: number; budgetTick: number; budgetUsed: number };
  };
  delete memory.active[(initRecord as { attemptId: string }).attemptId];
  const closingIds: string[] = [];
  const unknownIds: string[] = [];
  const retryIds: string[] = [];
  const pendingIds: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    const record = recordOf(i);
    memory.active[record.attemptId as string] = record;
    if (i < 30) closingIds.push(idOf(i));
    else if (i < 50) unknownIds.push(idOf(i));
    else if (i < 60) retryIds.push(idOf(i));
    else pendingIds.push(idOf(i));
  }
  memory.issuance.frontier = 65;
  memory.lifecycle = { lastBeginTick: null, lastEndTick: null };
  memory.recovery = { sweepCursor: 0, cleanupCursor: 0, budgetTick: seedTick, budgetUsed: 0 };
  return {
    ports,
    releaseCalls,
    failingKey,
    closingIds,
    unknownIds,
    retryIds,
    pendingIds,
    restoreFailingPort(): void {
      failing = false;
    },
  };
}

describe("H18 满载合法混合快照与逐 tick 完整 reset", () => {
  it("J05：64 条合法混合（30 closing×3 义务/20 unknown/10 retry_ready/4 pending）被生产 validator 判 healthy；构成/证据/发行/期限一致；active 64、ring 与字符守界", () => {
    const fx = buildH18MixedLoad();
    const health = readTreasuryCoreStoreHealth();
    expect(health.status).toBe("healthy"); // 不通过放宽 validator 过关——旧 fixture 在此红
    const core = Memory.runtime!.treasuryCore as unknown as {
      active: Record<string, Record<string, unknown>>;
      ring: unknown[];
      issuance: { frontier: number };
    };
    expect(Object.keys(core.active).length).toBe(TREASURY_CORE_ACTIVE_LIMIT); // 满载
    expect(core.ring.length).toBeLessThanOrEqual(128);
    const state = h18StateOf();
    expect(state.phases).toEqual({ closing: 30, outcome_unknown: 20, retry_ready: 10, pending: 4, other: 0 });
    expect(state.remaining).toBe(90); // 30 closing × 3 项义务
    expect(state.chars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    expect(core.issuance.frontier).toBe(65);
    // 构成与证据一致性：closing 的 evidence 结论与 outcome 一致；unknown
    // 无确定结论但有调用边界；retry_ready exact not-executed + 义务空 +
    // 期限；pending 无任何调用侧事实。
    for (const [index, id] of fx.closingIds.entries()) {
      const record = core.active[id] as { outcome: string; outcomeEvidence: { conclusion: string }; invocationBoundary: unknown; cleanup: { consumerKeys: readonly string[] } };
      expect(record.outcomeEvidence.conclusion).toBe(record.outcome === "committed" ? "executed" : "not_executed");
      expect(record.invocationBoundary).not.toBeNull();
      expect(record.cleanup.consumerKeys.length).toBe(3);
      void index;
    }
    for (const id of fx.unknownIds) {
      const record = core.active[id] as { outcome: string; outcomeEvidence: unknown; invocationBoundary: unknown };
      expect(record.outcome).toBe("unknown");
      expect(record.outcomeEvidence).toBeNull();
      expect(record.invocationBoundary).not.toBeNull(); // 不确定性有支持的调用边界
    }
    for (const id of fx.retryIds) {
      const record = core.active[id] as { outcome: string; outcomeEvidence: { conclusion: string }; cleanup: { consumerKeys: readonly string[] }; retryDeadlineTick: number };
      expect(record.outcome).toBe("not_executed");
      expect(record.outcomeEvidence.conclusion).toBe("not_executed");
      expect(record.cleanup.consumerKeys.length).toBe(0); // exact not-executed 且义务已空
      expect(record.retryDeadlineTick).toBeGreaterThan(Game.time);
    }
    for (const id of fx.pendingIds) {
      const record = core.active[id] as { outcome: string; outcomeEvidence: unknown; invocationBoundary: unknown; invocation: unknown; external: unknown };
      expect(record.outcome).toBe("unknown");
      expect(record.outcomeEvidence).toBeNull();
      expect(record.invocationBoundary).toBeNull(); // 未开始不得伪造调用事实
      expect(record.invocation).toBeNull();
      expect(record.external).toBeNull();
    }
  });

  it("J06：12 tick 完整 reset 观察段逐 tick healthy/份额≤8/释放≤4、非零服务与真实进展、20 unknown exact 保留；有界收尾 + 失败恢复 + retry_ready 安全退出；终态只剩不对账 unknown", () => {
    const fx = buildH18MixedLoad();
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy"); // fixture 工厂失败即终止，不跳过断言
    const initial = h18StateOf();
    const perTick: { tick: number; shares: number; releases: number; phases: H18Phases; remaining: number; active: number; ring: number; chars: number }[] = [];
    // —— 12 tick 观察段：每 tick 真正 JSON 重载 + 模块重建 + 新工厂 kernel，
    //    推进前/后各核验一次 healthy（runBeginTick:false 后显式 begin）——
    //    不用旧工厂重新 new 代替完整 reset。
    for (let t = 0; t < 12; t += 1) {
      Game.time += 1;
      const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
      const releasesBefore = fx.releaseCalls.length;
      const reset = performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const storeModule = require("@/runtime/treasury/kernel/store") as typeof import("@/runtime/treasury/kernel/store");
      expect(storeModule.readTreasuryCoreStoreHealth().status).toBe("healthy"); // 推进前
      const stats = reset.kernel.beginTick();
      expect(storeModule.readTreasuryCoreStoreHealth().status).toBe("healthy"); // 推进后
      const after = h18StateOf();
      expect(after.budgetUsed).toBeLessThanOrEqual(8); // 每 tick 逻辑份额 ≤8（所有实例/入口累计）
      expect(fx.releaseCalls.length - releasesBefore).toBeLessThanOrEqual(4); // 每 tick 实际释放 ≤4
      // 20 条 unknown 按具体 ID 持续保留（不只数量碰巧等于 20）。
      for (const id of fx.unknownIds) {
        const record = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active[id];
        expect(record?.phase).toBe("outcome_unknown");
      }
      perTick.push({ tick: Game.time, shares: after.budgetUsed, releases: fx.releaseCalls.length - releasesBefore, phases: after.phases, remaining: after.remaining, active: after.active, ring: after.ring, chars: after.chars });
      void stats;
    }
    // 观察段断言：非零服务 + 真实进展（上限断言单独绿不构成通过）。
    const afterObs = h18StateOf();
    expect(fx.releaseCalls.length).toBeGreaterThan(0); // 实际 release 非零
    expect(h18HasProgress(initial, afterObs)).toBe(true);
    expect(afterObs.phases.pending).toBe(0); // pending 经安全取消退出（≤3/tick，2 tick 内完成）
    expect(afterObs.remaining).toBeLessThan(initial.remaining); // 合法 remaining 减少
    // 至少有可完成的 closing 完成其清理阶段（committed 退出 active 或
    // not_executed 进入 retry_ready）。
    const activePhases = Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> };
    const completedClosing = fx.closingIds.some((id) => activePhases.active[id] === undefined || activePhases.active[id].phase === "retry_ready");
    expect(completedClosing).toBe(true);
    // 失败义务不被删除；健康项不被失败项饿死（C1+ 的义务有真实服务）。
    const c0 = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { cleanup?: { consumerKeys: readonly string[] } }> }).active[fx.closingIds[0] as string];
    expect(c0?.cleanup?.consumerKeys).toContain(fx.failingKey);
    const healthyKeysServed = new Set(fx.releaseCalls.filter((k) => k.startsWith("ext:h18:C") && k !== fx.failingKey));
    expect(healthyKeysServed.size).toBeGreaterThan(0);
    // 成功确认的义务不再调用（每个成功 key 恰好一次）。
    for (const key of healthyKeysServed) {
      expect(fx.releaseCalls.filter((k) => k === key).length).toBe(1);
    }

    // —— 有界收尾段：静态工作集继续服务。保守上界推导（写明而非无限
    //    while）：89 个可完成义务 × 2 份 + 30 份 closing 退出/转化 + 失败
    //    义务恢复前每 tick 至多 2 份重试消耗；每 tick ≤8 份 ⇒ 义务侧
    //    ⌈(89×2+30)/8⌉ = 26 tick；加游标轮转/子预算调度余量取 40 tick 上界。
    //    所有 tick 仍真正 JSON 重载，不复制旧数字。
    let boundedTicks = 0;
    let stateNow = h18StateOf();
    while ((stateNow.remaining > 1 || (stateNow.phases.closing ?? 0) > 1) && boundedTicks < 40) {
      Game.time += 1;
      const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
      const releasesBefore = fx.releaseCalls.length;
      const reset = performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const storeModule = require("@/runtime/treasury/kernel/store") as typeof import("@/runtime/treasury/kernel/store");
      expect(storeModule.readTreasuryCoreStoreHealth().status).toBe("healthy");
      reset.kernel.beginTick();
      expect(storeModule.readTreasuryCoreStoreHealth().status).toBe("healthy");
      const after = h18StateOf();
      expect(after.budgetUsed).toBeLessThanOrEqual(8);
      expect(fx.releaseCalls.length - releasesBefore).toBeLessThanOrEqual(4);
      boundedTicks += 1;
      stateNow = after;
    }
    expect(boundedTicks).toBeLessThan(40); // 真实推进在明确上界内完成（非无限循环掩盖）

    // —— 失败恢复段：宿主把持续失败义务恢复为 true，剩余安全工作收尾 ——
    fx.restoreFailingPort();
    let recoveryTicks = 0;
    let c0Phase: string | undefined = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active[fx.closingIds[0] as string]?.phase;
    while (c0Phase !== undefined && recoveryTicks < 10) {
      Game.time += 1;
      const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
      const reset = performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const storeModule = require("@/runtime/treasury/kernel/store") as typeof import("@/runtime/treasury/kernel/store");
      expect(storeModule.readTreasuryCoreStoreHealth().status).toBe("healthy");
      reset.kernel.beginTick();
      expect(storeModule.readTreasuryCoreStoreHealth().status).toBe("healthy");
      recoveryTicks += 1;
      c0Phase = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active[fx.closingIds[0] as string]?.phase;
    }
    // C0（committed）义务清空 + 观察接管后退出 active（进 ring 终态）。
    expect((Memory.runtime!.treasuryCore as unknown as { active: Record<string, unknown> }).active[fx.closingIds[0] as string]).toBeUndefined();

    // —— retry_ready 安全退出：经正常业务放弃（closeWork abandoned），不
    //    直接 delete Memory。终态 active 只剩 20 条故意不对账的 unknown。
    const finalReset = performTreasuryKernelFullReset({ ports: fx.ports, runBeginTick: false });
    const retryLeft = Object.entries((Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active)
      .filter(([, r]) => r.phase === "retry_ready")
      .map(([id]) => id);
    for (const id of retryLeft) {
      const closed = finalReset.kernel.closeWork({ attemptId: id, reason: "abandoned" });
      expect(closed.status).toBe("ok");
    }
    const finalState = h18StateOf();
    expect(finalState.active).toBe(20); // 只剩 unknown
    expect(Object.keys((Memory.runtime!.treasuryCore as unknown as { active: Record<string, unknown> }).active).sort()).toEqual([...fx.unknownIds].sort());
    expect(finalState.phases).toEqual({ closing: 0, outcome_unknown: 20, retry_ready: 0, pending: 0, other: 0 });
    expect(finalState.ring).toBeLessThanOrEqual(128);
    expect(finalState.chars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    // eslint-disable-next-line no-console
    console.log(`H18-TRACE initial=${JSON.stringify(initial)} per-tick[0..2]=${JSON.stringify(perTick.slice(0, 3))} bounded-ticks=${JSON.stringify(boundedTicks)} recovery-ticks=${JSON.stringify(recoveryTicks)} total-release-calls=${JSON.stringify(fx.releaseCalls.length)} final=${JSON.stringify(finalState)}`);
  });

  it("零推进负向对照：healthy fixture 下生命周期推进为零时，J06 的进度/收尾指标全部零变化——上限与 unknown 保留断言单独绿不构成通过", () => {
    const fx = buildH18MixedLoad();
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy"); // 前提保持 healthy（不是又一份损坏数据测试）
    Game.time += 1;
    const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
    // 完整 reset（真实通道）但不调用 beginTick——受测生命周期推进被替换为
    // 零推进（最小变体：跳过推进入口本身）。
    performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
    const before = h18StateOf();
    const after = h18StateOf(); // 同一持久状态：零推进
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy");
    expect(fx.releaseCalls.length).toBe(0); // 无服务
    expect(after.remaining).toBe(before.remaining); // remaining 无减少
    expect(after.phases).toEqual(before.phases); // 无阶段转移
    expect(after.active).toBe(before.active); // 无退出
    expect(h18HasProgress(before, after)).toBe(false); // J06 进度判别函数在零推进轨迹上判 false
  });
});
