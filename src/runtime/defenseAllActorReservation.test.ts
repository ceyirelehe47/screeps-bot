/**
 * 【Round 22 Remediation VI 六/七】All-Actor Rampart Reservation & Fallback
 * Real Facts 的固定反例矩阵（D1–D7）。
 *
 * 六、唯一 Rampart 占用覆盖所有参与 plan 的 Defender：
 * - D1：melee direct attacker（本 tick 直接 attack、不进移动分配）当前所站
 *   合法 boundary Rampart 被房间级保留（occupied + reservedPosition），
 *   approach Defender 只能获得其它候选；
 * - D2：候选只有被 direct actor 占据的 R1 → 后续 Defender 明确 hold
 *   （不 moveTo R1、不追逐边界外 hostile）；
 * - D3：ranged direct attacker 同样保留；
 * - D4：fallback revision 不抢 unaffected direct actor 的 Rampart；
 * - D5：fallback 重分配使用真实 role（primary 优先）且输入顺序反转结果稳定；
 * - D6：fallback 使用真实 Defender 距离（target anchor 近似会得到相反结果）。
 * 七、D7：fresh plan coverage 回归（消费侧 direct actor / hold 不追逐 /
 * canonical slot；fresh-missing/explicit-hold/not_participating/stale 的
 * 完整回归由 defenseFallbackReallocation.test.ts 的十一节继续承载）。
 */

import {
  planRoomEngagement,
  writeRoomEngagementPlan,
  clearDefenseEngagementForTest,
  type FocusFireHostileSnapshot,
  type FocusFireTowerSnapshot,
  type FocusFireDefenderSnapshot,
  type FocusFireEngagementPlan,
} from "@/runtime/defenseFocusFire";
import { resolveRoomEngagementFallbackRevision } from "@/runtime/engagementFallbackRevision";
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

beforeEach(() => {
  clearDefenseEngagementForTest();
  jest.clearAllMocks();
});

// ── D1/D2/D3：planner 层的 all-actor Rampart 占用 ──────────────────────────

describe("Remediation VI 6.1：direct attacker 的 Rampart 进入房间级占用权威", () => {
  it("D1：melee direct attacker 站 R1（与 hostile 距离 1）→ R1 被保留，approach Defender 获得 R2，无重复位置", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 24,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            { id: "r1", x: 24, y: 25 },
            { id: "r2", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        // d0 站在 r1(24,25)、与 T1(24,24) 距离 1 → 本 tick 直接 attack。
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25, meleeDamage: 30 }),
        // d1 远离（25,33）→ approach → 进入移动分配（候选 r1/r2）。
        defenderOf({ id: "d1", slot: "1", x: 25, y: 33, role: "secondary", rangedDamage: 10 }),
      ],
      wounded: [],
    }, Game.time);
    // D1 继续 attack（不因占用保留而停止攻击）且 R1 被保留。
    const d0 = plan.defenderEngagements["0"]!;
    expect(d0.mode).toBe("attack");
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    // plan 持久化候选集中 r1 被标 occupied（房间级 used 权威）。
    const candidates = plan.engagementCandidatesByTargetId!.T1!;
    expect(candidates.find((candidate) => candidate.id === "r1")?.occupied).toBe(true);
    expect(candidates.find((candidate) => candidate.id === "r2")?.occupied ?? false).toBe(false);
    // D2 approach → 只能获得 r2（r1 已被 d0 保留）。
    const d1 = plan.defenderEngagements["1"]!;
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 26 });
    // 不存在两个 slot 指向同一位置（reservedPosition 与 position 全房间唯一）。
    const positionsInUse = [
      ...(d0.reservedPosition !== undefined ? [`${d0.reservedPosition.x},${d0.reservedPosition.y}`] : []),
      ...(d1.position !== undefined ? [`${d1.position.x},${d1.position.y}`] : []),
    ];
    expect(new Set(positionsInUse).size).toBe(positionsInUse.length);
  });

  it("D2：候选只有 R1（被 direct attacker 占据）→ 后续 Defender 明确 hold", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 24,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [{ id: "r1", x: 24, y: 25 }],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25, meleeDamage: 30 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 33, role: "secondary", rangedDamage: 10 }),
      ],
      wounded: [],
    }, Game.time);
    expect(plan.defenderEngagements["0"]!.mode).toBe("attack");
    expect(plan.defenderEngagements["0"]!.reservedPosition).toEqual({ x: 24, y: 25 });
    // 唯一候选被保留 → d1 明确 hold（保留 combat target，本 tick 不移动）。
    expect(plan.defenderEngagements["1"]!.mode).toBe("hold");
    expect(plan.defenderEngagements["1"]!.targetId).toBe("T1");
    expect(plan.defenderEngagements["1"]!.position).toBeUndefined();
  });

  it("D3：ranged direct attacker（射程 3 内、当前位于 R1）→ R1 同样保留", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 21,
          engagement: { x: 24, y: 24, kind: "boundary" },
          engagementCandidates: [
            { id: "r1", x: 24, y: 24 },
            { id: "r2", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        // d0 纯远程，站 r1(24,24)、与 T1(24,21) 距离 3 → ranged_attack。
        defenderOf({ id: "d0", slot: "0", x: 24, y: 24, rangedDamage: 20 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 33, role: "secondary", rangedDamage: 10 }),
      ],
      wounded: [],
    }, Game.time);
    const d0 = plan.defenderEngagements["0"]!;
    expect(d0.mode).toBe("ranged_attack");
    expect(d0.reservedPosition).toEqual({ x: 24, y: 24 });
    expect(plan.engagementCandidatesByTargetId!.T1!.find((c) => c.id === "r1")?.occupied).toBe(true);
    const d1 = plan.defenderEngagements["1"]!;
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 26 });
  });

  it("direct actor 不站合法候选 Rampart（如 inside/其它 tile）→ 不产生保留事实", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 24,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            { id: "r1", x: 24, y: 25 },
            { id: "r2", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        // d0 贴身 hostile 但站在 (24,24)（hostile 本格——非候选 Rampart）。
        defenderOf({ id: "d0", slot: "0", x: 24, y: 24, meleeDamage: 30 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 33, role: "secondary", rangedDamage: 10 }),
      ],
      wounded: [],
    }, Game.time);
    expect(plan.defenderEngagements["0"]!.mode).toBe("attack");
    expect(plan.defenderEngagements["0"]!.reservedPosition).toBeUndefined();
    expect(plan.engagementCandidatesByTargetId!.T1!.find((c) => c.id === "r1")?.occupied ?? false).toBe(false);
    // d1 的 allocate 不受影响（r1 仍可用）。
    expect(plan.defenderEngagements["1"]!.position).toEqual({ x: 24, y: 25 });
  });
});

