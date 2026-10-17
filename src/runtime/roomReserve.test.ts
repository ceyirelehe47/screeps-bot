import { invalidateRoomReserveCache, isRoomInReserveMode } from "@/runtime/roomReserve";

it("同 tick 增删旗帜立即改变储备判定", () => {
  Game.time++; Game.flags = {};
  expect(isRoomInReserveMode("W1N1")).toBe(false);
  Game.flags.RESERVE_W1N1 = { name: "RESERVE_W1N1", pos: { roomName: "W1N1" } } as Flag;
  expect(isRoomInReserveMode("W1N1")).toBe(true);
  delete Game.flags.RESERVE_W1N1;
  expect(isRoomInReserveMode("W1N1")).toBe(false);
});
it("自动旗位置变更后可显式刷新，而不是等下一 tick", () => {
  Game.time++;
  const flag = { name: "RESERVE_W1N1", pos: { roomName: "W1N2" } } as Flag;
  Game.flags = { RESERVE_W1N1: flag };
  expect(isRoomInReserveMode("W1N2")).toBe(true);
  Object.assign(flag, { pos: { roomName: "W1N1" } });
  invalidateRoomReserveCache();
  expect(isRoomInReserveMode("W1N1")).toBe(true);
  expect(isRoomInReserveMode("W1N2")).toBe(false);
});
