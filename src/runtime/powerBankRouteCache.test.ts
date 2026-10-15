import { getPowerBankAdmissionRoute } from "@/runtime/powerBankRouteCache";
import { getPowerBankRoomExits, getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";

const corridor = ["E3N59", "E3N60", "E4N60"];
let closed = false;
let disconnected = false;

function map(): GameMap {
  return {
    ...Game.map,
    getWorldSize: () => 202,
    getRoomStatus: (name: string) => ({ status: closed && name === "E3N60" ? "closed" : "normal", timestamp: null }),
    describeExits: (name: string) => name === "E3N59" ? { [TOP]: "E3N60" } :
      name === "E3N60" && !disconnected ? { [RIGHT]: "E4N60" } : {},
  } as unknown as GameMap;
}

beforeEach(() => {
  closed = false; disconnected = false;
  (global as typeof global & { Game: Game }).Game = { ...Game, time: 100, map: map(), shard: { name: "shard1" } as Game["shard"] };
});

function read(find: () => string[] | null, avoid: string[] = []): string[] | null {
  return getPowerBankAdmissionRoute(corridor[0], corridor[2], avoid, find);
}

it("正常重建 Game/map 后复用走廊，但调用方数组改写不能污染它", () => {
  const find = jest.fn(() => [...corridor]);
  read(find)!.splice(1, 1);
  (global as typeof global & { Game: Game }).Game = { ...Game, time: 101, map: map() };
  expect(read(find)).toEqual(corridor);
  expect(find).toHaveBeenCalledTimes(1);
  Game.time = 125;
  expect(read(find)).toEqual(corridor);
  expect(find).toHaveBeenCalledTimes(2);
});

it.each(["closed", "disconnected"])("下一 tick 的 %s 立即重查 native route", (change) => {
  const find = jest.fn(() => [...corridor]);
  read(find);
  Game.time++;
  closed = change === "closed"; disconnected = change === "disconnected";
  read(find);
  expect(find).toHaveBeenCalledTimes(2);
});

it("危险集合与世界边界变化使旧几何失效，null 不跨 tick 复用", () => {
  const find = jest.fn< string[] | null, [] >(() => [...corridor]);
  read(find);
  read(find, ["E3N60"]);
  expect(find).toHaveBeenCalledTimes(2);
  Game.time++;
  Game.map.getWorldSize = () => 204;
  read(find);
  expect(find).toHaveBeenCalledTimes(3);
  find.mockReturnValue(null);
  read(find, ["E0N50"]); read(find, ["E0N50"]);
  expect(find).toHaveBeenCalledTimes(4);
  Game.time++;
  read(find, ["E0N50"]);
  expect(find).toHaveBeenCalledTimes(5);
});

it("同 tick 替换地图与缺少地图连通证据时不复用旧结果", () => {
  const find = jest.fn(() => [...corridor]);
  read(find);
  const status = jest.fn(() => ({ status: "normal" as const, timestamp: null }));
  Game.map.getRoomStatus = status;
  read(find);
  expect(status).toHaveBeenCalledTimes(3);
  const exits = jest.fn(map().describeExits);
  Game.map.describeExits = exits;
  read(find);
  expect(status).toHaveBeenCalledTimes(6);
  expect(exits).toHaveBeenCalledTimes(2);
  // Game 换代、map 换代与两个 reader 换代都是独立的原生事实边界。
  (global as typeof global & { Game: Game }).Game = { ...Game };
  read(find);
  expect(status).toHaveBeenCalledTimes(9);
  expect(exits).toHaveBeenCalledTimes(4);
  Game.map = map();
  read(find);
  expect(find).toHaveBeenCalledTimes(5);
  delete (Game.map as Partial<GameMap>).describeExits;
  Game.time++;
  read(find);
  Game.time++;
  read(find);
  expect(find).toHaveBeenCalledTimes(7);
});

it("LRU 有界，超过 64 个不同输入后老走廊重新查询", () => {
  const find = jest.fn(() => [...corridor]);
  read(find);
  for (let index = 0; index < 64; index++) read(find, [`E${index}S40`]);
  read(find);
  expect(find).toHaveBeenCalledTimes(66);

  // 地图事实同样有界；独立走廊超过容量后，最早的事实需要重新取得。
  const status = jest.fn(() => ({ status: "normal" as const, timestamp: null }));
  const exits = jest.fn((name: string) => ({ [TOP]: name.replace("N59", "N60") }));
  Game.map.getRoomStatus = status;
  Game.map.describeExits = exits;
  const readDistinct = (index: number) => {
    const route = [`E${index}N59`, `E${index}N60`];
    return getPowerBankAdmissionRoute(route[0], route[1], [], () => route);
  };
  for (let index = 0; index <= 1024; index++) readDistinct(index);
  const statusReads = status.mock.calls.length;
  const exitReads = exits.mock.calls.length;
  readDistinct(0);
  expect(status).toHaveBeenCalledTimes(statusReads + 2);
  expect(exits).toHaveBeenCalledTimes(exitReads + 1);
});

it("同帧走廊共享地图事实，下一帧重读，危险集合不能借事实缓存绕过", () => {
  const find = jest.fn(() => [...corridor]);
  const status = jest.spyOn(Game.map, "getRoomStatus");
  const exits = jest.spyOn(Game.map, "describeExits");
  read(find);
  read(find, ["E0N50"]);
  expect(status).toHaveBeenCalledTimes(3);
  expect(exits).toHaveBeenCalledTimes(2);
  // 新危险输入仍进入独立路线查询，不能把地图开放误作安全授权。
  read(find, ["E3N60"]);
  expect(find).toHaveBeenCalledTimes(3);
  Game.time++;
  read(find);
  expect(status).toHaveBeenCalledTimes(6);
  expect(exits).toHaveBeenCalledTimes(4);

  // 保存副本，调用方或原生对象的外部引用都不能污染已取得的事实。
  const nativeStatus: { status: "normal" | "closed"; timestamp: null } = { status: "normal", timestamp: null };
  Game.map.getRoomStatus = jest.fn(() => nativeStatus);
  const statusFact = getPowerBankRoomStatus(corridor[0]);
  nativeStatus.status = "closed";
  expect(getPowerBankRoomStatus(corridor[0]).status).toBe("normal");
  expect(Object.isFrozen(statusFact)).toBe(true);
  const nativeExits = { [RIGHT]: corridor[1] };
  Game.map.describeExits = jest.fn(() => nativeExits);
  const exitFact = getPowerBankRoomExits(corridor[0]);
  nativeExits[RIGHT] = "E9S9";
  expect(getPowerBankRoomExits(corridor[0])?.[RIGHT]).toBe(corridor[1]);
  expect(Object.isFrozen(exitFact)).toBe(true);

  // null 作为拒绝事实可复用；异常不记入缓存，下一次成功读取仍须执行原生方法。
  const nullStatus = jest.fn(() => null);
  const nullExits = jest.fn(() => null);
  Game.map.getRoomStatus = nullStatus;
  Game.map.describeExits = nullExits;
  expect(getPowerBankRoomStatus(corridor[0])).toBeNull();
  expect(getPowerBankRoomStatus(corridor[0])).toBeNull();
  expect(getPowerBankRoomExits(corridor[0])).toBeNull();
  expect(getPowerBankRoomExits(corridor[0])).toBeNull();
  expect(nullStatus).toHaveBeenCalledTimes(1);
  expect(nullExits).toHaveBeenCalledTimes(1);
  const recoveredStatus = jest.fn().mockImplementationOnce(() => { throw new Error("map unavailable"); })
    .mockReturnValue({ status: "normal", timestamp: null });
  const recoveredExits = jest.fn().mockImplementationOnce(() => { throw new Error("map unavailable"); })
    .mockReturnValue({ [RIGHT]: corridor[1] });
  Game.map.getRoomStatus = recoveredStatus;
  Game.map.describeExits = recoveredExits;
  expect(() => getPowerBankRoomStatus(corridor[0])).toThrow("map unavailable");
  expect(getPowerBankRoomStatus(corridor[0]).status).toBe("normal");
  expect(getPowerBankRoomStatus(corridor[0]).status).toBe("normal");
  expect(recoveredStatus).toHaveBeenCalledTimes(2);
  expect(() => getPowerBankRoomExits(corridor[0])).toThrow("map unavailable");
  expect(getPowerBankRoomExits(corridor[0])?.[RIGHT]).toBe(corridor[1]);
  expect(getPowerBankRoomExits(corridor[0])?.[RIGHT]).toBe(corridor[1]);
  expect(recoveredExits).toHaveBeenCalledTimes(2);
});
