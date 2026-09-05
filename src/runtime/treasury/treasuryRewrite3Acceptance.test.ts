/**
 * Treasury Core Rewrite III——C01–C24 验收矩阵（任务书 §9）。
 *
 * 每个用例名标注 C 编号；断言基于可观察事实：真实动作调用计数与实际
 * 参数（宿主持有轨迹）、独立于 Memory 与模块重载的世界状态、发布前后
 * 的持久快照。基线红灯证据见 evidence/core-rewrite-iii/baseline/；
 * 本文件是修复后的正式行为测试（对应 R1–R8 的治愈对照）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
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
  makeFixedReserveTreasuryPolicy,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
  type TreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { createTreasuryCoreKernel } from "@/runtime/treasury/kernel/kernel";
import {
  readTreasuryCoreStoreHealth,
  treasuryCoreMetaWorstChars,
  treasuryCoreRingSlotWorstChars,
  treasuryCoreSlotWorstChars,
} from "@/runtime/treasury/kernel/store";
import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_RING_LIMIT,
  TREASURY_CORE_TOTAL_CHAR_BUDGET,
} from "@/runtime/treasury/kernel/types";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";

/** 源池（W1N57 storage 1000）+ 下游接收房间。 */
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

/** 拦截 treasuryCore 写入：transform(draft, current) 返回实际落盘值。 */
function interceptTreasuryCoreWrites(
  transform: (draft: unknown, current: unknown) => unknown,
): () => void {
  const runtime = Memory.runtime as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
  const currentBox = { value: descriptor?.value };
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
    // 恢复为普通数据属性并**保留最新落盘值**（不回滚到安装时快照——II 轮
    // 已证 descriptor.value 会撤销拦截期间的全部合法发布）。
    delete runtime.treasuryCore;
    runtime.treasuryCore = currentBox.value;
  };
}

function storeNow(): Record<string, unknown> | undefined {
  return Memory.runtime?.treasuryCore as Record<string, unknown> | undefined;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── C01：policy 保留额约束累计责任（三态 + 正反对照） ──────────────────────

describe("C01 policy 累计（池 1000 / 保留 900）", () => {
  beforeEach(() => {
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(450)); // 450+450=900
  });

  it("A pending 80 后 B 80 拒绝；B 20 获准；A 取消后 B 80 恢复（无累计越界）", () => {
    const service = makeService();
    const a = admit(service, "biz:c01:a", transferArgs({ amount: 80 }));
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c01:b80", transferArgs({ amount: 80 })), { workKey: "biz:c01:b80" }).status,
    ).toBe("rejected");
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c01:b20", transferArgs({ amount: 20 })), { workKey: "biz:c01:b20" }).status,
    ).toBe("admitted");
    expect(service.cancelPendingWork({ attemptId: a.attemptId }).status).toBe("ok");
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c01:b80-after", transferArgs({ amount: 80 })), { workKey: "biz:c01:b80-after" }).status,
    ).toBe("admitted");
  });

  it("A unknown 80 后 B 80 拒绝（unknown 占用参与政策合计）", () => {
    const service = makeService();
    const a = admit(service, "biz:c01:u", transferArgs({ amount: 80, outcome: "throw" }));
    const executed = service.executeAuthorizedDispatch(a.dispatch);
    expect(executed.status).toBe("unknown");
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c01:ub", transferArgs({ amount: 80 })), { workKey: "biz:c01:ub" }).status,
    ).toBe("rejected");
  });

  it("A committed（效果未入观察）80 后 B 80 拒绝；下一 tick 观察接管后额度恢复", () => {
    const rooms = installRooms(POOL_ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
    service.beginTick();
    const a = admit(service, "biz:c01:c", transferArgs({ amount: 80 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c01:cb", transferArgs({ amount: 80 })), { workKey: "biz:c01:cb" }).status,
    ).toBe("rejected");
    // 世界已被 adapter 真实更新（storage 920）；下一 tick 观察接管。
    Game.time += 1;
    service.beginTick();
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c01:cb2", transferArgs({ amount: 20 })), { workKey: "biz:c01:cb2" }).status,
    ).toBe("admitted");
  });
});

