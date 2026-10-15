jest.mock("@/roles/shared", () => ({ clearMovementState: jest.fn(), moveToTarget: jest.fn(() => OK), moveToTargetRoom: jest.fn(() => OK) }));
jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ measureCreepIntent: (fn: () => unknown) => fn(), measureCreepDecision: (fn: () => unknown) => fn() }));
jest.mock("@/movement/traffic", () => ({ ...jest.requireActual("@/movement/traffic"), moveOffExit: jest.fn(() => OK) }));

import { constrainTowerDrainBreachPath, runTowerDrainPair, towerDrainPairRange, type TowerDrainPairState } from "@/roles/towerDrainPair";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import * as meleeModule from "@/roles/meleeAttacker";
import { healerRole } from "@/roles/healer";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";
import { issueMove } from "@/movement/traffic";
import { createHash } from "node:crypto";

const TARGET = "E3N57";
const RETREAT = "E2N57";
const RED_CONFIG = "E1N57:war:E3N57:g1:meleeAttacker:0";
const GREEN_CONFIG = "E1N57:war:E3N57:g1:healer:0";
const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as { moveToTarget: jest.Mock; moveToTargetRoom: jest.Mock };
const { requestCombatObservation } = jest.requireMock("@/runtime/powerBankObserver") as { requestCombatObservation: jest.Mock };
const { moveOffExit } = jest.requireMock("@/movement/traffic") as { moveOffExit: jest.Mock };

function room(name: string, structures: Structure[] = [], hostiles: Creep[] = []): Room {
  return {
    name,
    controller: { my: false, owner: { username: "npc" } },
    find: jest.fn((type: FindConstant, opts?: { filter?: (value: Structure) => boolean }) => {
      const values = type === FIND_STRUCTURES || type === FIND_HOSTILE_STRUCTURES ? structures : type === FIND_HOSTILE_CREEPS ? hostiles : [];
      return opts?.filter ? values.filter(opts.filter) : values;
    }),
  } as unknown as Room;
}

function tower(name: string, energy = 1000, x = 20, y = 25): StructureTower {
  return { id: name, structureType: STRUCTURE_TOWER, pos: new MockPos(x, y, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: energy }) } as unknown as StructureTower;
}

function carrier(x = 25, y = 25, energy = 0): Creep {
  return { body: [{ type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }], pos: new MockPos(x, y, TARGET),
    store: createMockStore({ [RESOURCE_ENERGY]: energy }) } as unknown as Creep;
}

function state(phase: TowerDrainPairState["phase"] = "draining"): TowerDrainPairState {
  return { targetRoom: TARGET, retreatRoom: RETREAT, exitDirection: LEFT, attackerEntry: { x: 0, y: 25 }, healerEntry: { x: 0, y: 26 }, phase };
}

function pair(outside = false, structures: Structure[] = [tower("tower")], hostiles: Creep[] = []): { attacker: Creep; healer: Creep; target: Room } {
  const target = room(TARGET, structures, hostiles);
  const safe = room(RETREAT);
  Game.rooms = { [TARGET]: target, [RETREAT]: safe };
  const parts = (type: BodyPartConstant, count: number): Array<{ type: BodyPartConstant; hits: number }> => Array.from({ length: count }, () => ({ type, hits: 100 }));
  const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: outside ? RETREAT : TARGET, x: outside ? 48 : 0, y: 25, body: [...parts(ATTACK, 25), ...parts(MOVE, 25)], memory: { configName: RED_CONFIG, _warPartnerConfigName: GREEN_CONFIG, _warTowerDrain: state(outside ? "approach" : "draining") } });
  const healer = createMockPowerBankCreep("healer", { name: "green", roomName: outside ? RETREAT : TARGET, x: outside ? 48 : 0, y: 26, body: [...parts(HEAL, 20), ...parts(MOVE, 25), ...parts(HEAL, 5)], memory: { configName: GREEN_CONFIG, _warPartnerConfigName: RED_CONFIG, _warTowerDrain: state(outside ? "approach" : "draining") } });
  attacker.room = outside ? safe : target;
  healer.room = outside ? safe : target;
  Game.creeps = { red: attacker, green: healer };
  return { attacker, healer, target };
}

