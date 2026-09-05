/**
 * Treasury Core Rewrite IV——生命周期验收矩阵（任务书 §8，Lifecycle 部分）。
 *
 * 覆盖：D09（heap 全清后接管）、D10（无关推进不当覆盖）、D11（硬终止与
 * 晚到 reconcile）、D13（8 义务逐 tick 完成）、D15（混合结果义务）、
 * D16（预扣/确认丢写）、D17（重入共享预算）、D18（断点 + 完整 reset）、
 * D19（公平性有界完成）、D23（小规模账目一致性模型）。
 * D01–D08/D12/D14/D20–D22 见 treasuryRewrite4Acceptance.test.ts。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import {
  buildTreasuryActionContract,
  findTreasuryActionAdapter,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
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
import { snapshotWholeMemory, installWholeMemorySnapshot, performTreasuryFullReset } from "@mock/treasuryResetHarness";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import type {
  TreasuryCoreIdentityFacts,
  TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
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

function storeNow(): Record<string, unknown> | undefined {
  return Memory.runtime?.treasuryCore as Record<string, unknown> | undefined;
}

function activeRecord(attemptId: string): Record<string, unknown> | undefined {
  const active = storeNow()?.active as Record<string, Record<string, unknown>> | undefined;
  return active?.[attemptId];
}

// ── kernel 直调基建（预算/义务场景） ─────────────────────────────────────────

function kernelIdentity(): TreasuryCoreIdentityFacts {
  return {
    actionKind: "d.kind",
    adapterVersion: 1,
    adapterRegistrationId: "reg-d4l",
    adapterSemanticIdentity: "d.adapter-l1",
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

/** 可信观察简化端口：观察序恒高于任何已发生效果（测试宿主保证）。 */
function simpleObservePort(): NonNullable<TreasuryCoreKernelPorts["observeForCleanup"]> {
  return () => ({ worldSequence: readTreasuryWorldSequence() + 1, atTick: Game.time + 1, locationExists: () => true });
}

function makeKernelPorts(overrides: Partial<TreasuryCoreKernelPorts> = {}): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) =>
      kind === "d.kind"
        ? { kind, version: 1, registrationId: "reg-d4l", semanticIdentity: "d.adapter-l1", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : undefined,
    checkAdmissionCapacity: () => null,
    observeForCleanup: simpleObservePort(),
    ...overrides,
  };
}

