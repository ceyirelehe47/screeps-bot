/**
 * Remediation IV 基线反例重现器（在 44593c8 基线上运行必须红）。
 *
 * 三个反例分别对应任务书 §2.1（R1：独立 endTick 反向重入 + 尾部旧预算
 * 覆盖）、§3.1（V1：同参数错身份——作用域声明 B、实际提交许可 A）、
 * §4.1（V2：断点事件来源错配——捕获器收 J2 marker、adapter 用 J1）。
 * 断言的是**修复后的语义**；基线上运行时各自以行为差异变红。
 */
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import type { TreasuryCoreIdentityFacts, TreasuryCoreWorstCaseLeg } from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  performTreasuryKernelFullReset,
  performTreasuryFullReset,
  captureTreasuryHostBreakpoint,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { createTreasuryHostJournal, executeTreasuryAdmittedDispatch, makeTreasuryExactOracleAdapter } from "@mock/treasuryExactOracle";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";

// ── 公共 fixture ────────────────────────────────────────────────────────────

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

type Admission = ReturnType<TreasuryService["authorizeTreasuryActionContract"]> & { status: "admitted"; attemptId: string; dispatch: unknown };

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs): Admission {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission as Admission;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── R1：独立 endTick 反向重入 + 尾部旧预算覆盖（任务书 §2.1） ────────────────

function r1Identity(actionKind: string): TreasuryCoreIdentityFacts {
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

function r1Legs(outflow: number): TreasuryCoreWorstCaseLeg[] {
  return [
    { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -outflow },
    { roomName: "W2N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: outflow },
  ];
}

describe("R1 基线反例：独立 endTick 未取得推进锁 + 尾部旧预算覆盖持久较新预算", () => {
  it("onEffect 重入 beginTick 后：嵌套应零推进、预算不回退、累计释放不超 4——基线三者全红", () => {
    const releaseCalls: string[] = [];
    const budgetTrace: { at: string; budgetUsed: number }[] = [];
    let kernelNow: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let nestedStats: { recovered: number; closed: number; cleaned: number; cancelled: number } | undefined;
    let reentered = false;
    let captured: TreasuryHostBreakpoint | undefined;
    let attemptIdA = "";
    const readBudget = (): number =>
      (Memory.runtime?.treasuryCore as unknown as { recovery?: { budgetUsed?: number } } | undefined)?.recovery?.budgetUsed ?? 0;
    const ports: TreasuryCoreKernelPorts = {
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      // 两个 kind：C 的普通 adapter（not_executed）；A 的捕获型 adapter
      //（dispatch_start 已发布、dispatch_result 未写时捕获断点——A 的
      // dispatching 残留从真实执行边界获得）。
      findAdapter: (kind: string) => {
        if (kind === "r1.capture") {
          return {
            kind,
            version: 1,
            registrationId: "reg-r1.capture",
            semanticIdentity: "d.adapter-r1.capture",
            settlesOnAccept: false,
            nonOkOutcome: "not_executed" as const,
            execute: () => {
              captured = captureTreasuryHostBreakpoint();
              return { ok: false };
            },
          };
        }
        return {
          kind,
          version: 1,
          registrationId: "reg-r1.plain",
          semanticIdentity: "d.adapter-r1.plain",
          settlesOnAccept: false,
          nonOkOutcome: "not_executed" as const,
          execute: () => ({ ok: false }),
        };
      },
      checkAdmissionCapacity: () => null,
      observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return true;
      },
      onEffect: (effect: unknown) => {
        const typed = effect as { effect?: string; attemptId?: string };
        if (typed?.effect === "recovered_to_unknown" && typed.attemptId === attemptIdA && !reentered) {
          reentered = true;
          nestedStats = kernelNow.beginTick(); // 回调重入（基线：可获推进权）
          budgetTrace.push({ at: "after-nested-beginTick", budgetUsed: readBudget() });
        }
      },
    };
    const r1Admit = (kernel: TreasuryCoreKernel, actionKind: string, consumers: readonly string[], workKey: string): { attemptId: string; dispatch: unknown } => {
      const input: TreasuryCoreAdmissionInput = {
        workKey,
        identity: r1Identity(actionKind),
        worstCase: r1Legs(50),
        externalConsumers: consumers,
        canonicalArgs: { n: 1 },
        postings: r1Legs(50),
        admissionContext: { contractId: `ac:${actionKind}`, contractDigest: "a".repeat(16), actionKind, ownerIdentity: null, excludeAttemptId: null },
        structureBindings: [],
      };
      const admitted = kernel.admit(input);
      if (admitted.status !== "admitted") throw new Error(`admit ${workKey} failed`);
      return { attemptId: admitted.attemptId, dispatch: admitted.dispatch };
    };
    const consumers = ["ext:r1:D0", "ext:r1:D1", "ext:r1:D2", "ext:r1:D3", "ext:r1:D4", "ext:r1:D5", "ext:r1:D6", "ext:r1:D7"];
    const kernel0 = createTreasuryCoreKernel(ports);
    // C：8 消费者义务，执行 → closing(not_executed)
    const c = r1Admit(kernel0, "r1.plain", consumers, "biz:r1:C");
    if (kernel0.executeDispatch(c.dispatch).status !== "not_executed") throw new Error("C dispatch failed");
    // A：执行时 adapter 捕获断点（A=dispatching、C=closing、本 tick 预算 0）
    const a = r1Admit(kernel0, "r1.capture", [], "biz:r1:A");
    attemptIdA = a.attemptId;
    void kernel0.executeDispatch(a.dispatch);
    if (captured === undefined) throw new Error("断点未捕获");

    // 恢复选定断点：首个生命周期入口必须是 endTick（runBeginTick:false）
    Game.time += 1;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: captured, runBeginTick: false });
    kernelNow = reset.kernel;
    const shape = (id: string): { phase?: string; cleanup?: { consumerKeys?: readonly string[] } } =>
      (Memory.runtime!.treasuryCore as unknown as { active: Record<string, { phase: string; cleanup?: { consumerKeys: readonly string[] } }> }).active[id];
    expect(shape(a.attemptId).phase).toBe("dispatching"); // 前提：A 为真实执行边界残留
    expect(readBudget()).toBe(0); // 前提：选定测试 tick 的持久预算为 0

    kernelNow.endTick(); // 独立 endTick：恢复 A（预算 0→1）
    budgetTrace.push({ at: "after-endTick", budgetUsed: readBudget() });
    kernelNow.beginTick(); // 同 tick 正常窗口
    budgetTrace.push({ at: "after-beginTick", budgetUsed: readBudget() });

    // 轨迹留档（任务书 §2.1：不能只读最后 budgetUsed）
    console.log("R1-TRACE " + JSON.stringify({ budgetTrace, releaseCalls, nestedStats, remaining: shape(c.attemptId).cleanup?.consumerKeys?.length }));

    // 修复后语义（基线全红）：
    expect(nestedStats).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // 嵌套零推进（基线 cleaned:3）
    expect(releaseCalls).toEqual(["ext:r1:D0", "ext:r1:D1", "ext:r1:D2"]); // 累计 3 次释放（基线 6 次 > 4 上限）
    const afterNested = budgetTrace[0]!.budgetUsed;
    const afterEnd = budgetTrace[1]!.budgetUsed;
    expect(afterEnd).toBeGreaterThanOrEqual(afterNested); // 预算不回退（基线 1 < 7）
    expect(readBudget()).toBe(7); // 本 tick 累计预算 7
    expect(shape(c.attemptId).phase).toBe("closing"); // C 仍在清理（5 项剩余义务，下一 tick 继续）
    expect(shape(c.attemptId).cleanup?.consumerKeys?.length).toBe(5);
  });
});

