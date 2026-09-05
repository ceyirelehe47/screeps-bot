/**
 * Treasury Core Kernel 生命周期测试（Core Rewrite I）。
 *
 * 覆盖：真计数计量器自证（design §9.1——先证明测试计量器有效，再用它
 * 验证内核）；admit→dispatch→settle→cleanup→rearm→close 全阶段；身份/
 * 排他/容量；tick 边界恢复保守化；retry 权利期限；近期环。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionAdapter,
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  makeNoReserveTreasuryPolicy,
  clearTreasuryPolicyResolversForTest,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import { appendTreasuryCoreRingEntry } from "@/runtime/treasury/kernel/store";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 30_000 },
  },
];

/**
 * 宿主侧独立副作用轨迹：不随被测 Memory 回滚（记录在测试闭包，永不写入
 * Memory）。真实调用事件 / 外部接受 / 持久快照分开保存。
 */
interface HostTrace {
  readonly invocations: number;
  readonly acceptedCount: number;
}
const hostTraces: HostTrace[] = [];

function recordHostTrace(invocations: number, acceptedCount: number): void {
  hostTraces.push({ invocations, acceptedCount });
}

function makeService(rooms: RoomSpec[] = ROOMS): TreasuryService {
  const installed = installRooms(rooms);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
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

/** 构建 contract 并接纳（返回 dispatch permit；断言 admitted）。 */
function admitTransfer(
  service: TreasuryService,
  workKey: string,
  args: TreasuryTestTransferArgs,
): { attemptId: string; dispatch: unknown; contract: TreasuryActionContract } {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  expect(admission.status).toBe("admitted");
  if (admission.status !== "admitted") throw new Error("unreachable");
  return { attemptId: admission.attemptId, dispatch: admission.dispatch, contract: built.contract };
}

function activeRecord(service: TreasuryService, attemptId: string): TreasuryCoreWorkRecord | undefined {
  return service.kernelJournal().active.find((r) => r.attemptId === attemptId);
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  hostTraces.length = 0;
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── §9.1 计量器自证：先证明测试计量器有效 ───────────────────────────────────

describe("真调用计量器自证（先于内核断言）", () => {
  it("正常返回 ok / non-ok / throw 各记录恰好一次进入", () => {
    const service = makeService();
    for (const outcome of ["ok", "non-ok", "throw"] as const) {
      resetTreasuryTestAdapterSideEffectsForTest();
      const { dispatch } = admitTransfer(service, `biz:probe:${outcome}`, { ...transferArgs(), outcome });
      const executed = service.executeAuthorizedDispatch(dispatch);
      expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
      recordHostTrace(1, executed.status === "committed" ? 1 : 0);
    }
    // 宿主轨迹独立保存：三组各一次进入。
    expect(hostTraces.map((t) => t.invocations)).toEqual([1, 1, 1]);
  });

  it("故意直接调用两次能记录两次（计量器不封顶）", () => {
    const adapter = makeTreasuryTestTransferAdapter();
    const args = transferArgs();
    adapter.execute(args);
    adapter.execute(args);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(2);
  });

  it("前置拒绝是零次（permit 无效/阶段不符时计量器不动）", () => {
    const service = makeService();
    const { attemptId } = admitTransfer(service, "biz:probe:zero", transferArgs());
    expect(attemptId).toBeTruthy();
    // 用字符串 ID 直接执行（无 permit 对象）→ 拒绝、零调用。
    const executed = service.executeAuthorizedDispatch(attemptId);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });
});

// ── 基础生命周期 ────────────────────────────────────────────────────────────

describe("admit → dispatch 基础流", () => {
  it("admit 创建 pending 聚合并签发 opaque permit；attemptId 为 tk1_ 前缀", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:basic:admit", transferArgs());
    expect(attemptId).toMatch(/^tk1_\d{1,10}_[0-9a-f]{16}$/);
    expect(typeof dispatch).toBe("object");
    const record = activeRecord(service, attemptId);
    expect(record?.phase).toBe("pending");
    expect(record?.generation).toBe(1);
    expect(record?.invocation).toBeNull();
  });

  it("dispatch ok（settleOnAccept）→ closing committed → beginTick 清理后真正退出 + ring 记录", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:basic:commit", transferArgs());
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    const record = activeRecord(service, attemptId);
    expect(record?.phase).toBe("closing");
    expect(record?.outcome).toBe("committed");
    expect(record?.invocation).not.toBeNull();
    expect(record?.external).toEqual({ accepted: true, atTick: Game.time });
    // 三种事实分离：invocation / external / outcome 独立可观察。
    expect(record?.outcomeEvidence?.kind).toBe("adapter_execution_semantics");
    expect(record?.outcomeEvidence?.conclusion).toBe("executed");
    // beginTick 清理（closing 无外部消费者）→ 移出活跃集合，写 ring。
    Game.time += 1;
    service.beginTick();
    expect(activeRecord(service, attemptId)).toBeUndefined();
    const ring = service.kernelJournal().ring;
    expect(ring.some((entry) => entry.attemptId === attemptId && entry.terminalPhase === "committed")).toBe(true);
  });

  it("dispatch non-ok（not_executed 语义）→ closing → retry_ready（有 retry facts）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:basic:nonok", { ...transferArgs(), outcome: "non-ok" });
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("not_executed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(activeRecord(service, attemptId)?.phase).toBe("closing");
    expect(activeRecord(service, attemptId)?.external).toEqual({ accepted: false, atTick: Game.time });
    Game.time += 1;
    service.beginTick();
    const record = activeRecord(service, attemptId);
    expect(record?.phase).toBe("retry_ready");
    expect(record?.retryDeadlineTick).toBeGreaterThan(Game.time);
  });

  it("dispatch throw → outcome_unknown（保守），外部接受事实缺失", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:basic:throw", { ...transferArgs(), outcome: "throw" });
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("unknown");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    const record = activeRecord(service, attemptId);
    expect(record?.phase).toBe("outcome_unknown");
    expect(record?.invocation).not.toBeNull();
    expect(record?.external).toBeNull();
  });

  it("保守默认 adapter：ok 不声明 settlesOnAccept → unknown（接受不构成无条件完成证明）", () => {
    replaceTreasuryActionAdapterForTest({
      ...makeTreasuryTestTransferAdapter(),
      settlesOnAccept: undefined,
      nonOkOutcome: undefined,
    } as TreasuryActionAdapter);
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:basic:conservative", transferArgs());
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("unknown");
    expect(activeRecord(service, attemptId)?.phase).toBe("outcome_unknown");
  });

  it("frontier 单调推进；多次 admit 的 attemptId 序号严格递增", () => {
    const service = makeService();
    const first = admitTransfer(service, "biz:seq:1", transferArgs());
    const second = admitTransfer(service, "biz:seq:2", transferArgs());
    const seqOf = (id: string) => Number(id.slice("tk1_".length).split("_")[0]);
    expect(seqOf(second.attemptId)).toBeGreaterThan(seqOf(first.attemptId));
    expect(service.kernelMetrics().frontier).toBe(seqOf(second.attemptId));
  });
});

