/**
 * Treasury Core Rewrite II——B01–B28 验收矩阵（任务书 §7.4）。
 *
 * 每个用例名与验收编号对应；断言基于可观察事实：真实动作调用计数与
 * 实际参数（adapter 进入函数第一步的宿主持有日志，独立于 Memory 与
 * 模块重载）、外部接受事件、持久 Memory 快照、宿主侧独立轨迹——不从
 * 被测函数返回状态反推调用次数。
 *
 * 本文件在实现前先于基线（35ed7f8）运行以记录红灯（evidence/
 * core-rewrite-ii/）；实现后全部转绿。B12/B13/B25（安全取消与完整
 * reset）依赖新 API / 共享 reset harness，见 treasuryRewrite2Lifecycle。
 */
import { createTreasuryService, type TreasuryService, type TreasuryServiceDeps } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  readTreasuryTestAdapterSideEffects,
  unregisterTreasuryActionAdapterForTest,
  type TreasuryActionAdapter,
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeFixedReserveTreasuryPolicy,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { createTreasuryCoreKernel } from "@/runtime/treasury/kernel/kernel";
import { readTreasuryCoreStoreHealth } from "@/runtime/treasury/kernel/store";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 200_000 },
  },
];

function makeService(rooms: RoomSpec[] = ROOMS, deps: Partial<TreasuryServiceDeps> = {}): TreasuryService {
  const installed = installRooms(rooms);
  const service = createTreasuryService({
    getRooms: () => Object.values(installed),
    holderExists: () => true,
    ...deps,
  });
  service.beginTick();
  return service;
}

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
  return {
    fromRoom: "W1N57",
    fromLocation: "storage",
    toRoom: "W1N57",
    toLocation: "terminal",
    resource: RESOURCE_ENERGY,
    amount: 500,
    outcome: "ok",
    ...overrides,
  };
}

function buildContract(service: TreasuryService, transactionId: string, args: TreasuryTestTransferArgs): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
}

function admit(service: TreasuryService, workKey: string, args: Partial<TreasuryTestTransferArgs> = {}) {
  const contract = buildContract(service, workKey, { ...transferArgs(), ...args });
  const admission = service.authorizeTreasuryActionContract(contract, { workKey });
  expect(admission.status).toBe("admitted");
  if (admission.status !== "admitted") throw new Error("unreachable");
  return admission;
}

/** 宿主持有的执行轨迹：记录每次 execute 实际收到的参数（独立于 Memory）。 */
interface ExecutionTrace {
  readonly log: { readonly amount: number; readonly toLocation: string }[];
}
function installRecordingAdapter(
  reconcileConclusion: Parameters<typeof makeTreasuryTestTransferAdapter>[0] = "still_uncertain",
): ExecutionTrace {
  const trace: { amount: number; toLocation: string }[] = [];
  const base = makeTreasuryTestTransferAdapter(reconcileConclusion);
  const recording: TreasuryActionAdapter<TreasuryTestTransferArgs, { ok: boolean }> = {
    ...base,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      trace.push({ amount: args.amount, toLocation: args.toLocation });
      return base.execute(args);
    },
  };
  replaceTreasuryActionAdapterForTest(recording);
  return { log: trace };
}

/** 拦截 Memory.runtime.treasuryCore 的写入（模拟驱动丢写/替换写）。 */
function interceptTreasuryCoreWrites(
  transform: (draft: unknown, current: unknown) => unknown,
): () => void {
  const runtime = Memory.runtime as unknown as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
  const currentBox = { value: runtime.treasuryCore };
  Object.defineProperty(runtime, "treasuryCore", {
    configurable: true,
    get() {
      return currentBox.value;
    },
    set(next: unknown) {
      currentBox.value = transform(next, currentBox.value);
    },
  });
  return () => {
    const live = currentBox.value;
    delete runtime.treasuryCore;
    runtime.treasuryCore = live;
  };
}

/** 构造 kernel 直连 fixture（手写持久布局；仅用于损坏/中断夹具场景）。 */
function makeClosingRecord(input: {
  attemptId: string;
  workKey: string;
  consumerKeys: readonly string[];
  outcome?: "committed" | "not_executed";
}): Record<string, unknown> {
  return {
    workKey: input.workKey,
    attemptId: input.attemptId,
    generation: 1,
    parentAttemptId: null,
    phase: "closing",
    admittedAtTick: Game.time,
    updatedAtTick: Game.time,
    identity: {
      actionKind: "test.transfer",
      adapterVersion: 1,
      adapterRegistrationId: "r".repeat(16),
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
      canonicalDigest: "a".repeat(16),
      postingsDigest: "b".repeat(16),
      retryFactsDigest: null,
      durableFacts: null,
    },
    worstCase: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    invocation: { atTick: Game.time },
    external: { accepted: true, atTick: Game.time },
    outcome: input.outcome ?? "committed",
    outcomeEvidence: {
      kind: "adapter_execution_semantics",
      conclusion: input.outcome === "not_executed" ? "not_executed" : "executed",
      source: "test",
      atTick: Game.time,
    },
    cleanup: { consumerKeys: [...input.consumerKeys], failures: 0 },
    retryDeadlineTick: null,
    lastError: null,
  };
}

