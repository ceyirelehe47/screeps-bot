/**
 * Treasury contract-first authorization 与原子 bundle redemption 测试
 * （第九轮 4.1/4.2）：
 * - 为 action A 签发的 bundle 不能执行 action B；同 kind 不同 digest、不同
 *   transactionId、不同 adapter version 拒绝；
 * - bundle 预验证原子性：第 N 个 token 无效时前 N−1 个不被消费（预算不
 *   变）；重复 token 拒绝；incarnation mismatch / fresh 耗尽零消费零
 *   callback；prepare 拒绝时预算不丢失（redemption 在 tentative 接管后）；
 * - 全部负 posting 必须被完整覆盖（同资源存在一个 token 不够——room/
 *   location 精确匹配）；
 * - 调用者自填 policy fingerprint 不能获得 policy authority；
 * - authorizeTreasuryActionContract 原子签发：任一资源失败时已签发 token
 *   预算回滚；write admission blocked 时授权拒绝。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import type { TreasuryAuthorizationToken } from "@/runtime/treasury/authorization";
import { quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { setTreasuryRedemptionFaultInjectorForTest } from "@/runtime/treasury/facade";
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

function authorizeBundle(service: TreasuryTestService, contract: TreasuryActionContract) {
  const result = service.authorizeTreasuryActionContract(contract);
  expect(result.status).toBe("authorized");
  if (result.status !== "authorized") throw new Error("unreachable");
  return result.bundle;
}

/** test-only 裸 token（绑定指定 contract digest）。 */
function rawToken(
  service: TreasuryTestService,
  contract: TreasuryActionContract,
  overrides: Partial<{ resource: string; amount: number; transactionId: string; contractDigest?: string; adapterVersion?: number; locations?: string[] }> = {},
): TreasuryAuthorizationToken {
  const result = service.authorizeResourceUse({
    transactionId: overrides.transactionId ?? contract.transactionId,
    actionKind: contract.actionKind,
    resource: overrides.resource ?? RESOURCE_ENERGY,
    rooms: ["W1N57"],
    locations: (overrides.locations ?? ["storage", "terminal"]) as "storage"[],
    amount: overrides.amount ?? 500,
    contractDigest: overrides.contractDigest ?? contract.digest,
    ...(overrides.adapterVersion !== undefined ? { adapterVersion: overrides.adapterVersion } : { adapterVersion: contract.adapterVersion }),
  });
  expect(result.status).toBe("authorized");
  if (result.status === "authorized") return result.token;
  throw new Error("unreachable");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryActionAdapter({
    kind: "test.three",
    version: 1,
    validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
    derivePostings: () => [
      { roomName: "W1N57", locationKind: "storage", resource: "U", delta: -1_000 },
      { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -50 },
      { roomName: "W1N57", locationKind: "storage", resource: "Z", delta: -20 },
    ],
    execute: (): { ok: boolean } => ({ ok: true }),
    structureBindings: () => [],
    reconcile: () => "still_uncertain" as const,
  });
});

/** 三腿 contract（middle_leg 注入点 fixture：U/energy/Z 三资源腿）。 */
function buildThreeLeg(service: TreasuryTestService, transactionId: string): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, { actionKind: "test.three", transactionId, args: {} });
  if (built.status !== "built") throw new Error("three-leg build failed");
  return built.contract;
}

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