// ── 排他与容量 ──────────────────────────────────────────────────────────────

describe("接纳排他与容量", () => {
  it("同 workKey 排他：活跃期间重复接纳拒绝（不存在第二个可执行 attempt）", () => {
    const service = makeService();
    admitTransfer(service, "biz:dup:1", transferArgs());
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "dup2", args: transferArgs() });
    const second = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:dup:1" });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reasonCode).toBe("work_key_conflict");
  });

  it("前代关闭后同 workKey 可重新接纳", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:reopen:1", transferArgs());
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick(); // committed 退出
    expect(activeRecord(service, attemptId)).toBeUndefined();
    const again = admitTransfer(service, "biz:reopen:1", transferArgs());
    expect(again.attemptId).not.toBe(attemptId);
  });

  it("容量不足拒绝（最坏流出超出物理存量）", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "too-big",
      args: { ...transferArgs(), amount: 500_000 },
    });
    const result = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:cap:1" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      // policy 层（insufficient_amount）与 kernel 容量层（capacity_insufficient）
      // 都表达物理不可覆盖——两者皆合法拒绝码。
      expect(["capacity_insufficient", "insufficient_amount"]).toContain(result.reasonCode);
    }
  });

  it("满载拒绝新工作，已接纳工作仍可推进（安全收尾不被阻断）", () => {
    const service = makeService();
    // 先经一次合法 admit 完成 store 显式初始化（查询零写），再直写注入至满载。
    admitTransfer(service, "biz:full:seed", { ...transferArgs(), amount: 1 });
    if (!Memory.runtime) Memory.runtime = {} as never;
    const store = Memory.runtime.treasuryCore!;
    delete store.active[Object.keys(store.active)[0]];
    for (let i = 0; i < 64; i++) {
      const attemptId = `tk1_${String(i + 1).padStart(3, "0")}_ffffffffffffffff`;
      store.active[attemptId] = {
        workKey: `biz:full:${i}`,
        attemptId,
        generation: 1,
        parentAttemptId: null,
        phase: "pending",
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
        worstCase: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
        invocation: null,
        external: null,
        outcome: "unknown",
        outcomeEvidence: null,
        cleanup: { consumerKeys: [], failures: 0 },
        retryDeadlineTick: null,
        lastError: null,
      } as TreasuryCoreWorkRecord;
      store.issuance.frontier = i + 1;
    }
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "full-reject", args: transferArgs() });
    const result = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:full:new" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reasonCode).toBe("active_full");
  });
});

