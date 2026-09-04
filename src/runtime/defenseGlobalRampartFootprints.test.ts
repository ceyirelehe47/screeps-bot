/**
 * 【Round 22 Remediation IX 工作流 10】Global Rampart Footprints 的固定
 * 反例矩阵（D16–D23）。
 *
 * IX 缺口：VIII 的 pre-claim 只在 Defender 自己 target 的候选数组内标记
 * occupied——每个 hostile 拥有独立候选数组，多 target 数组可包含同一真实
 * Rampart 坐标（candidate ID 不同），allocator 可再次分配同一坐标。
 *
 * 修复语义：房间级 coordinate → physical owner slot 的 ownership snapshot
 * ——claim 的坐标进入全局 used set（全部 target 候选视图共同消费）；唯一
 * 性按坐标不按 candidate ID；planner 与 fallback 共享同一
 * physicalRampartOwnership 入口。
 *
 * - D16：D0（target=T1）站 R1，T1/T2 候选数组都含同坐标 R1（candidate ID
 *   不同）→ D0 保留 R1、D1 不得获得 R1（hold）；
 * - D17：fallback 双 replacement、revised 候选含共享 R1 + R2 → occupant
 *   claim R1、另一 replacement 只能获得 R2；
 * - D18：fallback 共享 R1 唯一候选 → 后到者 hold；
 * - D19：participant、non-participant、跨 target 共享坐标混合——跨 actor
 *   物理坐标全局唯一；
 * - D20：same-target 的 VIII 语义不回归（occupant 的 engage_position 消费
 *   不强迫移动）；
 * - D21：输入顺序反转 per-slot 结果一致；
 * - D22：consumer 层 loser hold——不 moveTo、不追敌；
 * - D23：架构扫描——planner 与 fallback 都调用共享 physical ownership
 *   入口；唯一性按坐标。
 */

import { readFileSync } from "fs";
import { join } from "path";
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

/** 跨 target 共享坐标 R1(24,25) 的双 hostile 输入（candidate ID 不同）。 */
function crossTargetHostiles(withR2: boolean): FocusFireHostileSnapshot[] {
  return [
    hostileOf({
      id: "T1", hits: 500, x: 24, y: 20,
      engagement: { x: 24, y: 25, kind: "boundary" },
      engagementCandidates: [{ id: "r1", x: 24, y: 25 }],
    }),
    hostileOf({
      id: "T2", hits: 500, x: 26, y: 20,
      engagement: { x: 24, y: 25, kind: "boundary" },
      engagementCandidates: [
        // candidate ID 与 T1 的 r1 不同，但坐标同一 R1——物理同一 Rampart。
        { id: "t2-r-shared", x: 24, y: 25 },
        ...(withR2 ? [{ id: "r2", x: 24, y: 26 }] : []),
      ],
    }),
  ];
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

// ── D16/D19/D21：planner 层 ─────────────────────────────────────────────────

describe("Remediation IX：global rampart footprints（planner 层）", () => {
  it("D16：D0（target=T1）站 R1；T1/T2 候选共享同坐标 R1（candidate ID 不同）→ D0 保留 R1、D1 hold", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: crossTargetHostiles(false),
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
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    // D1 不得获得 R1（T2 候选的 t2-r-shared 是同一坐标——全局唯一）。
    expect(d1.mode).toBe("hold");
    expect(d1.position).toBeUndefined();
  });

  it("D19：participant claim + non-participant 采集层占用 + 跨 target 共享坐标混合——跨 actor 物理坐标全局唯一", () => {
    const plan = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            { id: "r0", x: 24, y: 24, occupied: true },
            { id: "r1", x: 24, y: 25 },
            { id: "r3", x: 24, y: 27 },
          ],
        }),
        hostileOf({
          id: "T2", hits: 500, x: 26, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [
            { id: "t2-shared-r0", x: 24, y: 24, occupied: true },
            { id: "t2-shared-r1", x: 24, y: 25 },
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
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 27 });
    // 跨 actor 唯一：两 actor 的坐标集合互不相交（同 actor 的 position 与
    // reservedPosition 同 tile 是 occupant 保留的预期形态——按 actor 分组）。
    const own0 = new Set([d0.position, d0.reservedPosition].filter(Boolean).map((p) => candidateKeyOf(p!.x, p!.y)));
    const own1 = new Set([d1.position, d1.reservedPosition].filter(Boolean).map((p) => candidateKeyOf(p!.x, p!.y)));
    for (const key of own0) {
      expect(own1.has(key)).toBe(false);
    }
  });

  it("D21：Defender 数组、target 顺序、candidate 数组顺序与 candidate ID 反转——per-slot 结果一致", () => {
    const forward = planRoomEngagement({
      roomName: "W1N57",
      hostiles: crossTargetHostiles(true),
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
        defenderOf({ id: "d1", slot: "1", x: 25, y: 30, role: "secondary" }),
      ],
      wounded: [],
    }, Game.time);
    const reversed = planRoomEngagement({
      roomName: "W1N57",
      hostiles: [
        hostileOf({
          id: "T2", hits: 500, x: 26, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [{ id: "r2", x: 24, y: 26 }, { id: "t2-r-shared-renamed", x: 24, y: 25 }],
        }),
        hostileOf({
          id: "T1", hits: 500, x: 24, y: 20,
          engagement: { x: 24, y: 25, kind: "boundary" },
          engagementCandidates: [{ id: "r1-renamed", x: 24, y: 25 }],
        }),
      ],
      towers: [towerOf({ id: "t1", x: 25, y: 20 })],
      defenders: [
        defenderOf({ id: "d1", slot: "1", x: 25, y: 30, role: "secondary" }),
        defenderOf({ id: "d0", slot: "0", x: 24, y: 25 }),
      ],
      wounded: [],
    }, Game.time);
    for (const slot of ["0", "1"] as const) {
      expect(reversed.defenderEngagements[slot]!.mode).toBe(forward.defenderEngagements[slot]!.mode);
      expect(reversed.defenderEngagements[slot]!.position).toEqual(forward.defenderEngagements[slot]!.position);
      expect(reversed.defenderEngagements[slot]!.reservedPosition).toEqual(forward.defenderEngagements[slot]!.reservedPosition);
    }
  });
});

