import { runSiegeFormation, findSpawnAssaultTiles } from "./siegeFormation";
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
  const room = { name: target, lookAt: () => [] } as unknown as Room;
  const terrain = jest.spyOn(Game.map, "getRoomTerrain").mockReturnValue({ get: () => 0 } as ReturnType<typeof Game.map.getRoomTerrain>);
  const unit = (job: "breacher" | "escort", i: number, x: number, y: number) => ({
    pos: new MockPos(x, y, target),
    memory: { _siegeSlot: i },
    fatigue: 0,
    getActiveBodyparts: (p: BodyPartConstant) => p === (job === "breacher" ? WORK : HEAL) ? 10 : 0,
  }) as unknown as Creep;
  const group = [unit("breacher", 0, 39, 37), unit("escort", 1, 38, 38), unit("escort", 3, 38, 37)];
  const spawn = { pos: new MockPos(36, 36, target) } as unknown as StructureSpawn;
  try {
    const result = findSpawnAssaultTiles(room, group, spawn);
    expect(result?.[0].x).toBe(38);
    for (const i of [1, 3]) expect(Math.max(Math.abs(result![i].x - result![0].x), Math.abs(result![i].y - result![0].y))).toBeLessThanOrEqual(1);
  } finally { terrain.mockRestore(); }
});