// ── D4/D5/D6：fallback revision 的真实 facts 与位置保留 ───────────────────

function handwrittenPlan(overrides: Partial<FocusFireEngagementPlan> = {}): FocusFireEngagementPlan {
  return {
    roomName: "W1N57",
    plannedAtTick: Game.time,
    focusTargetId: "T1",
    focusTargetClass: "killable_this_tick",
    killExpected: false,
    focusAssignedDamage: 0,
    focusKillBudget: null,
    focusExpectedHeal: 0,
    towerAssignments: {},
    defenderAssignments: {},
    defenderEngagements: {},
    engagementByTargetId: {},
    emergencyHealByTowerId: {},
    fallbackTargetIds: ["T1", "T2"],
    defenderFronts: {},
    ...overrides,
  } as FocusFireEngagementPlan;
}

describe("Remediation VI 6.3：fallback 保留真实 role 与位置事实", () => {
  it("D4：fallback 不抢 unaffected direct actor 的 Rampart（D1 保留 attack + R1，replacement 只能获得 R2 或 hold）", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      defenderAssignments: { "0": "T1", "1": "T2" },
      defenderEngagements: {
        // D1 unaffected：原目标 T1 存活、直接攻击、站在 R1。
        "0": { targetId: "T1", mode: "attack", reservedPosition: { x: 24, y: 25 } },
        // D2 的原目标 T2 失效（本 tick fallback）。
        "1": { targetId: "T2", mode: "engage_position", position: { x: 23, y: 27 }, positionKind: "boundary" },
      },
      engagementByTargetId: {
        T1: { x: 24, y: 25, kind: "boundary" },
        T2: { x: 23, y: 26, kind: "boundary" },
      },
      defenderFronts: {
        "0": { frontId: "f1", eligibleTargetIds: ["T1", "T2"] },
        "1": { frontId: "f1", eligibleTargetIds: ["T1", "T2"] },
      },
      engagementCandidatesByTargetId: {
        T1: [
          { id: "r1", x: 24, y: 25 },
          { id: "r2", x: 24, y: 26 },
        ],
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "secondary", x: 25, y: 33 },
      },
    }));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T2"], new Set(["T1"]));
    expect(revision).not.toBeNull();
    // D1（slot 0）unaffected direct actor：assignment 与 R1 保持（原动作保留）。
    const revised0 = revision!.defenderEngagementBySlot["0"]!;
    expect(revised0.targetId).toBe("T1");
    expect(revised0.mode).toBe("attack");
    expect(revised0.reservedPosition).toEqual({ x: 24, y: 25 });
    // D2（slot 1）fallback 到 T1：r1 已被 D1 保留（used 集合）→ 只能获得 r2。
    const revised1 = revision!.defenderEngagementBySlot["1"]!;
    expect(revised1.targetId).toBe("T1");
    expect(revised1.mode).toBe("engage_position");
    expect(revised1.position).toEqual({ x: 24, y: 26 });
    // 全房间无重复位置。
    const keys = [
      `${revised0.reservedPosition!.x},${revised0.reservedPosition!.y}`,
      `${revised1.position!.x},${revised1.position!.y}`,
    ];
    expect(new Set(keys).size).toBe(2);
  });

  it("D4b：replacement 候选只有被保留的 R1 → 明确 hold（不抢占）", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      defenderEngagements: {
        "0": { targetId: "T1", mode: "attack", reservedPosition: { x: 24, y: 25 } },
        "1": { targetId: "T2", mode: "engage_position", position: { x: 23, y: 27 }, positionKind: "boundary" },
      },
      engagementByTargetId: {
        T1: { x: 24, y: 25, kind: "boundary" },
        T2: { x: 23, y: 26, kind: "boundary" },
      },
      defenderFronts: {
        "0": { frontId: "f1", eligibleTargetIds: ["T1", "T2"] },
        "1": { frontId: "f1", eligibleTargetIds: ["T1", "T2"] },
      },
      engagementCandidatesByTargetId: { T1: [{ id: "r1", x: 24, y: 25 }] },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "secondary", x: 25, y: 33 },
      },
    }));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T2"], new Set(["T1"]));
    const revised1 = revision!.defenderEngagementBySlot["1"]!;
    expect(revised1.mode).toBe("hold");
    expect(revised1.position).toBeUndefined();
    // D1 的保留不受影响。
    expect(revision!.defenderEngagementBySlot["0"]!.mode).toBe("attack");
  });

  it("D5：fallback role 优先级——primary 按 allocate 规则优先获得更近候选；输入顺序反转 per-slot 结果不变", () => {
    const buildPlan = (frontOrder: string[]): FocusFireEngagementPlan => handwrittenPlan({
      // 两名 Defender 的原目标均失效（T1 fallback target）。
      defenderEngagements: {
        "0": { targetId: "T2", mode: "engage_position", position: { x: 23, y: 27 }, positionKind: "boundary" },
        "1": { targetId: "T3", mode: "engage_position", position: { x: 23, y: 28 }, positionKind: "boundary" },
      },
      engagementByTargetId: {
        T1: { x: 24, y: 25, kind: "boundary" },
        T2: { x: 23, y: 26, kind: "boundary" },
        T3: { x: 23, y: 29, kind: "boundary" },
      },
      // frontOrder 控制 defenderFronts 的键插入顺序（输入顺序变化源）。
      defenderFronts: Object.fromEntries(frontOrder.map((slot) => [
        slot,
        { frontId: "f1", eligibleTargetIds: ["T1", "T2", "T3"] },
      ])),
      // 候选对 target 等距（r1 近 target 主位、r2 远）——primary 优先拿 r1。
      engagementCandidatesByTargetId: {
        T1: [
          { id: "r1", x: 24, y: 25 },
          { id: "r2", x: 24, y: 30 },
        ],
      },
      defenderFactsBySlot: {
        // slot 0 是 primary（真实 role）、slot 1 是 secondary。
        "0": { role: "primary", x: 25, y: 33 },
        "1": { role: "secondary", x: 25, y: 34 },
      },
    });
    writeRoomEngagementPlan(buildPlan(["0", "1"]));
    const first = resolveRoomEngagementFallbackRevision("W1N57", ["T2", "T3"], new Set(["T1"])).revision!;
    clearDefenseEngagementForTest();
    writeRoomEngagementPlan(buildPlan(["1", "0"]));
    const second = resolveRoomEngagementFallbackRevision("W1N57", ["T2", "T3"], new Set(["T1"])).revision!;
    // primary（slot 0）按统一 allocator 规则优先获得 r1。
    expect(first.defenderEngagementBySlot["0"]!.position).toEqual({ x: 24, y: 25 });
    expect(first.defenderEngagementBySlot["1"]!.position).toEqual({ x: 24, y: 30 });
    // 输入顺序反转 → per-slot 语义结果完全一致。
    expect(second.defenderEngagementBySlot).toEqual(first.defenderEngagementBySlot);
  });

  it("D6：fallback 使用真实 Defender 距离（target anchor 近似会得到相反结果）", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      defenderEngagements: {
        "0": { targetId: "T2", mode: "engage_position", position: { x: 23, y: 27 }, positionKind: "boundary" },
      },
      engagementByTargetId: {
        // T1 的 engagement 位置（anchor）= (24,30)：r1(20,30) 与 r2(28,30)
        // 对 anchor 等距（各 4）——target 距离维度平手。
        T1: { x: 24, y: 30, kind: "boundary" },
        T2: { x: 23, y: 26, kind: "boundary" },
      },
      defenderFronts: { "0": { frontId: "f1", eligibleTargetIds: ["T1", "T2"] } },
      engagementCandidatesByTargetId: {
        T1: [
          { id: "r1", x: 20, y: 30 },
          { id: "r2", x: 28, y: 30 },
        ],
      },
      defenderFactsBySlot: {
        // 真实 Defender 位置 (29,30)：距 r2 = 1、距 r1 = 9 → 真实距离选 r2。
        //（target anchor 近似会把 defender 当作位于 (24,30)：两候选等距 →
        // id 字典序决胜选 r1——与真实位置结论相反。）
        "0": { role: "primary", x: 29, y: 30 },
      },
    }));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T2"], new Set(["T1"]));
    expect(revision!.defenderEngagementBySlot["0"]!.position).toEqual({ x: 28, y: 30 });
  });
});

