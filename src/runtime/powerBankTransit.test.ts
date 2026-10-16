jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));

import { getPowerBankOwnedAvoidRooms, isPowerBankTransitRoomAllowed, powerBankTransitOptions } from "@/runtime/powerBankTransit";
import { requestCombatObservation } from "@/runtime/powerBankObserver";

beforeEach(() => {
  jest.clearAllMocks();
  Game.rooms = {};
  Memory.runtime = {};
});

it("W2N58 已确认有主后丢失视野，规划仍避开它，重新确认无主才解除", () => {
  Game.rooms.W2N58 = { name: "W2N58", controller: { owner: { username: "enemy" }, my: false } } as Room;
  expect(getPowerBankOwnedAvoidRooms()).toContain("W2N58");
  expect(Memory.runtime?.powerBankOwnedRoomIntel?.W2N58).toEqual({ owner: "enemy", lastSeenAt: Game.time });
  Game.time += 1;
  delete Game.rooms.W2N58;
  expect(getPowerBankOwnedAvoidRooms()).toContain("W2N58");
  expect(powerBankTransitOptions({ room: { name: "W2N57" } } as Creep).avoidRooms).toContain("W2N58");
  expect(isPowerBankTransitRoomAllowed("W2N58")).toBe(false);
  Game.time += 1;
  Game.rooms.W2N58 = { name: "W2N58", controller: {} } as Room;
  expect(getPowerBankOwnedAvoidRooms()).not.toContain("W2N58");
  expect(isPowerBankTransitRoomAllowed("W2N58")).toBe(true);
});

it("再次取得己方所有权的原生视野后允许返仓", () => {
  Memory.runtime!.powerBankOwnedRoomIntel = { W2N58: { owner: "enemy", lastSeenAt: Game.time - 1 } };
  Game.rooms.W2N58 = { name: "W2N58", controller: { owner: { username: "me" }, my: true } } as Room;
  expect(getPowerBankOwnedAvoidRooms()).not.toContain("W2N58");
  expect(isPowerBankTransitRoomAllowed("W2N58")).toBe(true);
});

it("未知下一房先申请观察，不把固定路线当成安全证据", () => {
  expect(isPowerBankTransitRoomAllowed("E3N60")).toBe(false);
  expect(requestCombatObservation).toHaveBeenCalledWith("E3N60");
});

it.each([false, true])("仅己方有主房可通行，controller.my=%s", (my) => {
  Game.rooms.E3N59 = { name: "E3N59", controller: { owner: { username: my ? "me" : "enemy" }, my } } as Room;
  expect(isPowerBankTransitRoomAllowed("E3N59")).toBe(my);
});

it("保存路线包含敌方有主房时仍禁止原生跨房落点，并加入重算避让集合", () => {
  Game.rooms.E3N58 = { name: "E3N58", controller: { owner: { username: "enemy" }, my: false } } as Room;
  const creep = { room: { name: "E3N59" } } as Creep;
  const options = powerBankTransitOptions(creep, { avoidRooms: ["E2N54"] });
  expect(options.avoidRooms).toEqual(["E2N54", "E3N58"]);
  expect(options.canMoveStep?.({ roomName: "E3N58" } as RoomPosition)).toBe(false);
  expect(options.canMoveStep?.({ roomName: "E3N59" } as RoomPosition)).toBe(true);
});

it("己方有主房与无主房可通过，业务已有步进限制仍生效", () => {
  Game.rooms.E3N59 = { name: "E3N59", controller: { my: true, owner: { username: "me" } } } as Room;
  Game.rooms.E3N60 = { name: "E3N60" } as Room;
  const creep = { room: { name: "E3N59" } } as Creep;
  const options = powerBankTransitOptions(creep, { canMoveStep: (pos) => pos.x !== 10 });
  expect(options.canMoveStep?.({ roomName: "E3N60", x: 11 } as RoomPosition)).toBe(true);
  expect(options.canMoveStep?.({ roomName: "E3N60", x: 10 } as RoomPosition)).toBe(false);
});

