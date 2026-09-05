/**
 * Core Rewrite III——R1–R8 基线红灯反例（锁定 383ffc1）。
 *
 * 文件名不含 .test.：不进入默认 Jest 收集。显式运行（避免在注释中出现
 * 块注释终止符序列）：npx jest --config jest.config.cjs --runInBand
 * --runTestsByPath scripts/baseline-red/treasury3-boundaries.baseline.ts
 *
 * 每个反例对应任务书 §2 的一个缺陷；断言按"修复后期望的行为"书写——
 * 在缺陷实现上必须失败（红灯），修复后必须通过（复验对照）。夹具与
 * 事件轨迹由测试宿主持有（adapter 计数 / Memory 状态 / 拦截器）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeFixedReserveTreasuryPolicy,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { createTreasuryCoreKernel } from "@/runtime/treasury/kernel/kernel";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";

/** 源池 1000（storage）+ 下游接收房间（terminal 大容量）。 */
const POOL_ROOMS: RoomSpec[] = [
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
    amount: 80,
    outcome: "ok",
    ...overrides,
  };
}

function makeService(specs: RoomSpec[] = POOL_ROOMS): TreasuryService {
  const installed = installRooms(specs);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

function buildContract(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`contract build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return built.contract;
}

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const admission = service.authorizeTreasuryActionContract(buildContract(service, workKey, args), { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.reason}`);
  return admission;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── R1：policy 保留额必须约束累计责任（scope 合计，不是逐腿） ───────────────

describe("R1 policy 累计（池 1000 / 保留 900）", () => {
  beforeEach(() => {
    clearTreasuryPolicyResolversForTest();
    // withhold 450 + strategicReserve 450 = reserve 合计 900。
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(450));
  });

  it("A pending 流出 80 后，B 流出 80 必须拒绝（累计 160 > 可支配 100）", () => {
    const service = makeService();
    admit(service, "biz:r1:a", transferArgs({ amount: 80 }));
    const b = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r1:b", transferArgs({ amount: 80 })),
      { workKey: "biz:r1:b" },
    );
    expect(b.status).toBe("rejected");
  });

  it("对照：B 流出 20 获准；A 安全取消后 B 流出 80 恢复获准", () => {
    const service = makeService();
    const a = admit(service, "biz:r1:a2", transferArgs({ amount: 80 }));
    const b20 = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r1:b20", transferArgs({ amount: 20 })),
      { workKey: "biz:r1:b20" },
    );
    expect(b20.status).toBe("admitted");
    expect(service.cancelPendingWork({ attemptId: a.attemptId }).status).toBe("ok");
    const b80 = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r1:b80", transferArgs({ amount: 80 })),
      { workKey: "biz:r1:b80" },
    );
    expect(b80.status).toBe("admitted");
  });

  it("A committed（效果未入观察）流出 80 后，B 流出 80 必须拒绝", () => {
    const service = makeService();
    const a = admit(service, "biz:r1:a3", transferArgs({ amount: 80 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const b = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r1:b3", transferArgs({ amount: 80 })),
      { workKey: "biz:r1:b3" },
    );
    expect(b.status).toBe("rejected");
  });
});

// ── R2：kernel 容量端口必须获得真实 contract/owner 上下文（不是匿名裁决） ────

