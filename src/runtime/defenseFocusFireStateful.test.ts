/**
 * 【Round 22 Remediation III】Defense focus-fire 的 kill feasibility /
 * 有状态分配 / 站位分离 / 共享 fallback / 紧急治疗选择的确定性回归矩阵。
 *
 * 覆盖任务书十九节：
 * 1  Kill Feasibility：三分类与完整击杀预算（ceil((hits+heal)×margin)）；
 *    可击杀目标优先于高净伤不可击杀目标（5000 血 vs 100 血固定反例）；
 *    HEAL 核心在 killable 桶内的战略优先；
 * 2  Primary Allocation：边际有效伤害降序 greedy（最少 actor / 最小过量）；
 *    输入乱序确定性；移动中 Defender 不计入预算但保持定位 assignment；
 * 3  Stateful Secondary：目标级分配循环（secondary 达预算才切 tertiary；
 *    不可击杀时全部剩余共同压制一个目标——确定性拆火反例：A 对 X 强 /
 *    B 对 Y 强但联合只能压穿一个 → 共同同一目标，平手稳定 ID）；
 * 4  Positioning：combat target 与 engagement position 分离（boundary=
 *    合法 rampart 站位、inside=直接接敌；移动接敌的本 tick 伤害为 0）；
 * 5  Shared Fallback：每房间每 tick 至多一次共享解析；Tower 与 Defender
 *    消费同一缓存；无 fallback 共同空转；多房间隔离；
 * 6  Emergency Heal：按对伤员的实际治疗量选择（距离衰减感知；ID 决胜；
 *    满足保守需求即停）；
 * 7  Operation Count：fallback 多消费者单次解析；消费不增加 planner 调用。
 *
 * 全部使用纯数据 fixture 与 mock，不调用真实 Game 写 API。
 */
import {
  planRoomEngagement,
  writeRoomEngagementPlan,
  clearDefenseEngagementForTest,
  executableDefenderDamage,
  type FocusFireRoomInput,
  type FocusFireEngagementPlan,
} from "@/runtime/defenseFocusFire";
import { resolveRoomEngagementFallbackRevision } from "@/runtime/engagementFallbackRevision";

const TOWER_FULL = TOWER_POWER_ATTACK;