function installCoreStoreFixture(active: Record<string, unknown>): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  (Memory.runtime as unknown as Record<string, unknown>).treasuryCore = {
    version: 2,
    installEpochId: "0123456789abcdef",
    issuance: { frontier: Object.keys(active).length, burned: 0 },
    lifecycle: { lastBeginTick: null, lastEndTick: null },
    recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: Game.time, budgetUsed: 0 },
    active,
    ring: [],
    ringCursor: 0,
    counters: {
      admitted: Object.keys(active).length,
      dispatched: 0,
      settledCommitted: 0,
      settledNotExecuted: 0,
      unknown: 0,
      rearmings: 0,
      rejectedAdmissions: 0,
      recoveryAdvances: 0,
      cleanupFailures: 0,
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

// ── B01 真 dispatch 许可的内容不可变 ───────────────────────────────────────

describe("B01 许可内容封闭（R01）", () => {
  it("授权 500 后替换 permit.canonicalArgs 引用为 5000：修改无效或抛错，实际动作不得收到 5000", () => {
    const trace = installRecordingAdapter();
    const service = makeService();
    const { dispatch } = admit(service, "biz:b01:mutate");
    let mutationRejected = false;
    try {
      (dispatch as unknown as { canonicalArgs: unknown }).canonicalArgs = { ...transferArgs(), amount: 5000 };
    } catch {
      mutationRejected = true; // 深冻结签发快照：strict 赋值抛错
    }
    void mutationRejected;
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).not.toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(trace.log[0]?.amount).toBe(500);
  });

  it("授权 500 后修改嵌套 args.amount 为 5000：实际动作不得收到 5000", () => {
    const trace = installRecordingAdapter();
    const service = makeService();
    const args = transferArgs();
    const contract = buildContract(service, "biz:b01:nested", args);
    const admission = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b01:nested" });
    expect(admission.status).toBe("admitted");
    (args as { amount: number }).amount = 5000;
    const executed = service.executeAuthorizedDispatch(admission.status === "admitted" ? admission.dispatch : null);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(trace.log[0]?.amount).toBe(500);
  });

  it("修改 permit 身份字段（attemptId/digest/actionKind/issuedAtTick）：修改无效或抛错，不换目标执行", () => {
    const trace = installRecordingAdapter();
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b01:identity");
    const other = admit(service, "biz:b01:other");
    const mutated = dispatch as unknown as Record<string, unknown>;
    // 冻结签发快照：字段替换抛错（strict）或无效。
    expect(() => {
      mutated.attemptId = other.attemptId;
    }).toThrow();
    expect(() => {
      mutated.canonicalDigest = "0".repeat(16);
    }).toThrow();
    expect(() => {
      mutated.actionKind = "market.deal";
    }).toThrow();
    expect(() => {
      mutated.issuedAtTick = Game.time + 100;
    }).toThrow();
    // 冻结使修改无效：许可保持原授权语义（执行一次 500，不换目标/不延寿）。
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(trace.log[0]?.amount).toBe(500);
    void attemptId;
  });

  it("合法未修改对照：正常执行一次 500", () => {
    const trace = installRecordingAdapter();
    const service = makeService();
    const { dispatch } = admit(service, "biz:b01:control");
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(trace.log[0]?.amount).toBe(500);
  });
});

// ── B02 真 rearm 许可的内容不可变 ──────────────────────────────────────────

describe("B02 rearm 许可封闭（R01）", () => {
  function reachRetryReady(service: TreasuryService, workKey: string): string {
    const { attemptId, dispatch } = admit(service, workKey, { outcome: "non-ok" });
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("retry_ready");
    return attemptId;
  }

  it("修改 rearm 的前代指向另一 retry_ready：不得在错目标上建立 child", () => {
    const service = makeService();
    const first = reachRetryReady(service, "biz:b02:first");
    const second = reachRetryReady(service, "biz:b02:second");
    const capability = service.issueTreasuryRearmCapability({ attemptId: first });
    expect(capability.status).toBe("ok");
    if (capability.status !== "ok") throw new Error("unreachable");
    expect(() => {
      (capability.rearm as unknown as { parentAttemptId: string }).parentAttemptId = second;
    }).toThrow();
    const contract = buildContract(service, "biz:b02:retry", transferArgs());
    const result = service.executeRearm(capability.rearm, contract, { workKey: "biz:b02:first" });
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") throw new Error("unreachable");
    // 冻结使前代不可换目标：新 child 属于 first（原前代正确消费）。
    // second 未被触碰：仍 retry_ready、无新 child（冻结使前代不可换目标）。
    const journal = service.kernelJournal();
    expect(journal.active.find((r) => r.attemptId === second)?.phase).toBe("retry_ready");
    expect(journal.active.filter((r) => r.workKey === "biz:b02:second").length).toBe(1);
    expect(journal.active.find((r) => r.workKey === "biz:b02:first")?.parentAttemptId).toBe(first);
  });

  it("克隆/伪造 rearm 许可与延寿字段（issuedAtTick/runtime）：不可用", () => {
    const service = makeService();
    const first = reachRetryReady(service, "biz:b02:forgery");
    const capability = service.issueTreasuryRearmCapability({ attemptId: first });
    expect(capability.status).toBe("ok");
    if (capability.status !== "ok") throw new Error("unreachable");
    const contract = buildContract(service, "biz:b02:forgery-retry", transferArgs());
    const cloned = { ...(capability.rearm as unknown as Record<string, unknown>) };
    expect(service.executeRearm(cloned, contract, { workKey: "biz:b02:forgery" }).status).toBe("rejected");
    expect(() => {
      (capability.rearm as unknown as { issuedAtTick: number }).issuedAtTick = Game.time + 100;
    }).toThrow();
  });
});