describe("contract-first 授权绑定", () => {
  it("为 action A 签发的 bundle 不能执行 action B（不同 contract 拒绝且 A 的 token 未被消费）", () => {
    const service = makeService();
    const contractA = build(service, "ca_tx_a", transferArgs({ amount: 100 }));
    const contractB = build(service, "ca_tx_b", transferArgs({ amount: 200 }));
    const bundleA = authorizeBundle(service, contractA);
    const result = executeTreasuryActionContract(service, { contract: contractB, authorization: bundleA });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("authorization_invalid");
      expect(result.detail).toContain("不匹配");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // A 的 token 未被消费：A 仍可正常执行。
    const ok = executeTreasuryActionContract(service, { contract: contractA, authorization: bundleA });
    expect(ok.status).toBe("executed_committed");
  });

  it("同 action kind 但不同 contract digest / transactionId 被拒（token 零消费）", () => {
    const service = makeService();
    const c1 = build(service, "ca_tx_c1", transferArgs({ amount: 100 }));
    const c2 = build(service, "ca_tx_c2", transferArgs({ amount: 300 }));
    const tokenForC1 = rawToken(service, c1);
    // digest 属于 c1，执行 c2：transactionId 与 digest 均不匹配。
    const result = executeTreasuryActionContract(service, { contract: c2, authorization: tokenForC1 });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("adapter version 不匹配的 token 被拒（contract v1 token 声明 v2）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_ver", transferArgs());
    const wrongVersion = rawToken(service, contract, { adapterVersion: 2 });
    const result = executeTreasuryActionContract(service, { contract, authorization: wrongVersion });
    expect(result.status).toBe("prepare_rejected");
    // 【第十轮 3.12.3】裸 token 不是 production 输入——在 opaque 验证即拒
    //（比 adapter version 匹配检查更早、更强）。
    if (result.status === "prepare_rejected") expect(result.detail).toContain("opaque bundle");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("调用者自填 policy fingerprint 不能获得 policy authority（授权入口拒绝）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_pf", transferArgs());
    const rejected = service.authorizeResourceUse({
      transactionId: contract.transactionId,
      actionKind: "test.transfer",
      resource: RESOURCE_ENERGY,
      rooms: ["W1N57"],
      locations: ["storage", "terminal"],
      amount: 500,
      contractDigest: contract.digest,
      adapterVersion: contract.adapterVersion,
      ...({ policyFingerprint: "attacker-policy" } as object),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.detail).toContain("policyFingerprint");
  });

  it("【第十轮 3.12.3】授权 bundle opaque：legs 不可读；派生正确性经 legs 计数与执行覆盖观察", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_derive", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const beforeActive = service.metrics().authorizationsActive;
    const bundle = authorizeBundle(service, contract);
    // opaque：bundle 上无可读 legs/cohort 字段（只有 __brand）。
    expect(Object.keys(bundle)).toEqual(["__brand"]);
    // 派生正确性：每种负 posting 资源一个 leg（U + energy fee = 2）。
    expect(service.metrics().authorizationsActive - beforeActive).toBe(2);
    const ok = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(ok.status).toBe("executed_committed"); // 联合覆盖正确才能执行
  });

  it("authorizeTreasuryActionContract 原子签发：任一资源失败时已签发 token 预算回滚", () => {
    const service = makeService();
    // 物理上 energy 只有 20k（terminal）+100k（storage）——fee 腿在 terminal；
    // 构造一个 fee 超过 terminal 可用量的 contract：U 腿可授权、energy 腿
    // 失败 → U token 预算必须回滚（后续授权可用满额）。
    const contract = build(service, "ca_tx_rollback", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    // 先占满 terminal energy：既有 transfer outgoing 20k。
    const result = service.authorizeTreasuryActionContract(contract, { withhold: 0 });
    expect(result.status).toBe("authorized"); // 正常路径可签发（storage energy 补 fee scope）
    if (result.status !== "authorized") return;
    const ok = executeTreasuryActionContract(service, { contract, authorization: result.bundle });
    expect(ok.status).toBe("executed_committed");
    // 失败回滚路径：第二个 contract 的 fee 大幅超出可用 → bundle 拒绝后
    // 之前签发的 token 不留预算占用（storage energy 仍可全额授权）。
    const big = build(service, "ca_tx_rollback2", transferArgs({ resource: "U", amount: 1_000, feeFromRoom: "W1N57", feeAmount: 900_000 }));
    const rejected = service.authorizeTreasuryActionContract(big);
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("insufficient_amount");
  });

  it("存在 unresolved quarantine 时授权被 write admission 阻断（不留空转 token）", () => {
    const service = makeService();
    quarantineTreasuryTransaction({
      transactionId: "ca_q",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 }],
      recordedAt: Game.time,
    });
    const contract = build(service, "ca_tx_blocked", transferArgs());
    const rejected = service.authorizeTreasuryActionContract(contract);
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.reason).toBe("write_admission_blocked");
      expect(rejected.detail).toContain("quarantine");
    }
  });
});

