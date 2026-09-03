/**
 * 【Round 22 Remediation IV】front-aware defender allocation 的确定性
 * 回归矩阵（任务书十三～十八节）。
 *
 * 覆盖：
 * 1  Zero-primary-damage 再利用：对 Primary 本 tick 伤害为 0 的 Defender
 *    保留在 remaining 池重新评估 Secondary（不再作为 follower 提前消费）；
 *    全部伤害分配完成后进入 positioning（独立 rampart / hold）；
 * 2  Front eligibility：Defender 默认只处理 assigned front 的 hostile
 *    （kill feasibility 不计入其它 front 的 Defender；Tower 房间级）；
 * 3  Unique rampart：per-defender 唯一位置（不争抢同格；occupied 跳过；
 *    已站保留；候选不足 hold）；
 * 4  Front-aware fallback revision：一次房间级修订计划（front 约束与
 *    per-defender 位置保留；多 target 失效共享同一 revision）；
 * 5  Fresh plan authority：focusTargetId=null 也服从 plan（Tower emergency
 *    heal/idle；Defender hold 不回退独立评分）；
 * 6  确定性（输入乱序）与 operation-count（planner 单次调用、revision 单次
 *    生成）。
 *
 * planner 是纯函数——全部为快照数据驱动（不 mock Game 写 API）。
 */
import {
  planRoomEngagement,
  writeRoomEngagementPlan,
  clearDefenseEngagementForTest,
  readFocusFirePlannerStatsForTest,
  type FocusFireHostileSnapshot,
  type FocusFireTowerSnapshot,
  type FocusFireDefenderSnapshot,
  type FocusFireEngagementPlan,
} from "@/runtime/defenseFocusFire";
import {
  resolveRoomEngagementFallbackRevision,
  peekRoomEngagementFallbackRevision,
} from "@/runtime/engagementFallbackRevision";
import { allocateDefenderRampartPositions } from "@/runtime/defenderRampartAllocation";

function hostileOf(overrides: Partial<FocusFireHostileSnapshot> & { id: string }): FocusFireHostileSnapshot {
  return {
    x: 25,
    y: 25,
    hits: 600,
    hitsMax: 3000,
    toughProfile: [{ hits: 600, ratio: 1 }],
    incomingHeal: 0,
    threat: 10,
    ...overrides,
  };
}

function towerOf(overrides: Partial<FocusFireTowerSnapshot> & { id: string }): FocusFireTowerSnapshot {
  return { x: 25, y: 20, energy: 800, ...overrides };
}

function defenderOf(overrides: Partial<FocusFireDefenderSnapshot> & { id: string; slot: string }): FocusFireDefenderSnapshot {
  return { role: "primary", x: 25, y: 26, meleeDamage: 0, rangedDamage: 0, ...overrides };
}

function baseInput(overrides: Partial<Parameters<typeof planRoomEngagement>[0]> = {}): Parameters<typeof planRoomEngagement>[0] {
  return {
    roomName: "W1N57",
    hostiles: [],
    towers: [],
    defenders: [],
    wounded: [],
    ...overrides,
  };
}

function eligibleOf(ids: readonly string[]): ReadonlySet<string> {
  return new Set(ids);
}

beforeEach(() => {
  clearDefenseEngagementForTest();
});

// ── 1. Zero-primary-damage 再利用 ───────────────────────────────────────────