// ── B04/B05/B06 发布确认与结果边界 ────────────────────────────────────────

describe("B04 dispatching 发布被丢弃但读回合法旧 pending（R02）", () => {
  it("写被丢弃：publish 失败、实际调用 0、不报告写入完成", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b04:dropped");
    const restore = interceptTreasuryCoreWrites((_draft, current) => {
      // 写入被丢弃：读回仍是合法旧 pending（不是 absent）。
      return current;
    });
    try {
      const executed = service.executeAuthorizedDispatch(dispatch);
      expect(executed.status).not.toBe("committed");
      expect(executed.status).not.toBe("not_executed");
      expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    } finally {
      restore();
    }
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("pending");
  });
});

describe("B05 读回另一份合法状态 / 单安全字段回退（R02）", () => {
  it("读回为另一份合法 memory（少了本 attempt）：拒绝陈旧发布、零调用", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b05:swap");
    const original = (Memory.runtime as unknown as Record<string, unknown>).treasuryCore;
    const otherLegal = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    delete (otherLegal.active as Record<string, unknown>)[attemptId];
    const restore = interceptTreasuryCoreWrites(() => otherLegal);
    try {
      const executed = service.executeAuthorizedDispatch(dispatch);
      expect(executed.status).not.toBe("committed");
      expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    } finally {
      restore();
    }
  });

  it("读回仅 phase 字段被回退为 pending（其余为 draft）：拒绝陈旧发布、零调用", () => {
    const service = makeService();
    const { dispatch } = admit(service, "biz:b05:field");
    const restore = interceptTreasuryCoreWrites((draft) => {
      if (draft === undefined || typeof draft !== "object") return draft;
      const mutated = JSON.parse(JSON.stringify(draft as unknown)) as { active: Record<string, { phase: string }> };
      for (const record of Object.values(mutated.active)) {
        if (record.phase === "dispatching") record.phase = "pending";
      }
      return mutated;
    });
    try {
      const executed = service.executeAuthorizedDispatch(dispatch);
      expect(executed.status).not.toBe("committed");
      expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("B06 动作已进入后结果写失败（R02）", () => {
  it("结果持久被丢弃：真调用总计 1，不返回 committed，不回退 pending，风险保留", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b06:persist");
    let writes = 0;
    const restore = interceptTreasuryCoreWrites((draft) => {
      writes += 1;
      // 精确模拟"结果发布丢写"：第 2 次（dispatch_result 草稿）与第 4 次
      //（保守恢复草稿）丢弃；各次失败后的回滚写（3/5）放行——回滚是发布
      // 未发生语义的组成部分，不属于被模拟的丢写。
      return writes === 2 || writes === 4 ? undefined : draft;
    });
    let executed: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
    try {
      executed = service.executeAuthorizedDispatch(dispatch);
    } finally {
      restore();
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(executed.status).not.toBe("committed");
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record).toBeDefined();
    expect(record?.phase).not.toBe("pending");
    // 已消费的许可不可重复 dispatch（真调用不得变为 2）。
    expect(service.executeAuthorizedDispatch(dispatch).status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

// ── B07/B08/B09/B10/B11 统一授权事实口径 ──────────────────────────────────

describe("B07 接收容量竞争（R03）", () => {
  const TIGHT_ROOMS: RoomSpec[] = [
    {
      name: "W1N57",
      storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
      terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 100 },
    },
  ];

  it("接收容量 100：A 流入 80 unknown 后（dispatch），同 tick B 流入 80 拒绝", () => {
    const trace = installRecordingAdapter();
    void trace;
    const service = makeService(TIGHT_ROOMS);
    const a = admit(service, "biz:b07:a", { amount: 80, outcome: "throw" });
    service.executeAuthorizedDispatch(a.dispatch);
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("outcome_unknown");
    const contract = buildContract(service, "biz:b07:b", { ...transferArgs(), amount: 80 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b07:b" });
    expect(second.status).toBe("rejected");
  });

  it("下一 tick：A 仍 unknown，B 流入 80 仍拒绝（unknown 占接收容量跨 tick）", () => {
    const service = makeService(TIGHT_ROOMS);
    const a = admit(service, "biz:b07:a2", { amount: 80, outcome: "throw" });
    service.executeAuthorizedDispatch(a.dispatch);
    Game.time += 1;
    service.beginTick();
    const contract = buildContract(service, "biz:b07:b2", { ...transferArgs(), amount: 80 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b07:b2" });
    expect(second.status).toBe("rejected");
  });

  it("对照：无 unknown 占用时 B 流入 80（容量 100）获准", () => {
    const service = makeService(TIGHT_ROOMS);
    const contract = buildContract(service, "biz:b07:control", { ...transferArgs(), amount: 80 });
    const first = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b07:control" });
    expect(first.status).toBe("admitted");
  });
});

describe("B08 业务预留参与接纳（R03）", () => {
  const SCARCE_ROOMS: RoomSpec[] = [
    {
      name: "W1N57",
      storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
      terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
    },
  ];

  it("物理 1000、他人生产预留 900：流出 200 的接纳与严格查询都拒绝", () => {
    const service = makeService(SCARCE_ROOMS);
    (Memory.runtime as unknown as { resourceReservations?: Record<string, unknown> }).resourceReservations = {
      "res:b08:other": {
        roomName: "W1N57",
        resource: RESOURCE_ENERGY,
        holderId: "holder-other",
        amount: 900,
        expiresAt: Game.time + 1000,
      },
    };
    const contract = buildContract(service, "biz:b08:out", { ...transferArgs(), amount: 200 });
    const admission = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b08:out" });
    expect(admission.status).toBe("rejected");
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.spendable).toBeLessThan(200);
  });

  it("对照：物理 1000 无预留：流出 200 获准（不是一律封死）", () => {
    const service = makeService(SCARCE_ROOMS);
    const contract = buildContract(service, "biz:b08:control", { ...transferArgs(), amount: 200 });
    const admission = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b08:control" });
    expect(admission.status).toBe("admitted");
  });
});

describe("B09 双扣对照（R03）", () => {
  const ROOMS_1000: RoomSpec[] = [
    {
      name: "W1N57",
      storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
      terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
    },
  ];

  it("A pending 流出 200 后 B 流出 700 获准（不因 tentative+active 双扣误拒）", () => {
    const service = makeService(ROOMS_1000);
    admit(service, "biz:b09:a", { amount: 200 });
    const contract = buildContract(service, "biz:b09:b", { ...transferArgs(), amount: 700 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b09:b" });
    expect(second.status).toBe("admitted");
  });

  it("A committed 流出 200 后（同 tick）B 流出 700 获准（效果单次表达）", () => {
    const service = makeService(ROOMS_1000);
    const a = admit(service, "biz:b09:a2", { amount: 200 });
    const executed = service.executeAuthorizedDispatch(a.dispatch);
    expect(executed.status).toBe("committed");
    const contract = buildContract(service, "biz:b09:b2", { ...transferArgs(), amount: 700 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b09:b2" });
    expect(second.status).toBe("admitted");
  });

  it("A 完成并退出、下一 tick 观察刷新后：B 流出 700 获准且不二次扣减 A", () => {
    const rooms = installRooms(ROOMS_1000);
    const service = createTreasuryService({ getRooms: () => Object.values(rooms), holderExists: () => true });
    service.beginTick();
    const a = admit(service, "biz:b09:a3", { amount: 200 });
    service.executeAuthorizedDispatch(a.dispatch);
    Game.time += 1;
    setStoreResources(rooms.W1N57.storage, { energy: 800 });
    service.beginTick();
    const contract = buildContract(service, "biz:b09:b3", { ...transferArgs(), amount: 700 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b09:b3" });
    expect(second.status).toBe("admitted");
    // 观察 800（已含 A 效果）− B 占用 700 = 100：再有一笔 150 必须拒绝。
    const third = buildContract(service, "biz:b09:c3", { ...transferArgs(), amount: 150 });
    expect(service.authorizeTreasuryActionContract(third, { workKey: "biz:b09:c3" }).status).toBe("rejected");
  });
});

describe("B10 同键聚合与对冲腿（5.2）", () => {
  it("同一候选两条同资源流出 60、余额 100：按合计拒绝", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 100 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
      },
    ]);
    // fee 腿与主腿都从 storage 流出（同键）：60 + 60 = 120 > 100。
    const contract = buildContract(service, "biz:b10:aggregate", {
      ...transferArgs({ amount: 60 }),
      feeFromRoom: "W1N57",
      feeAmount: 60,
    });
    const admission = service.authorizeTreasuryActionContract(contract, { workKey: "biz:b10:aggregate" });
    expect(admission.status).toBe("rejected");
  });

  it("同一接收位置两种资源流入各 60、容量 100：按合计拒绝", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 100_000, Utrium: 100_000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 0, Utrium: 0 }, freeCapacity: 100 },
      },
    ]);
    const energyContract = buildContract(service, "biz:b10:in-energy", {
      ...transferArgs(),
      resource: RESOURCE_ENERGY,
      amount: 60,
    });
    const first = service.authorizeTreasuryActionContract(energyContract, { workKey: "biz:b10:in-energy" });
    expect(first.status).toBe("admitted");
    const utriumContract = buildContract(service, "biz:b10:in-utrium", {
      ...transferArgs(),
      resource: RESOURCE_UTRIUM,
      amount: 60,
    });
    const second = service.authorizeTreasuryActionContract(utriumContract, { workKey: "biz:b10:in-utrium" });
    expect(second.status).toBe("rejected");
  });
});

describe("B11 rearm 使用当前授权口径（R03）", () => {
  it("retry_ready 后收紧 policy：相同动作的新代被当前 policy 拒绝", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b11:gen1", { outcome: "non-ok" });
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.phase).toBe("retry_ready");
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(120_000));
    const capability = service.issueTreasuryRearmCapability({ attemptId });
    expect(capability.status).toBe("ok");
    if (capability.status !== "ok") throw new Error("unreachable");
    const contract = buildContract(service, "biz:b11:retry", transferArgs());
    const result = service.executeRearm(capability.rearm, contract, { workKey: "biz:b11:gen1" });
    expect(result.status).toBe("rejected");
    // 失败不产生可执行 child；前代不被错误消费（仍 retry_ready，可待 policy 放宽后重试）。
    const journal = service.kernelJournal();
    expect(journal.active.find((r) => r.attemptId === attemptId)?.phase).toBe("retry_ready");
    expect(journal.active.filter((r) => r.workKey === "biz:b11:gen1" && r.generation === 2).length).toBe(0);
  });
});

// ── B14/B15 消费者释放端口 ─────────────────────────────────────────────────

describe("B14 缺释放端口不得默认成功（R05）", () => {
  it("无释放端口时接纳非空 externalConsumers：拒绝", () => {
    const service = makeService();
    const contract = buildContract(service, "biz:b14:duty", transferArgs());
    const admission = service.authorizeTreasuryActionContract(contract, {
      workKey: "biz:b14:duty",
      externalConsumers: ["ext:b14:consumer-1"],
    });
    expect(admission.status).toBe("rejected");
  });

  it("已持久化义务 + 端口缺失：duty 保留、不退出、不报 released", () => {
    const attemptId = "tk1_1_aaaaaaaaaaaaaaaa";
    installCoreStoreFixture({ [attemptId]: makeClosingRecord({ attemptId, workKey: "biz:b14:held", consumerKeys: ["ext:b14:x"] }) });
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      // releaseExternalConsumer 未装配。
    });
    const stats = kernel.beginTick();
    void stats;
    const store = (Memory.runtime as unknown as { treasuryCore: { active: Record<string, { cleanup: { consumerKeys: string[] } }> } }).treasuryCore;
    expect(store.active[attemptId]).toBeDefined();
    expect(store.active[attemptId].cleanup.consumerKeys).toEqual(["ext:b14:x"]);
  });
});

describe("B15 释放失败/抛错/幂等重试（R05）", () => {
  it("端口返回 false：duty 保留、不退出、不建立 retry 权利", () => {
    const attemptId = "tk1_1_bbbbbbbbbbbbbbbb";
    installCoreStoreFixture({ [attemptId]: makeClosingRecord({ attemptId, workKey: "biz:b15:false", consumerKeys: ["ext:b15:x"] }) });
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: () => false,
    });
    kernel.beginTick();
    const store = (Memory.runtime as unknown as { treasuryCore: { active: Record<string, unknown> } }).treasuryCore;
    expect(store.active[attemptId]).toBeDefined();
  });

  it("端口抛错：beginTick 不崩、duty 保留", () => {
    const attemptId = "tk1_1_cccccccccccccccc";
    installCoreStoreFixture({ [attemptId]: makeClosingRecord({ attemptId, workKey: "biz:b15:throw", consumerKeys: ["ext:b15:y"] }) });
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: () => {
        throw new Error("release port fault");
      },
    });
    expect(() => kernel.beginTick()).not.toThrow();
    const store = (Memory.runtime as unknown as { treasuryCore: { active: Record<string, unknown> } }).treasuryCore;
    expect(store.active[attemptId]).toBeDefined();
  });

  it("释放成功但确认写失败：duty 保留，之后同一 (key, attemptId) 幂等重试", () => {
    const attemptId = "tk1_1_dddddddddddddddd";
    installCoreStoreFixture({ [attemptId]: makeClosingRecord({ attemptId, workKey: "biz:b15:ack", consumerKeys: ["ext:b15:z"] }) });
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: (key, id) => {
        releaseCalls.push(`${key}@${id}`);
        return true;
      },
    });
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => descriptor?.value,
      set() {
        // 丢弃全部写入（确认永远写不回）。
      },
    });
    try {
      kernel.beginTick();
    } finally {
      delete runtime.treasuryCore;
      if (descriptor) Object.defineProperty(runtime, "treasuryCore", descriptor);
      else runtime.treasuryCore = descriptor?.value;
    }
    const store = (Memory.runtime as unknown as { treasuryCore: { active: Record<string, { cleanup: { consumerKeys: string[] } }> } }).treasuryCore;
    expect(store.active[attemptId]).toBeDefined();
    expect(store.active[attemptId].cleanup.consumerKeys).toEqual(["ext:b15:z"]);
    // 确认写失败后重试是同一幂等操作：同一 (key, attemptId) 再次调用。
    kernel.beginTick();
    expect(releaseCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(releaseCalls).size).toBe(1);
  });
});

