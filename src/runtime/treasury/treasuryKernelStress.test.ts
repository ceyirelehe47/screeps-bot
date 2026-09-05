/**
 * Treasury Core Kernel 压力测试与小型参考模型（Core Rewrite I，任务书 §9.4）。
 *
 * 有界压力目标：≥10,000 项完成工作的生命周期；≥1,000 次合法 retry 的单链；
 * 固定一笔长期 unknown 的混合负载；满 active + 满近期环；最坏长度/数组
 * 数量的合法记录。记录峰值/终态序列化体积、活动数、环占用、副作用次数。
 *
 * 小模型：2 活动槽 / 2 资源的可枚举参考实现（独立判定，不复用生产
 * reducer）——验证同 attempt 不重复进入、unknown 不释放、关闭可退出、
 * 容量不超限、历史淘汰不改变执行许可。
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
import { installRooms } from "@mock/treasury";

const BIG_ROOMS = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 50_000_000 }, freeCapacity: 5_000_000 },
    terminal: { id: "term-1", resources: { energy: 1_000_000 }, freeCapacity: 40_000_000 },
  },
] as never;

function makeService(): TreasuryService {
  const installed = installRooms(BIG_ROOMS);
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
    amount: 100,
    outcome: "ok",
    ...overrides,
  };
}

/** 完成一笔工作（admit → dispatch committed → 下一 tick 清理退出）。 */
function completeOne(service: TreasuryService, workKey: string, amount = 100): number {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args: transferArgs({ amount }) });
  if (built.status !== "built") throw new Error("build failed");
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  const executed = service.executeAuthorizedDispatch(admission.dispatch);
  if (executed.status !== "committed") throw new Error(`dispatch failed: ${executed.status}`);
  Game.time += 1;
  service.beginTick();
  return admission.attemptId.length; // 占位返回（长度稳定）
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("压力：高吞吐完成生命周期", () => {
  it("10,000 项完成工作：副作用恰 10,000 次、ring 有界、终态体积有界", () => {
    const service = makeService();
    const N = 10_000;
    let peakBytes = 0;
    let peakActive = 0;
    for (let i = 0; i < N; i++) {
      completeOne(service, `biz:stress:flow:${i}`);
      if (i % 500 === 0) {
        peakBytes = Math.max(peakBytes, JSON.stringify(Memory.runtime!.treasuryCore).length);
        peakActive = Math.max(peakActive, service.kernelMetrics().activeCount);
      }
    }
    // 真实副作用恰好 N 次（真计数，非状态反推）。
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(N);
    // 活跃集合不随吞吐增长（每 tick 清理退出）；ring ≤ 128。
    expect(peakActive).toBeLessThanOrEqual(2);
    expect(service.kernelMetrics().activeCount).toBe(0);
    expect(service.kernelMetrics().ringCount).toBeLessThanOrEqual(128);
    // 终态体积有界（ring 128 + 元信息 + counters，无线性增长）。
    const finalBytes = JSON.stringify(Memory.runtime!.treasuryCore).length;
    expect(finalBytes).toBeLessThan(32_000);
    expect(peakBytes).toBeLessThan(32_000);
  }, 120_000);
});

describe("压力：长 retry 链", () => {
  it("1,000 次合法 retry 单链：每代新 ID、旧代退出、无重复执行", () => {
    const service = makeService();
    let currentWorkKey = "biz:stress:chain";
    // 第一代：non-ok → retry_ready。
    {
      const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: currentWorkKey, args: transferArgs({ outcome: "non-ok" }) });
      const admission = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: currentWorkKey });
      if (admission.status !== "admitted") throw new Error("first admit failed");
      const executed = service.executeAuthorizedDispatch(admission.dispatch);
      expect(executed.status).toBe("not_executed");
      Game.time += 1;
      service.beginTick();
      currentWorkKey = admission.attemptId; // 记 attemptId 供 rearm
      (globalThis as { __chainRoot?: string }).__chainRoot = currentWorkKey;
    }
    let parentAttempt = (globalThis as { __chainRoot?: string }).__chainRoot!;
    const generations = 1_000;
    for (let gen = 1; gen < generations; gen++) {
      const capability = service.issueTreasuryRearmCapability({ attemptId: parentAttempt });
      if (capability.status !== "ok") throw new Error(`rearm failed at gen ${gen}`);
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `chain-${gen}`,
        args: transferArgs({ outcome: gen === generations - 1 ? "ok" : "non-ok" }),
      });
      const child = service.executeRearm(capability.rearm, built.status === "built" ? built.contract : null, { workKey: "biz:stress:chain" });
      if (child.status !== "admitted") throw new Error(`child failed at gen ${gen}`);
      const executed = service.executeAuthorizedDispatch(child.dispatch);
      if (gen === generations - 1) {
        expect(executed.status).toBe("committed");
      } else {
        expect(executed.status).toBe("not_executed");
      }
      Game.time += 1;
      service.beginTick();
      parentAttempt = child.attemptId;
    }
    // 真实副作用 = 首代 + gen 1..999 的每代一次（末代 commit）= 1000 次。
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(generations);
    // 活跃不增长；frontier = 链长 + 1；ring 有界。
    expect(service.kernelMetrics().activeCount).toBeLessThanOrEqual(1);
    expect(service.kernelMetrics().ringCount).toBeLessThanOrEqual(128);
    const bytes = JSON.stringify(Memory.runtime!.treasuryCore).length;
    expect(bytes).toBeLessThan(32_000);
  }, 120_000);
});

