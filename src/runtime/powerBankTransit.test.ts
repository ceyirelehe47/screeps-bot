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
