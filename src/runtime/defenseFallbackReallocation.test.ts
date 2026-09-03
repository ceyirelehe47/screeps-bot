/**
 * 【Round 22 Remediation V 十/十一】Fallback Position Reallocation & Plan
 * Coverage 的固定反例矩阵。
 *
 * 十、fallback revision 的房间级 per-defender 独立位置重新分配：
 * - 不再把 target-level 单一位置复制给多个 Defender（revision 生成时对
 *   整个房间 Defender 集合重新执行 allocateDefenderRampartPositions）；
 * - unaffected Defender 的原独立位置优先保留（不被替代分配抢占）；
 * - occupied candidate 跳过；候选不足明确 hold（不追逐边界外）；
 * - inside target 的 action mode 由消费方按当前距离重算（revision 不携带
 *   复制的原 mode 位置）；
 * - Tower-first / Defender-first 得到同一 revision；输入顺序反转稳定。
 *
 * 十一、fresh plan 缺 assignment 默认 hold：
 * - planner slot 只用 canonical config slot（不再以 creep name 回落）；
 * - fresh plan 存在但本 slot 无 entry → hold（不 attack/rangedAttack/moveTo）；
 * - 只有显式 participation=not_participating 允许旧独立行为；
 * - stale plan / 无 plan 保留旧安全 fallback。
 */

import {
  planRoomEngagement,
  writeRoomEngagementPlan,
  clearDefenseEngagementForTest,
  type FocusFireHostileSnapshot,
  type FocusFireTowerSnapshot,
  type FocusFireDefenderSnapshot,
} from "@/runtime/defenseFocusFire";
import {
  resolveRoomEngagementFallbackRevision,
} from "@/runtime/engagementFallbackRevision";
import { homeDefenderRole } from "@/roles/homeDefender";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import { moveToTarget } from "@/roles/shared";

