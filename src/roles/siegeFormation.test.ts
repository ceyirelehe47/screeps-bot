import { setDefaultMapMocks, setupPathFinderGlobal, setupRoomPositionGlobal } from "@mock/movement";
import { runSiegeFormation, advanceInBreach, selectSiegeCore, siegeWeaponRange, planBreachSteps } from "./siegeFormation";
import { SIEGE_BODIES, SIEGE_SLOTS } from "@/runtime/war/siegeRoster";
import type { WarTask } from "@/runtime/war/store";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";

it("四次角色调度只提交一轮攻击；两名拆墙兵先打 Spawn 的掩体，护卫治疗受击者", () => {
  const target = "E3N2";
  const task: WarTask = {
    targetRoom: target,
    sourceRoom: "E1N2",
    squad: "siege",
    siegeAnchors: { 0: { x: 20, y: 20 } },
    status: "clearing",
    reason: "manual",
    attempts: 1,
    createdAt: 1,
    updatedAt: 1,
    siegeLaunched: true,
  };
  const group = SIEGE_SLOTS.slice(4, 8).map((job, i) => {
    const creep = createMockPowerBankCreep("siegeUnit", {
      name: "unit" + i,
      roomName: target,
      x: i % 2 === 0 ? 21 : 20,
      y: i < 2 ? 20 : 21,
      body: SIEGE_BODIES[job].map((type) => ({ type, hits: 100 })),
      memory: { role: "siegeUnit", roleArgs: [target, "", "task", "", job, String(i)] },
    });
    return Object.assign(creep, {
      dismantle: jest.fn(),
      rangedAttack: jest.fn(),
      heal: jest.fn(),
      rangedHeal: jest.fn(),
      move: jest.fn(),
    });
  });
  const spawn = { id: "spawn", structureType: STRUCTURE_SPAWN, pos: new MockPos(22, 20, target) };
  const rampart = { id: "shield", my: false, structureType: STRUCTURE_RAMPART, pos: spawn.pos, hits: 1000000 };
  const room = {
    name: target,
    find: (kind: FindConstant) => (kind === FIND_MY_CREEPS ? group : kind === FIND_HOSTILE_SPAWNS ? [spawn] : []),
    lookForAt: () => [spawn, rampart],
    getEventLog: () => [{ event: EVENT_ATTACK, data: { targetId: group[0].id, damage: 3200 } }],
  } as unknown as Room;
  group.forEach((c) => Object.assign(c, { room }));
  for (const c of group) runSiegeFormation(c, task);
  for (const i of [0, 2]) {
    expect(group[i].dismantle).toHaveBeenCalledTimes(1);
    expect(group[i].dismantle).toHaveBeenCalledWith(rampart);
  }
  for (const i of [1, 3]) expect(group[i].heal).toHaveBeenCalledWith(group[0]);
  expect(group.every((c) => c.move.mock.calls.length === 0)).toBe(true);
});

it("前排阵亡时，余下拆墙兵和两名治疗能朝空出的近身位置一起前进一步", () => {
  const target = "E3N2";
  const room = { name: target, lookForAt: () => [], find: () => [] } as unknown as Room;
  const unit = (job: "breacher" | "escort", i: number, x: number, y: number) => ({
    pos: new MockPos(x, y, target),
    memory: { _siegeSlot: i }, fatigue: 0, move: jest.fn(),
    getActiveBodyparts: (p: BodyPartConstant) => p === (job === "breacher" ? WORK : HEAL) ? 10 : 0,
  }) as unknown as Creep;
  const group = [unit("breacher", 0, 39, 37), unit("escort", 1, 38, 38), unit("escort", 3, 38, 37)];
  const spawn = { pos: new MockPos(36, 36, target) } as unknown as StructureSpawn;
  const originals = { map: Game.map, path: Reflect.get(global, "PathFinder"), pos: Reflect.get(global, "RoomPosition"), room: Reflect.get(global, "Room") };
  try {
    setDefaultMapMocks();
    setupPathFinderGlobal();
    setupRoomPositionGlobal();
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [new RoomPosition(38, 37, target)], incomplete: false, cost: 1, ops: 3,
    });
    expect(advanceInBreach(room, group, spawn)).toBe(spawn);
    expect(group[0].move).toHaveBeenCalledWith(LEFT);
    expect(group[2].move).toHaveBeenCalledTimes(1);
  } finally {
    Object.assign(global, {PathFinder: originals.path, RoomPosition: originals.pos, Room: originals.room});
    Game.map = originals.map;
  }
});

it("三个紧邻的 Spawn 先选能覆盖两侧的中央目标",()=>{
  const spawn=(x:number,y:number)=>({pos:new MockPos(x,y,"E3N2")}) as unknown as StructureSpawn;
  const left=spawn(20,20),central=spawn(22,23),right=spawn(25,24);
  expect(selectSiegeCore([left,central,right],{x:5,y:20})).toBe(central);
  expect(selectSiegeCore([left,right],{x:5,y:20})).toBe(left);
});


it("远射手失去唯一的 WORK 后依然保持三格射程，医疗护卫仍负责跟随", () => {
  const creep = (job: string) => ({
    memory: {roleArgs: ["", "", "", "", job]},
    getActiveBodyparts: (p: BodyPartConstant) => p === RANGED_ATTACK ? 15 : 0,
  }) as Creep;
  expect(siegeWeaponRange(creep("ranger"))).toBe(3);
  expect(siegeWeaponRange(creep("escort"))).toBe(1);
});

it("窄道中两名医疗兵同时保持近身互保，攻击手等待下一步也不会拆散医疗队", () => {
  const at = (x: number,y: number) => new MockPos(x,y,"E3N2") as unknown as RoomPosition;
  const unit = (x: number,y: number) => ({pos:at(x,y), hits:5000, hitsMax:5000, fatigue:0}) as Creep;
  const soldiers = [unit(25,40),unit(25,41)], medics = [unit(24,40),unit(24,41)];
  const proposed = new Map([[soldiers[0],at(26,39)], [soldiers[1],at(26,42)]]);
  const steps = planBreachSteps(soldiers,medics,proposed,() => true)!;
  const pos = (c:Creep) => at(steps.get(c)!.x,steps.get(c)!.y);
  expect(pos(medics[0]).isNearTo(pos(medics[1]))).toBe(true);
  for (const c of soldiers) expect(medics.some(h => pos(h).isNearTo(pos(c)))).toBe(true);
  expect(new Set([...steps.values()].map(p => p.x*50+p.y)).size).toBe(4);
});
