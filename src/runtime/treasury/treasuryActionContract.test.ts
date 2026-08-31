/**
 * Treasury action contract 与注册 adapter 测试（第八轮建立、第九轮升级
 * contract-first 授权与原子 bundle redemption）：
 * - contract 由 canonical args 确定性派生 postings（与 Game API 参数同源，
 *   两套事实通道不复存在）；调用者事后修改原 args 不影响 canonical；
 * - 伪造 contract（普通对象/JSON 副本）失败；跨 tick contract 失效；
 * - adapter 未注册 / kind 不匹配拒绝；重复注册拒绝；version 演进后旧
 *   contract 失效；
 * - 执行走 contract-first bundle（authorizeTreasuryActionContract：授权需求
 *   全部从 contract 派生）；test-only 裸 token 路径必须绑定 contractDigest；
 * - postings 覆盖校验（实际动作不得超出授权 scope/amount）；
 * - 结构 incarnation 变化拒绝；adapter.execute 恰好一次（副作用计数）；
 * - 不同 payload 同 transactionId 冲突拒绝。
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
  type TreasuryActionStructureBinding,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import type { TreasuryAuthorizationToken } from "@/runtime/treasury/authorization";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { readTreasuryIntentEntry, type TreasuryIntentStore } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 50_000 }, freeCapacity: 10_000 },
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

/** 构建 contract 并签发 contract-first bundle（生产路径的测试镜像）。 */
function buildAndAuthorize(
  service: TreasuryTestService,
  transactionId: string,
  args: TreasuryTestTransferArgs,
): { contract: TreasuryActionContract; bundle: ReturnType<TreasuryService["authorizeTreasuryActionContract"]> } {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return { contract: built.contract, bundle: service.authorizeTreasuryActionContract(built.contract) };
}

/**
 * test-only 裸 token（绑定 contract digest——预验证要求 token 恒绑 digest）：
 * 用于构造"与 contract 不匹配/超范围"的坏授权。
 */