describe("R2 own-reservation 全链一致（R03/R2）", () => {
  const OWN_ROOMS: RoomSpec[] = [
    {
      name: "W1N57",
      storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
      terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
    },
  ];

  function installOwnReservation(roomName: string, holderId: string, amount: number): void {
    (Memory.runtime as unknown as { resourceReservations?: Record<string, unknown> }).resourceReservations = {
      "res:r2:own": { roomName, resource: RESOURCE_ENERGY, holderId, amount, expiresAt: Game.time + 1000 },
    };
  }

  it("exact owner 自己的预留 300：owner 流出 950 必须获准（上层排除后 1000 ≥ 950）", () => {
    const installed = installRooms(OWN_ROOMS);
    const service = createTreasuryService({
      getRooms: () => Object.values(installed),
      holderExists: () => true,
      resolveHolder: (holderId) =>
        holderId === "svc:r2:own" ? { kind: "logical", roomName: "W1N57" } : undefined,
    });
    service.beginTick();
    installOwnReservation("W1N57", "svc:r2:own", 300);
    const admission = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r2:own", { ...transferArgs(), toRoom: "W1N57", toLocation: "terminal", amount: 950 }),
      {
        workKey: "biz:r2:own",
        owner: { scope: "production-reservation", ownerKind: "logical-service", ownerId: "svc:r2:own", roomName: "W1N57" },
      },
    );
    expect(admission.status).toBe("admitted");
  });

  it("对照：同一场景不声明 owner 时流出 950 拒绝（预留对他人有效）", () => {
    const installed = installRooms(OWN_ROOMS);
    const service = createTreasuryService({
      getRooms: () => Object.values(installed),
      holderExists: () => true,
      resolveHolder: (holderId) =>
        holderId === "svc:r2:own" ? { kind: "logical", roomName: "W1N57" } : undefined,
    });
    service.beginTick();
    installOwnReservation("W1N57", "svc:r2:own", 300);
    const admission = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r2:anon", { ...transferArgs(), toRoom: "W1N57", toLocation: "terminal", amount: 950 }),
      { workKey: "biz:r2:anon" },
    );
    expect(admission.status).toBe("rejected");
  });
});

// ── R3：执行前必须复验当前 policy / 生命周期窗口（不是只凭许可对象） ─────────

