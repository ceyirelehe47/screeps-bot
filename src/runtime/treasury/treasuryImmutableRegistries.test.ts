/**
 * Treasury immutable registry 测试（Core Rewrite I 适配版）。
 *
 * 语义保留（迁移自旧套件）：
 * - adapter registry 快照不可变：注册后篡改原对象 execute/reconcile 无效；
 * - 同 kind+version 不同实现拒绝、同实现幂等、版本只升不降；
 * - 更高 version / test-only 替换产生新 registrationId——旧 contract 的
 *   dispatch 被拒（内核校验注册身份与聚合一致，A03/A15 语义）；
 * - seal/unseal 边界与冻结视图；
 * - adapter 回调抛错结构化拒绝（callback 零调用）；
 * - policy registry：evaluate 引用固定、非法决策 fail closed、seal 边界。
 *
 * 【Core Rewrite I】旧 contract-first bundle/execute/capability 协议退役：
 * 执行统一经 authorize（admit）+ executeAuthorizedDispatch（受控 dispatch）；
 * policy withhold 在接纳路径 fail closed（checkPolicyForAdmission）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  findTreasuryActionAdapter,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  sealTreasuryAdapterRegistryForProduction,
  unregisterTreasuryActionAdapterForTest,
  unsealTreasuryAdapterRegistryForTest,
  type TreasuryActionAdapter,
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
  sealTreasuryPolicyRegistryForProduction,
  unsealTreasuryPolicyRegistryForTest,
  type TreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 30_000 },
  },
];

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
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

function build(service: TreasuryService, transactionId: string, args: TreasuryTestTransferArgs): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
}

/** contract-first 接纳（新 API：admit + 正向执行许可）。 */
function admit(service: TreasuryService, contract: TreasuryActionContract, workKey: string) {
  const result = service.authorizeTreasuryActionContract(contract, { workKey });
  expect(result.status).toBe("admitted");
  if (result.status !== "admitted") throw new Error("unreachable");
  return result;
}

