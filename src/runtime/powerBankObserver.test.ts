import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { runPowerBankObserver, hasPowerBankObserverCoverage, requestPowerBankObservation } from "@/runtime/powerBankObserver";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

function createRoom(name: string, owned = true): Room {
  return {
    name,
    controller: owned ? { my: true, level: 8 } : undefined,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function addObserver(room: Room): StructureObserver {
  const observer = {
    id: room.name + "-observer",
    structureType: STRUCTURE_OBSERVER,
    room,
    pos: { x: 10, y: 10, roomName: room.name },
    isActive: () => true,
    observeRoom: jest.fn(() => OK),
  } as unknown as StructureObserver;
  (room.find as jest.Mock).mockImplementation((kind: FindConstant) =>
    kind === FIND_MY_STRUCTURES || kind === FIND_STRUCTURES ? [observer] : []);
  Game.rooms[room.name] = room;
  return observer;
}

describe("PowerBank Observer 动态扫描", () => {
  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Memory.data = {};
    Memory.runtime = {};
    Game.map = {
      ...Game.map,
      getRoomLinearDistance: jest.fn(() => 1),
      getWorldSize: jest.fn(() => 202),
      getRoomStatus: jest.fn(() => ({ status: "normal", timestamp: null })),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
    } as unknown as GameMap;
    registerRuntimeServices();
  });

  it("轮巡自动生成的高速房，不限原固定十房", () => {
    const observer = addObserver(createRoom("E3N59"));
    runPowerBankObserver();
    Game.time += 1;
    runPowerBankObserver();
    const calls = (observer.observeRoom as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).not.toBe(calls[1][0]);
    expect(calls.every(([roomName]) => isPowerBankSearchRoom(roomName))).toBe(true);
    expect(calls.some(([roomName]) => !/^E[0-9]N60$/.test(roomName))).toBe(true);
    expect(Memory.runtime?.powerBankObserver?.lastObservedRooms).toEqual([calls[1][0]]);
  });

  it("覆盖判定包含其它来源周边，不能用自可达集合自证", () => {
    addObserver(createRoom("E3N59"));
    const remote = createRoom("E43N45");
    Game.rooms[remote.name] = remote;
    (Game.map.getRoomLinearDistance as jest.Mock).mockImplementation((from: string, to: string) =>
      from === "E3N59" && to === "E40N40" ? 40 : 1);
    expect(hasPowerBankObserverCoverage()).toBe(false);
    addObserver(remote);
    Game.time += 1;
    expect(hasPowerBankObserverCoverage()).toBe(true);
  });

  it("复看请求不覆盖当前意图，下次调度优先发布观察", () => {
    const observer = addObserver(createRoom("E3N59"));
    runPowerBankObserver();
    expect(requestPowerBankObservation("E10N60")).toBe(true);
    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    Game.time += 1;
    runPowerBankObserver();
    expect(observer.observeRoom).toHaveBeenLastCalledWith("E10N60");
    expect(Memory.runtime?.powerBankObserver?.requestedRooms?.E10N60).toBeUndefined();
  });

  it("多个Observer同tick不重复观察同一个房间", () => {
    const first = addObserver(createRoom("E3N59"));
    const second = addObserver(createRoom("E4N58"));
    requestPowerBankObservation("E10N60");
    runPowerBankObserver();
    const rooms = [...(first.observeRoom as jest.Mock).mock.calls, ...(second.observeRoom as jest.Mock).mock.calls].map(([name]) => name);
    expect(rooms).toHaveLength(2);
    expect(new Set(rooms).size).toBe(2);
  });

  it("失败的普通观察会继续轮转", () => {
    const observer = addObserver(createRoom("E3N59"));
    (observer.observeRoom as jest.Mock).mockReturnValueOnce(ERR_INVALID_ARGS).mockReturnValue(OK);
    runPowerBankObserver();
    expect(Memory.runtime?.powerBankObserver?.lastObservedRooms).toEqual([]);
    Game.time += 1;
    runPowerBankObserver();
    expect((observer.observeRoom as jest.Mock).mock.calls[0][0]).not.toBe((observer.observeRoom as jest.Mock).mock.calls[1][0]);
  });

  it("看见固定名单之外的真实Bank仍创建发现记录", () => {
    const room = createRoom("E20N7", false);
    const bank = { id: "pb-dynamic", structureType: STRUCTURE_POWER_BANK, pos: { x: 25, y: 25, roomName: room.name },
      hits: 2000000, power: 3000, ticksToDecay: 4000 };
    (room.find as jest.Mock).mockImplementation((kind: FindConstant) => kind === FIND_STRUCTURES ? [bank] : []);
    Game.rooms[room.name] = room;
    runPowerBankObserver();
    expect(Memory.data?.powerBankHarvest?.["pb-dynamic"]).toMatchObject({ status: "discovered", targetRoom: "E20N7" });
  });

  it("高速房的敌方战斗能力仍记录危险，不因巡逻范围豁免", () => {
    const room = createRoom("E10N60", false);
    const enemy = { getActiveBodyparts: jest.fn((part: BodyPartConstant) => part === ATTACK ? 1 : 0) };
    (room.find as jest.Mock).mockImplementation((kind: FindConstant) => kind === FIND_HOSTILE_CREEPS ? [enemy] : []);
    Game.rooms[room.name] = room;
    runPowerBankObserver();
    expect(Memory.runtime?.transitDangerRooms?.E10N60).toBe(600);
  });

  it("没有可用Observer或超过范围不接受复看请求", () => {
    expect(requestPowerBankObservation("E10N60")).toBe(false);
    addObserver(createRoom("E3N59"));
    (Game.map.getRoomLinearDistance as jest.Mock).mockReturnValue(11);
    expect(requestPowerBankObservation("E10N60")).toBe(false);
    expect(requestPowerBankObservation("E3N59")).toBe(false);
  });
});
