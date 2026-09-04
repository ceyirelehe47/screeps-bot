/**
 * 【Round 22 Remediation VII 九】Stationary Defender Rampart Ownership 的
 * 固定反例矩阵（D1–D8）。
 *
 * 占用规则按"本 tick 是否离开当前位置"判断，不再只看是否直接攻击：
 * - D1：hold Defender 站合法 boundary Rampart R1 → R1 进入房间级 used 权威
 *   （retained hold 的 reservedPosition + used 集第三路），replacement
 *   Defender 只能获得其它候选；
 * - D2：候选只剩被 hold Defender 占据的 R1 → 后续 Defender 明确 hold
 *   （不 moveTo R1、不追逐边界外 hostile）；
 * - D3：stationary engage_position（分配位置 = 当前 tile）→ R1 被保留；
 * - D4：fallback 不抢 unaffected hold actor 的 Rampart；
 * - D5：fallback 后无合法候选的 hold 也保留当前位置事实；
 * - D6：direct attack / ranged_attack 的保留回归（不停止攻击、不被抢位）；
 * - D7：非参与 Defender 的 Rampart 占用由采集层标记（planner 不重复分配）；
 * - D8：输入顺序反转（Defender / candidate / front key）不改变 per-slot 语义。
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

/** 手写 plan（revision 场景——stationary hold/engagement 的持久化事实）。 */
function handwrittenPlan(overrides: Partial<FocusFireEngagementPlan> = {}): FocusFireEngagementPlan {
  return {
    roomName: "W1N57",
    plannedAtTick: Game.time,
    focusTargetId: "T2",
    focusTargetClass: "suppression_only",
    killExpected: false,
    focusAssignedDamage: 0,
    focusKillBudget: null,
    focusExpectedHeal: 0,
    towerAssignments: {},
    defenderAssignments: {},
    defenderEngagements: {},
    engagementByTargetId: { T2: { x: 24, y: 25, kind: "boundary" } },
    emergencyHealByTowerId: {},
    fallbackTargetIds: ["T2"],
    defenderFronts: {},
    engagementCandidatesByTargetId: {
      T2: [
        { id: "r1", x: 24, y: 25 },
        { id: "r2", x: 24, y: 26 },
      ],
    },
    defenderFactsBySlot: {},
    ...overrides,
  } as FocusFireEngagementPlan;
}

class MockPos {
  public constructor(public x: number, public y: number, public roomName: string) {}
  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }
  public isEqualTo(): boolean { return false; }
  public lookFor(): unknown[] { return []; }
}