jest.mock("@/runtime/safeZone", () => ({ getSafeZone: jest.fn() }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: jest.fn((fn: () => unknown) => fn()),
  measureCreepIntent: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("@/runtime/defenseCoordination", () => ({
  getAssignedDefenseFront: jest.fn(),
  getDefenderRole: jest.fn(),
  getTowerFocusFront: jest.fn(),
}));
jest.mock("@/runtime/defenseMode", () => ({ getPlayerHostiles: jest.fn() }));
jest.mock("@/runtime/safeZoneHelpers", () => ({
  createSafeZoneCostCallback: jest.fn(() => jest.fn()),
  getBoundaryRamparts: jest.fn(),
}));
jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

function hostileOf(overrides: Partial<FocusFireHostileSnapshot> & { id: string }): FocusFireHostileSnapshot {
  return {
    x: 25, y: 25, hits: 600, hitsMax: 3000,
    toughProfile: [{ hits: 600, ratio: 1 }],
    incomingHeal: 0, threat: 10,
    ...overrides,
  };
}
function towerOf(overrides: Partial<FocusFireTowerSnapshot> & { id: string }): FocusFireTowerSnapshot {
  return { x: 25, y: 20, energy: 800, ...overrides };
}
function defenderOf(overrides: Partial<FocusFireDefenderSnapshot> & { id: string; slot: string }): FocusFireDefenderSnapshot {
  return { role: "primary", x: 25, y: 26, meleeDamage: 0, rangedDamage: 0, ...overrides };
}

/**
 * 两名同 front Defender（不同原独立位置）+ 替代 boundary target 的
 * 候选集合（r1/r2/r3）。原目标 T1 失效 → 两者 fallback 到 T2（boundary）。
 */
function seedTwoDefenderFallbackPlan() {
  const plan = planRoomEngagement({
    roomName: "W1N57",
    hostiles: [
      hostileOf({ id: "T1", hits: 500, x: 20, y: 25, engagement: { x: 20, y: 25, kind: "boundary" } }),
      hostileOf({
        id: "T2", hits: 500, x: 22, y: 25,
        engagement: { x: 24, y: 25, kind: "boundary" },
        engagementCandidates: [
          { id: "r1", x: 24, y: 25 },
          { id: "r2", x: 24, y: 26 },
          { id: "r3", x: 24, y: 27 },
        ],
      }),
    ],
    towers: [towerOf({ id: "t1", x: 25, y: 20 })],
    defenders: [
      defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
      defenderOf({ id: "d1", slot: "1", x: 24, y: 26 }),
    ],
    wounded: [],
  }, Game.time);
  writeRoomEngagementPlan(plan);
  return plan;
}

beforeEach(() => {
  clearDefenseEngagementForTest();
});

// ── 十、fallback 重新分配独立 Rampart ───────────────────────────────────────

describe("Remediation V 十：fallback revision 的 per-defender 位置重新分配", () => {
  it("A：两名 Defender 原位置不同、同 front 目标失效 → 替代 target 的 r1/r2/r3 中获得不同 revised position", () => {
    seedTwoDefenderFallbackPlan();
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    expect(revision).not.toBeNull();
    const p0 = revision!.defenderEngagementBySlot["0"];
    const p1 = revision!.defenderEngagementBySlot["1"];
    expect(p0.targetId).toBe("T2");
    expect(p1.targetId).toBe("T2");
    expect(p0.position).toBeDefined();
    expect(p1.position).toBeDefined();
    expect(`${p0.position!.x},${p0.position!.y}`).not.toBe(`${p1.position!.x},${p1.position!.y}`);
  });

  it("B：unaffected Defender 保留原独立位置，fallback Defender 不得抢占", () => {
    // d0 的 front 只含 T2（retained）；d1 的 front 只含 T1（失效 → fallback
    // 到 T2 的候选，排除 d0 已占位置）。
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({ id: "T1", hits: 500, x: 20, y: 25, engagement: { x: 24, y: 25, kind: "boundary" } }),
        hostileOf({
          id: "T2", hits: 500, x: 22, y: 25,
          engagement: { x: 24, y: 26, kind: "boundary" },
          engagementCandidates: [
            { id: "rA", x: 24, y: 25 },
            { id: "rB", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d0", slot: "0", x: 30, y: 25, frontId: "front:0", eligibleHostileIds: new Set(["T2"]) }),
        defenderOf({ id: "d1", slot: "1", x: 30, y: 26, frontId: "front:1", eligibleHostileIds: new Set(["T1", "T2"]) }),
      ],
      wounded: [],
    }, Game.time);
    writeRoomEngagementPlan(plan);
    const d0Original = plan.defenderEngagements["0"].position;
    expect(d0Original).toBeDefined();
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T1", "T2"]));
    // d0 unaffected：保留原独立位置。
    expect(revision!.defenderEngagementBySlot["0"].targetId).toBe("T2");
    expect(revision!.defenderEngagementBySlot["0"].position).toEqual(d0Original);
    // d1 fallback 到 T2：不得抢占 d0 已占位置。
    const d1 = revision!.defenderEngagementBySlot["1"];
    expect(d1.targetId).toBe("T2");
    expect(d1.position).toBeDefined();
    expect(`${d1.position!.x},${d1.position!.y}`).not.toBe(`${d0Original!.x},${d0Original!.y}`);
  });

    it("C：候选少于 Defender → 多余 Defender hold、任何 revised 坐标不重复", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({ id: "T1", hits: 500, x: 20, y: 25, engagement: { x: 24, y: 25, kind: "boundary" } }),
        hostileOf({
          id: "T2", hits: 500, x: 22, y: 25,
          engagement: { x: 24, y: 26, kind: "boundary" },
          engagementCandidates: [{ id: "only1", x: 24, y: 26 }],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d0", slot: "0", x: 30, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 30, y: 26 }),
      ],
      wounded: [],
    }, Game.time);
    writeRoomEngagementPlan(plan);
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    const slots = ["0", "1"].map((s) => revision!.defenderEngagementBySlot[s]);
    const positioned = slots.filter((e) => e.mode === "engage_position" && e.position !== undefined);
    const held = slots.filter((e) => e.mode === "hold");
    expect(positioned.length).toBe(1);
    expect(held.length).toBe(1);
    const keys = positioned.map((e) => `${e.position!.x},${e.position!.y}`);
    expect(new Set(keys).size).toBe(positioned.length);
  });

  it("D：occupied candidate 跳过（他属占用标记）", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({ id: "T1", hits: 500, x: 20, y: 25, engagement: { x: 24, y: 25, kind: "boundary" } }),
        hostileOf({
          id: "T2", hits: 500, x: 22, y: 25,
          engagement: { x: 24, y: 26, kind: "boundary" },
          engagementCandidates: [
            { id: "occ", x: 24, y: 26, occupied: true },
            { id: "free", x: 24, y: 27 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [defenderOf({ id: "d0", slot: "0", x: 30, y: 25 })],
      wounded: [],
    }, Game.time);
    writeRoomEngagementPlan(plan);
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    const d0 = revision!.defenderEngagementBySlot["0"];
    expect(d0.mode).toBe("engage_position");
    expect(`${d0.position!.x},${d0.position!.y}`).toBe("24,27");
  });

  it("E：fallback 到 inside target → revision 不携带复制的位置/mode（消费方按距离重算）", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({ id: "T1", hits: 500, x: 20, y: 25, engagement: { x: 24, y: 25, kind: "boundary" } }),
        hostileOf({ id: "T2", hits: 500, x: 25, y: 25, engagement: { x: 25, y: 25, kind: "inside" } }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [defenderOf({ id: "d0", slot: "0", x: 30, y: 25 })],
      wounded: [],
    }, Game.time);
    writeRoomEngagementPlan(plan);
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    const d0 = revision!.defenderEngagementBySlot["0"];
    expect(d0.targetId).toBe("T2");
    // inside：不复制原目标的 boundary position——kind 标记 inside、无坐标。
    expect(d0.position).toBeUndefined();
    expect(d0.positionKind).toBe("inside");
  });

  it("F：Tower-first 与 Defender-first 得到同一 revision 对象", () => {
    seedTwoDefenderFallbackPlan();
    const towerView = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    const defenderView = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    expect(defenderView.fromCache).toBe(true);
    expect(defenderView.revision).toBe(towerView.revision);
  });

  it("G：Defender 输入顺序反转 → per-slot revision 语义相同", () => {
    seedTwoDefenderFallbackPlan();
    const a = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"])).revision!;
    clearDefenseEngagementForTest();
    // 顺序反转的 plan 输入（defenders 反转）→ 同一 per-slot 修订语义。
    const reversed = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({ id: "T1", hits: 500, x: 20, y: 25, engagement: { x: 20, y: 25, kind: "boundary" } }),
        hostileOf({
          id: "T2", hits: 500, x: 22, y: 25,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            { id: "r1", x: 24, y: 25 },
            { id: "r2", x: 24, y: 26 },
            { id: "r3", x: 24, y: 27 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d1", slot: "1", x: 24, y: 26 }),
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
      ],
      wounded: [],
    }, Game.time);
    writeRoomEngagementPlan(reversed);
    const b = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"])).revision!;
    for (const slot of ["0", "1"]) {
      expect(a.defenderEngagementBySlot[slot].targetId).toBe(b.defenderEngagementBySlot[slot].targetId);
      expect(a.defenderEngagementBySlot[slot].position).toEqual(b.defenderEngagementBySlot[slot].position);
    }
  });

  it("plan 持久化候选集合（engagementCandidatesByTargetId——revision 不重查防线系统）", () => {
    const plan = seedTwoDefenderFallbackPlan();
    expect(plan.engagementCandidatesByTargetId?.T2).toBeDefined();
    expect(plan.engagementCandidatesByTargetId!.T2.map((c) => c.id)).toEqual(["r1", "r2", "r3"]);
  });
});