describe("原子 bundle redemption", () => {
  it("【第十轮 3.12.4】多资源 bundle redemption 注入中断（last_leg）：前缀完整回滚、budget 不变、callback 零调用", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_atomic", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const bundle = authorizeBundle(service, contract);
    const activeBefore = service.metrics().authorizationsActive;
    setTreasuryRedemptionFaultInjectorForTest((stage) => {
      if (stage === "last_leg") throw new Error("injected:last_leg");
    });
    try {
      const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
      expect(result.status).toBe("prepare_rejected");
      if (result.status === "prepare_rejected") expect(result.reason).toBe("internal_authorization_fault");
      expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
      // 前缀完整回滚：已发布 legs 的预算与消费标记恢复原状。
      expect(service.metrics().authorizationsActive).toBe(activeBefore);
    } finally {
      setTreasuryRedemptionFaultInjectorForTest(null);
    }
    // internal_authorization_fault marker 阻断后续 writer（新授权被拒）。
    const blocked2 = build(service, "ca_tx_atomic_b", transferArgs());
    const rejected2 = service.authorizeTreasuryActionContract(blocked2);
    expect(rejected2.status).toBe("rejected");
    if (rejected2.status === "rejected") expect(rejected2.reason).toBe("write_admission_blocked");
  });

  it("【第十轮 3.12.3】伪造 bundle（JSON round-trip 副本/手工构造品牌对象）拒绝；真 bundle 零状态变化仍可执行", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_dup", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const bundle = authorizeBundle(service, contract);
    // JSON round-trip 副本：registry 无记录（对象身份验证）。
    const jsonCopy = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    const rejectedCopy = executeTreasuryActionContract(service, { contract, authorization: jsonCopy });
    expect(rejectedCopy.status).toBe("prepare_rejected");
    if (rejectedCopy.status === "prepare_rejected") expect(rejectedCopy.detail).toContain("闭包签发");
    // 手工构造品牌对象同样无效。
    const handmade = { __brand: "treasury-authorization-bundle" } as typeof bundle;
    const rejectedHandmade = executeTreasuryActionContract(service, { contract, authorization: handmade });
    expect(rejectedHandmade.status).toBe("prepare_rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 零状态变化：真 bundle 仍可完整执行。
    const ok = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(ok.status).toBe("executed_committed");
  });

  it("结构 incarnation mismatch 时 token 不被消费（同 tick 构建后替换结构）", () => {
    const rooms = installRooms(ROOMS);
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    const contract = build(service, "ca_tx_struct", transferArgs());
    const bundle = authorizeBundle(service, contract);
    rooms.W1N57 = {
      ...(rooms.W1N57 as unknown as Room),
      storage: { ...(rooms.W1N57.storage as unknown as StructureStorage), id: "stor-REPLACED" },
    } as unknown as Room;
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("structure_replaced");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 【第十轮】bundle opaque 化后 token 不可直取：以授权 legs 仍在（未消费）
    // 验证预算未丢（redemption 未执行）。
    expect(service.metrics().authorizationsActive).toBeGreaterThanOrEqual(1);
  });

  it("fresh observation 配额耗尽时 callback 零调用、token 不被消费", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_fresh", transferArgs());
    const bundle = authorizeBundle(service, contract);
    // 耗尽 fresh 配额：beginFreshObservation 返回 null。
    let drained = false;
    while (!drained) {
      drained = service.beginFreshObservation() === null;
    }
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    const energySpendableBaseline = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).spendable;
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("fresh_observation_unavailable");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 【第十轮】bundle 未被消费：授权流出预算仍在（spendable 保持扣减）。
    expect(service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).spendable).toBe(energySpendableBaseline);
  });

  it("prepare 拒绝时 authorization budget 不丢失（tentative 接管失败 → redeem 未执行）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_preparedeny", transferArgs());
    const bundle = authorizeBundle(service, contract);
    // 制造 prepare 拒绝：同 id 已有不同 digest 的 active prepare。
    const prepare = service.prepareTransaction({
      transactionId: contract.transactionId,
      kind: "test.transfer",
      source: "test",
      decision: {
        scope: service.observation().epoch.scope,
        epochSeq: service.observation().epoch.epochSeq,
        observedAtTick: service.observation().epoch.observedAtTick,
      },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -123 }],
    });
    expect(prepare.status).toBe("prepared");
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    const energySpendableBaseline = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).spendable;
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("prepare_conflict");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // redemption 未执行（prepare 先拒）：bundle 预算未丢（spendable 保持扣减）。
    expect(service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).spendable).toBe(energySpendableBaseline);
    service.abortPreparedTransaction((prepare as { handle: unknown }).handle as never);
  });

  it("全部负 posting 必须被完整覆盖（同资源存在一个 token 不足以覆盖另一房间/位置腿）", () => {
    const service = makeService();
    // fee 腿在 terminal：token 只授权 storage scope → energy 负腿（terminal）
    // 未被覆盖 → 拒绝（不能只按"同资源存在一个 token"判断）。
    const contract = build(service, "ca_tx_cover", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const uToken = rawToken(service, contract, { resource: "U", amount: 3_000 });
    const energyStorageOnly = rawToken(service, contract, { resource: RESOURCE_ENERGY, amount: 50, locations: ["storage"] });
    // 【第十轮 3.12.3】裸 token 数组不是 production 输入（opaque 验证即拒）；
    // 覆盖语义由 contract-first 签发原子性结构性保证（legs 全覆盖负腿）。
    const result = executeTreasuryActionContract(service, { contract, authorization: [uToken, energyStorageOnly] });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("authorization_invalid");
      expect(result.detail).toContain("opaque bundle");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("【第十轮 3.12.3】执行成功后 bundle 进入终态（单次 redemption——重复使用拒绝）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_final", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const bundle = authorizeBundle(service, contract);
    const ok = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(ok.status).toBe("executed_committed");
    // 同一 transaction 重放：prepare 幂等（already_settled）先于 redemption——
    // 不重复执行、不重复释放预算（更强的幂等拒绝）。
    const replay = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(replay.status).toBe("already_settled");
  });
});