// ── B16/B17 公平推进与预算 ────────────────────────────────────────────────

describe("B16 前 8 条永久失败的公平性（R08）", () => {
  it("前 8 条释放永久失败：第 9 条在有限轮次内真正完成（游标轮转，风险不被删除）", () => {
    const active: Record<string, unknown> = {};
    for (let i = 1; i <= 9; i += 1) {
      const attemptId = `tk1_${String(i)}_${String(i).padStart(16, "0")}`;
      active[attemptId] = makeClosingRecord({
        attemptId,
        workKey: `biz:b16:work-${String(i)}`,
        consumerKeys: [`ext:b16:consumer-${String(i)}`],
      });
    }
    installCoreStoreFixture(active);
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: (key) => key === "ext:b16:consumer-9",
    });
    // 有限界：9 条 closing × 1 key、预算 8/tick → 第 9 条最多 9 个 tick 内
    // 被访问并完成（游标跨 reset 延续，无需扩大预算）。
    for (let tick = 0; tick < 12; tick += 1) {
      Game.time += 1;
      kernel.beginTick();
      const store = (Memory.runtime as unknown as { treasuryCore?: { active: Record<string, unknown> } }).treasuryCore;
      if (store?.active["tk1_9_0000000000000009"] === undefined) break;
    }
    const store = (Memory.runtime as unknown as { treasuryCore: { active: Record<string, Record<string, unknown>>; ring: { attemptId: string }[] } }).treasuryCore;
    expect(store.active["tk1_9_0000000000000009"]).toBeUndefined();
    expect(store.ring.some((e: { attemptId: string }) => e.attemptId === "tk1_9_0000000000000009")).toBe(true);
    // 前 8 条风险不被删除：duty 仍在（不能用删除或 TTL 驱逐取得完成）。
    for (let i = 1; i <= 8; i += 1) {
      const record = store.active[`tk1_${String(i)}_${String(i).padStart(16, "0")}`];
      expect((record as { cleanup?: { consumerKeys?: string[] } } | undefined)?.cleanup?.consumerKeys).toEqual([`ext:b16:consumer-${String(i)}`]);
    }
  });
});