// ── 十一、fresh plan 缺 assignment 默认 hold ────────────────────────────────

class MockPos {
  public constructor(public x: number, public y: number, public roomName: string) {}
  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }
  public isEqualTo(): boolean { return false; }
  public lookFor(): unknown[] { return []; }
}

function createHostile(id: string, x: number, y: number): Creep {
  return {
    id: id as Id<Creep>, hits: 100,
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
  } as unknown as Creep;
}

function createDefender(): Creep {
  const defender = {
    name: "defender-0",
    memory: { role: "homeDefender" },
    body: [{ type: ATTACK }],
    pos: new MockPos(20, 25, "W1N1") as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
    attack: jest.fn(() => OK),
    rangedAttack: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
  } as unknown as Creep;
  Object.defineProperty(defender, "room", {
    value: {
      name: "W1N1",
      find: jest.fn(() => [] as never[]),
      getPositionAt: (x: number, y: number) => new MockPos(x, y, "W1N1"),
    } as unknown as Room,
  });
  return defender;
}

describe("Remediation V 十一：fresh plan 缺 assignment 默认 hold", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSafeZone as jest.Mock).mockReturnValue(new Set([20 * 50 + 24, 20 * 50 + 25]));
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(jest.fn());
    (getDefenderRole as jest.Mock).mockReturnValue("primary");
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getPlayerHostiles as jest.Mock).mockReturnValue([createHostile("h1", 20, 24)]);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([]);
  });

  it("A：fresh plan 存在但 entry 只有 creep name（slot=0 查不到）→ hold（不 attack/ranged/moveTo）", () => {
    // 模拟 slot 错配：plan 的 defenderEngagements 键是 creep name。
    writeRoomEngagementPlan({
      roomName: "W1N1",
      plannedAtTick: Game.time,
      focusTargetId: "h1",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: { "defender-0": { targetId: "h1", mode: "attack" } },
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["h1"],
      defenderFronts: {},
    });
    const defender = createDefender();
    homeDefenderRole("W1N1", "0").target(defender);
    // fresh plan 存在但 slot=0 无 entry → 默认 hold（零攻击/移动动作）。
    expect((defender as unknown as { attack: jest.Mock }).attack).not.toHaveBeenCalled();
    expect((defender as unknown as { rangedAttack: jest.Mock }).rangedAttack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("B：fresh plan 显式 hold（targetId=null）→ 继续 hold", () => {
    writeRoomEngagementPlan({
      roomName: "W1N1",
      plannedAtTick: Game.time,
      focusTargetId: "h1",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: { "0": { targetId: null, mode: "hold" } },
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["h1"],
      defenderFronts: {},
    });
    const defender = createDefender();
    homeDefenderRole("W1N1", "0").target(defender);
    expect((defender as unknown as { attack: jest.Mock }).attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("C：fresh plan 显式 not_participating → 允许旧独立行为（attack 相邻 hostile）", () => {
    writeRoomEngagementPlan({
      roomName: "W1N1",
      plannedAtTick: Game.time,
      focusTargetId: "h1",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: { "0": { targetId: null, mode: "hold", participation: "not_participating" } },
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["h1"],
      defenderFronts: {},
    });
    const defender = createDefender();
    // defender 在 (20,25)，hostile 在 (20,24)——safe zone 内贴身 → 旧独立行为 attack。
    homeDefenderRole("W1N1", "0").target(defender);
    expect((defender as unknown as { attack: jest.Mock }).attack).toHaveBeenCalled();
  });

  it("D：stale plan（非本 tick）→ 保留旧独立 fallback（attack）", () => {
    writeRoomEngagementPlan({
      roomName: "W1N1",
      plannedAtTick: Game.time - 1,
      focusTargetId: "h1",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: { "0": { targetId: null, mode: "hold" } },
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["h1"],
      defenderFronts: {},
    });
    const defender = createDefender();
    homeDefenderRole("W1N1", "0").target(defender);
    expect((defender as unknown as { attack: jest.Mock }).attack).toHaveBeenCalled();
  });

  it("E：canonical slot 正常 → 按 plan 执行 attack（不回退）", () => {
    writeRoomEngagementPlan({
      roomName: "W1N1",
      plannedAtTick: Game.time,
      focusTargetId: "h1",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: { "0": { targetId: "h1", mode: "attack" } },
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["h1"],
      defenderFronts: {},
    });
    const defender = createDefender();
    homeDefenderRole("W1N1", "0").target(defender);
    expect((defender as unknown as { attack: jest.Mock }).attack).toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }));
  });
});