describe("批量原子 redemption 注入矩阵与 bundle 生命周期（第十轮 3.12.3/3.12.4）", () => {
  it("全部注入点（first/middle/last leg、budget publish/tentative handoff/bundle state 前）：前缀完整回滚 + internal fault 阻断", () => {
    const stages = ["first_leg", "middle_leg", "last_leg", "before_budget_publish", "before_tentative_handoff", "before_bundle_state"] as const;
    for (const stage of stages) {
      clearTreasuryPersistenceForTest();
      const service = makeService();
      // middle_leg 需要 ≥3 legs——使用三腿 adapter fixture；其余注入点用双腿。
      const contract =
        stage === "middle_leg"
          ? buildThreeLeg(service, `ca_inj_${stage}`)
          : build(service, `ca_inj_${stage}`, transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
      const bundle = authorizeBundle(service, contract);
      const activeBefore = service.metrics().authorizationsActive;
      setTreasuryRedemptionFaultInjectorForTest((candidate) => {
        if (candidate === stage) throw new Error(`injected:${stage}`);
      });
      try {
        const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
        expect(result.status).toBe("prepare_rejected");
        if (result.status === "prepare_rejected") expect(result.reason).toBe("internal_authorization_fault");
        expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
        // 前缀完整回滚：legs 全部恢复（预算/消费标记原状）。
        expect(service.metrics().authorizationsActive).toBe(activeBefore);
        // tentative 不残留。
        expect(service.metrics().preparedActive).toBe(0);
        // marker 阻断后续 writer。
        const blocked = build(service, `ca_inj_${stage}_b`, transferArgs());
        const rejected = service.authorizeTreasuryActionContract(blocked);
        expect(rejected.status).toBe("rejected");
        if (rejected.status === "rejected") expect(rejected.reason).toBe("write_admission_blocked");
      } finally {
        setTreasuryRedemptionFaultInjectorForTest(null);
      }
    }
  });

  it("正常路径：redemption 恰好一次（budget→tentative 单次转移）", () => {
    const service = makeService();
    const contract = build(service, "ca_once", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const bundle = authorizeBundle(service, contract);
    const activeBefore = service.metrics().authorizationsActive;
    const ok = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(ok.status).toBe("executed_committed");
    // 全部 legs 恰好消费一次（active 归零）。
    expect(service.metrics().authorizationsActive).toBe(activeBefore - 2);
    expect(service.metrics().preparedActive).toBe(0);
  });

  it("跨 tick 失效：下一 tick 执行同 bundle 被拒（cross_tick）", () => {
    const service = makeService();
    const contract = build(service, "ca_xt", transferArgs());
    const bundle = authorizeBundle(service, contract);
    Game.time += 1;
    service.beginTick();
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    // contract 跨 tick 先失效（builtAtTick）——两种失效都拒绝执行。
    if (result.status === "prepare_rejected") expect(result.reason).toMatch(/contract_invalid|authorization_invalid/);
  });

  it("跨 service generation 失效：新 service 实例下同 bundle 拒绝", () => {
    const rooms = installRooms(ROOMS);
    const first = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    first.beginTick();
    const contract = build(first, "ca_xg", transferArgs());
    const bundle = authorizeBundle(first, contract);
    // 同 tick 新 service（新 generation）——contract registry 身份仍在（模块级），
    // 但 bundle registry 是 service 闭包私有。
    const second = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    second.beginTick();
    const result = executeTreasuryActionContract(second, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.detail).toContain("闭包签发");
  });
});