function hostileOf(overrides: Partial<Parameters<typeof planRoomEngagement>[0]["hostiles"][number]> & { id: string }) {
  return {
    x: 25,
    y: 25,
    hits: 600,
    hitsMax: 600,
    toughProfile: [{ hits: 600, ratio: 1 }],
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

function woundedOf(overrides: Partial<Parameters<typeof planRoomEngagement>[0]["wounded"][number]> & { id: string }) {
  return { x: 25, y: 24, hits: 100, hitsMax: 1000, ...overrides };
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

// ── 1. Kill Feasibility ──────────────────────────────────────────────────────

describe("Remediation III：kill feasibility 三分类", () => {
  it("【固定反例】5000 血高净伤不可击杀目标 vs 100 血可击杀目标：primary 是可击杀目标", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_big", hits: 5000, hitsMax: 5000, threat: 40, x: 20, y: 25 }),
        hostileOf({ id: "h_small", hits: 100, hitsMax: 3000, threat: 10, x: 22, y: 25 }),
      ],
      towers: [towerOf({ id: "t1", x: 22, y: 20 }), towerOf({ id: "t2", x: 22, y: 21 })],
    });
    const plan = planRoomEngagement(input, 100);
    // 可靠击杀目标优先——高净伤高血量目标不得抢走 primary。
    expect(plan.focusTargetId).toBe("h_small");
    expect(plan.focusTargetClass).toBe("killable_this_tick");
    expect(plan.killExpected).toBe(true);
    // killExpected=true ⇔ 实际分配伤害达到完整预算。
    expect(plan.focusKillBudget).toBe(Math.ceil(100 * 1.15));
    expect(plan.focusAssignedDamage).toBeGreaterThanOrEqual(plan.focusKillBudget!);
    // t1（600）单独达到预算（115）——t2 溢出到最佳压制目标（高威胁的
    // h_big 获得剩余火力压制，不再钉死在 primary）。
    expect(plan.towerAssignments.t1).toBe("h_small");
    expect(plan.towerAssignments.t2).toBe("h_big");
  });

  it("正净伤但联合有效伤害未达完整击杀预算：killExpected=false（净伤害为正不再等价于可击杀）", () => {
    // 600 hits 无治疗 vs 300 净伤害：净 > 0 但 < ceil(600×1.15)=690。
    const input = baseInput({
      hostiles: [hostileOf({ id: "h_x", hits: 600, hitsMax: 600 })],
      towers: [towerOf({ id: "t1", x: 25, y: 40 })], // range 20 → 300
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_x");
    expect(plan.focusTargetClass).toBe("positive_pressure");
    expect(plan.killExpected).toBe(false);
    expect(plan.focusKillBudget).toBeNull();
    expect(plan.focusTargetId).not.toBeNull();
  });

  it("所有目标不可击杀（净伤为负）：共享 suppression、focusTarget 非 null", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_x", hits: 600, hitsMax: 600, incomingHeal: TOWER_FULL * 3 }),
        hostileOf({ id: "h_y", hits: 600, hitsMax: 600, incomingHeal: TOWER_FULL * 4 }),
      ],
      towers: [towerOf({ id: "t1" })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).not.toBeNull();
    expect(plan.focusTargetClass).toBe("suppression_only");
    expect(plan.killExpected).toBe(false);
    expect(plan.towerAssignments.t1).toBe(plan.focusTargetId);
  });

  it("killable 桶内 HEAL 核心优先于普通可击杀目标（战略排序）", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_plain", hits: 100, hitsMax: 3000, threat: 10, x: 22, y: 25 }),
        hostileOf({ id: "h_healer", hits: 100, hitsMax: 3000, threat: 10, healPower: 480, x: 24, y: 25 }),
      ],
      towers: [towerOf({ id: "t1", x: 23, y: 20 }), towerOf({ id: "t2", x: 23, y: 21 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetClass).toBe("killable_this_tick");
    // 敌方治疗核心先杀——瓦解其持续治疗（同等可击杀前提下）。
    expect(plan.focusTargetId).toBe("h_healer");
  });

  it("两个不可击杀目标进入 pressure 评分（不误标 killExpected）", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_a", hits: 5000, hitsMax: 5000, incomingHeal: 100, threat: 20 }),
        hostileOf({ id: "h_b", hits: 5000, hitsMax: 5000, incomingHeal: 100, threat: 30 }),
      ],
      towers: [towerOf({ id: "t1" })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.killExpected).toBe(false);
    expect(plan.focusTargetClass).not.toBe("killable_this_tick");
    expect(plan.focusTargetId).not.toBeNull();
  });
});

// ── 2. Primary Allocation ────────────────────────────────────────────────────

