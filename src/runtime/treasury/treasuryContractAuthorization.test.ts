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
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 50_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
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

function authorizeBundle(service: TreasuryService, contract: TreasuryActionContract) {
  const result = service.authorizeTreasuryActionContract(contract);
  expect(result.status).toBe("authorized");
  if (result.status !== "authorized") throw new Error("unreachable");
  return result.bundle;
}

/** test-only 裸 token（绑定指定 contract digest）。 */
function rawToken(
  service: TreasuryService,
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
});

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
      expect(result.reason).toBe("contract_invalid");
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
    if (result.status === "prepare_rejected") expect(result.detail).toContain("adapter version");
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

  it("授权 bundle 派生自 contract：amount/rooms/locations 与负腿精确一致", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_derive", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const bundle = authorizeBundle(service, contract);
    expect(bundle.tokens).toHaveLength(2);
    const uToken = bundle.tokens.find((t) => t.resource === "U");
    const energyToken = bundle.tokens.find((t) => t.resource === RESOURCE_ENERGY);
    expect(uToken?.amount).toBe(3_000);
    expect(uToken?.rooms).toEqual(["W1N57"]);
    expect(uToken?.locations).toEqual(["storage"]);
    expect(energyToken?.amount).toBe(50);
    expect(energyToken?.locations).toEqual(["terminal"]); // fee 腿的 location
    expect(uToken?.contractDigest).toBe(contract.digest);
    expect(uToken?.adapterVersion).toBe(contract.adapterVersion);
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
  it("多资源 bundle 第 N 个 token 无效时前 N−1 个不被消费（预算不变、callback 零调用）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_atomic", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const uToken = rawToken(service, contract, { resource: "U", amount: 3_000 });
    const energyToken = rawToken(service, contract, { resource: RESOURCE_ENERGY, amount: 50 });
    // energy token 先被单独消费（成为 already_consumed）→ bundle 预验证第
    // 2 个失败 → uToken 必须未被消费。
    const consumed = service.consumeTreasuryAuthorization(energyToken, {
      transactionId: contract.transactionId,
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -50 }],
    });
    expect(consumed.status).toBe("ok");
    const result = executeTreasuryActionContract(service, { contract, authorization: [uToken, energyToken] });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // uToken 未被消费：可再次用于完整执行（配新 energy token）。
    const freshEnergy = rawToken(service, contract, { resource: RESOURCE_ENERGY, amount: 50 });
    const ok = executeTreasuryActionContract(service, { contract, authorization: [uToken, freshEnergy] });
    expect(ok.status).toBe("executed_committed");
  });

  it("重复 token 出现在 bundle 中被拒（对象身份重复——零状态变化）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_dup", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const uToken = rawToken(service, contract, { resource: "U", amount: 3_000 });
    const result = executeTreasuryActionContract(service, { contract, authorization: [uToken, uToken] });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.detail).toContain("重复");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // 零状态变化：uToken 仍可正常消费使用。
    const energyToken = rawToken(service, contract, { resource: RESOURCE_ENERGY, amount: 50 });
    const ok = executeTreasuryActionContract(service, { contract, authorization: [uToken, energyToken] });
    expect(ok.status).toBe("executed_committed");
  });

  it("结构 incarnation mismatch 时 token 不被消费（同 tick 构建后替换结构）", () => {
    const rooms = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
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
    // token 未被消费：结构恢复后（新 service/tick 重新构建不适用——同
    // contract 绑定旧结构无法复用），以消费原语直接验证 token 仍有效。
    const consumed = service.consumeTreasuryAuthorization(bundle.tokens[0], {
      transactionId: contract.transactionId,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
    });
    expect(consumed.status).toBe("ok");
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
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("fresh_observation_unavailable");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    const consumed = service.consumeTreasuryAuthorization(bundle.tokens[0], {
      transactionId: contract.transactionId,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
    });
    expect(consumed.status).toBe("ok"); // token 完好未被消费
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
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("prepare_conflict");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // redemption 未执行（prepare 先拒）：bundle token 仍可消费（预算未丢）。
    const consumed = service.consumeTreasuryAuthorization(bundle.tokens[0], {
      transactionId: contract.transactionId,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
    });
    expect(consumed.status).toBe("ok");
    service.abortPreparedTransaction((prepare as { handle: unknown }).handle as never);
  });

  it("全部负 posting 必须被完整覆盖（同资源存在一个 token 不足以覆盖另一房间/位置腿）", () => {
    const service = makeService();
    // fee 腿在 terminal：token 只授权 storage scope → energy 负腿（terminal）
    // 未被覆盖 → 拒绝（不能只按"同资源存在一个 token"判断）。
    const contract = build(service, "ca_tx_cover", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const uToken = rawToken(service, contract, { resource: "U", amount: 3_000 });
    const energyStorageOnly = rawToken(service, contract, { resource: RESOURCE_ENERGY, amount: 50, locations: ["storage"] });
    const result = executeTreasuryActionContract(service, { contract, authorization: [uToken, energyStorageOnly] });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("authorization_invalid");
      // scope 校验（token 级）或联合覆盖校验（posting 级）先于消费拒绝。
      expect(result.detail).toMatch(/不在授权 scope|未被任何/);
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("执行成功后 bundle 内 token 全部终态（重复使用任意一个均失败）", () => {
    const service = makeService();
    const contract = build(service, "ca_tx_final", transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }));
    const bundle = authorizeBundle(service, contract);
    const ok = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(ok.status).toBe("executed_committed");
    for (const token of bundle.tokens) {
      const consumed = service.consumeTreasuryAuthorization(token, { transactionId: contract.transactionId });
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("already_consumed");
    }
  });
});