describe("Remediation IV 1：zero-primary-damage Defender 再利用", () => {
  it("【固定反例·精确布局】Defender 对 P range>1 伤害 0、对 S 贴身可击杀 → Tower→P、Defender→S", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [
          hostileOf({ id: "P", hits: 500, x: 25, y: 25 }),
          hostileOf({ id: "S", hits: 500, x: 27, y: 27 }),
        ],
        towers: [towerOf({ id: "t1", x: 25, y: 20 })],
        // Defender 在 (28,28)：对 P chebyshev 3（melee 需要 ≤1 → 0）；对 S
        // chebyshev 1 → melee 600 ≥ S 预算 575。
        defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 600, x: 28, y: 28 })],
      }),
      100,
    );
    expect(plan.towerAssignments.t1).toBe("P");
    expect(plan.defenderAssignments["0"]).toBe("S");
    expect(plan.defenderEngagements["0"]?.mode).toBe("attack");
  });

  it("Defender 对 P 伤害 0、对 S 为正但不足击杀 → 参与 S 的共同压制", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [
          hostileOf({ id: "P", hits: 500, x: 25, y: 25 }),
          hostileOf({ id: "S", hits: 2000, x: 27, y: 27 }),
        ],
        towers: [towerOf({ id: "t1", x: 25, y: 20 })],
        defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 600, x: 28, y: 28 })],
      }),
      100,
    );
    expect(plan.towerAssignments.t1).toBe("P");
    // S 不可击杀（预算 2300 > 600）→ 正伤害 Defender 全部压制 S。
    expect(plan.defenderAssignments["0"]).toBe("S");
  });

  it("Defender 对所有合法 target 均为 0 伤害 → positioning 阶段（engage_position/hold，不进入 kill budget）", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [
          hostileOf({ id: "P", hits: 500, x: 25, y: 25, engagement: { x: 24, y: 24, kind: "inside" } }),
          hostileOf({ id: "S", hits: 500, x: 30, y: 30 }),
        ],
        towers: [towerOf({ id: "t1", x: 25, y: 20 })],
        // 纯近战 Defender 距 P range 3、距 S range 5 → 本 tick 全 0。
        defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 600, x: 28, y: 28 })],
      }),
      100,
    );
    // 零伤害 Defender 不进入任何 kill budget（Tower 单独判定 P 可击杀）。
    expect(plan.killExpected).toBe(true);
    expect(plan.focusAssignedDamage).toBeGreaterThanOrEqual(575);
    // positioning：保留 combat target（eligible 顺序首位 P）+ engage_position。
    expect(plan.defenderEngagements["0"]?.targetId).toBe("P");
    expect(plan.defenderEngagements["0"]?.mode).toBe("engage_position");
  });

  it("输入顺序反转 → 分配语义相同（确定性）", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "P", hits: 500, x: 25, y: 25 }),
        hostileOf({ id: "S", hits: 500, x: 27, y: 27 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 600, x: 28, y: 28 })],
    });
    const a = planRoomEngagement(input, 100);
    const b = planRoomEngagement(
      { ...input, hostiles: [...input.hostiles].reverse(), defenders: [...input.defenders].reverse() },
      100,
    );
    expect(a.defenderAssignments).toEqual(b.defenderAssignments);
    expect(a.towerAssignments).toEqual(b.towerAssignments);
  });
});

// ── 2. Front eligibility ────────────────────────────────────────────────────