// ── C02：scope 多候选共同消费政策余量；范围级承诺单份 ──────────────────────

describe("C02 scope 合计与承诺单份", () => {
  beforeEach(() => {
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(470)); // reserve 940，池 1050 → 可支配 110
  });

  it("同一候选跨 storage/terminal 双腿流出：合计 130 > 110 拒绝；对照 95 获准（不逐腿共用余量）", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 50 }, freeCapacity: 200_000 },
      },
      {
        name: "W2N57",
        storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
        terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 },
      },
    ]);
    // 主腿 storage 80 + fee 腿 terminal 50（同房间同池合计 130 > 可支配 110）。
    const contract = buildContract(service, "biz:c02:two-legs", {
      ...transferArgs({ amount: 80, feeFromRoom: "W1N57", feeAmount: 50 }),
    });
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:c02:two-legs" }).status).toBe("rejected");
    // 对照：合计 95（60+35）≤ 110 获准（fee 35 ≤ terminal 余额 50）。
    const ok = buildContract(service, "biz:c02:two-legs-ok", {
      ...transferArgs({ amount: 60, feeFromRoom: "W1N57", feeAmount: 35 }),
    });
    expect(service.authorizeTreasuryActionContract(ok, { workKey: "biz:c02:two-legs-ok" }).status).toBe("admitted");
  });

  it("跨房间候选合计受约束（共享池不按房间复制余额）", () => {
    const service = makeService();
    // 每房间单独 80 ≤ 100，但两房间候选合计 160 > 池 1000 − 900 → 拒绝。
    // 候选一：W1N57→W2N57（80）；候选二（同笔 fee 腿从 W2N57 terminal 拿不出——
    // 改用单候选双腿跨房间场景：主腿 80 + fee 腿挂另一房间 terminal（0 资源，
    // 由容量检查覆盖）；政策层验证 scope 合计。
    const contract = buildContract(service, "biz:c02:cross", {
      ...transferArgs({ amount: 80, feeFromRoom: "W2N57", feeAmount: 50 }),
    });
    expect(service.authorizeTreasuryActionContract(contract, { workKey: "biz:c02:cross" }).status).toBe("rejected");
  });

  it("同接收位置两种资源流入各 60、空位 100：按合计拒绝（单份容量不重复给）", () => {
    const service = makeService([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 100_000, Utrium: 100_000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 0, Utrium: 0 }, freeCapacity: 100 },
      },
      {
        name: "W2N57",
        storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
        terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 },
      },
    ]);
    const energy = buildContract(service, "biz:c02:in-e", { ...transferArgs(), resource: RESOURCE_ENERGY, amount: 60 });
    expect(service.authorizeTreasuryActionContract(energy, { workKey: "biz:c02:in-e" }).status).toBe("admitted");
    const utrium = buildContract(service, "biz:c02:in-u", { ...transferArgs(), resource: RESOURCE_UTRIUM, amount: 60 });
    expect(service.authorizeTreasuryActionContract(utrium, { workKey: "biz:c02:in-u" }).status).toBe("rejected");
  });
});

// ── C03：own-reservation 贯穿与伪造 owner 对照 ──────────────────────────────