function createDefenderAt(name: string, x: number, y: number): Creep {
  const defender = {
    name,
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

beforeEach(() => {
  clearDefenseEngagementForTest();
  jest.clearAllMocks();
});

// ── D1/D2/D4/D5：fallback revision 的 stationary 保留 ─────────────────────

describe("Remediation VII：stationary defender 的 Rampart ownership（revision 层）", () => {
  it("D1：hold Defender 站 R1 → retained hold 携带 reservedPosition 且 used 集第三路生效——replacement 只能获得 R2", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      defenderEngagements: {
        // d0：hold（无 front-local 候选的显式不动）且真实坐标站在 R1(24,25)。
        "0": { targetId: "T2", mode: "hold" },
        // d1：原 target T1 失效（不在 alive 集）。
        "1": { targetId: "T1", mode: "engage_position", position: { x: 20, y: 20 }, positionKind: "boundary" },
      },
      defenderFronts: {
        "0": { frontId: "f1", eligibleTargetIds: ["T2"] },
        "1": { frontId: "f1", eligibleTargetIds: ["T2"] },
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "secondary", x: 25, y: 33 },
      },
    }));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    expect(revision).not.toBeNull();
    // d0：retained hold 保持 hold 且携带 R1 保留事实（不被改写为无位置
    // engage_position——那会让消费方回落共享位置）。
    const d0 = revision!.defenderEngagementBySlot["0"]!;
    expect(d0.mode).toBe("hold");
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    // d1：replacement 不得获得被 d0 占据的 R1——只能 R2。
    const d1 = revision!.defenderEngagementBySlot["1"]!;
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 26 });
  });

  it("D2：候选只剩被 hold Defender 占据的 R1 → replacement 明确 hold（不 moveTo R1、不追逐）", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      engagementCandidatesByTargetId: { T2: [{ id: "r1", x: 24, y: 25 }] },
      defenderEngagements: {
        "0": { targetId: "T2", mode: "hold" },
        "1": { targetId: "T1", mode: "engage_position", position: { x: 20, y: 20 }, positionKind: "boundary" },
      },
      defenderFronts: {
        "0": { frontId: "f1", eligibleTargetIds: ["T2"] },
        "1": { frontId: "f1", eligibleTargetIds: ["T2"] },
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "secondary", x: 25, y: 33 },
      },
    }));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    const d0 = revision!.defenderEngagementBySlot["0"]!;
    expect(d0.mode).toBe("hold");
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    const d1 = revision!.defenderEngagementBySlot["1"]!;
    expect(d1.mode).toBe("hold");
    expect(d1.position).toBeUndefined();
    // d1 当前不在合法候选上（25,33）→ 无 reservedPosition（明确 hold 不携带
    // 虚假位置事实）。
    expect(d1.reservedPosition).toBeUndefined();
  });

  it("D4：unaffected hold actor 的原 target 仍存活 → 保持 hold + R1；fallback Defender 不得抢占 R1", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      defenderEngagements: {
        "0": { targetId: "T2", mode: "hold" },
        "1": { targetId: "T1", mode: "engage_position", position: { x: 20, y: 20 }, positionKind: "boundary" },
      },
      defenderFronts: {
        "0": { frontId: "f1", eligibleTargetIds: ["T2"] },
        "1": { frontId: "f1", eligibleTargetIds: ["T2"] },
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "secondary", x: 25, y: 33 },
      },
    }));
    // d0 原 target T2 存活（retained）；d1 原 target T1 失效。
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T1", "T2"]));
    const d0 = revision!.defenderEngagementBySlot["0"]!;
    expect(d0.mode).toBe("hold");
    expect(d0.targetId).toBe("T2");
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    const d1 = revision!.defenderEngagementBySlot["1"]!;
    expect(d1.position).toEqual({ x: 24, y: 26 });
  });

  it("D5：replacement 无合法候选但当前已在合法 Rampart → hold 携带当前位置保留事实", () => {
    writeRoomEngagementPlan(handwrittenPlan({
      engagementCandidatesByTargetId: {
        T2: [
          { id: "r1", x: 24, y: 25, occupied: true },
          { id: "r2", x: 24, y: 26, occupied: true },
        ],
      },
      defenderEngagements: {
        "0": { targetId: "T2", mode: "attack", reservedPosition: { x: 24, y: 25 } },
        "1": { targetId: "T1", mode: "engage_position", position: { x: 20, y: 20 }, positionKind: "boundary" },
      },
      defenderFronts: {
        "0": { frontId: "f1", eligibleTargetIds: ["T2"] },
        "1": { frontId: "f1", eligibleTargetIds: ["T2"] },
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        // d1 当前站在 r2(24,26)——合法候选上（被 occupied 标记占用，但那是
        // 采集层的他属标记；d1 自己站着的 R2 是它的当前位置事实）。
        "1": { role: "secondary", x: 24, y: 26 },
      },
    }));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    const d1 = revision!.defenderEngagementBySlot["1"]!;
    expect(d1.mode).toBe("hold");
    // 当前位置保留事实（D5：明确保留当前位置，而不是无位置的 hold）。
    expect(d1.reservedPosition).toEqual({ x: 24, y: 26 });
  });
});

// ── D3/D6/D7/D8：planner 层 ────────────────────────────────────────────────