describe("Remediation IV 2：front eligibility（Defender 默认本 front；Tower 房间级）", () => {
  function twoFrontInput() {
    return baseInput({
      hostiles: [
        // 北 front（P，Tower 可杀）。
        hostileOf({ id: "north_1", hits: 500, x: 25, y: 10 }),
        // 南 front。
        hostileOf({ id: "south_1", hits: 500, x: 25, y: 40 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 25 })],
      defenders: [
        defenderOf({
          id: "dN", slot: "0", meleeDamage: 600, x: 25, y: 11,
          frontId: "front:0", eligibleHostileIds: eligibleOf(["north_1"]),
        }),
        defenderOf({
          id: "dS", slot: "1", meleeDamage: 600, x: 25, y: 39,
          frontId: "front:1", eligibleHostileIds: eligibleOf(["south_1"]),
        }),
      ],
    });
  }

  it("两 front 各一 Defender 一 hostile → 各守本 front（不跨 front 迁移）", () => {
    const plan = planRoomEngagement(twoFrontInput(), 100);
    expect(plan.defenderAssignments["0"]).toBe("north_1");
    expect(plan.defenderAssignments["1"]).toBe("south_1");
  });

  it("北 front 目标只有借南 front Defender 才可击杀 → 不得分类为 killable（borrow 不虚构 burst）", () => {
    const input = baseInput({
      hostiles: [
        // 北 front 高血量：北 Defender（贴身 90）+ Tower（range ~15 → ~340）
        // 联合 <ceil(2000×1.15)=2300 → 不可击杀。南 Defender（600）足以
        // 补足，但跨 front 不可计入。
        hostileOf({ id: "north_heavy", hits: 2000, x: 25, y: 10 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 25 })],
      defenders: [
        defenderOf({ id: "dN", slot: "0", meleeDamage: 90, x: 25, y: 11, frontId: "front:0", eligibleHostileIds: eligibleOf(["north_heavy"]) }),
        defenderOf({ id: "dS", slot: "1", meleeDamage: 600, x: 25, y: 12, frontId: "front:1", eligibleHostileIds: eligibleOf([]) }),
      ],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetClass).not.toBe("killable_this_tick");
    // 南 Defender 对北 front 目标零伤害（eligible 排除）→ positioning。
    expect(plan.defenderEngagements["1"]?.mode).toBe("hold");
  });

  it("Primary 位于北 front → 南 Defender 不得跟随 Primary（保持南 front）", () => {
    const plan = planRoomEngagement(twoFrontInput(), 100);
    expect(plan.focusTargetId).toBe("north_1");
    expect(plan.defenderAssignments["1"]).toBe("south_1");
  });

  it("未分配 front 的 Defender → room-scope 保守默认（可处理全部 hostiles）", () => {
    const input = twoFrontInput();
    const revisedDefenders = [
      defenderOf({ id: "dN", slot: "0", meleeDamage: 600, x: 25, y: 11, frontId: "front:0", eligibleHostileIds: eligibleOf(["north_1"]) }),
      defenderOf({ id: "dFree", slot: "1", meleeDamage: 600, x: 25, y: 39 }),
    ];
    const plan = planRoomEngagement({ ...input, defenders: revisedDefenders }, 100);
    expect(plan.defenderAssignments["0"]).toBe("north_1");
    expect(plan.defenderAssignments["1"]).toBe("south_1");
  });

  it("front 输入顺序改变（hostile 顺序反转）→ 结果不变", () => {
    const a = planRoomEngagement(twoFrontInput(), 100);
    const input = twoFrontInput();
    const b = planRoomEngagement({ ...input, hostiles: [...input.hostiles].reverse() }, 100);
    expect(a.defenderAssignments).toEqual(b.defenderAssignments);
  });
});

// ── 3. Unique rampart ───────────────────────────────────────────────────────

describe("Remediation IV 3：per-defender 唯一 Rampart 分配", () => {
  function boundaryInput(defenderCount: number) {
    const hostiles = [
      hostileOf({
        id: "P", hits: 500, x: 10, y: 25,
        engagement: { x: 20, y: 25, kind: "boundary" },
        engagementCandidates: [
          { id: "r1", x: 20, y: 25 },
          { id: "r2", x: 20, y: 26 },
          { id: "r3", x: 20, y: 27 },
        ],
      }),
    ];
    const defenders = Array.from({ length: defenderCount }, (_, i) =>
      defenderOf({ id: `d${i}`, slot: String(i), meleeDamage: 30, x: 25 + i, y: 25, role: i === 0 ? "primary" : "secondary" }),
    );
    return baseInput({ hostiles, defenders, towers: [towerOf({ id: "t1", x: 25, y: 20 })] });
  }

  it("两名 Defender 同 target → 分配两个不同 Rampart", () => {
    const plan = planRoomEngagement(boundaryInput(2), 100);
    const pos0 = plan.defenderEngagements["0"]?.position;
    const pos1 = plan.defenderEngagements["1"]?.position;
    expect(pos0).toBeDefined();
    expect(pos1).toBeDefined();
    expect(`${pos0!.x},${pos0!.y}`).not.toBe(`${pos1!.x},${pos1!.y}`);
  });

  it("三名 Defender → 所有可分配位置唯一", () => {
    const plan = planRoomEngagement(boundaryInput(3), 100);
    const positions = ["0", "1", "2"].map((slot) => {
      const pos = plan.defenderEngagements[slot]?.position;
      expect(pos).toBeDefined();
      return `${pos!.x},${pos!.y}`;
    });
    expect(new Set(positions).size).toBe(3);
  });

  it("Rampart 少于 Defender → 未分配者明确 hold（不重复位置、不追逐边界外）", () => {
    const plan = planRoomEngagement(boundaryInput(4), 100);
    const engagements = ["0", "1", "2", "3"].map((slot) => plan.defenderEngagements[slot]);
    const positioned = engagements.filter((e) => e?.mode === "engage_position");
    const held = engagements.filter((e) => e?.mode === "hold");
    expect(positioned.length).toBe(3);
    expect(held.length).toBe(1);
    const keys = positioned.map((e) => `${e!.position!.x},${e!.position!.y}`);
    expect(new Set(keys).size).toBe(3);
  });

  it("候选顺序反转 → per-slot 结果相同（确定性）", () => {
    const a = planRoomEngagement(boundaryInput(3), 100);
    const input = boundaryInput(3);
    const revisedHostiles = input.hostiles.map((h, i) =>
      i === 0 ? { ...h, engagementCandidates: [...h.engagementCandidates!].reverse() } : h,
    );
    const b = planRoomEngagement({ ...input, hostiles: revisedHostiles }, 100);
    for (const slot of ["0", "1", "2"]) {
      expect(a.defenderEngagements[slot]?.position).toEqual(b.defenderEngagements[slot]?.position);
    }
  });

  it("allocate：occupied 候选跳过；已站候选保留", () => {
    const allocation = allocateDefenderRampartPositions({
      defenders: [
        { slot: "0", role: "primary", x: 20, y: 25, targetId: "P" },
        { slot: "1", role: "secondary", x: 25, y: 25, targetId: "P" },
      ],
      candidatesByTargetId: {
        P: [
          { id: "r1", x: 20, y: 25 },
          { id: "r2", x: 20, y: 26, occupied: true },
          { id: "r3", x: 20, y: 27 },
        ],
      },
      targetPositionById: { P: { x: 10, y: 25 } },
    });
    // slot0 已站在 r1（保留）；slot1 跳过 occupied r2 → r3。
    expect(`${allocation["0"]!.x},${allocation["0"]!.y}`).toBe("20,25");
    expect(`${allocation["1"]!.x},${allocation["1"]!.y}`).toBe("20,27");
  });

  it("primary 与 secondary 平手 → primary 获得更优位置", () => {
    const allocation = allocateDefenderRampartPositions({
      defenders: [
        { slot: "1", role: "secondary", x: 25, y: 25, targetId: "P" },
        { slot: "0", role: "primary", x: 25, y: 25, targetId: "P" },
      ],
      candidatesByTargetId: {
        P: [
          { id: "rA", x: 20, y: 25 },
          { id: "rB", x: 20, y: 26 },
        ],
      },
      targetPositionById: { P: { x: 10, y: 25 } },
    });
    // rA 距目标更近 → primary（slot 0）优先获得。
    expect(`${allocation["0"]!.x},${allocation["0"]!.y}`).toBe("20,25");
    expect(`${allocation["1"]!.x},${allocation["1"]!.y}`).toBe("20,26");
  });
});

// ── 4. Front-aware fallback revision ────────────────────────────────────────

describe("Remediation IV 4：房间级 fallback revision（front 约束保留）", () => {
  function seedMultiFrontPlan(): FocusFireEngagementPlan {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [
          hostileOf({ id: "north_1", hits: 500, x: 25, y: 10 }),
          hostileOf({ id: "north_2", hits: 500, x: 26, y: 10 }),
          hostileOf({ id: "south_1", hits: 500, x: 25, y: 40 }),
        ],
        towers: [towerOf({ id: "t1", x: 25, y: 25 })],
        defenders: [
          defenderOf({ id: "dN", slot: "0", meleeDamage: 600, x: 25, y: 11, frontId: "front:0", eligibleHostileIds: eligibleOf(["north_1", "north_2"]) }),
          defenderOf({ id: "dS", slot: "1", meleeDamage: 600, x: 25, y: 39, frontId: "front:1", eligibleHostileIds: eligibleOf(["south_1"]) }),
        ],
      }),
      Game.time,
    );
    writeRoomEngagementPlan(plan);
    return plan;
  }

  it("北 front 原目标失效：北 Defender 转向北替代；南 Defender 保持原 target；Tower 按房间级 revision 支援", () => {
    seedMultiFrontPlan();
    const { revision } = resolveRoomEngagementFallbackRevision(
      "W1N57",
      ["north_1"],
      new Set(["north_2", "south_1"]),
    );
    expect(revision).not.toBeNull();
    expect(revision!.defenderEngagementBySlot["0"].targetId).toBe("north_2");
    expect(revision!.defenderEngagementBySlot["1"].targetId).toBe("south_1");
    expect(revision!.towerTargetByTowerId.t1).toBe("north_2");
  });

  it("南 Defender 先请求 → 北 Defender 不被错误转到南 front", () => {
    seedMultiFrontPlan();
    // 南目标失效（假设）：南 Defender 无 front-local 替代 → hold；北保持。
    const { revision } = resolveRoomEngagementFallbackRevision(
      "W1N57",
      ["south_1"],
      new Set(["north_1", "north_2"]),
    );
    expect(revision!.defenderEngagementBySlot["1"].targetId).toBeNull();
    expect(revision!.defenderEngagementBySlot["0"].targetId).toBe("north_1");
  });

  it("多个 assigned target 同时失效 → 只生成一次 revision；后续 consumer 读缓存", () => {
    seedMultiFrontPlan();
    const alive = new Set(["north_2"]);
    const first = resolveRoomEngagementFallbackRevision("W1N57", ["north_1", "south_1"], alive);
    expect(first.fromCache).toBe(false);
    const second = resolveRoomEngagementFallbackRevision("W1N57", ["north_1"], alive);
    expect(second.fromCache).toBe(true);
    expect(peekRoomEngagementFallbackRevision("W1N57")?.requests).toBe(2);
    // 同一 revision：两个消费方看到一致的修订。
    expect(second.revision).toBe(first.revision);
  });

  it("第一个请求来自 Tower、第二个来自 Defender → revision 相同", () => {
    seedMultiFrontPlan();
    const alive = new Set(["south_1"]);
    const towerView = resolveRoomEngagementFallbackRevision("W1N57", ["north_1"], alive);
    const defenderView = resolveRoomEngagementFallbackRevision("W1N57", ["north_1"], alive);
    expect(towerView.revision!.towerTargetByTowerId.t1).toBe("south_1");
    expect(defenderView.revision).toBe(towerView.revision);
  });

  it("无任何存活 hostile → Tower 与 Defender 全部 null（共同 idle）", () => {
    seedMultiFrontPlan();
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["north_1"], new Set());
    expect(revision!.towerTargetByTowerId.t1).toBeNull();
    expect(revision!.defenderEngagementBySlot["0"].targetId).toBeNull();
    expect(revision!.defenderEngagementBySlot["1"].targetId).toBeNull();
  });

  it("多房间同时 fallback → 完全隔离", () => {
    seedMultiFrontPlan();
    const other = planRoomEngagement(
      baseInput({
        roomName: "W2N57",
        hostiles: [hostileOf({ id: "other_1", hits: 500, x: 25, y: 10 }), hostileOf({ id: "other_2", hits: 500, x: 26, y: 10 })],
        towers: [towerOf({ id: "t9", x: 25, y: 25 })],
      }),
      Game.time,
    );
    writeRoomEngagementPlan(other);
    resolveRoomEngagementFallbackRevision("W1N57", ["north_1"], new Set(["north_2"]));
    const b = resolveRoomEngagementFallbackRevision("W2N57", ["other_1"], new Set(["other_2"]));
    expect(b.revision!.towerTargetByTowerId.t9).toBe("other_2");
    expect(peekRoomEngagementFallbackRevision("W1N57")?.towerTargetByTowerId.t1).toBe("north_2");
  });
});

