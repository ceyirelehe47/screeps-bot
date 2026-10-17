jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  ...jest.requireActual("@/runtime/cpuPhaseProfiler"),
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/movement/traffic", () => ({ ...jest.requireActual("@/movement/traffic"),
  moveOffExit: jest.fn(() => OK),
}));

import { meleeAttackerRole, findWarObjectiveTarget } from "@/roles/meleeAttacker";
import * as towerDrainPair from "@/roles/towerDrainPair";
import { setDefaultMapMocks, RealCostMatrix } from "@mock/movement";
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
    pos: new MockPos(x, y, TARGET_ROOM) as unknown as RoomPosition,
  } as Structure;
}

// 本文件只验证目标策略与请求许可；实际寻路和位置推进由多 tick 集成覆盖。
// 模拟完整搜索结果仍须逐步相邻并抵达目标范围。
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

function wallsAroundTarget(target: Structure): Structure[] {
  return [-1, 0, 1].flatMap(dx => [-1, 0, 1]
    .filter(dy => dx !== 0 || dy !== 0)
    .map(dy => hostileStructure(STRUCTURE_WALL, `${target.id}:seal:${dx}:${dy}`, target.pos.x + dx, target.pos.y + dy, 500_000)));
}

describe("meleeAttackerRole 目标策略与移动请求安全边界", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moveToTarget.mockReturnValue(OK);
    moveToTargetRoom.mockReturnValue(OK);
    Game.creeps = {}; setDefaultMapMocks();
    Object.assign(global, {
      PathFinder: {
        CostMatrix: RealCostMatrix,
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

  it("共享巡逻的敌方rampart和设施目标不被更弱的中性墙抢占", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "unnecessary-neutral-wall", 47, 11, 165_551);
    const rampart = hostileStructure(STRUCTURE_RAMPART, "patrol-rampart", 25, 25, 9001);
    const structures = [rampart];
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM, memory: { configName: ATTACKER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, ...structures] : kind === FIND_HOSTILE_STRUCTURES ? structures : []) as Room["find"];
    Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, sharedSquadWatchId: "patrol-watch" } } };
    expect(findWarObjectiveTarget(attacker, true)).toBe(rampart);
    const extension = hostileStructure(STRUCTURE_EXTENSION, "patrol-extension", 26, 25, 9001);
    structures.push(extension);
    expect(findWarObjectiveTarget(attacker, true)).toBe(extension);
    expect(PathFinder.search).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it.each([false, true])("核心攻击范围被墙封闭时，只选择完整突破路径上的墙；共享耗塔模式=%s", (towerDrain) => {
    const incidental = hostileStructure(STRUCTURE_WALL, "weak-unnecessary-neutral-wall", 20, 19, 100);
    const core = hostileStructure(STRUCTURE_INVADER_CORE, "sealed-patrol-objective", 25, 25, 5000);
    const seal = wallsAroundTarget(core);
    const wall = seal.find(s => s.pos.x === 24 && s.pos.y === 24)!;
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 20, y: 20,
      memory: { configName: ATTACKER_CONFIG } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 19, y: 20,
      memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [incidental, ...seal, core] : kind === FIND_HOSTILE_STRUCTURES ? [core] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    if (towerDrain) Memory.data = { war: { [TARGET_ROOM]: { targetRoom: TARGET_ROOM, sourceRoom: "E1N57", status: "clearing", reason: "manual",
      attempts: 1, createdAt: 1, updatedAt: Game.time, sharedSquadWatchId: "patrol-watch" } } };
    (PathFinder.search as jest.Mock)
      .mockImplementationOnce((_origin, goal, options) => {
        expect(goal).toEqual({ pos: core.pos, range: 1 });
        const matrix = options.roomCallback(TARGET_ROOM);
        expect(seal).toHaveLength(8);
        expect(seal.every(s => matrix.get(s.pos.x, s.pos.y) === 255)).toBe(true);
        return { path: [], incomplete: true, ops: 100 };
      })
      .mockReturnValueOnce({ path: combatPathThrough([20, 20], [24, 24]), incomplete: false, ops: 100 });
    const drainGate = jest.spyOn(towerDrainPair, "runTowerDrainPair").mockReturnValue(false);
    const safePath = jest.spyOn(towerDrainPair, "constrainTowerDrainBreachPath").mockImplementation((_creep, _roomName, matrix) => matrix);
    try {
      meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG, towerDrain ? "towerDrainDuo" : undefined).target(attacker);
      expect(attacker.attack).toHaveBeenCalledWith(wall);
      expect(attacker.attack).not.toHaveBeenCalledWith(incidental);
      expect(attacker.memory._warBreachTargetId).toBe(wall.id);
      expect(moveToTarget).toHaveBeenCalledWith(attacker, wall, 1, expect.objectContaining({ requireCompletePath: true, reusePath: towerDrain ? 0 : 3 }));
      if (towerDrain) expect(jest.mocked(moveToTarget).mock.calls[0][3]?.costCallback).toEqual(expect.any(Function));
      else expect(jest.mocked(moveToTarget).mock.calls[0][3]?.costCallback).toBeUndefined();
      if (towerDrain) expect(safePath).toHaveBeenCalledWith(attacker, TARGET_ROOM, expect.any(Object));
      else expect(safePath).not.toHaveBeenCalled();
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

  it.each(["worker", "defender"] as const)("共享巡逻仅余远处%s时选敌兵并校验approach，敌人消失后恢复无目标", (kind) => {
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

  it("未声明搭档时直接发跨房移动请求，不推断同索引治疗", () => {
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
    "%s阶段跨房移动请求获准时，撤销旧邻墙目标且不攻击",
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

  it("跨房移动层返回ERR_NO_PATH时允许记录并攻击邻墙", () => {
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

  it("开放路线已证明后，移动层ERR_NO_PATH也不授予邻墙攻击许可，并撤销旧墙目标", () => {
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
    moveToTarget.mockReturnValue(ERR_NO_PATH);
    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);
    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(attacker.attack).not.toHaveBeenCalledWith(wall);
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    const options = (PathFinder.search as jest.Mock).mock.calls[0][2];
    expect(options).toMatchObject({ maxRooms: 1, maxOps: 8000 });
    expect(options.roomCallback(TARGET_ROOM).get(2, 28)).toBe(255);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, spawn, 1, expect.any(Object));
  });

  it("最近核心攻击范围封闭而另一核心已有开放路径证明时，选择后者并撤销旧墙目标", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "sealed-wall", 2, 28, 500000);
    const rampart = hostileStructure(STRUCTURE_RAMPART, "adjacent-rampart", 2, 27, 1000);
    const closed = hostileStructure(STRUCTURE_SPAWN, "closed-spawn", 5, 28, 5000);
    const seal = wallsAroundTarget(closed);
    const open = hostileStructure(STRUCTURE_SPAWN, "open-spawn", 25, 25, 5000);
    const road = hostileStructure(STRUCTURE_ROAD, "open-road", 2, 32);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28,
      memory: { configName: ATTACKER_CONFIG, _warBreachTargetId: wall.id as Id<StructureWall> } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? [wall, ...seal, rampart, road, closed, open] : kind === FIND_HOSTILE_STRUCTURES ? [rampart, closed, open] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    (PathFinder.search as jest.Mock)
      .mockImplementationOnce((_origin, goal, options) => {
        expect(goal).toEqual({ pos: closed.pos, range: 1 });
        const matrix = options.roomCallback(TARGET_ROOM);
        expect(seal).toHaveLength(8);
        expect(seal.every(s => matrix.get(s.pos.x, s.pos.y) === 255)).toBe(true);
        return { path: [], incomplete: true, ops: 100 };
      })
      .mockReturnValueOnce({ path: combatPathThrough([1, 28], [2, 29], [3, 29], [4, 28]), incomplete: false, ops: 100 })
      .mockImplementationOnce((_origin, goal, options) => {
        expect(goal).toEqual({ pos: open.pos, range: 1 });
        const path = combatPathThrough([1, 28], [1, 31], [2, 32], [7, 32], [14, 25], [24, 25]);
        const matrix = options.roomCallback(TARGET_ROOM);
        expect(path.every(step => matrix.get(step.x, step.y) < 255)).toBe(true);
        return { path, incomplete: false, ops: 100 };
      });
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

  it("连续三 tick 保持可达替代目标，邻接目标不受游标影响，目标失效后恢复轮询", () => {
    Game.time += 20;
    const wall = hostileStructure(STRUCTURE_WALL, "sticky-wall", 10, 10);
    const preferred = hostileStructure(STRUCTURE_SPAWN, "sticky-preferred", 5, 5);
    const open = hostileStructure(STRUCTURE_SPAWN, "sticky-open", 25, 25);
    const closed = hostileStructure(STRUCTURE_SPAWN, "sticky-closed", 30, 30);
    const structures = [wall, preferred, open, closed];
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "sticky-red", roomName: TARGET_ROOM, x: 1, y: 1,
      memory: { configName: ATTACKER_CONFIG } });
    attacker.room.find = jest.fn(kind => kind === FIND_STRUCTURES ? structures : kind === FIND_HOSTILE_STRUCTURES
      ? structures.filter(s => s !== wall) : []) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { [attacker.name]: attacker };
    (PathFinder.search as jest.Mock).mockImplementation((_origin, goal) => goal.pos === open.pos
      ? { path: combatPathThrough([1, 1], [1, 24], [24, 24]), incomplete: false, ops: 100 }
      : { path: [], incomplete: true, ops: 2000 });
    const role = meleeAttackerRole(TARGET_ROOM);
    for (let i = 0; i < 3; i++) {
      (attacker.attack as jest.Mock).mockClear();
      role.target(attacker);
      expect(attacker.attack).toHaveBeenCalledWith(open);
      Game.time++;
    }
    const adjacent = hostileStructure(STRUCTURE_EXTENSION, "sticky-adjacent", 2, 1);
    structures.push(adjacent);
    (attacker.attack as jest.Mock).mockClear();
    role.target(attacker);
    expect(attacker.attack).toHaveBeenCalledWith(adjacent);
    structures.splice(structures.indexOf(adjacent), 1);
    structures.splice(structures.indexOf(open), 1);
    Game.time++;
    (attacker.attack as jest.Mock).mockClear();
    role.target(attacker);
    expect(attacker.attack).not.toHaveBeenCalledWith(open);
    expect((PathFinder.search as jest.Mock).mock.calls.some(([, goal]) => goal.pos === closed.pos)).toBe(true);
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

  it.each([100, 8000])("搜索无完整证明时拒绝邻墙，屏障消失后重新请求目标移动（ops=%s）", (ops) => {
    const wall = hostileStructure(STRUCTURE_WALL, "unproven-wall", 2, 28, 100);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "unreachable-spawn", 25, 25, 5000);
    const structures = [wall, spawn];
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 1, y: 28,
      memory: { configName: ATTACKER_CONFIG, _warBreachTargetId: wall.id as Id<StructureWall> } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 1, y: 29, memory: { configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES ? structures : kind === FIND_HOSTILE_STRUCTURES ? [spawn] : []) as Room["find"];
    attacker.pos.findInRange = jest.fn((kind: FindConstant) => kind === FIND_STRUCTURES ? [wall] : []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    Game.creeps = { red: attacker, green: healer };
    (PathFinder.search as jest.Mock)
      .mockReturnValueOnce({ path: [], incomplete: true, ops })
      .mockReturnValue({ path: [], incomplete: true, ops: 100 });

    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(attacker.move).not.toHaveBeenCalled();
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    expect(PathFinder.search).toHaveBeenCalledTimes(ops === 8000 ? 3 : 2);

    // 另一单位拆掉屏障是实际世界变化；不靠单纯流逝一 tick 假称能够恢复。
    Game.time += 1;
    structures.splice(0, 1);
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);
    expect(attacker.attack).toHaveBeenCalledTimes(1);
    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, spawn, 1, expect.any(Object));
    expect(attacker.attack).not.toHaveBeenCalledWith(wall);
    expect(PathFinder.search).toHaveBeenCalledTimes(ops === 8000 ? 3 : 2);
  });

  it.each([undefined, TARGET_ROOM])("战争目标本帧失效后下一帧重选；普通角色同帧回退（targetRoom=%s）", (targetRoom) => {
    const rampart = hostileStructure(STRUCTURE_RAMPART, "nearest-rampart", 24, 25, 1000);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "invalid-spawn", 26, 25, 5000);
    const structures = [rampart, spawn];
    const attacker = createMockPowerBankCreep("meleeAttacker", { roomName: TARGET_ROOM, x: 25, y: 25,
      memory: { configName: ATTACKER_CONFIG } });
    attacker.room.find = jest.fn((kind) => kind === FIND_STRUCTURES || kind === FIND_HOSTILE_STRUCTURES ? structures : []) as Room["find"];
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
    if (targetRoom) {
      Game.time += 1;
      structures.pop(); // fresh 房间列表已移除失效的 Spawn。
      (attacker.attack as jest.Mock).mockClear();
      meleeAttackerRole(targetRoom).target(attacker);
      expect(attacker.attack).toHaveBeenCalledTimes(1);
      expect(attacker.attack).toHaveBeenCalledWith(rampart);
      expect(attacker.memory._warBreachTargetId).toBe(rampart.id);
    }
  });

  it("approach 在四 tick 内复用，几何分桶变化或 TTL 到期立即重算", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "cache-wall", 10, 10, 1000);
    const spawn = hostileStructure(STRUCTURE_SPAWN, "cache-spawn", 25, 25, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "cache-red", roomName: TARGET_ROOM, x: 1, y: 1,
      memory: { configName: ATTACKER_CONFIG } });
    const structures = [wall, spawn];
    attacker.room.find = jest.fn(kind => kind === FIND_STRUCTURES ? structures : kind === FIND_HOSTILE_STRUCTURES ? [spawn] : []) as Room["find"];
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE); Game.creeps = { [attacker.name]: attacker };
    (PathFinder.search as jest.Mock).mockReturnValue({ path: combatPathThrough([1, 1], [1, 24], [24, 24]), incomplete: false, ops: 100 });
    const role = meleeAttackerRole(TARGET_ROOM);
    role.target(attacker); expect(PathFinder.search).toHaveBeenCalledTimes(1);
    Game.time++; role.target(attacker); expect(PathFinder.search).toHaveBeenCalledTimes(1);
    Game.time += 3; role.target(attacker); expect(PathFinder.search).toHaveBeenCalledTimes(2);
    wall.hits = 50001; Game.time++; role.target(attacker); expect(PathFinder.search).toHaveBeenCalledTimes(3);
  });

  it("预算耗尽时每帧最多评估两个候选，后续帧轮转覆盖其它核心且不授权破墙", () => {
    const wall = hostileStructure(STRUCTURE_WALL, "budget-wall", 10, 10, 1000);
    const spawns = Array.from({ length: 5 }, (_, i) => hostileStructure(STRUCTURE_SPAWN, `budget-spawn-${i}`, 25 + i, 25, 5000));
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "budget-red", roomName: TARGET_ROOM, x: 1, y: 1,
      memory: { configName: ATTACKER_CONFIG } });
    attacker.room.find = jest.fn(kind => kind === FIND_STRUCTURES ? [wall, ...spawns] : kind === FIND_HOSTILE_STRUCTURES ? spawns : []) as Room["find"];
    Game.creeps = { [attacker.name]: attacker };
    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], incomplete: true, ops: 2000 });
    const seen = new Set<string>(); const role = meleeAttackerRole(TARGET_ROOM);
    for (let i = 0; i < 5; i++) {
      (PathFinder.search as jest.Mock).mockClear(); role.target(attacker);
      expect((PathFinder.search as jest.Mock).mock.calls.length).toBeLessThanOrEqual(4);
      for (const [, goal] of (PathFinder.search as jest.Mock).mock.calls) seen.add(`${goal.pos.x}:${goal.pos.y}`);
      expect(attacker.attack).not.toHaveBeenCalled(); Game.time++;
    }
    expect(seen.size).toBe(5); expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("战争目标先选Spawn再选Tower，设施清完才选择远处敌兵", () => {
    const hostile = hostileCreep("hostile-defender", 800, { [ATTACK]: 5 });
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-war-objective", 20, 20, 5000);
    const tower = hostileStructure(STRUCTURE_TOWER, "tower-war-objective", 10, 10, 3000);
    const structures = [tower, spawn];
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_HOSTILE_STRUCTURES) return structures;
      return [];
    }) as Room["find"];
    expect(findWarObjectiveTarget(attacker)).toBe(spawn);
    Game.time += 1;
    structures.pop();
    expect(findWarObjectiveTarget(attacker)).toBe(tower);
    Game.time += 1;
    structures.pop();
    expect(findWarObjectiveTarget(attacker)).toBe(hostile);
    expect(moveToTarget).not.toHaveBeenCalled();
  });
});
