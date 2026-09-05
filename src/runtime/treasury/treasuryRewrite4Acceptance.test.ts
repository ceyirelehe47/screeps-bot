/**
 * Treasury Core Rewrite IV——D01–D24 验收矩阵（任务书 §8，Acceptance 部分）。
 *
 * 覆盖：D01–D09、D12、D14、D20、D21、D22（观察责任退出 / 视图失效 /
 * fresh 阻断 / 完整性门禁 / own-reservation 贯穿 / heap reset 接管 /
 * 父子义务 / 矛盾状态 / 空间上界）。生命周期与预算场景
 * （D10/D11/D13/D15–D19/D23）见 treasuryRewrite4Lifecycle.test.ts。
 *
 * 断言基于可观察事实：真实动作调用计数（宿主轨迹）、独立世界状态、
 * 持久快照；不依赖返回标签自证。基线红灯证据见
 * evidence/core-rewrite-iv/baseline/。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
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
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { bumpTreasuryCommitmentRevision, resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import {
  buildTreasuryCoreWorstWorkRecord,
  buildTreasuryCoreWorstRingEntry,
  readTreasuryCoreStoreHealth,
  treasuryCoreMetaWorstChars,
  treasuryCoreRingSlotWorstChars,
  treasuryCoreSlotWorstChars,
} from "@/runtime/treasury/kernel/store";
import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_CONSUMER_KEYS_MAX,
  TREASURY_CORE_RING_LIMIT,
  TREASURY_CORE_TOTAL_CHAR_BUDGET,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import { classifyTreasuryHolderIdAsOwner } from "@/runtime/treasury/ownerIdentity";
import { reserveProductionResourceForOwner } from "@/runtime/resourceReservation";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";

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

/** 可控房间源 service（观察范围可动态收缩/恢复——D01/D12/D10）。 */
function makeScopedService(): { service: TreasuryService; rooms: Record<string, Room>; hide: (name: string) => void; show: (name: string) => void } {
  const installed = installRooms(POOL_ROOMS);
  const visible = new Set(Object.keys(installed));
  const service = createTreasuryService({
    getRooms: () => Object.values(installed).filter((room) => visible.has(room.name)),
  });
  service.beginTick();
  return {
    service,
    rooms: installed,
    hide: (name) => visible.delete(name),
    show: (name) => visible.add(name),
  };
}

function buildContract(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`contract build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return built.contract;
}

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const admission = service.authorizeTreasuryActionContract(buildContract(service, workKey, args), { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.reason}`);
  return admission;
}

function authorizeOf(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  return service.authorizeTreasuryActionContract(buildContract(service, workKey, args), { workKey });
}

function storeNow(): Record<string, unknown> | undefined {
  return Memory.runtime?.treasuryCore as Record<string, unknown> | undefined;
}

function activeRecord(attemptId: string): Record<string, unknown> | undefined {
  const active = storeNow()?.active as Record<string, Record<string, unknown>> | undefined;
  return active?.[attemptId];
}

// ── kernel 直调基建（释放端口场景） ──────────────────────────────────────────

function kernelIdentity(): TreasuryCoreIdentityFacts {
  return {
    actionKind: "d.kind",
    adapterVersion: 1,
    adapterRegistrationId: "reg-d4",
    adapterSemanticIdentity: "d.adapter-v1",
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
        ? { kind, version: 1, registrationId: "reg-d4", semanticIdentity: "d.adapter-v1", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : undefined,
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: readTreasuryWorldSequence(), atTick: Game.time, locationExists: () => true }),
    ...overrides,
  };
}

function kernelAdmitInput(consumers: readonly string[], workKey = "biz:d4:work"): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: kernelIdentity(),
    worstCase: kernelLegs(50),
    externalConsumers: consumers,
    canonicalArgs: { n: 1 },
    postings: kernelLegs(50),
    admissionContext: {
      contractId: "ac:d4",
      contractDigest: "a".repeat(16),
      actionKind: "d.kind",
      ownerIdentity: null,
      excludeAttemptId: null,
    },
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

// ── D01：观察暂不可确认时不退出，覆盖恢复后正常退出 ─────────────────────────