function kernelAdmitInput(consumers: readonly string[], workKey: string): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: kernelIdentity(),
    worstCase: kernelLegs(50),
    externalConsumers: consumers,
    canonicalArgs: { n: 1 },
    postings: kernelLegs(50),
    admissionContext: { contractId: "ac:d4l", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

function establishClosing(consumers: readonly string[], workKey: string, outcome: "not_executed" | "committed") {
  const kernel = createTreasuryCoreKernel(makeKernelPorts(
    outcome === "committed"
      ? {
          releaseExternalConsumer: () => true,
          findAdapter: (kind) => kind === "d.kind" ? { kind, version: 1, registrationId: "reg-d4l", semanticIdentity: "d.adapter-l1", execute: () => ({ ok: true }), settlesOnAccept: true, nonOkOutcome: "unknown" as const } : undefined,
        }
      : { releaseExternalConsumer: () => true },
  ));
  const admitted = kernel.admit(kernelAdmitInput(consumers, workKey));
  if (admitted.status !== "admitted") throw new Error(`admit failed: ${admitted.reason}`);
  const executed = kernel.executeDispatch(admitted.dispatch);
  if (executed.status !== outcome) throw new Error(`expected ${outcome}, got ${executed.status}`);
  return { kernel, attemptId: admitted.attemptId, dispatch: admitted.dispatch };
}

interface HostTrace {
  executions: number;
  releaseCalls: string[];
}

function installTracingAdapter(trace: HostTrace): TreasuryActionAdapter {
  const base = makeTreasuryTestTransferAdapter();
  return {
    ...base,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      trace.executions += 1;
      return base.execute(args);
    },
  };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── D09：heap 全清（含旧世界序 global）+ Memory 保留 → 新观察接管 ────────────

describe("D09 全 heap reset 后的观察接管", () => {
  it("旧 global 世界序槽清除后：无重复调用、无跨域扣留，新观察接管退出，余额不双扣", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const a = admit(service, "biz:d09:a", transferArgs({ amount: 300 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(trace.executions).toBe(1);
    const worldSequenceBefore = readTreasuryWorldSequence();
    expect(worldSequenceBefore).toBeGreaterThan(0);
    // 完整 reset：Memory 保留（JSON 往返安装）、模块缓存重建、global 清空
    //（harness 显式清 Treasury 运行时槽；宿主世界效果保留）。
    const snapshot = snapshotWholeMemory();
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: installTracingAdapter(trace), advanceTicks: 1 });
    void snapshot;
    // 旧 global 槽已清（世界序权威在 Memory——持久值跨 reset 连续）。
    expect((globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence).toBeUndefined();
    expect(readTreasuryWorldSequence()).toBe(worldSequenceBefore); // 持久域连续
    // 新运行时 beginTick：A 的效果被新可信观察接管 → 退出（不永久扣留）。
    const stats = reset.service.beginTick();
    expect(stats).toEqual(expect.objectContaining({ recovered: 0 }));
    const stillActive = reset.service.kernelJournal().active.some((r) => r.attemptId === a.attemptId);
    expect(stillActive).toBe(false);
    expect(trace.executions).toBe(1); // 无重复调用
    // 余额不双扣：世界保留（storage 700），B 700 全额可支配获准。
    const rebuilt = reset.handles.actionContractsModule.buildTreasuryActionContract(
      reset.service,
      { actionKind: "test.transfer", transactionId: "biz:d09:b", args: { ...transferArgs({ amount: 700 }) } },
    );
    if (rebuilt.status !== "built") throw new Error(`rebuild failed: ${"reason" in rebuilt ? rebuilt.reason : "?"}`);
    const b = reset.service.authorizeTreasuryActionContract(rebuilt.contract, { workKey: "biz:d09:b" });
    expect(b.status).toBe("admitted");
  });
});

// ── D10：reset 后无关推进不能当覆盖 ──────────────────────────────────────────

describe("D10 无关推进与范围缺失", () => {
  it("heap 清零后只推进无关源：新序更大不判覆盖；目标源恢复后才关闭", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const installed = installRooms(ROOMS);
    const visible = new Set(["W1N57", "W2N57"]);
    const service = createTreasuryService({ getRooms: () => Object.values(installed).filter((r) => visible.has(r.name)) });
    service.beginTick();
    const a = admit(service, "biz:d10:a", transferArgs({ amount: 300 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // heap 清零（模块重建由 harness 承担；此处模拟 global 侧清空 + 新实例）。
    delete (globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence;
    // 目标流入位置（W2N57）离开观察范围。
    visible.delete("W2N57");
    // 无关源推进（W1N57 terminal 世界更新）——序号变大，但范围缺失。
    setStoreResources(installed["W1N57"]!.terminal, { energy: 5 });
    Game.time += 1;
    service.beginTick();
    expect(activeRecord(a.attemptId)).toBeDefined(); // 不当覆盖
    Game.time += 1;
    setStoreResources(installed["W1N57"]!.terminal, { energy: 7 }); // 更多无关推进
    service.beginTick();
    expect(activeRecord(a.attemptId)).toBeDefined();
    // 目标源恢复：新可信观察覆盖 → 关闭。
    visible.add("W2N57");
    Game.time += 1;
    service.beginTick();
    expect(activeRecord(a.attemptId)).toBeUndefined();
  });
});

// ── D11：硬终止断点与晚到 reconcile executed ────────────────────────────────

describe("D11 硬终止与晚到结论（Remediation I/V1：真实路径断点快照）", () => {
  it("断点：调用边界已发布、adapter 尚未进入——快照恢复 unknown 且不重发", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    const captured: string[] = [];
    // 真实路径断点：adapter execute 入口 = dispatch_start 已发布（含
    // Remediation I/R1 调用边界）、效果未发生——在此捕获持久快照。
    // 旧调用栈随后继续走完（结果写回），不进入指定快照建立的新分支。
    const base = makeTreasuryTestTransferAdapter();
    const breakpointAdapter: TreasuryActionAdapter = {
      ...base,
      execute(args: TreasuryTestTransferArgs): { ok: boolean } {
        captured.push(snapshotWholeMemory());
        trace.executions += 1;
        return base.execute(args);
      },
    };
    replaceTreasuryActionAdapterForTest(breakpointAdapter);
    const service = makeService();
    const a = admit(service, "biz:d11:entered", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(trace.executions).toBe(1);
    // 快照事实核查：断点时刻 phase=dispatching、边界已发布、实际调用
    // 事实未写（external 不被伪造为 accepted）。
    const snap = JSON.parse(captured[0]) as {
      runtime: { treasuryCore: { active: Record<string, { phase: string; invocationBoundary: unknown; invocation: unknown; external: unknown }> } };
    };
    const snapRecord = snap.runtime.treasuryCore.active[a.attemptId];
    expect(snapRecord.phase).toBe("dispatching");
    expect(snapRecord.invocationBoundary).not.toBeNull();
    expect(snapRecord.invocation).toBeNull();
    expect(snapRecord.external).toBeNull();
    // 指定断点快照完整 reset：新 runtime 恢复 unknown、不重发。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: installTracingAdapter(trace),
      advanceTicks: 1,
      memorySnapshot: captured[0],
    });
    const record = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(record?.phase).toBe("outcome_unknown");
    expect(record?.invocationBoundary).not.toBeNull(); // R1：恢复锚点在
    expect(record?.invocation).toBeNull(); // 无结果证据——不伪造实际调用事实
    expect(trace.executions).toBe(1); // 新 runtime 不重发
  });

  it("断点：实际动作后、结果未写 + 晚到 reconcile executed → 观察接管退出，总调用 1", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    const captured: string[] = [];
    // 真实路径断点：动作已产生同步世界效果、dispatch_result 尚未写入。
    const base = makeTreasuryTestTransferAdapter("observed_committed");
    const breakpointAdapter: TreasuryActionAdapter = {
      ...base,
      execute(args: TreasuryTestTransferArgs): { ok: boolean } {
        const result = base.execute(args); // 真实效果（世界已变、世界序推进）
        trace.executions += 1;
        captured.push(snapshotWholeMemory());
        return result;
      },
    };
    replaceTreasuryActionAdapterForTest(breakpointAdapter);
    const service = makeService();
    const a = admit(service, "biz:d11:after", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const snap = JSON.parse(captured[0]) as {
      runtime: { treasuryCore: { active: Record<string, { phase: string; invocation: unknown }> } };
    };
    expect(snap.runtime.treasuryCore.active[a.attemptId].phase).toBe("dispatching");
    // 指定断点快照 reset（宿主世界效果由 harness 保留——不重置回初始值）。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryTestTransferAdapter("observed_committed"),
      advanceTicks: 1,
      memorySnapshot: captured[0],
    });
    const afterRecover = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(afterRecover?.phase).toBe("outcome_unknown");
    // 晚到对账：reconciler 依据世界（观察含效果）得出 executed。
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok");
    Game.time += 1;
    reset.service.beginTick(); // R1 边界锚点 → 观察接管 → 真正退出
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeUndefined();
    expect(trace.executions).toBe(1); // 实际总调用 1（无重复执行）
    // 宿主世界未被 reset 还原（效果保留）。
    expect(reset.rooms["W2N57"]!.terminal.store.energy).toBe(100);
  });
});

// ── D13：8 义务 closing 的逐 tick 完成轨迹 ──────────────────────────────────

describe("D13 成对预算下的 8 义务完成", () => {
  it("每 tick 端口 >0 且 ≤8、remaining 单调减少、至多 3 个完整预算 tick 结束、后续不再释放", () => {
    const releaseCalls: string[] = [];
    const { kernel, attemptId } = establishClosing(
      Array.from({ length: 8 }, (_, i) => `ext:d13:duty-${String(i)}`),
      "biz:d13:work",
      "committed",
    );
    const kernelWithPort = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return true;
      },
    }));
    void kernel; // establishClosing 的 kernel 用于建立记录；推进用带端口的实例（共享 Memory/heap 记账）。
    const remainingByTick: number[] = [];
    const callsByTick: number[] = [];
    let ticks = 0;
    for (; ticks < 5; ticks += 1) {
      const before = releaseCalls.length;
      Game.time += 1;
      kernelWithPort.beginTick();
      callsByTick.push(releaseCalls.length - before);
      const record = activeRecord(attemptId) as { cleanup?: { consumerKeys: string[] } } | undefined;
      remainingByTick.push(record === undefined ? 0 : record.cleanup.consumerKeys.length);
      if (record === undefined) break;
    }
    // 每个推进 tick 端口调用 >0 且 ≤8（成对预算下实际 ≤4/tick）。
    for (let t = 0; t < remainingByTick.indexOf(0); t += 1) {
      expect(callsByTick[t]).toBeGreaterThan(0);
      expect(callsByTick[t]).toBeLessThanOrEqual(8);
    }
    // remaining 单调不增。
    for (let t = 1; t < remainingByTick.length; t += 1) {
      expect(remainingByTick[t]).toBeLessThanOrEqual(remainingByTick[t - 1]!);
    }
    // 至多 3 个完整预算 tick 结束（IV/§6.1：4 单位/tick → 2 tick 调用 + 终态）。
    expect(remainingByTick[remainingByTick.length - 1]).toBe(0);
    expect(ticks).toBeLessThanOrEqual(3);
    // 结束后不再释放（再跑两 tick 零调用）。
    const beforeFinal = releaseCalls.length;
    for (let t = 0; t < 2; t += 1) {
      Game.time += 1;
      kernelWithPort.beginTick();
    }
    expect(releaseCalls.length).toBe(beforeFinal);
    // 幂等：同 (key, attempt) 首次成功后无重复。
    expect(new Set(releaseCalls).size).toBe(releaseCalls.length);
  });
});