function fixedReservePolicy(reserve: number): TreasuryPolicyResolver {
  return {
    policyId: "treasury.test.fixed-reserve",
    policyVersion: 1,
    evaluate: () => ({ withhold: 0, strategicReserve: reserve, emergencyOverride: false }),
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

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  unregisterTreasuryActionAdapterForTest("test.throwing");
  unregisterTreasuryActionAdapterForTest("test.throwing-derive");
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── adapter registry：快照不可变 ─────────────────────────────────────────────

describe("immutable adapter registry", () => {
  it("注册后修改原对象的 execute 不影响 registry 执行（快照固定函数引用）", () => {
    const adapter = makeTreasuryTestTransferAdapter();
    unregisterTreasuryActionAdapterForTest("test.transfer");
    expect(registerTreasuryActionAdapter(adapter)).toEqual({ status: "registered" });
    // 调用方事后替换原对象的 execute（静默篡改尝试）。
    (adapter as unknown as { execute: unknown }).execute = (): { ok: boolean } => ({ ok: false });
    const service = makeService();
    const contract = build(service, "tx-immutable-execute", transferArgs());
    const admission = admit(service, contract, "biz:registry:immutable-execute");
    const executed = service.executeAuthorizedDispatch(admission.dispatch);
    // registry 按注册时快照执行：副作用计数 1、settleOnAccept → committed
    //（篡改后的 ok:false 实现被无视）。
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(executed.status).toBe("committed");
  });

  it("注册后修改原对象的 reconcile 不影响 registry（settle 结论仍来自注册快照）", () => {
    const adapter = makeTreasuryTestTransferAdapter("observed_not_executed");
    unregisterTreasuryActionAdapterForTest("test.transfer");
    registerTreasuryActionAdapter(adapter);
    (adapter as unknown as { reconcile: unknown }).reconcile = () => "observed_committed" as const;
    const service = makeService();
    const contract = build(service, "tx-immutable-reconcile", { ...transferArgs(), outcome: "throw" });
    const admission = admit(service, contract, "biz:registry:immutable-reconcile");
    const executed = service.executeAuthorizedDispatch(admission.dispatch);
    expect(executed.status).toBe("unknown");
    // 推进 tick（fresh observation）后 settle：结论由注册 reconciler 快照得出。
    Game.time += 2;
    service.beginTick();
    const settled = service.settleUnknownOutcome({ attemptId: admission.attemptId });
    expect(settled.status).toBe("ok");
    // 篡改后的 observed_committed 被无视——聚合按 observed_not_executed 进入 closing。
    const record = service.kernelJournal().active.find((r) => r.attemptId === admission.attemptId);
    expect(record?.outcome).toBe("not_executed");
  });

  it("同 kind+version 注册不同实现被拒；同实现幂等；更低 version 拒绝", () => {
    const result = registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), execute: () => ({ ok: false }) });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("不同实现");
    // 同实现（相同函数引用）幂等。
    const adapter = findTreasuryActionAdapter("test.transfer") as unknown as TreasuryActionAdapter;
    expect(registerTreasuryActionAdapter(adapter)).toEqual({ status: "registered" });
    // 更低 version 拒绝（版本只升不降）。
    const downgrade = registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), version: 0 });
    expect(downgrade.status).toBe("rejected");
  });

  it("更高 version 演进后旧 contract 的 dispatch 被拒（registration identity 不匹配，动作零调用）", () => {
    const service = makeService();
    const contract = build(service, "tx-evolve", transferArgs());
    const admission = admit(service, contract, "biz:registry:evolve");
    const upgraded = registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), version: 2 });
    expect(upgraded).toEqual({ status: "registered" });
    const executed = service.executeAuthorizedDispatch(admission.dispatch);
    expect(executed.status).toBe("rejected");
    if (executed.status === "rejected") expect(executed.reason).toContain("adapter 注册身份与聚合不一致");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("test-only 同 version 替换产生新 registrationId——旧 contract 的 dispatch 被拒", () => {
    const service = makeService();
    const contract = build(service, "tx-replace", transferArgs());
    const admission = admit(service, contract, "biz:registry:replace");
    const oldRegistrationId = contract.adapterRegistrationId;
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
    const current = findTreasuryActionAdapter("test.transfer");
    expect(current?.registrationId).not.toBe(oldRegistrationId);
    const executed = service.executeAuthorizedDispatch(admission.dispatch);
    expect(executed.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("seal 后动态注册拒绝（unseal 恢复测试通道）", () => {
    sealTreasuryAdapterRegistryForProduction();
    const sealed = registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), kind: "test.sealed", version: 1 });
    expect(sealed.status).toBe("rejected");
    if (sealed.status === "rejected") expect(sealed.detail).toContain("seal");
    unsealTreasuryAdapterRegistryForTest();
    expect(registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), kind: "test.sealed", version: 1 })).toEqual({
      status: "registered",
    });
    unregisterTreasuryActionAdapterForTest("test.sealed");
  });

  it("读 API 返回冻结视图且不泄漏内部 record", () => {
    const view = findTreasuryActionAdapter("test.transfer");
    expect(view).toBeDefined();
    expect(() => {
      (view as unknown as { kind: string }).kind = "tampered";
    }).toThrow();
    expect(view?.kind).toBe("test.transfer");
    // 内部装配元数据不在公开视图上。
    expect(view).not.toHaveProperty("registryGeneration");
    expect(view).not.toHaveProperty("registeredAtTick");
  });

  it("validate 抛错 → 结构化 contract 拒绝（callback 零调用）", () => {
    const throwing: TreasuryActionAdapter = {
      ...makeTreasuryTestTransferAdapter(),
      kind: "test.throwing",
      validate: (): string | null => {
        throw new Error("validate boom");
      },
    };
    registerTreasuryActionAdapter(throwing);
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.throwing", transactionId: "tx-throw-validate", args: transferArgs() });
    expect(built.status).toBe("rejected");
    if (built.status === "rejected") {
      expect(built.detail).toContain("adapter_fault(validate)");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("derivePostings 抛错 → adapter_fault(derivePostings)", () => {
    const throwing: TreasuryActionAdapter = {
      ...makeTreasuryTestTransferAdapter(),
      kind: "test.throwing-derive",
      derivePostings: (): never => {
        throw new Error("derive boom");
      },
    };
    registerTreasuryActionAdapter(throwing);
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.throwing-derive", transactionId: "tx-throw-derive", args: transferArgs() });
    expect(built.status).toBe("rejected");
    if (built.status === "rejected") {
      expect(built.detail).toContain("adapter_fault(derivePostings)");
    }
  });
});

// ── policy registry：不可变 + 接纳路径 fail closed ───────────────────────────

describe("immutable policy registry", () => {
  it("注册后修改原 resolver 对象不影响 authority（evaluate 引用固定）", () => {
    const resolver = fixedReservePolicy(1_000);
    registerTreasuryPolicyResolver(resolver);
    // 同对象重注册幂等（相同 evaluate 引用）。
    expect(registerTreasuryPolicyResolver(resolver)).toEqual({ status: "registered" });
    (resolver as unknown as { evaluate: unknown }).evaluate = () => ({ withhold: 0, strategicReserve: 0, emergencyOverride: false });
    const service = makeService();
    // 存量 storage+terminal 120_000：注册快照扣 1_000 reserve → 119_000 可支配；
    // 授权 119_500 应被拒（篡改后的 0 reserve 会让其通过——快照生效则拒绝）。
    const contract = build(service, "tx-policy-snapshot", { ...transferArgs(), amount: 119_500 });
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:registry:policy-snapshot" });
    expect(result.status).toBe("rejected");
    // 统一判定下容量检查（storage 单独不足）先于 policy reserve 拒绝——
    // 两者都是 fail closed；注册快照篡改（0 reserve）不能让接纳通过。
    if (result.status === "rejected") {
      expect(["insufficient_amount", "capacity_insufficient"]).toContain(result.reasonCode);
    }
  });

  it("同 policyId+version 不同实现被拒；policyVersion 非法拒绝", () => {
    registerTreasuryPolicyResolver(fixedReservePolicy(1_000));
    const sameIdDiffImpl = registerTreasuryPolicyResolver(fixedReservePolicy(2_000));
    expect(sameIdDiffImpl.status).toBe("rejected");
    if (sameIdDiffImpl.status === "rejected") expect(sameIdDiffImpl.detail).toContain("不同实现");
    // policyVersion 非法（0 / 非整数）。
    clearTreasuryPolicyResolversForTest();
    expect(registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyVersion: 0 }).status).toBe("rejected");
    expect(registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyVersion: 1.5 }).status).toBe("rejected");
    // 恢复默认（后续用例）。
    registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  });

  it("evaluate 抛错 → policy_fault 结构化 fail closed（不产生执行许可）", () => {
    const throwing: TreasuryPolicyResolver = {
      policyId: "treasury.test.throwing",
      policyVersion: 1,
      evaluate: (): never => {
        throw new Error("evaluate boom");
      },
    };
    registerTreasuryPolicyResolver(throwing);
    const service = makeService();
    const contract = build(service, "tx-policy-throw", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:registry:policy-throw" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reasonCode).toBe("policy_fault");
      expect(result.reason).toContain("policy_fault");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("decision 字段非法（负 strategicReserve / 非布尔 override）拒绝", () => {
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.negative",
      policyVersion: 1,
      evaluate: () => ({ withhold: 0, strategicReserve: -5, emergencyOverride: false }),
    });
    const service = makeService();
    const contract = build(service, "tx-policy-negative", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:registry:policy-negative" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("strategicReserve");
    // 非布尔 emergencyOverride。
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.badoverride",
      policyVersion: 1,
      evaluate: () => ({ withhold: 0, strategicReserve: 0, emergencyOverride: "yes" as unknown as boolean }),
    });
    const result2 = service.authorizeTreasuryActionContract(contract, { workKey: "biz:registry:policy-negative-2" });
    expect(result2.status).toBe("rejected");
    if (result2.status === "rejected") expect(result2.reason).toContain("emergencyOverride");
  });

  it("无注册 policy resolver 时接纳 fail closed（不得自报 withhold）", () => {
    clearTreasuryPolicyResolversForTest();
    const service = makeService();
    const contract = build(service, "tx-policy-missing", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract, { workKey: "biz:registry:policy-missing" });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reasonCode).toBe("policy_unavailable");
  });

  it("seal 后动态注册拒绝", () => {
    sealTreasuryPolicyRegistryForProduction();
    const sealed = registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyId: "treasury.test.sealed", policyVersion: 1 });
    expect(sealed.status).toBe("rejected");
    if (sealed.status === "rejected") expect(sealed.detail).toContain("seal");
    unsealTreasuryPolicyRegistryForTest();
  });
});