it("同 tick 多个调用只读一次房间所有权，返回数组互不污染", () => {
  const controller = jest.fn(() => ({ my: false, owner: { username: "enemy" } }));
  Game.rooms.E3N58 = { name: "E3N58", get controller() { return controller(); } } as unknown as Room;
  const first = getPowerBankOwnedAvoidRooms();
  first.length = 0;
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58"]);
  expect(powerBankTransitOptions({ room: { name: "E3N59" } } as Creep).avoidRooms).toEqual(["E3N58"]);
  expect(controller).toHaveBeenCalledTimes(1);
});

it("下一 tick 重新确认敌方所有权解除与新敌方所有权", () => {
  const room = { name: "E3N58", controller: { my: false, owner: { username: "enemy" } } } as Room;
  Game.rooms.E3N58 = room;
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58"]);
  Game.time += 1;
  room.controller = { my: true, owner: { username: "me" } } as StructureController;
  Game.rooms.E3N57 = { name: "E3N57", controller: { my: false, owner: { username: "other" } } } as Room;
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N57"]);
});

it("同 tick 可见房集合替换后重新读取，丢失视野仍保留已确认敌方记录", () => {
  Game.rooms.E3N58 = { name: "E3N58", controller: { my: false, owner: { username: "enemy" } } } as Room;
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58"]);
  Game.rooms = {};
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58"]);
  Game.rooms = { E3N58: { name: "E3N58", controller: { my: true } } as Room };
  expect(getPowerBankOwnedAvoidRooms()).toEqual([]);
});

it("同 tick Game 替换也不会继承旧原生房间事实", () => {
  Game.rooms.E3N58 = { name: "E3N58", controller: { my: false, owner: { username: "enemy" } } } as Room;
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58"]);
  const previous = Game;
  const rooms = Game.rooms;
  try {
    rooms.E3N58 = { name: "E3N58", controller: { my: true } } as Room;
    Object.assign(global, { Game: { ...Game, rooms } });
    expect(getPowerBankOwnedAvoidRooms()).toEqual([]);
  } finally {
    Object.assign(global, { Game: previous });
  }
});

it("同 tick 重读可变 intel，原生可见事实仍校正覆盖后的记录", () => {
  Game.rooms.E3N58 = { name: "E3N58", controller: { my: false, owner: { username: "enemy" } } } as Room;
  Game.rooms.E3N59 = { name: "E3N59", controller: { my: true } } as Room;
  getPowerBankOwnedAvoidRooms();
  Memory.runtime!.powerBankOwnedRoomIntel = {
    E3N58: { owner: "stale", lastSeenAt: Game.time },
    E3N59: { owner: "stale", lastSeenAt: Game.time },
    W2N58: { owner: "unseen", lastSeenAt: Game.time - 1 },
  };
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58", "W2N58"]);
  expect(Memory.runtime!.powerBankOwnedRoomIntel.E3N58).toEqual({ owner: "enemy", lastSeenAt: Game.time });
  Memory.runtime = {};
  expect(getPowerBankOwnedAvoidRooms()).toEqual(["E3N58"]);
});

it("缓存规划事实不代替实际迁房落点的原生安全门", () => {
  const room = { name: "E3N58", controller: { my: true } } as Room;
  Game.rooms.E3N58 = room;
  const options = powerBankTransitOptions({ room: { name: "E3N59" } } as Creep);
  room.controller = { my: false, owner: { username: "enemy" } } as StructureController;
  expect(options.canMoveStep?.({ roomName: "E3N58" } as RoomPosition)).toBe(false);
});


it("没有 Observer 覆盖时依赖已知所有权继续行军，仍避开已知敌房", () => {
  (requestCombatObservation as jest.Mock).mockReturnValue(false);
  expect(isPowerBankTransitRoomAllowed("E3N60")).toBe(true);
  Memory.runtime!.powerBankOwnedRoomIntel = { E3N58: { owner: "enemy", lastSeenAt: Game.time - 500 } };
  expect(isPowerBankTransitRoomAllowed("E3N58")).toBe(false);
  (requestCombatObservation as jest.Mock).mockReturnValue(true);
});
