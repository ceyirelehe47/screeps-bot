/**
 * 【Round 22 Remediation VIII 工作流 F】Pre-allocation Stationary Rampart
 * Ownership 的固定反例矩阵（D9–D15）。
 *
 * F1 缺口：pending boundary Defender 在 allocator 候选不足后才变 hold、
 * fallback replacement 在 allocation 失败后才变 hold——此刻它脚下的
 * Rampart 可能已被 allocator 分给另一名 Defender（双占位）。
 *
 * 修复语义：allocation 之前建立物理 ownership——站在**自己 target** 的
 * 未占用候选上的 actor 直接 claim（occupant 保留当前位置）；变 hold 的
 * actor 脚下命中候选时保留当前位置事实（occupied + reservedPosition）。
 * planner 与 fallback revision 共享同一占用语义。
 *
 * - D9：D0 站 R1（pending boundary）+ D1 primary 同 target、候选只有 R1
 *   → D0 claim 保留 R1、D1 hold（不得两人都得到 R1）；
 * - D10：候选 R1/R2 → D0 claim R1、D1 只能得到 R2；
 * - D11：fallback 双 replacement、候选只有 R1 → D0 claim R1、D1 hold；
 * - D12：fallback 候选 R1/R2 → occupant 保留 R1、replacement 得 R2；
 * - D13：participant claim + non-participant 采集层占用混合——全部物理
 *   占用 Rampart 不被重复分配；
 * - D14：输入顺序反转 per-slot 结果一致；
 * - D15：消费层——hold actor 不 moveTo / 不追逐，direct attack 不停止攻击。
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
import { collectPhysicalCandidateFootprints, candidateKeyOf } from "@/runtime/physicalRampartOwnership";
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
  return { role: "primary", x: 25, y: 33, meleeDamage: 0, rangedDamage: 10, ...overrides };
}

/** 手写 plan（fallback 场景——replacement 的持久化事实）。 */
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
    pos: new MockPos(x, y, "W1N57") as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
    attack: jest.fn(() => OK),
    rangedAttack: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
  } as unknown as Creep;
  Object.defineProperty(defender, "room", {
    value: {
      name: "W1N57",
      find: jest.fn(() => [] as never[]),
      getPositionAt: (px: number, py: number) => new MockPos(px, py, "W1N57"),
    } as unknown as Room,
  });
  return defender;
}

beforeEach(() => {
  clearDefenseEngagementForTest();
  jest.clearAllMocks();
});

// ── D9/D10/D13/D14：planner 层 ─────────────────────────────────────────────

describe("Remediation VIII：allocation 前的物理 Rampart ownership（planner 层）", () => {
  it("D9：D0 站 R1（pending boundary）+ D1 primary 同 target、候选只有 R1 → D0 claim 保留 R1、D1 hold（无双占位）", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [{ id: "r1", x: 24, y: 25 }],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        // 两名都 approach → 都进 pending boundary；d0 站在唯一候选 R1 上。
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 30, role: "secondary" }),
      ],
      wounded: [],
    }, Game.time);
    const d0 = plan.defenderEngagements["0"]!;
    const d1 = plan.defenderEngagements["1"]!;
    // D0 claim R1（occupant 保留当前位置——engage_position = 当前 tile）。
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    // D1 hold（唯一候选已被 occupant claim——不得双占位）。
    expect(d1.mode).toBe("hold");
    expect(d1.position).toBeUndefined();
    // 房间级无重复位置（跨 actor——claim 的 position 与 reservedPosition
    // 同 tile 是 occupant 保留的预期形态，不计为双占位）。
    const keys = [d0.position, d1.position, d1.reservedPosition]
      .filter((p): p is { x: number; y: number } => p !== undefined)
      .map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("D10：D0 站 R1（pending）+ D1 需要 boundary、候选 R1/R2 → D1 只能得到 R2", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
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
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 30, role: "secondary" }),
      ],
      wounded: [],
    }, Game.time);
    const d0 = plan.defenderEngagements["0"]!;
    const d1 = plan.defenderEngagements["1"]!;
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 26 });
  });

  it("D13：participant claim + non-participant 采集层占用混合——全部物理占用 Rampart 不被重复分配", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            // r0 已被 non-participant 占用（采集层 occupied 标记）。
            { id: "r0", x: 24, y: 24, occupied: true },
            { id: "r1", x: 24, y: 25 },
            { id: "r2", x: 24, y: 26 },
          ],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        // d0 站 r1（participant——claim）。
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 30, role: "secondary" }),
      ],
      wounded: [],
    }, Game.time);
    const d0 = plan.defenderEngagements["0"]!;
    const d1 = plan.defenderEngagements["1"]!;
    // participant claim r1；non-participant 的 r0 保持 occupied；d1 只能 r2。
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d1.position).toEqual({ x: 24, y: 26 });
    const occupiedIds = plan.engagementCandidatesByTargetId!.T1!
      .filter((candidate) => candidate.occupied === true)
      .map((candidate) => candidate.id)
      .sort();
    expect(occupiedIds).toEqual(["r0", "r1"]);
  });

  it("D14：Defender / candidate / front key 顺序反转 → per-slot 结果逐项一致", () => {
    const build = (reversed: boolean): FocusFireEngagementPlan => {
      const defenders = [
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 30, role: "secondary" }),
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
    const forward = build(false);
    const reversedPlan = build(true);
    for (const slot of ["0", "1"]) {
      expect(reversedPlan.defenderEngagements[slot]).toEqual(forward.defenderEngagements[slot]);
    }
  });
});

