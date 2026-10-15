jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/movement/traffic", () => ({ ...jest.requireActual("@/movement/traffic"),
  moveOffExit: jest.fn(() => OK),
}));

import { meleeAttackerRole, findWarObjectiveTarget } from "@/roles/meleeAttacker";
import * as towerDrainPair from "@/roles/towerDrainPair";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};
const TARGET_ROOM = "E3N57";
const ATTACKER_CONFIG = "E1N57:war:E3N57:meleeAttacker:0";
const HEALER_CONFIG = "E1N57:war:E3N57:healer:0";

function hostileCreep(name: string, hits: number, parts: Partial<Record<BodyPartConstant, number>> = {}): Creep {
  return {
    id: name as Id<Creep>,
    name,
    owner: { username: "TooAngel" },
    hits,
    pos: new MockPos(26, 25, TARGET_ROOM) as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => parts[part] ?? 0),
  } as unknown as Creep;
}

function hostileStructure(type: StructureConstant, id: string, x: number, y: number, hits = 3000): Structure {
  return {
    id: id as Id<Structure>,
    structureType: type,
    hits,
    hitsMax: hits,
    pos: { x, y, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
  } as Structure;
}

// 目标策略用例仍使用模拟搜索；路径逐步相邻且确实抵达目标攻击范围。
function combatPathThrough(...waypoints: Array<readonly [number, number]>): RoomPosition[] {
  const path: RoomPosition[] = [];
  let [x, y] = waypoints[0];
  for (const [targetX, targetY] of waypoints.slice(1)) {
    while (x !== targetX || y !== targetY) {
      x += Math.sign(targetX - x);
      y += Math.sign(targetY - y);
      path.push({ x, y, roomName: TARGET_ROOM } as RoomPosition);
    }
  }
  return path;
}


describe("meleeAttackerRole war duo staging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moveToTarget.mockReturnValue(OK);
    moveToTargetRoom.mockReturnValue(OK);
    Game.creeps = {};
    Object.assign(global, {
      PathFinder: {
        CostMatrix: class {
          private readonly values = new Map<string, number>();

          public set(x: number, y: number, value: number): void {
            this.values.set(`${x}:${y}`, value);
          }

          public get(x: number, y: number): number {
            return this.values.get(`${x}:${y}`) ?? 0;
          }
        },
        search: jest.fn(),
      },
    });
  });

  it("补剿的旧被动建筑不再选为目标，新建筑和生产设施仍是目标", () => {
    const old = hostileStructure(STRUCTURE_EXTRACTOR, "old-extractor", 25, 25);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM, memory: { configName: ATTACKER_CONFIG } });
    const structures = [old];
    attacker.room.find = jest.fn((type: FindConstant) => type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES ? structures : []) as Room["find"];
    Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, rebuildIgnoreStructureIds: [old.id, "old-spawn"] } } };
    expect(findWarObjectiveTarget(attacker)).toBeNull();
    const rebuilt = hostileStructure(STRUCTURE_EXTENSION, "new-extension", 26, 25);
    structures.push(rebuilt);
    expect(findWarObjectiveTarget(attacker)).toBe(rebuilt);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "old-spawn", 27, 25);
    structures.push(spawn);
    expect(findWarObjectiveTarget(attacker)).toBe(spawn);
    attacker.memory.configName = "another-source:war:E3N57:meleeAttacker:0";
    structures.splice(1);
    expect(findWarObjectiveTarget(attacker)).toBe(old);
  });

  it.each([STRUCTURE_RAMPART, STRUCTURE_EXTENSION] as const)("共享巡逻有开放目标%s时，不被更弱的中性墙抢占", (type) => {
    const wall = hostileStructure(STRUCTURE_WALL, "unnecessary-neutral-wall", 47, 11, 165_551);
    const target = hostileStructure(type, "patrol-objective", 25, 25, 9001);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 20, y: 20,
      memory: { configName: ATTACKER_CONFIG } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 19, y: 20,
      memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, target] : kind === FIND_HOSTILE_STRUCTURES ? [target] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, sharedSquadWatchId: "patrol-watch" } } };
    (PathFinder.search as jest.Mock).mockReturnValue({ path: combatPathThrough([20, 20], [24, 24]), incomplete: false, ops: 10 });
    const drainGate = jest.spyOn(towerDrainPair, "runTowerDrainPair").mockReturnValue(false);
    const safePath = jest.spyOn(towerDrainPair, "constrainTowerDrainBreachPath").mockImplementation((_creep, _roomName, matrix) => matrix);
    try {
      expect(findWarObjectiveTarget(attacker, true)).toBe(target);
      meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG, "towerDrainDuo").target(attacker);
      expect(attacker.attack).toHaveBeenCalledWith(target);
      expect(attacker.attack).not.toHaveBeenCalledWith(wall);
      expect(moveToTarget).toHaveBeenCalledWith(attacker, target, 1, expect.objectContaining({ costCallback: expect.any(Function) }));
      if (type === STRUCTURE_EXTENSION) expect(safePath).toHaveBeenCalledWith(attacker, TARGET_ROOM, expect.any(Object));
    } finally {
      safePath.mockRestore();
      drainGate.mockRestore();
    }
  });

  it("共享巡逻仍可突破实际目标路径上的中性墙，并保留耗塔安全矩阵", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "necessary-neutral-wall", 22, 20, 500_000);
    const incidental = hostileStructure(STRUCTURE_WALL, "weak-unnecessary-neutral-wall", 20, 19, 100);
    const core = hostileStructure(STRUCTURE_INVADER_CORE, "sealed-patrol-objective", 25, 25, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 20, y: 20,
      memory: { configName: ATTACKER_CONFIG } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 19, y: 20,
      memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [incidental, wall, core] : kind === FIND_HOSTILE_STRUCTURES ? [core] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, sharedSquadWatchId: "patrol-watch" } } };
    (PathFinder.search as jest.Mock)
      .mockReturnValueOnce({ path: [], incomplete: true, ops: 100 })
      .mockReturnValueOnce({ path: combatPathThrough([20, 20], [22, 20], [24, 22], [24, 24]), incomplete: false, ops: 100 });
    const drainGate = jest.spyOn(towerDrainPair, "runTowerDrainPair").mockReturnValue(false);
    const safePath = jest.spyOn(towerDrainPair, "constrainTowerDrainBreachPath").mockImplementation((_creep, _roomName, matrix) => matrix);
    try {
      meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG, "towerDrainDuo").target(attacker);
      expect(attacker.attack).toHaveBeenCalledWith(wall);
      expect(attacker.attack).not.toHaveBeenCalledWith(incidental);
      expect(attacker.memory._warBreachTargetId).toBe(wall.id);
      expect(moveToTarget).toHaveBeenCalledWith(attacker, wall, 1, expect.objectContaining({ costCallback: expect.any(Function) }));
      expect(safePath).toHaveBeenCalledWith(attacker, TARGET_ROOM, expect.any(Object));
      expect(PathFinder.search).toHaveBeenCalledTimes(2);
    } finally {
      safePath.mockRestore();
      drainGate.mockRestore();
    }
  });

  it("中性墙独立目标许可只约束本任务共享巡逻，普通耗塔清墙与其它身份保持原行为", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "neutral-cleanup-wall", 24, 25, 100);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM, memory: { configName: ATTACKER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall] : []) as Room["find"];
    Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, sharedSquadWatchId: "patrol-watch" } } };
    expect(findWarObjectiveTarget(attacker, true)).toBeNull();
    attacker.memory.configName = "another-source:war:E3N57:meleeAttacker:0";
    expect(findWarObjectiveTarget(attacker, true)).toBe(wall);
    attacker.memory.configName = ATTACKER_CONFIG;
    delete Memory.data.war![TARGET_ROOM].sharedSquadWatchId;
    expect(findWarObjectiveTarget(attacker, true)).toBe(wall);
    expect(findWarObjectiveTarget(attacker)).toBeNull();
  });

  it.each(["worker", "defender"] as const)("共享巡逻设施清除后追击远处%s，敌人消失后恢复无目标", (kind) => {
    const enemy = hostileCreep(`remaining-${kind}`, 800, kind === "defender" ? { [RANGED_ATTACK]: 1, [HEAL]: 1 } : {});
    enemy.pos = new MockPos(40, 40, TARGET_ROOM) as unknown as RoomPosition;
    const keeper = hostileCreep("ignored-keeper", 5000, { [ATTACK]: 10 });
    Object.assign(keeper.owner, { username: "Source Keeper" });
    const hostiles = [enemy, keeper];
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 25, y: 25,
      memory: { configName: ATTACKER_CONFIG } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 24, y: 25,
      memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((type: FindConstant, options?: { filter?: (hostile: Creep) => boolean }) =>
      type === FIND_HOSTILE_CREEPS ? hostiles.filter(options?.filter ?? (() => true)) : [],
    ) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, sharedSquadWatchId: "patrol-watch" } } };
    (PathFinder.search as jest.Mock).mockReturnValue({ path: combatPathThrough([25, 25], [39, 39]), incomplete: false, ops: 100 });
    const drainGate = jest.spyOn(towerDrainPair, "runTowerDrainPair").mockReturnValue(false);
    const safePath = jest.spyOn(towerDrainPair, "constrainTowerDrainBreachPath").mockImplementation((_creep, _roomName, matrix) => matrix);
    try {
      expect(findWarObjectiveTarget(attacker, true)).toBe(enemy);
      meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG, "towerDrainDuo").target(attacker);
      expect(attacker.attack).toHaveBeenCalledWith(enemy);
      expect(moveToTarget).toHaveBeenCalledWith(attacker, enemy, 1, expect.objectContaining({ costCallback: expect.any(Function) }));
      expect(safePath).toHaveBeenCalledWith(attacker, TARGET_ROOM, expect.any(Object));
      expect(PathFinder.search).toHaveBeenCalledTimes(1);
      hostiles.splice(0, 1);
      expect(findWarObjectiveTarget(attacker, true)).toBeNull();
    } finally {
      safePath.mockRestore();
      drainGate.mockRestore();
    }
  });

  it("does not wait for an implicit same-index healer when the producer declares no partner", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "standard-attacker-1",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: "E1N57:war:E3N57:meleeAttacker:1",
      },
    });
    Game.creeps = { [attacker.name]: attacker };

    meleeAttackerRole(TARGET_ROOM, "", "", "", "").source?.(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      "",
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it.each(["source", "target"] as const)(
    "keeps moving through a cleared room instead of attacking an adjacent wall in %s phase",
    (phase) => {
      const wall = hostileStructure(STRUCTURE_WALL, "leftover-wall", 25, 24, 500_000);
      const attacker = createMockPowerBankCreep("meleeAttacker", {
        roomName: TARGET_ROOM,
        x: 24,
        y: 24,
        memory: {
          role: "meleeAttacker",
          configName: ATTACKER_CONFIG,
          _warBreachTargetId: wall.id as Id<StructureWall>,
        },
      });
      attacker.pos.findInRange = jest.fn((type: FindConstant) =>
        type === FIND_STRUCTURES ? [wall] : [],
      ) as unknown as RoomPosition["findInRange"];
      Game.creeps = { [attacker.name]: attacker };

      const role = meleeAttackerRole("E2N54", "", "", "", "");
      if (phase === "source") role.source?.(attacker);
      else role.target(attacker);

      expect(moveToTargetRoom).toHaveBeenCalledWith(attacker, "E2N54", "", expect.any(Object));
      expect(attacker.attack).not.toHaveBeenCalled();
      expect(attacker.memory._warBreachTargetId).toBeUndefined();
    },
  );

  it("attacks an adjacent wall only when travel has no path", () => {
    moveToTargetRoom.mockReturnValue(ERR_NO_PATH);
    const wall = hostileStructure(STRUCTURE_WALL, "route-blocking-wall", 25, 24, 500_000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 24,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.pos.findInRange = jest.fn((type: FindConstant) =>
      type === FIND_STRUCTURES ? [wall] : [],
    ) as unknown as RoomPosition["findInRange"];
    Game.creeps = { [attacker.name]: attacker };

    meleeAttackerRole("E2N54", "", "", "", "").source?.(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(wall);
    expect(attacker.memory._warBreachTargetId).toBe(wall.id);
  });

  it.each([OK, ERR_NO_PATH])("同目标存在开放绕行路线时撤销旧墙目标，移动结果%s也不授予拆墙许可", (moveResult) => {
    const wall = hostileStructure(STRUCTURE_WALL, "old-wall", 2, 28, 500000);
    const road = hostileStructure(STRUCTURE_ROAD, "open-road", 2, 32);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "open-spawn", 25, 25, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28,
      memory: { configName: ATTACKER_CONFIG, _warBreachTargetId: wall.id as Id<StructureWall> } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, road, spawn] : kind === FIND_HOSTILE_STRUCTURES ? [spawn] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn((kind: FindConstant) => kind === FIND_STRUCTURES ? [wall] : []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target) => target === spawn ? ERR_NOT_IN_RANGE : OK) as Creep["attack"];
    Game.creeps = { red: attacker, green: healer };
    Game.getObjectById = jest.fn(() => wall) as typeof Game.getObjectById;
    (PathFinder.search as jest.Mock).mockReturnValue({ path: combatPathThrough([1, 28], [1, 31], [2, 32], [9, 25], [24, 25]), incomplete: false, ops: 1500 });
    moveToTarget.mockReturnValue(moveResult);
    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);
    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(attacker.attack).not.toHaveBeenCalledWith(wall);
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    const options = (PathFinder.search as jest.Mock).mock.calls[0][2];
    expect(options).toMatchObject({ maxRooms: 1, maxOps: 2000 });
    expect(options.roomCallback(TARGET_ROOM).get(2, 28)).toBe(255);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, spawn, 1, expect.any(Object));
  });

  it("耗塔队最近核心封闭时先走另一开放核心，相邻wall/rampart不能抢占目标", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "sealed-wall", 2, 28, 500000);
    const rampart = hostileStructure(STRUCTURE_RAMPART, "adjacent-rampart", 2, 27, 1000);
    const closed = hostileStructure(STRUCTURE_SPAWN, "closed-spawn", 5, 28, 5000);
    const open = hostileStructure(STRUCTURE_SPAWN, "open-spawn", 25, 25, 5000);
    const road = hostileStructure(STRUCTURE_ROAD, "open-road", 2, 32);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28,
      memory: { configName: ATTACKER_CONFIG, _warBreachTargetId: wall.id as Id<StructureWall> } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, rampart, road, closed, open] : kind === FIND_HOSTILE_STRUCTURES ? [rampart, closed, open] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    (PathFinder.search as jest.Mock)
      .mockReturnValueOnce({ path: [], incomplete: true })
      .mockReturnValueOnce({ path: combatPathThrough([1, 28], [4, 28]), incomplete: false })
      .mockReturnValueOnce({ path: combatPathThrough([1, 28], [1, 31], [2, 32], [9, 25], [24, 25]), incomplete: false });
    // 此用例单独检查耗塔门放行后的目标选择；门本身由 towerDrainPair.test 验证。
    const drainGate = jest.spyOn(towerDrainPair, "runTowerDrainPair").mockReturnValue(false);
    try {
      meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG, "towerDrainDuo").target(attacker);
    } finally {
      drainGate.mockRestore();
    }
    expect(attacker.attack).toHaveBeenCalledWith(open);
    expect(attacker.attack).not.toHaveBeenCalledWith(wall);
    expect(attacker.attack).not.toHaveBeenCalledWith(rampart);
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    expect(moveToTarget).toHaveBeenCalledWith(attacker, open, 1, expect.any(Object));
  });

  it("InvaderCore确需突破时只攻击已证明路径上的墙，忽略旁边更弱的墙", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "sealed-wall", 2, 28, 500000);
    const incidental = hostileStructure(STRUCTURE_WALL, "incidental-wall", 2, 27, 100);
    const core = hostileStructure(STRUCTURE_INVADER_CORE, "sealed-core", 25, 25, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28, memory: { configName: ATTACKER_CONFIG } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [incidental, wall, core] : kind === FIND_HOSTILE_STRUCTURES ? [core] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    Game.creeps = { red: attacker, green: healer };
    (PathFinder.search as jest.Mock).mockReturnValueOnce({ path: [], incomplete: true, ops: 100 }).mockReturnValueOnce({ path: [wall.pos], incomplete: false, ops: 100 });
    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);
    expect(attacker.attack).toHaveBeenCalledWith(wall);
    expect(attacker.attack).not.toHaveBeenCalledWith(incidental);
    expect(attacker.memory._warBreachTargetId).toBe(wall.id);
    expect(PathFinder.search).toHaveBeenCalledTimes(2);
  });

  it("耗塔队保留覆盖敌塔的rampart目标，不被相邻中立墙抢占", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "incidental-wall", 2, 28, 1_800_000);
    const tower = hostileStructure(STRUCTURE_TOWER, "covered-tower", 25, 25, 3000);
    const covering = hostileStructure(STRUCTURE_RAMPART, "covering-rampart", 25, 25, 10_201);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28,
      memory: { configName: ATTACKER_CONFIG } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, tower, covering] : kind === FIND_HOSTILE_STRUCTURES ? [tower, covering] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn((kind: FindConstant) => kind === FIND_STRUCTURES ? [wall] : []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    const drainGate = jest.spyOn(towerDrainPair, "runTowerDrainPair").mockReturnValue(false);
    try {
      meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG, "towerDrainDuo").target(attacker);
    } finally {
      drainGate.mockRestore();
    }

    expect(attacker.attack).toHaveBeenCalledWith(covering);
    expect(attacker.attack).not.toHaveBeenCalledWith(wall);
    expect(attacker.memory._warBreachTargetId).toBe(covering.id);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, covering, 1, expect.objectContaining({ costCallback: expect.any(Function) }));
    expect(PathFinder.search).not.toHaveBeenCalled();
  });

  it.each([100, 2000])("路径搜索未提供可走或可突破证明时保持位置，不攻击邻墙（ops=%s）", (ops) => {
    const wall = hostileStructure(STRUCTURE_WALL, "unproven-wall", 2, 28, 100);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "unreachable-spawn", 25, 25, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28,
      memory: { configName: ATTACKER_CONFIG, _warBreachTargetId: wall.id as Id<StructureWall> } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, spawn] : kind === FIND_HOSTILE_STRUCTURES ? [spawn] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn((kind: FindConstant) => kind === FIND_STRUCTURES ? [wall] : []) as unknown as RoomPosition["findInRange"];
    Game.creeps = { red: attacker, green: healer };
    (PathFinder.search as jest.Mock)
      .mockReturnValueOnce({ path: [], incomplete: true, ops })
      // 开放搜索用尽预算时，即使放宽墙后能找到路径也不能据此允许拆墙。
      .mockReturnValue({ path: [wall.pos], incomplete: ops < 2000, ops: 100 });

    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(attacker.move).not.toHaveBeenCalled();
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    expect(PathFinder.search).toHaveBeenCalledTimes(ops < 2000 ? 2 : 1);
  });

  it.each([undefined, TARGET_ROOM])("目标失效时战争角色等待重选，普通角色保留原回退（targetRoom=%s）", (targetRoom) => {
    const rampart = hostileStructure(STRUCTURE_RAMPART, "nearest-rampart", 24, 25, 1000);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "invalid-spawn", 26, 25, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM, x: 25, y: 25,
      memory: { configName: ATTACKER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES || kind === FIND_HOSTILE_STRUCTURES ? [rampart, spawn] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target) => target === spawn ? ERR_INVALID_TARGET : OK);
    Game.creeps = { [attacker.name]: attacker };

    meleeAttackerRole(targetRoom).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    if (targetRoom) {
      expect(attacker.attack).toHaveBeenCalledTimes(1);
      expect(attacker.attack).not.toHaveBeenCalledWith(rampart);
    } else {
      expect(attacker.attack).toHaveBeenCalledWith(rampart);
    }
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("focuses hostile spawn before non-adjacent creeps and towers for war objectives", () => {
    const hostile = hostileCreep("hostile-defender", 800, { [ATTACK]: 5 });
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-war-objective", 20, 20, 5000);
    const tower = hostileStructure(STRUCTURE_TOWER, "tower-war-objective", 10, 10, 3000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_HOSTILE_STRUCTURES) return [tower, spawn];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === spawn ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 2, y: 1, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(attacker.attack).not.toHaveBeenCalledWith(hostile);
    expect(attacker.attack).not.toHaveBeenCalledWith(tower);
    expect(moveToTarget).toHaveBeenCalledWith(
      attacker,
      spawn,
      1,
      expect.objectContaining({
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
        ignoreCreeps: false,
        reusePath: 0,
      }),
    );
    expect((attacker.memory as CreepMemory & { _warMoveIntentAt?: number })._warMoveIntentAt).toBe(Game.time);
  });
});