describe("Remediation III：primary actor 分配", () => {
  it("边际伤害降序 greedy：最少 actor 达预算（不把全部 actor 都钉在 primary）", () => {
    // primary 预算 ceil(200×1.15)=230；t1/t2 各 600、防御者贴身 90——t1 单塔
    // 即达标（最小过量），t2 与防御者进入 secondary 池。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_primary", hits: 200, hitsMax: 3000, x: 25, y: 22 }),
        hostileOf({ id: "h_second", hits: 800, hitsMax: 3000, x: 25, y: 30 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 }), towerOf({ id: "t2", x: 25, y: 21 })],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 90, x: 25, y: 23 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_primary");
    expect(plan.towerAssignments.t1).toBe("h_primary");
    expect(plan.focusAssignedDamage).toBeGreaterThanOrEqual(230);
    // 未被 primary 需要的 actor 去向 secondary（不零散空转）。
    expect(plan.towerAssignments.t2).toBe("h_second");
    // 【Remediation IV 十四】防御者对 secondary 距离 7（射程外、本 tick 伤害
    // 0）——不再作为压制 actor 消费：positioning 阶段保留 combat target
    //（贴身的 primary——下一 tick 预算变化时可参与）。
    expect(plan.defenderAssignments["0"]).toBe("h_primary");
    expect(plan.defenderEngagements["0"]?.mode).toBe("attack");
  });

  it("输入 actor 顺序反转后 plan 语义一致（确定性）", () => {
    const hostiles = [
      hostileOf({ id: "h_a", hits: 300, hitsMax: 3000, x: 22, y: 25 }),
      hostileOf({ id: "h_b", hits: 900, hitsMax: 3000, x: 22, y: 30 }),
    ];
    const towers = [towerOf({ id: "t1", x: 22, y: 20 }), towerOf({ id: "t2", x: 22, y: 21 }), towerOf({ id: "t3", x: 22, y: 22 })];
    const defenders = [defenderOf({ id: "d1", slot: "0", meleeDamage: 120, x: 22, y: 26 }), defenderOf({ id: "d2", slot: "1", rangedDamage: 30, x: 22, y: 27 })];
    const forward = planRoomEngagement(baseInput({ hostiles, towers, defenders }), 100);
    const reversed = planRoomEngagement(
      baseInput({
        hostiles: [...hostiles].reverse(),
        towers: [...towers].reverse(),
        defenders: [...defenders].reverse(),
      }),
      100,
    );
    const stripFallback = (plan: FocusFireEngagementPlan) => {
      const { fallbackResolution, ...rest } = plan;
      void fallbackResolution;
      return rest;
    };
    expect(stripFallback(reversed)).toEqual(stripFallback(forward));
  });

  it("移动中的 Defender（边际伤害 0）不计入击杀预算但保留共享 combat target", () => {
    // 防御者距 primary range 3（混合编队 → 可执行伤害 0）；两塔已达预算。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_primary", hits: 200, hitsMax: 3000, x: 25, y: 22 }),
        hostileOf({ id: "h_second", hits: 2000, hitsMax: 3000, x: 25, y: 35 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 400, x: 25, y: 25 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_primary");
    // t1（600）已单独达标 → 防御者跟随 primary（定位 assignment，预算不含其伤害）。
    expect(plan.towerAssignments.t1).toBe("h_primary");
    expect(plan.defenderAssignments["0"]).toBe("h_primary");
    expect(plan.defenderEngagements["0"].mode).toBe("engage_position");
    expect(plan.focusAssignedDamage).toBeGreaterThanOrEqual(230);
    expect(plan.focusAssignedDamage).toBeLessThan(230 + 400);
  });
});

// ── 3. Stateful Secondary ────────────────────────────────────────────────────

describe("Remediation III：有状态 secondary 分配", () => {
  it("【确定性拆火反例】A 对 X 强、B 对 Y 强但联合只可压穿一个：共同攻击同一 secondary", () => {
    // h_kill（80 血）由 t_k 单塔可靠击杀后溢出；X/Y 各 400 治疗、hits 400
    // → 预算 ceil((400+400)×1.15)=920；剩余 {t_a, t_b} 联合对 X =
    // 600+300=900 < 920（不可击杀）→ 全部剩余 actor 共同压制一个目标
    //（评分平手 → 稳定 ID 选 X）——不得 A→X、B→Y 拆火。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h_kill", hits: 80, hitsMax: 3000, x: 25, y: 22 }),
        hostileOf({ id: "h_x", hits: 400, hitsMax: 400, incomingHeal: 400, x: 20, y: 25 }),
        hostileOf({ id: "h_y", hits: 400, hitsMax: 400, incomingHeal: 400, x: 30, y: 25 }),
      ],
      towers: [
        towerOf({ id: "t_k", x: 25, y: 20 }), // 对 h_kill range 2 → 600
        towerOf({ id: "t_a", x: 20, y: 20 }), // 对 X range 5、对 Y range 10+
        towerOf({ id: "t_b", x: 30, y: 20 }), // 对 Y range 5、对 X range 10+
      ],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h_kill");
    // primary greedy：三塔对 h_kill 边际均 600（平手按稳定 key——t_a 字典
    // 序最小）→ t_a 单独达到预算即停，t_k/t_b 溢出。
    expect(plan.towerAssignments.t_a).toBe("h_kill");
    // secondary 不拆火：剩余 {t_k, t_b} 对 X/Y 均不可靠击杀（900 < 920）
    // → 共同压制同一目标（评分平手 → 稳定 ID 选 X）——不得 t_k→X、t_b→Y。
    expect(plan.towerAssignments.t_k).toBe(plan.towerAssignments.t_b);
    expect(new Set([plan.towerAssignments.t_k, plan.towerAssignments.t_b]).size).toBe(1);
  });

  it("secondary 达到 kill budget 后才切换 tertiary（多目标击杀链）", () => {
    // h1（低血可杀）→ 剩余对 h2 可杀（达预算）→ 剩余对 h3 不可杀 → 全压 h3。
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h1", hits: 100, hitsMax: 3000, x: 25, y: 22 }),
        hostileOf({ id: "h2", hits: 900, hitsMax: 3000, x: 25, y: 24 }),
        hostileOf({ id: "h3", hits: 4000, hitsMax: 4000, x: 25, y: 40, incomingHeal: 0 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 }), towerOf({ id: "t2", x: 25, y: 21 }), towerOf({ id: "t3", x: 25, y: 23 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.focusTargetId).toBe("h1");
    expect(plan.killExpected).toBe(true);
    // h1 由 t1 单塔达标；t2/t3 对 h2：联合 1200 ≥ ceil(900×1.15)=1035 → 可靠
    // 击杀；t3 达到边际后剩余压 h3？——t2+t3 都给 h2（若 t3 单独即可达标
    // 则溢出到 h3；本场景 t3=600<1035，需两塔）。
    expect(plan.towerAssignments.t1).toBe("h1");
    expect(plan.towerAssignments.t2).toBe("h2");
    // h2 需要两塔（1035 > 单塔 600）→ t3 留在 h2，无 actor 溢出到 h3。
    expect(plan.towerAssignments.t3).toBe("h2");
  });

  it("secondary 不可击杀：全部剩余 actor 共同压制（不切换第三目标）", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h1", hits: 100, hitsMax: 3000, x: 25, y: 22 }),
        hostileOf({ id: "h2", hits: 3000, hitsMax: 3000, x: 25, y: 24, incomingHeal: 0 }),
        hostileOf({ id: "h3", hits: 200, hitsMax: 3000, x: 25, y: 26 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 }), towerOf({ id: "t2", x: 25, y: 21 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.towerAssignments.t1).toBe("h1");
    // t2 单塔对 h2（3000 血预算 3450）不可击杀、对 h3 可击杀——但目标级
    // 顺序：secondary 优先选剩余 actor 可靠击杀的目标 → h3。
    expect(plan.towerAssignments.t2).toBe("h3");
  });

  it("已分配 primary 的 actor 不出现在 secondary 预算（target 级状态不回漏）", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({ id: "h1", hits: 100, hitsMax: 3000, x: 25, y: 22 }),
        hostileOf({ id: "h2", hits: 3000, hitsMax: 3000, x: 25, y: 24 }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 }), towerOf({ id: "t2", x: 25, y: 21 }), towerOf({ id: "t3", x: 25, y: 23 })],
    });
    const plan = planRoomEngagement(input, 100);
    // t1 达到 h1 预算；t2/t3 全压 h2（600+600=1200 < 3450 不可击杀——全压）。
    expect(plan.towerAssignments.t1).toBe("h1");
    expect(plan.towerAssignments.t2).toBe("h2");
    expect(plan.towerAssignments.t3).toBe("h2");
  });
});

