/**
 * Defense Focus-Fire Coordination Sidecar 测试（纯函数 planner + 持久化 +
 * 消费读取；全部使用 mock，不调用真实 Game API）。
 *
 * 覆盖：协同失败案例的确定性复现与修复断言、联合伤害预算（距离衰减 /
 * TOUGH/boost 有效伤害比 / 敌方治疗抵消 / 防御者输出）、过量伤害控制与
 * 次级目标分火、紧急治疗仲裁（重伤优先 + 塔数上限）、稳定排序与
 * tie-breaker、多房间隔离、fallback、快照单次性（CPU/opcount 约束）。
 */
import {
  planRoomEngagement,
  readRoomEngagementPlan,
  writeRoomEngagementPlan,
  clearRoomEngagementPlan,
  clearDefenseEngagementForTest,
  FOCUS_FIRE_KILL_OVERKILL_MARGIN,
  FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO,
  buildFocusFireRoomInput,
  type FocusFireRoomInput,
} from "@/runtime/defenseFocusFire";

/** 单塔满额伤害（TOWER_OPTIMAL_RANGE 内、无衰减）。 */
const TOWER_FULL = TOWER_POWER_ATTACK;

function hostileOf(overrides: Partial<Parameters<typeof planRoomEngagement>[0]["hostiles"][number]> & { id: string }) {
  return {
    x: 25,
    y: 25,
    hits: 500,
    hitsMax: 500,
    toughDamageRatio: 1,
    incomingHeal: 0,
    threat: 10,
    ...overrides,
  };
}

function towerOf(overrides: Partial<Parameters<typeof planRoomEngagement>[0]["towers"][number]> & { id: string }) {
  return { x: 25, y: 20, energy: 800, ...overrides };
}

function defenderOf(overrides: Partial<Parameters<typeof planRoomEngagement>[0]["defenders"][number]> & { id: string; slot: string }) {
  return { role: "primary" as const, x: 25, y: 26, meleeDamage: 0, rangedDamage: 0, ...overrides };
}

function baseInput(overrides: Partial<FocusFireRoomInput> = {}): FocusFireRoomInput {
  return {
    roomName: "W1N57",
    hostiles: [],
    towers: [],
    defenders: [],
    wounded: [],
    ...overrides,
  };
}

beforeEach(() => {
  clearDefenseEngagementForTest();
});

describe("联合伤害预算与主目标选择", () => {
  it("确定性复现协同失败案例：防御者输出计入预算后，Tower 与防御者锁定同一主目标", () => {
    // 场景：H_healer（伴随治疗 200/tick，body 威胁高）与 H_wounded（残血
    // 150hits 无治疗）。仅 1 塔时对两者净伤害：H_wounded 远高——plan 应把
    // 塔+防御者全部锁定 H_wounded（旧独立评分下防御者按 body 优先级可能
    // 选 H_healer 造成分裂）。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_healer", hits: 600, hitsMax: 600, incomingHeal: 200, threat: 40, x: 20, y: 25 }),
        hostileOf({ id: "h_wounded", hits: 650, hitsMax: 700, incomingHeal: 0, threat: 10, x: 22, y: 25 }),
      ],
      towers: [towerOf({ id: "t1", x: 22, y: 20 })],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: ATTACK_POWER * 4, x: 22, y: 26 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_wounded");
    expect(plan.towerAssignments.t1).toBe("h_wounded");
    expect(plan.defenderAssignments["0"]).toBe("h_wounded");
    // 预算 = 塔伤害（range 5 衰减后）×1 + 防御者近战（贴身）。
    expect(plan.focusAssignedDamage).toBeGreaterThan(0);
    expect(plan.focusExpectedHeal).toBe(0);
  });

  it("治疗全覆盖（净伤害 ≤ 0）→ fallback（focusTargetId=null + 原因）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", incomingHeal: TOWER_FULL * 5 })],
      towers: [towerOf({ id: "t1" })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBeNull();
    expect(plan.fallbackReason).toBe("no-net-positive-target");
    expect(plan.towerAssignments).toEqual({});
  });

  it("Tower 距离衰减参与预算：远距塔伤害低，主目标选择考虑实际衰减", () => {
    // 两敌同血量同威胁：近的那个（range 2）净伤害更高 → 主目标。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_far", x: 25, y: 40 }),
        hostileOf({ id: "h_near", x: 25, y: 22 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_near");
  });

  it("TOUGH/boost 有效伤害比折算预算（toughDamageRatio < 1 时净伤害相应下降）", () => {
    const full = planRoomEngagement(
      baseInput({ hostiles: [hostileOf({ id: "h_plain" })], towers: [towerOf({ id: "t1" })] }),
      100,
    );
    const tough = planRoomEngagement(
      baseInput({ hostiles: [hostileOf({ id: "h_plain", toughDamageRatio: 0.3 })], towers: [towerOf({ id: "t1" })] }),
      100,
    );
    expect(full.focusAssignedDamage).toBe(TOWER_FULL); // 塔位于最优射程内
    expect(tough.focusAssignedDamage).toBe(Math.round(TOWER_FULL * 0.3)); // 有效伤害比折算
    expect(tough.focusAssignedDamage).toBeLessThan(full.focusAssignedDamage);
  });
});

