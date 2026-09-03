import { runTowerControl } from "@/runtime/towerControl";
import { readFocusFirePlannerStatsForTest, type FocusFireEngagementPlan } from "@/runtime/defenseFocusFire";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }

  public findClosestByRange<T extends { pos: { x: number; y: number } }>(targets: T[]): T | null {
    let closest: T | null = null;
    let closestRange = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const range = this.getRangeTo(target);
      if (range < closestRange) {
        closest = target;
        closestRange = range;
      }
    }

    return closest;
  }

  public lookFor(): never[] {
    return [];
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(energy: number): StoreDefinition {
  return {
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? 1000 : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY || resource === undefined ? Math.max(0, 1000 - energy) : 0,
    ),
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? energy : 0)),
  } as unknown as StoreDefinition;
}

function createBody(type: BodyPartConstant, count: number): BodyPartDefinition[] {
  return Array.from({ length: count }, () => ({ type, hits: 100 }) as BodyPartDefinition);
}

function createHostile(
  roomName: string,
  id: string,
  x: number,
  y: number,
  options: {
    hits?: number;
    body?: BodyPartDefinition[];
  } = {},
): Creep {
  const body = options.body ?? createBody(MOVE, 1);
  const hits = options.hits ?? body.length * 100;
  return {
    id: id as Id<Creep>,
    owner: {
      username: "Enemy",
    } as Owner,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    body,
    hits,
    hitsMax: hits,
  } as Creep;
}

function createTower(roomName: string, id: string, x: number, y: number, energy = 1000): StructureTower {
  return {
    id: id as Id<StructureTower>,
    structureType: STRUCTURE_TOWER,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    store: createStore(energy),
    attack: jest.fn(() => OK),
    heal: jest.fn(() => OK),
    repair: jest.fn(() => OK),
  } as unknown as StructureTower;
}

function createRoom(
  name: string,
  options: {
    towers: StructureTower[];
    hostiles?: Creep[];
    myCreeps?: Creep[];
    structures?: Structure<StructureConstant>[];
  },
): Room {
  const towers = options.towers;
  const hostiles = options.hostiles ?? [];
  const myCreeps = options.myCreeps ?? [];
  const structures = options.structures ?? towers;

  return {
    name,
    controller: {
      my: true,
    } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === FIND_MY_STRUCTURES) {
        return towers;
      }

      if (type === FIND_MY_CREEPS) {
        return myCreeps;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      return [];
    },
  } as Room;
}