// ── D11/D12：fallback revision 层 ───────────────────────────────────────────

describe("Remediation VIII：allocation 前的物理 Rampart ownership（fallback 层）", () => {
  it("D11：D0 旧目标失效站 R1、D1 也 replacement、候选只有 R1 → D0 claim R1、D1 hold（不得把 R1 分给 D1 后让 D0 hold R1）", () => {
    const plan = handwrittenPlan({
      engagementCandidatesByTargetId: {
        T2: [{ id: "r1", x: 24, y: 25 }],
      },
      engagementByTargetId: { T2: { x: 24, y: 25, kind: "boundary" } },
      defenderFronts: {
        "0": { eligibleTargetIds: ["T1", "T2"] },
        "1": { eligibleTargetIds: ["T1", "T2"] },
      },
      defenderEngagements: {
        "0": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 25 }, positionKind: "boundary" },
        "1": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 26 }, positionKind: "boundary" },
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "primary", x: 24, y: 26 },
      },
    });
    writeRoomEngagementPlan(plan);
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    expect(revision).not.toBeNull();
    const d0 = revision!.defenderEngagementBySlot["0"]!;
    const d1 = revision!.defenderEngagementBySlot["1"]!;
    // D0 站在自己 revised target（T2）的唯一候选 R1 → claim 保留。
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    // D1 hold（R1 已被 occupant claim）。
    expect(d1.mode).toBe("hold");
    expect(d1.position).toBeUndefined();
  });

  it("D12：fallback 候选 R1/R2、occupant 保留 R1、replacement 得 R2", () => {
    const plan = handwrittenPlan({
      defenderFronts: {
        "0": { eligibleTargetIds: ["T1", "T2"] },
        "1": { eligibleTargetIds: ["T1", "T2"] },
      },
      defenderEngagements: {
        "0": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 25 }, positionKind: "boundary" },
        "1": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 26 }, positionKind: "boundary" },
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "primary", x: 24, y: 26 },
      },
    });
    writeRoomEngagementPlan(plan);
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set(["T2"]));
    expect(revision).not.toBeNull();
    const d0 = revision!.defenderEngagementBySlot["0"]!;
    const d1 = revision!.defenderEngagementBySlot["1"]!;
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 26 });
  });
});

// ── D15：消费层 ─────────────────────────────────────────────────────────────

describe("Remediation VIII：hold actor 的消费层行为", () => {
  it("D15：claim 后 hold 的 loser 不 moveTo、不追逐；direct attacker 不停止攻击", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [{ id: "r1", x: 24, y: 25 }],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        // d0 站 R1（pending → claim 保留）；d1 远离（pending → 候选不足 hold）。
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 33, role: "secondary" }),
        // d2 贴身 direct attacker（attack 保留回归——站在 target 旁）。
        defenderOf({ id: "d2", slot: "2", x: 24, y: 21, meleeDamage: 30 }),
      ],
      wounded: [],
    }, Game.time);
    expect(plan.defenderEngagements["0"]!.mode).toBe("engage_position");
    expect(plan.defenderEngagements["1"]!.mode).toBe("hold");
    expect(plan.defenderEngagements["2"]!.mode).toBe("attack");
    writeRoomEngagementPlan(plan);
    // safe zone 非空（前置检查——空集合会直接 return false）。
    (getSafeZone as jest.Mock).mockReturnValue(new Set<number>([24 * 50 + 20, 24 * 50 + 21, 24 * 50 + 25, 24 * 50 + 26, 25 * 50 + 30, 25 * 50 + 33]));
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(jest.fn());
    (getDefenderRole as jest.Mock).mockReturnValue("primary");
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getPlayerHostiles as jest.Mock).mockReturnValue([
      { id: "T1" as Id<Creep>, hits: 500, pos: new MockPos(24, 20, "W1N57") as unknown as RoomPosition } as unknown as Creep,
    ]);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([]);
    // hold loser：不 moveTo、不追逐。
    const holdCreep = createDefenderAt("hd-1", 25, 33);
    homeDefenderRole("W1N57", "1").target(holdCreep);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect((holdCreep as unknown as { attack: jest.Mock }).attack).not.toHaveBeenCalled();
    // direct attacker：继续攻击（不因占用保留停止）。
    const attackCreep = createDefenderAt("hd-2", 24, 21);
    homeDefenderRole("W1N57", "2").target(attackCreep);
    expect((attackCreep as unknown as { attack: jest.Mock }).attack).toHaveBeenCalled();
  });
});

// ── 共享入口守护（物理占用语义单一权威）────────────────────────────────────

describe("Remediation VIII：物理占用语义的共享入口", () => {
  it("collectPhysicalCandidateFootprints：slot 字典序决胜、输入顺序无关、非候选坐标不产生 footprint", () => {
    const keys = new Set(["24,25", "24,26"]);
    const forward = collectPhysicalCandidateFootprints(
      [
        { slot: "1", x: 24, y: 25 },
        { slot: "0", x: 24, y: 25 },
        { slot: "9", x: 30, y: 30 },
      ],
      keys,
    );
    const reversed = collectPhysicalCandidateFootprints(
      [
        { slot: "9", x: 30, y: 30 },
        { slot: "0", x: 24, y: 25 },
        { slot: "1", x: 24, y: 25 },
      ],
      keys,
    );
    expect(forward).toEqual(reversed);
    expect(forward.get(candidateKeyOf(24, 25))).toBe("0");
    expect(forward.has(candidateKeyOf(30, 30))).toBe(false);
  });
});
