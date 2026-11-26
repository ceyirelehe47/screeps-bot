import { shouldUseSiege, limitReinforcementBoosts, needsSiegeSuccessor } from "./siege";
import type { WarTask } from "./store";
import { getBoostPartType } from "../boostParts";
import { reinforcementBody, assembleSiegeWings, SIEGE_BODIES, SIEGE_BOOSTS, SIEGE_SLOTS } from "./siegeRoster";
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
    expect([wing[1], wing[3]]).toEqual(["escort", "escort"]);
    expect(["breacher", "ranger"]).toContain(wing[2]);
    expect(["breacher", "ranger"]).toContain(wing[0]);
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

it("剩矿只能供应一部分补兵时，保留可用装甲与能调入的治疗矿", () => {
  const armor = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
  const heal = RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE;
  const work = RESOURCE_CATALYZED_ZYNTHIUM_ACID;
  const amounts = new Map<ResourceConstant, number>([[armor, 3500], [heal, 1800], [work, 510]]);
  const unavailable = limitReinforcementBoosts(amounts, r => r === armor ? 2461 : 0, r => r === heal);
  expect(unavailable).toEqual([work]);
  expect([...amounts]).toEqual([[armor, 2460], [heal, 1800]]);
});

it("远射翼在三格外两兵合计每 tick 可打掉 1680 点，拆墙翼保留近身输出", () => {
  expect(SIEGE_SLOTS.slice(0,4)).toEqual(["ranger", "escort", "breacher", "escort"]);
  const shots = SIEGE_BODIES.ranger.filter(p => p === RANGED_ATTACK).length;
  expect(2 * shots * RANGED_ATTACK_POWER * BOOSTS.ranged_attack.XKHO2.rangedAttack).toBe(1680);
  expect(SIEGE_BODIES.breacher.filter(p => p === WORK).length).toBeGreaterThan(shots / 2);
});

it("留出孵化、强化和四房行军时间，同一远征槽最多只提前补一人", () => {
  const task: WarTask = { ...order, siegeLaunched: true, routeRooms: ["E1N2","E2N2","E3N2","E4N2","E5N2"], targetRoom: "E5N2" };
  const veteran = { room: { name: task.targetRoom }, ticksToLive: 400 } as Creep;
  const next = { room: { name: task.sourceRoom }, spawning: true } as Creep;
  expect(needsSiegeSuccessor(task, [veteran], 150, 200000)).toBe(true);
  expect(needsSiegeSuccessor(task, [veteran, next], 150, 200000)).toBe(false);
  expect(needsSiegeSuccessor(task, [veteran], 150, 140000)).toBe(false);
  expect(needsSiegeSuccessor({ ...task, oneShot: true }, [veteran], 150, 200000)).toBe(false);
});

it("无装甲矿的后续部队仍有五十节，远射和医疗部件增加且能正常孵化",()=>{
  for(const job of ["ranger","escort","breacher"] as const){
    const next=reinforcementBody(job,0,12900);
    expect(next).toHaveLength(50);expect(next).not.toContain(TOUGH);
    expect(reinforcementBody(job,3000,12900)).toBe(SIEGE_BODIES[job]);
  }
});