describe("过量伤害控制与次级分火", () => {
  it("主目标累计分配 ≥ hits × margin 后，追加 actor 分火次级目标", () => {
    // 残血主目标（80 hits）：第一塔即超过 kill 阈值——但首个 actor 恒定
    // 打主目标（focusAssignedDamage > 0 才触发 spill），后续塔分火次级。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_low", hits: 80, hitsMax: 600 }),
        hostileOf({ id: "h_second", hits: 500, hitsMax: 600, threat: 5 }),
      ],
      towers: [
        towerOf({ id: "t1" }),
        towerOf({ id: "t2" }),
        towerOf({ id: "t3" }),
      ],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_low");
    expect(plan.towerAssignments.t1).toBe("h_low");
    // t1 的伤害已超过 80 × 1.15，后续塔分火次级。
    expect(plan.towerAssignments.t2).toBe("h_second");
    expect(plan.towerAssignments.t3).toBe("h_second");
  });

  it("无次级候选时不浪费输出口（继续主目标）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h_only", hits: 80, hitsMax: 600 })],
      towers: [towerOf({ id: "t1" }), towerOf({ id: "t2" })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.towerAssignments.t1).toBe("h_only");
    expect(plan.towerAssignments.t2).toBe("h_only");
  });
});

describe("紧急治疗仲裁", () => {
  it("重伤 creep 优先占用塔，且紧急治疗塔数不超过攻击塔一半（cap ≥ 1）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", hits: 600 })],
      towers: [towerOf({ id: "t1" }), towerOf({ id: "t2" }), towerOf({ id: "t3" }), towerOf({ id: "t4" })],
      wounded: [
        { id: "w_critical", x: 25, y: 21, hits: 50, hitsMax: 1000 },
        { id: "w_light", x: 25, y: 22, hits: 999, hitsMax: 1000 },
      ],
    });
    const plan = planRoomEngagement(input, 100);
    const healTowers = Object.keys(plan.emergencyHealByTowerId);
    // 重伤优先：唯一紧急治疗塔服务 w_critical（cap = ceil(4 × 0.5) = 2，
    // 但缺口 950 只需 1 塔持续治疗——首塔即指派）。
    expect(healTowers.length).toBeGreaterThanOrEqual(1);
    expect(healTowers.length).toBeLessThanOrEqual(2);
    expect(plan.emergencyHealByTowerId[healTowers[0]]).toBe("w_critical");
    // 治疗塔不参与攻击分配。
    for (const towerId of healTowers) {
      expect(plan.towerAssignments[towerId]).toBeUndefined();
    }
  });

  it("轻伤（缺口低于阈值）不占用任何塔", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1" })],
      towers: [towerOf({ id: "t1" })],
      wounded: [{ id: "w_light", x: 25, y: 21, hits: Math.floor(600 * (1 - FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO)) + 100, hitsMax: 600 }],
    });
    const plan = planRoomEngagement(input, 100);
    expect(Object.keys(plan.emergencyHealByTowerId)).toHaveLength(0);
    expect(plan.towerAssignments.t1).toBe("h1");
  });
});

describe("确定性与稳定排序", () => {
  it("输入顺序打乱（任意来源顺序）产生完全相同的 plan", () => {
    const hostiles = [
      hostileOf({ id: "h_a", hits: 300 }),
      hostileOf({ id: "h_b", hits: 400, threat: 12 }),
      hostileOf({ id: "h_c", hits: 300 }),
    ];
    const towers = [towerOf({ id: "t_a" }), towerOf({ id: "t_b" }), towerOf({ id: "t_c" })];
    const defenders = [defenderOf({ id: "d_a", slot: "1" }), defenderOf({ id: "d_b", slot: "0" })];
    const first = planRoomEngagement(baseInput({ hostiles, towers, defenders }), 50);
    const second = planRoomEngagement(
      baseInput({
        hostiles: [...hostiles].reverse(),
        towers: [towers[2], towers[0], towers[1]],
        defenders: [...defenders].reverse(),
      }),
      50,
    );
    expect(second).toEqual(first);
  });

  it("评分平手以 id 字典序决胜（不依赖输入顺序）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h_z", hits: 300, threat: 10, x: 26, y: 25 }), hostileOf({ id: "h_a", hits: 300, threat: 10, x: 24, y: 25 })],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
    });
    const plan = planRoomEngagement(input, 100);
    // 两敌完全对称（同 range）——id 字典序小者胜。
    expect(plan.focusTargetId).toBe("h_a");
  });
});