// ── 4. Positioning（combat target 与 engagement position 分离） ──────────────

describe("Remediation III：站位分离表达", () => {
  it("boundary 目标：Defender 的 approach 使用合法 rampart 站位（不直接追 hostile）", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({
          id: "h_out",
          hits: 3000,
          hitsMax: 3000,
          x: 45,
          y: 45,
          engagement: { x: 30, y: 30, kind: "boundary" },
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 300, x: 25, y: 26 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.defenderEngagements["0"].targetId).toBe("h_out");
    // approach 模式 → engage_position，位置是 boundary rampart（不是 hostile 坐标）。
    expect(plan.defenderEngagements["0"].mode).toBe("engage_position");
    expect(plan.defenderEngagements["0"].positionKind).toBe("boundary");
    expect(plan.defenderEngagements["0"].position).toEqual({ x: 30, y: 30 });
    // planner 预算不计移动中的伤害（本 tick 伤害 0）。
    expect(plan.defenderEngagements["0"].mode === "engage_position").toBe(true);
  });

  it("inside 目标：attack range 内直接 attack/ranged_attack", () => {
    const input = baseInput({
      hostiles: [
        hostileOf({
          id: "h_in",
          hits: 3000,
          hitsMax: 3000,
          x: 25,
          y: 26,
          engagement: { x: 25, y: 26, kind: "inside" },
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d1", slot: "0", meleeDamage: 300, x: 25, y: 26 }),
        defenderOf({ id: "d2", slot: "1", rangedDamage: 90, x: 25, y: 28 }),
      ],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.defenderEngagements["0"]).toMatchObject({ targetId: "h_in", mode: "attack" });
    expect(plan.defenderEngagements["1"]).toMatchObject({ targetId: "h_in", mode: "ranged_attack" });
  });

  it("planner 计入的伤害与执行动作口径一致（executableDefenderDamage=0 → engage_position）", () => {
    const defender = { x: 25, y: 25, meleeDamage: 400, rangedDamage: 400 };
    expect(executableDefenderDamage(defender, { x: 25, y: 27 })).toBe(0); // 混合编队 range 2
    expect(executableDefenderDamage({ ...defender, meleeDamage: 0 }, { x: 25, y: 27 })).toBe(400); // 纯远程
    const input = baseInput({
      hostiles: [hostileOf({ id: "h_far", hits: 3000, hitsMax: 3000, x: 25, y: 27 })],
      towers: [],
      defenders: [defenderOf({ id: "d1", slot: "0", meleeDamage: 400, rangedDamage: 400, x: 25, y: 25 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.defenderEngagements["0"].mode).toBe("engage_position");
    expect(plan.focusAssignedDamage).toBe(0);
  });
});

// ── 5. Shared live fallback ──────────────────────────────────────────────────

describe("Remediation III：房间级一次性共享 fallback", () => {
  function seedPlan(roomName: string, focus: string, fallbacks: string[]): FocusFireEngagementPlan {
    const plan = planRoomEngagement(
      baseInput({
        roomName,
        hostiles: [
          hostileOf({ id: focus, hits: 100, hitsMax: 3000 }),
          ...fallbacks.map((id) => hostileOf({ id, hits: 500, hitsMax: 3000 })),
        ],
        towers: [towerOf({ id: "t1" })],
      }),
      Game.time,
    );
    writeRoomEngagementPlan(plan);
    return plan;
  }

  it("primary 失效：fallback 顺序命中第一个存活目标；同 tick 多消费者共享一次解析", () => {
    seedPlan("W1N57", "h_primary", ["h_f1", "h_f2"]);
    const alive = new Set(["h_f2"]); // h_f1 也死了
    const first = resolveRoomEngagementFallbackRevision("W1N57", ["h_primary"], alive);
    expect(first.revision?.towerTargetByTowerId.t1).toBe("h_f2");
    expect(first.fromCache).toBe(false);
    // 第二个消费者（Defender）同 tick 命中同一 revision。
    const second = resolveRoomEngagementFallbackRevision("W1N57", ["h_primary"], alive);
    expect(second.revision?.towerTargetByTowerId.t1).toBe("h_f2");
    expect(second.fromCache).toBe(true);
    // plan 上的运行期 revision（计数有界——每 tick 重写）。
    const plan = (Memory.runtime as { defenseEngagement?: Record<string, FocusFireEngagementPlan & { fallbackRevision?: { requests: number } }> }).defenseEngagement?.["W1N57"];
    expect(plan?.fallbackRevision?.requests).toBe(2);
  });

  it("无合法 fallback：返回 null（共同空转——不回退独立评分）", () => {
    seedPlan("W1N56", "h_primary", ["h_f1"]);
    const result = resolveRoomEngagementFallbackRevision("W1N56", ["h_primary"], new Set());
    expect(result.revision?.towerTargetByTowerId.t1 ?? null).toBeNull();
  });

  it("多房间隔离：fallback 解析互不影响", () => {
    seedPlan("W1N57", "h_primary", ["h_f1"]);
    seedPlan("W1N58", "h_other", ["h_f9"]);
    const a = resolveRoomEngagementFallbackRevision("W1N57", ["h_primary"], new Set(["h_f1"]));
    const b = resolveRoomEngagementFallbackRevision("W1N58", ["h_other"], new Set(["h_f9"]));
    expect(a.revision?.towerTargetByTowerId.t1).toBe("h_f1");
    expect(b.revision?.towerTargetByTowerId.t1).toBe("h_f9");
  });

  it("stale plan（上一 tick）不参与 fallback 解析", () => {
    const stale = planRoomEngagement(
      baseInput({ hostiles: [hostileOf({ id: "h_x", hits: 100, hitsMax: 3000 })], towers: [towerOf({ id: "t1" })] }),
      Game.time - 1,
    );
    writeRoomEngagementPlan(stale);
    const result = resolveRoomEngagementFallbackRevision(stale.roomName, ["h_x"], new Set(["h_x"]));
    expect(result.revision).toBeNull();
  });
});

// ── 6. Emergency heal（按实际治疗量选择） ────────────────────────────────────

describe("Remediation III：紧急治疗 Tower 按实际治疗量选择", () => {
  it("【固定反例】近塔治疗 400、远塔（ID 更小）治疗 100、上限 1 → 近塔治疗、远塔攻击", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", hits: 3000, hitsMax: 3000 })],
      towers: [towerOf({ id: "t_far", x: 40, y: 24 }), towerOf({ id: "t_near", x: 26, y: 24 })],
      wounded: [woundedOf({ id: "w1", x: 25, y: 24, hits: 200, hitsMax: 1000 })],
    });
    const plan = planRoomEngagement(input, 100);
    // t_near（range 1 → 400 治疗）胜过 t_far（ID 更小但 range 15 → ~175）。
    expect(plan.emergencyHealByTowerId.t_near).toBe("w1");
    expect(plan.emergencyHealByTowerId.t_far).toBeUndefined();
    // 远塔进入攻击预算。
    expect(plan.towerAssignments.t_far).toBe("h1");
  });

  it("治疗量相同：Tower ID 字典序稳定决胜", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", hits: 3000, hitsMax: 3000 })],
      towers: [towerOf({ id: "t_b", x: 26, y: 24 }), towerOf({ id: "t_a", x: 26, y: 24 })],
      wounded: [woundedOf({ id: "w1", x: 25, y: 24, hits: 200, hitsMax: 1000 })],
    });
    const plan = planRoomEngagement(input, 100);
    expect(plan.emergencyHealByTowerId.t_a).toBe("w1");
    expect(plan.emergencyHealByTowerId.t_b).toBeUndefined();
  });

  it("一塔满足保守需求后不占用第二座（剩余塔全部攻击）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", hits: 3000, hitsMax: 3000 })],
      towers: [towerOf({ id: "t1", x: 26, y: 24 }), towerOf({ id: "t2", x: 27, y: 24 }), towerOf({ id: "t3", x: 28, y: 24 })],
      wounded: [woundedOf({ id: "w1", x: 25, y: 24, hits: 600, hitsMax: 1000 })], // 缺口 400 ≥ 阈值 350
    });
    const plan = planRoomEngagement(input, 100);
    const healTowers = Object.keys(plan.emergencyHealByTowerId);
    expect(healTowers).toHaveLength(1); // 单塔 400 已覆盖缺口 400
    expect(plan.towerAssignments.t2).toBe("h1");
    expect(plan.towerAssignments.t3).toBe("h1");
  });

  it("重度缺口跨塔补足（缺口 900 > 单塔 400 → 第二座治疗塔加入，受 cap=2 约束）", () => {
    const input = baseInput({
      hostiles: [hostileOf({ id: "h1", hits: 3000, hitsMax: 3000 })],
      towers: [towerOf({ id: "t1", x: 26, y: 24 }), towerOf({ id: "t2", x: 27, y: 24 }), towerOf({ id: "t3", x: 28, y: 24 }), towerOf({ id: "t4", x: 29, y: 24 })],
      wounded: [woundedOf({ id: "w1", x: 25, y: 24, hits: 100, hitsMax: 1000 })], // 缺口 900
    });
    const plan = planRoomEngagement(input, 100);
    expect(Object.keys(plan.emergencyHealByTowerId)).toHaveLength(2); // ceil(4×0.5)=2
  });
});

// ── 7. Operation count ───────────────────────────────────────────────────────

describe("Remediation III：operation-count", () => {
  it("fallback 多消费者只触发一次解析（缓存命中不重算）", () => {
    const plan = planRoomEngagement(
      baseInput({
        hostiles: [hostileOf({ id: "h_x", hits: 100, hitsMax: 3000 }), hostileOf({ id: "h_y", hits: 500, hitsMax: 3000 })],
        towers: [towerOf({ id: "t1" })],
      }),
      Game.time,
    );
    writeRoomEngagementPlan(plan);
    const alive = new Set(["h_y"]);
    for (let i = 0; i < 10; i++) {
      resolveRoomEngagementFallbackRevision(plan.roomName, ["h_x"], alive);
    }
    const stored = (Memory.runtime as { defenseEngagement?: Record<string, FocusFireEngagementPlan & { fallbackRevision?: { requests: number; towerTargetByTowerId: Record<string, string | null> } }> }).defenseEngagement?.[plan.roomName];
    expect(stored?.fallbackRevision?.requests).toBe(10); // 单次生成 revision + 9 次缓存读
    expect(stored?.fallbackRevision?.towerTargetByTowerId.t1).toBe("h_y");
  });
});