describe("runTowerControl", () => {
  beforeEach(() => {
    resetRuntimeServices();
    jest.clearAllMocks();
    Game.time = 1;
    Memory.runtime = {};
  });

  it("keeps towers focused on the same target during periodic probe ticks when focus damage is still positive", () => {
    Game.time = 7;

    const roomName = "W1N1";
    const focusTarget = createHostile(roomName, "hostile-focus", 11, 10, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const otherTarget = createHostile(roomName, "hostile-other", 25, 25, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [focusTarget, otherTarget],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerB.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerA.attack).not.toHaveBeenCalledWith(otherTarget);
    expect(towerB.attack).not.toHaveBeenCalledWith(otherTarget);
  });

  it("does not waste tower energy when every hostile is immune to tower damage", () => {
    const roomName = "W1N2";
    const healerA = createHostile(roomName, "hostile-a", 30, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const healerB = createHostile(roomName, "hostile-b", 31, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [healerA, healerB],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).not.toHaveBeenCalled();
    expect(towerB.attack).not.toHaveBeenCalled();
  });

  it("【Remediation III 十七】计划目标失效：房间级共享 fallback 转向仍存活的 secondary（不独立重评分）", () => {
    const roomName = "W1N7";
    const liveSecondary = createHostile(roomName, "hostile-live", 35, 35, { hits: 100 });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const room = createRoom(roomName, {
      towers: [towerA],
      hostiles: [liveSecondary], // 计划目标 hostile-dead 不在本 tick hostiles 中（已失效）
    });
    Game.rooms[room.name] = room;
    const plan: FocusFireEngagementPlan = {
      roomName,
      plannedAtTick: Game.time,
      focusTargetId: "hostile-dead",
      focusTargetClass: "killable_this_tick",
      killExpected: true,
      focusAssignedDamage: 600,
      focusKillBudget: 115,
      focusExpectedHeal: 0,
      towerAssignments: { "tower-a": "hostile-dead" },
      defenderAssignments: {},
      defenderEngagements: {},
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["hostile-dead", "hostile-live"],
    };
    Memory.runtime = { defenseEngagement: { [roomName]: plan } } as never;
    const plannerInvocationsBefore = readFocusFirePlannerStatsForTest().invocations;

    runTowerControl();

    // Tower 转向共享 fallback 目标（不空转、不独立重评分——与 Defender 消费
    // 同一 fallbackResolution 缓存）。
    expect(towerA.attack).toHaveBeenCalledWith(liveSecondary);
    expect(readFocusFirePlannerStatsForTest().invocations).toBe(plannerInvocationsBefore);
  });

  it("【Remediation II】pressure plan（killExpected=false）仍是唯一权威：塔攻击共享压制目标而非独立评分", () => {
    const roomName = "W1N9";
    // 独立评分会选近距离高净伤的 hostile-near；共享 plan 指定 hostile-pressure
    //（killExpected=false 的压制目标）——plan 路径不得回退独立选择。
    const nearTarget = createHostile(roomName, "hostile-near", 11, 10, { hits: 100 });
    const pressureTarget = createHostile(roomName, "hostile-pressure", 35, 35, { hits: 100 });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [nearTarget, pressureTarget],
    });
    Game.rooms[room.name] = room;
    const plan: FocusFireEngagementPlan = {
      roomName,
      plannedAtTick: Game.time,
      focusTargetId: "hostile-pressure",
      focusTargetClass: "suppression_only",
      killExpected: false,
      focusAssignedDamage: 0,
      focusKillBudget: null,
      focusExpectedHeal: 9_999,
      towerAssignments: { "tower-a": "hostile-pressure", "tower-b": "hostile-pressure" },
      defenderAssignments: {},
      defenderEngagements: {},
      engagementByTargetId: {},
      emergencyHealByTowerId: {},
      fallbackTargetIds: ["hostile-pressure", "hostile-near"],
    };
    Memory.runtime = { defenseEngagement: { [roomName]: plan } } as never;
    const plannerInvocationsBefore = readFocusFirePlannerStatsForTest().invocations;

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(pressureTarget);
    expect(towerB.attack).toHaveBeenCalledWith(pressureTarget);
    expect(towerA.attack).not.toHaveBeenCalledWith(nearTarget);
    // 消费方零重评分：planner 调用计数不因 runTowerControl 增加。
    expect(readFocusFirePlannerStatsForTest().invocations).toBe(plannerInvocationsBefore);
  });

  it("【Remediation II】紧急治疗塔按 plan 治疗（不出现于攻击分配），攻击塔按分配目标攻击", () => {
    const roomName = "W1N8";
    const hostile = createHostile(roomName, "hostile-1", 20, 20, { hits: 100 });
    const wounded = createHostile(roomName, "wounded-1", 15, 15, { hits: 50 });
    const healTower = createTower(roomName, "tower-heal", 10, 10);
    const attackTower = createTower(roomName, "tower-atk", 12, 10);
    const room = createRoom(roomName, {
      towers: [healTower, attackTower],
      hostiles: [hostile],
      myCreeps: [wounded],
    });
    Game.rooms[room.name] = room;
    (Game.getObjectById as unknown as jest.Mock) = jest.fn((id: string) =>
      id === "wounded-1" ? wounded : undefined,
    );
    const plan: FocusFireEngagementPlan = {
      roomName,
      plannedAtTick: Game.time,
      focusTargetId: "hostile-1",
      focusTargetClass: "killable_this_tick",
      killExpected: true,
      focusAssignedDamage: 600,
      focusKillBudget: 115,
      focusExpectedHeal: 0,
      towerAssignments: { "tower-atk": "hostile-1" },
      defenderAssignments: {},
      defenderEngagements: {},
      engagementByTargetId: {},
      emergencyHealByTowerId: { "tower-heal": "wounded-1" },
      fallbackTargetIds: ["hostile-1"],
    };
    Memory.runtime = { defenseEngagement: { [roomName]: plan } } as never;

    runTowerControl();

    expect(healTower.heal).toHaveBeenCalledWith(wounded);
    expect(healTower.attack).not.toHaveBeenCalled();
    expect(attackTower.attack).toHaveBeenCalledWith(hostile);
    expect(attackTower.heal).not.toHaveBeenCalled();
  });
});