describe("多房间隔离与持久化", () => {
  it("plan 按房间隔离存储；fresh 校验（过期 plan 不可消费）；清理生效", () => {
    const planA = planRoomEngagement(baseInput({ roomName: "W1N57", hostiles: [hostileOf({ id: "h1" })], towers: [towerOf({ id: "t1" })] }), Game.time);
    const planB = planRoomEngagement(baseInput({ roomName: "E2N41", hostiles: [hostileOf({ id: "h_other" })], towers: [towerOf({ id: "t9" })] }), Game.time);
    writeRoomEngagementPlan(planA);
    writeRoomEngagementPlan(planB);
    expect(readRoomEngagementPlan("W1N57")?.focusTargetId).toBe("h1");
    expect(readRoomEngagementPlan("E2N41")?.focusTargetId).toBe("h_other");
    expect(readRoomEngagementPlan("W0N0")).toBeNull();
    // 过期（非本 tick）→ 不可消费（消费方回退独立逻辑一次）。
    const stale = { ...planA, plannedAtTick: Game.time - 1 };
    writeRoomEngagementPlan(stale);
    expect(readRoomEngagementPlan("W1N57")).toBeNull();
    clearRoomEngagementPlan("W1N57");
    expect(readRoomEngagementPlan("W1N57")).toBeNull();
    expect(readRoomEngagementPlan("E2N41")).not.toBeNull();
  });
});

describe("快照采集（运行时）", () => {
  class MockPos {
    constructor(public x: number, public y: number) {}
    public getRangeTo(target: { pos?: { x: number; y: number } }): number {
      const p = target.pos ?? { x: (target as { x: number }).x, y: (target as { y: number }).y };
      return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y));
    }
  }

  function hostileCreep(id: string, x: number, y: number, body: BodyPartDefinition[], healParts = 0): Creep {
    return {
      id,
      pos: new MockPos(x, y) as unknown as RoomPosition,
      body,
      hits: 400,
      hitsMax: 400,
      getActiveBodyparts: (part: BodyPartConstant) =>
        part === HEAL ? healParts : body.filter((p) => p.type === part && p.hits > 0).length,
    } as unknown as Creep;
  }

  it("采集：TOUGH/boost 比、敌方 range-aware 治疗、防御者 boost 输出一次算好", () => {
    const towers = [
      {
        id: "t1" as Id<StructureTower>,
        pos: new MockPos(25, 20) as unknown as RoomPosition,
        store: { getUsedCapacity: () => 800 } as unknown as StoreDefinition,
      } as unknown as StructureTower,
    ];
    const hostiles = [
      // boosted TOUGH：toughDamageRatio < 1（calcEffectiveDamage 折算）。
      hostileCreep("h_tough", 25, 24, [
        { type: TOUGH, hits: 100, boost: "XGHO2" as ResourceConstant },
        { type: ATTACK, hits: 100 },
      ] as BodyPartDefinition[]),
      // healer：2 个 HEAL 部件贴身（range 1 → HEAL_POWER）。
      hostileCreep("h_healer", 25, 25, [{ type: HEAL, hits: 100 }, { type: HEAL, hits: 100 }] as BodyPartDefinition[], 2),
    ];
    const defenders = [
      {
        id: "d1" as Id<Creep>,
        name: "def-1",
        pos: new MockPos(25, 26) as unknown as RoomPosition,
        body: [{ type: ATTACK, hits: 100 }, { type: ATTACK, hits: 100 }] as BodyPartDefinition[],
      } as unknown as Creep,
    ];
    const input = buildFocusFireRoomInput({
      roomName: "W1N57",
      hostiles,
      towers,
      defenders,
      defenderSlots: { "def-1": "0" },
      defenderRoles: { "0": "primary" },
      wounded: [],
    });
    const tough = input.hostiles.find((h) => h.id === "h_tough")!;
    expect(tough.toughDamageRatio).toBeLessThan(1);
    // h_healer 贴身治疗自己（range 0 → 近程 HEAL_POWER × 2）。
    const healer = input.hostiles.find((h) => h.id === "h_healer")!;
    expect(healer.incomingHeal).toBe(HEAL_POWER * 2);
    const defender = input.defenders[0]!;
    expect(defender.meleeDamage).toBe(ATTACK_POWER * 2);
    expect(defender.slot).toBe("0");
  });
});

describe("常量与预算语义", () => {
  it("保守击杀裕度常量按任务书要求保守（≥1.1）", () => {
    expect(FOCUS_FIRE_KILL_OVERKILL_MARGIN).toBeGreaterThanOrEqual(1.1);
    expect(FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO).toBeGreaterThan(0);
    expect(FOCUS_FIRE_EMERGENCY_HEAL_MISSING_RATIO).toBeLessThan(1);
  });

  it("0 能量塔不参与攻击分配；plan 的塔分配可整体为空（仅防御者）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", hits: 100 })],
      towers: [towerOf({ id: "t_dry", energy: 0 })],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: ATTACK_POWER * 5, x: 25, y: 25 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h1");
    expect(plan.towerAssignments.t_dry).toBeUndefined();
    expect(plan.defenderAssignments["0"]).toBe("h1");
  });
});
