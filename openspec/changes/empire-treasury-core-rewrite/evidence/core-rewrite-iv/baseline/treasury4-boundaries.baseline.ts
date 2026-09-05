/**
 * Core Rewrite IV——R1-R7 基线反例（基线版，b6c87c1 上运行）。
 *
 * 运行方式（干净 worktree，detached b6c87c1）：
 *   npx jest --config jest.config.cjs --runInBand --testMatch "[.]/[.]/[.]/*.baseline.ts" 的
 *   等价形式（glob 为任意目录下的 .baseline.ts，此处用字符类避免块注释终止符）
 *   --runTestsByPath scripts/baseline-red/treasury4-boundaries.baseline.ts
 *
 * 每组一个缺陷反例（红灯）+ 至少一个合法对照（绿灯）。红灯断言的是
 * 任务书 §2 的七个缺口在现状代码上的必然后果；对照证明断言目标不是
 * 永久拒绝（合法路径可达）。
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
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { createTreasuryCoreKernel, type TreasuryCoreKernelPorts, type TreasuryCoreAdmissionInput } from "@/runtime/treasury/kernel/kernel";
import { treasuryCoreSlotWorstChars } from "@/runtime/treasury/kernel/store";
import type {
  TreasuryCoreIdentityFacts,
  TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import { installRooms, type RoomSpec } from "@mock/treasury";

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

/** 原位替换 W2N57 terminal 结构 ID（资源/容量保留——incarnation 变化）。 */
function rebuildTerminal(newId: string): void {
  const rooms = (globalThis as unknown as { Game: { rooms: Record<string, Room> } }).Game.rooms;
  const room = rooms["W2N57"] as unknown as { terminal?: { id: string } };
  if (room?.terminal) room.terminal.id = newId;
}

