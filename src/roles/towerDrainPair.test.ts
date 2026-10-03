jest.mock("@/roles/shared", () => ({ clearMovementState: jest.fn(), moveToTarget: jest.fn(() => OK), moveToTargetRoom: jest.fn(() => OK) }));
jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ measureCreepIntent: (fn: () => unknown) => fn(), measureCreepDecision: (fn: () => unknown) => fn() }));
jest.mock("@/movement/traffic", () => ({ moveOffExit: jest.fn(() => OK) }));

import { constrainTowerDrainBreachPath, runTowerDrainPair, towerDrainPairRange, type TowerDrainPairState } from "@/roles/towerDrainPair";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import * as meleeModule from "@/roles/meleeAttacker";
import { healerRole } from "@/roles/healer";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";

const TARGET = "E3N57";
const RETREAT = "E2N57";
const RED_CONFIG = "E1N57:war:E3N57:g1:meleeAttacker:0";
const GREEN_CONFIG = "E1N57:war:E3N57:g1:healer:0";
const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as { moveToTarget: jest.Mock; moveToTargetRoom: jest.Mock };
const { requestCombatObservation } = jest.requireMock("@/runtime/powerBankObserver") as { requestCombatObservation: jest.Mock };
const { moveOffExit } = jest.requireMock("@/movement/traffic") as { moveOffExit: jest.Mock };

function room(name: string, structures: Structure[] = []): Room {
  return {
    name,
    controller: { my: false, owner: { username: "npc" } },
    find: jest.fn((type: FindConstant, opts?: { filter?: (value: Structure) => boolean }) => {
      const values = type === FIND_STRUCTURES || type === FIND_HOSTILE_STRUCTURES ? structures : [];
      return opts?.filter ? values.filter(opts.filter) : values;
    }),
  } as unknown as Room;
}

function tower(name: string, energy = 1000, x = 20, y = 25): StructureTower {
  return { id: name, structureType: STRUCTURE_TOWER, pos: new MockPos(x, y, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: energy }) } as unknown as StructureTower;
}

function state(phase: TowerDrainPairState["phase"] = "draining"): TowerDrainPairState {
  return { targetRoom: TARGET, retreatRoom: RETREAT, exitDirection: LEFT, attackerEntry: { x: 0, y: 25 }, healerEntry: { x: 0, y: 26 }, phase };
}

function pair(outside = false, structures: Structure[] = [tower("tower")]): { attacker: Creep; healer: Creep; target: Room } {
  const target = room(TARGET, structures);
  const safe = room(RETREAT);
  Game.rooms = { [TARGET]: target, [RETREAT]: safe };
  const parts = (type: BodyPartConstant, count: number): Array<{ type: BodyPartConstant; hits: number }> => Array.from({ length: count }, () => ({ type, hits: 100 }));
  const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: outside ? RETREAT : TARGET, x: outside ? 49 : 0, y: 25, body: [...parts(ATTACK, 25), ...parts(MOVE, 25)], memory: { configName: RED_CONFIG, _warPartnerConfigName: GREEN_CONFIG, _warTowerDrain: state(outside ? "approach" : "draining") } });
  const healer = createMockPowerBankCreep("healer", { name: "green", roomName: outside ? RETREAT : TARGET, x: outside ? 49 : 0, y: 26, body: [...parts(HEAL, 20), ...parts(MOVE, 25), ...parts(HEAL, 5)], memory: { configName: GREEN_CONFIG, _warPartnerConfigName: RED_CONFIG, _warTowerDrain: state(outside ? "approach" : "draining") } });
  attacker.room = outside ? safe : target;
  healer.room = outside ? safe : target;
  Game.creeps = { red: attacker, green: healer };
  return { attacker, healer, target };
}