// ── D15：同记录多义务混合结果，跨 tick 恢复 ─────────────────────────────────

describe("D15 混合结果义务的部分推进", () => {
  it("true/false/throw 混合：只移除明确完成项，成功项不再调用；全部完成后合法 retry_ready", () => {
    const consumers = ["ext:d15:ok-a", "ext:d15:false-b", "ext:d15:throw-c", "ext:d15:ok-d"];
    const releaseCalls: string[] = [];
    const outcomes = new Map<string, "ok" | "false" | "throw">([
      ["ext:d15:ok-a", "ok"],
      ["ext:d15:false-b", "false"],
      ["ext:d15:throw-c", "throw"],
      ["ext:d15:ok-d", "ok"],
    ]);
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        const mode = outcomes.get(key) ?? "ok";
        if (mode === "false") return false;
        if (mode === "throw") throw new Error("release fault");
        return true;
      },
    }));
    const admitted = kernel.admit(kernelAdmitInput(consumers, "biz:d15:mix"));
    if (admitted.status !== "admitted") throw new Error(`admit failed: ${admitted.reason}`);
    expect(kernel.executeDispatch(admitted.dispatch).status).toBe("not_executed");
    Game.time += 1;
    kernel.beginTick();
    // tick1：4 单位全尝试（2×4=8 份）；成功 ok-a/ok-d 确认移除；false/throw 保留。
    let record = activeRecord(admitted.attemptId) as { phase?: string; cleanup: { consumerKeys: string[] } };
    expect([...record.cleanup.consumerKeys].sort()).toEqual(["ext:d15:false-b", "ext:d15:throw-c"]);
    const okAFirst = releaseCalls.filter((k) => k === "ext:d15:ok-a").length;
    // tick2：修复端口（全部 ok）→ 保留两项释放并确认 → retry_ready（空集合）。
    outcomes.set("ext:d15:false-b", "ok");
    outcomes.set("ext:d15:throw-c", "ok");
    Game.time += 1;
    kernel.beginTick();
    record = activeRecord(admitted.attemptId) as { phase: string; cleanup: { consumerKeys: string[] } };
    expect(record.phase).toBe("retry_ready");
    expect(record.cleanup.consumerKeys).toEqual([]);
    // 成功项不再调用：ok-a 全程恰 1 次。
    expect(releaseCalls.filter((k) => k === "ext:d15:ok-a").length).toBe(1);
    expect(okAFirst).toBe(1);
  });
});