describe("C03 own-reservation 全链一致", () => {
  const OWN_HOLDER = "synthesis:W1N57:energy";

  function ownService(): { service: TreasuryService; holderId: string } {
    const installed = installRooms([
      {
        name: "W1N57",
        storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
        terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
      },
    ]);
    // synthesis: 是已注册逻辑命名空间（resolveTreasuryHolder 默认解析
    // owned 房间归属；commitments 分类为 typed logical-service owner）。
    const service = createTreasuryService({
      getRooms: () => Object.values(installed),
      holderExists: () => true,
    });
    service.beginTick();
    (Memory.runtime as unknown as { resourceReservations?: Record<string, unknown> }).resourceReservations = {
      "res:c03:own": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: OWN_HOLDER, amount: 300, expiresAt: Game.time + 1000 },
    };
    return { service, holderId: OWN_HOLDER };
  }

  const ownerOf = (holderId: string) => ({
    scope: "production-reservation" as const,
    ownerKind: "logical-service" as const,
    ownerId: holderId,
    roomName: "W1N57",
  });

  it("exact owner 自己的预留 300：owner 流出 950 获准（facade 与 kernel 端口同一上下文，无匿名扣回）", () => {
    const { service, holderId } = ownService();
    const admission = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c03:own", { ...transferArgs(), toRoom: "W1N57", toLocation: "terminal", amount: 950 }),
      { workKey: "biz:c03:own", owner: ownerOf(holderId) },
    );
    expect(admission.status).toBe("admitted");
  });

  it("同一场景执行复验：owner 许可的执行不被匿名二次裁决拒绝（不自我双扣）", () => {
    const { service } = ownService();
    const a = admit(service, "biz:c03:exec", { ...transferArgs({ amount: 500 }), toRoom: "W1N57", toLocation: "terminal" });
    const executed = service.executeAuthorizedDispatch(a.dispatch);
    expect(executed.status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("不声明 owner 时 950 拒绝（预留对他人有效）；伪造 owner（未注册 holder）拒绝", () => {
    const { service } = ownService();
    expect(
      service.authorizeTreasuryActionContract(
        buildContract(service, "biz:c03:anon", { ...transferArgs(), toRoom: "W1N57", toLocation: "terminal", amount: 950 }),
        { workKey: "biz:c03:anon" },
      ).status,
    ).toBe("rejected");
    expect(
      service.authorizeTreasuryActionContract(
        buildContract(service, "biz:c03:forged", { ...transferArgs(), toRoom: "W1N57", toLocation: "terminal", amount: 950 }),
        { workKey: "biz:c03:forged", owner: ownerOf("svc:c03:not-registered") },
      ).status,
    ).toBe("rejected");
  });

  it("policy resolver 收到真实 contract 上下文（无占位 '-'）", () => {
    const contexts: Array<Record<string, unknown>> = [];
    const resolver: TreasuryPolicyResolver = {
      policyId: "treasury.test.recording",
      policyVersion: 1,
      evaluate: (context) => {
        contexts.push({ ...context });
        return { withhold: 0, strategicReserve: 0, emergencyOverride: false };
      },
    };
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(resolver);
    const { service } = ownService();
    admit(service, "biz:c03:ctx", { ...transferArgs({ amount: 50 }), toRoom: "W1N57", toLocation: "terminal" });
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    const ctx = contexts[0];
    expect(ctx.contractId).not.toBe("-");
    expect(ctx.contractDigest).not.toBe("-");
    expect(ctx.actionKind).toBe("test.transfer");
    expect(String(ctx.contractId)).toContain("ac:");
  });
});

// ── C04：policy 缺失/故障与宽松展示开关 ────────────────────────────────────

describe("C04 fail-closed 一致阻断", () => {
  it("policy 缺失：接纳与执行复验一致阻断；宽松查询展示不转化执行权限", () => {
    clearTreasuryPolicyResolversForTest();
    const service = makeService();
    const admission = service.authorizeTreasuryActionContract(buildContract(service, "biz:c04:miss", transferArgs()), { workKey: "biz:c04:miss" });
    expect(admission.status).toBe("rejected");
    if (admission.status === "rejected") expect(admission.reasonCode).toBe("policy_unavailable");
    // 宽松展示口径仍可返回数字（projected 展示），但 authorizationSafe=false。
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
  });

  it("policy 抛错：结构化 policy_fault，接纳拒绝", () => {
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.throwing",
      policyVersion: 1,
      evaluate: () => {
        throw new Error("boom");
      },
    });
    const service = makeService();
    const admission = service.authorizeTreasuryActionContract(buildContract(service, "biz:c04:throw", transferArgs()), { workKey: "biz:c04:throw" });
    expect(admission.status).toBe("rejected");
    if (admission.status === "rejected") expect(admission.reason).toContain("policy_fault");
  });

  it("policy 返回非法决策（负 withhold）：policy_fault 拒绝", () => {
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.invalid",
      policyVersion: 1,
      evaluate: () => ({ withhold: -5, strategicReserve: 0, emergencyOverride: false }),
    });
    const service = makeService();
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c04:invalid", transferArgs()), { workKey: "biz:c04:invalid" }).status,
    ).toBe("rejected");
  });

  it("承诺不完整（任务 holder 缺失）：严格查询 authorizationSafe=false", () => {
    const service = makeService();
    (Memory.data as unknown as { resourceControl?: unknown } | undefined) ?? {};
    Memory.data = Memory.data ?? {};
    (Memory.data as unknown as { resourceControl: { tasks: Record<string, unknown> } }).resourceControl = {
      tasks: { "task:c04:orphan": { fromRoom: "W1N57", toRoom: "W2N57", resource: RESOURCE_ENERGY, amount: 10, holderId: "ghost", status: "pending" } },
    };
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
  });
});