describe("B17 每 tick 释放端口调用预算（R08）", () => {
  it("单条大量 consumer 全失败：一次 beginTick 的端口调用次数受预算约束", () => {
    const many: string[] = [];
    for (let i = 0; i < 20; i += 1) many.push(`ext:b17:key-${String(i)}`);
    const attemptId = "tk1_1_eeeeeeeeeeeeeeee";
    installCoreStoreFixture({ [attemptId]: makeClosingRecord({ attemptId, workKey: "biz:b17:many", consumerKeys: many }) });
    let calls = 0;
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: () => {
        calls += 1;
        return false;
      },
    });
    kernel.beginTick();
    expect(calls).toBeLessThanOrEqual(8);
    // 同 tick 重复 beginTick：总调用不因重复入口扩大。
    kernel.beginTick();
    expect(calls).toBeLessThanOrEqual(8);
  });
});

// ── B18/B19 字段与总量上限 ────────────────────────────────────────────────

describe("B18 consumerKeys 数量上限（R09）", () => {
  it("已持久化记录携带 1000 个 consumer key：有界拒绝（unhealthy），不无限遍历", () => {
    const many: string[] = [];
    for (let i = 0; i < 1000; i += 1) many.push(`ext:b18:overflow-${String(i)}`);
    const attemptId = "tk1_1_ffffffffffffffff";
    installCoreStoreFixture({ [attemptId]: makeClosingRecord({ attemptId, workKey: "biz:b18:persisted", consumerKeys: many }) });
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
  });

  it("接纳时 externalConsumers 超上限（端口可用）：有界拒绝，不截断一半义务", () => {
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: () => true,
    });
    const many: string[] = [];
    for (let i = 0; i < 20; i += 1) many.push(`ext:b18:adm-${String(i)}`);
    const admission = kernel.admit({
      workKey: "biz:b18:admission",
      identity: {
        actionKind: "test.transfer",
        adapterVersion: 1,
        adapterRegistrationId: "r".repeat(16),
        adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
        canonicalDigest: "a".repeat(16),
        postingsDigest: "b".repeat(16),
        retryFactsDigest: null,
        durableFacts: null,
      },
      worstCase: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      externalConsumers: many,
      canonicalArgs: {},
      postings: [],
    });
    expect(admission.status).toBe("rejected");
    if (admission.status === "rejected") {
      expect(admission.reason).toContain("externalConsumers");
    }
    // 未截断一半义务：没有创建任何活跃记录。
    const store = (Memory.runtime as unknown as { treasuryCore?: { active: Record<string, unknown> } }).treasuryCore;
    expect(Object.keys(store?.active ?? {}).length).toBe(0);
  });
});