describe("Remediation VII：stationary defender 的 Rampart ownership（planner 层）", () => {
  it("D3：stationary engage_position（分配位置 = 当前 tile）→ R1 被保留（occupied + reservedPosition）", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        // target 距 r1(24,25) 5 格——站在 r1 的 d1 是 approach（射程外），
        // 经 allocate 获得 on-tile 分配（第二维距离 0）→ stationary。
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            { id: "r1", x: 24, y: 25 },
            { id: "r2", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d0", slot: "0", x: 25, y: 33, role: "secondary", rangedDamage: 10 }),
        defenderOf({ id: "d1", slot: "1", x: 24, y: 25, rangedDamage: 10 }),
      ],
      wounded: [],
    }, Game.time);
    const d1 = plan.defenderEngagements["1"]!;
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 25 });
    // 二次标记：on-tile stationary 的 reservedPosition + 候选 occupied。
    expect(d1.reservedPosition).toEqual({ x: 24, y: 25 });
    expect(plan.engagementCandidatesByTargetId!.T1!.find((c) => c.id === "r1")?.occupied).toBe(true);
    // d0 只能获得 r2。
    const d0 = plan.defenderEngagements["0"]!;
    expect(d0.position).toEqual({ x: 24, y: 26 });
    // 房间级无重复位置。
    const keys = [d1.reservedPosition, d0.position].map((p) => `${p!.x},${p!.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("D6：direct attack / ranged_attack 的保留回归——不停止攻击、hold 消费不被迫移动", () => {
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
    // direct attacker：attack + reservedPosition（不因占用保留停止攻击）。
    expect(plan.defenderEngagements["0"]!.mode).toBe("attack");
    expect(plan.defenderEngagements["0"]!.reservedPosition).toEqual({ x: 24, y: 25 });
    // 唯一候选被占 → d1 明确 hold；消费层：hold 不 moveTo / 不追逐。
    writeRoomEngagementPlan(plan);
    (getSafeZone as jest.Mock).mockReturnValue(new Set<number>());
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(jest.fn());
    (getDefenderRole as jest.Mock).mockReturnValue("primary");
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getPlayerHostiles as jest.Mock).mockReturnValue([]);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([]);
    const d1Creep = createDefenderAt("hd-1", 25, 33);
    homeDefenderRole("W1N57", "1").target(d1Creep);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect((d1Creep as unknown as { attack: jest.Mock }).attack).not.toHaveBeenCalled();
  });

  it("D7：非参与 Defender 的 Rampart（采集层 occupied 标记）不被 planner 重复分配", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 24,
          engagement: { x: 24, y: 25, kind: "boundary" },
          // r1 被采集层标记 occupied（非参与计划的 homeDefender 站着——
          // canonical slot 缺失/不在 plan，由采集层承载占用）。
          engagementCandidates: [
            { id: "r1", x: 24, y: 25, occupied: true },
            { id: "r2", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [defenderOf({ id: "d0", slot: "0", x: 25, y: 33, role: "secondary", rangedDamage: 10 })],
      wounded: [],
    }, Game.time);
    const d0 = plan.defenderEngagements["0"]!;
    // 参与 Defender 不得获得被非参与 actor 占据的 r1。
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 26 });
    expect(d0.reservedPosition).toBeUndefined();
  });

  it("D8：输入顺序反转（Defender / candidate / front key 插入顺序）不改变 per-slot 语义", () => {
    const buildPlan = (reversed: boolean): FocusFireEngagementPlan => {
      const defenders = [
        defenderOf({ id: "d0", slot: "0", x: 25, y: 33, role: "secondary", rangedDamage: 10 }),
        defenderOf({ id: "d1", slot: "1", x: 24, y: 25, rangedDamage: 10 }),
        defenderOf({ id: "d2", slot: "2", x: 26, y: 33, role: "secondary", rangedDamage: 10 }),
      ];
      const candidates = [
        { id: "r1", x: 24, y: 25 },
        { id: "r2", x: 24, y: 26 },
      ];
      return planRoomEngagement({
        roomName: "W1N57",
        hostiles: [
          hostileOf({
            id: "T1", hits: 500, x: 24, y: 24,
            engagement: { x: 24, y: 25, kind: "boundary" },
            engagementCandidates: reversed ? [...candidates].reverse() : candidates,
          }),
        ],
        towers: [towerOf({ id: "t1", x: 25, y: 20 })],
        defenders: reversed ? [...defenders].reverse() : defenders,
        wounded: [],
      }, Game.time);
    };
    const forward = buildPlan(false);
    const reversed = buildPlan(true);
    for (const slot of ["0", "1", "2"]) {
      const left = forward.defenderEngagements[slot]!;
      const right = reversed.defenderEngagements[slot]!;
      expect(right.mode).toBe(left.mode);
      expect(right.targetId).toBe(left.targetId);
      expect(right.position ?? null).toEqual(left.position ?? null);
      expect(right.reservedPosition ?? null).toEqual(left.reservedPosition ?? null);
    }
    // on-tile stationary（d1）在两种顺序下都保留 R1。
    expect(forward.defenderEngagements["1"]!.reservedPosition).toEqual({ x: 24, y: 25 });
    expect(reversed.defenderEngagements["1"]!.reservedPosition).toEqual({ x: 24, y: 25 });
  });
});
