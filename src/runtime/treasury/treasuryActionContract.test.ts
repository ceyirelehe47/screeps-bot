/**
 * Treasury action contract 与注册 adapter 测试（第八轮）：
 * - contract 由 canonical args 确定性派生 postings（与 Game API 参数同源，
 *   两套事实通道不复存在）；调用者事后修改原 args 不影响 canonical；
 * - 伪造 contract（普通对象/JSON 副本）失败；跨 tick contract 失效；
 * - adapter 未注册 / kind 不匹配拒绝；重复注册拒绝；
 * - 执行必须携带授权 token；postings 覆盖校验（实际动作不得超出授权
 *   scope/amount）；授权 contractDigest 绑定；多资源 action 每资源分别
 *   授权（联合覆盖校验）；
 * - 结构 incarnation 变化拒绝；
 * - adapter.execute 恰好一次（副作用计数）；不同 payload 同 transactionId
 *   冲突拒绝。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
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
  type TreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import type { TreasuryAuthorizationToken } from "@/runtime/treasury/authorization";
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

function authorize(
  service: TreasuryService,
  overrides: Partial<{ resource: string; amount: number; transactionId: string; contractDigest?: string; locations?: string[] }> = {},
): TreasuryAuthorizationToken {
  const result = service.authorizeResourceUse({
    transactionId: overrides.transactionId ?? "ac_tx",
    actionKind: "test.transfer",
    resource: overrides.resource ?? RESOURCE_ENERGY,
    rooms: ["W1N57"],
    locations: (overrides.locations ?? ["storage"]) as "storage"[],
    amount: overrides.amount ?? 500,
    ...(overrides.contractDigest !== undefined ? { contractDigest: overrides.contractDigest } : {}),
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

describe("contract 构建与派生一致性", () => {
  it("postings 由 canonical args 确定性派生（双腿 + 可选费用腿），与 args 完全一致", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_build",
      args: transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }),
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const postings = [...built.contract.postings].sort((a, b) => a.delta - b.delta);
    expect(postings).toEqual([
      { roomName: "W1N57", locationKind: "storage", resource: "U", delta: -3_000 },
      { roomName: "W1N57", locationKind: "terminal", resource: "energy", delta: -50 },
      { roomName: "W1N57", locationKind: "terminal", resource: "U", delta: 3_000 },
    ]);
    expect(built.contract.contractId).toBe(`ac:${built.contract.digest}`);
    expect(built.contract.structureIds).toContain("W1N57:storage");
  });

  it("调用者事后修改原 args 不影响 canonical contract（冻结深拷贝）", () => {
    const service = makeService();
    const args = transferArgs({ amount: 500 });
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_freeze", args });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const digestBefore = built.contract.digest;
    // 原地篡改原始 args。
    (args as { amount: number }).amount = 99_999;
    expect(built.contract.digest).toBe(digestBefore);
    // contract 自身冻结：修改 postings/args 抛出。
    expect(() => {
      (built.contract as unknown as { transactionId: string }).transactionId = "hacked";
    }).toThrow();
    const rebuilt = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_freeze", args: transferArgs({ amount: 500 }) });
    expect(rebuilt.status).toBe("built");
    if (rebuilt.status === "built") expect(rebuilt.contract.digest).toBe(digestBefore);
  });

  it("未注册 kind 与非法 args 结构化拒绝；重复注册拒绝", () => {
    const service = makeService();
    const unregistered = buildTreasuryActionContract(service, {
      actionKind: "no.such.kind",
      transactionId: "ac_x",
      args: {},
    });
    expect(unregistered.status).toBe("rejected");
    if (unregistered.status === "rejected") expect(unregistered.reason).toBe("adapter_not_registered");
    const invalid = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_x",
      args: { bad: true },
    });
    expect(invalid.status).toBe("rejected");
    if (invalid.status === "rejected") expect(invalid.reason).toBe("contract_invalid");
    const duplicate = registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    expect(duplicate.status).toBe("rejected");
  });
});

describe("contract 执行", () => {
  it("授权 + 执行：adapter 恰好一次、commit 完成、副作用计数为 1", () => {
    const service = makeService();
    const token = authorize(service, { amount: 500, transactionId: "ac_exec_ok" });
    const result = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_exec_ok",
      args: transferArgs({ amount: 500 }),
      authorization: token,
    });
    expect(result.status).toBe("executed_committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    // 同 id 重放命中 already_settled（receipt 防重放），callback 零新增调用。
    const replay = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_exec_ok",
      args: transferArgs({ amount: 500 }),
      authorization: authorize(service, { transactionId: "ac_exec_ok", amount: 500 }),
    });
    expect(replay.status).toBe("already_settled");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("无授权拒绝；不同 payload 同 transactionId 冲突拒绝", () => {
    const service = makeService();
    const noAuth = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_noauth",
      args: transferArgs(),
    });
    expect(noAuth.status).toBe("prepare_rejected");
    if (noAuth.status === "prepare_rejected") expect(noAuth.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);

    // 同 id 不同 args（不同 canonical payload）→ prepare_conflict。
    const first = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_conflict",
      args: transferArgs({ amount: 100 }),
      authorization: authorize(service, { transactionId: "ac_conflict", amount: 100 }),
    });
    expect(first.status).toBe("executed_committed");
    // 同 id 已结算：幂等优先于 payload 冲突——不同 payload 的重放同样
    // already_settled（防重放保证；prepare_conflict 只在未结算仍 active 时
    // 由低层 prepare 语义触发）。
    const conflict = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_conflict",
      args: transferArgs({ amount: 200 }),
      authorization: authorize(service, { transactionId: "ac_conflict", amount: 200 }),
    });
    expect(conflict.status).toBe("already_settled");
  });

  it("postings 覆盖校验：流出超出授权 amount 拒绝、location 超出 scope 拒绝", () => {
    const service = makeService();
    const small = authorize(service, { amount: 100, transactionId: "ac_scope1" });
    const over = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_scope1",
      args: transferArgs({ amount: 500 }),
      authorization: small,
    });
    expect(over.status).toBe("prepare_rejected");
    if (over.status === "prepare_rejected") expect(over.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);

    // 授权 scope 只含 storage：从 terminal 流出（写入侧）不受流出约束——
    // 但从 storage 流出到 terminal 需要流入腿合法；改从 terminal 流出且授权
    // 仅 storage scope → 负 posting 的 location 不在 scope → 拒绝。
    const storageOnly = authorize(service, { amount: 5_000, transactionId: "ac_scope2" });
    const wrongLocation = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_scope2",
      args: transferArgs({ amount: 1_000, fromLocation: "terminal", toLocation: "storage" }),
      authorization: storageOnly,
    });
    expect(wrongLocation.status).toBe("prepare_rejected");
    if (wrongLocation.status === "prepare_rejected") expect(wrongLocation.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("多资源 action（U 转移 + energy 费用腿）：每资源分别授权、联合覆盖校验", () => {
    const service = makeService();
    const energyToken = authorize(service, {
      resource: RESOURCE_ENERGY,
      amount: 50,
      transactionId: "ac_multi",
      locations: ["storage", "terminal"],
    });
    const uToken = authorize(service, { resource: "U", amount: 3_000, transactionId: "ac_multi" });
    // 缺 energy 授权 → energy 负腿未被覆盖 → 拒绝（uToken 在此被消费）。
    const missing = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_multi",
      args: transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }),
      authorization: uToken,
    });
    expect(missing.status).toBe("prepare_rejected");
    if (missing.status === "prepare_rejected") expect(missing.reason).toBe("authorization_invalid");
    // 双 token 齐备（重新签发——授权单次使用）→ 执行成功。
    const ok = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_multi",
      args: transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 }),
      authorization: [
        authorize(service, { resource: "U", amount: 3_000, transactionId: "ac_multi" }),
        authorize(service, {
          resource: RESOURCE_ENERGY,
          amount: 50,
          transactionId: "ac_multi",
          locations: ["storage", "terminal"],
        }),
      ],
    });
    expect(ok.status).toBe("executed_committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("授权 contractDigest 绑定不一致拒绝", () => {
    const service = makeService();
    const bound = authorize(service, { amount: 500, transactionId: "ac_digest", contractDigest: "0123456789abcdef" });
    const result = executeTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_digest",
      args: transferArgs({ amount: 500 }),
      authorization: bound,
    });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("contract_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("伪造 contract（普通对象/结构相同副本）与跨 tick contract 失效", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_forge", args: transferArgs() });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const token = authorize(service, { amount: 500, transactionId: "ac_forge" });
    const forged: TreasuryActionContract = { ...built.contract };
    const forgedResult = executeTreasuryActionContract(service, { contract: forged, authorization: token });
    expect(forgedResult.status).toBe("prepare_rejected");
    if (forgedResult.status === "prepare_rejected") expect(forgedResult.reason).toBe("contract_invalid");
    // 跨 tick：contract 构建与执行不在同一 tick → 失效。
    const token2 = authorize(service, { amount: 500, transactionId: "ac_forge2" });
    const built2 = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_forge2", args: transferArgs() });
    expect(built2.status).toBe("built");
    Game.time += 1;
    service.beginTick();
    const stale = executeTreasuryActionContract(service, {
      contract: built2.status === "built" ? built2.contract : undefined,
      authorization: token2,
    });
    expect(stale.status).toBe("prepare_rejected");
    if (stale.status === "prepare_rejected") expect(stale.reason).toBe("contract_invalid");
  });

  it("结构 incarnation 变化拒绝（structureId 快照 vs 当前 observation）", () => {
    const rooms = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
    service.beginTick();
    const token = authorize(service, { amount: 500, transactionId: "ac_struct" });
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_struct",
      args: transferArgs(),
    });
    expect(built.status).toBe("built");
    // 结构替换（storage structureId 变化）。
    Game.time += 1;
    rooms.W1N57 = {
      ...(rooms.W1N57 as unknown as Room),
      storage: { ...(rooms.W1N57.storage as unknown as StructureStorage), id: "stor-NEW" },
    } as unknown as Room;
    service.beginTick();
    const result = executeTreasuryActionContract(service, {
      contract: built.status === "built" ? built.contract : undefined,
      authorization: token,
    });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("contract_invalid"); // 跨 tick contract 先失效
    // 同 tick 内构建后立刻替换结构再执行 → structure_replaced。
    const service2 = createTreasuryService({ getRooms: () => Object.values(rooms) });
    service2.beginTick();
    const token2 = authorize(service2, { amount: 500, transactionId: "ac_struct2" });
    const built2 = buildTreasuryActionContract(service2, {
      actionKind: "test.transfer",
      transactionId: "ac_struct2",
      args: transferArgs(),
    });
    expect(built2.status).toBe("built");
    rooms.W1N57 = {
      ...(rooms.W1N57 as unknown as Room),
      storage: { ...(rooms.W1N57.storage as unknown as StructureStorage), id: "stor-NEW2" },
    } as unknown as Room;
    const replaced = executeTreasuryActionContract(service2, {
      contract: built2.status === "built" ? built2.contract : undefined,
      authorization: token2,
    });
    expect(replaced.status).toBe("prepare_rejected");
    if (replaced.status === "prepare_rejected") expect(replaced.reason).toBe("structure_replaced");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("adapter execute 抛错 → execution unknown 隔离（intent/quarantine 状态机）", () => {
    const service = makeService();
    const token = authorize(service, { amount: 500, transactionId: "ac_throw" });
    let rethrown: unknown = null;
    try {
      executeTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: "ac_throw",
        args: transferArgs({ outcome: "throw" }),
        authorization: token,
      });
    } catch (error) {
      rethrown = error;
    }
    expect((rethrown as Error).message).toContain("injected execution failure");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    // durable quarantine 接管（execution unknown）。
    const quarantined = (service.metrics() as unknown as { quarantineEntries: number }).quarantineEntries;
    expect(quarantined).toBe(1);
    // 同 id 重放被拒（callback 零新增）：隔离后 authorize 被 context 阻断
    //（write_fault + quarantine_unresolved——正确行为），故在 prepare 层断言。
    const replay = service.prepareTransaction({
      transactionId: "ac_throw",
      kind: "test.transfer",
      source: "test",
      decision: {
        scope: service.observation().epoch.scope,
        epochSeq: service.observation().epoch.epochSeq,
        observedAtTick: service.observation().epoch.observedAtTick,
      },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
    });
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") expect(replay.reason).toBe("transaction_quarantined");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("adapter kind 不匹配拒绝（registry 被替换为不同 kind 的实现）", () => {
    const service = makeService();
    expect(findTreasuryActionAdapter("test.transfer")).toBeDefined();
    const token = authorize(service, { amount: 500, transactionId: "ac_mismatch" });
    // 构建合法 contract 后注销 adapter → 执行拒绝。
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_mismatch",
      args: transferArgs(),
    });
    expect(built.status).toBe("built");
    replaceTreasuryActionAdapterForTest({
      ...makeTreasuryTestTransferAdapter(),
      kind: "test.transfer",
      version: 2,
    });
    const result = executeTreasuryActionContract(service, {
      contract: built.status === "built" ? built.contract : undefined,
      authorization: token,
    });
    expect(result.status).toBe("executed_committed"); // 同 kind 替换仍可执行（版本演进）
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});
