import { shouldUseSiege } from "./siege";
import type { WarTask } from "./store";
import { getBoostPartType } from "../boostParts";
import { assembleSiegeWings, SIEGE_BODIES, SIEGE_BOOSTS, SIEGE_SLOTS } from "./siegeRoster";
import { createMockStore } from "@mock/powerBank";

const order: WarTask = {
  targetRoom: "E3N2",
  sourceRoom: "E1N2",
  squad: "t3Duo",
  status: "staging",
  reason: "manual",
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  autoTactic: true,
  oneShot: false,
};

function target(towers: number, shield: boolean): Room {
  const spawn = { structureType: STRUCTURE_SPAWN, pos: { x: 25, y: 25 } };
  return {
    controller: { owner: { username: "opponent" }, level: 8 },
    find: (type: FindConstant) =>
      type === FIND_HOSTILE_SPAWNS
        ? [spawn]
        : Array.from({ length: towers }, () => ({ structureType: STRUCTURE_TOWER })),
    lookForAt: () => (shield ? [{ structureType: STRUCTURE_RAMPART }] : []),
  } as unknown as Room;
}

beforeEach(() => {
  Game.rooms[order.sourceRoom] = {
    storage: { store: createMockStore({ energy: 500000 }) },
    energyCapacityAvailable: 12900,
    find: () => Array.from({ length: 10 }, () => ({ structureType: STRUCTURE_LAB })),
  } as unknown as Room;
});

it("只为持续进攻有塔且 Spawn 有掩体的玩家房自动选择攻坚编组", () => {
  expect(shouldUseSiege(order, target(6, true))).toBe(true);
  expect(shouldUseSiege({ ...order, oneShot: true }, target(6, true))).toBe(false);
  expect(shouldUseSiege({ ...order, autoTactic: undefined }, target(6, true))).toBe(false);
  expect(shouldUseSiege(order, target(2, true))).toBe(false);
  expect(shouldUseSiege(order, target(6, false))).toBe(false);
  expect(shouldUseSiege(order, undefined)).toBe(false);
});

it("每个四人单元有两名拆墙兵与两名护卫，所有 50 个部件均有对应 T3", () => {
  for (const wing of [SIEGE_SLOTS.slice(0, 4), SIEGE_SLOTS.slice(4, 8), SIEGE_SLOTS.slice(8)]) {
    expect(wing).toEqual(["breacher", "escort", "breacher", "escort"]);
    for (const job of wing) {
      const body = SIEGE_BODIES[job];
      expect(body).toHaveLength(50);
      expect(new Set(SIEGE_BOOSTS[job].map(getBoostPartType))).toEqual(new Set(body));
      expect(body.filter((part) => part === MOVE)).toHaveLength(10);
    }
  }
});

it("首次齐射尚未获得治疗时，两轮六塔近距伤害仍能由前排装甲吸收", () => {
  const volley = 6 * TOWER_POWER_ATTACK;
  const armor = SIEGE_BODIES.breacher.filter((p) => p === TOUGH).length * 100;
  expect(armor).toBeGreaterThanOrEqual(2 * volley * BOOSTS.tough.XGHO2.damage);
  const medicArmor = SIEGE_BODIES.escort.filter((p) => p === TOUGH).length * 100;
  const remainingArmor = medicArmor - volley * BOOSTS.tough.XGHO2.damage;
  const secondHit =
    volley - Math.min(volley, remainingArmor / BOOSTS.tough.XGHO2.damage) * (1 - BOOSTS.tough.XGHO2.damage);
  const healing = 2 * SIEGE_BODIES.escort.filter((p) => p === HEAL).length * HEAL_POWER * BOOSTS.heal.XLHO2.heal;
  expect(healing).toBeGreaterThanOrEqual(secondHit);
});

it("出生序号不齐时，按中场实到兵力组队；阵亡的拆墙兵由到场同类增援替补", () => {
  const staging = "E2N2";
  const task: WarTask = { ...order, squad: "siege" };
  const soldier = (job: "breacher" | "escort", index: number) =>
    ({
      name: job + index,
      room: { name: staging },
      memory: { ready: true, roleArgs: ["", "", "", "", "", String(index)] },
      getActiveBodyparts: (part: BodyPartConstant) => (job === "breacher" && part === WORK ? 17 : 0),
    }) as unknown as Creep;
  const soldiers = [soldier("breacher", 4), soldier("escort", 1), soldier("breacher", 2), soldier("escort", 7)];
  assembleSiegeWings(task, soldiers, staging);
  expect(task.siegeWings?.[0]).toBe(true);
  expect(soldiers.map((c) => c.memory._siegeSlot)).toEqual([0, 1, 2, 3]);
  const replacement = soldier("breacher", 6);
  assembleSiegeWings(task, [...soldiers.slice(1), replacement], staging);
  expect(replacement.memory._siegeSlot).toBe(0);
});
