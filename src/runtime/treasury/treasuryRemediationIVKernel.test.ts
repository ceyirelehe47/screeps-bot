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
import {
  createSealTraceRecorder,
  sealBuildUnknownRiskBaseline,
  sealCompareUnknownRisk,
  sealSnapshotUnknownRisk,
  sealVerifyTraceCompleteness,
  sealWriteEvidence,
  SEAL_FIELD_ABSENT,
  type SealCheckpoint,
  type SealPortEvent,
  type SealRiskDiff,
  type SealSegmentFacts,
  type SealStateView,
  type SealTraceDoc,
  type SealTracePoint,
  type SealTraceStage,
} from "@mock/treasurySealEvidence";
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

// ── H18（Remediation VI/V1 重写；Core Candidate Seal I 全轨迹化）──────────
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
//
// Seal I/§2（K02/K03）补全证据：全程轨迹（初始基线、逐 tick 重载前/推进
// 后、有限收尾、失败恢复、最终 close——不 slice 截断）+ 20 条 unknown 的
// 风险事实独立深快照（JSON 往返脱离 Memory 引用）与逐字段基线比较
// （identity/完整 worstCase 腿/调用边界三件套/outcome/证据/义务归属）。
// 轨迹导出仅当环境变量 TREASURY_SEAL_EVIDENCE_DIR 已设置时落盘；未设置
// 时全部断言照常执行（不 skip）。失败路径保留已捕获的部分轨迹并标记
// incomplete，不在 finally 补造成功终态。

// type alias（非 interface）：纯数据字段类型获得隐式索引签名，可直接进入
// Seal 轨迹的 Readonly<Record<string, number>> 视图。
type H18Phases = {
  closing: number;
  outcome_unknown: number;
  retry_ready: number;
  pending: number;
  other: number;
};