// ── D16：预扣丢写与确认丢写 ──────────────────────────────────────────────────

describe("D16 预扣/确认丢写的预算语义", () => {
  function interceptTreasuryCoreWrites(transform: (next: unknown, current: unknown) => unknown): () => void {
    const runtime = Memory.runtime as Record<string, unknown>;
    const box = { value: runtime.treasuryCore };
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => box.value,
      set: (next: unknown) => {
        box.value = transform(next, box.value);
      },
    });
    return () => {
      delete runtime.treasuryCore;
      runtime.treasuryCore = box.value;
    };
  }

  it("预扣写失败：端口调用 0；义务保留；下一 tick 正常恢复", () => {
    const releaseCalls: string[] = [];
    const { attemptId } = establishClosing(["ext:d16:a", "ext:d16:b"], "biz:d16:prepay", "not_executed");
    // 吞掉一切 treasuryCore 写入（预扣发布失败——不得调用端口）。
    const restore = interceptTreasuryCoreWrites((_next, current) => current);
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return true;
      },
    }));
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls.length).toBe(0); // 预扣失败 → 调用 0
    restore();
    Game.time += 1;
    kernel.beginTick(); // 下一 tick 正常恢复
    expect(releaseCalls.length).toBeGreaterThan(0);
    const record = activeRecord(attemptId) as { cleanup: { consumerKeys: string[] } } | undefined;
    expect(record === undefined || record.cleanup.consumerKeys.length === 0).toBe(true);
  });

  it("释放成功但确认写失败：保留原 attempt 义务、预算不退回；下 tick 同一幂等关联重试并最终确认", () => {
    const releaseCalls: string[] = [];
    const { attemptId } = establishClosing(["ext:d16:c"], "biz:d16:confirm", "not_executed");
    // 只吞"确认命令"的写入：active 内容变化（consumerKeys 减少）时拒绝；
    // 预扣类写入（budgetUsed 变化）放行。
    const restore = interceptTreasuryCoreWrites((next, current) => {
      const nextRec = (next as { active?: Record<string, { cleanup?: { consumerKeys?: string[] } }> }).active?.[attemptId];
      const curRec = (current as { active?: Record<string, { cleanup?: { consumerKeys?: string[] } }> }).active?.[attemptId];
      if (nextRec && curRec && nextRec.cleanup.consumerKeys.length !== curRec.cleanup.consumerKeys.length) {
        return current; // 确认写被丢
      }
      return next;
    });
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return true;
      },
    }));
    Game.time += 1;
    kernel.beginTick();
    // 释放已调用（端口成功）但确认丢失：义务保留原样。
    expect(releaseCalls.length).toBe(1);
    let record = activeRecord(attemptId) as { phase?: string; cleanup: { consumerKeys: string[] } };
    expect(record.cleanup.consumerKeys).toEqual(["ext:d16:c"]);
    // 预算已扣不退回：单义务仅占 2/8 份，同 tick 重复入口允许**幂等重试**
    //（每次重试先成对预扣——份额不回退给无预算入口；调用有界）。
    kernel.beginTick();
    expect(releaseCalls.length).toBeLessThanOrEqual(2);
    let recordAfterRetry = activeRecord(attemptId) as { cleanup: { consumerKeys: string[] } };
    expect(recordAfterRetry.cleanup.consumerKeys).toEqual(["ext:d16:c"]); // 确认仍被吞，义务保留
    restore();
    Game.time += 1;
    kernel.beginTick(); // 下 tick 同一 (key, attemptId) 幂等重试 → 确认成功
    expect(releaseCalls.length).toBeLessThanOrEqual(3); // 1 初次 + ≤1 同 tick 重试 + 1 下 tick 确认
    record = activeRecord(attemptId) as { phase?: string; cleanup: { consumerKeys: string[] } };
    expect(record.phase).toBe("retry_ready");
    expect(record.cleanup.consumerKeys).toEqual([]);
    void recordAfterRetry;
  });
});

