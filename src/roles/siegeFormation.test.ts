import { runSiegeFormation } from "./siegeFormation";
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
  const group = SIEGE_SLOTS.slice(0, 4).map((job, i) => {
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
