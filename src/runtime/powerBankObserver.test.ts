jest.mock("@/runtime/depositDiscovery", () => ({ recordDepositDiscovery: jest.fn() }), { virtual: true });

import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { runPowerBankObserver, hasPowerBankObserverCoverage, requestPowerBankObservation,
  requestCombatObservation, requestDepositObservation, requestRemoteObservation } from "@/runtime/powerBankObserver";
import { recordDepositDiscovery } from "@/runtime/depositDiscovery";
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
    jest.clearAllMocks();
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

  it("四类请求共享同帧活跃结构与可达查询，保留独立队列及单次意图", () => {
    const observer = addObserver(createRoom("E3N59"));
    const active = jest.spyOn(observer, "isActive");
    for (const request of [requestPowerBankObservation, requestCombatObservation, requestDepositObservation, requestRemoteObservation]) {
      expect(request("E10N60")).toBe(true);
    }
    const runtime = Memory.runtime!.powerBankObserver!;
    expect([runtime.requestedRooms?.E10N60, runtime.combatRequestedRooms?.E10N60,
      runtime.depositRequestedRooms?.E10N60, runtime.remoteRequestedRooms?.E10N60].every((value) => value !== undefined)).toBe(true);
    runPowerBankObserver();
    runPowerBankObserver();
    const reachabilityQueries = (Game.map.getRoomLinearDistance as jest.Mock).mock.calls.filter(([, to]) => to === "E10N60").length;
    console.log(JSON.stringify({ kind: "observerSharedQueryBudget", activeQueries: active.mock.calls.length, reachabilityQueries,
      publishedRooms: (observer.observeRoom as jest.Mock).mock.calls.map(([room]) => room) }));
    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(observer.observeRoom).toHaveBeenCalledWith("E10N60");
    expect(active).toHaveBeenCalledTimes(1);
    expect(reachabilityQueries).toBe(1);
  });

  it("同tick重建服务与下一tick均使Observer查询快照失效", () => {
    const observer = addObserver(createRoom("E3N59"));
    const active = jest.spyOn(observer, "isActive");
    expect(requestCombatObservation("E10N60")).toBe(true);
    (Game.map.getRoomLinearDistance as jest.Mock).mockReturnValue(11);
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    registerRuntimeServices();
    expect(requestCombatObservation("E10N60")).toBe(false);
    expect(active).toHaveBeenCalledTimes(2);
    (Game.map.getRoomLinearDistance as jest.Mock).mockReturnValue(1);
    Game.time++;
    expect(requestCombatObservation("E10N60")).toBe(true);
    expect(active).toHaveBeenCalledTimes(3);
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

  it("可见高速房登记 Deposit，非高速房不进入 Deposit 扫描", () => {
    const highway = createRoom("E20N7", false);
    const nonHighway = createRoom("E3N59", false);
    const deposit = { id: "deposit-dynamic", pos: { x: 20, y: 20, roomName: highway.name } } as unknown as Deposit;
    const ignored = { id: "deposit-non-highway", pos: { x: 20, y: 20, roomName: nonHighway.name } } as unknown as Deposit;
    (highway.find as jest.Mock).mockImplementation((kind: FindConstant) => kind === FIND_DEPOSITS ? [deposit] : []);
    (nonHighway.find as jest.Mock).mockImplementation((kind: FindConstant) => kind === FIND_DEPOSITS ? [ignored] : []);
    Game.rooms = { [highway.name]: highway, [nonHighway.name]: nonHighway };
    runPowerBankObserver();
    expect(recordDepositDiscovery).toHaveBeenCalledTimes(1);
    expect(recordDepositDiscovery).toHaveBeenCalledWith(deposit);
  });

  it.each([
    ["combat", requestCombatObservation, "E2N55"],
    ["deposit", requestDepositObservation, "E0N59"],
    ["remote", requestRemoteObservation, "E6N57"],
  ] as const)("%s 显式请求为已有视野继续安排下一 tick 观察", (_kind, request, target) => {
    const observer = addObserver(createRoom("E3N59"));
    Game.rooms[target] = createRoom(target, false);
    expect(request(target)).toBe(true);
    expect(observer.observeRoom).not.toHaveBeenCalled();
    runPowerBankObserver();
    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(observer.observeRoom).toHaveBeenCalledWith(target);
  });

  it("八个 Observer 的 combat 至多三格、remote 至多一格，同时服务 PB/Deposit 并保留巡逻", () => {
    const observers = Array.from({ length: 8 }, (_, index) => addObserver(createRoom(`E${index + 3}N59`)));
    const combat = ["E2N55", "E3N55", "E4N55", "E5N55", "E6N55"];
    const pb = ["E0N59", "E10N60"];
    const deposits = ["E0N58", "E0N56"];
    const remote = ["E6N57", "E6N58"];
    for (const room of combat) expect(requestCombatObservation(room)).toBe(true);
    for (const room of pb) expect(requestPowerBankObservation(room)).toBe(true);
    for (const room of deposits) expect(requestDepositObservation(room)).toBe(true);
    for (const room of remote) expect(requestRemoteObservation(room)).toBe(true);
    runPowerBankObserver();
    const rooms = observers.map((observer) => {
      expect(observer.observeRoom).toHaveBeenCalledTimes(1);
      return (observer.observeRoom as jest.Mock).mock.calls[0][0] as string;
    });
    expect(new Set(rooms).size).toBe(8);
    expect(rooms.filter((room) => combat.includes(room))).toHaveLength(3);
    expect(rooms.filter((room) => remote.includes(room))).toHaveLength(1);
    expect(rooms.some((room) => pb.includes(room))).toBe(true);
    expect(rooms.some((room) => deposits.includes(room))).toBe(true);
    const requested = [...combat, ...pb, ...deposits, ...remote];
    expect(rooms.some((room) => !requested.includes(room) && isPowerBankSearchRoom(room))).toBe(true);
  });

  it.each([5, 8])("%i 个异质覆盖 Observer 保留 Deposit 唯一覆盖者，不被持续 combat 请求占用", (count) => {
    Game.time = 101;
    const observers = Array.from({ length: count }, (_, index) => {
      const observer = addObserver(createRoom(`E${index + 3}N59`));
      Object.assign(observer, { id: `coverage-${index}` });
      return observer;
    });
    const exclusive = observers[0];
    const deposit = "E0N58";
    const combat = ["E2N55", "E3N55", "E4N55", "E5N55", "E6N55"];
    const powerBank = "E10N60";
    const remote = ["E6N57", "E6N58"];
    const requested = [...combat, powerBank, deposit, ...remote];
    (Game.map.getRoomLinearDistance as jest.Mock).mockImplementation((from: string, to: string) =>
      to === deposit && from !== exclusive.room.name ? 11 : 1);

    // 包含独占者轮到普通巡逻的 tick；其余 tick 必须直接服务真实可达请求。
    for (let tick = 0; tick <= count; tick += 1) {
      for (const observer of observers) (observer.observeRoom as jest.Mock).mockClear();
      for (const room of combat) expect(requestCombatObservation(room)).toBe(true);
      expect(requestPowerBankObservation(powerBank)).toBe(true);
      expect(requestDepositObservation(deposit)).toBe(true);
      for (const room of remote) expect(requestRemoteObservation(room)).toBe(true);
      const patrolObserver = observers[Game.time % count];

      runPowerBankObserver();

      const observed = observers.map((observer) => {
        expect(observer.observeRoom).toHaveBeenCalledTimes(1);
        return (observer.observeRoom as jest.Mock).mock.calls[0][0] as string;
      });
      expect(new Set(observed).size).toBe(count);
      expect(observed.filter((room) => combat.includes(room)).length).toBeLessThanOrEqual(3);
      expect(observed.filter((room) => remote.includes(room)).length).toBeLessThanOrEqual(1);
      const patrolled = (patrolObserver.observeRoom as jest.Mock).mock.calls[0][0] as string;
      expect(isPowerBankSearchRoom(patrolled)).toBe(true);
      expect(requested).not.toContain(patrolled);
      if (patrolObserver !== exclusive) {
        expect(exclusive.observeRoom).toHaveBeenCalledWith(deposit);
        expect(observed).toContain(powerBank);
        expect(observed.some((room) => remote.includes(room))).toBe(true);
      }
      // observeRoom OK 是次 tick 观察意图；不能把排队/发布当作当前真实视野。
      expect(Game.rooms[deposit]).toBeUndefined();
      Game.time += 1;
    }
  });

  it("跨四类同房请求只观察一次，并一次清除已完成请求", () => {
    const observers = [addObserver(createRoom("E3N59")), addObserver(createRoom("E4N58")),
      addObserver(createRoom("E5N59")), addObserver(createRoom("E6N59"))];
    const target = "E10N60";
    for (const request of [requestCombatObservation, requestPowerBankObservation, requestDepositObservation, requestRemoteObservation]) {
      expect(request(target)).toBe(true);
    }
    runPowerBankObserver();
    const rooms = observers.flatMap((observer) => (observer.observeRoom as jest.Mock).mock.calls.map(([room]) => room));
    expect(rooms.filter((room) => room === target)).toHaveLength(1);
    expect(new Set(rooms).size).toBe(rooms.length);
    const state = Memory.runtime!.powerBankObserver!;
    for (const field of ["requestedRooms", "combatRequestedRooms", "depositRequestedRooms", "remoteRequestedRooms"] as const) {
      expect(state[field]?.[target]).toBeUndefined();
    }
  });

  it("同 tick 再调度不覆盖已发布意图，角色的新请求留给下一 tick", () => {
    const observers = [addObserver(createRoom("E3N59")), addObserver(createRoom("E4N58"))];
    runPowerBankObserver();
    const observed = [...Memory.runtime!.powerBankObserver!.lastObservedRooms];
    expect(requestCombatObservation("E2N55")).toBe(true);
    runPowerBankObserver();
    for (const observer of observers) expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(Memory.runtime!.powerBankObserver!.lastObservedRooms).toEqual(observed);
    expect(Memory.runtime!.powerBankObserver!.combatRequestedRooms?.E2N55).toBe(100);
    Game.time += 1;
    runPowerBankObserver();
    for (const observer of observers) expect(observer.observeRoom).toHaveBeenCalledTimes(2);
    expect(Memory.runtime!.powerBankObserver!.lastObservedRooms).toContain("E2N55");
  });

  it.each([1, 2])("%i 个 Observer 连续四类请求下公平轮转且保留普通巡逻", (count) => {
    const observers = Array.from({ length: count }, (_, index) => addObserver(createRoom(`E${index + 3}N59`)));
    const targets = ["E2N55", "E0N59", "E0N58", "E6N57"];
    const requests = [requestCombatObservation, requestPowerBankObservation, requestDepositObservation, requestRemoteObservation];
    for (let tick = 0; tick < 5; tick += 1) {
      for (let index = 0; index < requests.length; index += 1) expect(requests[index](targets[index])).toBe(true);
      runPowerBankObserver();
      Game.time += 1;
    }
    const rooms = observers.flatMap((observer) => (observer.observeRoom as jest.Mock).mock.calls.map(([room]) => room as string));
    expect(rooms).toHaveLength(count * 5);
    for (const target of targets) expect(rooms).toContain(target);
    expect(rooms.some((room) => !targets.includes(room) && isPowerBankSearchRoom(room))).toBe(true);
  });

  it("四队列共享 64 请求上限，过期请求清理后恢复容量", () => {
    addObserver(createRoom("E3N59"));
    for (let index = 1; index <= 40; index += 1) expect(requestCombatObservation(`E${index}S1`)).toBe(true);
    for (let index = 41; index <= 50; index += 1) expect(requestRemoteObservation(`E${index}S1`)).toBe(true);
    for (let index = 1; index <= 14; index += 1) expect(requestDepositObservation(`E0S${index}`)).toBe(true);
    expect(requestPowerBankObservation("E0S20")).toBe(false);
    expect(requestCombatObservation("E2S2")).toBe(false);
    expect(requestCombatObservation("E1S1")).toBe(true);
    Game.time += 26;
    expect(requestPowerBankObservation("E0S20")).toBe(true);
    const state = Memory.runtime!.powerBankObserver!;
    const total = [state.requestedRooms, state.combatRequestedRooms, state.depositRequestedRooms, state.remoteRequestedRooms]
      .reduce((sum, table) => sum + Object.keys(table ?? {}).length, 0);
    expect(total).toBe(1);
  });

  it.each([
    [requestCombatObservation, "E2N55"],
    [requestDepositObservation, "E0N59"],
    [requestRemoteObservation, "E6N57"],
  ] as const)("新请求无覆盖或非法房名时返回 false（%s）", (request, target) => {
    expect(request(target)).toBe(false);
    addObserver(createRoom("E3N59"));
    (Game.map.getRoomLinearDistance as jest.Mock).mockReturnValue(11);
    expect(request(target)).toBe(false);
    (Game.map.getRoomLinearDistance as jest.Mock).mockReturnValue(1);
    for (const invalid of ["sim", "E01N57", "E101N57"]) expect(request(invalid)).toBe(false);
    expect(requestDepositObservation("E3N59")).toBe(false);
  });
});