// ── D7：消费层回归（direct actor 消费 / hold 不追逐 / canonical slot）──────

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

function createDefender(x: number, y: number): Creep {
  const defender = {
    name: "defender-0",
    memory: { role: "homeDefender" },
    body: [{ type: ATTACK }],
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
    attack: jest.fn(() => OK),
    rangedAttack: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
  } as unknown as Creep;
  Object.defineProperty(defender, "room", {
    value: {
      name: "W1N1",
      find: jest.fn(() => [] as never[]),
      getPositionAt: (px: number, py: number) => new MockPos(px, py, "W1N1"),
    } as unknown as Room,
  });
  return defender;
}

describe("Remediation VI 7：消费层 all-actor reservation 回归（D7）", () => {
  beforeEach(() => {
    (getSafeZone as jest.Mock).mockReturnValue(new Set([20 * 50 + 24, 20 * 50 + 25]));
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(jest.fn());
    (getDefenderRole as jest.Mock).mockReturnValue("primary");
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([]);
  });

  it("D7a：direct attacker 的 plan assignment（attack + reservedPosition）→ 消费继续 attack（不停止攻击）", () => {
    (getPlayerHostiles as jest.Mock).mockReturnValue([createHostile("h1", 20, 24)]);
    writeRoomEngagementPlan(handwrittenPlan({
      roomName: "W1N1",
      focusTargetId: "h1",
      fallbackTargetIds: ["h1"],
      defenderEngagements: { "0": { targetId: "h1", mode: "attack", reservedPosition: { x: 20, y: 25 } } },
    }));
    // defender 站 (20,25) 与 h1(20,24) 距离 1 → 直接 attack。
    const defender = createDefender(20, 25);
    homeDefenderRole("W1N1", "0").target(defender);
    expect((defender as unknown as { attack: jest.Mock }).attack).toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }));
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("D7b：候选 Rampart 不足的显式 hold（唯一候选被 direct actor 保留）→ 不 moveTo、不追逐边界外 hostile", () => {
    // hostile 在 safe zone 外（20,24 不在 zone、20,25/20,24 在——zone 含 24/25
    // 两格；hostile 放 (20,23) 边界外），defender 距离 2 → approach。
    (getPlayerHostiles as jest.Mock).mockReturnValue([createHostile("h1", 20, 23)]);
    writeRoomEngagementPlan(handwrittenPlan({
      roomName: "W1N1",
      focusTargetId: "h1",
      fallbackTargetIds: ["h1"],
      defenderEngagements: { "0": { targetId: "h1", mode: "hold" } },
      engagementByTargetId: { h1: { x: 20, y: 24, kind: "boundary" } },
    }));
    const defender = createDefender(20, 25);
    homeDefenderRole("W1N1", "0").target(defender);
    // approach + 显式 hold：本 tick 不追逐（零攻击/移动动作）。
    expect((defender as unknown as { attack: jest.Mock }).attack).not.toHaveBeenCalled();
    expect((defender as unknown as { rangedAttack: jest.Mock }).rangedAttack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("D7c：canonical slot 正常消费 fallback revision 的 attack entry（unaffected direct actor 修订后仍攻击）", () => {
    (getPlayerHostiles as jest.Mock).mockReturnValue([createHostile("h1", 20, 24)]);
    writeRoomEngagementPlan(handwrittenPlan({
      roomName: "W1N1",
      focusTargetId: "h1",
      fallbackTargetIds: ["h1", "h2"],
      defenderEngagements: { "0": { targetId: "h2", mode: "attack" } },
      engagementByTargetId: { h2: { x: 20, y: 24, kind: "inside" } },
      defenderFronts: { "0": { frontId: "f1", eligibleTargetIds: ["h1", "h2"] } },
    }));
    const defender = createDefender(20, 25);
    homeDefenderRole("W1N1", "0").target(defender);
    // h2 已失效 → revision 给出 front-local 替代 h1（alive）；defender 贴身
    // h1 → attack（fallback 后不 hold、不追逐）。
    expect((defender as unknown as { attack: jest.Mock }).attack).toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }));
  });
});