function makeService(specs: RoomSpec[] = POOL_ROOMS): TreasuryService {
  const installed = installRooms(specs);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

/** 动态房间源（观察重建读取当前 Game.rooms——世界重装后 incarnation 变化可见）。 */
function makeDynamicService(): TreasuryService {
  installRooms(POOL_ROOMS);
  const service = createTreasuryService({
    getRooms: () => Object.values((globalThis as unknown as { Game: { rooms: Record<string, Room> } }).Game.rooms),
  });
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

// ── kernel 直调基建（R4/R5：受控释放端口场景） ───────────────────────────────

function baselineKernelIdentity(): TreasuryCoreIdentityFacts {
  return {
    actionKind: "baseline.kind",
    adapterVersion: 1,
    adapterRegistrationId: "reg-b4",
    adapterSemanticIdentity: "baseline.adapter-v1",
    canonicalDigest: "a".repeat(16),
    postingsDigest: "b".repeat(16),
    retryFactsDigest: "c".repeat(16),
    durableFacts: null,
  };
}

function baselineLegs(outflow: number): TreasuryCoreWorstCaseLeg[] {
  return [
    { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -outflow },
    { roomName: "W2N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: outflow },
  ];
}

function makeBaselineKernel(consumers: readonly string[]) {
  const kernel = createTreasuryCoreKernel({
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) =>
      kind === "baseline.kind"
        ? {
            kind,
            version: 1,
            registrationId: "reg-b4",
            semanticIdentity: "baseline.adapter-v1",
            execute: () => ({ ok: false }),
            settlesOnAccept: false,
            nonOkOutcome: "not_executed" as const,
          }
        : undefined,
    checkAdmissionCapacity: () => null,
    releaseExternalConsumer: () => true,
  } satisfies TreasuryCoreKernelPorts);
  const identity = baselineKernelIdentity();
  const input: TreasuryCoreAdmissionInput = {
    workKey: "biz:baseline:r4",
    identity,
    worstCase: baselineLegs(50),
    externalConsumers: consumers,
    canonicalArgs: { n: 1 },
    postings: baselineLegs(50),
    admissionContext: {
      contractId: "ac:baseline",
      contractDigest: "a".repeat(16),
      actionKind: "baseline.kind",
      ownerIdentity: null,
      excludeAttemptId: null,
    },
    structureBindings: [],
  };
  return { kernel, input };
}

/** 经真实 admit + executeDispatch 建立 not_executed closing 记录。 */
function establishNotExecutedClosing(consumers: readonly string[]) {
  const ctx = makeBaselineKernel(consumers);
  const admitted = ctx.kernel.admit(ctx.input);
  if (admitted.status !== "admitted") throw new Error(`kernel admit failed: ${admitted.reason}`);
  const outcome = ctx.kernel.executeDispatch(admitted.dispatch);
  if (outcome.status !== "not_executed") throw new Error(`expected not_executed, got ${outcome.status}`);
  return { kernel: ctx.kernel, attemptId: admitted.attemptId };
}

function kernelActiveRecord(kernel: ReturnType<typeof createTreasuryCoreKernel>, attemptId: string) {
  const journal = kernel.health();
  if (journal.status !== "healthy") throw new Error(`store not healthy: ${journal.status}`);
  return journal.memory.active[attemptId];
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── R1：观察责任必须进入 committed 退出条件 ─────────────────────────────────

describe("R1 committed 退出条件（观察接管）", () => {
  it("同 tick 效果未入观察时 cleanup 不得删除聚合（旧观察+已删记录=责任消失）", () => {
    const service = makeService();
    const a = admit(service, "biz:r1:a", transferArgs({ amount: 800 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 同 tick 再次 beginTick（幂等路径重跑 kernel 清理）：观察构建于效果前，
    // 未覆盖 800 的流出效果——聚合不得退出。
    service.beginTick();
    const stillActive = service.kernelJournal().active.some((r) => r.attemptId === a.attemptId);
    expect(stillActive).toBe(true);
  });

  it("删除后旧观察不得继续授权：B 以旧观察金额申请 800 必须拒绝", () => {
    const service = makeService();
    const a = admit(service, "biz:r1:b", transferArgs({ amount: 800 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    service.beginTick(); // 现状：在此删除 A，旧 shared 观察（1000）仍存活
    const b = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r1:b2", transferArgs({ amount: 800 })),
      { workKey: "biz:r1:b2" },
    );
    expect(b.status).toBe("rejected");
  });

  it("对照：下一 tick 观察含效果（世界序推进）后聚合正常退出", () => {
    const service = makeService();
    const a = admit(service, "biz:r1:c", transferArgs({ amount: 800 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    Game.time += 1;
    service.beginTick();
    const gone = !service.kernelJournal().active.some((r) => r.attemptId === a.attemptId);
    expect(gone).toBe(true);
  });
});

// ── R2：fresh 额度耗尽不得回退旧快照执行 ───────────────────────────────────

describe("R2 执行复验 fresh 回退（额度耗尽）", () => {
  it("fresh 耗尽后目标结构换 ID：真许可执行必须 blocked 且实际调用 0", () => {
    const service = makeDynamicService();
    const p = admit(service, "biz:r2:a", transferArgs({ amount: 600 }));
    // 耗尽本 tick fresh 额度（8 次）。
    for (let i = 0; i < 8; i += 1) expect(service.beginFreshObservation()).not.toBeNull();
    expect(service.beginFreshObservation()).toBeNull();
    // 目标 terminal 换 ID（结构 incarnation 变化；资源保留）。
    rebuildTerminal("term-2-rebuilt");
    const outcome = service.executeAuthorizedDispatch(p.dispatch);
    expect(outcome.status).toBe("blocked");
    const effects = readTreasuryTestAdapterSideEffectsForTestSafe();
    expect(effects.executeCalls).toBe(0);
  });

  it("对照：fresh 可用时同结构变化必须 blocked（现有语义不回归）", () => {
    const service = makeDynamicService();
    const p = admit(service, "biz:r2:b", transferArgs({ amount: 600 }));
    rebuildTerminal("term-2-rebuilt2");
    const outcome = service.executeAuthorizedDispatch(p.dispatch);
    expect(outcome.status).toBe("blocked");
  });

  it("对照：fresh 可用且结构未变时同一许可执行恰 1 次", () => {
    const service = makeDynamicService();
    const p = admit(service, "biz:r2:c", transferArgs({ amount: 600 }));
    const outcome = service.executeAuthorizedDispatch(p.dispatch);
    expect(outcome.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffectsForTestSafe().executeCalls).toBe(1);
  });
});

function readTreasuryTestAdapterSideEffectsForTestSafe(): { executeCalls: number } {
  const effects = readTreasuryTestAdapterSideEffects();
  return { executeCalls: effects.executions };
}

// ── R3：承诺完整性必须进入真实授权门禁 ──────────────────────────────────────

describe("R3 承诺完整性进授权门禁", () => {
  function installBrokenTask(): void {
    Memory.data = Memory.data ?? {};
    Memory.data.resourceControl = Memory.data.resourceControl ?? {};
    (Memory.data.resourceControl as { tasks?: Record<string, unknown> }).tasks = {
      "task-r3-bad": {
        id: "task-r3-bad",
        resource: RESOURCE_ENERGY,
        fromRoomName: "W1N57",
        toRoomName: "W2N57",
        remainingAmount: "corrupted" as unknown as number,
        status: "pending",
      },
    };
    resetTreasuryCommitmentRevisionForTest();
  }

  it("适用 scope incomplete 时 query 阻断（对照）且 authorize 也必须拒绝", () => {
    const service = makeService();
    installBrokenTask();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.commitmentStatus).not.toBe("complete");
    const admission = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r3:a", transferArgs({ amount: 800 })),
      { workKey: "biz:r3:a" },
    );
    expect(admission.status).toBe("rejected");
  });

  it("对照：任务修复（合法 remainingAmount）后同一 authorize 获准", () => {
    const service = makeService();
    Memory.data = Memory.data ?? {};
    Memory.data.resourceControl = Memory.data.resourceControl ?? {};
    (Memory.data.resourceControl as { tasks?: Record<string, unknown> }).tasks = {
      "task-r3-ok": {
        id: "task-r3-ok",
        resource: RESOURCE_ENERGY,
        fromRoomName: "W1N57",
        toRoomName: "W2N57",
        remainingAmount: 50,
        status: "pending",
      },
    };
    resetTreasuryCommitmentRevisionForTest();
    const admission = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:r3:b", transferArgs({ amount: 800 })),
      { workKey: "biz:r3:b" },
    );
    expect(admission.status).toBe("admitted");
  });
});

// ── R4：确认命令不得要求第 9 份预算（8 义务必须可完成） ─────────────────────

describe("R4 成对预算（8 义务 closing 可完成）", () => {
  it("一条 8 义务 closing、端口全 true：3 个完整预算 tick 内剩余义务必须清空", () => {
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:r4:duty-${String(i)}`);
    const { kernel, attemptId } = establishNotExecutedClosing(consumers);
    for (let tick = 0; tick < 3; tick += 1) {
      Game.time += 1;
      kernel.beginTick();
    }
    const record = kernelActiveRecord(kernel, attemptId);
    // 已退出（not_executed+义务清空 → retry_ready 后被 rearm/close 之外保留）
    // 或仍活跃但义务为空——两者都算"可完成"。现状：8 义务原样保留。
    const remaining = record === undefined ? [] : [...record.cleanup.consumerKeys];
    expect(remaining).toEqual([]);
  });

  it("对照：7 义务记录 3 tick 内完成（现状即绿——上界缺口恰在 8）", () => {
    const consumers = Array.from({ length: 7 }, (_, i) => `ext:r4:ok-${String(i)}`);
    const { kernel, attemptId } = establishNotExecutedClosing(consumers);
    for (let tick = 0; tick < 3; tick += 1) {
      Game.time += 1;
      kernel.beginTick();
    }
    const record = kernelActiveRecord(kernel, attemptId);
    if (record === undefined) throw new Error("expected retry_ready record");
    expect(record.phase).toBe("retry_ready");
  });
});

// ── R5：retry_ready 必须持久化空义务集合；child 不得继承已释放义务 ──────────

describe("R5 retry_ready 空义务集合", () => {
  it("not_executed 单义务释放完成进 retry_ready：consumerKeys 必须持久为空", () => {
    const { kernel, attemptId } = establishNotExecutedClosing(["ext:r5:duty-d"]);
    Game.time += 1;
    kernel.beginTick();
    const record = kernelActiveRecord(kernel, attemptId);
    if (record === undefined) throw new Error("record should stay in retry_ready (deadline 5000 ticks)");
    expect(record.phase).toBe("retry_ready");
    expect([...record.cleanup.consumerKeys]).toEqual([]);
  });

  it("对照：retry_ready 可签发 rearm 许可（现状即绿）", () => {
    const { kernel, attemptId } = establishNotExecutedClosing(["ext:r5:duty-e"]);
    Game.time += 1;
    kernel.beginTick();
    const issued = kernel.issueRearmPermit({ parentAttemptId: attemptId });
    expect(issued.status).toBe("ok");
  });
});

// ── R6：槽位最坏字符上界必须覆盖真实序列化 ──────────────────────────────────

describe("R6 槽位上界与实际序列化一致", () => {
  const MAXI = Number.MAX_SAFE_INTEGER;

  function worstRecord(): { attemptId: string; record: Record<string, unknown> } {
    const attemptId = `tk1_${"9".repeat(9)}_${"a".repeat(16)}`;
    return {
      attemptId,
      record: {
        workKey: `biz:${"a".repeat(92)}`,
        attemptId,
        generation: MAXI,
        parentAttemptId: `tk1_${"a".repeat(40)}`,
        phase: "closing",
        admittedAtTick: MAXI,
        updatedAtTick: MAXI,
        identity: {
          actionKind: "a".repeat(64),
          adapterVersion: MAXI,
          adapterRegistrationId: "a".repeat(96),
          adapterSemanticIdentity: "a".repeat(96),
          canonicalDigest: "a".repeat(64),
          postingsDigest: "a".repeat(64),
          retryFactsDigest: "a".repeat(64),
          durableFacts: { version: 9999, payload: "a".repeat(512) },
        },
        worstCase: Array.from({ length: 16 }, () => ({
          roomName: "a".repeat(16),
          locationKind: "storage",
          resource: "a".repeat(32),
          delta: -MAXI,
        })),
        invocation: { atTick: MAXI, worldSequence: MAXI },
        external: { accepted: true, atTick: MAXI },
        outcome: "committed",
        outcomeEvidence: {
          kind: "adapter_execution_semantics",
          conclusion: "executed",
          source: "a".repeat(64),
          atTick: MAXI,
        },
        cleanup: {
          consumerKeys: Array.from({ length: 8 }, (_, i) => `${"k".repeat(62)}${String(i)}`),
          failures: MAXI,
        },
        retryDeadlineTick: MAXI,
        lastError: "\u0000".repeat(96),
      },
    };
  }

  it("validator 接受全部字段极值记录（对照：这是合法输入）", () => {
    const { attemptId, record } = worstRecord();
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = healthyBaseWith(attemptId, record);
    const service = makeService();
    expect(service.kernelJournal().health.status).toBe("healthy");
  });

  it("槽位上界公式必须 ≥ 该记录的真实 JSON 序列化长度（含 active 键）", () => {
    const { attemptId, record } = worstRecord();
    const actual = JSON.stringify({ [attemptId]: record }).length;
    expect(treasuryCoreSlotWorstChars()).toBeGreaterThanOrEqual(actual);
  });
});

function healthyBaseWith(attemptId: string, record: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 3,
    installEpochId: "e".repeat(16),
    issuance: { frontier: 1, burned: 0 },
    lifecycle: { lastBeginTick: null, lastEndTick: null },
    recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
    active: { [attemptId]: record },
    ring: [],
    ringCursor: 0,
    counters: {
      admitted: 1, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0,
      unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0,
    },
  };
}

// ── R7：世界序跨域比较（heap 全清后不得永久扣留） ───────────────────────────

describe("R7 世界序跨域（global 清零 + Memory 保留）", () => {
  it("heap 清零后宿主世界保留效果：新观察必须完成接管（不双扣、不永久扣留）", () => {
    const service = makeService();
    const a = admit(service, "biz:r7:a", transferArgs({ amount: 300 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 模拟真实 global reset：Memory/宿主世界保留，运行时 global 槽清零。
    const holder = global as { __treasuryWorldSequence?: number };
    delete holder.__treasuryWorldSequence;
    Game.time += 1;
    const service2 = createTreasuryService({
      getRooms: () => Object.values((globalThis as unknown as { Game: { rooms: Record<string, Room> } }).Game.rooms),
    });
    // 不跑 beginTick（清理删除是 R1 的缺陷面；本例聚焦观察覆盖判定本身）。
    // 世界保留效果（storage 700）；新可信观察应接管 A 的已确认效果：
    // 700 全额可支配。
    const b = service2.authorizeTreasuryActionContract(
      buildContract(service2, "biz:r7:b", transferArgs({ amount: 700 })),
      { workKey: "biz:r7:b" },
    );
    expect(b.status).toBe("admitted");
  });

  it("对照：未发生效果时 heap 清零不影响新实例授权", () => {
    const service = makeService();
    admit(service, "biz:r7:c", transferArgs({ amount: 100 }));
    const holder = global as { __treasuryWorldSequence?: number };
    delete holder.__treasuryWorldSequence;
    Game.time += 1;
    const service2 = createTreasuryService({
      getRooms: () => Object.values((globalThis as unknown as { Game: { rooms: Record<string, Room> } }).Game.rooms),
    });
    service2.beginTick();
    const view = service2.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.observed).toBe(1000);
    expect(view.authorizationSafe).toBe(true);
  });
});
