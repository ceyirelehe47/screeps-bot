import { setupPathFinderGlobal } from "@mock/movement";
jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  ...jest.requireActual("@/runtime/cpuPhaseProfiler"),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

import { runTowerDrainPair, type TowerDrainPairState } from "@/roles/towerDrainPair";
import { clearWarGeometryForTest } from "@/roles/warGeometry";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";

const TARGET = "E3N57";
const SOURCE = "E2N57";
const RED_CONFIG = "E1N57:war:E3N57:g1:meleeAttacker:0";
const GREEN_CONFIG = "E1N57:war:E3N57:g1:healer:0";
const OLD_RED = { x: 0, y: 25 };
const OLD_GREEN = { x: 0, y: 26 };

function structure(type: StructureConstant, x: number, y: number): Structure {
  return {
    id: `${type}:${x}:${y}`, structureType: type, pos: new MockPos(x, y, TARGET),
    ...(type === STRUCTURE_WALL || type === STRUCTURE_PORTAL ? {} : { owner: { username: "enemy" }, my: false }),
    hits: 1000, hitsMax: 1000,
    store: createMockStore(),
  } as unknown as Structure;
}

function room(name: string, structures: Structure[], hostiles: Creep[]): Room {
  return {
    name,
    controller: { my: false, pos: new MockPos(40, 40, name), owner: { username: "enemy" } },
    find: (type: FindConstant) => type === FIND_STRUCTURES ? structures
      : type === FIND_HOSTILE_STRUCTURES ? structures.filter(value => value.structureType !== STRUCTURE_WALL && value.structureType !== STRUCTURE_PORTAL)
        : type === FIND_HOSTILE_CREEPS ? hostiles : [],
  } as unknown as Room;
}

function targetTerrain(alternateRows: number[]): ReturnType<GameMap["getRoomTerrain"]> {
  const openings = new Set([25, 26, ...alternateRows]);
  return { get: (x: number, y: number) => x === 0 && !openings.has(y) ? TERRAIN_MASK_WALL : 0 } as ReturnType<GameMap["getRoomTerrain"]>;
}

/** 只观察策略状态与原生 move 意图；坐标由各断言设置，不模拟帧末移动、碰撞或塔伤。 */
function fixture(objective: "utility" | "hostile", sealed = true) {
  clearWarGeometryForTest();
  const structures: Structure[] = objective === "utility" ? [structure(STRUCTURE_EXTENSION, 10, 10)] : [];
  const hostile = createMockPowerBankCreep("scout", { name: "enemy", roomName: TARGET, x: 10, y: 10 });
  Object.assign(hostile, { owner: { username: "enemy" }, my: false });
  const hostiles = objective === "hostile" ? [hostile] : [];
  const target = room(TARGET, structures, hostiles);
  const source = room(SOURCE, [], []);
  hostile.room = target;
  let terrain = targetTerrain([10, 11]);
  const plain = { get: () => 0 } as ReturnType<GameMap["getRoomTerrain"]>;
  const reader = (name: string): ReturnType<GameMap["getRoomTerrain"]> => name === TARGET ? terrain : plain;
  Game.rooms = { [TARGET]: target, [SOURCE]: source };
  Game.map = {
    describeExits: (name: string) => name === TARGET ? { [LEFT]: SOURCE } : name === SOURCE ? { [RIGHT]: TARGET } : {},
    getRoomTerrain: reader,
  } as unknown as GameMap;

  const parts = (type: BodyPartConstant): Array<{ type: BodyPartConstant; hits: number }> => Array.from({ length: 25 }, () => ({ type, hits: 100 }));
  const state: TowerDrainPairState = {
    targetRoom: TARGET, retreatRoom: SOURCE, exitDirection: LEFT, phase: "breaching",
    attackerEntry: { ...OLD_RED }, healerEntry: { ...OLD_GREEN },
  };
  const attacker = createMockPowerBankCreep("meleeAttacker", {
    name: "red", roomName: TARGET, x: 1, y: 25, body: [...parts(ATTACK), ...parts(MOVE)],
    memory: { configName: RED_CONFIG, _warPartnerConfigName: GREEN_CONFIG, _warTowerDrain: state },
  });
  const healer = createMockPowerBankCreep("healer", {
    name: "green", roomName: TARGET, x: 1, y: 26, body: [...parts(HEAL), ...parts(MOVE)],
    memory: { configName: GREEN_CONFIG, _warPartnerConfigName: RED_CONFIG, _warTowerDrain: { ...state } },
  });
  attacker.room = healer.room = target;
  Game.creeps = { red: attacker, green: healer };

  const sealOldEntry = (): void => {
    // 8 邻连通：x=2 两端斜角和 x=1 上下口均封住，旧入口退路仍开放。
    for (const [x, y] of [[1, 24], [1, 27], [2, 24], [2, 25], [2, 26], [2, 27]]) {
      structures.push(structure(STRUCTURE_WALL, x, y));
    }
  };
  if (sealed) sealOldEntry();
  return {
    attacker, healer, structures, sealOldEntry,
    state: (): TowerDrainPairState => attacker.memory._warTowerDrain!,
    place: (member: Creep, x: number, y: number, roomName = SOURCE): void => {
      member.pos = new MockPos(x, y, roomName) as unknown as RoomPosition;
      member.room = Game.rooms[roomName];
    },
    replaceTerrain: (identity: "reader" | "map" | "Game"): void => {
      // 同房名装载另一张测试地图；真实 Screeps 地形不随 reader 包装器变化。
      clearWarGeometryForTest();
      terrain = targetTerrain([40, 41]);
      if (identity === "reader") Game.map.getRoomTerrain = (name: string) => reader(name);
      else if (identity === "map") Game.map = { ...Game.map };
      else Object.assign(global, { Game: { ...Game } });
    },
  };
}