function rawToken(
  service: TreasuryTestService,
  contract: TreasuryActionContract,
  overrides: Partial<{ resource: string; amount: number; transactionId: string; contractDigest?: string; locations?: string[] }> = {},
): TreasuryAuthorizationToken {
  const result = service.authorizeResourceUse({
    transactionId: overrides.transactionId ?? contract.transactionId,
    actionKind: contract.actionKind,
    resource: overrides.resource ?? RESOURCE_ENERGY,
    rooms: ["W1N57"],
    locations: (overrides.locations ?? ["storage", "terminal"]) as "storage"[],
    amount: overrides.amount ?? 500,
    contractDigest: overrides.contractDigest ?? contract.digest,
    adapterVersion: contract.adapterVersion,
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
    // 受控结构快照（第九轮）：posting locations + structureBindings 声明。
    expect(Object.keys(built.contract.structureSnapshots)).toContain("W1N57:storage");
    expect(built.contract.structureBindings.map((b) => `${b.roomName}:${b.locationKind}`)).toEqual(
      expect.arrayContaining(["W1N57:storage", "W1N57:terminal"]),
    );
    // durableFacts 有界对账事实（intent 持久化来源）。
    expect(built.contract.durableFacts?.version).toBe(1);
    expect(built.contract.durableFacts?.payload).toContain("transfer|");
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

describe("contract 执行（contract-first bundle）", () => {
  it("bundle 授权 + 执行：adapter 恰好一次、commit 完成、副作用计数为 1", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "ac_exec_ok", transferArgs({ amount: 500 }));
    expect(bundle.status).toBe("authorized");
    if (bundle.status !== "authorized") return;
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle.bundle });
    expect(result.status).toBe("executed_committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    // 同 id 重放命中 already_settled（receipt 防重放），callback 零新增调用。
    const reAuthorized = service.authorizeTreasuryActionContract(contract);
    expect(reAuthorized.status).toBe("authorized");
    const replay =
      reAuthorized.status === "authorized"
        ? executeTreasuryActionContract(service, { contract, authorization: reAuthorized.bundle })
        : { status: "not_authorized" as const };
    expect(replay.status).toBe("already_settled");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("无授权拒绝；不同 payload 同 transactionId 已结算后重放 already_settled", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_noauth",
      args: transferArgs(),
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const noAuth = executeTreasuryActionContract(service, { contract: built.contract });
    expect(noAuth.status).toBe("prepare_rejected");
    if (noAuth.status === "prepare_rejected") expect(noAuth.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);

    const first = buildAndAuthorize(service, "ac_conflict", transferArgs({ amount: 100 }));
    expect(first.bundle.status).toBe("authorized");
    if (first.bundle.status !== "authorized") return;
    const ok = executeTreasuryActionContract(service, { contract: first.contract, authorization: first.bundle.bundle });
    expect(ok.status).toBe("executed_committed");
    // 同 id 已结算：幂等优先于 payload 冲突——不同 payload 的重放同样
    // already_settled（防重放保证；prepare_conflict 只在未结算仍 active 时
    // 由低层 prepare 语义触发）。
    const conflict = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_conflict",
      args: transferArgs({ amount: 200 }),
    });
    expect(conflict.status).toBe("built");
    if (conflict.status !== "built") return;
    const conflictAuth = service.authorizeTreasuryActionContract(conflict.contract);
    const conflictResult =
      conflictAuth.status === "authorized"
        ? executeTreasuryActionContract(service, { contract: conflict.contract, authorization: conflictAuth.bundle })
        : { status: "not_authorized" as const };
    expect(conflictResult.status).toBe("already_settled");
  });

  it("postings 覆盖校验：流出超出授权 amount 拒绝、location 超出 scope 拒绝（token 零消费）", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_scope1",
      args: transferArgs({ amount: 500 }),
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const small = rawToken(service, built.contract, { amount: 100 });
    const over = executeTreasuryActionContract(service, { contract: built.contract, authorization: small as unknown as import("@/runtime/treasury/authorization").TreasuryAuthorizationBundle });
    expect(over.status).toBe("prepare_rejected");
    if (over.status === "prepare_rejected") expect(over.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);

    // 授权 scope 只含 storage：负 posting 从 storage 流出在 scope——反向
    // （从 terminal 流出且授权仅 storage scope）在 scope 校验拒绝。
    const built2 = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_scope2",
      args: transferArgs({ amount: 1_000, fromLocation: "terminal", toLocation: "storage" }),
    });
    expect(built2.status).toBe("built");
    if (built2.status !== "built") return;
    const storageOnly = rawToken(service, built2.contract, { amount: 5_000, locations: ["storage"] });
    const wrongLocation = executeTreasuryActionContract(service, { contract: built2.contract, authorization: storageOnly as unknown as import("@/runtime/treasury/authorization").TreasuryAuthorizationBundle });
    expect(wrongLocation.status).toBe("prepare_rejected");
    if (wrongLocation.status === "prepare_rejected") expect(wrongLocation.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("多资源 action（U 转移 + energy 费用腿）：bundle 自动派生每资源授权", () => {
    const service = makeService();
    const args = transferArgs({ resource: "U", amount: 3_000, feeFromRoom: "W1N57", feeAmount: 50 });
    const { contract, bundle } = buildAndAuthorize(service, "ac_multi", args);
    expect(bundle.status).toBe("authorized");
    if (bundle.status !== "authorized") return;
    // 多资源派生正确性（U + energy fee 腿）经执行成功与下述"缺一资源拒绝"验证。
    const ok = executeTreasuryActionContract(service, { contract, authorization: bundle.bundle });
    expect(ok.status).toBe("executed_committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    // 缺一资源的裸 token 集合：energy 负腿未被覆盖 → 预验证拒绝（零消费）。
    const rebuilt = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_multi2", args });
    expect(rebuilt.status).toBe("built");
    if (rebuilt.status !== "built") return;
    const uOnly = rawToken(service, rebuilt.contract, { resource: "U", amount: 3_000 });
    const missing = executeTreasuryActionContract(service, { contract: rebuilt.contract, authorization: [uOnly] as unknown as import("@/runtime/treasury/authorization").TreasuryAuthorizationBundle });
    expect(missing.status).toBe("prepare_rejected");
    if (missing.status === "prepare_rejected") expect(missing.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("授权 contractDigest 绑定不一致拒绝（token 未被消费）", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "ac_digest",
      args: transferArgs({ amount: 500 }),
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const bound = rawToken(service, built.contract, { amount: 500, contractDigest: "0123456789abcdef" });
    const result = executeTreasuryActionContract(service, { contract: built.contract, authorization: bound as unknown as import("@/runtime/treasury/authorization").TreasuryAuthorizationBundle });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("authorization_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("伪造 contract（普通对象/结构相同副本）与跨 tick contract 失效", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_forge", args: transferArgs() });
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const authorized = service.authorizeTreasuryActionContract(built.contract);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    const forged: TreasuryActionContract = { ...built.contract };
    const forgedResult = executeTreasuryActionContract(service, { contract: forged, authorization: authorized.bundle });
    expect(forgedResult.status).toBe("prepare_rejected");
    if (forgedResult.status === "prepare_rejected") expect(forgedResult.reason).toBe("contract_invalid");
    // 跨 tick：contract 构建与执行不在同一 tick → 失效（授权亦失效）。
    const built2 = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "ac_forge2", args: transferArgs() });
    expect(built2.status).toBe("built");
    Game.time += 1;
    service.beginTick();
    const staleAuth = built2.status === "built" ? service.authorizeTreasuryActionContract(built2.contract) : undefined;
    const stale = executeTreasuryActionContract(service, {
      contract: built2.status === "built" ? built2.contract : undefined,
      authorization: staleAuth !== undefined && staleAuth.status === "authorized" ? staleAuth.bundle : undefined,
    });
    expect(stale.status).toBe("prepare_rejected");
    if (stale.status === "prepare_rejected") expect(stale.reason).toBe("contract_invalid");
  });

  it("结构 incarnation 变化拒绝（structureId 快照 vs 当前 observation）", () => {
    const rooms = installRooms(ROOMS);
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    const { contract, bundle } = buildAndAuthorize(service, "ac_struct", transferArgs());
    expect(bundle.status).toBe("authorized");
    // 同 tick 内构建后立刻替换结构再执行 → structure_replaced（fresh 必需，
    // 不退回 shared observation）。
    const service2 = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service2.beginTick();
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
    const auth2 = service2.authorizeTreasuryActionContract(built2.status === "built" ? built2.contract : undefined);
    const replaced =
      auth2.status === "authorized" && built2.status === "built"
        ? executeTreasuryActionContract(service2, { contract: built2.contract, authorization: auth2.bundle })
        : { status: "not_authorized" as const };
    expect(replaced.status).toBe("prepare_rejected");
    if (replaced.status === "prepare_rejected") expect(replaced.reason).toBe("structure_replaced");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    void contract;
  });

  it("adapter execute 抛错 → execution unknown 隔离（intent/quarantine 状态机）", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "ac_throw", transferArgs({ outcome: "throw" }));
    expect(bundle.status).toBe("authorized");
    if (bundle.status !== "authorized") return;
    let rethrown: unknown = null;
    try {
      executeTreasuryActionContract(service, { contract, authorization: bundle.bundle });
    } catch (error) {
      rethrown = error;
    }
    expect((rethrown as Error).message).toContain("injected execution failure");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    // durable quarantine 接管（execution unknown）。
    const quarantined = (service.metrics() as unknown as { quarantineEntries: number }).quarantineEntries;
    expect(quarantined).toBe(1);
    // 同 id 重放被拒（callback 零新增）：隔离后 authorize 被 write admission
    // 阻断（正确行为），故在 prepare 层断言。
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

  it("adapter version 演进后旧 contract 失效（同 kind 替换 v2 → 旧 v1 contract 拒绝）", () => {
    const service = makeService();
    expect(findTreasuryActionAdapter("test.transfer")).toBeDefined();
    const { contract, bundle } = buildAndAuthorize(service, "ac_mismatch", transferArgs());
    expect(bundle.status).toBe("authorized");
    replaceTreasuryActionAdapterForTest({
      ...makeTreasuryTestTransferAdapter(),
      kind: "test.transfer",
      semanticIdentity: "test.transfer@test-adapter-semantics-v1",
      version: 2,
    });
    const result =
      bundle.status === "authorized"
        ? executeTreasuryActionContract(service, { contract, authorization: bundle.bundle })
        : { status: "not_authorized" as const };
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("contract_invalid");
      expect(result.detail).toContain("adapter version");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // v2 adapter 构建的新 contract 可正常执行（bundle 重新签发）。
    const fresh = buildAndAuthorize(service, "ac_mismatch_v2", transferArgs());
    expect(fresh.bundle.status).toBe("authorized");
    if (fresh.bundle.status !== "authorized") return;
    const ok = executeTreasuryActionContract(service, { contract: fresh.contract, authorization: fresh.bundle.bundle });
    expect(ok.status).toBe("executed_committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });
});

describe("contract digest AC3：durable reconciliation facts 绑定（第十轮 3.12.6）", () => {
  /** 双腿 adapter（可变 durable payload 的固定 vector fixture）。 */
  function vectorAdapter(payload: string, version = 1) {
    return {
      kind: "test.vec",
      semanticIdentity: "test.vec@test-adapter-semantics-v1",
      version,
      validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
      derivePostings: () => [
        { roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 },
        { roomName: "W1N57", locationKind: "terminal", resource: "energy", delta: 100 },
      ],
      execute: (): { ok: boolean } => ({ ok: true }),
      structureBindings: () => [],
      durableFacts: () => ({ version, payload }),
      reconcile: () => "still_uncertain" as const,
    };
  }

  it("durable payload 变化 → digest 变化；version 变化 → digest 变化；相同 facts → 固定 digest（vector）", () => {
    registerTreasuryActionAdapter(vectorAdapter("vec-payload-A"));
    const service = makeService();
    const a1 = buildTreasuryActionContract(service, { actionKind: "test.vec", transactionId: "ac3_fixed", args: {} });
    const a2 = buildTreasuryActionContract(service, { actionKind: "test.vec", transactionId: "ac3_fixed", args: {} });
    if (a1.status !== "built" || a2.status !== "built") throw new Error("build a failed");
    expect(a1.contract.digest).toBe(a2.contract.digest); // 确定性（固定 vector）
    const fixedDigest = a1.contract.digest;
    // 同 adapter version、不同 payload → digest 变化。
    replaceTreasuryActionAdapterForTest(vectorAdapter("vec-payload-B"));
    const b = buildTreasuryActionContract(service, { actionKind: "test.vec", transactionId: "ac3_fixed", args: {} });
    if (b.status !== "built") throw new Error("build b failed");
    expect(b.contract.digest).not.toBe(fixedDigest);
    // durable payload version 变化 → digest 变化（同 payload 文本）。
    replaceTreasuryActionAdapterForTest(vectorAdapter("vec-payload-A", 2));
    const c = buildTreasuryActionContract(service, { actionKind: "test.vec", transactionId: "ac3_fixed", args: {} });
    if (c.status !== "built") throw new Error("build c failed");
    expect(c.contract.digest).not.toBe(fixedDigest);
    // 【第十一轮 AC4】digest 绑定 adapter registration identity：test-only
    // replace（同 kind/version/同 payload）产生新 registrationId → digest
    // 变化（旧 contract 因 registration identity 不匹配失效）；新
    // registration 下重构建仍确定性（连续两次相同）。
    replaceTreasuryActionAdapterForTest(vectorAdapter("vec-payload-A"));
    const a3 = buildTreasuryActionContract(service, { actionKind: "test.vec", transactionId: "ac3_fixed", args: {} });
    if (a3.status !== "built") throw new Error("build a3 failed");
    expect(a3.contract.digest).not.toBe(fixedDigest);
    const a4 = buildTreasuryActionContract(service, { actionKind: "test.vec", transactionId: "ac3_fixed", args: {} });
    if (a4.status !== "built") throw new Error("build a4 failed");
    expect(a4.contract.digest).toBe(a3.contract.digest);
  });

  it("提供 reconciler 但无 durableFacts 的 adapter：contract 构建拒绝（durable facts 必填）", () => {
    registerTreasuryActionAdapter({
      kind: "test.nofacts",
      semanticIdentity: "test.nofacts@test-adapter-semantics-v1",
      version: 1,
      validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
      derivePostings: () => [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      execute: (): { ok: boolean } => ({ ok: true }),
      structureBindings: () => [],
      reconcile: () => "still_uncertain" as const,
    });
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.nofacts", transactionId: "ac3_nofacts", args: {} });
    expect(built.status).toBe("rejected");
    if (built.status === "rejected") expect(built.detail).toContain("durableFacts");
  });
});

describe("structure binding canonical authority（第十轮 3.12.11）", () => {
  function locationAdapter(extraBindings: TreasuryActionStructureBinding[], kind = "test.bindloc") {
    return {
      kind,
      semanticIdentity: `${kind}@test-adapter-semantics-v1`,
      version: 1,
      validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
      derivePostings: () => [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      execute: (): { ok: boolean } => ({ ok: true }),
      structureBindings: () => extraBindings,
      durableFacts: () => ({ version: 1, payload: "bind-fixture" }),
      reconcile: () => "still_uncertain" as const,
    };
  }

  it("label 与 posting binding 相同但 identity 声明冲突：contract 拒绝（不静默合并）", () => {
    registerTreasuryActionAdapter(
      locationAdapter([{ roomName: "W1N57", locationKind: "storage", label: "custom" }], "test.bind_a"),
    );
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.bind_a", transactionId: "bind_a", args: {} });
    expect(built.status).toBe("built"); // 同 identity（W1N57:storage）→ 合并合法
    registerTreasuryActionAdapter(
      locationAdapter(
        [
          { roomName: "W1N57", locationKind: "terminal", label: "W1N57:storage:source" }, // label 撞 posting（role 后缀）但 identity 不同
        ],
        "test.bind_b",
      ),
    );
    const built2 = buildTreasuryActionContract(service, { actionKind: "test.bind_b", transactionId: "bind_b", args: {} });
    expect(built2.status).toBe("rejected");
    if (built2.status === "rejected") expect(built2.detail).toContain("冲突"); // label 撞 posting 且 identity 不同
  });

  it("required structure 构建时不存在（位置缺失）：contract 拒绝（不记录 undefined）", () => {
    // E1N1 无 mock 房间 → posting 房间不在管辖 → 拒绝。
    registerTreasuryActionAdapter(
      locationAdapter([{ roomName: "E1N1", locationKind: "storage" }], "test.bind_c"),
    );
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.bind_c", transactionId: "bind_c", args: {} });
    expect(built.status).toBe("rejected");
    if (built.status === "rejected") expect(built.detail).toContain("不在管辖");
  });

  it("__proto__ 类诊断 label 不污染结构快照（null-prototype 容器）", () => {
    registerTreasuryActionAdapter(
      locationAdapter([{ roomName: "W1N57", locationKind: "terminal", label: "__proto__" }], "test.bind_d"),
    );
    const service = makeService();
    // terminal 位置缺失（ROOMS fixture 的 W1N57 无 terminal？——有（term-1）。构建成功且 __proto__ 为自有键。
    const built = buildTreasuryActionContract(service, { actionKind: "test.bind_d", transactionId: "bind_d", args: {} });
    expect(built.status).toBe("built");
    if (built.status === "built") {
      expect(Object.prototype.hasOwnProperty.call(built.contract.structureSnapshots, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(built.contract.structureSnapshots)).toBe(null);
    }
  });

  it("object-ID binding：对象类型或 room 归属错误时拒绝；正确时构建成功", () => {
    registerTreasuryActionAdapter(
      locationAdapter(
        [{ roomName: "W1N57", locationKind: "storage", objectId: "lab-001", expectedType: "lab", expectedRoom: "W1N57" }],
        "test.bind_e",
      ),
    );
    (Game as unknown as { objects: Record<string, unknown> }).objects = {};
    const service = makeService();
    // 对象不存在 → 拒绝。
    const missing = buildTreasuryActionContract(service, { actionKind: "test.bind_e", transactionId: "bind_e1", args: {} });
    expect(missing.status).toBe("rejected");
    if (missing.status === "rejected") expect(missing.detail).toContain("不存在");
    // 类型不匹配 → 拒绝。
    (Game as unknown as { objects: Record<string, unknown> }).objects = {
      "lab-001": { id: "lab-001", structureType: "spawn", room: { name: "W1N57" } },
    };
    const wrongType = buildTreasuryActionContract(service, { actionKind: "test.bind_e", transactionId: "bind_e2", args: {} });
    expect(wrongType.status).toBe("rejected");
    if (wrongType.status === "rejected") expect(wrongType.detail).toContain("类型不匹配");
    // room 归属不匹配 → 拒绝。
    (Game as unknown as { objects: Record<string, unknown> }).objects = {
      "lab-001": { id: "lab-001", structureType: "lab", room: { name: "E2N2" } },
    };
    const wrongRoom = buildTreasuryActionContract(service, { actionKind: "test.bind_e", transactionId: "bind_e3", args: {} });
    expect(wrongRoom.status).toBe("rejected");
    if (wrongRoom.status === "rejected") expect(wrongRoom.detail).toContain("room 归属不匹配");
    // 全部匹配 → 构建成功且快照含 objectId。
    (Game as unknown as { objects: Record<string, unknown> }).objects = {
      "lab-001": { id: "lab-001", structureType: "lab", room: { name: "W1N57" } },
    };
    const ok = buildTreasuryActionContract(service, { actionKind: "test.bind_e", transactionId: "bind_e4", args: {} });
    expect(ok.status).toBe("built");
    if (ok.status === "built") {
      expect(ok.contract.structureSnapshots["obj:lab-001"]).toBe("lab-001");
    }
  });

  it("structure facts 变化导致 contract digest 变化", () => {
    registerTreasuryActionAdapter(
      locationAdapter([{ roomName: "W1N57", locationKind: "terminal", label: "extra" }], "test.bind_f"),
    );
    const service = makeService();
    const first = buildTreasuryActionContract(service, { actionKind: "test.bind_f", transactionId: "bind_f", args: {} });
    // 换一个声明（不同 label）→ digest 变化（replace 覆盖注册）。
    replaceTreasuryActionAdapterForTest(
      locationAdapter([{ roomName: "W1N57", locationKind: "terminal", label: "extra2" }], "test.bind_f"),
    );
    const second = buildTreasuryActionContract(service, { actionKind: "test.bind_f", transactionId: "bind_f", args: {} });
    if (first.status !== "built" || second.status !== "built") throw new Error("build failed");
    expect(first.contract.digest).not.toBe(second.contract.digest);
  });
});

describe("完整 structure descriptor（第十一轮 3.13.9 / AC4）", () => {
  interface DescriptorAdapterOverrides {
    readonly bindings?: TreasuryActionStructureBinding[];
    readonly kind?: string;
  }
  function descriptorAdapter(overrides: DescriptorAdapterOverrides = {}) {
    return {
      kind: overrides.kind ?? "test.desc",
      semanticIdentity: `${overrides.kind ?? "test.desc"}@test-adapter-semantics-v1`,
      version: 1,
      validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
      derivePostings: () => [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      execute: (): { ok: boolean } => ({ ok: true }),
      structureBindings: () => overrides.bindings ?? [],
      durableFacts: () => ({ version: 1, payload: "desc-fixture" }),
      reconcile: () => "still_uncertain" as const,
    };
  }

  it("role 变化 → digest 变化；同结构不同 role 不被合并（双 descriptor 保留）", () => {
    registerTreasuryActionAdapter(descriptorAdapter({ kind: "test.desc_role", bindings: [{ roomName: "W1N57", locationKind: "terminal", role: "fee_source" }] }));
    const service = makeService();
    const feeSource = buildTreasuryActionContract(service, { actionKind: "test.desc_role", transactionId: "desc_role", args: {} });
    if (feeSource.status !== "built") throw new Error("build fee_source failed");
    // posting binding（W1N57:storage, source）+ adapter 声明（W1N57:terminal, fee_source）两条 descriptor。
    const roles = feeSource.contract.structureDescriptors.map((d) => d.role).sort();
    expect(roles).toEqual(["fee_source", "source"]);
    // 换 role（production_structure）→ digest 变化。
    replaceTreasuryActionAdapterForTest(
      descriptorAdapter({ kind: "test.desc_role", bindings: [{ roomName: "W1N57", locationKind: "terminal", role: "production_structure" }] }),
    );
    const prod = buildTreasuryActionContract(service, { actionKind: "test.desc_role", transactionId: "desc_role", args: {} });
    if (prod.status !== "built") throw new Error("build prod failed");
    expect(prod.contract.digest).not.toBe(feeSource.contract.digest);
    // 同一结构（W1N57:terminal）以两个 role 同时声明 → 保留两条（不静默合并）。
    replaceTreasuryActionAdapterForTest(
      descriptorAdapter({
        kind: "test.desc_role",
        bindings: [
          { roomName: "W1N57", locationKind: "terminal", role: "fee_source" },
          { roomName: "W1N57", locationKind: "terminal", role: "production_structure" },
        ],
      }),
    );
    const dual = buildTreasuryActionContract(service, { actionKind: "test.desc_role", transactionId: "desc_role", args: {} });
    if (dual.status !== "built") throw new Error("build dual failed");
    const terminalRoles = dual.contract.structureDescriptors.filter((d) => d.roomName === "W1N57" && d.locationKind === "terminal").map((d) => d.role).sort();
    expect(terminalRoles).toEqual(["fee_source", "production_structure"]);
  });

  it("expectedType / expectedRoom / objectId 变化 → digest 变化（game_object 全字段进 digest）", () => {
    (Game as unknown as { objects: Record<string, unknown> }).objects = {
      "lab-001": { id: "lab-001", structureType: "lab", room: { name: "W1N57" } },
      "lab-002": { id: "lab-002", structureType: "lab", room: { name: "W1N57" } },
    };
    const service = makeService();
    registerTreasuryActionAdapter(
      descriptorAdapter({ kind: "test.desc_obj", bindings: [{ roomName: "W1N57", locationKind: "storage", objectId: "lab-001", expectedType: "lab", expectedRoom: "W1N57" }] }),
    );
    const base = buildTreasuryActionContract(service, { actionKind: "test.desc_obj", transactionId: "desc_obj", args: {} });
    if (base.status !== "built") throw new Error("build base failed");
    const objectIdDescriptor = base.contract.structureDescriptors.find((d) => d.bindingKind === "game_object");
    expect(objectIdDescriptor).toMatchObject({ objectId: "lab-001", expectedType: "lab", expectedRoom: "W1N57", structureId: "lab-001" });
    // objectId 变化 → digest 变化。
    replaceTreasuryActionAdapterForTest(
      descriptorAdapter({ kind: "test.desc_obj", bindings: [{ roomName: "W1N57", locationKind: "storage", objectId: "lab-002", expectedType: "lab", expectedRoom: "W1N57" }] }),
    );
    const byObject = buildTreasuryActionContract(service, { actionKind: "test.desc_obj", transactionId: "desc_obj", args: {} });
    if (byObject.status !== "built") throw new Error("build byObject failed");
    expect(byObject.contract.digest).not.toBe(base.contract.digest);
    // expectedRoom 声明变化（改为 E2N2——对象不匹配会拒绝，因此用省略 vs 存在比较）：
    replaceTreasuryActionAdapterForTest(
      descriptorAdapter({ kind: "test.desc_obj", bindings: [{ roomName: "W1N57", locationKind: "storage", objectId: "lab-001", expectedType: "lab" }] }),
    );
    const noRoom = buildTreasuryActionContract(service, { actionKind: "test.desc_obj", transactionId: "desc_obj", args: {} });
    if (noRoom.status !== "built") throw new Error("build noRoom failed");
    expect(noRoom.contract.digest).not.toBe(base.contract.digest);
    // expectedType 省略 → digest 变化。
    replaceTreasuryActionAdapterForTest(
      descriptorAdapter({ kind: "test.desc_obj", bindings: [{ roomName: "W1N57", locationKind: "storage", objectId: "lab-001", expectedRoom: "W1N57" }] }),
    );
    const noType = buildTreasuryActionContract(service, { actionKind: "test.desc_obj", transactionId: "desc_obj", args: {} });
    if (noType.status !== "built") throw new Error("build noType failed");
    expect(noType.contract.digest).not.toBe(base.contract.digest);
  });

  it("required 缺失拒绝；optional（required=false）缺失跳过不进 descriptor", () => {
    registerTreasuryActionAdapter(
      descriptorAdapter({ kind: "test.desc_req", bindings: [{ roomName: "E1N1", locationKind: "storage" }] }),
    );
    const service = makeService();
    const missing = buildTreasuryActionContract(service, { actionKind: "test.desc_req", transactionId: "desc_req", args: {} });
    expect(missing.status).toBe("rejected");
    // optional 声明同一缺失结构 → 跳过（构建成功，descriptor 集不含该声明）。
    replaceTreasuryActionAdapterForTest(
      descriptorAdapter({ kind: "test.desc_req", bindings: [{ roomName: "E1N1", locationKind: "storage", required: false }] }),
    );
    const optional = buildTreasuryActionContract(service, { actionKind: "test.desc_req", transactionId: "desc_req", args: {} });
    expect(optional.status).toBe("built");
    if (optional.status === "built") {
      expect(optional.contract.structureDescriptors.every((d) => d.roomName !== "E1N1")).toBe(true);
      expect(optional.contract.structureDescriptors.every((d) => d.required === true)).toBe(true);
    }
  });

  it("完整 descriptor 进入 durable intent，global reset 后仍可读取；reconciler 收到完整 descriptor", () => {
    (Game as unknown as { objects: Record<string, unknown> }).objects = {
      "lab-001": { id: "lab-001", structureType: "lab", room: { name: "W1N57" } },
    };
    let observedFacts: { structureDescriptors?: unknown } | null = null;
    registerTreasuryActionAdapter({
      kind: "test.desc_durable",
      semanticIdentity: "test.desc_durable@test-adapter-semantics-v1",
      version: 1,
      validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
      derivePostings: () => [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      execute: (): { ok: boolean } => {
        throw new Error("desc-durable: execution unknown fixture");
      },
      structureBindings: () => [
        { roomName: "W1N57", locationKind: "terminal", role: "fee_source" },
        { roomName: "W1N57", locationKind: "storage", objectId: "lab-001", expectedType: "lab", role: "production_structure" },
      ],
      durableFacts: () => ({ version: 1, payload: "durable-fixture" }),
      reconcile: (facts: { structureDescriptors?: unknown }): "observed_not_executed" => {
        observedFacts = { structureDescriptors: facts.structureDescriptors };
        return "observed_not_executed";
      },
    });
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.desc_durable", transactionId: "desc_durable", args: {} });
    if (built.status !== "built") throw new Error("build failed");
    const authorized = service.authorizeTreasuryActionContract(built.contract);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") throw new Error("unreachable");
    expect(() => executeTreasuryActionContract(service, { contract: built.contract, authorization: authorized.bundle })).toThrow();
    // execution unknown → durable quarantine 保留完整 descriptor（governed +
    // game_object 两种 binding；intent 随事实转移释放）。
    const entry = readTreasuryQuarantineEntry("desc_durable");
    expect(entry?.structureFacts).toBeDefined();
    const facts = entry?.structureFacts ?? [];
    expect(facts.some((f) => f.bindingKind === "governed_location" && f.role === "source")).toBe(true);
    expect(facts.some((f) => f.bindingKind === "governed_location" && f.role === "fee_source")).toBe(true);
    expect(facts.some((f) => f.bindingKind === "game_object" && f.role === "production_structure" && f.objectId === "lab-001")).toBe(true);
    expect(facts.every((f) => f.version === 1 && typeof f.required === "boolean")).toBe(true);
    // global reset（重建 service）后 descriptor 仍在 durable authority 中。
    const next = makeService();
    void next;
    const entryAfterReset = readTreasuryQuarantineEntry("desc_durable");
    expect(entryAfterReset?.structureFacts?.length).toBe(facts.length);
    // reconciler 收到完整 descriptor。
    Game.time += 2;
    const postService = makeService();
    const capability = postService.issueTreasuryReconciliationCapability({ transactionId: "desc_durable" });
    expect(capability.status).toBe("issued");
    expect(observedFacts).not.toBeNull();
    const reconcilerDescriptors = (observedFacts as { structureDescriptors?: { objectId?: string; role: string }[] } | null)?.structureDescriptors ?? [];
    expect(reconcilerDescriptors.some((d) => d.objectId === "lab-001" && d.role === "production_structure")).toBe(true);
  });

  it("v3 简化三元组 structureFacts 迁移为完整 descriptor（governed/auxiliary/required/v1）", () => {
    // 构造 v3 intent store（旧三元组 facts）→ load 迁移 → 读出完整 descriptor。
    const boot = makeService();
    void boot;
    Memory.runtime!.treasury!.intents = {
      version: 3,
      entries: {
        "i:desc_legacy": {
          transactionId: "desc_legacy",
          digest: "0123456789abcdef",
          actionKind: "legacy.kind",
          kind: "legacy.kind",
          source: "test",
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
          outcome: "started_unknown",
          settlement: "executing",
          structureFacts: [
            { roomName: "W1N57", locationKind: "storage", structureId: "stor-1" },
          ] as unknown as TreasuryIntentStore["entries"][string]["structureFacts"],
          createdAtTick: Game.time,
          updatedAtTick: Game.time,
        },
      },
      entryCount: 1,
      updatedAt: Game.time,
    } as unknown as NonNullable<NonNullable<typeof Memory.runtime>["treasury"]>["intents"];
    const migrated = readTreasuryIntentEntry("desc_legacy");
    expect(migrated?.structureFacts?.[0]).toMatchObject({
      bindingKind: "governed_location",
      role: "auxiliary",
      required: true,
      version: 1,
      structureId: "stor-1",
    });
    expect((Memory.runtime!.treasury!.intents as { version: number }).version).toBe(5);
  });
});