function t3Pair(outside = false, structures: Structure[] = [tower("tower")], hostiles: Creep[] = []) {
  const result = pair(outside, structures, hostiles);
  const parts = (type: BodyPartConstant, count: number, boost: ResourceConstant): BodyPartDefinition[] =>
    Array.from({ length: count }, () => ({ type, hits: 100, boost } as BodyPartDefinition));
  result.attacker.body.splice(0, result.attacker.body.length,
    ...parts(TOUGH, 10, RESOURCE_CATALYZED_GHODIUM_ALKALIDE), ...parts(ATTACK, 30, RESOURCE_CATALYZED_UTRIUM_ACID), ...parts(MOVE, 10, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE));
  result.healer.body.splice(0, result.healer.body.length,
    ...parts(TOUGH, 10, RESOURCE_CATALYZED_GHODIUM_ALKALIDE), ...parts(HEAL, 20, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE), ...parts(MOVE, 8, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE));
  result.attacker.hits = result.attacker.hitsMax = 5000;
  result.healer.hits = result.healer.hitsMax = 3800;
  return result;
}

/** 独立按已安装Engine的clamp→edge interRoom顺序提交；连本帧idle的边缘actor也会迁房。 */
function deferredEngineFrame(actors: Creep[]): () => void {
  const pending = new Map<Creep, DirectionConstant>();
  const offsets: Record<number, [number, number]> = { 1: [0, -1], 2: [1, -1], 3: [1, 0], 4: [1, 1], 5: [0, 1], 6: [-1, 1], 7: [-1, 0], 8: [-1, -1] };
  for (const actor of actors) actor.move = jest.fn((direction: DirectionConstant) => { pending.set(actor, direction); return OK; }) as unknown as Creep["move"];
  moveToTarget.mockImplementation((actor: Creep, target: RoomPosition | { pos: RoomPosition }) => {
    const destination = "pos" in target ? target.pos : target;
    const direction = actor.pos.getDirectionTo(destination);
    if (direction) actor.move(direction);
    return OK;
  });
  return () => {
    const positions = actors.map((actor) => {
      const direction = pending.get(actor);
      const [dx, dy] = direction && actor.fatigue === 0 && actor.getActiveBodyparts(MOVE) > 0 ? offsets[direction] : [0, 0];
      let x = Math.max(0, Math.min(49, actor.pos.x + dx));
      const y = Math.max(0, Math.min(49, actor.pos.y + dy));
      let roomName = actor.room.name;
      if (x === 49 && roomName === RETREAT) { roomName = TARGET; x = 0; }
      else if (x === 0 && roomName === TARGET) { roomName = RETREAT; x = 49; }
      return { actor, x, y, roomName };
    });
    for (const { actor, x, y, roomName } of positions) {
      actor.pos = new MockPos(x, y, roomName) as unknown as RoomPosition;
      actor.room = Game.rooms[roomName];
    }
    pending.clear();
    Game.time++;
  };
}