// ── D17/D18：fallback revision 层 ───────────────────────────────────────────

describe("Remediation IX：global rampart footprints（fallback 层）", () => {
  /** 双 replacement 的 fallback plan：两个 slot 旧 target=T1（失效），
   * revised 候选来自 T2（含与 T1 数组共享坐标的条目——candidate ID 不同）。 */
  function crossTargetPlan(withR2: boolean): FocusFireEngagementPlan {
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
      defenderEngagements: {
        "0": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 25 }, positionKind: "boundary" },
        "1": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 26 }, positionKind: "boundary" },
      },
      engagementByTargetId: {
        T1: { x: 24, y: 25, kind: "boundary" },
        T2: { x: 24, y: 25, kind: "boundary" },
      },
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["T2"],
      defenderFronts: {
        "0": { eligibleTargetIds: ["T1", "T2"] },
        "1": { eligibleTargetIds: ["T1", "T2"] },
      },
      engagementCandidatesByTargetId: {
        T1: [{ id: "r1", x: 24, y: 25 }],
        T2: [
          { id: "t2-r-shared", x: 24, y: 25 },
          ...(withR2 ? [{ id: "r2", x: 24, y: 26 }] : []),
        ],
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "primary", x: 24, y: 26 },
      },
    } as FocusFireEngagementPlan;
  }

  it("D17：fallback 双 replacement、revised 候选含共享 R1 + R2 → occupant claim R1、另一 replacement 得 R2", () => {
    writeRoomEngagementPlan(crossTargetPlan(true));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set<string>(["T2"]));
    if (revision === null) throw new Error("D17: revision null");
    const d0 = revision.defenderEngagementBySlot["0"]!;
    const d1 = revision.defenderEngagementBySlot["1"]!;
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d1.mode).toBe("engage_position");
    expect(d1.position).toEqual({ x: 24, y: 26 });
  });

  it("D18：fallback 共享 R1 为唯一 revised 候选 → 先到 slot claim R1、后到者 hold", () => {
    writeRoomEngagementPlan(crossTargetPlan(false));
    const { revision } = resolveRoomEngagementFallbackRevision("W1N57", ["T1"], new Set<string>(["T2"]));
    if (revision === null) throw new Error("D18: revision null");
    const d0 = revision.defenderEngagementBySlot["0"]!;
    const d1 = revision.defenderEngagementBySlot["1"]!;
    expect(d0.mode).toBe("engage_position");
    expect(d0.position).toEqual({ x: 24, y: 25 });
    expect(d0.reservedPosition).toEqual({ x: 24, y: 25 });
    expect(d1.mode).toBe("hold");
    expect(d1.position).toBeUndefined();
  });
});

// ── D20/D22：消费层（homeDefender）──────────────────────────────────────────