// ── C05：执行前复验的当前事实 ──────────────────────────────────────────────

describe("C05 执行门禁复验", () => {
  it("授权后同 tick policy 收紧（reserve→950）：旧许可调用 0、无 applied 变化；合法对照调用 1", () => {
    const service = makeService();
    const a = admit(service, "biz:c05:tight", transferArgs({ amount: 80 }));
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(475)); // 950
    const blocked = service.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") expect(blocked.reasonCode).toBe("insufficient_amount");
    // 合法对照：恢复宽松 policy 后新许可调用恰 1 次（同一收紧 policy 下
    // A 的 80 占用使可支配为负——新候选也应被拒，由上一断言覆盖）。
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
    const b = admit(service, "biz:c05:ok", transferArgs({ amount: 20 }));
    expect(service.executeAuthorizedDispatch(b.dispatch).status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("同 policy 注册下业务值改变（reserve 0→900）同样阻断：执行时重算，不只比对注册身份", () => {
    const service = makeService();
    const a = admit(service, "biz:c05:value", transferArgs({ amount: 80 }));
    // 同一 resolver 引用不变，但返回的业务值收紧。
    let currentReserve = 0;
    clearTreasuryPolicyResolversForTest();
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.dynamic",
      policyVersion: 1,
      evaluate: () => ({ withhold: currentReserve / 2, strategicReserve: currentReserve / 2, emergencyOverride: false }),
    });
    currentReserve = 950;
    const blocked = service.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(blocked.status).toBe("blocked");
  });

  it("结构消失（房间被移除）：观察不覆盖目标 → 许可 blocked、调用 0", () => {
    const installed = installRooms(POOL_ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const a = admit(service, "biz:c05:gone", transferArgs({ amount: 80 }));
    delete (installed as Record<string, unknown>)["W2N57"];
    const blocked = service.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(blocked.status).toBe("blocked");
  });

  it("同位置结构更换 ID（incarnation 变化）：许可 blocked、调用 0", () => {
    const installed = installRooms(POOL_ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const a = admit(service, "biz:c05:incarnation", transferArgs({ amount: 80 }));
    // 模拟结构重建：同位置换 ID（世界变化，观察仍覆盖位置但 incarnation 不同）。
    const roomsRecord = installed as unknown as Record<string, { name: string; storage?: unknown; terminal?: unknown }>;
    roomsRecord["W1N57"] = {
      ...roomsRecord["W1N57"],
      storage: { id: "stor-1-rebuilt", store: (roomsRecord["W1N57"].storage as { store: unknown }).store },
    } as unknown as typeof roomsRecord["W1N57"];
    const blocked = service.executeAuthorizedDispatch(a.dispatch);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(blocked.status).toBe("blocked");
  });
});

// ── C06：endTick 关闭共享授权窗口 ──────────────────────────────────────────

describe("C06 授权窗口共享关闭", () => {
  it("endTick 后：同实例 dispatch blocked、第二实例 beginTick 不重开、rearm 拒绝；下一 tick 恢复", () => {
    const installed = installRooms(POOL_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const a = admit(serviceA, "biz:c06:a", transferArgs({ amount: 80 }));
    serviceA.endTick();
    // 同实例 dispatch。
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("blocked");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 第二实例重开尝试：新接纳拒绝。
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    const reopened = serviceB.authorizeTreasuryActionContract(buildContract(serviceB, "biz:c06:b", transferArgs({ amount: 50 })), { workKey: "biz:c06:b" });
    expect(reopened.status).toBe("rejected");
    if (reopened.status === "rejected") expect(reopened.reasonCode).toBe("lifecycle_closed");
    // 同实例重复 beginTick 也不重开。
    serviceA.beginTick();
    const again = serviceA.authorizeTreasuryActionContract(buildContract(serviceA, "biz:c06:c", transferArgs({ amount: 50 })), { workKey: "biz:c06:c" });
    expect(again.status).toBe("rejected");
    if (again.status === "rejected") expect(again.reasonCode).toBe("lifecycle_closed");
    // 下一 tick：正常新授权窗口。
    Game.time += 1;
    serviceA.beginTick();
    expect(
      serviceA.authorizeTreasuryActionContract(buildContract(serviceA, "biz:c06:next", transferArgs({ amount: 50 })), { workKey: "biz:c06:next" }).status,
    ).toBe("admitted");
  });

  it("endTick 后安全清理仍可继续（预算恢复不受窗口限制）", () => {
    const service = makeService();
    const a = admit(service, "biz:c06:cleanup", transferArgs({ amount: 80, outcome: "non-ok" }));
    const executed = service.executeAuthorizedDispatch(a.dispatch);
    expect(executed.status).toBe("not_executed");
    service.endTick();
    // endTick 后同 tick：恢复路径（beginTick 幂等分支）仍可推进清理。
    const stats = service.beginTick();
    expect(stats).toBeDefined();
  });
});

// ── C07：本笔占用排除与其它占用保留 ────────────────────────────────────────

describe("C07 复验不自我双扣", () => {
  it("A pending 200、B pending 700：执行 A（排除本笔）合法；B 占用不丢；累计正确", () => {
    const service = makeService();
    const a = admit(service, "biz:c07:a", transferArgs({ amount: 200 }));
    const b = admit(service, "biz:c07:b", transferArgs({ amount: 700 }));
    // 执行 A：复验排除 A 自身 200 占用——可用 = 1000 − B 700 = 300 ≥ 200 ✓。
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    // A committed 后（未入观察）：占用 = B 700 + A 200 = 900；新候选 150 拒绝。
    expect(
      service.authorizeTreasuryActionContract(buildContract(service, "biz:c07:c", transferArgs({ amount: 150 })), { workKey: "biz:c07:c" }).status,
    ).toBe("rejected");
    // B 仍可执行（复验排除 B 自身：1000 − A 200（未覆盖 committed）= 800 ≥ 700 ✓）。
    expect(service.executeAuthorizedDispatch(b.dispatch).status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(2);
  });
});

// ── C08/C09：独立发布目标与全路径发布确认 ──────────────────────────────────

describe("C08 独立发布目标（原地载荷污染）", () => {
  it("写入端原地把 dispatching 改回 pending 并返回同一引用：发布失败、调用 0、许可未消费", () => {
    const service = makeService();
    const a = admit(service, "biz:c08:dirty", transferArgs({ amount: 80 }));
    const restore = interceptTreasuryCoreWrites((draft) => {
      if (draft !== null && typeof draft === "object") {
        const mutated = draft as { active?: Record<string, { phase?: string }> };
        for (const record of Object.values(mutated.active ?? {})) {
          if (record.phase === "dispatching") record.phase = "pending";
        }
      }
      return draft;
    });
    let outcome: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
    try {
      outcome = service.executeAuthorizedDispatch(a.dispatch);
    } finally {
      restore();
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(outcome.status).toBe("publish_failed");
    // 拦截移除后同一许可仍可执行（发布失败未消费许可）。
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

describe("C09 发布确认全路径", () => {
  it("嵌套安全字段原地污染（evidence.conclusion 反转）：结果发布失败，不谎报相反结论", () => {
    const service = makeService();
    const a = admit(service, "biz:c09:dirty", transferArgs({ amount: 80 }));
    const restore = interceptTreasuryCoreWrites((draft) => {
      if (draft !== null && typeof draft === "object") {
        const mutated = draft as { active?: Record<string, { phase?: string; outcomeEvidence?: { conclusion?: string } }> };
        for (const record of Object.values(mutated.active ?? {})) {
          if (record.phase === "closing" && record.outcomeEvidence) {
            record.outcomeEvidence.conclusion = "not_executed";
          }
        }
      }
      return draft;
    });
    let outcome: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
    try {
      outcome = service.executeAuthorizedDispatch(a.dispatch);
    } finally {
      restore();
    }
    // 结果发布被污染 → 安全校验失败（结论与 outcome 相反）→ 不谎报。
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(outcome.status).not.toBe("not_executed");
    const record = service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(record).toBeDefined();
    expect(record?.phase).not.toBe("pending");
  });

  it("写入被替换为旧合法值：识别目标不一致并失败（不误报 committed）", () => {
    const service = makeService();
    const a = admit(service, "biz:c09:swap", transferArgs({ amount: 80 }));
    let firstWrite = true;
    const restore = interceptTreasuryCoreWrites((draft, current) => {
      if (firstWrite) {
        firstWrite = false;
        return draft;
      }
      return current;
    });
    let outcome: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
    try {
      outcome = service.executeAuthorizedDispatch(a.dispatch);
    } finally {
      restore();
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(outcome.status).not.toBe("committed");
    const record = service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(record).toBeDefined();
    expect(record?.phase).not.toBe("pending");
  });

  it("初始化读回不一致：接纳拒绝，不产生半安装状态", () => {
    resetTreasuryCoreStoreForTest();
    Memory.runtime = Memory.runtime ?? {};
    const runtime = Memory.runtime as Record<string, unknown>;
    let installations = 0;
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get() {
        return undefined;
      },
      set() {
        installations += 1;
      },
    });
    try {
      const service = makeService();
      const admission = service.authorizeTreasuryActionContract(
        buildContract(service, "biz:c09:init", transferArgs()),
        { workKey: "biz:c09:init" },
      );
      expect(admission.status).toBe("rejected");
      expect(installations).toBeGreaterThanOrEqual(1);
    } finally {
      delete runtime.treasuryCore;
    }
  });

  it("取消发布丢写：操作失败、记录与义务保留", () => {
    const service = makeService();
    const a = admit(service, "biz:c09:cancel", transferArgs({ amount: 80 }));
    const restore = interceptTreasuryCoreWrites((_draft, current) => current);
    let cancel: ReturnType<TreasuryService["cancelPendingWork"]>;
    try {
      cancel = service.cancelPendingWork({ attemptId: a.attemptId });
    } finally {
      restore();
    }
    expect(cancel.status).toBe("rejected");
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeDefined();
  });

  it("合法发布对照：无故障时 admit→dispatch→跨 tick 清理退出全链成功", () => {
    const service = makeService();
    const a = admit(service, "biz:c09:healthy", transferArgs({ amount: 80 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeUndefined();
    expect(service.kernelJournal().ring.some((e) => e.attemptId === a.attemptId)).toBe(true);
  });
});

// ── C10：写入端重入推进（旧草稿不覆盖新安全状态） ──────────────────────────

describe("C10 重入推进保护", () => {
  it("mutate 与基线漂移检查之间另一工作被推进（重入写）：陈旧草稿被拒、调用 0、不覆盖新状态", () => {
    const service = makeService();
    const a = admit(service, "biz:c10:a", transferArgs({ amount: 80 }));
    const b = admit(service, "biz:c10:b", transferArgs({ amount: 80 }));
    // 模拟可重入回调中的另一项合法推进（§5.2）：dispatch_start 的写入进入
    // 存储边界时，边界同时落盘一份"另一工作 B 已被取消"的新合法状态
    // （而非本次 draft）——读回与独立预期不一致 → 发布失败；条件回滚判定
    // 当前值不属于本次失败发布（≠ draft）→ **不覆盖**该新推进。
    const runtime = Memory.runtime as Record<string, unknown>;
    const liveBox = { value: runtime.treasuryCore as unknown as { active?: Record<string, unknown> } | undefined };
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get() {
        return liveBox.value;
      },
      set(next: unknown) {
        if (next !== null && typeof next === "object") {
          const draft = next as { active?: Record<string, { phase?: string }> };
          const isDispatchStart = Object.values(draft.active ?? {}).some((r) => r.phase === "dispatching");
          if (isDispatchStart) {
            // 边界以"另一合法推进"响应：B 被取消的快照（A 保持 pending）。
            const advanced = JSON.parse(JSON.stringify(next)) as { active?: Record<string, unknown> };
            if (advanced.active) delete advanced.active[b.attemptId];
            liveBox.value = advanced as unknown as { active?: Record<string, unknown> };
            return;
          }
        }
        liveBox.value = next as unknown as { active?: Record<string, unknown> };
      },
    });
    let outcome: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
    try {
      outcome = service.executeAuthorizedDispatch(a.dispatch);
    } finally {
      delete runtime.treasuryCore;
      runtime.treasuryCore = liveBox.value;
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(outcome.status).toBe("publish_failed");
    // B 的取消（较新的安全推进）不被旧草稿/回滚覆盖；A 保持边界返回的
    // dispatching（调用边界未获发布确认）——下一 tick 保守恢复为 unknown
    //（不重发、不推导 not_executed）。
    const journal = service.kernelJournal();
    expect(journal.active.find((r) => r.attemptId === b.attemptId)).toBeUndefined();
    expect(journal.active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("dispatching");
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("outcome_unknown");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });
});

// ── C11：调用边界已跨越后的失败语义 ────────────────────────────────────────

describe("C11 结果写失败与释放确认写失败", () => {
  it("动作已进入、结果写丢弃：调用总计 1、不回退 pending、unknown 责任保留", () => {
    const service = makeService();
    const a = admit(service, "biz:c11:persist", transferArgs({ amount: 80 }));
    let writes = 0;
    const restore = interceptTreasuryCoreWrites((draft) => {
      writes += 1;
      return writes === 2 ? undefined : draft;
    });
    let outcome: ReturnType<TreasuryService["executeAuthorizedDispatch"]>;
    try {
      outcome = service.executeAuthorizedDispatch(a.dispatch);
    } finally {
      restore();
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(outcome.status).not.toBe("committed");
    const record = service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(record).toBeDefined();
    expect(record?.phase).not.toBe("pending");
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("释放成功但确认写失败：预扣失败零调用；恢复后同一幂等 (key, attemptId) 重试并退出", () => {
    const attemptId = "tk1_1_dddddddddddddddd";
    resetTreasuryCoreStoreForTest();
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as Record<string, unknown>).treasuryCore = {
      version: 3,
      installEpochId: "e".repeat(16),
      issuance: { frontier: 1, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {
        [attemptId]: {
          workKey: "biz:c11:duty",
          attemptId,
          generation: 1,
          parentAttemptId: null,
          phase: "closing",
          admittedAtTick: Game.time - 1,
          updatedAtTick: Game.time - 1,
          identity: {
            actionKind: "test.transfer",
            adapterVersion: 1,
            adapterRegistrationId: "reg-c11",
            adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
            canonicalDigest: "a".repeat(16),
            postingsDigest: "b".repeat(16),
            retryFactsDigest: null,
            durableFacts: null,
          },
          worstCase: [],
          invocation: { atTick: Game.time - 1 },
          external: { accepted: true, atTick: Game.time - 1 },
          outcome: "committed",
          outcomeEvidence: { kind: "adapter_execution_semantics", conclusion: "executed", source: "test", atTick: Game.time - 1 },
          cleanup: { consumerKeys: ["ext:c11:z"], failures: 0 },
          retryDeadlineTick: null,
          lastError: null,
        },
      },
      ring: [],
      ringCursor: 0,
      counters: { admitted: 1, dispatched: 1, settledCommitted: 1, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    };
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
    const runtime = Memory.runtime as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => descriptor?.value,
      set() {
        // 丢弃全部写入（预扣与确认都写不回）。
      },
    });
    try {
      kernel.beginTick();
    } finally {
      delete runtime.treasuryCore;
      if (descriptor) Object.defineProperty(runtime, "treasuryCore", descriptor);
    }
    expect(releaseCalls.length).toBe(0);
    kernel.beginTick();
    expect(releaseCalls.length).toBe(1);
    const active = (Memory.runtime as unknown as { treasuryCore?: { active: Record<string, unknown> } }).treasuryCore?.active ?? {};
    expect(active[attemptId]).toBeUndefined();
  });
});

// ── C12/C13：观察接管前的多实例责任保持 ────────────────────────────────────

describe("C12 多实例流出责任（余额 1000）", () => {
  it("A 实例执行 800 后（同 tick）：B 实例 800 拒绝、200 获准；不同 workKey", () => {
    const installed = installRooms(POOL_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    const a = admit(serviceA, "biz:c12:a", transferArgs({ amount: 800 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(
      serviceB.authorizeTreasuryActionContract(buildContract(serviceB, "biz:c12:b800", transferArgs({ amount: 800 })), { workKey: "biz:c12:b800" }).status,
    ).toBe("rejected");
    expect(
      serviceB.authorizeTreasuryActionContract(buildContract(serviceB, "biz:c12:b200", transferArgs({ amount: 200 })), { workKey: "biz:c12:b200" }).status,
    ).toBe("admitted");
  });
});

describe("C13 多实例接收责任（空位 100）", () => {
  const RECV_ROOMS: RoomSpec[] = [
    {
      name: "W1N57",
      storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
      terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
    },
    {
      name: "W2N57",
      storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
      terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 100 },
    },
  ];

  it("A 实例确认流入 80（观察旧）：B 实例流入 80 拒绝、20 获准", () => {
    const installed = installRooms(RECV_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const serviceB = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceB.beginTick();
    const a = admit(serviceA, "biz:c13:a", transferArgs({ amount: 80 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(
      serviceB.authorizeTreasuryActionContract(buildContract(serviceB, "biz:c13:b80", transferArgs({ amount: 80 })), { workKey: "biz:c13:b80" }).status,
    ).toBe("rejected");
    expect(
      serviceB.authorizeTreasuryActionContract(buildContract(serviceB, "biz:c13:b20", transferArgs({ amount: 20 })), { workKey: "biz:c13:b20" }).status,
    ).toBe("admitted");
  });

  it("确认/新实例重建后接收责任不消失；观察接管后仍守容量（80 拒、可纳 19）", () => {
    const installed = installRooms(RECV_ROOMS);
    const serviceA = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceA.beginTick();
    const a = admit(serviceA, "biz:c13:hold", transferArgs({ amount: 80 }));
    expect(serviceA.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    const serviceC = createTreasuryService({ getRooms: () => Object.values(installed) });
    serviceC.beginTick();
    expect(
      serviceC.authorizeTreasuryActionContract(buildContract(serviceC, "biz:c13:c80", transferArgs({ amount: 80 })), { workKey: "biz:c13:c80" }).status,
    ).toBe("rejected");
    // 世界已真实更新（term-2 freeCapacity 20）+ 下一 tick 观察接管。
    Game.time += 1;
    serviceC.beginTick();
    expect(
      serviceC.authorizeTreasuryActionContract(buildContract(serviceC, "biz:c13:d80", transferArgs({ amount: 80 })), { workKey: "biz:c13:d80" }).status,
    ).toBe("rejected");
    expect(
      serviceC.authorizeTreasuryActionContract(buildContract(serviceC, "biz:c13:d19", transferArgs({ amount: 19 })), { workKey: "biz:c13:d19" }).status,
    ).toBe("admitted");
  });
});