describe("towerDrainDuo 公共战术门", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moveToTarget.mockImplementation(() => OK);
    Object.assign(global, { RoomPosition: MockPos });
    Game.map = { describeExits: jest.fn((name: string) => name === TARGET ? { [LEFT]: RETREAT } : name === RETREAT ? { [RIGHT]: TARGET } : {}), getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })) } as unknown as GameMap;
  });

  it("T3必须耗尽塔能量才推进，即使当前塔伤低于强化治疗", () => {
    const { attacker, healer } = t3Pair(false, [tower("last-shot", 10)]);
    meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "t3TowerDrainDuo").target(attacker);
    healerRole(TARGET, "", "", "", RED_CONFIG, "t3TowerDrainDuo").target(healer);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain).toMatchObject({ phase: "draining", strictT3: true, healingPower: 960 });
    expect(healer.heal).toHaveBeenCalledWith(attacker);
  });

  it.each(["approach", "recovering"] as const)("真实T3八MOVE治疗在%s阶段满血可入房", phase => {
    const { attacker, healer } = t3Pair(true);
    attacker.memory._warTowerDrain!.phase = phase;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG, true);
    runTowerDrainPair(healer, TARGET, RED_CONFIG, true);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(healer.move).toHaveBeenCalledWith(RIGHT);
  });

  it("TOUGH一节打穿时即使仍有98%总血量也停止贴身攻击并撤退治疗", () => {
    const { attacker, healer } = t3Pair(false, []);
    attacker.body[0].hits = 0; attacker.hits = 4900;
    attacker.pos = new MockPos(5, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(6, 25, TARGET) as unknown as RoomPosition;
    meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "t3TowerDrainDuo").target(attacker);
    healerRole(TARGET, "", "", "", RED_CONFIG, "t3TowerDrainDuo").target(healer);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain).toMatchObject({ phase: "retreating", blocker: "tough_broken" });
    expect(attacker.move).toHaveBeenCalled();
    expect(healer.heal).toHaveBeenCalledWith(attacker);
  });

  it("两名UH2O近战下一步可贴身时，装甲完整也提前撤退", () => {
    const defenders = [carrier(6, 25), carrier(6, 26)];
    for (const defender of defenders) {
      defender.fatigue = 0;
      defender.body = [...Array.from({ length: 25 }, () => ({ type: ATTACK, hits: 100, boost: RESOURCE_UTRIUM_ACID })), { type: MOVE, hits: 100 }];
    }
    const { attacker, healer } = t3Pair(false, [], defenders);
    attacker.pos = new MockPos(4, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(4, 26, TARGET) as unknown as RoomPosition;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG, true)).toBe(true);
    expect(attacker.memory._warTowerDrain).toMatchObject({ phase: "retreating", blocker: "hostile_pressure" });
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("出口附近新增两名强化近战时拒绝T3入场，不等跨房受击再撤退", () => {
    const defenders = [carrier(2, 25), carrier(2, 26)];
    for (const defender of defenders) {
      defender.fatigue = 0;
      defender.body = [...Array.from({ length: 25 }, () => ({ type: ATTACK, hits: 100, boost: RESOURCE_UTRIUM_ACID })), { type: MOVE, hits: 100 }];
    }
    const { attacker, healer } = t3Pair(true, [], defenders);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG, true);
    runTowerDrainPair(healer, TARGET, RED_CONFIG, true);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.memory._warTowerDrain).toMatchObject({ phase: "recovering", blocker: "entry_damage_or_healing" });
  });

  it("T3行进矩阵拒绝下一步会进入两个强化近战攻击范围的格子", () => {
    const defenders = [carrier(6, 25), carrier(6, 26)];
    for (const defender of defenders) {
      defender.fatigue = 0;
      defender.body = [...Array.from({ length: 25 }, () => ({ type: ATTACK, hits: 100, boost: RESOURCE_UTRIUM_ACID })), { type: MOVE, hits: 100 }];
    }
    const { attacker } = t3Pair(false, [], defenders);
    attacker.memory._warTowerDrain = { ...state("breaching"), strictT3: true };
    const cells = new Map<string, number>();
    const matrix = { set: (x: number, y: number, value: number) => cells.set(`${x}:${y}`, value), get: (x: number, y: number) => cells.get(`${x}:${y}`) ?? 0 } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, matrix);
    expect(matrix.get(4, 25)).toBe(0xff);
    expect(matrix.get(2, 25)).not.toBe(0xff);
  });

  it("空塔且队伍完整时解除耗塔门进入近战阶段", () => {
    const { attacker } = t3Pair(false, [tower("empty", 0)]);
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG, true)).toBe(true);
    expect(attacker.memory._warTowerDrain?.phase).toBe("breaching");
    expect(attacker.move).toHaveBeenCalled();
  });

  it("跨房49/0实际相邻，含E/W及N/S原点边界", () => {
    expect(towerDrainPairRange(new MockPos(49, 25, RETREAT) as unknown as RoomPosition, new MockPos(0, 26, TARGET) as unknown as RoomPosition)).toBe(1);
    expect(towerDrainPairRange(new MockPos(49, 49, "W0N0") as unknown as RoomPosition, new MockPos(0, 0, "E0S0") as unknown as RoomPosition)).toBe(1);
    expect(towerDrainPairRange(new MockPos(49, 25, RETREAT) as unknown as RoomPosition, new MockPos(49, 25, TARGET) as unknown as RoomPosition)).toBe(50);
  });

  it("在边界耗有能量的塔，两个真实role都不追目标、不破墙、不moveOffExit", () => {
    const { attacker, healer } = pair(false, [tower("one"), tower("two"), tower("three")]);
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

  it.each([false, true])("实际48→0迁房前在48双人排位，绿先执行=%s", (greenFirst) => {
    const { attacker, healer } = pair(true);
    healer.pos = new MockPos(47, 26, RETREAT) as unknown as RoomPosition;
    const commit = deferredEngineFrame([attacker, healer]);
    const run = (): void => {
      for (const actor of greenFirst ? [healer, attacker] : [attacker, healer]) runTowerDrainPair(actor, TARGET, actor === attacker ? GREEN_CONFIG : RED_CONFIG);
    };
    run();
    expect(attacker.move).not.toHaveBeenCalled();
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([RETREAT, RETREAT]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([48, 48]);
    run();
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([TARGET, TARGET]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([0, 0]);
  });

  it("source49不能hold：受伤的双人退回48治疗而不自动再入", () => {
    const { attacker, healer } = pair();
    const commit = deferredEngineFrame([attacker, healer]);
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([RETREAT, RETREAT]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([49, 49]);
    attacker.hits = 4900;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([RETREAT, RETREAT]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([48, 48]);
  });

  it("半队已进0时双方先退回48重排，不在两房间互换", () => {
    const { attacker, healer } = pair();
    healer.pos = new MockPos(48, 26, RETREAT) as unknown as RoomPosition;
    healer.room = Game.rooms[RETREAT];
    const commit = deferredEngineFrame([attacker, healer]);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(healer.move).not.toHaveBeenCalledWith(RIGHT);
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([RETREAT, RETREAT]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    commit();
    expect([attacker.pos.x, healer.pos.x]).toEqual([48, 48]);
    expect([attacker.room.name, healer.room.name]).toEqual([RETREAT, RETREAT]);
  });

  it.each([48, 49])("入口同时证明source attempted49和staging48可站：source%d整列被墙挡时拒绝", (blockedX) => {
    const { attacker, healer } = pair(true);
    delete attacker.memory._warTowerDrain?.attackerEntry;
    delete attacker.memory._warTowerDrain?.healerEntry;
    Game.map.getRoomTerrain = jest.fn((roomName: string) => ({ get: jest.fn((x: number) => roomName === RETREAT && x === blockedX ? TERRAIN_MASK_WALL : 0) })) as unknown as GameMap["getRoomTerrain"];
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.memory._warTowerDrain?.blocker).toBe("no_safe_exit");
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it.each([false, true])("空塔后两人一起从target0内移，绿先执行=%s不会追旧0弹回", (greenFirst) => {
    const { attacker, healer } = pair(false, [tower("empty", 0)]);
    const commit = deferredEngineFrame([attacker, healer]);
    for (const actor of greenFirst ? [healer, attacker] : [attacker, healer]) expect(runTowerDrainPair(actor, TARGET, actor === attacker ? GREEN_CONFIG : RED_CONFIG)).toBe(true);
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([TARGET, TARGET]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([1, 1]);
    expect(towerDrainPairRange(attacker.pos, healer.pos)).toBe(1);
  });

  it.each([false, true])("所有敌塔已拆除时允许从沼泽入口进入，绿先执行=%s", (greenFirst) => {
    const { attacker, healer } = pair(false, []);
    Game.map.getRoomTerrain = jest.fn(() => ({ get: (x: number) => x === 1 ? TERRAIN_MASK_SWAMP : 0 })) as GameMap["getRoomTerrain"];
    const commit = deferredEngineFrame([attacker, healer]);
    for (const actor of greenFirst ? [healer, attacker] : [attacker, healer]) runTowerDrainPair(actor, TARGET, actor === attacker ? GREEN_CONFIG : RED_CONFIG);
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([TARGET, TARGET]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([1, 1]);
    expect(attacker.memory._warTowerDrain?.blocker).toBeUndefined();
  });

  it.each([false, true])("E3N57三塔9/3/1能量、载能carrier距最近塔6格时，绿先执行=%s也同步离开边界", (greenFirst) => {
    const storage = { structureType: STRUCTURE_STORAGE, pos: new MockPos(22, 26, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1971 }) } as unknown as StructureStorage;
    const threats = [tower("a", 9, 24, 28), tower("b", 3, 14, 6), tower("c", 1, 13, 8), storage];
    const { attacker, healer } = pair(false, threats, [carrier(18, 27, 40)]);
    attacker.pos = new MockPos(0, 28, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(0, 29, TARGET) as unknown as RoomPosition;
    attacker.memory._warTowerDrain = { ...state(), attackerEntry: { x: 0, y: 28 }, healerEntry: { x: 0, y: 29 } };
    const commit = deferredEngineFrame([attacker, healer]);
    for (const actor of greenFirst ? [healer, attacker] : [attacker, healer]) {
      if (actor === attacker) meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").target(actor);
      else healerRole(TARGET, "", "", "", RED_CONFIG, "towerDrainDuo").target(actor);
    }
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([TARGET, TARGET]);
    expect([attacker.pos.x, healer.pos.x]).toEqual([1, 1]);
    expect(attacker.memory._warTowerDrain?.healingPower).toBe(300);
    threats.slice(0, 3).forEach((tower) => (tower as StructureTower).store[RESOURCE_ENERGY] = 1000);
    for (const actor of [attacker, healer]) runTowerDrainPair(actor, TARGET, actor === attacker ? GREEN_CONFIG : RED_CONFIG);
    expect(attacker.memory._warTowerDrain?.phase).toBe("retreating");
    commit();
    expect([attacker.room.name, healer.room.name]).toEqual([RETREAT, RETREAT]);
  });

  it("一座有能量塔落点伤害低于300治疗时推进；等于治疗则不推进", () => {
    const { attacker, healer } = pair(false, [tower("one", 1000, 25, 25)]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(healer.move).toHaveBeenCalledWith(RIGHT);
    const equal = pair(false, [tower("one", 1000, 25, 25), tower("two", 1000, 25, 25)]);
    runTowerDrainPair(equal.attacker, TARGET, GREEN_CONFIG);
    expect(equal.attacker.move).not.toHaveBeenCalled();
  });

  it("治疗按当前活HEAL和强化读取，同tick部件失效会关闭原先可推进的格", () => {
    const { attacker, healer } = pair(false, [tower("one", 1000, 25, 25), tower("two", 1000, 25, 25)]);
    for (const part of healer.body) if (part.type === HEAL) part.boost = "LHO2";
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    for (const part of healer.body) if (part.type === HEAL) part.hits = 0;
    attacker.move = jest.fn(() => OK);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.memory._warTowerDrain?.phase).toBe("retreating");
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
  });

  it("库存和远处搬运者不阻止空塔房深入，近旁实际送能和塔补能仍重新收紧", () => {
    const stock = { structureType: STRUCTURE_STORAGE, pos: new MockPos(22, 26, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1971 }) } as unknown as StructureStorage;
    const towers = [tower("a", 9, 24, 28), tower("b", 3, 14, 6), tower("c", 1, 13, 8)];
    const { attacker } = pair(false, [...towers, stock], [carrier(18, 27, 50)]);
    attacker.memory._warTowerDrain = state("breaching");
    const first = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, first);
    expect(first.set).not.toHaveBeenCalledWith(20, 25, 255);
    towers.forEach((tower) => tower.store[RESOURCE_ENERGY] = 1000);
    const second = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, second);
    expect(second.set).toHaveBeenCalledWith(20, 25, 255);
  });

  it("坐标相邻却无实际地图出口时清除旧入口，继续路线而非永久等待不存在的双格出口", () => {
    const { attacker, healer } = pair(true);
    Game.map.describeExits = jest.fn(() => ({}));
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(false);
    expect(runTowerDrainPair(healer, TARGET, RED_CONFIG)).toBe(false);
    expect(attacker.memory._warTowerDrain?.retreatRoom).toBeUndefined();
    expect(attacker.memory._warTowerDrain?.blocker).toBeUndefined();
    expect(attacker.memory._warTowerDrain?.phase).toBe("approach");
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

  it("六空塔旁有实际带能搬运者时，不能按零伤害放行危险入口", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`empty${index}`, 0, 1, 25));
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker, healer } = pair(true, [...towers, storage], [carrier(1, 26, 50)]);
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
    for (const threat of towers) threat.effects = [{ effect: PWR_OPERATE_TOWER, power: PWR_OPERATE_TOWER, level: 1, ticksRemaining: 20 }];
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

  it("绿的HEAL全部失效时立即退出并自疗", () => {
    const { attacker, healer } = pair();
    healer.hits = 4900;
    for (const part of healer.body) if (part.type === HEAL) part.hits = 0;
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

  it("近身撤退一员疲劳时同时等待并治疗，不预支未来已经分离的治疗", () => {
    const { attacker, healer } = pair(false, [tower("one", 1000, 25, 25)]);
    attacker.pos = new MockPos(3, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(3, 26, TARGET) as unknown as RoomPosition;
    attacker.hits = 3700;
    healer.fatigue = 4;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).not.toHaveBeenCalled();
    expect(healer.heal).toHaveBeenCalledWith(attacker);
    healer.fatigue = 0;
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    runTowerDrainPair(healer, TARGET, RED_CONFIG);
    expect(attacker.move).toHaveBeenCalled();
    expect(healer.move).toHaveBeenCalled();
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
    const empty = tower("empty", TOWER_ENERGY_COST - 1, 3, 25);
    const { attacker, healer } = pair(false, [empty]);
    attacker.pos = new MockPos(1, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(1, 26, TARGET) as unknown as RoomPosition;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(false);
    expect(attacker.memory._warTowerDrain?.phase).toBe("breaching");
    empty.store[RESOURCE_ENERGY] = TOWER_ENERGY_COST;
    expect(runTowerDrainPair(attacker, TARGET, GREEN_CONFIG)).toBe(true);
    expect(attacker.move).toHaveBeenCalledWith(LEFT);
    expect(runTowerDrainPair(healer, TARGET, RED_CONFIG)).toBe(true);
    expect(healer.move).toHaveBeenCalledWith(LEFT);
  });

  it("破墙移动在近旁搬运者可填塔时保留退出距离预算；实际供能消失后重新开放", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`tower${index}`, 0, 25, 25));
    const storage = { id: "enemy-storage", structureType: STRUCTURE_STORAGE, pos: new MockPos(25, 20, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker } = pair(false, [...towers, storage], [carrier(25, 25, 50)]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    const first = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, first);
    expect(first.set).toHaveBeenCalledWith(10, 25, 255);
    for (const actor of Game.rooms[TARGET].find(FIND_HOSTILE_CREEPS)) actor.store[RESOURCE_ENERGY] = 0;
    storage.store[RESOURCE_ENERGY] = 0;
    towers.forEach((tower) => tower.store[RESOURCE_ENERGY] = 0);
    const second = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, second);
    expect(second.set).not.toHaveBeenCalledWith(10, 25, 255);
  });

  it("整房破墙矩阵的身体查询保持常量上限，同tick疲劳变化仍重新收紧", () => {
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker, healer } = pair(false, [tower("empty", 0, 25, 25), storage], [carrier(25, 25, 50)]);
    attacker.memory._warTowerDrain = state("breaching");
    const redQueries = jest.spyOn(attacker, "getActiveBodyparts");
    const greenQueries = jest.spyOn(healer, "getActiveBodyparts");
    const evaluate = () => {
      const cells = new Uint8Array(2500);
      const matrix = { set: (x: number, y: number, value: number) => { cells[x * 50 + y] = value; } } as unknown as CostMatrix;
      const started = Date.now();
      constrainTowerDrainBreachPath(attacker, TARGET, matrix);
      console.log(JSON.stringify({ kind: "towerDrainMatrixBudget", fatigue: healer.fatigue,
        redQueries: redQueries.mock.calls.length, greenQueries: greenQueries.mock.calls.length,
        matrixSha256: createHash("sha256").update(cells).digest("hex"), elapsedMs: Date.now() - started }));
      return cells;
    };
    const healthy = evaluate();
    expect(healthy[1 * 50 + 25]).toBe(0);
    expect(healthy[20 * 50 + 25]).toBe(255);
    expect(redQueries.mock.calls.length).toBeLessThanOrEqual(8);
    expect(greenQueries.mock.calls.length).toBeLessThanOrEqual(8);
    redQueries.mockClear();
    greenQueries.mockClear();
    healer.fatigue = 1500;
    for (const part of healer.body) if (part.type === HEAL) part.hits = 0;
    const fatigued = evaluate();
    expect(fatigued[1 * 50 + 25]).toBe(255);
    expect(redQueries.mock.calls.length).toBeLessThanOrEqual(8);
    expect(greenQueries.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("按实际治疗与落点伤害开放浅格，塔近处伤害超过治疗仍拒绝", () => {
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker } = pair(false, [tower("empty", 0, 25, 25), storage], [carrier(25, 25, 50)]);
    attacker.memory._warTowerDrain = state("breaching");
    const matrix = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, matrix);
    expect(matrix.set).not.toHaveBeenCalledWith(1, 25, 255);
    expect(matrix.set).toHaveBeenCalledWith(20, 25, 255);
  });

  it("死亡主部件仍占平地重量，红25主已毁仅20MOVE与受损绿的近路也不能假称一tick一格", () => {
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker, healer } = pair(false, [tower("empty", 0, 25, 25), storage], [carrier(25, 25, 50)]);
    for (let index = 0; index < 30; index++) attacker.body[index].hits = 0;
    for (let index = 0; index < 30; index++) healer.body[index].hits = 0;
    attacker.hits = healer.hits = 2000;
    expect(attacker.getActiveBodyparts(MOVE)).toBe(20);
    expect(healer.getActiveBodyparts(MOVE)).toBe(15);
    attacker.memory._warTowerDrain = state("breaching");
    const matrix = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, matrix);
    expect(matrix.set).toHaveBeenCalledWith(1, 25, 255);
  });

  it("同一浅格重新读取当前fatigue，不能只复用健康身体的退出预算", () => {
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker, healer } = pair(false, [tower("empty", 0, 25, 25), storage], [carrier(25, 25, 50)]);
    attacker.memory._warTowerDrain = state("breaching");
    const first = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, first);
    expect(first.set).not.toHaveBeenCalledWith(1, 25, 255);
    healer.fatigue = 1500;
    for (const part of healer.body) if (part.type === HEAL) part.hits = 0;
    const fatigued = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, fatigued);
    expect(fatigued.set).toHaveBeenCalledWith(1, 25, 255);
  });

  it("铺路沼泽属于现成通道，保留道路可走并继续封住裸沼泽", () => {
    const road = { structureType: STRUCTURE_ROAD, pos: new MockPos(2, 25, TARGET) } as unknown as StructureRoad;
    const { attacker } = pair(false, [tower("live", 1000), road]);
    attacker.memory._warTowerDrain = state("breaching");
    Game.map.getRoomTerrain = jest.fn(() => ({ get: (x: number) => x === 2 || x === 3 ? TERRAIN_MASK_SWAMP : 0 })) as GameMap["getRoomTerrain"];
    const matrix = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, matrix);
    expect(matrix.set).not.toHaveBeenCalledWith(2, 25, 255);
    expect(matrix.set).toHaveBeenCalledWith(3, 25, 255);
  });

  it("目标房外集结使用普通沼泽代价，唯一通路含沼泽时仍能走到入口", () => {
    const { attacker, healer } = pair(true, [tower("empty", 0)]);
    attacker.pos = new MockPos(44, 25, RETREAT) as unknown as RoomPosition;
    healer.pos = new MockPos(43, 25, RETREAT) as unknown as RoomPosition;
    Game.map.getRoomTerrain = jest.fn((name) => ({ get: (x: number) => name === RETREAT && x === 45 ? TERRAIN_MASK_SWAMP : 0 })) as GameMap["getRoomTerrain"];
    moveToTarget.mockImplementation((actor: Creep, _target: RoomPosition, _range: number, options: { costCallback?: (name: string, matrix: CostMatrix) => CostMatrix }) => {
      const cells = new Uint8Array(2500);
      const matrix = { set: (x: number, y: number, value: number) => { cells[x * 50 + y] = value; }, get: (x: number, y: number) => cells[x * 50 + y] } as CostMatrix;
      options.costCallback?.(actor.room.name, matrix);
      if (matrix.get(45, 25) === 255) return ERR_NO_PATH;
      actor.move(RIGHT); return OK;
    });
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, expect.objectContaining({ roomName: RETREAT }), 0,
      expect.objectContaining({ swampCost: 8, ignoreCreeps: false }));
  });

  it("空塔仍有载能补给时禁走无道路沼泽，不隐藏多轮MOVE疲劳", () => {
    const storage = { structureType: STRUCTURE_STORAGE, pos: new MockPos(20, 20, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const { attacker } = pair(false, [tower("empty", 0), storage], [carrier(20, 24, 50)]);
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    Game.map.getRoomTerrain = jest.fn(() => ({ get: jest.fn((x: number, y: number) => x === 1 && y === 25 ? TERRAIN_MASK_SWAMP : 0) })) as unknown as GameMap["getRoomTerrain"];
    const matrix = { set: jest.fn() } as unknown as CostMatrix;
    constrainTowerDrainBreachPath(attacker, TARGET, matrix);
    expect(matrix.set).toHaveBeenCalledWith(1, 25, 255);
  });

  it("已知墙绕行的实际退路长于几何range时拒绝深入，并按BFS首步退出", () => {
    const structures: Structure[] = [tower("empty", 0, 25, 25), tower("empty2", 0, 25, 25), { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(30, 30, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage];
    const { attacker, healer } = pair(false, structures, [carrier(25, 25, 50)]);
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
    (attacker.move as jest.Mock).mockClear();
    runTowerDrainPair(attacker, TARGET, GREEN_CONFIG);
    expect(attacker.memory._warTowerDrain?.phase).toBe("retreating");
    expect(attacker.move).toHaveBeenCalledTimes(1);
    expect([BOTTOM, BOTTOM_RIGHT]).toContain((attacker.move as jest.Mock).mock.calls[0]?.[0]);
    expect(attacker.move).not.toHaveBeenCalledWith(LEFT);
  });

  it("真实红球目标路径不能借通用出口moveOffExit越过第一步安全门", () => {
    const towers = Array.from({ length: 6 }, (_, index) => tower(`empty${index}`, 0, 15, 25));
    const storage = { id: "stock", structureType: STRUCTURE_STORAGE, pos: new MockPos(25, 20, TARGET), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureStorage;
    const spawn = { id: "target-spawn", structureType: STRUCTURE_SPAWN, pos: new MockPos(25, 25, TARGET), store: createMockStore() } as unknown as StructureSpawn;
    const { attacker } = pair(false, [...towers, storage, spawn], [carrier(15, 26, 50)]);
    attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
    meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").target(attacker);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(attacker.move).not.toHaveBeenCalledWith(RIGHT);
    expect(moveToTarget).not.toHaveBeenCalled();
    expect(moveOffExit).not.toHaveBeenCalled();
  });

  it("绿球新模式不等待旧counterstrike准备，直接跟随已经安全移动的红球", () => {
    const { attacker, healer, target } = pair(false, []);
    // 原生 Controller 必有位置；跟随安全检查按原生 lookAt 读取真实格子内容。
    Object.assign(target.controller!, { structureType: STRUCTURE_CONTROLLER, pos: new MockPos(40, 40, TARGET) });
    target.lookAt = jest.fn((x: number, y: number) => {
      const terrain = Game.map.getRoomTerrain(TARGET).get(x, y);
      const at = (object: { pos: RoomPosition }): boolean => object.pos.x === x && object.pos.y === y;
      return [
        { type: LOOK_TERRAIN, terrain: terrain === TERRAIN_MASK_WALL ? "wall" : terrain === TERRAIN_MASK_SWAMP ? "swamp" : "plain" },
        ...[target.controller!, ...target.find(FIND_STRUCTURES)].filter(at).map(structure => ({ type: LOOK_STRUCTURES, structure })),
        ...[...Object.values(Game.creeps).filter(creep => creep.room.name === TARGET), ...target.find(FIND_HOSTILE_CREEPS)]
          .filter(at).map(creep => ({ type: LOOK_CREEPS, creep })),
      ];
    }) as unknown as Room["lookAt"];
    attacker.pos = new MockPos(2, 25, TARGET) as unknown as RoomPosition;
    healer.pos = new MockPos(1, 26, TARGET) as unknown as RoomPosition;
    attacker.memory._warMoveIntentAt = Game.time;
    issueMove(attacker, RIGHT);
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
    const { attacker, healer } = pair(false, [tower("one"), tower("two"), tower("three")]);
    expect(meleeAttackerRole(TARGET, "", "", "", GREEN_CONFIG, "towerDrainDuo").source?.(attacker)).toBe(false);
    expect(healerRole(TARGET, "", "", "", RED_CONFIG, "towerDrainDuo").source?.(healer)).toBe(false);
    expect(attacker.attack).not.toHaveBeenCalled();
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });
});