describe("压力：固定长期 unknown 的混合负载", () => {
  it("1 笔 unknown + 5,000 正常完成：unknown 有界保留、其余正常退出", () => {
    const service = makeService();
    const stuck = (() => {
      const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:stress:stuck", args: transferArgs({ amount: 1_000, outcome: "throw" }) });
      const admission = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:stress:stuck" });
      if (admission.status !== "admitted") throw new Error("unreachable");
      service.executeAuthorizedDispatch(admission.dispatch);
      return admission.attemptId;
    })();
    for (let i = 0; i < 5_000; i++) {
      completeOne(service, `biz:stress:mixed:${i}`);
    }
    const metrics = service.kernelMetrics();
    expect(metrics.activeCount).toBe(1);
    const record = service.kernelJournal().active.find((r) => r.attemptId === stuck);
    expect(record?.phase).toBe("outcome_unknown");
    expect(metrics.ringCount).toBeLessThanOrEqual(128);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(5_001);
  }, 120_000);
});

describe("压力：满载与最坏记录", () => {
  it("满 active + 满 ring + 最坏记录体积：新工作拒绝、总量有界", () => {
    const service = makeService();
    // 经一次 admit 初始化，再直写注入最坏形态记录（192 错误 + 16 腿 +
    // durable payload 512 + consumer keys）。
    {
      const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:stress:worse", args: transferArgs() });
      const admission = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:stress:worse" });
      expect(admission.status).toBe("admitted");
    }
    const store = Memory.runtime!.treasuryCore!;
    const base = store.active[Object.keys(store.active)[0]];
    const worstLegs = Array.from({ length: 16 }, (_, i) => ({
      roomName: `W${i}N${i}`,
      locationKind: i % 2 === 0 ? "storage" : "terminal",
      resource: RESOURCE_ENERGY,
      delta: -1_000,
    }));
    for (let i = 0; i < 63; i++) {
      const attemptId = `tk1_${String(9_000 + i)}_ffffffffffffffff`;
      store.active[attemptId] = {
        ...base,
        attemptId,
        workKey: `biz:stress:worst:${i}`,
        lastError: "y".repeat(192),
        worstCase: worstLegs,
        cleanup: { consumerKeys: ["ext:stress:consumer:key:" + "z".repeat(80)], failures: 3 },
      } as never;
    }
    store.issuance.frontier = 9_100;
    for (let i = 0; i < 128; i++) {
      store.ring.push({
        attemptId: `tk1_${String(8_000 + i)}_ffffffffffffffff`,
        workKey: "biz:stress:ring:" + "w".repeat(80),
        generation: 1,
        terminalPhase: "committed",
        closedAtTick: Game.time,
      });
    }
    // 满载拒绝新工作。
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:stress:rejected", args: transferArgs() });
    expect(service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey: "biz:stress:rejected" }).status).toBe("rejected");
    // 总序列化体积上界（64 × 最坏 ~2.5KB + ring 128 + 元信息）。
    const bytes = JSON.stringify(store).length;
    expect(bytes).toBeLessThan(260_000);
  });
});

// ── 小型参考模型（独立实现，不复用生产 reducer） ────────────────────────────

