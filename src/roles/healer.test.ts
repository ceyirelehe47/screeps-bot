import { setDefaultMapMocks } from "@mock/movement";
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

import { getMoveIntentReceipt, issueMove } from "@/movement/traffic";
import { healerRole } from "@/roles/healer";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";

const { moveToTarget } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};
const TARGET_ROOM = "E3N57";
const ATTACKER_CONFIG = "E1N57:war:E3N57:meleeAttacker:0";
const HEALER_CONFIG = "E1N57:war:E3N57:healer:0";


function hostileStructure(type: StructureConstant, id: string, x: number, y: number, hits = 3000): Structure {
  return {
    id: id as Id<Structure>,
    structureType: type,
    hits,
    hitsMax: hits,
    pos: new MockPos(x, y, TARGET_ROOM) as unknown as RoomPosition,
  } as Structure;
}

function formationScenario(order: "leader-first" | "healer-first") {
  Game.time++;
  const spawn = hostileStructure(STRUCTURE_SPAWN, "formation-destination", 35, 20, 5000);
  const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 20, y: 20,
    memory: { configName: ATTACKER_CONFIG, _warPartnerConfigName: HEALER_CONFIG } });
  const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 19, y: 20,
    memory: { configName: HEALER_CONFIG, _warPartnerConfigName: ATTACKER_CONFIG } });
  const room = attacker.room;
  const blocked = new Set<string>();
  room.find = jest.fn((kind: FindConstant) => kind === FIND_HOSTILE_STRUCTURES || kind === FIND_STRUCTURES ? [spawn] : []) as Room["find"];
  room.lookAt = jest.fn((x: number, y: number) => [
    { type: LOOK_TERRAIN, terrain: blocked.has(`${x}:${y}`) ? "wall" : "plain" },
    ...Object.values(Game.creeps).filter(c => c.pos.x === x && c.pos.y === y).map(creep => ({ type: LOOK_CREEPS, creep })),
  ]) as unknown as Room["lookAt"];
  healer.room = room;
  attacker.attack = jest.fn(() => ERR_NOT_IN_RANGE);
  Game.creeps = order === "leader-first" ? { red: attacker, green: healer } : { green: healer, red: attacker };
  const pending = new Map<Creep, DirectionConstant>();
  const offsets: Record<DirectionConstant, readonly [number, number]> = {
    [TOP]: [0, -1], [TOP_RIGHT]: [1, -1], [RIGHT]: [1, 0], [BOTTOM_RIGHT]: [1, 1],
    [BOTTOM]: [0, 1], [BOTTOM_LEFT]: [-1, 1], [LEFT]: [-1, 0], [TOP_LEFT]: [-1, -1],
  };
  const register = (creep: Creep): void => {
    creep.move = jest.fn((direction: DirectionConstant) => {
      if (creep.fatigue > 0) return ERR_TIRED;
      pending.set(creep, direction);
      return OK;
    }) as unknown as Creep["move"];
    creep.cancelOrder = jest.fn((method: string) => method === "move" && pending.delete(creep) ? OK : ERR_NOT_FOUND) as unknown as Creep["cancelOrder"];
  };
  for (const creep of [attacker, healer]) register(creep);
  moveToTarget.mockImplementation((creep: Creep, target: RoomPosition | { pos: RoomPosition }) =>
    issueMove(creep, creep.pos.getDirectionTo("pos" in target ? target.pos : target)),
  );
  const redRole = meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG);
  const greenRole = healerRole(TARGET_ROOM, "", "", "", ATTACKER_CONFIG);
  return {
    attacker, healer, blocked, register,
    run: () => {
      if (order === "leader-first") { redRole.target(attacker); greenRole.target(healer); }
      else { greenRole.target(healer); redRole.target(attacker); }
    },
    commit: () => {
      // 帧初位置不变；墙/未离开的占位者及争用同格会逐层阻止跟随链移动。
      const destinations = new Map(Object.values(Game.creeps).map(creep => {
        const direction = pending.get(creep);
        const [dx, dy] = direction && creep.fatigue === 0 ? offsets[direction] : [0, 0];
        return [creep, { x: creep.pos.x + dx, y: creep.pos.y + dy }] as const;
      }));
      const moving = new Set([...destinations].filter(([creep, to]) => !blocked.has(`${to.x}:${to.y}`)
        && (to.x !== creep.pos.x || to.y !== creep.pos.y)).map(([creep]) => creep));
      let changed = true;
      while (changed) {
        changed = false;
        for (const creep of moving) {
          const to = destinations.get(creep)!;
          if ([...destinations].some(([other, otherTo]) => other !== creep
            && (other.pos.x === to.x && other.pos.y === to.y && !moving.has(other)
              || moving.has(other) && otherTo.x === to.x && otherTo.y === to.y))) {
            moving.delete(creep); changed = true;
          }
        }
      }
      for (const creep of moving) Object.assign(creep, { pos: new MockPos(destinations.get(creep)!.x, destinations.get(creep)!.y, TARGET_ROOM) });
      pending.clear();
      Game.time++;
    },
  };
}