// ── 结算（unknown → 确定） ──────────────────────────────────────────────────

describe("settle（对账结算）", () => {
  it("reconcile 结论 executed → committed closing；not_executed → not-executed closing", () => {
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_committed"));
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:settle:exec", { ...transferArgs(), outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    const settled = service.settleUnknownOutcome({ attemptId });
    expect(settled.status).toBe("ok");
    expect(activeRecord(service, attemptId)?.outcome).toBe("committed");
  });

  it("still_uncertain 保持 unknown（不得推导）", () => {
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("still_uncertain"));
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:settle:uncertain", { ...transferArgs(), outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    const settled = service.settleUnknownOutcome({ attemptId });
    expect(settled.status).toBe("still_uncertain");
    expect(activeRecord(service, attemptId)?.phase).toBe("outcome_unknown");
  });

  it("reconciler 语义身份不一致（adapter 被替换）→ 拒绝 settle", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:settle:mismatch", { ...transferArgs(), outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    replaceTreasuryActionAdapterForTest({
      ...makeTreasuryTestTransferAdapter("observed_committed"),
      semanticIdentity: "test.transfer@different-semantics",
    });
    const settled = service.settleUnknownOutcome({ attemptId });
    expect(settled.status).toBe("rejected");
    expect(activeRecord(service, attemptId)?.phase).toBe("outcome_unknown");
  });
});

// ── tick 边界恢复 ───────────────────────────────────────────────────────────

describe("tick 边界恢复（保守推进，不重发）", () => {
  it("dispatching 残留 → beginTick 保守化为 outcome_unknown（动作计数不增）", () => {
    const service = makeService();
    const { attemptId } = admitTransfer(service, "biz:recover:dispatching", transferArgs());
    // 直接构造 dispatching（模拟硬中断：发布后、结果写入前进程终止）。
    const record = activeRecord(service, attemptId);
    if (!Memory.runtime) Memory.runtime = {} as never;
    (Memory.runtime.treasuryCore!.active[attemptId] as { phase: string }).phase = "dispatching";
    void record;
    Game.time += 1;
    const before = readTreasuryTestAdapterSideEffects().executions;
    service.beginTick();
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(before);
    expect(activeRecord(service, attemptId)?.phase).toBe("outcome_unknown");
  });

  it("未知不能被年龄推导成 not-executed：outcome_unknown 长期保留", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:recover:aging", { ...transferArgs(), outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    for (let i = 0; i < 20; i++) {
      Game.time += 100;
      service.beginTick();
      service.endTick();
    }
    const record = activeRecord(service, attemptId);
    expect(record?.phase).toBe("outcome_unknown");
    expect(record?.outcome).toBe("unknown");
  });

  it("permit 跨 tick 失效（同 permit 对象下一 tick 不可执行）", () => {
    const service = makeService();
    const { dispatch } = admitTransfer(service, "biz:recover:stale-permit", transferArgs());
    Game.time += 1;
    service.beginTick();
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("unknown 全额占用保持：资源不被后续接纳重复授权", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 200_000 },
      },
    ]);
    const { dispatch } = admitTransfer(service, "biz:recover:occupancy", { ...transferArgs(), amount: 90_000, outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch); // → unknown（抛错不释放占用）
    // 下一 tick：unknown 仍占用，第二笔 90_000 应被容量拒绝。
    Game.time += 1;
    service.beginTick();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "occ-2",
      args: { ...transferArgs(), amount: 90_000 },
    });
    const second = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:recover:occupancy-2" });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reasonCode).toBe("capacity_insufficient");
  });
});

// ── retry（rearm） ──────────────────────────────────────────────────────────