// ── V1：同参数错身份（任务书 §3.1） ─────────────────────────────────────────

describe("V1 基线反例：作用域声明 B、实际提交许可 A（同参数）", () => {
  it("事件必须只归实际提交的许可 A——基线上 entered/effect 被错记到 B", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:v1:A", args);
    const b = admit(service, "biz:v1:B", args); // 资源足够支持两笔

    // 旧工具路径（identity 与 fn 实际提交的许可分离）已从公共 API 删除——
    // 等价错配输入：聚合结果声明 B 的 attempt、实际携带 A 的 dispatch 许可。
    expect(() => executeTreasuryAdmittedDispatch(journal, service, { status: "admitted", attemptId: b.attemptId, dispatch: a.dispatch })).toThrow(/不一致/);

    // 正常路径：包装执行 A——事件只归实际许可 A
    const outcome = executeTreasuryAdmittedDispatch(journal, service, a);
    expect(outcome.status).toBe("committed");
    expect(journal.visibleFor(a.attemptId).map((e) => e.kind)).toEqual(["adapter-entered", "world-effect"]); // 归实际许可 A
    expect(journal.visibleFor(b.attemptId)).toEqual([]); // B 未执行，不借 A 的事件
    // 世界只发生 A 的一笔变化
    const from = (Game.rooms["W1N57"] as unknown as Record<string, { store: Record<string, number> }>).storage.store.energy;
    expect(from).toBe(900);
  });
});

// ── V2：断点事件来源错配（任务书 §4.1） ─────────────────────────────────────

describe("V2 基线反例：捕获器收 J2 marker、adapter 实际用 J1", () => {
  it("恢复入口必须在对账前拒绝错来源——基线上世界 1000 却误判 committed", () => {
    const j1 = createTreasuryHostJournal(); // 实际执行 adapter 的 journal
    const j2 = createTreasuryHostJournal(); // 另一份
    const oracle1 = makeTreasuryExactOracleAdapter(j1);
    replaceTreasuryActionAdapterForTest(oracle1);
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const args = transferArgs({ amount: 100 });
    const a = admit(service, "biz:v2:A", args);

    let b0: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        b0 = captureTreasuryHostBreakpoint(j2.captureBranch()); // 错配：效果前 Memory/世界 + J2 的分支标记
      },
    });
    const outcome = executeTreasuryAdmittedDispatch(j1, service, a);
    interceptor.restore();
    expect(outcome.status).toBe("persist_failed"); // interceptor 拦掉后续写（效果已发生、记入 J1）
    if (b0 === undefined) throw new Error("B0 未捕获");

    // 修复后语义：恢复入口对账前拒绝错来源（基线不抛 → 红）
    expect(() =>
      performTreasuryFullReset({
        roomSpecs: ROOMS,
        adapter: makeTreasuryExactOracleAdapter(j1),
        breakpoint: b0,
      }),
    ).toThrow(/事件来源/);
  });
});
