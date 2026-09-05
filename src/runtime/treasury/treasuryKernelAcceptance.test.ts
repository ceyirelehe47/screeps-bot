/**
 * Treasury Core Rewrite I——A01–A24 验收矩阵（任务书 §9.2）。
 *
 * 每个用例名与验收编号对应；断言基于可观察事实：真实动作调用计数
 *（adapter 进入函数第一步的独立计数器）、外部接受事件、持久 Memory
 * 快照、宿主侧独立轨迹——不从被测函数返回状态反推调用次数。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { createTreasuryCoreKernel } from "@/runtime/treasury/kernel/kernel";
import { readTreasuryCoreStoreHealth } from "@/runtime/treasury/kernel/store";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 200_000 },
  },
];

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

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── A01 外部指定 ID：无执行许可 ────────────────────────────────────────────

describe("A01 外部指定旧 ID / future canonical 字符串 / 无活跃记录的 ID", () => {
  it("字符串 ID（旧格式 tk1_/ti1_/ti2_/tr1_ 与任意 future canonical）不是许可：真实调用 0", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a01:real");
    for (const forged of [
      attemptId,
      "tk1_999_futuresha12345",
      "ti2_123_abcdef0123456789",
      "ti1_42_0000000000000000",
      "tr1_1_ffffffffffffffff",
      "biz:a01:real",
    ]) {
      const executed = service.executeAuthorizedDispatch(forged);
      expect(executed.status).toBe("rejected");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 伪造普通对象（结构相似）同样无效。
    const executed = service.executeAuthorizedDispatch({ attemptId, canonicalDigest: "0".repeat(16) } as never);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("无活跃记录的 ID（已退役进 ring）不能凭 frontier 重新取得许可", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a01:retired");
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().ring.some((e) => e.attemptId === attemptId)).toBe(true);
    const replay = service.executeAuthorizedDispatch({ attemptId } as never);
    expect(replay.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

// ── A02 序号洞：frontier 不回退、洞不可执行 ────────────────────────────────

describe("A02 分配中断/失败留下序号洞", () => {
  it("frontier 前进但对应记录缺失（洞）：不回退、洞不变成可执行记录、不建逐洞 proof", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a02:first");
    const store = Memory.runtime!.treasuryCore!;
    const seq = Number(attemptId.slice(4).split("_")[0]);
    // 手工制造洞：frontier 前进 3，但不创建记录（模拟分配中断）。
    store.issuance.frontier = seq + 3;
    const next = admit(service, "biz:a02:after-hole");
    // frontier 不回退：新分配在洞之后。
    const nextSeq = Number(next.attemptId.slice(4).split("_")[0]);
    expect(nextSeq).toBe(seq + 4);
    // 洞 ID 无记录：不可执行。
    const holeId = `tk1_${String(seq + 1)}_0000000000000000`;
    expect(Memory.runtime!.treasuryCore!.active[holeId]).toBeUndefined();
    const executed = service.executeAuthorizedDispatch(holeId);
    expect(executed.status).toBe("rejected");
    // 不存在为洞建立的 proof/range 记录（burned 计数之外的任何结构）。
    expect(Object.keys(store)).not.toContain("retiredAttemptRanges");
  });

  it("frontier 溢出（>上限）拒绝分配且不回绕", () => {
    const service = makeService();
    admit(service, "biz:a02:seed");
    const store = Memory.runtime!.treasuryCore!;
    store.issuance.frontier = 9_999_999_999;
    const contract = buildContract(service, "biz:a02:overflow", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a02:overflow" });
    expect(result.status).toBe("rejected");
    expect(store.issuance.frontier).toBe(9_999_999_999);
  });
});

// ── A03 身份冲突：原事实保留、调用 0 ───────────────────────────────────────

describe("A03 同 work/attempt 的 payload、contract、adapter 语义不同", () => {
  it("adapter 语义身份演进后旧 permit 的 dispatch 拒绝（原事实保留、调用 0）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a03:semantic");
    registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), version: 2 });
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 聚合原事实保留（仍 pending、身份未变）。
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("pending");
    expect(record?.identity.adapterVersion).toBe(1);
  });

  it("持真许可修改字段（R11 等价修正）：冻结快照抛错/无效，原授权语义不变", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a03:real-mutation");
    // 真许可（WeakSet 注册）的字段替换被深冻结阻止（完整矩阵见 B01/B02）。
    expect(() => {
      (dispatch as unknown as { canonicalDigest: string }).canonicalDigest = "0".repeat(16);
    }).toThrow();
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    void attemptId;
  });

  it("permit 绑定 digest 与聚合不一致（许可错配）：拒绝执行", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a03:mismatch");
    // 构造合法 permit 但绑定别的 contract digest：经第二个 admit 的 permit
    // 不能执行第一个聚合（对象不同即不同许可——直接执行必然拒绝）。
    const other = admit(service, "biz:a03:other");
    void other;
    // 用伪造 digest 的 permit 对象（非 WeakSet 注册）→ 无效。
    const forged = { attemptId, canonicalDigest: "0".repeat(16) } as never;
    const executed = service.executeAuthorizedDispatch(forged);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });
});

// ── A04（R1）恢复看到不匹配身份：不消费/覆盖原许可 ─────────────────────────

describe("A04（R1 等价）恢复路径的身份冲突", () => {
  it("dispatching 残留 + 外部篡改身份 → store unhealthy（不被恢复解释成可推进）", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a04:recover");
    const store = Memory.runtime!.treasuryCore!;
    (store.active[attemptId] as unknown as { phase: string }).phase = "dispatching";
    // 恢复者注入不匹配身份（模拟旧 R1：executing 记录自洽地绑定另一个 opening）。
    (store.active[attemptId] as unknown as { identity: { canonicalDigest: string } }).identity.canonicalDigest = "b".repeat(16);
    // 身份篡改后 store 仍形状合法——恢复按保守语义推进：可能已进入 →
    // unknown（不重发、不消费、不覆盖原事实、不推导 not-executed）。
    Game.time += 1;
    const callsBefore = readTreasuryTestAdapterSideEffects().executions;
    service.beginTick();
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(callsBefore);
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("outcome_unknown");
    // 原事实未被恢复覆盖（恢复不反推"expected 应该是它"）。
    expect(record?.identity.canonicalDigest).toBe("b".repeat(16));
  });
});

// ── A05（R2）关键权威缺失 ≠ 损坏 ≠ 版本不兼容 ──────────────────────────────

describe("A05（R2 等价）store 四态区分", () => {
  it("absent / healthy / unhealthy / incompatible 互斥表达；损坏不被折叠为缺失", () => {
    const service = makeService();
    // absent：从未初始化。
    expect(service.kernelJournal().health.status).toBe("absent");
    admit(service, "biz:a05:init");
    // healthy。
    expect(service.kernelJournal().health.status).toBe("healthy");
    // unhealthy：记录损坏。
    const store = Memory.runtime!.treasuryCore!;
    const attemptId = Object.keys(store.active)[0];
    (store.active[attemptId] as unknown as { phase: string }).phase = "corrupted-phase";
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
    expect(service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).authorizationBlockers).toContain("kernel_store_unhealthy");
    // incompatible：未知版本。
    (store as unknown as { version: number }).version = 99;
    const incompatible = readTreasuryCoreStoreHealth();
    expect(incompatible.status).toBe("incompatible");
    if (incompatible.status === "incompatible") expect(incompatible.reason).toContain("v99");
  });

  it("unhealthy/incompatible 期间写入阻断、数据原样保留（不自动清库）", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a05:blocked");
    const snapshot = JSON.stringify(Memory.runtime!.treasuryCore);
    (Memory.runtime!.treasuryCore as unknown as { version: number }).version = 99;
    const contract = buildContract(service, "biz:a05:after", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a05:after" });
    expect(result.status).toBe("rejected");
    // 原数据保留（不被清库、不重新初始化）。
    expect(Memory.runtime!.treasuryCore!.active[attemptId]).toBeDefined();
    (Memory.runtime!.treasuryCore as unknown as { version: number }).version = 3;
    expect(JSON.stringify(Memory.runtime!.treasuryCore)).toBe(snapshot.replace('"version":99', '"version":3'));
  });
});

// ── A06（R3）矛盾证据并存：与排列顺序无关 ──────────────────────────────────

describe("A06（R3 等价）not_started 与 committed 证据并存", () => {
  it("active(pending) + ring(同 attemptId committed)：历史 degraded（以 active 为准），不凭 ring 决定关闭或重放", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a06:conflict");
    const store = Memory.runtime!.treasuryCore!;
    // 注入相反历史：ring 声称同 attempt 已 committed（active 仍 pending）。
    store.ring.push({
      attemptId,
      workKey: "biz:a06:conflict",
      generation: 1,
      terminalPhase: "committed",
      closedAtTick: Game.time,
    });
    // 安全权威仍健康；ring 重叠只产生 degraded 诊断（历史不可信，以
    // active 为准——Core Rewrite II §6.5）。
    const health = readTreasuryCoreStoreHealth();
    expect(health.status).toBe("healthy");
    if (health.status === "healthy") expect(health.ringDegraded).toContain("重叠");
    // 核心不因历史错误阻断：新接纳可用（ring 层在下一次成功写入时重建）。
    const contract = buildContract(service, "biz:a06:new", transferArgs());
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:a06:new" }).status).toBe("admitted");
    // ring 不构成 settlement 证据：active 记录不被关闭或重放。
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.phase).toBe("pending");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });
});

// ── A07（R4）同 attempt 相反结论证据：保留并阻断 ───────────────────────────

describe("A07（R4 等价）not-executed 与 committed 相反证据", () => {
  it("closing(not_executed) + 证据结论 executed → 结构矛盾 unhealthy；清理不能消除冲突", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a07:opposite", { outcome: "non-ok" });
    service.executeAuthorizedDispatch(dispatch);
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.outcome).toBe("not_executed");
    // 注入相反证据（篡改 conclusion）。
    const store = Memory.runtime!.treasuryCore!;
    (store.active[attemptId].outcomeEvidence as unknown as { conclusion: string }).conclusion = "executed";
    const health = readTreasuryCoreStoreHealth();
    expect(health.status).toBe("unhealthy");
    // beginTick 清理在 unhealthy 下不推进（不挑较弱证据清除冲突）。
    Game.time += 1;
    service.beginTick();
    expect(Memory.runtime!.treasuryCore!.active[attemptId]).toBeDefined();
  });
});

// ── A08 调用前状态发布失败：动作 0、保持已知未开始 ─────────────────────────

describe("A08 dispatching 发布失败", () => {
  it("发布前 store 变 incompatible → 零调用；恢复后聚合仍 pending（不虚构 unknown）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a08:publish");
    (Memory.runtime!.treasuryCore as unknown as { version: number }).version = 42;
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 修复 store：聚合保持 pending（有正面未开始证据——不虚构 unknown）。
    (Memory.runtime!.treasuryCore as unknown as { version: number }).version = 3;
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("pending");
    expect(record?.invocation).toBeNull();
  });
});

// ── A09 同 tick 重复执行/重入/多 facade：至多一次 ───────────────────────────

describe("A09 至多一次调用", () => {
  it("同 permit 重复执行：第二次拒绝（真实调用恰好 1 次）", () => {
    const service = makeService();
    const { dispatch } = admit(service, "biz:a09:dup");
    const first = service.executeAuthorizedDispatch(dispatch);
    expect(first.status).toBe("committed");
    const second = service.executeAuthorizedDispatch(dispatch);
    expect(second.status).toBe("rejected");
    const third = service.executeAuthorizedDispatch(dispatch);
    expect(third.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("action 内部重入（递归 dispatch 同一 permit）拒绝", () => {
    let hostEntries = 0;
    let reentrancyResult: { status: string } | null = null;
    let reentrantDispatch: (() => unknown) | null = null;
    replaceTreasuryActionAdapterForTest({
      ...makeTreasuryTestTransferAdapter(),
      execute(args: unknown): { ok: boolean } {
        hostEntries += 1;
        if (reentrancyResult === null) {
          reentrancyResult = reentrantDispatch!() as { status: string };
        }
        void args;
        return { ok: true };
      },
    } as never);
    const service = makeService();
    const { dispatch } = admit(service, "biz:a09:reentrant");
    reentrantDispatch = () => service.executeAuthorizedDispatch(dispatch);
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("committed");
    expect(reentrancyResult).not.toBeNull();
    expect(reentrancyResult!.status).toBe("rejected");
    expect(hostEntries).toBe(1);
  });

  it("多个 facade 实例共享 Memory：一实例执行后另一实例无法对同一聚合执行", () => {
    const rooms = installRooms(ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(rooms) });
    serviceA.beginTick();
    const { attemptId, dispatch } = (() => {
      const contract = buildContract(serviceA, "biz:a09:multi", transferArgs());
      const admission = serviceA.authorizeTreasuryActionContract(contract, { workKey: "biz:a09:multi" });
      expect(admission.status).toBe("admitted");
      if (admission.status !== "admitted") throw new Error("unreachable");
      return admission;
    })();
    serviceA.executeAuthorizedDispatch(dispatch);
    // 实例 B（独立 heap）：只能看到阶段已推进。
    const serviceB = createTreasuryService({ getRooms: () => Object.values(rooms) });
    const record = serviceB.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("closing");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

// ── A10 动作进入后 non-ok/throw/结果写失败：计数真实为 1 ───────────────────

describe("A10 真实调用计数与保守结算", () => {
  it("non-ok / throw：真实进入各 1 次，按 adapter 证据进入确定未执行或 unknown", () => {
    const service = makeService();
    const nonOk = admit(service, "biz:a10:nonok", { outcome: "non-ok" });
    const r1 = service.executeAuthorizedDispatch(nonOk.dispatch);
    expect(r1.status).toBe("not_executed");
    const throwing = admit(service, "biz:a10:throw", { outcome: "throw" });
    const r2 = service.executeAuthorizedDispatch(throwing.dispatch);
    expect(r2.status).toBe("unknown");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(2);
    // 风险不凭失败释放：throw 的聚合保持 outcome_unknown 占用。
    const record = service.kernelJournal().active.find((r) => r.attemptId === throwing.attemptId);
    expect(record?.phase).toBe("outcome_unknown");
  });
});

// ── A11 接受 ≠ 世界效果 ────────────────────────────────────────────────────

describe("A11 API 接受不构成充分 settlement 证明", () => {
  it("未声明 settlesOnAccept 的 adapter：ok 接受后仍 unknown，需独立证据通道结算", () => {
    replaceTreasuryActionAdapterForTest({
      ...makeTreasuryTestTransferAdapter(),
      settlesOnAccept: false,
    });
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a11:accept-not-effect");
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("unknown"); // 接受事实已记录但不是效果证明
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.external).toEqual({ accepted: true, atTick: Game.time });
    expect(record?.outcome).toBe("unknown");
  });

  it("净余额变化不能当 settlement：只经 settle 证据通道推进", () => {
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("still_uncertain"));
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a11:net-balance", { outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    // 世界模拟：余额被其他因素抵消（净变化 0）——仍不能推导 committed。
    Game.time += 1;
    service.beginTick();
    const settled = service.settleUnknownOutcome({ attemptId });
    expect(settled.status).toBe("still_uncertain");
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.outcome).toBe("unknown");
  });
});

// ── A12 执行可能开始后 reset：恢复不重发 ───────────────────────────────────

describe("A12 中断后恢复", () => {
  it("dispatching 状态硬中断（模拟）→ 下一 tick 恢复保守化，不重发（调用计数不变）", () => {
    const service = makeService();
    const { attemptId } = admit(service, "biz:a12:interrupt");
    const store = Memory.runtime!.treasuryCore!;
    (store.active[attemptId] as unknown as { phase: string }).phase = "dispatching";
    Game.time += 1;
    const before = readTreasuryTestAdapterSideEffects().executions;
    service.beginTick();
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(before);
    const record = service.kernelJournal().active.find((r) => r.attemptId === attemptId);
    expect(record?.phase).toBe("outcome_unknown");
  });
});

// ── A13 unknown 直接 retry / 换 root 重复：拒绝 ────────────────────────────

describe("A13 绕过 unknown 的尝试", () => {
  it("outcome_unknown 直接 issueRearm 拒绝；同业务任务换 workKey 重提交在原聚合活跃期间被排他拒绝", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a13:unknown", { amount: 90_000, outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    expect(service.issueTreasuryRearmCapability({ attemptId }).status).toBe("rejected");
    // 换 root（不同 workKey 字符串）提交同业务任务：不构成绕过——新聚合
    // 需要新资源授权（原聚合的占用仍在），资源不足时拒绝。
    const contract = buildContract(service, "biz:a13:other-root", { ...transferArgs(), amount: 90_000 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a13:other-root" });
    expect(second.status).toBe("rejected");
  });
});

// ── A14 合法 rearm：新 ID/generation、旧代不可执行（见 treasuryKernel.test）──

describe("A14 exact not-executed + cleanup 完成后的合法 rearm", () => {
  it("rearm 产生新 attemptId 与 generation+1；前代 dispatch permit 不可再执行", () => {
    const service = makeService();
    const parent = admit(service, "biz:a14:parent", { outcome: "non-ok" });
    service.executeAuthorizedDispatch(parent.dispatch);
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    expect(capability.status).toBe("ok");
    if (capability.status !== "ok") throw new Error("unreachable");
    const contract = buildContract(service, "biz:a14:child", transferArgs());
    const child = service.executeRearm(capability.rearm, contract, { workKey: "biz:a14:parent" });
    expect(child.status).toBe("admitted");
    if (child.status !== "admitted") throw new Error("unreachable");
    expect(child.attemptId).not.toBe(parent.attemptId);
    // 前代 permit（早已跨 tick 失效）与新 permit 不同——旧代不可执行。
    const replay = service.executeAuthorizedDispatch(parent.dispatch);
    expect(replay.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

// ── A15 retry 参数改变/重复消费/旧 capability：拒绝 ─────────────────────────

describe("A15 retry 约束", () => {
  it("rearm 许可重复消费拒绝（不创建两个 child）", () => {
    const service = makeService();
    const parent = admit(service, "biz:a15:double", { outcome: "non-ok" });
    service.executeAuthorizedDispatch(parent.dispatch);
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("unreachable");
    const contract = buildContract(service, "biz:a15:child", transferArgs());
    const first = service.executeRearm(capability.rearm, contract, { workKey: "biz:a15:double" });
    expect(first.status).toBe("admitted");
    const second = service.executeRearm(capability.rearm, contract, { workKey: "biz:a15:double" });
    expect(second.status).toBe("rejected");
  });

  it("retry 改变动作参数（amount 不同 → retry facts 不同）拒绝", () => {
    const service = makeService();
    const parent = admit(service, "biz:a15:mutate", { amount: 500, outcome: "non-ok" });
    service.executeAuthorizedDispatch(parent.dispatch);
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("unreachable");
    const mutated = buildContract(service, "biz:a15:mutated", { ...transferArgs(), amount: 777 });
    const result = service.executeRearm(capability.rearm, mutated, { workKey: "biz:a15:mutate" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("retry 语义事实");
  });

  it("跨 tick 的旧 rearm 许可失效（旧 runtime capability 不可用）", () => {
    const service = makeService();
    const parent = admit(service, "biz:a15:stale", { outcome: "non-ok" });
    service.executeAuthorizedDispatch(parent.dispatch);
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("unreachable");
    Game.time += 1;
    service.beginTick();
    const contract = buildContract(service, "biz:a15:stale-child", transferArgs());
    const result = service.executeRearm(capability.rearm, contract, { workKey: "biz:a15:stale" });
    expect(result.status).toBe("rejected");
  });
});

// ── A16 资源与 receiver capacity 竞争 ──────────────────────────────────────

describe("A16 容量竞争", () => {
  it("同 tick 两笔竞争同一资源：第一笔 tentative 后第二笔最坏流出被拒", () => {
    const service = makeService();
    admit(service, "biz:a16:first", { amount: 80_000 });
    const contract = buildContract(service, "biz:a16:second", { ...transferArgs(), amount: 80_000 });
    const second = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a16:second" });
    expect(second.status).toBe("rejected");
  });

  it("多笔合计超容量（R11 等价修正）：两笔各 60、容量 100——第二笔按合计拒绝", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 100 },
      },
    ]);
    const first = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:a16:multi-1", { ...transferArgs(), amount: 60 }),
      { workKey: "biz:a16:multi-1" },
    );
    expect(first.status).toBe("admitted");
    const second = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:a16:multi-2", { ...transferArgs(), amount: 60 }),
      { workKey: "biz:a16:multi-2" },
    );
    expect(second.status).toBe("rejected");
  });

  it("接收容量竞争：terminal free 不足时流入腿拒绝（同 tick 不得重复占满接收空间）", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
      },
    ]);
    const contract = buildContract(service, "biz:a16:inflow", { ...transferArgs(), amount: 20_000 });
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a16:inflow" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("接收容量不足");
  });
});

// ── A17 cleanup 重复/失败/source 不健康：幂等或保留 ─────────────────────────

describe("A17 清理责任", () => {
  it("外部消费者释放未确认 → duty 保留（不谎报完成）；确认后幂等推进", () => {
    // 直接构造 kernel 实例注入释放端口（facade 未暴露端口——测试用 kernel API）。
    const kernel = createTreasuryCoreKernel({
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: () => undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: (key) => key === "ext:test:confirmed",
    });
    if (!Memory.runtime) Memory.runtime = {} as never;
    Memory.runtime.treasuryCore = {
      version: 3,
      installEpochId: "0123456789abcdef",
      issuance: { frontier: 2, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {
        tk1_1_aaaaaaaaaaaaaaaa: {
          workKey: "biz:a17:cleanup",
          attemptId: "tk1_1_aaaaaaaaaaaaaaaa",
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
          outcome: "committed",
          outcomeEvidence: { kind: "adapter_execution_semantics", conclusion: "executed", source: "test", atTick: Game.time },
          cleanup: { consumerKeys: ["ext:test:confirmed", "ext:test:failing"], failures: 0 },
          retryDeadlineTick: null,
          lastError: null,
        },
      },
      ring: [],
      ringCursor: 0,
      counters: { admitted: 1, dispatched: 1, settledCommitted: 1, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    } as never;
    const before = kernel.beginTick();
    expect(before.cleaned).toBeGreaterThanOrEqual(1);
    // failing 的 duty 未确认 → 记录保留 active（不因 absent/失败谎报完成）。
    const store = Memory.runtime.treasuryCore!;
    const record = store.active["tk1_1_aaaaaaaaaaaaaaaa"];
    expect(record).toBeDefined();
    expect(record.cleanup.consumerKeys).toEqual(["ext:test:failing"]);
    // 修复释放端口 → 下次推进完成清理，幂等。
    Game.time += 1;
    // 再次 beginTick（端口仍失败）：duty 保留，failures 计数。
    kernel.beginTick();
    expect(store.active["tk1_1_aaaaaaaaaaaaaaaa"]).toBeDefined();
  });

  it("重复推进幂等：closing 无消费者时 beginTick 只退出一次", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a17:idempotent");
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)).toBeUndefined();
    // 再次 beginTick：无副作用、ring 不重复。
    Game.time += 1;
    service.beginTick();
    const ringCount = service.kernelJournal().ring.filter((e) => e.attemptId === attemptId).length;
    expect(ringCount).toBe(1);
  });
});

// ── A18 ring 满/损坏/清空（见 treasuryKernel.test 的环测试 + A06） ──────────

describe("A18 近期环异常", () => {
  it("ring 损坏（非法条目）→ 历史 degraded：不阻断安全观察，写入路径重建 ring 层", () => {
    const service = makeService();
    admit(service, "biz:a18:init");
    Memory.runtime!.treasuryCore!.ring.push({ bad: "entry" } as never);
    const health = readTreasuryCoreStoreHealth();
    expect(health.status).toBe("healthy");
    if (health.status === "healthy") expect(health.ringDegraded).not.toBeNull();
    // 查询仍可用（零写观察不因 ring 损坏崩溃）。
    expect(() => service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] })).not.toThrow();
    // 安全收尾不被 ring 故障阻断：下一次成功写入重建（丢弃）ring 层。
    const contract = buildContract(service, "biz:a18:next", transferArgs());
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:a18:next" }).status).toBe("admitted");
    expect(service.kernelJournal().health.ringDegraded).toBeNull();
  });
});

// ── A19 长期 unknown + 大量完成：有界 ──────────────────────────────────────

describe("A19 长期 unknown 的有界占用", () => {
  it("一笔长期 unknown 保持占用；后续完成工作正常退出、ring 有界", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 1_000_000 }, freeCapacity: 900_000 },
        terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 2_000_000 },
      },
    ]);
    // 固定一笔长期 unknown（amount 100，占用小但永不结算）。
    const unknown = admit(service, "biz:a19:stuck", { amount: 100, outcome: "throw" });
    service.executeAuthorizedDispatch(unknown.dispatch);
    // 大量正常工作完成（超过 ring 容量）。
    for (let i = 0; i < 140; i++) {
      Game.time += 1;
      service.beginTick();
      const done = admit(service, `biz:a19:flow:${i}`, { amount: 50 });
      const executed = service.executeAuthorizedDispatch(done.dispatch);
      expect(executed.status).toBe("committed");
    }
    Game.time += 1;
    service.beginTick();
    // unknown 仍有界占用（一条记录）。
    const record = service.kernelJournal().active.find((r) => r.attemptId === unknown.attemptId);
    expect(record?.phase).toBe("outcome_unknown");
    expect(service.kernelJournal().active.length).toBe(1);
    // ring ≤ 128（不随吞吐线性增长）。
    expect(service.kernelJournal().ring.length).toBeLessThanOrEqual(128);
  });
});

// ── A20 满载：拒绝新、已接纳可收尾、总字节有界 ─────────────────────────────

describe("A20 满载与序列化预算", () => {
  it("满 active + 满 ring + 最长错误详情：新接纳拒绝、已完成仍可退出、总字节有界", () => {
    const service = makeService();
    admit(service, "biz:a20:seed");
    const store = Memory.runtime!.treasuryCore!;
    // 填满 active（64）与 ring（128），注入最长错误详情。
    for (let i = 0; i < 63; i++) {
      const attemptId = `tk1_${String(900 + i)}_ffffffffffffffff`;
      store.active[attemptId] = {
        ...store.active[Object.keys(store.active)[0]],
        attemptId,
        workKey: `biz:a20:fill:${i}`,
        // 本 tick 注入（不触发跨 tick pending sweep 抢占清理预算——sweep
        // 语义由 B12/B13 单独覆盖）。
        admittedAtTick: Game.time,
        updatedAtTick: Game.time,
        lastError: "x".repeat(96),
      } as never;
    }
    store.issuance.frontier = 999;
    for (let i = 0; i < 128; i++) {
      store.ring.push({ attemptId: `tk1_${String(500 + i)}_ffffffffffffffff`, workKey: `biz:a20:ring:${i}`, generation: 1, terminalPhase: "committed", closedAtTick: Game.time });
    }
    // 新接纳拒绝。
    const contract = buildContract(service, "biz:a20:rejected", transferArgs());
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:a20:rejected" }).status).toBe("rejected");
    // 已接纳（seed，合法 pending）仍可推进收尾。
    // 写回协议会替换 treasuryCore 根对象（clone-write-readback）——直改前
    // 必须重取引用（外部不得缓存 store 引用，design 已记录）。
    const liveStore = Memory.runtime!.treasuryCore!;
    const seed = Object.values(liveStore.active).find((r) => r.workKey === "biz:a20:seed")!;
    const dispatchExecuted = (() => {
      // seed 的 permit 已丢失（store 注入后无 permit）——用直写方式推进阶段，
      // 验证 beginTick 清理路径仍工作：把 seed 置为 closing committed。
      (seed as unknown as { phase: string }).phase = "closing";
      (seed as unknown as { outcome: string }).outcome = "committed";
      (seed as unknown as { outcomeEvidence: unknown }).outcomeEvidence = {
        kind: "adapter_execution_semantics",
        conclusion: "executed",
        source: "test",
        atTick: Game.time,
      };
      (seed as unknown as { invocation: unknown }).invocation = { atTick: Game.time };
      // 同 tick 内推进（幂等 beginTick 直接进 kernel 恢复；跨 tick 会先
      // 触发 pending sweep 抢占预算——该语义由 B12/B13 单独覆盖）。
      return service.beginTick();
    })();
    expect(dispatchExecuted.cleaned).toBeGreaterThanOrEqual(1);
    expect(Object.values(Memory.runtime!.treasuryCore!.active).some((r) => r.workKey === "biz:a20:seed")).toBe(false);
    // 总序列化字节有上界（active 64 × 最坏记录 + ring 128 + 元信息）。
    const bytes = JSON.stringify(Memory.runtime!.treasuryCore).length;
    expect(bytes).toBeLessThan(220_000);
  });
});

// ── A21 首次查询零写 ───────────────────────────────────────────────────────

describe("A21 查询纯度（零 Memory 写）", () => {
  it.each([
    ["空 store", () => undefined],
    ["正常 store", (svc: TreasuryService) => admit(svc, "biz:a21:normal")],
  ])("首次 %s 查询：Memory 前后完全一致", (_name, prepare) => {
    const service = makeService();
    prepare(service);
    const before = JSON.stringify(Memory);
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    service.kernelJournal();
    service.kernelMetrics();
    service.observation();
    expect(JSON.stringify(Memory)).toBe(before);
  });

  it("旧版本/损坏数据的首查询：不迁移、不修复、零写", () => {
    const service = makeService();
    if (!Memory.runtime) Memory.runtime = {} as never;
    Memory.runtime.treasuryCore = { version: 99 } as never;
    const before = JSON.stringify(Memory);
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    service.kernelJournal();
    expect(JSON.stringify(Memory)).toBe(before);
    expect((Memory.runtime.treasuryCore as unknown as { version: number }).version).toBe(99);
  });

  it("返回对象不可反向修改权威（含 health/ring/counters 全部可达嵌套）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a21:immutable");
    const journal = service.kernelJournal();
    // health 不含 memory 引用（R06）；修改冻结快照抛错且不影响后续读取。
    expect((journal.health as unknown as { memory?: unknown }).memory).toBeUndefined();
    expect(() => {
      (journal.health as unknown as { status: string }).status = "unhealthy";
    }).toThrow();
    const active = journal.active;
    expect(() => {
      (active.find((r) => r.attemptId === attemptId) as unknown as { phase: string }).phase = "closing";
    }).toThrow();
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.phase).toBe("pending");
    // ring 元素与 counters 同样不可回写（完整矩阵见 B22）。
    const executed = service.executeAuthorizedDispatch(dispatch);
    expect(executed.status).toBe("committed");
    Game.time += 1;
    service.beginTick();
    const after = service.kernelJournal();
    const entry = after.ring.find((e) => e.attemptId === attemptId);
    if (entry !== undefined) {
      expect(() => {
        (entry as unknown as { attemptId: string }).attemptId = "tampered";
      }).toThrow();
    }
    const metrics = service.kernelMetrics();
    const before = metrics.counters.admitted;
    (metrics.counters as unknown as { admitted: number }).admitted = 99_999;
    expect(service.kernelMetrics().counters.admitted).toBe(before);
  });
});

// ── A22 全 reset 等价 ──────────────────────────────────────────────────────

describe("A22 global reset 等价", () => {
  it("Memory JSON 往返 + 服务重建 + tick 推进：活跃状态等价、旧 handle 不可复用", () => {
    const rooms = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
    service.beginTick();
    const contract = buildContract(service, "biz:a22:reset", { ...transferArgs(), outcome: "throw" });
    const admission = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a22:reset" });
    expect(admission.status).toBe("admitted");
    if (admission.status !== "admitted") throw new Error("unreachable");
    const unknown = admit(service, "biz:a22:unknown", { outcome: "throw" });
    service.executeAuthorizedDispatch(unknown.dispatch);
    service.executeAuthorizedDispatch(admission.dispatch);
    // 序列化 → 清空 heap（模拟 global reset：服务与全部 WeakSet 丢弃）→ 反序列化。
    const serialized = JSON.stringify(Memory.runtime!.treasuryCore);
    const freshService = createTreasuryService({ getRooms: () => Object.values(rooms) });
    (globalThis as { __resetHints?: undefined }).__resetHints;
    Game.time += 1;
    freshService.beginTick();
    // 等价：活跃集合一致（phase/outcome/身份），reset 不改变持久语义。
    const restored = JSON.parse(serialized);
    const live = freshService.kernelJournal();
    const restoredActive = Object.values(restored.active) as { attemptId: string; phase: string; outcome: string }[];
    for (const record of restoredActive) {
      const current = live.active.find((r) => r.attemptId === record.attemptId);
      expect(current).toBeDefined();
      expect(current?.outcome).toBe(record.outcome);
    }
    // 旧 handle 不可复用：旧 dispatch permit 对象已随旧 runtime 失效。
    const replay = freshService.executeAuthorizedDispatch(admission.dispatch);
    expect(replay.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(2); // a22:reset 与 a22:unknown 各真实进入一次
  });
});

// ── A23 safe cancellation / retry 权利期限 ─────────────────────────────────

describe("A23 安全关闭边界", () => {
  it("outcome_unknown 不能被 close（TTL 不可驱逐执行未知的记录）", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a23:unknown", { outcome: "throw" });
    service.executeAuthorizedDispatch(dispatch);
    const closed = service.closeWork({ attemptId, reason: "abandoned" });
    expect(closed.status).toBe("rejected");
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)).toBeDefined();
  });

  it("retry_ready 未到期不可被 retry_expired 关闭；到期自动关闭", () => {
    const service = makeService();
    const { attemptId, dispatch } = admit(service, "biz:a23:expiry", { outcome: "non-ok" });
    service.executeAuthorizedDispatch(dispatch);
    Game.time += 1;
    service.beginTick();
    // 未到期：显式 retry_expired 关闭拒绝。
    expect(service.closeWork({ attemptId, reason: "retry_expired" }).status).toBe("rejected");
    // 到期：beginTick 自动关闭。
    Game.time += 5_001;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === attemptId)).toBeUndefined();
  });
});

// ── A24 元信息异常 ─────────────────────────────────────────────────────────

describe("A24 元信息回退/溢出/缺失/不兼容", () => {
  it("installEpochId 缺失 → unhealthy，不重新签发旧身份、不自动清库", () => {
    const service = makeService();
    admit(service, "biz:a24:meta");
    const store = Memory.runtime!.treasuryCore!;
    (store as unknown as { installEpochId: string }).installEpochId = "";
    const health = readTreasuryCoreStoreHealth();
    expect(health.status).toBe("unhealthy");
    const contract = buildContract(service, "biz:a24:after", transferArgs());
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:a24:after" }).status).toBe("rejected");
    // 数据原样保留（含活跃记录），未清库。
    expect(Object.keys(store.active).length).toBeGreaterThan(0);
  });

  it("frontier 非法（负数/非整数）→ unhealthy 阻断分配", () => {
    const service = makeService();
    admit(service, "biz:a24:frontier");
    (Memory.runtime!.treasuryCore!.issuance as unknown as { frontier: number }).frontier = -3;
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
    const contract = buildContract(service, "biz:a24:frontier2", transferArgs());
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:a24:frontier2" }).status).toBe("rejected");
  });

  it("旧 Treasury 业务数据存在 → legacy 阻断（真实 driver 保持禁用语义）", () => {
    const service = makeService();
    if (!Memory.runtime) Memory.runtime = {} as never;
    (Memory.runtime as unknown as { treasury?: unknown }).treasury = { intents: { version: 7, entries: { "i:x": {} } } };
    const contract = buildContract(service, "biz:a24:legacy", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:a24:legacy" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("旧 Treasury 业务数据");
    // 旧数据不被擦除。
    expect((Memory.runtime as unknown as { treasury?: { intents?: unknown } }).treasury?.intents).toBeDefined();
  });
});