function expectOldEntry(state: TowerDrainPairState): void {
  expect(state.attackerEntry).toEqual(OLD_RED);
  expect(state.healerEntry).toEqual(OLD_GREEN);
}

describe("towerDrainDuo 死袋入口重选策略", () => {
  beforeEach(() => {
  setupPathFinderGlobal();
    Object.assign(global, { RoomPosition: MockPos });
  });

  it("utility 尚存时撤出死袋，双方回旧 stage 后才按新 reader 重选，第二 role 同 tick 不跨房", () => {
    const world = fixture("utility");
    expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(world.state()).toMatchObject({ phase: "retreating", reselectRequested: true, blocker: "entry_reselection_retreat" });
    expectOldEntry(world.state());
    expect(world.attacker.move).toHaveBeenCalledWith(LEFT);
    expect(runTowerDrainPair(world.healer, TARGET, RED_CONFIG)).toBe(true);
    expectOldEntry(world.state());
    expect(world.healer.move).toHaveBeenCalledWith(LEFT);

    // 已到源房但绿仍在自动迁房边缘，不能提前把退路改到另一出口。
    world.place(world.attacker, 48, 25);
    world.place(world.healer, 49, 26);
    (world.attacker.move as jest.Mock).mockClear();
    expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(world.state()).toMatchObject({ phase: "recovering", reselectRequested: true, blocker: "entry_reselection_retreat" });
    expectOldEntry(world.state());
    expect(world.attacker.move).not.toHaveBeenCalled();

    // 同 tick 换原生地形 reader：10/11 已封，40/41 是唯一开放替代。
    world.replaceTerrain("reader");
    world.place(world.healer, 48, 26);
    (world.healer.move as jest.Mock).mockClear();
    expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(world.state()).toMatchObject({
      phase: "approach", attackerEntry: { x: 0, y: 40 }, healerEntry: { x: 0, y: 41 }, entrySelectedAt: Game.time,
    });
    expect(world.state().reselectRequested).toBeUndefined();
    expect(runTowerDrainPair(world.healer, TARGET, RED_CONFIG)).toBe(true);
    expect(world.state()).toMatchObject({ phase: "approach", blocker: "entry_reselected" });
    expect(world.attacker.move).not.toHaveBeenCalled();
    expect(world.healer.move).not.toHaveBeenCalled();
  });

  it("核心和 utility 已清时仍为敌兵重选，显式重置测试地图后兼容 map 与 Game 包装器更换", () => {
    for (const identity of ["map", "Game"] as const) {
      const world = fixture("hostile");
      expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(true);
      expect(world.state()).toMatchObject({ phase: "retreating", reselectRequested: true });
      expectOldEntry(world.state());

      world.place(world.attacker, 48, 25);
      world.place(world.healer, 48, 26);
      world.replaceTerrain(identity);
      expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(true);
      expect(world.state()).toMatchObject({
        phase: "approach", attackerEntry: { x: 0, y: 40 }, healerEntry: { x: 0, y: 41 }, entrySelectedAt: Game.time,
      });
      expect(world.state().reselectRequested).toBeUndefined();
    }
  });

  it("同 tick 新墙封住唯一开放替代时保留必要突破，拆除替代墙后才触发死袋撤退", () => {
    const world = fixture("utility", false);
    // 先读取开放旧通路，随后只变动态结构；不更换 Game、map、reader 或 tick。
    expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(false);
    expect(world.state().reselectRequested).toBeUndefined();
    world.sealOldEntry();
    const alternateWalls = [structure(STRUCTURE_WALL, 0, 10), structure(STRUCTURE_WALL, 0, 11)];
    world.structures.push(...alternateWalls);
    expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(false);
    expect(world.state()).toMatchObject({ phase: "breaching" });
    expect(world.state().reselectRequested).toBeUndefined();
    expectOldEntry(world.state());
    expect(world.attacker.move).not.toHaveBeenCalled();

    world.structures.splice(world.structures.indexOf(alternateWalls[0]), alternateWalls.length);
    expect(runTowerDrainPair(world.attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(world.state()).toMatchObject({ phase: "retreating", reselectRequested: true, blocker: "entry_reselection_retreat" });
    expectOldEntry(world.state());
    expect(world.attacker.move).toHaveBeenCalledWith(LEFT);
  });
});