describe("R3 执行门禁复验", () => {
  it("授权后同 tick policy 收紧（reserve 0→950）：旧许可实际调用必须为 0", () => {
    const service = makeService();
    const a = admit(service, "biz:r3:a", transferArgs({ amount: 80 }));
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(475));
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(outcome.status).not.toBe("committed");
  });

  it("对照：policy 不变时同一许可调用恰 1 次", () => {
    const service = makeService();
    const a = admit(service, "biz:r3:b", transferArgs({ amount: 80 }));
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    expect(outcome.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("endTick 后同 tick 再 dispatch / 第二实例重开授权：实际调用必须为 0", () => {
    const installed = installRooms(POOL_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const a = admit(serviceA, "biz:r3:c", transferArgs({ amount: 80 }));
    serviceA.endTick();
    // 同实例：许可对象有效（同 generation），但授权窗口已关闭。
    const outcome = serviceA.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(outcome.status).not.toBe("committed");
    // 第二实例：不得重开已关闭的授权窗口（新接纳也拒绝）。
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    const reopened = serviceB.authorizeTreasuryActionContract(
      buildContract(serviceB, "biz:r3:d", transferArgs({ amount: 50 })),
      { workKey: "biz:r3:d" },
    );
    expect(reopened.status).toBe("rejected");
  });
});

// ── R4：发布确认必须比较独立预期目标（写入载荷原地污染不得冒充发布成功） ─────

describe("R4 独立发布目标", () => {
  /** 拦截 treasuryCore 写入：原地把传入载荷的 dispatching 改回 pending，返回同一引用。 */
  function installInPlacePayloadCorruption(): void {
    const runtime = Memory.runtime as Record<string, unknown>;
    let live = runtime.treasuryCore;
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get() {
        return live;
      },
      set(next: unknown) {
        if (next !== undefined && typeof next === "object" && live !== undefined) {
          const draft = next as { active?: Record<string, { phase?: string }>; lifecycle?: { lastBeginTick?: number } };
          for (const record of Object.values(draft.active ?? {})) {
            if (record.phase === "dispatching") record.phase = "pending";
          }
        }
        live = next;
      },
    });
  }

  it("写入端原地把 dispatching 改回 pending：发布必须失败、实际调用 0", () => {
    const service = makeService();
    const a = admit(service, "biz:r4:a", transferArgs({ amount: 80 }));
    installInPlacePayloadCorruption();
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(outcome.status).toBe("publish_failed");
  });
});

// ── R5：已确认未入观察的效果必须仍在授权账目中（多实例不消失） ───────────────

describe("R5 观察接管前责任保持（两实例 / 余额 1000）", () => {
  it("A 执行 800 后（同 tick，观察未含效果）：第二实例 B 申请 800 必须拒绝、200 获准", () => {
    const installed = installRooms(POOL_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    const a = admit(serviceA, "biz:r5:a", transferArgs({ amount: 800 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const b800 = serviceB.authorizeTreasuryActionContract(
      buildContract(serviceB, "biz:r5:b800", transferArgs({ amount: 800 })),
      { workKey: "biz:r5:b800" },
    );
    expect(b800.status).toBe("rejected");
    const b200 = serviceB.authorizeTreasuryActionContract(
      buildContract(serviceB, "biz:r5:b200", transferArgs({ amount: 200 })),
      { workKey: "biz:r5:b200" },
    );
    expect(b200.status).toBe("admitted");
  });

  it("对照：世界更新进入下一 tick 观察后（storage 800），B 流出 750 获准且不双扣 A", () => {
    const installed = installRooms(POOL_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const a = admit(serviceA, "biz:r5:a2", transferArgs({ amount: 200 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    Game.time += 1;
    setStoreResources(installed.W1N57.storage, { energy: 800 });
    serviceA.beginTick();
    const b750 = serviceA.authorizeTreasuryActionContract(
      buildContract(serviceA, "biz:r5:b2", transferArgs({ amount: 750 })),
      { workKey: "biz:r5:b2" },
    );
    expect(b750.status).toBe("admitted");
  });
});

// ── R6：端口调用前必须取得共享预算（重入不得各花一份） ───────────────────────

describe("R6 释放端口重入共享预算", () => {
  function makeClosing(attemptId: string, workKey: string, consumers: string[]) {
    return {
      workKey,
      attemptId,
      generation: 1,
      parentAttemptId: null,
      phase: "closing" as const,
      admittedAtTick: Game.time - 1,
      updatedAtTick: Game.time - 1,
      identity: {
        actionKind: "test.transfer",
        adapterVersion: 1,
        adapterRegistrationId: "test-reg",
        adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
        canonicalDigest: "a".repeat(16),
        postingsDigest: "b".repeat(16),
        retryFactsDigest: null,
        durableFacts: null,
      },
      worstCase: [],
      invocation: { atTick: Game.time - 1 },
      external: { accepted: true, atTick: Game.time - 1 },
      outcome: "committed" as const,
      outcomeEvidence: { kind: "adapter_execution_semantics" as const, conclusion: "executed" as const, source: "test", atTick: Game.time - 1 },
      cleanup: { consumerKeys: consumers, failures: 0 },
      retryDeadlineTick: null,
      lastError: null,
    };
  }

  it("两条 closing × 8 消费者、端口单次重入 beginTick：本 tick 实际释放调用总计 ≤ 8", () => {
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:r6:c${String(i)}`);
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = {
      version: 2,
      installEpochId: "e".repeat(16),
      issuance: { frontier: 2, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {
        "tk1_1_aaaaaaaaaaaaaaaa": makeClosing("tk1_1_aaaaaaaaaaaaaaaa", "biz:r6:a", consumers),
        "tk1_2_aaaaaaaaaaaaaaaa": makeClosing("tk1_2_aaaaaaaaaaaaaaaa", "biz:r6:b", consumers),
      },
      ring: [],
      ringCursor: 0,
      counters: {
        admitted: 2, dispatched: 2, settledCommitted: 2, settledNotExecuted: 0, unknown: 0,
        rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0,
      },
    };
    let releaseCalls = 0;
    let reentryDepth = 0;
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: () => {
        releaseCalls += 1;
        // 端口内重入同 tick beginTick（单层）：内层恢复也消费共享预算。
        if (reentryDepth === 0) {
          reentryDepth += 1;
          kernel.beginTick();
          reentryDepth -= 1;
        }
        return true;
      },
    });
    kernel.beginTick();
    expect(releaseCalls).toBeGreaterThan(0);
    expect(releaseCalls).toBeLessThanOrEqual(8);
  });
});

// ── R7：ring 损坏必须贯穿全部命令与查询（非数组不得崩溃） ────────────────────

describe("R7 ring 非数组全路径隔离", () => {
  it("ring=null：kernelJournal/kernelMetrics 首次查询零写且不崩溃", () => {
    const service = makeService();
    admit(service, "biz:r7:a", transferArgs({ amount: 80 }));
    const store = Memory.runtime?.treasuryCore as { ring: unknown };
    store.ring = null;
    expect(() => service.kernelJournal()).not.toThrow();
    expect(() => service.kernelMetrics()).not.toThrow();
    const journal = service.kernelJournal();
    expect(Array.isArray(journal.ring)).toBe(true);
    expect(journal.ring.length).toBe(0);
  });

  it("ring=null + 跨 tick pending sweep：beginTick 不崩溃且取消完成", () => {
    const service = makeService();
    admit(service, "biz:r7:b", transferArgs({ amount: 80 }));
    const store = Memory.runtime?.treasuryCore as { ring: unknown };
    store.ring = null;
    Game.time += 1;
    expect(() => service.beginTick()).not.toThrow();
    const after = service.kernelJournal();
    expect(after.active.length).toBe(0);
    expect(after.health.status).toBe("healthy");
  });
});

// ── R8：字段名检查不等于完整值校验（类型/长度/嵌套夹带必须有界拒绝） ──────────

describe("R8 有界值校验", () => {
  function healthyBase(): Record<string, unknown> {
    return {
      version: 2,
      installEpochId: "e".repeat(16),
      issuance: { frontier: 0, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {},
      ring: [],
      ringCursor: 0,
      counters: {
        admitted: 0, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0, unknown: 0,
        rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0,
      },
    };
  }

  function pendingRecord(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      workKey: "biz:r8:a",
      attemptId: "tk1_1_aaaaaaaaaaaaaaaa",
      generation: 1,
      parentAttemptId: null,
      phase: "pending",
      admittedAtTick: 100,
      updatedAtTick: 100,
      identity: {
        actionKind: "test.transfer",
        adapterVersion: 1,
        adapterRegistrationId: "reg-1",
        adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
        canonicalDigest: "a".repeat(16),
        postingsDigest: "b".repeat(16),
        retryFactsDigest: null,
        durableFacts: null,
      },
      worstCase: [
        { roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -80 },
        { roomName: "W2N57", locationKind: "terminal", resource: "energy", delta: 80 },
      ],
      invocation: null,
      external: null,
      outcome: "unknown",
      outcomeEvidence: null,
      cleanup: { consumerKeys: [], failures: 0 },
      retryDeadlineTick: null,
      lastError: null,
      ...overrides,
    };
  }

  it("超长 parentAttemptId（10,000 字符）必须判 unhealthy", () => {
    const base = healthyBase();
    base.active = { "tk1_1_aaaaaaaaaaaaaaaa": pendingRecord({ parentAttemptId: "tk1_" + "x".repeat(10_000) }) };
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = base;
    const service = makeService();
    const journal = service.kernelJournal();
    expect(journal.health.status).toBe("unhealthy");
  });

  it("durableFacts 夹带未知巨字段必须判 unhealthy", () => {
    const base = healthyBase();
    base.active = {
      "tk1_1_aaaaaaaaaaaaaaaa": pendingRecord({
        identity: {
          actionKind: "test.transfer",
          adapterVersion: 1,
          adapterRegistrationId: "reg-1",
          adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
          canonicalDigest: "a".repeat(16),
          postingsDigest: "b".repeat(16),
          retryFactsDigest: null,
          durableFacts: { version: 1, payload: "p", smuggled: "z".repeat(50_000) },
        },
      }),
    };
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = base;
    const service = makeService();
    const journal = service.kernelJournal();
    expect(journal.health.status).toBe("unhealthy");
  });

  it("invocation.atTick 字符串 / external.accepted 字符串必须判 unhealthy", () => {
    Memory.runtime = Memory.runtime ?? {};
    const base1 = healthyBase();
    base1.active = { "tk1_1_aaaaaaaaaaaaaaaa": pendingRecord({ invocation: { atTick: "one" } }) };
    (Memory.runtime as Record<string, unknown>).treasuryCore = base1;
    let service = makeService();
    expect(service.kernelJournal().health.status).toBe("unhealthy");

    const base2 = healthyBase();
    base2.active = {
      "tk1_1_aaaaaaaaaaaaaaaa": pendingRecord({ external: { accepted: "yes" as unknown as boolean, atTick: 100 } }),
    };
    (Memory.runtime as Record<string, unknown>).treasuryCore = base2;
    service = makeService();
    expect(service.kernelJournal().health.status).toBe("unhealthy");
  });
});