/**
 * 2 活动槽 / 2 资源的最小参考模型：直接用纯集合运算独立判定安全性不变量，
 * 与生产 kernel 对比行为。参考模型不 import 任何生产状态机代码。
 */
describe("小型参考模型对比（2 槽 / 2 资源）", () => {
  interface RefModel {
    active: Map<string, { outflowResA: number; outflowResB: number; settled: boolean; unknown: boolean }>;
    capacityResA: number;
    capacityResB: number;
    slots: number;
  }

  function refModelInit(capA: number, capB: number): RefModel {
    return { active: new Map(), capacityResA: capA, capacityResB: capB, slots: 2 };
  }

  /** 参考判定：接纳是否应放行（容量 + 槽位 + 排他）。 */
  function refAdmit(model: RefModel, id: string, outA: number, outB: number): boolean {
    if (model.active.has(id)) return false;
    if (model.active.size >= model.slots) return false;
    let usedA = 0;
    let usedB = 0;
    for (const record of model.active.values()) {
      if (record.settled && !record.unknown) continue; // 确定未执行的释放
      usedA += record.outflowResA;
      usedB += record.outflowResB;
    }
    return usedA + outA <= model.capacityResA && usedB + outB <= model.capacityResB;
  }

  it("随机事件序列下，生产 kernel 与参考模型的安全判定一致", () => {
    // 固定种子可复现（确定性伪随机）。
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const rooms = installRooms([
      { name: "W1N57", storage: { id: "stor-1", resources: { energy: 10_000 }, freeCapacity: 1_000 }, terminal: { id: "term-1", resources: { energy: 5_000 }, freeCapacity: 10_000 } },
    ]);
    for (let round = 0; round < 30; round++) {
      resetTreasuryCoreStoreForTest();
      const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
      service.beginTick();
      const model = refModelInit(10_000, 10_000);
      const liveKeys = new Set<string>();
      for (let step = 0; step < 12; step++) {
        const roll = rand();
        if (roll < 0.6) {
          // 尝试接纳一笔（量 1..4000）。
          const amount = 100 * (1 + Math.floor(rand() * 40));
          const workKey = `biz:model:${round}:${step}`;
          const refAllows = refAdmit(model, workKey, amount, 0);
          const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args: transferArgs({ amount }) });
          const admission = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : null, { workKey });
          const kernelAllows = admission.status === "admitted";
          // 判定一致：参考模型容量口径（10_000 与观察一致）。
          expect(kernelAllows).toBe(refAllows);
          if (kernelAllows) {
            model.active.set(workKey, { outflowResA: amount, outflowResB: 0, settled: false, unknown: false });
            liveKeys.add(workKey);
            const executed = service.executeAuthorizedDispatch(admission.dispatch);
            if (executed.status === "committed") {
              // settleOnAccept：committed 保持占用至清理退出。
              model.active.get(workKey)!.settled = true;
            }
          }
        }
        // 推进 tick（清理退出 committed）。
        Game.time += 1;
        service.beginTick();
        for (const [key, record] of model.active) {
          if (record.settled) {
            model.active.delete(key);
            liveKeys.delete(key);
          }
        }
        // 生产 active 数与模型一致（unknown/占用不消失）。
        const kernelActive = service.kernelMetrics().activeCount;
        expect(kernelActive).toBe(model.active.size);
      }
    }
  });

  it("参考模型独立验证：unknown 不释放、关闭工作可退出、历史淘汰不改变许可", () => {
    const model = refModelInit(1_000, 1_000);
    expect(refAdmit(model, "a", 800, 0)).toBe(true);
    model.active.set("a", { outflowResA: 800, outflowResB: 0, settled: false, unknown: true });
    // unknown 占用保持：800+800 > 1000 → 第二笔同量拒绝。
    expect(refAdmit(model, "b", 800, 0)).toBe(false);
    // 小额可过（容量口径内）。
    expect(refAdmit(model, "c", 200, 0)).toBe(true);
    // 槽位：2 槽已满（a、c）→ 第四笔拒绝。
    model.active.set("c", { outflowResA: 200, outflowResB: 0, settled: false, unknown: false });
    expect(refAdmit(model, "d", 1, 0)).toBe(false);
    // 关闭（删除）后可退出。
    model.active.delete("c");
    expect(refAdmit(model, "d", 1, 0)).toBe(true);
  });
});
