import { shouldUseSiege } from "./siege";
import type { WarTask } from "./store";
import { getBoostPartType } from "../boostParts";
import { SIEGE_BODIES, SIEGE_BOOSTS, SIEGE_SLOTS } from "./siegeRoster";
import { createMockStore } from "@mock/powerBank";

const order: WarTask = { targetRoom: "E3N2", sourceRoom: "E1N2", squad: "t3Duo",
  status: "staging", reason: "manual", attempts: 1, createdAt: 1, updatedAt: 1, autoTactic: true, oneShot: false };

function target(towers: number, shield: boolean): Room {
  const spawn = { structureType: STRUCTURE_SPAWN, pos: {x: 25, y: 25} };
  return { controller: { owner: {username: "opponent"}, level: 8 }, find: (type: FindConstant) =>
    type === FIND_HOSTILE_SPAWNS ? [spawn] : Array.from({length: towers}, () => ({structureType: STRUCTURE_TOWER})),
    lookForAt: () => shield ? [{structureType: STRUCTURE_RAMPART}] : [] } as unknown as Room;
}

beforeEach(() => {
  Game.rooms[order.sourceRoom] = { storage: {store: createMockStore({energy:500000})}, energyCapacityAvailable: 12900,
    find: () => Array.from({length: 10}, () => ({structureType: STRUCTURE_LAB})) } as unknown as Room;
});

it("只为持续进攻有塔且 Spawn 有掩体的玩家房自动选择攻坚编组", () => {
  expect(shouldUseSiege(order,target(6,true))).toBe(true);
  expect(shouldUseSiege({...order,oneShot:true},target(6,true))).toBe(false);
  expect(shouldUseSiege({...order,autoTactic:undefined},target(6,true))).toBe(false);
  expect(shouldUseSiege(order,target(2,true))).toBe(false);
  expect(shouldUseSiege(order,target(6,false))).toBe(false);
  expect(shouldUseSiege(order,undefined)).toBe(false);
});

it("每个四人单元有拆墙兵与三名护卫，所有 50 个部件均有对应 T3", () => {
  for (const wing of [SIEGE_SLOTS.slice(0,4),SIEGE_SLOTS.slice(4)]) {
    expect(wing).toEqual(["breacher","escort","escort","escort"]);
    for (const job of wing) {
      const body = SIEGE_BODIES[job];
      expect(body).toHaveLength(50);
      expect(new Set(SIEGE_BOOSTS[job].map(getBoostPartType))).toEqual(new Set(body));
      expect(body.filter(part => part === MOVE)).toHaveLength(10);
    }
  }
});