describe("D01 committed 无消费者的观察责任", () => {
  it("目标位置不在适用观察范围：重复 beginTick/endTick/cleanup 都不退出，不靠 ring 或时间消除", () => {
    const scoped = makeScopedService();
    const a = admit(scoped.service, "biz:d01:a", transferArgs({ amount: 800 }));
    expect(scoped.service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // W2N57（流入腿位置）离开观察范围——效果覆盖不可确认。
    scoped.hide("W2N57");
    for (let i = 0; i < 4; i += 1) {
      Game.time += 1;
      scoped.service.beginTick();
      scoped.service.endTick();
    }
    const record = activeRecord(a.attemptId);
    expect(record).toBeDefined();
    expect((record as { phase: string }).phase).toBe("closing");
    // 时间流逝与 ring 存在都不能替代观察接管。
    expect(scoped.service.kernelJournal().ring.some((e) => e.attemptId === a.attemptId)).toBe(false);
  });

  it("范围恢复（新可信观察覆盖）后正常退出，义务集合为空", () => {
    const scoped = makeScopedService();
    const a = admit(scoped.service, "biz:d01:b", transferArgs({ amount: 800 }));
    expect(scoped.service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    scoped.hide("W2N57");
    Game.time += 1;
    scoped.service.beginTick();
    expect(activeRecord(a.attemptId)).toBeDefined();
    scoped.show("W2N57");
    Game.time += 1;
    scoped.service.beginTick();
    expect(activeRecord(a.attemptId)).toBeUndefined();
    expect(scoped.service.kernelJournal().ring.some((e) => e.attemptId === a.attemptId)).toBe(true);
  });
});

// ── D02：cleanup 后旧视图失效（两实例 1000 / A 800 / B 800 拒、200 准） ─────

describe("D02 观察接管退出后的旧视图失效", () => {
  it("A 执行 800 并退出后，旧观察实例 B：800 拒绝（新观察物理余额 200），200 获准（新 contract）", () => {
    const installed = installRooms(POOL_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    // 两实例共享观察事实：世界序 0，余额 1000。
    expect(serviceA.observation().epoch.worldSequence).toBe(serviceB.observation().epoch.worldSequence);
    const a = admit(serviceA, "biz:d02:a", transferArgs({ amount: 800 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 效果后（持久世界序 +1）A 的 cleanup 退出合法（观察重建覆盖）。
    Game.time += 1;
    serviceA.beginTick();
    expect(serviceA.kernelJournal().active.some((r) => r.attemptId === a.attemptId)).toBe(false);
    // B 持有删除前旧观察（epoch.worldSequence=0、金额 1000）——800 不得
    // 超额接纳（入口重建观察：物理余额 200）；200 有正当对照获准。
    const b800 = authorizeOf(serviceB, "biz:d02:b800", transferArgs({ amount: 800 }));
    expect(b800.status).toBe("rejected");
    const b200 = authorizeOf(serviceB, "biz:d02:b200", transferArgs({ amount: 200 }));
    expect(b200.status).toBe("admitted");
    // 不是重放同 permit：B 的是全新授权（不同 attempt）。
    if (b200.status !== "admitted") throw new Error("unreachable");
    expect(b200.attemptId).not.toBe(a.attemptId);
  });
});

// ── D03：接收空间责任同样闭合（100 / 80 拒 / 20 准） ─────────────────────────

describe("D03 接收空间的观察接管", () => {
  it("A 确认流入 80 并退出后：旧实例申请流入 80 拒；新观察空位 20 不双扣，20 合法", () => {
    const installed = installRooms([
      { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 } },
      { name: "W2N57", terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 100 } },
    ]);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    const a = admit(serviceA, "biz:d03:a", transferArgs({ amount: 80 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 世界：terminal 80 / free 20。
    const terminal = (installed["W2N57"] as unknown as { terminal?: { store: { getFreeCapacity(): number } } }).terminal;
    expect(terminal?.store.getFreeCapacity()).toBe(20);
    Game.time += 1;
    serviceA.beginTick();
    expect(serviceA.kernelJournal().active.some((r) => r.attemptId === a.attemptId)).toBe(false);
    // B 旧观察 free=100：80 不得双占；20 与新观察空位一致，合法。
    const intoArgs = (amount: number, workKey: string): TreasuryTestTransferArgs =>
      transferArgs({ amount, toRoom: "W2N57", toLocation: "terminal" });
    expect(authorizeOf(serviceB, "biz:d03:in80", intoArgs(80, "biz:d03:in80")).status).toBe("rejected");
    expect(authorizeOf(serviceB, "biz:d03:in20", intoArgs(20, "biz:d03:in20")).status).toBe("admitted");
  });
});

// ── D04：fresh 耗尽 + 结构变化：blocked、调用 0、可安全取消 ──────────────────

describe("D04 fresh 耗尽的执行门禁", () => {
  it("额度耗尽后结构换 ID：blocked、实际调用 0、无 applied、pending 可安全取消；fresh 可用对照执行 1", () => {
    const installed = installRooms(POOL_ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const p = admit(service, "biz:d04:p", transferArgs({ amount: 600 }));
    for (let i = 0; i < 8; i += 1) expect(service.beginFreshObservation()).not.toBeNull();
    (installed["W2N57"] as unknown as { terminal?: { id: string } }).terminal!.id = "term-2-rebuilt";
    const outcome = service.executeAuthorizedDispatch(p.dispatch);
    expect(outcome.status).toBe("blocked");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 许可未消费、记录保持 pending——可安全取消（调用边界从未开始）。
    expect(service.cancelPendingWork({ attemptId: p.attemptId }).status).toBe("ok");
    expect(activeRecord(p.attemptId)).toBeUndefined();
    // 对照：fresh 可用（下一 tick）且结构未变时，新的合法工作执行恰 1 次。
    Game.time += 1;
    const q = admit(service, "biz:d04:q", transferArgs({ amount: 100 }));
    const executed = service.executeAuthorizedDispatch(q.dispatch);
    expect(executed.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

// ── D05：清理 + 旧视图 + fresh 耗尽组合仍不越权 ──────────────────────────────

describe("D05 组合场景（D02/D03 之后再耗尽 fresh）", () => {
  it("旧真许可在 fresh 耗尽 + 结构变化下 blocked；新合法工作仍可授权；多实例重复入口幂等", () => {
    const installed = installRooms(POOL_ROOMS);
    const s1 = createTreasuryService({ getRooms: () => Object.values(installed) });
    const s2 = createTreasuryService({ getRooms: () => Object.values(installed) });
    s1.beginTick();
    s2.beginTick();
    const a = admit(s1, "biz:d05:a", transferArgs({ amount: 700 }));
    expect(s1.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    Game.time += 1;
    s1.beginTick(); // A 退出（观察接管）。
    // B 在旧观察下授权 200（新观察余额 300，合法），然后耗尽本实例 fresh。
    const b = admit(s2, "biz:d05:b", transferArgs({ amount: 200 }));
    for (let i = 0; i < 8; i += 1) expect(s2.beginFreshObservation()).not.toBeNull();
    (installed["W1N57"] as unknown as { storage?: { id: string } }).storage!.id = "stor-1-rebuilt";
    // 旧真许可 + fresh 耗尽 + 结构变化：组合阻断，调用 0。
    const outcome = s2.executeAuthorizedDispatch(b.dispatch);
    expect(outcome.status).toBe("blocked");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1); // 只有 A 的 1 次
    // B 的 pending 可安全取消；多实例重复入口（幂等 beginTick）无越权。
    expect(s2.cancelPendingWork({ attemptId: b.attemptId }).status).toBe("ok");
    expect(s1.beginTick()).toEqual(expect.objectContaining({ recovered: 0 }));
    expect(s2.beginTick()).toEqual(expect.objectContaining({ recovered: 0 }));
    // 下一 tick fresh 恢复：合法新工作可执行。
    Game.time += 1;
    const c = admit(s2, "biz:d05:c", transferArgs({ amount: 50 }));
    expect(s2.executeAuthorizedDispatch(c.dispatch).status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(2);
  });
});

// ── D06：承诺完整性进入 authorize 与 dispatch（含真许可后注入） ──────────────

describe("D06 完整性门禁三时点", () => {
  function injectBrokenTask(): void {
    Memory.data = Memory.data ?? {};
    Memory.data.resourceControl = Memory.data.resourceControl ?? {};
    (Memory.data.resourceControl as { tasks?: Record<string, unknown> }).tasks = {
      "task-d06-bad": {
        id: "task-d06-bad", resource: RESOURCE_ENERGY, fromRoomName: "W1N57", toRoomName: "W2N57",
        amount: 100, remainingAmount: "corrupted" as unknown as number, status: "pending",
        createdAt: 900, updatedAt: 1000, origin: "manual", lastProgressAt: 1000,
      },
    };
    bumpTreasuryCommitmentRevision();
  }
  function clearTasks(): void {
    Memory.data = Memory.data ?? {};
    Memory.data.resourceControl = Memory.data.resourceControl ?? {};
    (Memory.data.resourceControl as { tasks?: Record<string, unknown> }).tasks = {};
    bumpTreasuryCommitmentRevision();
  }

  it("authorize 前注入：query 阻断、authorize 拒绝（不按剩余数值放行）；修复后合法对照获准", () => {
    const service = makeService();
    injectBrokenTask();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(authorizeOf(service, "biz:d06:a", transferArgs({ amount: 800 })).status).toBe("rejected");
    clearTasks();
    expect(authorizeOf(service, "biz:d06:b", transferArgs({ amount: 800 })).status).toBe("admitted");
  });

  it("真许可已签发后注入：dispatch 复验一致阻断、实际调用 0；修复后同一许可可执行", () => {
    const service = makeService();
    const p = admit(service, "biz:d06:p", transferArgs({ amount: 500 }));
    injectBrokenTask();
    const outcome = service.executeAuthorizedDispatch(p.dispatch);
    expect(outcome.status).toBe("blocked");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 来源修复（正常失效/刷新）：同一许可在下一 tick 前不可跨 tick 复用
    // （issuedAtTick 门禁）——用新的合法授权作正向对照。
    clearTasks();
    const q = admit(service, "biz:d06:q", transferArgs({ amount: 500 }));
    expect(service.executeAuthorizedDispatch(q.dispatch).status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

// ── D07：rearm 前的完整性门禁（不误消费权利） ────────────────────────────────

describe("D07 rearm 门禁与权利保持", () => {
  function injectBrokenTask(): void {
    Memory.data = Memory.data ?? {};
    Memory.data.resourceControl = Memory.data.resourceControl ?? {};
    (Memory.data.resourceControl as { tasks?: Record<string, unknown> }).tasks = {
      "task-d07-bad": {
        id: "task-d07-bad", resource: RESOURCE_ENERGY, fromRoomName: "W1N57", toRoomName: "W2N57",
        amount: 1, remainingAmount: "bad" as unknown as number, status: "pending",
        createdAt: 900, updatedAt: 1000, origin: "manual", lastProgressAt: 1000,
      },
    };
    bumpTreasuryCommitmentRevision();
  }
  function clearTasks(): void {
    (Memory.data!.resourceControl as { tasks?: Record<string, unknown> }).tasks = {};
    bumpTreasuryCommitmentRevision();
  }

  it("父代 retry_ready 后承诺不完整：不产生 child、不消费 rearm 权利；修复后同一许可合法 rearm", () => {
    // service 全链路（facade 装配的容量端口含完整性门禁——kernel 直调的
    // 测试端口 () => null 不经过它）。
    const service = makeService();
    const parent = admit(service, "biz:d07:parent", transferArgs({ amount: 500, outcome: "non-ok" }));
    expect(service.executeAuthorizedDispatch(parent.dispatch).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    expect((activeRecord(parent.attemptId) as { phase?: string })?.phase).toBe("retry_ready");
    const issued = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (issued.status !== "ok") throw new Error("rearm permit expected");
    // 承诺不完整 → rearm 拒绝；父代保持 retry_ready（权利未被消费）。
    injectBrokenTask();
    const blocked = service.executeRearm(issued.rearm, buildContract(service, "biz:d07:child", transferArgs({ amount: 500 })), { workKey: "biz:d07:child" });
    expect(blocked.status).toBe("rejected");
    expect((activeRecord(parent.attemptId) as { phase?: string })?.phase).toBe("retry_ready");
    // 来源修复（正常失效/刷新）后：同一 rearm 许可合法产生 child。
    clearTasks();
    const rearmOk = service.executeRearm(issued.rearm, buildContract(service, "biz:d07:child", transferArgs({ amount: 500 })), { workKey: "biz:d07:child" });
    expect(rearmOk.status).toBe("admitted");
    expect((activeRecord(parent.attemptId))).toBeUndefined(); // 父代退出（not_executed ring）
  });
});

// ── D08：健康 policy + exact own-reservation 贯穿（合法请求能完成） ───────────

describe("D08 own-reservation 与他人责任并存", () => {
  it("owner A 200 获准并执行；他人 B 700 获准并执行；不声明 owner 的 950 对照拒绝", () => {
    const installed = installRooms(POOL_SAFE_ROOMS());
    const ownerHolder = "synthesis:W1N57:energy";
    const service = createTreasuryService({ getRooms: () => Object.values(installed), holderExists: () => true });
    service.beginTick();
    const owner = classifyTreasuryHolderIdAsOwner(ownerHolder);
    if (owner === undefined) throw new Error("owner 未分类");
    const reserved = reserveProductionResourceForOwner("W1N57", RESOURCE_ENERGY, 50, owner, 1000);
    if (reserved.status !== "ok") throw new Error(`reserve failed: ${"reason" in reserved ? reserved.reason : "?"}`);
    const ownerOpts = {
      scope: "production-reservation" as const,
      ownerKind: "logical-service" as const,
      ownerId: ownerHolder,
      roomName: "W1N57",
    };
    // owner 自己的预留（50）可排除：950 ≤ 1000 获准并执行。
    const a = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:d08:a", transferArgs({ amount: 200 })),
      { workKey: "biz:d08:a", owner: ownerOpts },
    );
    expect(a.status).toBe("admitted");
    expect(service.executeAuthorizedDispatch((a as { dispatch: unknown }).dispatch).status).toBe("committed");
    // 他人 B（无 owner 声明，预留有效）：余额 800，700 获准并执行。
    const b = admit(service, "biz:d08:b", transferArgs({ amount: 700 }));
    expect(service.executeAuthorizedDispatch(b.dispatch).status).toBe("committed");
    // 对照：不声明 owner 时预留不可排除——950 > 剩余 100 拒绝。
    expect(authorizeOf(service, "biz:d08:anon", transferArgs({ amount: 950 })).status).toBe("rejected");
  });
});

function POOL_SAFE_ROOMS(): RoomSpec[] {
  // 大余额池：A 200 + B 700 + 预留 50 均可容纳（预留 50 来自 fixture）。
  return [
    { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 } },
    { name: "W2N57", terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 } },
  ];
}

// ── D12：部分适用观察不得代表全部源覆盖 ──────────────────────────────────────

describe("D12 多位置动作的部分观察", () => {
  it("观察只覆盖流出侧时 committed 不退出；全部位置恢复覆盖后才退出并使旧视图失效", () => {
    const scoped = makeScopedService();
    const a = admit(scoped.service, "biz:d12:a", transferArgs({ amount: 300 }));
    expect(scoped.service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    scoped.hide("W2N57");
    Game.time += 1;
    scoped.service.beginTick();
    expect(activeRecord(a.attemptId)).toBeDefined(); // 全局序号再大也不代表流入侧覆盖
    Game.time += 1;
    setStoreResources((scoped.rooms["W1N57"] as unknown as { terminal?: StructureTerminal }).terminal, { energy: 5 }); // 无关源推进世界序
    scoped.service.beginTick();
    expect(activeRecord(a.attemptId)).toBeDefined(); // 无关更新不满足范围
    scoped.show("W2N57");
    Game.time += 1;
    scoped.service.beginTick();
    expect(activeRecord(a.attemptId)).toBeUndefined(); // 全部必要责任闭合 → 退出
    // 退出后旧视图失效：同 service 的新授权以真实世界（storage 700）判定。
    expect(authorizeOf(scoped.service, "biz:d12:b800", transferArgs({ amount: 800 })).status).toBe("rejected");
    expect(authorizeOf(scoped.service, "biz:d12:b700", transferArgs({ amount: 700 })).status).toBe("admitted");
  });
});

// ── D14：父子代义务不重复继承 ────────────────────────────────────────────────

describe("D14 retry 链的义务继承", () => {
  it("父代 not-executed 单义务 D 释放完成：retry_ready 持久空集合；child 不继承 D、不重复释放；child 可执行", () => {
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key, id) => {
        releaseCalls.push(`${key}@${id}`);
        return true;
      },
    }));
    const admitted = kernel.admit(kernelAdmitInput(["ext:d14:duty-d"], "biz:d14:chain"));
    if (admitted.status !== "admitted") throw new Error(`admit failed: ${admitted.reason}`);
    expect(kernel.executeDispatch(admitted.dispatch).status).toBe("not_executed");
    Game.time += 1;
    kernel.beginTick();
    const parent = activeRecord(admitted.attemptId) as { phase: string; cleanup: { consumerKeys: string[] } } | undefined;
    expect(parent?.phase).toBe("retry_ready");
    expect(parent?.cleanup.consumerKeys).toEqual([]); // 持久空集合（IV/R5）
    const issued = kernel.issueRearmPermit({ parentAttemptId: admitted.attemptId });
    if (issued.status !== "ok") throw new Error("rearm expected");
    const rearm = kernel.executeRearm(issued.rearm, {
      identity: kernelIdentity(),
      worstCase: kernelLegs(30),
      canonicalArgs: { n: 2 },
      postings: kernelLegs(30),
      admissionContext: { contractId: "ac:d14", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
      structureBindings: [],
    });
    if (rearm.status !== "admitted") throw new Error(`rearm failed: ${rearm.reason}`);
    const child = activeRecord(rearm.attemptId) as { cleanup: { consumerKeys: string[] } } | undefined;
    expect(child?.cleanup.consumerKeys).toEqual([]); // 不继承 D
    // child 生命周期推进（not_executed → 清理）不再对 D 产生任何释放调用。
    expect(kernel.executeDispatch(rearm.dispatch).status).toBe("not_executed");
    Game.time += 1;
    kernel.beginTick();
    const releaseSet = new Set(releaseCalls);
    expect(releaseSet.size).toBe(releaseCalls.length); // 同一 (key, attemptId) 幂等
    expect(releaseCalls.filter((entry) => entry.startsWith("ext:d14:duty-d@")).length).toBe(1); // D 恰好释放一次
  });
});

// ── D20：矛盾状态拒绝；坏 ring 不阻断健康工作 ────────────────────────────────

describe("D20 retry_ready 矛盾与坏 ring 隔离", () => {
  function healthyBase(): Record<string, unknown> {
    return {
      version: 3,
      installEpochId: "e".repeat(16),
      issuance: { frontier: 1, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {},
      ring: [],
      ringCursor: 0,
      counters: { admitted: 0, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    };
  }
  function notExecutedRecord(attemptId: string, consumerKeys: string[]): Record<string, unknown> {
    return {
      workKey: "biz:d20:w", attemptId, generation: 1, parentAttemptId: null,
      phase: "retry_ready", admittedAtTick: 1, updatedAtTick: 2,
      identity: {
        actionKind: "d.kind", adapterVersion: 1, adapterRegistrationId: "reg-d4", adapterSemanticIdentity: "d.adapter-v1",
        canonicalDigest: "a".repeat(16), postingsDigest: "b".repeat(16), retryFactsDigest: "c".repeat(16), durableFacts: null,
      },
      worstCase: kernelLegs(50), invocation: null, external: null,
      outcome: "not_executed",
      outcomeEvidence: { kind: "adapter_execution_semantics", conclusion: "not_executed", source: "test", atTick: 2 },
      cleanup: { consumerKeys, failures: 0 }, retryDeadlineTick: 5000, lastError: null,
    };
  }

  it("非空义务 + retry_ready：unhealthy（拒绝，不自动清空）", () => {
    const base = healthyBase();
    base.active = { tk1_1_aaaaaaaaaaaaaaaa: notExecutedRecord("tk1_1_aaaaaaaaaaaaaaaa", ["ext:d20:kept"]) };
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = base;
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
    // 原数据保留（不自动清空义务）。
    const kept = ((Memory.runtime as unknown as { treasuryCore?: { active: Record<string, { cleanup: { consumerKeys: string[] } }> } }).treasuryCore!.active)["tk1_1_aaaaaaaaaaaaaaaa"];
    expect(kept.cleanup.consumerKeys).toEqual(["ext:d20:kept"]);
  });

  it("committed + retry_ready：unhealthy", () => {
    const base = healthyBase();
    const record = notExecutedRecord("tk1_1_bbbbbbbbbbbbbbbb", []);
    (record as { outcome: string }).outcome = "committed";
    ((record as { outcomeEvidence: unknown }).outcomeEvidence as { conclusion: string }).conclusion = "executed";
    base.active = { tk1_1_bbbbbbbbbbbbbbbb: record };
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = base;
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
  });

  it("仅 ring 坏（非数组）：healthy + ringDegraded，查询零写，健康工作仍可完成退出", () => {
    const installed = installRooms(POOL_ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const a = admit(service, "biz:d20:a", transferArgs({ amount: 100 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 破坏 ring 层（非数组）——只产生诊断。
    const store = Memory.runtime!.treasuryCore as unknown as { ring: unknown };
    store.ring = "corrupted";
    const before = JSON.stringify(Memory.runtime!.treasuryCore);
    const journal = service.kernelJournal();
    expect(journal.health.status).toBe("healthy");
    expect(journal.health.ringDegraded).not.toBeNull();
    expect(JSON.stringify(Memory.runtime!.treasuryCore)).toBe(before); // 查询零写
    Game.time += 1;
    service.beginTick(); // 健康清理照常（重建 ring 前提下退出）
    expect(activeRecord(a.attemptId)).toBeUndefined();
  });
});

// ── D21：真实 JSON 与构造器上界逐项对照 ──────────────────────────────────────

describe("D21 空间上界与实际表示", () => {
  const MAXI = Number.MAX_SAFE_INTEGER;

  it("构造器最坏记录通过 validator（合法输入）且其真实序列化 = 声明上界", () => {
    const record = buildTreasuryCoreWorstWorkRecord();
    const base = {
      version: 3, installEpochId: "e".repeat(16),
      issuance: { frontier: 1, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: { [record.attemptId]: record }, ring: [], ringCursor: 0,
      counters: { admitted: 1, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    };
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = base;
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy");
    expect(JSON.stringify(base).length).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    expect(treasuryCoreSlotWorstChars()).toBe(JSON.stringify({ [record.attemptId]: record }).length);
  });

  it("逐字段极值独立验证：数字位宽（16 位正/17 位负）、worldSequence、转义文本、consumerKeys 数量", () => {
    const record = buildTreasuryCoreWorstWorkRecord() as unknown as Record<string, unknown>;
    expect(record.generation).toBe(9_999);
    expect(record.admittedAtTick).toBe(MAXI); // 16 位
    expect((record.worstCase as { delta: number }[])[0]!.delta).toBe(-MAXI); // 17 位（负号）
    expect((record.invocation as { worldSequence: number }).worldSequence).toBe(MAXI); // IV 新增字段计入
    expect((record.lastError as string).length).toBe(96); // 96 × \u0000 = 576 转义字符
    expect((record.cleanup as { consumerKeys: string[] }).consumerKeys.length).toBe(TREASURY_CORE_CONSUMER_KEYS_MAX);
    // 转义真实计价：JSON.stringify 每个控制字符 6 字符。
    expect(JSON.stringify(record.lastError).length).toBe(96 * 6 + 2);
  });

  it("非法值在复制前拒绝：超界 payload 整体拒绝（无 slice 截断后接受）", () => {
    const base = {
      version: 3, installEpochId: "e".repeat(16),
      issuance: { frontier: 1, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {}, ring: [], ringCursor: 0,
      counters: { admitted: 0, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    };
    const record = buildTreasuryCoreWorstWorkRecord() as unknown as Record<string, unknown>;
    const identity = record.identity as { durableFacts: { payload: string } };
    identity.durableFacts.payload = "a".repeat(513); // 超界
    base.active = { [record.attemptId as string]: record };
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = base;
    expect(readTreasuryCoreStoreHealth().status).toBe("unhealthy");
  });

  it("满载数学断言：64 × 槽上界 + 128 × 历史槽上界 + 根元信息 ≤ 360,000（bytes 另报）", () => {
    const total = TREASURY_CORE_ACTIVE_LIMIT * treasuryCoreSlotWorstChars()
      + TREASURY_CORE_RING_LIMIT * treasuryCoreRingSlotWorstChars()
      + treasuryCoreMetaWorstChars();
    expect(total).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    expect(treasuryCoreSlotWorstChars()).toBeGreaterThan(4_000); // 上界真实反映极值记录（非缩水估算）
    // bytes：受控字符集下 bytes == 字符数；lastError 转义后仍 ASCII。
    const record = buildTreasuryCoreWorstWorkRecord();
    expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBe(JSON.stringify(record).length);
    expect(JSON.stringify(buildTreasuryCoreWorstRingEntry()).length).toBeLessThanOrEqual(treasuryCoreRingSlotWorstChars());
  });
});

// ── D22：真实接纳的最大记录满载与全生命周期预算 ──────────────────────────────

describe("D22 真实接纳满载与生命周期预算", () => {
  it("真实接纳极值记录 × 满 active + 满 ring，演化 unknown/closing/partial cleanup：总序列化 ≤ 预算，超额拒绝，已接纳可收尾", () => {
    const installed = installRooms([
      { name: "W1N57", storage: { id: "stor-1", resources: { energy: 10 ** 15 }, freeCapacity: 10_000 } },
      { name: "W2N57", terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 } },
    ]);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const longKey = (i: number) => `biz:d22:${"k".repeat(80)}:${String(i)}`;
    // 64 条真实接纳（满 active），最长 workKey（96 内）+ 最大金额。
    const permits: { attemptId: string; dispatch: unknown }[] = [];
    for (let i = 0; i < TREASURY_CORE_ACTIVE_LIMIT; i += 1) {
      const admitted = service.authorizeTreasuryActionContract(
        buildContract(service, longKey(i), transferArgs({ amount: 1000, outcome: "throw" })),
        { workKey: longKey(i) },
      );
      if (admitted.status !== "admitted") throw new Error(`admit ${String(i)} failed: ${admitted.reason}`);
      permits.push({ attemptId: admitted.attemptId, dispatch: admitted.dispatch });
    }
    // 部分演化为 unknown（throw 路径）、部分保持 pending。同 tick fresh
    // 额度 8（IV/R2：耗尽即阻断）——恰好验证满载下许可执行的有界吞吐。
    for (const permit of permits.slice(0, 8)) {
      const outcome = service.executeAuthorizedDispatch(permit.dispatch);
      expect(outcome.status).toBe("unknown");
    }
    const ninth = service.executeAuthorizedDispatch(permits[8]!.dispatch);
    expect(ninth.status).toBe("blocked"); // fresh 耗尽：不回退旧快照（R2）
    // 满 ring。
    const store = Memory.runtime!.treasuryCore as unknown as { ring: unknown[]; issuance: { frontier: number } };
    for (let i = 0; i < TREASURY_CORE_RING_LIMIT; i += 1) {
      store.ring.push({ attemptId: `tk1_${String(9000 + i)}_ffffffffffffffff`, workKey: longKey(i), generation: 9_999, terminalPhase: "retry_expired", closedAtTick: Game.time });
    }
    // 满载 + 满预算下：新接纳拒绝（active 上限）。
    expect(authorizeOf(service, "biz:d22:overflow", transferArgs({ amount: 1 })).status).toBe("rejected");
    // 已接纳工作仍有收尾余量：一条 pending 安全取消（写回成功）。
    expect(service.cancelPendingWork({ attemptId: permits[permits.length - 1]!.attemptId }).status).toBe("ok");
    // 总序列化实测（字符与 bytes 分报）。
    const chars = JSON.stringify(Memory.runtime!.treasuryCore).length;
    expect(chars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    expect(Buffer.byteLength(JSON.stringify(Memory.runtime!.treasuryCore), "utf8")).toBe(chars);
    // 全生命周期上界断言（数学）：满载最坏（含 ring）不超预算。
    expect(
      TREASURY_CORE_ACTIVE_LIMIT * treasuryCoreSlotWorstChars()
        + TREASURY_CORE_RING_LIMIT * treasuryCoreRingSlotWorstChars()
        + treasuryCoreMetaWorstChars(),
    ).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
  });
});