describe("Remediation IX：global footprints 的消费层（homeDefender）", () => {
  function consumerSetup(): { d0: Creep; d1: Creep } {
    writeRoomEngagementPlan({
      roomName: "W1N57",
      plannedAtTick: Game.time,
      focusTargetId: "T1",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 0,
      towerAssignments: {},
      defenderAssignments: {},
      defenderEngagements: {
        "0": { targetId: "T1", mode: "engage_position", position: { x: 24, y: 25 }, positionKind: "boundary", reservedPosition: { x: 24, y: 25 } },
        "1": { targetId: "T2", mode: "hold" },
      },
      engagementByTargetId: { T1: { x: 24, y: 25, kind: "boundary" }, T2: { x: 24, y: 25, kind: "boundary" } },
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["T1", "T2"],
      defenderFronts: {},
      engagementCandidatesByTargetId: {
        T1: [{ id: "r1", x: 24, y: 25 }],
        T2: [{ id: "t2-r-shared", x: 24, y: 25 }],
      },
      defenderFactsBySlot: {
        "0": { role: "primary", x: 24, y: 25 },
        "1": { role: "secondary", x: 25, y: 30 },
      },
    } as FocusFireEngagementPlan);
    (getAssignedDefenseFront as unknown as jest.Mock).mockReturnValue(null);
    (getDefenderRole as unknown as jest.Mock).mockReturnValue(null);
    (getPlayerHostiles as unknown as jest.Mock).mockReturnValue([
      {
        id: "T1", pos: new MockPos(24, 20, "W1N57"),
        hits: 500, hitsMax: 3000, body: [], activeBodyparts: [],
        owner: { username: "invader" },
      },
    ]);
    (getSafeZone as unknown as jest.Mock).mockReturnValue(new Set<number>([
      24 * 50 + 20, 24 * 50 + 25, 24 * 50 + 26, 25 * 50 + 30, 25 * 50 + 33,
    ]));
    (createSafeZoneCostCallback as unknown as jest.Mock).mockReturnValue(jest.fn());
    (getBoundaryRamparts as unknown as jest.Mock).mockReturnValue([]);
    (getTowerFocusFront as unknown as jest.Mock).mockReturnValue(null);
    const d0 = createDefenderAt("d0", 24, 25);
    const d1 = createDefenderAt("d1", 25, 30);
    return { d0, d1 };
  }

  it("D22：loser hold 不 moveTo 已占 R1、不追逐边界外敌人", () => {
    const { d1 } = consumerSetup();
    homeDefenderRole("W1N57", "1").target(d1);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect((d1 as unknown as { attack: jest.Mock }).attack).not.toHaveBeenCalled();
  });

  it("D20：same-target 语义不回归——occupant 的 engage_position 消费方只允许移动到自己的位置", () => {
    const { d0 } = consumerSetup();
    homeDefenderRole("W1N57", "0").target(d0);
    const calls = (moveToTarget as jest.Mock).mock.calls;
    for (const call of calls) {
      const target = call[1] as { x?: number; y?: number } | undefined;
      if (target !== undefined) {
        expect(`${target.x},${target.y}`).toBe("24,25");
      }
    }
  });
});

// ── D23：架构扫描 ───────────────────────────────────────────────────────────

describe("Remediation IX：global footprints 架构守护", () => {
  it("D23：planner 与 fallback 都调用共享 physical ownership 入口（physicalRampartOwnership）", () => {
    const plannerSource = readFileSync(join(process.cwd(), "src", "runtime", "defenseFocusFire.ts"), "utf8");
    const fallbackSource = readFileSync(join(process.cwd(), "src", "runtime", "engagementFallbackRevision.ts"), "utf8");
    expect(plannerSource).toContain('from "@/runtime/physicalRampartOwnership"');
    expect(plannerSource).toContain("collectPhysicalCandidateFootprints");
    expect(plannerSource).toContain("markCandidateOccupiedGlobally");
    expect(fallbackSource).toContain('from "@/runtime/physicalRampartOwnership"');
    expect(fallbackSource).toContain("collectPhysicalCandidateFootprints");
  });

  it("D23：Rampart 唯一性按坐标——不同 candidate ID 同坐标视同同一 Rampart（字典序决胜确定性）", () => {
    const footprints = collectPhysicalCandidateFootprints(
      [
        { slot: "a", x: 24, y: 25 },
        { slot: "b", x: 24, y: 25 },
        { slot: "c", x: 24, y: 26 },
      ],
      new Set([candidateKeyOf(24, 25), candidateKeyOf(24, 26)]),
    );
    expect(footprints.get(candidateKeyOf(24, 25))).toBe("a");
    expect(footprints.get(candidateKeyOf(24, 26))).toBe("c");
  });
});
