/**
 * Core Rewrite IV · Remediation I——基线重现器（任务书 §9.1，持续回归形态）。
 *
 * 2026-09-05 在 aea7035 上首次运行时：断言修复后应有的行为，当时全部红灯
 * （5/5；红灯日志与当时源码快照见
 * openspec/…/core-rewrite-iv-remediation-i/baseline/）。修复落地后
 * 转为正向回归（R1–R4/V2 行为锚点）。
 */
import { createTreasuryService, TREASURY_FRESH_EPOCH_LIMIT, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
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
import { installRooms, type RoomSpec } from "@mock/treasury";

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

function makeKernelPorts(overrides: Partial<TreasuryCoreKernelPorts> = {}): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) =>
      kind === "d.kind"
        ? { kind, version: 1, registrationId: "reg-d4l", semanticIdentity: "d.adapter-l1", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : undefined,
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
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

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── R1：真实调用后、结果写回前的中断缺恢复锚点 ────────────────────────────────

describe("基线 R1 调用后结果未写的中断恢复", () => {
  it("真实 dispatch_start + 实际调用后的持久快照 → 恢复 unknown → 可信 executed 对账 → 观察接管退出", () => {
    const captured: string[] = [];
    const ports = makeKernelPorts({
      findAdapter: (kind) =>
        kind === "d.kind"
          ? {
              kind,
              version: 1,
              registrationId: "reg-d4l",
              semanticIdentity: "d.adapter-l1",
              execute: () => {
                // 真实调用路径内的断点捕获：此刻 dispatch_start 已发布、
                // 实际调用已进入、结果尚未写回。
                captured.push(snapshotWholeMemory());
                return { ok: true };
              },
              settlesOnAccept: true,
              nonOkOutcome: "unknown" as const,
            }
          : undefined,
      reconcileOutcome: () => ({ status: "ok", conclusion: "executed", source: "d.adapter-l1" }),
    });
    const kernel = createTreasuryCoreKernel(ports);
    const admitted = kernel.admit(kernelAdmitInput([], "biz:bl:r1"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    const outcome = kernel.executeDispatch(admitted.dispatch);
    expect(outcome.status).toBe("committed"); // 无中断对照：正常完成
    expect(captured.length).toBe(1);
    // 断点快照 = 调用已发生、结果未写：phase=dispatching。
    const snapRecord = JSON.parse(captured[0]).runtime.treasuryCore.active[admitted.attemptId] as { phase: string };
    expect(snapRecord.phase).toBe("dispatching");
    // 从断点快照建立恢复分支（JSON 重载，旧调用栈后续写入不进入）。
    installWholeMemorySnapshot(captured[0]);
    const kernel2 = createTreasuryCoreKernel(ports);
    Game.time += 1;
    kernel2.beginTick(); // dispatching 残留 → 保守 unknown（不重发）
    expect((activeRecord(admitted.attemptId) as { phase: string }).phase).toBe("outcome_unknown");
    // 可信对账结论 executed。
    expect(kernel2.settle({ attemptId: admitted.attemptId }).status).toBe("ok");
    expect((activeRecord(admitted.attemptId) as { phase: string; outcome: string }).outcome).toBe("committed");
    Game.time += 1;
    kernel2.beginTick(); // committed → 观察接管 → 退出（修复后）
    expect(activeRecord(admitted.attemptId)).toBeUndefined(); // ← 基线红灯：当前无锚点永不退出
  });
});

// ── R2：同记录内失败前缀永久占据尝试预算 ──────────────────────────────────────

describe("基线 R2 记录内公平", () => {
  it("8 义务前 4 永久 false、后 4 可成功：有限 tick 内后 4 应获得服务并确认移除", () => {
    const sticky = new Set(["ext:bl:f0", "ext:bl:f1", "ext:bl:f2", "ext:bl:f3"]);
    const consumers = [...sticky, "ext:bl:t4", "ext:bl:t5", "ext:bl:t6", "ext:bl:t7"];
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return !sticky.has(key);
      },
    }));
    const admitted = kernel.admit(kernelAdmitInput(consumers, "biz:bl:r2"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    expect(kernel.executeDispatch(admitted.dispatch).status).toBe("not_executed");
    for (let tick = 0; tick < 6; tick += 1) {
      Game.time += 1;
      kernel.beginTick(); // 每 tick 完整 8 份预算全给本记录（无其他流量）
    }
    const served = new Set(releaseCalls.filter((k) => !sticky.has(k)));
    expect(served.size).toBe(4); // ← 基线红灯：当前每次都从头遍历，后 4 永不被调用
    const record = activeRecord(admitted.attemptId) as { cleanup: { consumerKeys: string[] } };
    expect(record.cleanup.consumerKeys.sort()).toEqual([...sticky].sort()); // 前 4 保留
  });
});

// ── R3：rearm 静默丢弃新消费者义务 ───────────────────────────────────────────

describe("基线 R3 rearm 新义务拒绝", () => {
  it("safe retry_ready + capability：非空 externalConsumers 应被结构化拒绝", () => {
    const service = makeService();
    const a = admit(service, "biz:bl:r3", transferArgs({ amount: 100, outcome: "non-ok" }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick(); // not_executed + 空义务 → retry_ready
    const capability = service.issueTreasuryRearmCapability({ attemptId: a.attemptId });
    if (capability.status !== "ok") throw new Error("capability failed");
    const contract = buildContract(service, "biz:bl:r3", transferArgs({ amount: 100, outcome: "non-ok" }));
    const rearmed = service.executeRearm(capability.rearm, contract, {
      workKey: "biz:bl:r3",
      externalConsumers: ["ext:bl:new-duty"],
    });
    expect(rearmed.status).toBe("rejected"); // ← 基线红灯：当前静默忽略并 admitted
    expect(String(rearmed.status === "rejected" ? rearmed.reason : "")).toContain("不支持"); // 理由明确
  });
});

// ── R4：无效克隆许可先消耗 fresh 额度 ────────────────────────────────────────

describe("基线 R4 许可认证前置", () => {
  it("克隆许可提交次数 > fresh 上限：fresh/policy 零增量、动作 0；随后真许可正常执行", () => {
    const service = makeService();
    const p = admit(service, "biz:bl:r4", transferArgs({ amount: 100 }));
    const before = service.metrics();
    const clone = { ...(p.dispatch as object) }; // 公开字段相同的普通克隆
    const attempts = TREASURY_FRESH_EPOCH_LIMIT + 1;
    for (let i = 0; i < attempts; i += 1) {
      const out = service.executeAuthorizedDispatch(clone);
      expect(out.status).toBe("rejected"); // 认证阶段拒绝（不消耗 fresh）
    }
    const after = service.metrics();
    expect(after.freshObservationBuilds - before.freshObservationBuilds).toBe(0); // ← 基线红灯：当前每次耗 1
    expect(after.freshEpochLimitRejections - before.freshEpochLimitRejections).toBe(0); // ← 同上
    // 真许可：其他条件不变且额度可用 → 正常执行一次。
    const ok = service.executeAuthorizedDispatch(p.dispatch);
    expect(ok.status).toBe("committed"); // ← 基线红灯：fresh 已被克隆耗尽 → blocked
  });
});

// ── V2：完整 reset 未安装 JSON 快照（引用隔离缺失） ──────────────────────────

describe("基线 V2 reset 引用隔离", () => {
  it("performTreasuryFullReset 后全局 Memory 应为 JSON 重载的新引用", () => {
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const a = admit(service, "biz:bl:v2", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const oldMemory = Memory;
    const oldActive = Memory.runtime!.treasuryCore!.active;
    const snapshot = snapshotWholeMemory(); // D09 现状：取了快照但 reset 不安装
    void snapshot;
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryTestTransferAdapter(), advanceTicks: 1 });
    reset.service.beginTick();
    expect(Memory).not.toBe(oldMemory); // ← 基线红灯：当前沿用同一 Memory 对象
    expect(Memory.runtime!.treasuryCore!.active).not.toBe(oldActive); // ← 嵌套引用同样未脱离
  });
});