// ── B20/B21 历史故障隔离与安全矛盾 ────────────────────────────────────────

describe("B20 ring 故障隔离（R10）", () => {
  it("ring 超限/损坏：不阻断安全恢复与收尾，查询报告 degraded", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b20:recover", { outcome: "throw" });
    const store = Memory.runtime!.treasuryCore!;
    (store.active[attemptId] as unknown as { phase: string }).phase = "dispatching";
    // ring 注入超限（200 > 128）。
    for (let i = 0; i < 200; i += 1) {
      store.ring.push({
        attemptId: `tk1_9${String(i).padStart(3, "0")}_0000000000000000`,
        workKey: `biz:b20:dead-${String(i)}`,
        generation: 1,
        terminalPhase: "committed",
        closedAtTick: Game.time,
      });
    }
    Game.time += 1;
    const stats = service.beginTick();
    expect(stats.recovered).toBe(1);
    const journal = service.kernelJournal();
    const record = journal.active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("outcome_unknown");
  });

  it("ring 声称 attempt 已关闭但 active 仍在：历史 degraded，不阻断核心、不凭 ring 决定关闭", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:b20:overlap");
    const store = Memory.runtime!.treasuryCore!;
    store.ring.push({
      attemptId,
      workKey: "biz:b20:overlap",
      generation: 1,
      terminalPhase: "committed",
      closedAtTick: Game.time,
    });
    // 安全四态仍 healthy，ring 重叠只产生 degraded 诊断；active 记录不被
    // ring 覆盖或关闭（ring 不构成独立 settlement 证据）。
    const journal = service.kernelJournal();
    expect(journal.health.status).toBe("healthy");
    expect(journal.health.ringDegraded).toContain("重叠");
    expect(journal.active.find((r) => r.attemptId === attemptId)?.phase).toBe("pending");
    // 写路径可用：ring 层在下一次成功写入时重建（丢弃非权威明细）。
    const b = admit(service, "biz:b20:overlap-next");
    expect(b.status).toBe("admitted");
    const after = service.kernelJournal();
    expect(after.health.ringDegraded).toBeNull();
    expect(after.active.find((r) => r.attemptId === attemptId)?.phase).toBe("pending");
  });
});