interface H18State {
  phases: H18Phases;
  remaining: number;
  active: number;
  ring: number;
  chars: number;
  utf8Bytes: number;
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
    utf8Bytes: Buffer.byteLength(JSON.stringify(Memory.runtime!.treasuryCore), "utf8"),
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

/** 当前活跃记录原视图（recorder 风险快照在此之上做 JSON 往返脱离引用）。 */
function h18ActiveRecords(): Record<string, Record<string, unknown>> {
  return (Memory.runtime!.treasuryCore as unknown as { active: Record<string, Record<string, unknown>> }).active;
}

/** 推进后当 tick 的健康状态（沿用完整 reset 后 require 新 store 模块惯例）。 */
function h18HealthNow(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const storeModule = require("@/runtime/treasury/kernel/store") as typeof import("@/runtime/treasury/kernel/store");
  return storeModule.readTreasuryCoreStoreHealth().status;
}

interface H18Fixture {
  ports: TreasuryCoreKernelPorts;
  /** 原始端口事件流（Seal I/§2.2）：计数一律来自实际事件求和，含成败与 tick。 */
  releaseEvents: SealPortEvent[];
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
  const releaseEvents: SealPortEvent[] = [];
  const failingKey = "ext:h18:C0:D0"; // C0（committed）的第一项义务持续失败
  let failing = true;
  let releaseSeq = 0;
  const ports = makeKernelPorts({
    releaseExternalConsumer: (key: string): boolean => {
      releaseSeq += 1;
      const ok = !(failing && key === failingKey);
      releaseEvents.push({ seq: releaseSeq, tick: Game.time, key, ok });
      return ok;
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
    releaseEvents,
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

/**
 * J06 成功定格后的真实完整轨迹深拷贝（Evidence Remediation I/§3.1）：
 * 敏感性检查以它为合法底版，变体只作用于隔离副本、原件不变。同文件
 * it 顺序执行（J06 先于敏感性 describe）；J06 未成功时敏感性用例显式红。
 */
let h18SealTraceArchive: SealTraceDoc | undefined;

function h18SealTraceOf(): SealTraceDoc {
  if (h18SealTraceArchive === undefined) throw new Error("前置 J06 未成功完成——无真实轨迹底版可用");
  return h18SealTraceArchive;
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

  it("J06（Seal I 全轨迹）：12 tick 观察段逐 tick healthy/份额≤8/释放≤4、非零服务与真实进展、unknown 风险逐字段与独立基线一致；有限收尾在回归测试限值内完成且失败项不提前消失；失败恢复段同上限核验；终态只剩不对账 unknown 且风险事实与基线逐字段一致", () => {
    const fx = buildH18MixedLoad();
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy"); // fixture 工厂失败即终止，不跳过断言
    const sealStateView = (): SealStateView => {
      const state = h18StateOf();
      return {
        health: h18HealthNow(),
        phases: state.phases,
        active: state.active,
        ring: state.ring,
        remaining: state.remaining,
        sharesUsed: state.budgetUsed,
        chars: state.chars,
        utf8Bytes: state.utf8Bytes,
        activeRecords: h18ActiveRecords(),
      };
    };
    const recorder = createSealTraceRecorder({
      suite: "treasuryRemediationIVKernel.test.ts",
      test: "H18 J06（Seal I 全轨迹）",
      fixture: { closing: 30, unknown: 20, retry: 10, pending: 4, obligations: 90, unknownIds: fx.unknownIds },
      unknownIds: fx.unknownIds,
      portEvents: fx.releaseEvents,
      readState: sealStateView,
    });
    const initial = h18StateOf();
    const segments: SealSegmentFacts = {
      observe: { plannedTicks: 12, actualTicks: 0, exitReason: "not-run" },
      bounded: { limitWindows: 40, actualTicks: 0, exitReason: "not-run" },
      recovery: { limitWindows: 10, actualTicks: 0, failingPortRestoredAtTick: -1, exitReason: "not-run" },
    };
    const evidenceDir = process.env.TREASURY_SEAL_EVIDENCE_DIR;
    try {
      // —— 12 tick 观察段：每 tick 真正 JSON 重载 + 模块重建 + 新工厂 kernel，
      //    重载后/推进后各一次检查点（healthy + unknown 风险与基线的字段级
      //    比较）——不用旧工厂重新 new 代替完整 reset；轨迹全程不截断。
      for (let t = 0; t < 12; t += 1) {
        Game.time += 1;
        const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
        const reset = performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
        const reloadCp = recorder.checkpoint("observe", "reload-before");
        expect(reloadCp.health).toBe("healthy"); // 推进前（重载后）
        expect(reloadCp.riskDiff).toBeNull(); // 每次重载后 unknown 风险与基线逐字段一致
        const stats = reset.kernel.beginTick();
        const afterCp = recorder.checkpoint("observe", "after-advance");
        expect(afterCp.health).toBe("healthy"); // 推进后
        expect(afterCp.riskDiff).toBeNull();
        expect(afterCp.sharesUsed).toBeLessThanOrEqual(8); // 每 tick 逻辑份额 ≤8（所有实例/入口累计，持久记账）
        expect(afterCp.tickEvents).toBeLessThanOrEqual(4); // 每 tick 实际释放 ≤4（实际事件求和）
        // 20 条 unknown 按具体 ID 持续保留（不只数量碰巧等于 20）。
        for (const id of fx.unknownIds) {
          const record = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active[id];
          expect(record?.phase).toBe("outcome_unknown");
        }
        void stats;
      }
      segments.observe = { ...segments.observe, actualTicks: 12, exitReason: "固定 12 窗口观察完毕（计划即实际）" };
      recorder.setSegments(segments);
      // 观察段断言：非零服务 + 真实进展（上限断言单独绿不构成通过）。
      const afterObs = h18StateOf();
      expect(fx.releaseEvents.length).toBeGreaterThan(0); // 实际端口事件非零
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
      const healthyKeysServedAtObs = new Set(fx.releaseEvents.filter((e) => e.key.startsWith("ext:h18:C") && e.key !== fx.failingKey && e.ok).map((e) => e.key));
      expect(healthyKeysServedAtObs.size).toBeGreaterThan(0);

      // —— 有限收尾段（Seal I/§3 表述口径）：这是针对固定 H18 fixture 的
      //    有限回归测试限值——最多 40 个追加收尾窗口（第 40 个窗口出现即
      //    失败）。限值由 89 项可完成义务 ×2 份额 + 30 份退出/转化份额在每
      //    tick ≤8 份额下的静态推算加调度余量导出，用于发现回归；它不是
      //    所有工作负载的完成时间保证，8 份额/tick 是上限而非每 tick 最低
      //    服务量。所有 tick 仍真正 JSON 重载，不复制旧数字。
      let boundedTicks = 0;
      let stateNow = h18StateOf();
      while ((stateNow.remaining > 1 || (stateNow.phases.closing ?? 0) > 1) && boundedTicks < 40) {
        Game.time += 1;
        const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
        const reset = performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
        const reloadCp = recorder.checkpoint("bounded", "reload-before");
        expect(reloadCp.health).toBe("healthy");
        expect(reloadCp.riskDiff).toBeNull();
        reset.kernel.beginTick();
        const afterCp = recorder.checkpoint("bounded", "after-advance");
        expect(afterCp.health).toBe("healthy");
        expect(afterCp.riskDiff).toBeNull();
        expect(afterCp.sharesUsed).toBeLessThanOrEqual(8);
        expect(afterCp.tickEvents).toBeLessThanOrEqual(4);
        // 持续失败项在宿主恢复端口前不能提前消失（Seal I/§2.3）。
        const c0Now = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { cleanup?: { consumerKeys: readonly string[] } }> }).active[fx.closingIds[0] as string];
        expect(c0Now?.cleanup?.consumerKeys).toContain(fx.failingKey);
        boundedTicks += 1;
        stateNow = h18StateOf();
      }
      // 到达限值但退出条件未满足必须失败：显式断言退出条件达成，且完成
      // 发生在限值内（"最多 40 个窗口"含第 40 次；实际窗口数如实记录）。
      expect(stateNow.remaining).toBe(1); // 只剩 C0 的失败义务
      expect(stateNow.phases.closing).toBe(1); // 只剩 C0 一条 closing
      expect(boundedTicks).toBeLessThan(40);
      // 健康工作不因失败项持续失败而饿死：收尾段期间仍有新的成功服务。
      const healthyKeysServedAtBounded = new Set(fx.releaseEvents.filter((e) => e.key.startsWith("ext:h18:C") && e.key !== fx.failingKey && e.ok).map((e) => e.key));
      expect(healthyKeysServedAtBounded.size).toBeGreaterThan(healthyKeysServedAtObs.size);
      segments.bounded = { ...segments.bounded, actualTicks: boundedTicks, exitReason: `退出条件达成（remaining=1/closing=1），实际 ${boundedTicks} 窗口` };
      recorder.setSegments(segments);

      // —— 失败恢复段（回归测试限值 10 窗口）：宿主把持续失败义务恢复为
      //    true，剩余安全工作收尾；本段同样核验健康、风险保留与份额/释放
      //    上限（不能只在前 12 tick 检查后就假设后续满足同样事实）。
      fx.restoreFailingPort();
      const failingPortRestoredAtTick = Game.time; // 宿主恢复时点（此后下一窗口生效）
      let recoveryTicks = 0;
      let c0Phase: string | undefined = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active[fx.closingIds[0] as string]?.phase;
      while (c0Phase !== undefined && recoveryTicks < 10) {
        Game.time += 1;
        const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
        const reset = performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
        const reloadCp = recorder.checkpoint("recovery", "reload-before");
        expect(reloadCp.health).toBe("healthy");
        expect(reloadCp.riskDiff).toBeNull();
        reset.kernel.beginTick();
        const afterCp = recorder.checkpoint("recovery", "after-advance");
        expect(afterCp.health).toBe("healthy");
        expect(afterCp.riskDiff).toBeNull();
        expect(afterCp.sharesUsed).toBeLessThanOrEqual(8);
        expect(afterCp.tickEvents).toBeLessThanOrEqual(4);
        recoveryTicks += 1;
        c0Phase = (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active[fx.closingIds[0] as string]?.phase;
      }
      // C0（committed）义务清空 + 观察接管后退出 active（进 ring 终态）；
      // 若 10 窗口限值内未退出，此处红——不靠循环结束本身判通过。
      expect((Memory.runtime!.treasuryCore as unknown as { active: Record<string, unknown> }).active[fx.closingIds[0] as string]).toBeUndefined();
      segments.recovery = { ...segments.recovery, actualTicks: recoveryTicks, failingPortRestoredAtTick, exitReason: `C0 经真实清理退出 active，实际 ${recoveryTicks} 窗口` };
      recorder.setSegments(segments);

      // —— retry_ready 安全退出：经正常业务放弃（closeWork abandoned），不
      //    直接 delete Memory。显式业务命令与自动恢复预算内的动作在轨迹中
      //    分开分类（finalClose 与 portEvents 各自记录）；同 tick 多次入口
      //    的释放累计仍不得超过原上限。
      const finalReset = performTreasuryKernelFullReset({ ports: fx.ports, runBeginTick: false });
      const preCp = recorder.checkpoint("final-close", "pre-close");
      expect(preCp.health).toBe("healthy");
      expect(preCp.riskDiff).toBeNull();
      expect(preCp.sharesUsed).toBeLessThanOrEqual(8);
      const retryLeft = Object.entries((Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string }> }).active)
        .filter(([, r]) => r.phase === "retry_ready")
        .map(([id]) => id);
      for (const id of retryLeft) {
        const closed = finalReset.kernel.closeWork({ attemptId: id, reason: "abandoned" });
        expect(closed.status).toBe("ok");
        recorder.addFinalClose({ attemptId: id, status: closed.status });
      }
      const postCp = recorder.checkpoint("final-close", "post-close");
      expect(postCp.health).toBe("healthy");
      expect(postCp.riskDiff).toBeNull(); // 最终 close 后 unknown 风险仍与基线一致
      expect(postCp.tickEvents).toBeLessThanOrEqual(4); // 同 tick（含恢复段最后窗口）累计释放 ≤4
      const finalState = h18StateOf();
      expect(finalState.active).toBe(20); // 只剩 unknown
      expect(Object.keys((Memory.runtime!.treasuryCore as unknown as { active: Record<string, unknown> }).active).sort()).toEqual([...fx.unknownIds].sort());
      expect(finalState.phases).toEqual({ closing: 0, outcome_unknown: 20, retry_ready: 0, pending: 0, other: 0 });
      expect(finalState.ring).toBeLessThanOrEqual(128);
      expect(finalState.chars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);

      // —— 全程端口事件核验（Seal I/§2.3）：已确认成功的义务真正退出
      //    remaining 后不再进入端口（每个成功 key 全程恰好一次，含收尾/
      //    恢复段）；失败 key 的失败尝试全部发生在宿主恢复之前、恢复后
      //    恰好一次成功。
      const failingFirstOk = fx.releaseEvents.find((e) => e.key === fx.failingKey && e.ok);
      if (failingFirstOk === undefined) throw new Error("恢复后失败义务未获得成功释放");
      for (const event of fx.releaseEvents.filter((e) => e.key === fx.failingKey && !e.ok)) {
        expect(event.tick).toBeLessThan(failingFirstOk.tick); // 失败尝试全部在恢复前
      }
      for (const key of new Set(fx.releaseEvents.filter((e) => e.ok).map((e) => e.key))) {
        if (key === fx.failingKey) continue;
        expect(fx.releaseEvents.filter((e) => e.key === key).length).toBe(1); // 成功确认后不再调用
      }

      // 终态定格：active=20 且每个指定 ID 的风险事实与推进前的独立基线
      // 逐字段一致（不只是 ID+phase——"记录还在"不等于"记录里的责任没变"）。
      const terminalRisk = sealSnapshotUnknownRisk(fx.unknownIds, h18ActiveRecords());
      const doc = recorder.complete({
        health: "healthy",
        active: finalState.active,
        unknownIds: [...fx.unknownIds],
        ring: finalState.ring,
        chars: finalState.chars,
        riskDiff: sealCompareUnknownRisk(recorder.current().initial.unknownRiskBaseline as Record<string, Record<string, unknown>>, terminalRisk),
      });
      expect(doc.terminal?.riskDiff).toEqual([]);
      // Evidence Remediation I/§3.1：真实完整轨迹定格为敏感性检查的合法底版
      // （隔离副本变体，原件不变）。
      h18SealTraceArchive = JSON.parse(JSON.stringify(doc)) as SealTraceDoc;
      // —— 完整性核验（Seal I/§2.4）：初始/全部观察窗口/全部追加窗口/失败
      //    恢复/终态都在，序号与段落数和执行时独立记录的次数相符，事件
      //    计数与实际事件求和一致，风险比较覆盖全部 20 个 ID。
      const verdict = sealVerifyTraceCompleteness(doc, { unknownIds: fx.unknownIds, plannedObserveTicks: 12 });
      expect(verdict.problems).toEqual([]);
      // —— 敏感性自检之一（真实轨迹的隔离副本，Seal I/§5.1）：删除一个
      //    中间窗口必须让完整性核验失败（不修改原运行数据、不补伪造窗口）。
      const mutated = JSON.parse(JSON.stringify(doc)) as SealTraceDoc;
      mutated.checkpoints.splice(10, 2); // 一个观察窗口的 reload-before/after-advance 对
      const mutatedVerdict = sealVerifyTraceCompleteness(mutated, { unknownIds: fx.unknownIds, plannedObserveTicks: 12 });
      expect(mutatedVerdict.ok).toBe(false);
      expect(mutatedVerdict.problems.length).toBeGreaterThan(0);
      // —— 敏感性自检之二（真实基线的隔离副本，Seal I/§5.2）：单字段漂移
      //    （ID/phase/腿数不变）必须被字段级比较抓住。
      const driftedBaseline = JSON.parse(JSON.stringify(doc.initial.unknownRiskBaseline)) as Record<string, Record<string, unknown>>;
      ((driftedBaseline[fx.unknownIds[0] as string] as { worstCase: { delta: number }[] }).worstCase[0] as { delta: number }).delta += 1;
      expect(sealCompareUnknownRisk(driftedBaseline, terminalRisk).length).toBeGreaterThan(0);
      // —— 导出：仅当 TREASURY_SEAL_EVIDENCE_DIR 已设置时落盘；未设置时
      //    全部断言已执行（不 skip）。证据路径错误要报告，不静默丢弃。
      const written = sealWriteEvidence(evidenceDir, doc, "H18-J06");
      if (evidenceDir !== undefined) expect(written === null ? "" : written.file).not.toBe("");
      // eslint-disable-next-line no-console
      console.log(`H18-TRACE completed=true observe=12 bounded=${boundedTicks}/40 recovery=${recoveryTicks}/10 checkpoints=${doc.checkpoints.length} portEvents=${doc.portEvents.length} finalClose=${doc.finalClose.length} final=${JSON.stringify(finalState)}`);
    } catch (error) {
      // Seal I/§2.4：测试失败也保留已捕获的部分轨迹并标记 incomplete——
      // 不在 finally 中补出"成功终态"。
      recorder.fail("J06", error);
      sealWriteEvidence(evidenceDir, recorder.current(), "H18-J06");
      throw error;
    }
  });

  it("零推进负向对照：healthy fixture 下生命周期推进为零时，J06 的进度/收尾指标全部零变化——上限与 unknown 保留断言单独绿不构成通过", () => {
    const fx = buildH18MixedLoad();
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy"); // 前提保持 healthy（不是又一份损坏数据测试）
    const baseline = sealSnapshotUnknownRisk(fx.unknownIds, h18ActiveRecords()); // 推进前独立基线
    Game.time += 1;
    const snapshot = JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
    // 完整 reset（真实通道）但不调用 beginTick——受测生命周期推进被替换为
    // 零推进（最小变体：跳过推进入口本身）。
    performTreasuryKernelFullReset({ ports: fx.ports, memorySnapshot: snapshot, runBeginTick: false });
    const before = h18StateOf();
    const after = h18StateOf(); // 同一持久状态：零推进
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy");
    expect(fx.releaseEvents.length).toBe(0); // 无服务
    expect(after.remaining).toBe(before.remaining); // remaining 无减少
    expect(after.phases).toEqual(before.phases); // 无阶段转移
    expect(after.active).toBe(before.active); // 无退出
    expect(h18HasProgress(before, after)).toBe(false); // J06 进度判别函数在零推进轨迹上判 false
    // 完整 reset 的 JSON 重载通道本身不篡改 unknown 风险事实（K3 对照）。
    expect(sealCompareUnknownRisk(baseline, sealSnapshotUnknownRisk(fx.unknownIds, h18ActiveRecords()))).toEqual([]);
  });
});

// ── Seal I／Evidence Remediation I 敏感性检查（K06/L01–L04）───────────────
//
// 测试侧负向检查（expect 正常通过的形态），证明轨迹完整性核验与风险字段级
// 比较对"故意坏掉的隔离副本"敏感——它们不宣称生产已发生该错误；与生产
// 负向变体（一次性 worktree 中的 heap-only/零推进 patch，Jest 非零失败）
// 在报告中分开分类。Evidence Remediation I 起底版为 J06 定格的真实完整
// 轨迹（§3.1）；变体只作用于隔离副本，原件不变。合成轨迹（检查点
// unknownRisk=null、基线仅 2 字段）不再冒充"完整风险证据"，仅用于欠缺
// 证据的负向测试（§3.3）。

/**
 * 合成一份结构完整但无实际风险数据的最小形态轨迹（检查点 unknownRisk=null、
 * 基线仅 2 字段）——Evidence Remediation I/§3.3：不再称"完整风险证据"，
 * 仅用于欠缺风险证据的负向测试（核验必须拒绝它）。
 */
function buildSyntheticSealTrace(): SealTraceDoc {
  const ids = ["tk1_synth_00", "tk1_synth_01", "tk1_synth_02"];
  const synthCheckpoint = (
    seq: number,
    stage: SealTraceStage,
    point: SealTracePoint,
    tick: number,
    events: { upTo: number; tickEvents: number; tickSucceeded: number; tickFailed: number },
  ): SealCheckpoint => ({
    seq,
    stage,
    point,
    tick,
    health: "healthy",
    phases: { closing: 1, outcome_unknown: 3, retry_ready: 0, pending: 0, other: 0 },
    active: 4,
    ring: 0,
    remaining: 1,
    sharesUsed: 2,
    chars: 120,
    utf8Bytes: 120,
    eventsUpTo: events.upTo,
    tickEvents: events.tickEvents,
    tickSucceeded: events.tickSucceeded,
    tickFailed: events.tickFailed,
    unknownRisk: null,
    riskCheckedIds: [...ids],
    riskDiff: null,
    note: null,
  });
  return {
    format: "treasury-seal-trace/v1",
    suite: "synthetic",
    test: "completeness-fixture",
    recordedAt: "2026-09-07T00:00:00.000Z",
    comparisonScope: { riskFieldsCompared: [], mutableDiagnosticFieldsNotCompared: [] },
    fixture: { closing: 1, unknown: 3, retry: 0, pending: 0, obligations: 3, unknownIds: ids },
    initial: {
      health: "healthy",
      phases: { closing: 1, outcome_unknown: 3, retry_ready: 0, pending: 0, other: 0 },
      active: 4,
      ring: 0,
      remaining: 3,
      chars: 120,
      utf8Bytes: 120,
      unknownRiskBaseline: Object.fromEntries(ids.map((id) => [id, { attemptId: id, phase: "outcome_unknown" }])) as Record<string, Record<string, unknown>>,
    },
    segments: {
      observe: { plannedTicks: 2, actualTicks: 2, exitReason: "计划即实际" },
      bounded: { limitWindows: 40, actualTicks: 1, exitReason: "退出条件达成" },
      recovery: { limitWindows: 10, actualTicks: 1, failingPortRestoredAtTick: 3, exitReason: "C0 退出" },
    },
    checkpoints: [
      synthCheckpoint(1, "observe", "reload-before", 1, { upTo: 0, tickEvents: 0, tickSucceeded: 0, tickFailed: 0 }),
      synthCheckpoint(2, "observe", "after-advance", 1, { upTo: 1, tickEvents: 1, tickSucceeded: 1, tickFailed: 0 }),
      synthCheckpoint(3, "observe", "reload-before", 2, { upTo: 1, tickEvents: 0, tickSucceeded: 0, tickFailed: 0 }),
      synthCheckpoint(4, "observe", "after-advance", 2, { upTo: 2, tickEvents: 1, tickSucceeded: 0, tickFailed: 1 }),
      synthCheckpoint(5, "bounded", "reload-before", 3, { upTo: 2, tickEvents: 0, tickSucceeded: 0, tickFailed: 0 }),
      synthCheckpoint(6, "bounded", "after-advance", 3, { upTo: 3, tickEvents: 1, tickSucceeded: 1, tickFailed: 0 }),
      synthCheckpoint(7, "recovery", "reload-before", 4, { upTo: 3, tickEvents: 0, tickSucceeded: 0, tickFailed: 0 }),
      synthCheckpoint(8, "recovery", "after-advance", 4, { upTo: 4, tickEvents: 1, tickSucceeded: 1, tickFailed: 0 }),
      synthCheckpoint(9, "final-close", "pre-close", 4, { upTo: 4, tickEvents: 1, tickSucceeded: 1, tickFailed: 0 }),
      synthCheckpoint(10, "final-close", "post-close", 4, { upTo: 4, tickEvents: 1, tickSucceeded: 1, tickFailed: 0 }),
    ],
    portEvents: [
      { seq: 1, tick: 1, key: "ext:synth:0", ok: true },
      { seq: 2, tick: 2, key: "ext:synth:1", ok: false },
      { seq: 3, tick: 3, key: "ext:synth:2", ok: true },
      { seq: 4, tick: 4, key: "ext:synth:0", ok: true },
    ],
    finalClose: [{ attemptId: "tk1_synth_retry", status: "ok" }],
    terminal: { health: "healthy", active: 3, unknownIds: ids, ring: 1, chars: 90, riskDiff: null },
    completed: true,
    failure: null,
  };
}

describe("Seal I／Evidence Remediation I 敏感性检查（K06/L01–L04）", () => {
  const SYNTH_IDS = ["tk1_synth_00", "tk1_synth_01", "tk1_synth_02"];
  /** 从 J06 定格的真实轨迹深拷贝一份隔离副本（原件永不被变体触碰）。 */
  const copyOfRealTrace = (): SealTraceDoc => JSON.parse(JSON.stringify(h18SealTraceOf())) as SealTraceDoc;
  const realExpected = (): { unknownIds: readonly string[]; plannedObserveTicks: number } => {
    const base = h18SealTraceOf();
    return { unknownIds: base.fixture.unknownIds, plannedObserveTicks: base.segments.observe.actualTicks };
  };

  it("轨迹完整性核验：真实轨迹通过；缺失中间窗口/缺失终态/事件计数不符/覆盖标签缺 ID/finalClose 缺失均必须报 problems", () => {
    const base = h18SealTraceOf();
    const expected = realExpected();
    expect(sealVerifyTraceCompleteness(base, expected).problems).toEqual([]); // 真实底版完整通过
    // 变体 1：删除一个中间观察窗口（reload-before/after-advance 对）。
    const missingWindow = copyOfRealTrace();
    missingWindow.checkpoints.splice(2, 2);
    const v1 = sealVerifyTraceCompleteness(missingWindow, expected);
    expect(v1.ok).toBe(false);
    expect(v1.problems.some((p) => p.includes("observe"))).toBe(true);
    expect(v1.problems.some((p) => p.includes("序号不连续") || p.includes("after-advance 检查点数"))).toBe(true);
    // 变体 2：终态丢失。
    const missingTerminal = copyOfRealTrace();
    missingTerminal.terminal = null;
    const v2 = sealVerifyTraceCompleteness(missingTerminal, expected);
    expect(v2.ok).toBe(false);
    expect(v2.problems.some((p) => p.includes("terminal 缺失"))).toBe(true);
    // 变体 3：post-close 检查点（终态窗口）丢失。
    const missingPostClose = copyOfRealTrace();
    const postIdx = missingPostClose.checkpoints.findIndex((c) => c.stage === "final-close" && c.point === "post-close");
    if (postIdx < 0) throw new Error("真实底版缺 post-close 检查点");
    missingPostClose.checkpoints.splice(postIdx, 1);
    const v3 = sealVerifyTraceCompleteness(missingPostClose, expected);
    expect(v3.ok).toBe(false);
    expect(v3.problems.some((p) => p.includes("post-close"))).toBe(true);
    // 变体 4：端口事件少一条（末检查点 eventsUpTo 与实际事件总数不符）。
    const missingEvent = copyOfRealTrace();
    missingEvent.portEvents.pop();
    const v4 = sealVerifyTraceCompleteness(missingEvent, expected);
    expect(v4.ok).toBe(false);
    expect(v4.problems.some((p) => p.includes("端口事件总数"))).toBe(true);
    // 变体 5：某检查点风险覆盖标签缺一个 ID（覆盖不全）。
    const partialRisk = copyOfRealTrace();
    const cp5 = partialRisk.checkpoints[4];
    if (cp5 === undefined) throw new Error("真实底版缺检查点 4");
    partialRisk.checkpoints[4] = { ...cp5, riskCheckedIds: base.fixture.unknownIds.slice(0, 19) };
    const v5 = sealVerifyTraceCompleteness(partialRisk, expected);
    expect(v5.ok).toBe(false);
    expect(v5.problems.some((p) => p.includes("风险比较覆盖标签与 expected ID 集合不符"))).toBe(true);
    // 变体 6：finalClose 为空（retry_ready 退出无真实调用记录）。
    const noFinalClose = copyOfRealTrace();
    noFinalClose.finalClose = [];
    const v6 = sealVerifyTraceCompleteness(noFinalClose, expected);
    expect(v6.ok).toBe(false);
    expect(v6.problems.some((p) => p.includes("finalClose 为空"))).toBe(true);
    // 原件未被任何变体修改（纯核验/隔离副本纪律）。
    expect(sealVerifyTraceCompleteness(base, expected).problems).toEqual([]);
  });

  it("逐检查点实证核验（L02/L03）：风险证据整项缺失、实际漂移标签仍一致、中间差异被正确终态掩盖、快照缺 ID、终态标签与 post-close 矛盾均必须失败；无证据合成轨迹被拒；核验不修改输入", () => {
    const expected = realExpected();
    const problemsOf = (t: SealTraceDoc): string[] => sealVerifyTraceCompleteness(t, expected).problems;
    const idOf = (i: number): string => (h18SealTraceOf().fixture.unknownIds[i] as string);
    // 反例 A：中间检查点（observe 第 3 窗 reload-before，seq=5）风险证据整项
    // 缺失（unknownRisk/riskCheckedIds/riskDiff 全 null）——不能跳过。
    const a = copyOfRealTrace();
    const aCp = a.checkpoints[4];
    if (aCp === undefined) throw new Error("底版缺检查点 4");
    a.checkpoints[4] = { ...aCp, unknownRisk: null, riskCheckedIds: null, riskDiff: null };
    const aBefore = JSON.stringify(a);
    const aProblems = problemsOf(a);
    expect(aProblems.some((p) => p.includes("seq=5") && p.includes("风险证据缺失"))).toBe(true);
    expect(JSON.stringify(a)).toBe(aBefore); // 纯核验：输入未被检查器修改或自愈
    // 反例 B：中间检查点实际快照 worstCase 单腿金额漂移（ID/phase/腿数不变），
    // riskDiff 标签保持 null——必须从实际快照重算发现，不信任标签。
    const b = copyOfRealTrace();
    const bCp = b.checkpoints[6];
    if (bCp === undefined || bCp.unknownRisk === null) throw new Error("底版缺检查点 6 风险快照");
    const bSnapshot = bCp.unknownRisk as Record<string, Record<string, unknown>>;
    const bId = idOf(2);
    const bLegs = (bSnapshot[bId] as { worstCase: { delta: number }[] }).worstCase;
    if (bLegs[1] === undefined) throw new Error("底版 worstCase 腿数不足");
    bLegs[1].delta += 1;
    const bProblems = problemsOf(b);
    expect(bProblems.some((p) => p.includes("seq=7") && p.includes("worstCase[1].delta") && p.includes(bId))).toBe(true);
    expect(bProblems.some((p) => p.includes("标签与实际证据矛盾"))).toBe(true);
    // 反例 C：中间检查点保存非空 riskDiff（快照实际一致），终态正确——不能
    // 因终态恢复放行；标签与原始快照矛盾也必须报错。
    const c = copyOfRealTrace();
    const cCp = c.checkpoints[8];
    if (cCp === undefined) throw new Error("底版缺检查点 8");
    c.checkpoints[8] = {
      ...cCp,
      riskDiff: [{ attemptId: idOf(0), field: "worstCase[0].delta", expected: 50, actual: 51 }],
    };
    const cProblems = problemsOf(c);
    expect(cProblems.some((p) => p.includes("seq=9") && p.includes("标签非空但实际快照与基线重算一致"))).toBe(true);
    expect(cProblems.some((p) => p.includes("中间漂移不因后续恢复放行"))).toBe(false); // C 的快照本身一致，只有标签矛盾
    // 相邻 1：中间检查点实际快照缺一个 unknown ID（部分覆盖不是实际风险数据）。
    const d = copyOfRealTrace();
    const dCp = d.checkpoints[4];
    if (dCp === undefined || dCp.unknownRisk === null) throw new Error("底版缺检查点 4 风险快照");
    delete (dCp.unknownRisk as Record<string, Record<string, unknown>>)[idOf(19)];
    const dProblems = problemsOf(d);
    expect(dProblems.some((p) => p.includes("seq=5") && p.includes("实际风险快照未覆盖全部 unknown ID"))).toBe(true);
    // 相邻 2：post-close 实际快照漂移、terminal.riskDiff 标签保持一致——终态
    // 标签与实际证据矛盾必须报。
    const e = copyOfRealTrace();
    const ePost = e.checkpoints.find((cp) => cp.stage === "final-close" && cp.point === "post-close");
    if (ePost === undefined || ePost.unknownRisk === null) throw new Error("底版缺 post-close 风险快照");
    const eSnapshot = ePost.unknownRisk as Record<string, Record<string, unknown>>;
    (eSnapshot[idOf(0)] as { identity: { canonicalDigest: string } }).identity.canonicalDigest = "e".repeat(16);
    const eProblems = problemsOf(e);
    expect(eProblems.some((p) => p.includes("post-close") && p.includes("identity.canonicalDigest"))).toBe(true);
    expect(eProblems.some((p) => p.includes("终态标签与实际证据矛盾"))).toBe(true);
    // 相邻 3：terminal.riskDiff 标签非空、post-close 实际一致——终态标签矛盾。
    const f = copyOfRealTrace();
    if (f.terminal === null) throw new Error("底版缺终态");
    f.terminal = { ...f.terminal, riskDiff: [{ attemptId: idOf(0), field: "worstCase[0].delta", expected: 50, actual: 51 }] };
    const fProblems = problemsOf(f);
    expect(fProblems.some((p) => p.includes("terminal 风险事实与基线存在差异"))).toBe(true);
    expect(fProblems.some((p) => p.includes("terminal.riskDiff 标签非空但 post-close 实际快照与基线重算一致"))).toBe(true);
    // 无证据合成轨迹：必须被报风险证据缺失与基线缺字段——欠证据不称完整。
    const synthProblems = sealVerifyTraceCompleteness(buildSyntheticSealTrace(), {
      unknownIds: SYNTH_IDS,
      plannedObserveTicks: 2,
    }).problems;
    expect(synthProblems.some((p) => p.includes("风险证据缺失"))).toBe(true);
    expect(synthProblems.some((p) => p.includes("缺风险字段"))).toBe(true);
  });

  it("原始记录入口的无损风险提取（L01）：原始记录上 delete 基线 null 字段经提取+JSON 往返+比较仍定位存在性差异；合法 null 与未变记录通过；基线不随副本改变且拒绝不完整事实", () => {
    const fx = buildH18MixedLoad();
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy"); // 前提：健康 H18 fixture
    const ids = fx.unknownIds;
    const active = h18ActiveRecords();
    const id0 = ids[0] as string;
    const baseline = sealBuildUnknownRiskBaseline(ids, active); // 独立基线（只建一次、脱离引用）
    // 合法对照：未修改记录重复提取、独立深复制、JSON 往返比较一致；合法
    // null（invocation/external/outcomeEvidence）不是错误。
    expect(sealCompareUnknownRisk(baseline, sealSnapshotUnknownRisk(ids, active))).toEqual([]);
    const deepCopy = JSON.parse(JSON.stringify(active)) as Record<string, Record<string, unknown>>;
    expect(sealCompareUnknownRisk(baseline, sealSnapshotUnknownRisk(ids, deepCopy))).toEqual([]);
    // 入口反例：基线为合法 null 的字段在"原始记录副本"上被 delete——经提取、
    // JSON 往返、比较后必须定位 attempt 与字段的存在性差异（Evidence
    // Remediation I/§2.1：差异发生在原始记录，不绕过提取器）。
    const deletedNullField = (field: string): SealRiskDiff[] => {
      const mutated = JSON.parse(JSON.stringify(active)) as Record<string, Record<string, unknown>>;
      delete mutated[id0][field];
      return sealCompareUnknownRisk(baseline, sealSnapshotUnknownRisk(ids, mutated));
    };
    for (const field of ["invocation", "external", "outcomeEvidence"]) {
      const diffs = deletedNullField(field);
      const first = diffs[0];
      if (first === undefined) throw new Error(`原始记录 delete ${field} 未被定位`);
      expect(diffs.length).toBe(1);
      expect(first.attemptId).toBe(id0);
      expect(first.field).toBe(field);
      expect(first.expected).toBeNull(); // 基线侧是合法 null（存在且为 null）
      expect(first.actual).toEqual({ sealFieldAbsent: true }); // 当前侧是显式缺失（哨兵渲染）
    }
    // 非 null 字段对照：调用边界/identity/worstCase 的 delete 同样定位存在性差异。
    for (const field of ["invocationBoundary", "identity", "worstCase"]) {
      const diffs = deletedNullField(field);
      const first = diffs[0];
      if (first === undefined) throw new Error(`原始记录 delete ${field} 未被定位`);
      expect(first.attemptId).toBe(id0);
      expect(first.field).toBe(field);
      expect(first.actual).toEqual({ sealFieldAbsent: true });
    }
    // 合法值变化（ID/phase/记录数/腿数不变）：worstCase 单腿金额经入口路径定位。
    const amountDrift = JSON.parse(JSON.stringify(active)) as Record<string, Record<string, unknown>>;
    const legs = (amountDrift[id0] as { worstCase: { delta: number }[] }).worstCase;
    if (legs[1] === undefined) throw new Error("fixture worstCase 腿数不足");
    legs[1].delta += 1;
    const dAmount = sealCompareUnknownRisk(baseline, sealSnapshotUnknownRisk(ids, amountDrift));
    const firstAmount = dAmount[0];
    if (firstAmount === undefined) throw new Error("worstCase 金额漂移未在入口路径被定位");
    expect(dAmount.length).toBe(1);
    expect(firstAmount.field).toBe("worstCase[1].delta");
    // 基线不随副本改变：副本被破坏后，基线与原始记录再比较仍一致。
    expect(sealCompareUnknownRisk(baseline, sealSnapshotUnknownRisk(ids, active))).toEqual([]);
    // 基线完整性拒绝：原始记录缺风险字段或整条记录缺失时，不得建立"完整基线"。
    const brokenField = JSON.parse(JSON.stringify(active)) as Record<string, Record<string, unknown>>;
    delete brokenField[id0].invocationBoundary;
    expect(() => sealBuildUnknownRiskBaseline(ids, brokenField)).toThrow(/invocationBoundary/);
    const brokenRecord = JSON.parse(JSON.stringify(active)) as Record<string, Record<string, unknown>>;
    delete brokenRecord[id0];
    expect(() => sealBuildUnknownRiskBaseline(ids, brokenRecord)).toThrow(/记录缺失/);
  });

  it("落盘写读往返核验（L04）：合法真实轨迹写文件再 JSON 读取后完整性核验仍通过、存在性区分保留；被破坏副本落盘读回仍报差异", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeOs = require("node:os") as typeof import("node:os");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require("node:path") as typeof import("node:path");
    const expected = realExpected();
    const id0 = h18SealTraceOf().fixture.unknownIds[0] as string;
    const tmpRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "seal-ev1-roundtrip-"));
    try {
      // 合法真实轨迹落盘再读取：导出不消除完整性。
      const written = sealWriteEvidence(tmpRoot, h18SealTraceOf(), "roundtrip");
      if (written === null) throw new Error("sealWriteEvidence 未落盘");
      const readBack = JSON.parse(nodeFs.readFileSync(written.file, "utf8")) as SealTraceDoc;
      expect(sealVerifyTraceCompleteness(readBack, expected).problems).toEqual([]);
      // 存在性区分经落盘不消除：基线合法 null 读回仍是 null（不是缺失标记）。
      const baselineRead = readBack.initial.unknownRiskBaseline as Record<string, Record<string, unknown>>;
      expect(baselineRead[id0]?.invocation).toBeNull();
      // 缺失哨兵经 JSON 落盘读回仍是哨兵，且被完整性核验拒绝（基线不完整）。
      const sentinelTrace = JSON.parse(JSON.stringify(readBack)) as SealTraceDoc;
      (sentinelTrace.initial.unknownRiskBaseline as Record<string, Record<string, unknown>>)[id0]!.invocation = SEAL_FIELD_ABSENT;
      const sentinelWritten = sealWriteEvidence(tmpRoot, sentinelTrace, "roundtrip-sentinel");
      if (sentinelWritten === null) throw new Error("哨兵副本未落盘");
      const sentinelRead = JSON.parse(nodeFs.readFileSync(sentinelWritten.file, "utf8")) as SealTraceDoc;
      const sentinelBaseline = sentinelRead.initial.unknownRiskBaseline as Record<string, Record<string, unknown>>;
      expect(sentinelBaseline[id0]?.invocation).toBe(SEAL_FIELD_ABSENT); // 哨兵字节经 JSON 往返保留
      const sentinelProblems = sealVerifyTraceCompleteness(sentinelRead, expected).problems;
      expect(sentinelProblems.some((p) => p.includes("缺失哨兵"))).toBe(true);
      // 被破坏副本（B 型漂移）落盘读回仍被核验发现——导出不消除差异。
      const broken = copyOfRealTrace();
      const brokenCp = broken.checkpoints[6];
      if (brokenCp === undefined || brokenCp.unknownRisk === null) throw new Error("底版缺检查点 6 风险快照");
      const brokenSnapshot = brokenCp.unknownRisk as Record<string, Record<string, unknown>>;
      const brokenLegs = (brokenSnapshot[id0] as { worstCase: { delta: number }[] }).worstCase;
      if (brokenLegs[1] === undefined) throw new Error("底版 worstCase 腿数不足");
      brokenLegs[1].delta += 1;
      const brokenWritten = sealWriteEvidence(tmpRoot, broken, "roundtrip-broken");
      if (brokenWritten === null) throw new Error("破坏副本未落盘");
      const brokenRead = JSON.parse(nodeFs.readFileSync(brokenWritten.file, "utf8")) as SealTraceDoc;
      const brokenProblems = sealVerifyTraceCompleteness(brokenRead, expected).problems;
      expect(brokenProblems.some((p) => p.includes("worstCase[1].delta"))).toBe(true);
    } finally {
      nodeFs.rmSync(tmpRoot, { recursive: true, force: true }); // 临时目录在仓库外，用后即清
    }
  });

  it("unknown 风险字段级比较（已提取快照上的比较器单测；入口路径由 L01 it 承担）：同 ID/phase/腿数下的单字段漂移被定位到 attempt 与字段路径；null 与缺失不互相替代", () => {
    const fx = buildH18MixedLoad();
    const baseline = sealSnapshotUnknownRisk(fx.unknownIds, h18ActiveRecords());
    // 底版：与自身的隔离副本一致（JSON 往返不产生差异）。
    expect(sealCompareUnknownRisk(baseline, JSON.parse(JSON.stringify(baseline)) as typeof baseline)).toEqual([]);
    const id0 = fx.unknownIds[0] as string;
    // 漂移 1：一条 worstCase 腿的金额（ID/phase/腿数均不变）。
    const driftAmount = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    ((driftAmount[id0] as { worstCase: { delta: number }[] }).worstCase[1] as { delta: number }).delta += 1;
    const d1 = sealCompareUnknownRisk(baseline, driftAmount);
    const first1 = d1[0];
    if (first1 === undefined) throw new Error("worstCase 金额漂移未被抓住");
    expect(d1.length).toBe(1);
    expect(first1.attemptId).toBe(id0);
    expect(first1.field).toBe("worstCase[1].delta");
    // 漂移 2：调用边界 tick（不确定性来源事实）。
    const driftBoundary = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    ((driftBoundary[id0] as { invocationBoundary: { atTick: number } }).invocationBoundary as { atTick: number }).atTick += 1;
    const d2 = sealCompareUnknownRisk(baseline, driftBoundary);
    const first2 = d2[0];
    if (first2 === undefined) throw new Error("调用边界漂移未被抓住");
    expect(first2.attemptId).toBe(id0);
    expect(first2.field).toBe("invocationBoundary.atTick");
    // 漂移 3：identity 摘要（adapter 身份链）。
    const driftIdentity = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    (driftIdentity[id0] as { identity: { canonicalDigest: string } }).identity.canonicalDigest = "f".repeat(16);
    const d3 = sealCompareUnknownRisk(baseline, driftIdentity);
    const first3 = d3[0];
    if (first3 === undefined) throw new Error("identity 漂移未被抓住");
    expect(first3.field).toBe("identity.canonicalDigest");
    // 漂移 4：null 与缺失不互替（invocation=null 被删除为缺失）。
    const driftMissing = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    delete (driftMissing[id0] as { invocation?: unknown }).invocation;
    const d4 = sealCompareUnknownRisk(baseline, driftMissing);
    const first4 = d4[0];
    if (first4 === undefined) throw new Error("null→缺失未被抓住");
    expect(first4.attemptId).toBe(id0);
    expect(first4.field).toBe("invocation");
    expect(first4.expected).toBeNull();
    expect(first4.actual).toBeUndefined();
    // 漂移 5：记录整体缺失（ID 还在清单里但记录被删）。
    const driftGone = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    delete driftGone[id0];
    const d5 = sealCompareUnknownRisk(baseline, driftGone);
    const first5 = d5[0];
    if (first5 === undefined) throw new Error("记录缺失未被抓住");
    expect(first5.field).toBe("(record)");
  });
});