// ── 5. Fresh plan authority ─────────────────────────────────────────────────

describe("Remediation IV 5：fresh plan 是消费权威（focusTargetId=null 也服从）", () => {
  it("no-hostile plan：全部参与 Defender 获得显式 hold（不缺 assignment）", () => {
    const plan = planRoomEngagement(
      baseInput({ defenders: [defenderOf({ id: "d1", slot: "0" })] }),
      100,
    );
    expect(plan.focusTargetId).toBeNull();
    expect(plan.defenderEngagements["0"]).toEqual({ targetId: null, mode: "hold" });
    expect(plan.defenderFronts).toEqual({});
  });

  it("no-attack-actor plan：Defender hold + front 约束持久化", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [hostileOf({ id: "h1", hits: 500 })],
        towers: [towerOf({ id: "t1", energy: 0 })],
        defenders: [defenderOf({ id: "d1", slot: "0", frontId: "front:0", eligibleHostileIds: eligibleOf(["h1"]) })],
      }),
      100,
    );
    // Defender 无伤害部件（melee/ranged 全 0）→ 塔全低能量：主目标仍是
    // 唯一 hostile（suppression 压制）；Defender positioning hold（本 tick
    // 伤害 0、combat target 保留）。
    expect(plan.focusTargetId).toBe("h1");
    expect(plan.focusTargetClass).toBe("suppression_only");
    // 无站位信息（h1 无 engagement/candidates）→ engage_position 不带
    // 位置（消费侧按既有规则直接接敌）；combat target 与 front 约束保留。
    expect(plan.defenderEngagements["0"]?.mode).toBe("engage_position");
    expect(plan.defenderEngagements["0"]?.position).toBeUndefined();
    expect(plan.defenderFronts["0"]?.eligibleTargetIds).toEqual(["h1"]);
  });

  it("plan 携带 per-defender 位置（boundary target 的 positioning 分配唯一格）", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [
          hostileOf({
            id: "h1", hits: 500, x: 10, y: 25,
            engagement: { x: 20, y: 25, kind: "boundary" },
            engagementCandidates: [{ id: "r1", x: 20, y: 25 }, { id: "r2", x: 20, y: 26 }],
          }),
        ],
        defenders: [
          defenderOf({ id: "d1", slot: "0", meleeDamage: 30, x: 30, y: 25 }),
          defenderOf({ id: "d2", slot: "1", meleeDamage: 30, x: 31, y: 25, role: "secondary" }),
        ],
      }),
      100,
    );
    const pos0 = plan.defenderEngagements["0"]?.position;
    const pos1 = plan.defenderEngagements["1"]?.position;
    expect(pos0).toBeDefined();
    expect(pos1).toBeDefined();
    expect(`${pos0!.x},${pos0!.y}`).not.toBe(`${pos1!.x},${pos1!.y}`);
  });
});