describe("retry（受控 rearm）", () => {
  function driveToRetryReady(service: TreasuryService, workKey: string, amount = 500): { attemptId: string } {
    const { attemptId, dispatch } = admitTransfer(service, workKey, { ...transferArgs(), amount, outcome: "non-ok" });
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    expect(activeRecord(service, attemptId)?.phase).toBe("retry_ready");
    return { attemptId };
  }

  it("合法 rearm：新 attemptId、generation+1、旧 attempt 退出并进 ring", () => {
    const service = makeService();
    const { attemptId } = driveToRetryReady(service, "biz:retry:legal");
    const capability = service.issueTreasuryRearmCapability({ attemptId });
    expect(capability.status).toBe("ok");
    if (capability.status !== "ok") throw new Error("unreachable");
    // rearm 许可与 dispatch 许可同语义：签发 tick 内有效。
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "retry-child", args: transferArgs() });
    const child = service.executeRearm(capability.rearm, built.status === "built" ? built.contract : null, { workKey: "biz:retry:legal" });
    expect(child.status).toBe("admitted");
    if (child.status !== "admitted") throw new Error("unreachable");
    expect(child.attemptId).not.toBe(attemptId);
    const record = activeRecord(service, child.attemptId);
    expect(record?.generation).toBe(2);
    expect(record?.parentAttemptId).toBe(attemptId);
    expect(activeRecord(service, attemptId)).toBeUndefined();
    expect(service.kernelJournal().ring.some((e) => e.attemptId === attemptId && e.terminalPhase === "not_executed")).toBe(true);
  });

  it("rearm 许可重复消费拒绝（不会创建两个 child）", () => {
    const service = makeService();
    const { attemptId } = driveToRetryReady(service, "biz:retry:double");
    const capability = service.issueTreasuryRearmCapability({ attemptId });
    if (capability.status !== "ok") throw new Error("unreachable");
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "retry-dbl", args: transferArgs() });
    const first = service.executeRearm(capability.rearm, built.status === "built" ? built.contract : null, { workKey: "biz:retry:double" });
    expect(first.status).toBe("admitted");
    const second = service.executeRearm(capability.rearm, built.status === "built" ? built.contract : null, { workKey: "biz:retry:double" });
    expect(second.status).toBe("rejected");
  });

  it("rearm 改变动作参数（不同 canonical）拒绝——同 workKey 已被 child 占据", () => {
    const service = makeService();
    const { attemptId } = driveToRetryReady(service, "biz:retry:mutate");
    const capability = service.issueTreasuryRearmCapability({ attemptId });
    if (capability.status !== "ok") throw new Error("unreachable");
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "retry-mut",
      args: { ...transferArgs(), amount: 999 },
    });
    const result = service.executeRearm(capability.rearm, built.status === "built" ? built.contract : null, { workKey: "biz:retry:mutate" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("retry 语义事实与前代不一致");
  });

  it("retry 权利期限到期：beginTick 自动 close（过期的是权利，不是风险）", () => {
    const service = makeService();
    const { attemptId } = driveToRetryReady(service, "biz:retry:expiry");
    Game.time += 5_001;
    service.beginTick();
    expect(activeRecord(service, attemptId)).toBeUndefined();
    expect(service.kernelJournal().ring.some((e) => e.attemptId === attemptId && e.terminalPhase === "retry_expired")).toBe(true);
    const late = service.issueTreasuryRearmCapability({ attemptId });
    expect(late.status).toBe("rejected");
  });

  it("outcome_unknown 不可直接 rearm（须先结算）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:retry:unknown", { ...transferArgs(), outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    const capability = service.issueTreasuryRearmCapability({ attemptId });
    expect(capability.status).toBe("rejected");
  });

  it("显式放弃（abandoned）关闭已知安全的 retry_ready", () => {
    const service = makeService();
    const { attemptId } = driveToRetryReady(service, "biz:retry:abandon");
    const closed = service.closeWork({ attemptId, reason: "abandoned" });
    expect(closed.status).toBe("ok");
    expect(activeRecord(service, attemptId)).toBeUndefined();
    expect(service.kernelJournal().ring.some((e) => e.attemptId === attemptId && e.terminalPhase === "abandoned")).toBe(true);
  });
});

// ── 近期明细环 ──────────────────────────────────────────────────────────────

describe("近期明细环（不参与授权）", () => {
  it("退役 attemptId 不可再取得执行许可（ring 不授权）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admitTransfer(service, "biz:ring:noauth", transferArgs());
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().ring.some((e) => e.attemptId === attemptId)).toBe(true);
    // ring 中的 ID 不能重新执行（伪造 permit 对象）。
    const executed = service.executeAuthorizedDispatch({ attemptId } as never);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1); // 仅原始一次
  });

  it("环容量有界：满 128 后覆盖最旧（不随历史增长）", () => {
    const service = makeService();
    admitTransfer(service, "biz:ring:seed", { ...transferArgs(), amount: 1 });
    const store = Memory.runtime!.treasuryCore!;
    store.ring.length = 0;
    store.ringCursor = 0;
    // 经内核 append 辅助注入 140 条——满 128 后覆盖最旧，长度恒有界。
    for (let i = 0; i < 140; i++) {
      appendTreasuryCoreRingEntry(store, {
        attemptId: `tk1_${String(i + 1).padStart(3, "0")}_ffffffffffffffff`,
        workKey: `biz:ring:${i}`,
        generation: 1,
        terminalPhase: "committed",
        closedAtTick: Game.time,
      });
      expect(store.ring.length).toBeLessThanOrEqual(128);
    }
    expect(store.ring.length).toBe(128);
    // 覆盖后最旧条目已不在（首 12 条被覆盖），最新仍在。
    expect(store.ring.some((e) => e.workKey === "biz:ring:0")).toBe(false);
    expect(store.ring.some((e) => e.workKey === "biz:ring:139")).toBe(true);
  });
});