describe("healerRole war duo staging", () => {
  beforeEach(() => {
    setDefaultMapMocks();
    jest.clearAllMocks();
    moveToTarget.mockReset().mockReturnValue(OK);
    clearCreepMovementStateForTest();
    Game.creeps = {};
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
  });

  it("does not restore partner identity from fallback args after owner detach", () => {
    const healer = createMockPowerBankCreep("healer", {
      name: "detached-healer",
      roomName: "E2N57",
      memory: {
        role: "healer",
        _warDetached: true,
      },
    });
    Game.creeps = { [healer.name]: healer };

    healerRole(TARGET_ROOM, "", "", "", ATTACKER_CONFIG).source?.(healer);

    expect(healer.memory._warPartnerConfigName).toBeUndefined();
  });

  it.each(["leader-first", "healer-first"] as const)("%s 实际结算移动后连续三 tick 同步前进且保持贴身", (order) => {
    const { attacker, healer, run, commit } = formationScenario(order);
    for (let tick = 1; tick <= 3; tick++) {
      run(); commit();
      expect({ x: attacker.pos.x, y: attacker.pos.y }).toEqual({ x: 20 + tick, y: 20 });
      expect({ x: healer.pos.x, y: healer.pos.y }).toEqual({ x: 19 + tick, y: 20 });
      expect(healer.pos.isNearTo(attacker.pos)).toBe(true);
    }
  });

  it.each((["leader-first", "healer-first"] as const).flatMap(order =>
    ["fatigued", "blocked", "move_failed"].map(kind => ({ order, kind })),
  ))("$order 在 $kind 时撤销本次红移动，解除后继续实际同步推进", ({ order, kind }) => {
    const { attacker, healer, blocked, run, commit } = formationScenario(order);
    const nativeGreenMove = healer.move;
    if (kind === "fatigued") healer.fatigue = 2;
    if (kind === "blocked") blocked.add("21:20");
    if (kind === "move_failed") healer.move = jest.fn(() => ERR_BUSY) as unknown as Creep["move"];
    run();
    expect(getMoveIntentReceipt(attacker)).toBeUndefined();
    expect(attacker.memory._warMoveIntentAt).toBeUndefined();
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    commit();
    expect([attacker.pos.x, healer.pos.x]).toEqual([20, 19]);
    expect(healer.pos.isNearTo(attacker.pos)).toBe(true);
    healer.fatigue = 0; blocked.clear(); healer.move = nativeGreenMove;
    for (let tick = 1; tick <= 3; tick++) {
      run(); commit();
      expect([attacker.pos.x, healer.pos.x]).toEqual([20 + tick, 19 + tick]);
      expect(healer.pos.isNearTo(attacker.pos)).toBe(true);
    }
  });

  it("不覆盖绿先提交的安全移动，只取消红本次新意图", () => {
    const { attacker, healer, run, commit } = formationScenario("healer-first");
    issueMove(healer, TOP);
    const previous = getMoveIntentReceipt(healer);
    run();
    expect(getMoveIntentReceipt(healer)).toBe(previous);
    expect(getMoveIntentReceipt(attacker)).toBeUndefined();
    commit();
    expect([attacker.pos.x, attacker.pos.y, healer.pos.x, healer.pos.y]).toEqual([20, 20, 19, 19]);
    expect(healer.pos.isNearTo(attacker.pos)).toBe(true);
  });

  it.each(["pushed", "occupied_head", "reserved_tail", "existing_follow_conflict"])("%s 不盲目补跟或拉散编队", (kind) => {
    const { attacker, healer, run, commit, register } = formationScenario("healer-first");
    if (kind === "pushed") ensureCreepMovementState(healer).movementPushedAt = Game.time;
    else {
      const blocker = createMockPowerBankCreep("worker", { name: "blocker", roomName: TARGET_ROOM, x: kind === "occupied_head" ? 21 : 20, y: kind === "occupied_head" ? 20 : 19 });
      blocker.room = attacker.room;
      Game.creeps.blocker = blocker;
      register(blocker);
      if (kind !== "occupied_head") issueMove(blocker, BOTTOM);
    }
    if (kind === "existing_follow_conflict") issueMove(healer, RIGHT);
    const priorGreen = getMoveIntentReceipt(healer);
    run();
    expect(getMoveIntentReceipt(attacker)).toBeUndefined();
    expect(getMoveIntentReceipt(healer)).toBe(priorGreen);
    expect(attacker.memory._warBreachTargetId).toBeUndefined();
    commit();
    expect([attacker.pos.x, healer.pos.x]).toEqual([20, 19]);
    expect(healer.pos.isNearTo(attacker.pos)).toBe(true);
  });

  it("已有让位返回OK但没有新receipt时不取消或误补跟", () => {
    const { attacker, healer, run, commit } = formationScenario("leader-first");
    issueMove(attacker, TOP);
    const priorRed = getMoveIntentReceipt(attacker);
    moveToTarget.mockReturnValue(OK);
    run();
    expect(getMoveIntentReceipt(attacker)).toBe(priorRed);
    expect(healer.move).not.toHaveBeenCalled();
    commit();
    expect([attacker.pos.x, attacker.pos.y, healer.pos.x, healer.pos.y]).toEqual([20, 19, 19, 20]);
  });

  it("仅有本tick移动标记而无真实receipt时不补跟", () => {
    const { attacker, healer, run, commit } = formationScenario("leader-first");
    attacker.memory._warMoveIntentAt = Game.time;
    moveToTarget.mockReturnValue(OK);
    run();
    expect(getMoveIntentReceipt(attacker)).toBeUndefined();
    expect(getMoveIntentReceipt(healer)).toBeUndefined();
    commit();
    expect([attacker.pos.x, attacker.pos.y, healer.pos.x, healer.pos.y]).toEqual([20, 20, 19, 20]);
  });

  it("红的新落点仍贴身时绿原地，下一tick需要时再跟随", () => {
    const { attacker, healer, run, commit } = formationScenario("leader-first");
    healer.pos = new MockPos(20, 19, TARGET_ROOM) as unknown as RoomPosition;
    run();
    expect(getMoveIntentReceipt(healer)).toBeUndefined();
    commit();
    expect([attacker.pos.x, attacker.pos.y, healer.pos.x, healer.pos.y]).toEqual([21, 20, 20, 19]);
    run(); commit();
    expect([attacker.pos.x, attacker.pos.y, healer.pos.x, healer.pos.y]).toEqual([22, 20, 21, 20]);
    expect(healer.pos.isNearTo(attacker.pos)).toBe(true);
  });
});


it("自己轻伤时不覆盖给搭档的治疗意图", () => {
  const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 19, y: 20 });
  const ally = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 20, y: 20 });
  healer.hits -= 1; ally.hits -= 100;
  healer.room.find = jest.fn(() => [ally]) as Room["find"];
  Game.creeps = { green: healer, red: ally };
  healerRole().target(healer);
  expect(healer.heal).toHaveBeenCalledTimes(1);
  expect(healer.heal).toHaveBeenCalledWith(ally);
});