// ── 6. Operation count ──────────────────────────────────────────────────────

describe("Remediation IV 6：operation-count", () => {
  it("多 Defender 快照只构建一次 plan（planner 单次调用）", () => {
    const before = readFocusFirePlannerStatsForTest().invocations;
    planRoomEngagement(
      baseInput({
        hostiles: [hostileOf({ id: "h1", hits: 500 })],
        towers: [towerOf({ id: "t1" })],
        defenders: Array.from({ length: 6 }, (_, i) => defenderOf({ id: `d${i}`, slot: String(i), x: 25 + i, y: 26 })),
      }),
      100,
    );
    expect(readFocusFirePlannerStatsForTest().invocations).toBe(before + 1);
  });

  it("多 consumer fallback 只生成一次 revision（缓存计数有界）", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [hostileOf({ id: "h1", hits: 500 }), hostileOf({ id: "h2", hits: 500 })],
        towers: [towerOf({ id: "t1" })],
      }),
      Game.time,
    );
    writeRoomEngagementPlan(plan);
    for (let i = 0; i < 10; i++) {
      resolveRoomEngagementFallbackRevision("W1N57", ["h1"], new Set(["h2"]));
    }
    expect(peekRoomEngagementFallbackRevision("W1N57")?.requests).toBe(10);
    expect(peekRoomEngagementFallbackRevision("W1N57")?.towerTargetByTowerId.t1).toBe("h2");
  });
});