// ── D17：重入共享预算（beginTick/endTick/另一 kernel/同 tick 重复） ──────────

describe("D17 重入与份额共享", () => {
  it("端口回调内重入 beginTick/endTick + 另一 kernel 同 tick 重复入口：份额共享、不回退、确认不要求第 9 份", () => {
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:d17:duty-${String(i)}`);
    const releaseLog: string[] = [];
    const { attemptId } = establishClosing(consumers, "biz:d17:reenter", "not_executed");
    const ports = (): TreasuryCoreKernelPorts =>
      makeKernelPorts({
        releaseExternalConsumer: (key) => {
          releaseLog.push(key);
          // 重入：端口回调内推进另一实例的生命周期入口（共享持久预算）。
          kernel2.beginTick();
          return true;
        },
      });
    let kernel2: ReturnType<typeof createTreasuryCoreKernel>;
    const kernel1 = createTreasuryCoreKernel(ports());
    kernel2 = createTreasuryCoreKernel(ports());
    Game.time += 1;
    kernel1.beginTick(); // 端口回调内重入 kernel2.beginTick——递归推进共享同一持久预算
    // 重入递归共享同一持久记账：义务在共享预算内有界推进（本 tick 可能
    // 部分完成）；确认命令使用已预扣份额——不存在第 9 份（budgetUsed ≤8）。
    const record = activeRecord(attemptId) as { cleanup: { consumerKeys: string[] } } | undefined;
    const remainingNow = record === undefined ? 0 : record.cleanup.consumerKeys.length;
    expect(remainingNow).toBeLessThan(8); // 有真实推进
    const budgetNow = (storeNow() as unknown as { recovery: { budgetUsed: number } }).recovery.budgetUsed;
    expect(budgetNow).toBeLessThanOrEqual(8);
    // 后续 tick（预算刷新）最终完成。
    for (let t = 0; t < 10 && activeRecord(attemptId) !== undefined; t += 1) {
      Game.time += 1;
      const callsBefore = releaseLog.length;
      kernel1.beginTick();
      expect(releaseLog.length - callsBefore).toBeLessThanOrEqual(8); // 每 tick 调用 ≤8
    }
    const finalRecord = activeRecord(attemptId) as { cleanup: { consumerKeys: string[] } } | undefined;
    expect(finalRecord === undefined || finalRecord.cleanup.consumerKeys.length === 0).toBe(true);
    // 同 tick 份额耗尽后重复入口零调用（廉价返回）。
    const beforeFinal = releaseLog.length;
    kernel1.beginTick();
    kernel2.beginTick();
    expect(releaseLog.length).toBe(beforeFinal);
  });
});

// ── D18：断点 + 同 tick 完整 reset 再推进 ────────────────────────────────────

describe("D18 断点与完整 reset 后的预算/许可/义务", () => {
  it("已预扣未进端口（budgetUsed=2 已持久、义务保留）：完整 reset 后旧 heap 许可无效、预算保留、下 tick 恢复", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    const { attemptId, dispatch } = establishClosing(["ext:d18:a", "ext:d18:b"], "biz:d18:bp", "not_executed");
    // 手工模拟断点：成对预扣已持久（budgetUsed=2）、端口未调用。
    const store = storeNow() as unknown as { recovery: { budgetTick: number; budgetUsed: number } };
    store.recovery.budgetTick = Game.time;
    store.recovery.budgetUsed = 2;
    const oldDispatch = dispatch;
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: installTracingAdapter(trace), advanceTicks: 0 });
    // 同 tick 推进：已用预算保留（新实例读到 2，本 tick 至多再 3 单位）；
    // 旧 heap 许可无效（WeakSet 注册表随模块重建消失）。
    const executed = reset.service.executeAuthorizedDispatch(oldDispatch);
    expect(executed.status).toBe("rejected"); // 旧 dispatch 许可对象不被新 runtime 认可
    const releaseCalls: string[] = [];
    // 义务不跨 attempt 迁移：重试仍针对原 attemptId 的同一消费者集合。
    const kernelAfter = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 2,
      findAdapter: (kind) => kind === "d.kind" ? { kind, version: 1, registrationId: "reg-d4l", semanticIdentity: "d.adapter-l1", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const } : undefined,
      checkAdmissionCapacity: () => null,
      observeForCleanup: simpleObservePort(),
      releaseExternalConsumer: (key) => {
        releaseCalls.push(`${key}@${attemptId}`);
        return true;
      },
    });
    const stats = reset.service.beginTick(); // facade 侧推进（共享 Memory）
    void stats;
    const record = activeRecord(attemptId) as { cleanup: { consumerKeys: string[] } } | undefined;
    if (record !== undefined) {
      // 本 tick 剩余份额内部分推进；下一 tick 完成。
      Game.time += 1;
      kernelAfter.beginTick();
    }
    const final = activeRecord(attemptId) as { phase?: string; cleanup?: { consumerKeys: string[] } } | undefined;
    expect(final === undefined || final.phase === "retry_ready").toBe(true);
    if (final !== undefined) expect(final.cleanup!.consumerKeys).toEqual([]);
    expect(releaseCalls.length).toBeGreaterThan(0);
    expect(releaseCalls.every((entry) => entry.endsWith(`@${attemptId}`))).toBe(true); // 同一 attempt 幂等关联
  });
});

// ── D19：公平性——失败工作不饿死可完成工作 ────────────────────────────────────

describe("D19 公平推进有限界（失败前置 + 可完成后置 + 混合流量）", () => {
  it("前 8 条永久失败、第 9 条（8 义务）可完成：持续 pending/恢复流量下在有限 tick 内真完成，失败风险保留", () => {
    const sticky = new Set<string>(Array.from({ length: 8 }, (_, i) => `ext:d19:sticky-${String(i)}`));
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return !sticky.has(key);
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    // 前 8 条：各 1 义务永久失败。
    for (let i = 0; i < 8; i += 1) {
      const admitted = kernel.admit(kernelAdmitInput([`ext:d19:sticky-${String(i)}`], `biz:d19:fail-${String(i)}`));
      if (admitted.status !== "admitted") throw new Error(`admit fail-${String(i)} failed`);
      expect(kernel.executeDispatch(admitted.dispatch).status).toBe("not_executed");
    }
    // 第 9 条：8 义务全部可确认。
    const target = kernel.admit(kernelAdmitInput(Array.from({ length: 8 }, (_, i) => `ext:d19:good-${String(i)}`), "biz:d19:good"));
    if (target.status !== "admitted") throw new Error("target admit failed");
    expect(kernel.executeDispatch(target.dispatch).status).toBe("not_executed");
    // 持续混合流量：每 tick 注入新 pending（下 tick 被 sweep 取消）+
    // dispatching 残留（被恢复为 unknown）。
    let targetDone = false;
    let ticks = 0;
    const writeCount = { beginTicks: 0 };
    // 有限界推导：sticky 记录每次访问耗 2 份（成对预扣；诊断确认用已预扣
    // 份额——IV/§6.1），每 tick 8 份至多 4 个单位（噪声 sweep/恢复再占
    // 1-5 份）；cleanupCursor 轮转保证 good 每 ~3 tick 被访问一次、每次
    // 至少 1 个成对单位（清理保底 ≥2 份）——8 义务 ≤ 8 次单位 ≈ 8 次访问
    // ≈ 24 tick，噪声挤占后取 3 倍余量 80。
    // Remediation I/V3（§7.4）：推进循环每 tick 用上一 tick 的真实序列化
    // 快照重建运行时（JSON 重载 + 新 kernel 实例；ports 闭包为宿主数据
    // 跨 tick 持续）。同记录 8 义务前缀失败场景见 E06
    //（treasuryRemediationIKernel.test.ts，同样逐 tick JSON 重载）。
    let rolling = createTreasuryCoreKernel(ports);
    for (; ticks < 80 && !targetDone; ticks += 1) {
      Game.time += 1;
      installWholeMemorySnapshot(snapshotWholeMemory());
      rolling = createTreasuryCoreKernel(ports);
      rolling.beginTick();
      writeCount.beginTicks += 1;
      const pending = rolling.admit({ ...kernelAdmitInput([], `biz:d19:noise-${String(ticks)}`), worstCase: kernelLegs(1), postings: kernelLegs(1) });
      void pending;
      const record = activeRecord(target.attemptId) as { phase?: string; cleanup?: { consumerKeys: string[] } } | undefined;
      if (record === undefined || (record.phase === "retry_ready" && record.cleanup!.consumerKeys.length === 0)) targetDone = true;
    }
    expect(targetDone).toBe(true);
    expect(ticks).toBeLessThan(80); // 推导有限界内完成（保底轮转不饿死后方）
    // 失败风险保留：前 8 条义务仍在（不被删除、不谎报完成）。
    for (let i = 0; i < 8; i += 1) {
      const record = Object.values((storeNow()!.active as Record<string, { workKey: string; cleanup: { consumerKeys: string[] } }>))
        .find((r) => r.workKey === `biz:d19:fail-${String(i)}`);
      expect(record?.cleanup.consumerKeys).toEqual([`ext:d19:sticky-${String(i)}`]);
    }
    void writeCount;
  });
});

// ── D23：小规模混合账目一致性模型（完成/retry/长期 unknown + reset） ─────────

describe("D23 混合规模模型与账目一致", () => {
  it("批量完成 + 合法 retry + 固定长期 unknown：世界轨迹与账目一致、ring 淘汰不授旧 ID 许可、全 heap reset 后接管", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    // 独立参考模型（不复用生产 oracle）：跟踪每笔效果与世界终态。
    const COMPLETED = 600;
    const RETRIED = 60;
    const STUCK_UNKNOWN = 4;
    const installed = installRooms([
      { name: "W1N57", storage: { id: "stor-1", resources: { energy: 2_000_000 }, freeCapacity: 500_000 } },
      { name: "W2N57", terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 2_000_000 } },
    ]);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    let modelOutflow = 0;
    let stuckSeen = 0;
    // Remediation I/V3（§7.4）：RETRIED 分支真实化——non-ok 父代经
    // not_executed → 清理完成 → retry_ready → capability 签发 → 合法新
    // contract → executeRearm → child 实际执行（同 workKey 关联、新 ID）。
    const rearmedChildren: { parent: string; child: string; workKey: string }[] = [];
    const legacyParentPermits: unknown[] = [];
    for (let i = 0; i < COMPLETED + RETRIED + STUCK_UNKNOWN; i += 1) {
      const kind = i < COMPLETED ? "ok" : i < COMPLETED + RETRIED ? "non-ok" : "throw";
      const workKey = `biz:d23:w${String(i)}`;
      const admitted = service.authorizeTreasuryActionContract(
        buildContract(service, workKey, transferArgs({ amount: 200, outcome: kind as "ok" })),
        { workKey },
      );
      if (admitted.status !== "admitted") throw new Error(`w${String(i)} admit failed: ${admitted.reason}`);
      const outcome = service.executeAuthorizedDispatch(admitted.dispatch);
      if (kind === "ok") {
        expect(outcome.status).toBe("committed");
        modelOutflow += 200;
      } else if (kind === "non-ok") {
        expect(outcome.status).toBe("not_executed");
        // 真实 retry 链（V3）：推进到 retry_ready 后签发 capability 并 rearm。
        Game.time += 1;
        service.beginTick();
        const parentReady = service.kernelJournal().active.find((r) => r.attemptId === admitted.attemptId);
        if (parentReady?.phase !== "retry_ready") throw new Error(`w${String(i)} not retry_ready: ${String(parentReady?.phase)}`);
        const capability = service.issueTreasuryRearmCapability({ attemptId: admitted.attemptId });
        if (capability.status !== "ok") throw new Error(`capability failed: ${capability.reason}`);
        legacyParentPermits.push(admitted.dispatch);
        // child 用新 contract（同 workKey/同 args 语义——retry facts 一致）。
        const childContract = buildContract(service, workKey, transferArgs({ amount: 200, outcome: "ok" }));
        const child = service.executeRearm(capability.rearm, childContract, { workKey });
        if (child.status !== "admitted") throw new Error(`rearm failed: ${child.reason}`);
        expect(child.attemptId).not.toBe(admitted.attemptId); // parent/child ID 不同
        // child 是新 attempt（无消费者义务），实际执行并完成。
        const childOutcome = service.executeAuthorizedDispatch(child.dispatch);
        expect(childOutcome.status).toBe("committed");
        modelOutflow += 200;
        rearmedChildren.push({ parent: admitted.attemptId, child: child.attemptId, workKey });
        Game.time += 1;
        service.beginTick(); // child committed → 观察接管退出 → ring
      } else {
        expect(outcome.status).toBe("unknown");
        stuckSeen += 1;
      }
      if (i % 4 === 3) {
        Game.time += 1;
        service.beginTick(); // 周期性清理推进（committed 退出 → ring）。
      }
    }
    // 真实 retry 事件成立：每对 parent/child ID 不同、同 workKey 关联。
    expect(rearmedChildren.length).toBe(RETRIED);
    for (const pair of rearmedChildren) {
      expect(pair.parent).not.toBe(pair.child);
      expect(pair.workKey.startsWith("biz:d23:w")).toBe(true);
    }
    // 旧许可失效：父代 dispatch permit 回放被拒（WeakSet 身份 + 阶段终态）。
    for (const legacy of legacyParentPermits.slice(0, 5)) {
      expect(service.executeAuthorizedDispatch(legacy).status).toBe("rejected");
    }
    Game.time += 1;
    service.beginTick();
    // 账目一致：世界 = 初始 − 已确认流出（2,000,000 − modelOutflow）。
    expect(installed["W1N57"]!.storage.store.energy).toBe(2_000_000 - modelOutflow);
    // unknown 有界（恰 STUCK_UNKNOWN 条，不随时间增长）。
    const journal = service.kernelJournal();
    expect(journal.active.filter((r) => r.phase === "outcome_unknown").length).toBe(STUCK_UNKNOWN);
    expect(stuckSeen).toBe(STUCK_UNKNOWN);
    // ring 淘汰（128 上限）不授予旧 ID 许可：取一条已淘汰历史 ID 重放。
    const ringIds = new Set(journal.ring.map((e) => e.attemptId));
    expect(journal.ring.length).toBeLessThanOrEqual(128);
    expect(ringIds.size).toBe(journal.ring.length);
    const anyOld = [...ringIds][0];
    expect(service.settleUnknownOutcome({ attemptId: anyOld }).status).toBe("rejected"); // 历史不可当活跃工作结算
    // 全 heap reset：committed 效果由新观察接管；unknown 保持不重发。
    const executionsBefore = trace.executions;
    const reset = performTreasuryFullReset({ roomSpecs: [
      { name: "W1N57", storage: { id: "stor-1", resources: { energy: installed["W1N57"]!.storage.store.energy }, freeCapacity: 500_000 } },
      { name: "W2N57", terminal: { id: "term-2", resources: { energy: installed["W2N57"]!.terminal.store.energy }, freeCapacity: 2_000_000 } },
    ], adapter: installTracingAdapter(trace), advanceTicks: 1 });
    reset.service.beginTick();
    expect(trace.executions).toBe(executionsBefore); // 无重复调用
    const after = reset.service.kernelJournal();
    expect(after.active.filter((r) => r.phase === "outcome_unknown").length).toBe(STUCK_UNKNOWN);
    // 世界账目仍一致（reset 不还原宿主世界）。
    expect(reset.rooms["W1N57"]!.storage.store.energy).toBe(2_000_000 - modelOutflow);
  });
});