describe("towerDrainDuo 公共战术门", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(global, { RoomPosition: MockPos });
    Game.map = { getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })) } as unknown as GameMap;
  });

  it("跨房49/0实际相邻，含E/W及N/S原点边界", () => {
    expect(towerDrainPairRange(new MockPos(49, 25, RETREAT) as unknown as RoomPosition, new MockPos(0, 26, TARGET) as unknown as RoomPosition)).toBe(1);
    expect(towerDrainPairRange(new MockPos(49, 49, "W0N0") as unknown as RoomPosition, new MockPos(0, 0, "E0S0") as unknown as RoomPosition)).toBe(1);
    expect(towerDrainPairRange(new MockPos(49, 25, RETREAT) as unknown as RoomPosition, new MockPos(49, 25, TARGET) as unknown as RoomPosition)).toBe(50);
  });

  it("在边界耗有能量的塔，两个真实role都不追目标、不破墙、不moveOffExit", () => {
    const { attacker, healer } = pair();
    meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").target(attacker);
    healerRole(TARGET, "", "", "", RED_CONFIG, "towerDrainDuo").target(healer);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(attacker.move).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveOffExit).not.toHaveBeenCalled();
    expect(healer.heal).toHaveBeenCalledWith(attacker);
    expect(requestCombatObservation).toHaveBeenCalledTimes(2);
  });

  it("无fresh目标视野时双方都不盲入", () => {
    const { attacker, healer } = pair(true);
    delete Game.rooms[TARGET];
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain?.blocker).toBe("target_not_visible");
  });

  it("红先到最后邻房而绿仍在前一房时，绿沿原formation追上而非永久停驻", () => {
    const { attacker, healer } = pair(true);
    delete attacker.memory._warTowerDrain;
    delete healer.memory._warTowerDrain;
    attacker.pos = new MockPos(0, 25, RETREAT) as unknown as RoomPosition;
    const previous = room("E1N57");
    Game.rooms.E1N57 = previous;
    healer.room = previous;
    healer.pos = new MockPos(49, 26, "E1N57") as unknown as RoomPosition;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(false);
    healerRole(TARGET, "E2N57", "", "", RED_CONFIG, "towerDrainDuo").source?.(healer);
    expect(moveToTargetRoom).toHaveBeenCalledWith(healer, RETREAT, undefined, expect.any(Object));
    expect(attacker.memory._warTowerDrain?.phase).toBe("approach");
  });

  it("已对齐双格且两轮塔伤留足时，两人同向入房", () => {
    const { attacker, healer } = pair(true);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(healer.move).toHaveBeenCalledWith(RIGHT);
  });

  it("高血比例仍不足承受fresh6塔两轮时拒绝入房", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`tower${index}`, 1000, 1, 25));
    const { attacker, healer } = pair(true, towers);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain?.blocker).toBe("entry_damage_or_healing");
  });

  it("六空塔仍可从敌库存补能时，不能按零伤害放行危险入口", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`empty${index}`, 0, 1, 25));
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker, healer } = pair(true, [...towers, storage]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain?.blocker).toBe("entry_damage_or_healing");
  });

  it("两轮后只剩绿尾部HEAL或少量MOVE时不入房，保住持续退房所需MOVE", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`tower${index}`, 1000, 14, 25));
    const { attacker, healer } = pair(true, towers);
    // 1980*2后只余1040；连续平地退房还须保留尾部5HEAL和5MOVE的1000余量。
    // 再加operateTower的小幅增伤，仍能存活却不足保持移动的入口必须拒绝。
    for (const threat of towers) threat.effects = [{ effect: PWR_OPERATE_TOWER, level: 1, ticksRemaining: 20 }];
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain?.blocker).toBe("entry_damage_or_healing");
  });

  it("入口选塔伤较低的成对可通行格，而非沿途直接盲穿", () => {
    const { attacker, healer } = pair(true, [tower("near-entry", 1000, 1, 25)]);
    delete attacker.memory._warTowerDrain?.attackerEntry;
    delete attacker.memory._warTowerDrain?.healerEntry;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(moveToTarget).toHaveBeenCalled();
    expect(Math.abs((attacker.memory._warTowerDrain?.attackerEntry?.y ?? 25) - 25)).toBeGreaterThanOrEqual(20);
    expect(attacker.memory._warTowerDrain?.healerEntry?.y).toBe((attacker.memory._warTowerDrain?.attackerEntry?.y ?? 0) + 1);
    expect(healer.room.name).toBe(RETREAT);
  });

  it("红血低于低阈值时直接退邻房，绿同步退，不被旧formation推回敌房", () => {
    const { attacker, healer } = pair();
    attacker.hits = 3700;
    meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").target(attacker);
    healerRole(TARGET, "", "", "", RED_CONFIG, "towerDrainDuo").target(healer);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    expect(healer.move).toHaveBeenCalledWith(LEFT);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveOffExit).not.toHaveBeenCalled();
  });

  it("新塔伤超过退出预算时，即使高于75%也退房", () => {
    const { attacker } = pair(false, Array.from({ length: 6 }, (_, index) => tower(`tower${index}`, 1000, 1, 25)));
    attacker.hits = 4900;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    expect(attacker.memory._warTowerDrain?.phase).toBe("retreating");
  });

  it("绿受伤立即退出并自疗", () => {
    const { attacker, healer } = pair();
    healer.hits = 4900;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    expect(healer.move).toHaveBeenCalledWith(LEFT);
    expect(healer.heal).toHaveBeenCalledWith(healer);
  });

  it("塔空但绿有疲劳时不推进，双人仍保持", () => {
    const { attacker, healer } = pair(false, [tower("empty", 0)]);
    healer.fatigue = 10;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain?.blocker).toBe("pair_fatigued");
  });

  it("跨边界撤退不会对另一房治疗或误判远离后重新进房", () => {
    const { attacker, healer } = pair();
    attacker.hits = 3700;
    healer.pos = new MockPos(49, 26, RETREAT) as unknown as RoomPosition;
    healer.room = Game.rooms[RETREAT];
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    expect(healer.move).not.toHaveBeenCalledWith(RIGHT);
    expect(healer.heal).not.toHaveBeenCalledWith(attacker);
    expect(healer.rangedHeal).not.toHaveBeenCalled();
  });

  it("两人退出后恢复不到满血不再进，满血及体力恢复后才再进", () => {
    const { attacker, healer } = pair(true);
    attacker.memory._warTowerDrain = state("recovering");
    attacker.hits = 4900;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).not.toHaveBeenCalledWith(RIGHT);
    expect(healer.heal).toHaveBeenCalledWith(attacker);
    attacker.hits = 5000;
    jest.clearAllMocks();
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(healer.move).toHaveBeenCalledWith(RIGHT);
  });

  it("丢失搭档或detach只退避，旧第6参数不能恢复攻击", () => {
    const { attacker, healer } = pair();
    delete Game.creeps.green;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    attacker.memory._warDetached = true;
    Game.creeps.green = healer;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("目标被我方接管后不攻击其墙", () => {
    const { attacker, target } = pair(false, []);
    target.controller!.my = true;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain?.blocker).toBe("target_owned");
  });

  it("每次fresh判断塔不能开火后才放行原破墙逻辑，补能立刻撤退", () => {
    const empty = tower("empty", TOWER_ENERGY_COST - 1);
    const { attacker, healer } = pair(false, [empty]);
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(false);
    expect(attacker.memory._warTowerDrain?.phase).toBe("breaching");
    empty.store[RESOURCE_ENERGY] = TOWER_ENERGY_COST;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    expect(runTowerDrainPair(healer, TARGET, RED_CONFIG)).toBe(true);
    expect(healer.move).toHaveBeenCalledWith(LEFT);
  });

  it("破墙移动在NPC仍可填塔时保留退出距离预算；库存耗尽后重新开放", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`tower${index}`, 0, 25, 25));
    const storage = { id: "enemy-storage", structureType: STRUCTURE_STORAGE, pos: new MockPos(25, 20, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker } = pair(false, [...towers, storage]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    const first = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, first);
    expect(first.set).toHaveBeenCalledWith(10, 25, 255);
    storage.store[RESOURCE_ENERGY] = 0;
    const second = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, second);
    expect(second.set).not.toHaveBeenCalledWith(10, 25, 255);
  });

  it("即使全部空塔也禁走沼泽，不把多轮MOVE疲劳藏入两轮退出余量", () => {
    const { attacker } = pair(false, [tower("empty", 0)]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    Game.map.getRoomTerrain = jest.fn(() => ({ get: jest.fn((x: number, y: number) => x === 1 && y === 25 ? TERRAIN_MASK_SWAMP : 0) })) as unknown as GameMap["getRoomTerrain"];
    const matrix = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, matrix);
    expect(matrix.set).toHaveBeenCalledWith(1, 25, 255);
  });

  it("已知墙绕行的实际退路长于几何range时拒绝深入，并按BFS首步退出", () => {
    const structures: Structure[] = [tower("empty", 0, 25, 25), { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage];
    const { attacker, healer } = pair(false, structures);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    const initial = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, initial);
    expect(initial.set).not.toHaveBeenCalledWith(2, 25, 255);
    for (let y = 0; y < 48; y++) structures.push({ id: `wall${y}`, structureType: STRUCTURE_WALL, pos: new MockPos(1, y, TARGET) } as unknown as StructureWall);
    const blocked = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, blocked);
    expect(blocked.set).toHaveBeenCalledWith(2, 25, 255);
    attacker.pos = new MockPos(2, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(2, 26, TARGET) as unknown as RoomPosition;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.memory._warTowerDrain?.phase).toBe("retreating");
    expect([BOTTOM, BOTTOM_RIGHT]).toContain((attacker.move as jest.Mock).mock.calls[0]?.[0]);
    expect(attacker.move).not.toHaveBeenCalledWith(LEFT);
  });

  it("真实红球目标路径不能借通用出口moveOffExit越过第一步安全门", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`empty${index}`, 0, 15, 25));
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(25, 20, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const spawn = { id: "target-spawn", structureType: STRUCTURE_SPAWN, pos: new MockPos(25, 25, TARGET), store: createMockStore() } as unknown as StructureSpawn;
    const { attacker } = pair(false, [...towers, storage, spawn]);
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").target(attacker);
    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveOffExit).not.toHaveBeenCalled();
  });

  it("绿球新模式不等待旧counterstrike准备，直接跟随已经安全移动的红球", () => {
    const { attacker, healer } = pair(false, []);
    attacker.pos = new MockPos(2, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(1, 26, TARGET) as unknown as RoomPosition;
    attacker.memory._warMoveIntentAt = Game.time;
    const hold = jest.spyOn(meleeModule, "shouldWarHealerHoldForCounterstrike").mockReturnValue(true);
    try {
      healerRole(TARGET, "", "", "", RED_CONFIG, "towerDrainDuo").target(healer);
      expect(hold).not.toHaveBeenCalled();
      expect(healer.move).toHaveBeenCalledWith(TOP_RIGHT);
    } finally { hold.mockRestore(); }
  });

  it("绿先执行导致红移动后临时相距两格时，红等待绿追上，不把全队拉回入口", () => {
    const { attacker, healer } = pair(false, []);
    attacker.memory._warTowerDrain = state("breaching");
    attacker.pos = new MockPos(1, 24, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(0, 26, TARGET) as unknown as RoomPosition;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(runTowerDrainPair(healer, TARGET, RED_CONFIG)).toBe(true);
    expect(healer.move).toHaveBeenCalledWith(TOP_RIGHT);
    expect(attacker.memory._warTowerDrain?.phase).toBe("breaching");
  });

  it("source与target两阶段都先消费耗塔门，不被mount立即换阶段旁路", () => {
    const { attacker, healer } = pair();
    expect(meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").source?.(attacker)).toBe(false);
    expect(healerRole(TARGET, "", "", "", RED_CONFIG, "towerDrainDuo").source?.(healer)).toBe(false);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });
});