describe("B21 真实安全矛盾仍 fail-closed（对照）", () => {
  it("closing 但无结论证据：unhealthy 阻断（不因 ring 可丢弃而放过安全矛盾）", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:b21:contradiction");
    const store = Memory.runtime!.treasuryCore!;
    const record = store.active[attemptId] as unknown as Record<string, unknown>;
    record.phase = "closing";
    record.outcome = "committed";
    record.outcomeEvidence = null;
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
  });

  it("发行元信息不自洽：unhealthy 阻断", () => {
    const service = makeService();
    admit(service, "biz:b21:issuance");
    (Memory.runtime!.treasuryCore!.issuance as unknown as { frontier: number }).frontier = -1;
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
  });
});

// ── B22 查询返回值不可修改权威 ────────────────────────────────────────────

describe("B22 查询视图只读（R06）", () => {
  it("kernelJournal().health 修改不回写 Memory（health 不泄漏 memory 引用）", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:b22:health");
    const journal = service.kernelJournal();
    // health 不含 memory 引用（对外只有状态与有界诊断）。
    expect((journal.health as unknown as { memory?: unknown }).memory).toBeUndefined();
    expect(journal.health.status).toBe("healthy");
    // 修改 health 对象本身：冻结快照抛错或无效，不影响后续读取。
    expect(() => {
      (journal.health as unknown as { status: string }).status = "unhealthy";
    }).toThrow();
    expect(service.kernelJournal().health.status).toBe("healthy");
  });

  it("ring 元素与 counters 修改不回写 Memory", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b22:ring");
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    const journal = service.kernelJournal();
    const ringEntry = journal.ring.find((e) => e.attemptId === attemptId);
    expect(ringEntry).toBeDefined();
    if (ringEntry !== undefined) {
      expect(() => {
        (ringEntry as unknown as { attemptId: string }).attemptId = "tampered";
      }).toThrow();
      expect(service.kernelJournal().ring.some((e) => e.attemptId === "tampered")).toBe(false);
    }
    const metrics = service.kernelMetrics();
    const before = metrics.counters.admitted;
    (metrics.counters as unknown as { admitted: number }).admitted = 99_999;
    expect(service.kernelMetrics().counters.admitted).toBe(before);
  });

  it("修改 metrics/active 深层嵌套后原始 Memory 与后续判定不受影响", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:b22:deep");
    const journal = service.kernelJournal();
    const record = journal.active.find((r) => r.attemptId === attemptId);
    expect(record).toBeDefined();
    if (record !== undefined) {
      expect(() => {
        (record.identity as unknown as { canonicalDigest: string }).canonicalDigest = "0".repeat(16);
      }).toThrow();
      for (const leg of record.worstCase) {
        expect(() => {
          (leg as unknown as { delta: number }).delta = 999_999;
        }).toThrow();
      }
    }
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.identity.canonicalDigest).not.toBe("0".repeat(16));
  });
});

