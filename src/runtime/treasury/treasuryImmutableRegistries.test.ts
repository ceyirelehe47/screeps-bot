/**
 * 第十一轮 3.13.2/3.13.3：immutable adapter/policy registry 确定性测试。
 *
 * adapter registry：
 * - 注册快照固定函数引用——调用方事后修改原对象不影响 registry 执行/
 *   reconciliation；
 * - 同 kind+version 不同实现拒绝、同实现幂等、更低 version 拒绝、更高
 *   version 演进使旧 contract 失效（registration identity）；
 * - seal 后动态注册拒绝；读 API 返回冻结视图不泄漏内部 record；
 * - adapter 函数异常边界（validate/derivePostings 抛错 → 结构化 contract
 *   拒绝零 callback；reconcile 抛错 → capability 签发拒绝且 authority 隔离）。
 *
 * policy registry：
 * - 注册快照固定 evaluate 引用；同 ID+version 不同实现拒绝；policyVersion
 *   非法拒绝；seal 后注册拒绝；
 * - decision digest 由 Treasury 计算（不同决策 → 不同 digest/policyIdentity）；
 *   evaluate 抛错与非法 decision 字段结构化 fail closed；
 * - registration 变化（换 version 重注册）使旧 bundle 失效。
 */
import { createTreasuryService, setTreasuryRedemptionFaultInjectorForTest } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  findTreasuryActionAdapter,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  sealTreasuryAdapterRegistryForProduction,
  unsealTreasuryAdapterRegistryForTest,
  unregisterTreasuryActionAdapterForTest,
  type TreasuryActionAdapter,
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import {
  clearTreasuryPolicyResolversForTest,
  makeFixedReserveTreasuryPolicy,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
  sealTreasuryPolicyRegistryForProduction,
  unsealTreasuryPolicyRegistryForTest,
  type TreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 50_000, Z: 1_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
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

function build(service: TreasuryTestService, transactionId: string, args: TreasuryTestTransferArgs): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
}

function authorize(service: TreasuryTestService, contract: TreasuryActionContract) {
  const result = service.authorizeTreasuryActionContract(contract);
  expect(result.status).toBe("authorized");
  if (result.status !== "authorized") throw new Error("unreachable");
  return result.bundle;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  setTreasuryRedemptionFaultInjectorForTest(null);
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  // policy 槽每用例确定起点（immutable registry 下用例末尾恢复会因版本单调约束失败）。
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
    const bundle = authorize(service, contract);
    const executed = executeTreasuryActionContract(service, { contract, authorization: bundle });
    // registry 按注册时快照执行：副作用计数 +1、结果 ok（篡改后的 false 被无视）。
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    expect(executed.status).toBe("executed_committed");
  });

  it("注册后修改原对象的 reconcile 不影响 registry（capability 结论仍来自注册快照）", () => {
    const adapter = makeTreasuryTestTransferAdapter("observed_not_executed");
    unregisterTreasuryActionAdapterForTest("test.transfer");
    registerTreasuryActionAdapter(adapter);
    (adapter as unknown as { reconcile: unknown }).reconcile = () => "observed_committed" as const;
    const service = makeService();
    const contract = build(service, "tx-immutable-reconcile", { ...transferArgs(), outcome: "throw" });
    const bundle = authorize(service, contract);
    expect(() => executeTreasuryActionContract(service, { contract, authorization: bundle })).toThrow();
    // post-fault observation：推进 tick 并建立新 shared observation。
    Game.time += 2;
    service.beginTick();
    const capability = service.issueTreasuryReconciliationCapability({ transactionId: "tx-immutable-reconcile" });
    expect(capability.status).toBe("issued");
    if (capability.status !== "issued") throw new Error("unreachable");
    // 篡改后的 observed_committed 被无视——结论来自注册快照的 observed_not_executed。
    expect(capability.capability.conclusion).toBe("observed_not_executed");
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

  it("更高 version 演进后旧 contract 失效（version + registration identity）", () => {
    const service = makeService();
    const contract = build(service, "tx-evolve", transferArgs());
    const bundle = authorize(service, contract);
    const upgraded = registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), version: 2 });
    expect(upgraded).toEqual({ status: "registered" });
    const executed = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") {
      expect(executed.reason).toBe("contract_invalid");
      expect(executed.detail).toContain("v1");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("test-only 同 version 替换产生新 registrationId——旧 contract 失效", () => {
    const service = makeService();
    const contract = build(service, "tx-replace", transferArgs());
    const bundle = authorize(service, contract);
    const oldRegistrationId = contract.adapterRegistrationId;
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
    const current = findTreasuryActionAdapter("test.transfer");
    expect(current?.registrationId).not.toBe(oldRegistrationId);
    const executed = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") {
      expect(executed.detail).toContain("registration identity");
    }
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
    // 内部装配元数据（registryGeneration/registeredAtTick）不在公开视图上。
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

  it("reconcile 抛错 → capability 签发拒绝且 authority 保持隔离", () => {
    const throwing: TreasuryActionAdapter = {
      ...makeTreasuryTestTransferAdapter(),
      kind: "test.throwing-reconcile",
      reconcile: (): never => {
        throw new Error("reconcile boom");
      },
    };
    registerTreasuryActionAdapter(throwing);
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.throwing-reconcile",
      transactionId: "tx-throw-reconcile",
      args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W1N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 100, outcome: "throw" },
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("unreachable");
    const bundle = authorize(service, built.contract);
    expect(() => executeTreasuryActionContract(service, { contract: built.contract, authorization: bundle })).toThrow();
    // 推进 tick 并作废 outstanding handle（execution unknown 锁定 + post-fault observation）。
    Game.time += 2;
    service.beginTick();
    const capability = service.issueTreasuryReconciliationCapability({ transactionId: "tx-throw-reconcile" });
    expect(capability.status).toBe("rejected");
    if (capability.status === "rejected") {
      expect(capability.reason).toBe("reconciler_fault");
      expect(capability.detail).toContain("reconciler 抛错");
    }
    // authority 保持隔离：quarantine 中的同 id 不得重新执行（execution unknown 锁定）。
    const again = executeTreasuryActionContract(service, { contract: built.contract, authorization: bundle });
    expect(again.status).toBe("prepare_rejected");
  });

  it("execution 与 reconciliation 使用同一 registration identity（contract 绑定）", () => {
    const service = makeService();
    const contract = build(service, "tx-same-record", transferArgs());
    const registry = findTreasuryActionAdapter("test.transfer");
    expect(registry?.registrationId).toBe(contract.adapterRegistrationId);
    const verify = authorize(service, contract);
    void verify;
    // verification 成功即证明 contract 与 registry 的 registration identity 一致。
    expect(contract.adapterRegistrationId.length).toBeGreaterThan(0);
  });
});

