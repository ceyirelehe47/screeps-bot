/**
 * Treasury 资源授权 token 测试（第八轮）：
 * - 授权计算：物理−reservations−outgoing−withhold−quarantine/intent 风险−
 *   其它授权预算；commitment incomplete / store 损坏 / readiness 阻断拒绝；
 * - immediate write 硬策略：allowIncoming=true、subtractOutgoing=false、
 *   subtractReservations=false 一律拒绝；自由字符串 policy fingerprint 通道
 *   已移除（第九轮）——提交即结构化拒绝；
 * - owner-aware：owner 自身 reservation 合法排除、非法 owner fail closed；
 * - 防超卖：A 授权后 B 同批资源授权被拒（不等 prepare）；
 * - token 失效矩阵：commitment revision（task/reservation mutation）、
 *   projection revision（commit）、quarantine revision、reservation store
 *   revision、跨 tick、跨 service、重复消费、伪造/JSON 副本、
 *   transactionId 不匹配、postings 超出 scope；
 * - 容量需求：risk-adjusted free 口径校验。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { bumpTreasuryCommitmentRevision, resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import { releaseProductionReservationForOwner, reserveProductionResourceForOwner } from "@/runtime/resourceReservation";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import type { TreasuryAuthorizationRequest, TreasuryAuthorizationToken } from "@/runtime/treasury/authorization";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function authRequest(overrides: Partial<TreasuryAuthorizationRequest> = {}): TreasuryAuthorizationRequest {
  return {
    transactionId: "auth_tx",
    actionKind: "terminal.send",
    resource: RESOURCE_ENERGY,
    rooms: ["W1N57"],
    locations: ["storage"],
    amount: 500,
    ...overrides,
  };
}

function seedPendingTask(id: string, remainingAmount: number): void {
  Memory.data = Memory.data ?? ({} as never);
  Memory.data.resourceControl = Memory.data.resourceControl ?? ({} as never);
  Memory.data.resourceControl.tasks = Memory.data.resourceControl.tasks ?? ({} as never);
  const task = {
    resource: "energy",
    fromRoomName: "W1N57",
    toRoomName: "W1N57",
    amount: remainingAmount,
    remainingAmount,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    origin: "manual",
    lastProgressAt: 1,
  } as ResourceTransferTask;
  Memory.data.resourceControl.tasks[id] = task;
  bumpTreasuryCommitmentRevision();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("授权计算", () => {
  it("物理 100k、production reservation 80k：申请 60k 拒绝（available 20k）", () => {
    const service = makeService();
    expect(
      reserveProductionResourceForOwner("W1N57", RESOURCE_ENERGY, 80_000, { kind: "logical-service", id: "synthesis:W1N57", namespace: "synthesis", roomName: "W1N57" }).status,
    ).toBe("ok");
    const rejected = service.authorizeResourceUse(authRequest({ amount: 60_000 }));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.reason).toBe("insufficient_amount");
      expect(rejected.detail).toContain("20000");
    }
    // 20k 以内可授权。
    const ok = service.authorizeResourceUse(authRequest({ amount: 20_000 }));
    expect(ok.status).toBe("authorized");
  });

  it("owner 查询自身 reservation 时仅合法排除自身（owner-aware 自排除）", () => {
    const service = makeService();
    const owner = { kind: "logical-service" as const, id: "synthesis:W1N57", namespace: "synthesis", roomName: "W1N57" };
    expect(reserveProductionResourceForOwner("W1N57", RESOURCE_ENERGY, 80_000, owner).status).toBe("ok");
    // owner 自排除：自己的 80k 不扣——100k 可授权 60k。
    const own = service.authorizeResourceUse(authRequest({ amount: 60_000, owner }));
    expect(own.status).toBe("authorized");
    // 无 owner / 其它 owner：照常扣除——60k 拒绝。
    const other = service.authorizeResourceUse(authRequest({ amount: 60_000 }));
    expect(other.status).toBe("rejected");
    // 非法 owner（房间不符）fail closed。
    const invalid = service.authorizeResourceUse(
      authRequest({ amount: 100, owner: { kind: "game-object", id: "stor-1", roomName: "E9S9" } }),
    );
    expect(invalid.status).toBe("rejected");
    if (invalid.status === "rejected") expect(invalid.reason).toBe("authorization_context_unsafe");
  });

  it("pending outgoing 被扣除", () => {
    const service = makeService();
    seedPendingTask("auth-task", 30_000);
    const rejected = service.authorizeResourceUse(authRequest({ amount: 95_000 }));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("insufficient_amount");
    const ok = service.authorizeResourceUse(authRequest({ amount: 70_000 }));
    expect(ok.status).toBe("authorized");
  });

  it("policy withhold 被扣除", () => {
    const service = makeService();
    const rejected = service.authorizeResourceUse(authRequest({ amount: 95_000, withhold: 10_000 }));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("insufficient_amount");
    const ok = service.authorizeResourceUse(authRequest({ amount: 90_000, withhold: 10_000 }));
    expect(ok.status).toBe("authorized");
  });

  it("commitment incomplete 拒绝授权", () => {
    const service = makeService();
    Memory.data = Memory.data ?? ({} as never);
    Memory.data.resourceControl = Memory.data.resourceControl ?? ({} as never);
    Memory.data.resourceControl.tasks = Memory.data.resourceControl.tasks ?? ({} as never);
    Memory.data.resourceControl.tasks["broken"] = { bad: "shape" } as unknown as ResourceTransferTask;
    bumpTreasuryCommitmentRevision();
    const rejected = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.reason).toBe("authorization_context_unsafe");
      expect(rejected.detail).toContain("commitment_incomplete");
    }
  });

  it("immediate write 硬策略：allowIncoming / subtractOutgoing=false / subtractReservations=false 拒绝", () => {
    const service = makeService();
    for (const overrides of [
      { allowIncoming: true },
      { subtractOutgoing: false },
      { subtractReservations: false },
    ] as Partial<TreasuryAuthorizationRequest>[]) {
      const rejected = service.authorizeResourceUse(authRequest({ ...overrides, amount: 100 }));
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") expect(rejected.reason).toBe("authorization_policy_violation");
    }
    // 自由字符串 policy fingerprint 通道已移除（第九轮）：提交任意字符串即拒。
    const freeform = service.authorizeResourceUse(
      authRequest({ amount: 100, ...({ policyFingerprint: "caller-said-so" } as object) }),
    );
    expect(freeform.status).toBe("rejected");
    if (freeform.status === "rejected") expect(freeform.reason).toBe("invalid_input");
  });

  it("存在 unresolved quarantine 时授权直接 fail closed（比风险扣减更保守）", () => {
    const service = makeService();
    quarantineTreasuryTransaction({
      transactionId: "auth_q",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -30_000 }],
      recordedAt: Game.time,
    });
    // quarantine 未解决：authorizationSafe=false——即使物理 100k 且流出仅
    // 占用 30k（保守阻断优先于风险扣减）。
    const rejected = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.reason).toBe("authorization_context_unsafe");
      expect(rejected.detail).toContain("quarantine_unresolved");
    }
  });

  it("容量需求走 risk-adjusted free 口径（storage free 10k）", () => {
    const service = makeService();
    const rejected = service.authorizeResourceUse(
      authRequest({ amount: 100, capacityRequirement: { roomName: "W1N57", locationKind: "storage", amount: 10_001 } }),
    );
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("capacity_overflow");
    const ok = service.authorizeResourceUse(
      authRequest({ amount: 100, capacityRequirement: { roomName: "W1N57", locationKind: "storage", amount: 10_000 } }),
    );
    expect(ok.status).toBe("authorized");
    // 已授权的容量预算计入下一次授权（双授权不得超卖容量）。
    const second = service.authorizeResourceUse(
      authRequest({
        transactionId: "auth_tx2",
        amount: 100,
        capacityRequirement: { roomName: "W1N57", locationKind: "storage", amount: 1 },
      }),
    );
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reason).toBe("capacity_overflow");
  });
});

describe("防超卖预算", () => {
  it("A 授权 60k 后 B 再授权 60k（物理 100k）被拒——不等 prepare", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ transactionId: "auth_a", amount: 60_000 }));
    expect(a.status).toBe("authorized");
    const b = service.authorizeResourceUse(authRequest({ transactionId: "auth_b", amount: 60_000 }));
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") expect(b.reason).toBe("insufficient_amount");
    expect(service.metrics().authorizationsActive).toBe(1);
    // A 消费后预算释放。
    if (a.status === "authorized") {
      expect(service.consumeTreasuryAuthorization(a.token, { transactionId: "auth_a" }).status).toBe("ok");
    }
    const bAfter = service.authorizeResourceUse(authRequest({ transactionId: "auth_b", amount: 60_000 }));
    expect(bAfter.status).toBe("authorized");
  });

  it("授权消费成功后同 token 重复消费失败", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    if (a.status === "authorized") {
      expect(service.consumeTreasuryAuthorization(a.token).status).toBe("ok");
      const again = service.consumeTreasuryAuthorization(a.token);
      expect(again.status).toBe("rejected");
      if (again.status === "rejected") expect(again.reason).toBe("already_consumed");
    }
  });
});

describe("token 失效矩阵", () => {
  it("commitment revision 变化（transfer task mutation 语义）后失效", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    bumpTreasuryCommitmentRevision(); // 任何 task/reservation mutation 的统一通知
    if (a.status === "authorized") {
      const consumed = service.consumeTreasuryAuthorization(a.token);
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("revision_mismatch");
    }
    expect(service.metrics().authorizationRevisionMismatches).toBe(1);
  });

  it("reservation mutation 后失效（reservation store revision）", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    expect(
      reserveProductionResourceForOwner("W1N57", RESOURCE_ENERGY, 50, { kind: "game-object", id: "stor-1", roomName: "W1N57" }).status,
    ).toBe("ok");
    if (a.status === "authorized") {
      const consumed = service.consumeTreasuryAuthorization(a.token);
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("revision_mismatch");
    }
  });

  it("projection revision 变化（任何 commit）后失效", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    const recorded = compatRecordAcceptedTransaction(service, {
      transactionId: "auth_proj_commit",
      kind: "test",
      source: "test",
      decision: { scope: "shared", epochSeq: service.observation().epoch.epochSeq, observedAtTick: Game.time },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -10 }],
    });
    expect(recorded.status).toBe("recorded");
    if (a.status === "authorized") {
      const consumed = service.consumeTreasuryAuthorization(a.token);
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("revision_mismatch");
    }
  });

  it("quarantine revision 变化后失效", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status === "authorized");
    quarantineTreasuryTransaction({
      transactionId: "auth_qrev",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [],
      recordedAt: Game.time,
    });
    if (a.status === "authorized") {
      const consumed = service.consumeTreasuryAuthorization(a.token);
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("revision_mismatch");
    }
  });

  it("跨 tick 失效", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    Game.time += 1;
    service.beginTick();
    if (a.status === "authorized") {
      const consumed = service.consumeTreasuryAuthorization(a.token);
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("cross_tick");
    }
  });

  it("跨 service（旧实例 token）与伪造/JSON 副本一律无效", () => {
    const first = makeService();
    const a = first.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    const second = makeService(); // 新 service 实例（不同 generation/registry）
    if (a.status === "authorized") {
      const consumed = second.consumeTreasuryAuthorization(a.token);
      expect(consumed.status).toBe("rejected");
      if (consumed.status === "rejected") expect(consumed.reason).toBe("invalid_token");
      // 伪造：结构相同的普通对象。
      const forged: TreasuryAuthorizationToken = { ...a.token };
      const forgedResult = first.consumeTreasuryAuthorization(forged);
      expect(forgedResult.status).toBe("rejected");
      // JSON round-trip 副本。
      const roundTripped = JSON.parse(JSON.stringify(a.token)) as TreasuryAuthorizationToken;
      const roundTripResult = first.consumeTreasuryAuthorization(roundTripped);
      expect(roundTripResult.status).toBe("rejected");
    }
  });

  it("transactionId 不匹配与 postings 超出 scope 拒绝", () => {
    const service = makeService();
    const a = service.authorizeResourceUse(authRequest({ amount: 1_000 }));
    expect(a.status).toBe("authorized");
    if (a.status === "authorized") {
      const mismatch = service.consumeTreasuryAuthorization(a.token, { transactionId: "other_tx" });
      expect(mismatch.status).toBe("rejected");
      if (mismatch.status === "rejected") expect(mismatch.reason).toBe("transaction_mismatch");
      // 超量：postings 累计流出 2000 > amount 1000。
      const over = service.consumeTreasuryAuthorization(a.token, {
        transactionId: "auth_tx",
        postings: [
          { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_200 },
          { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -800 },
        ],
      });
      expect(over.status).toBe("rejected");
      if (over.status === "rejected") expect(over.reason).toBe("scope_violation");
      // scope 内合法消费。
      const fine = service.consumeTreasuryAuthorization(a.token, {
        transactionId: "auth_tx",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      });
      expect(fine.status).toBe("ok");
    }
  });

  it("授权请求形状非法结构化拒绝（非管辖房间/非正 amount/非法资源）", () => {
    const service = makeService();
    for (const overrides of [
      { rooms: ["E9S9"] },
      { rooms: [] },
      { amount: 0 },
      { amount: -5 },
      { resource: "not-a-resource" },
      { actionKind: "" },
    ] as Partial<TreasuryAuthorizationRequest>[]) {
      const rejected = service.authorizeResourceUse(authRequest(overrides));
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") expect(rejected.reason).toBe("invalid_input");
    }
  });

  it("release 预留（mutation）同样使既有 token 失效并释放预算", () => {
    const service = makeService();
    const owner = { kind: "game-object" as const, id: "stor-1", roomName: "W1N57" };
    expect(reserveProductionResourceForOwner("W1N57", RESOURCE_ENERGY, 50, owner).status).toBe("ok");
    const a = service.authorizeResourceUse(authRequest({ amount: 100 }));
    expect(a.status).toBe("authorized");
    expect(releaseProductionReservationForOwner("W1N57", RESOURCE_ENERGY, owner).status).toBe("ok");
    if (a.status === "authorized") {
      expect(service.consumeTreasuryAuthorization(a.token).status).toBe("rejected");
    }
  });
});