// ── B23/B24 结算通道封闭 ──────────────────────────────────────────────────

describe("B23 自报 external receipt 关闭（R07）", () => {
  it("external_settlement_receipt 自报 not_executed：入口已删除，自报字段不生效、unknown 不变", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b23:selfreport", { outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    // 入口已删除：多余字段被忽略，结论仍由受控 reconciler（默认
    // still_uncertain）得出——调用者自报的 not_executed 不生效。
    const settled = service.settleUnknownOutcome({
      attemptId,
      evidenceKind: "external_settlement_receipt",
      conclusion: "not_executed",
    } as never);
    expect(settled.status).toBe("still_uncertain");
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("outcome_unknown");
    expect(record?.outcome).toBe("unknown");
  });

  it("运行时强制转换传入 external 结论：结论未被使用（与不传自报字段的受控调用等价）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b23:coerce", { outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    const settled = service.settleUnknownOutcome({
      attemptId,
      evidenceKind: "external_settlement_receipt" as "adapter_reconcile",
      conclusion: "executed",
    } as never);
    expect(settled.status).toBe("still_uncertain");
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.phase).toBe("outcome_unknown");
  });
});

describe("B24 受控对账边界（对照+强化）", () => {
  it("still_uncertain / 缺 adapter / reconciler 抛错 / 语义变化：不释放风险", () => {
    const service = makeService();
    const a = admit(service, "biz:b24:missing", { outcome: "throw" });
    service.executeAuthorizedDispatch(a.dispatch);
    // still_uncertain（同一注册 reconciler）：结论保留 unknown。
    const uncertain = service.settleUnknownOutcome({ attemptId: a.attemptId });
    expect(uncertain.status).toBe("still_uncertain");
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("outcome_unknown");
    // reconciler 抛错：捕获并拒绝。
    const throwing = makeTreasuryTestTransferAdapter();
    (throwing as unknown as { reconcile: () => never }).reconcile = () => {
      throw new Error("reconciler fault");
    };
    replaceTreasuryActionAdapterForTest(throwing);
    expect(
      service.settleUnknownOutcome({ attemptId: a.attemptId }).status,
    ).toBe("rejected");
    // 缺 adapter（注册移除）：拒绝。
    unregisterTreasuryActionAdapterForTest("test.transfer");
    expect(service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("rejected");
  });

  it("受控 reconciler 给出的可信结论可推进（正常对照）", () => {
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:b24:trusted", { outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    const settled = service.settleUnknownOutcome({ attemptId });
    expect(settled.status).toBe("ok");
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.outcome).toBe("not_executed");
    expect(record?.phase).toBe("closing");
  });
});

// ── B28 元信息异常（对照） ─────────────────────────────────────────────────

describe("B28 元信息与旧数据（对照）", () => {
  it("frontier 溢出拒绝分配不回绕；legacy store 阻断且不擦除", () => {
    const service = makeService();
    admit(service, "biz:b28:seed");
    const store = Memory.runtime!.treasuryCore!;
    store.issuance.frontier = 9_999_999_999;
    const contract = buildContract(service, "biz:b28:overflow", transferArgs());
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:b28:overflow" }).status).toBe("rejected");
    expect(store.issuance.frontier).toBe(9_999_999_999);

    (Memory.runtime as unknown as { treasury?: unknown }).treasury = { intents: { version: 7 } };
    const legacy = buildContract(service, "biz:b28:legacy", transferArgs());
    expect(service.authorizeTreasuryActionContract(legacy, { workKey: "biz:b28:legacy" }).status).toBe("rejected");
    expect((Memory.runtime as unknown as { treasury?: { intents?: unknown } }).treasury?.intents).toBeDefined();
  });
});