// ── policy registry：不可变 + Treasury-computed digest ───────────────────────

describe("immutable policy registry", () => {
  it("注册后修改原 resolver 对象不影响 authority（evaluate 引用固定）", () => {
    const resolver = makeFixedReserveTreasuryPolicy(1_000);
    registerTreasuryPolicyResolver(resolver);
    // 同对象重注册幂等（相同 evaluate 引用）。
    expect(registerTreasuryPolicyResolver(resolver)).toEqual({ status: "registered" });
    (resolver as unknown as { evaluate: unknown }).evaluate = () => ({ withhold: 0, strategicReserve: 0, emergencyOverride: false });
    const service = makeService();
    // 存量 100_000：注册快照扣 1_000 reserve → 99_500 的授权不足；篡改后的
    // 0 reserve 会让 99_500 通过——快照生效则拒绝。
    const contract = build(service, "tx-policy-snapshot", { ...transferArgs(), amount: 99_500 });
    const result = service.authorizeTreasuryActionContract(contract);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("insufficient_amount");
  });

  it("同 policyId+version 不同实现被拒；policyVersion 非法拒绝", () => {
    // 同 ID（treasury.test.fixed-reserve）+ 同 version：不同 evaluate 引用拒绝。
    registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
    const sameIdDiffImpl = registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(2_000));
    expect(sameIdDiffImpl.status).toBe("rejected");
    if (sameIdDiffImpl.status === "rejected") expect(sameIdDiffImpl.detail).toContain("不同实现");
    // policyVersion 非法（0 / 非整数）。
    clearTreasuryPolicyResolversForTest();
    expect(registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyVersion: 0 }).status).toBe("rejected");
    expect(registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyVersion: 1.5 }).status).toBe("rejected");
    // 恢复默认（后续用例）。
  });

  it("evaluate 抛错 → policy_fault 结构化 fail closed（无 bundle 签发）", () => {
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
    const result = service.authorizeTreasuryActionContract(contract);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBe("authorization_policy_violation");
      expect(result.detail).toContain("policy_fault");
    }
  });

  it("decision 字段非法（负 strategicReserve / 非布尔 override）拒绝", () => {
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.negative",
      policyVersion: 1,
      evaluate: () => ({ withhold: 0, strategicReserve: -5, emergencyOverride: false }),
    });
    const service = makeService();
    const contract = build(service, "tx-policy-negative", transferArgs());
    const result = service.authorizeTreasuryActionContract(contract);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("strategicReserve");
    // 非布尔 emergencyOverride。
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.badoverride",
      policyVersion: 1,
      evaluate: () => ({ withhold: 0, strategicReserve: 0, emergencyOverride: "yes" as unknown as boolean }),
    });
    const result2 = service.authorizeTreasuryActionContract(contract);
    expect(result2.status).toBe("rejected");
    if (result2.status === "rejected") expect(result2.detail).toContain("emergencyOverride");
  });

  it("不同决策的 policy registration 使旧 bundle 失效（decision digest 变化）", () => {
    const service = makeService();
    const contract = build(service, "tx-policy-decision-change", transferArgs());
    const bundle = authorize(service, contract);
    // 同 policyId 不同 version + 不同决策（withhold 500）——新 registration。
    registerTreasuryPolicyResolver({
      policyId: "treasury.test.no-reserve",
      policyVersion: 2,
      evaluate: () => ({ withhold: 500, strategicReserve: 500, emergencyOverride: false }),
    });
    const executed = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") {
      expect(executed.detail).toContain("policy_invalidated");
    }
  });

  it("policy registration 变化（换 version 重注册）使旧 bundle 失效", () => {
    const service = makeService();
    const contract = build(service, "tx-policy-invalidated", transferArgs());
    const bundle = authorize(service, contract);
    // 换 version 重新注册（合法演进——registrationId 变化）。
    registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyVersion: 2 });
    const executed = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") {
      expect(executed.reason).toBe("authorization_invalid");
      expect(executed.detail).toContain("policy_invalidated");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("seal 后动态注册拒绝", () => {
    sealTreasuryPolicyRegistryForProduction();
    const sealed = registerTreasuryPolicyResolver({ ...makeNoReserveTreasuryPolicy(), policyId: "treasury.test.sealed", policyVersion: 1 });
    expect(sealed.status).toBe("rejected");
    if (sealed.status === "rejected") expect(sealed.detail).toContain("seal");
    unsealTreasuryPolicyRegistryForTest();
  });
});
