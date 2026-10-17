import { registerRuntimeServices } from "@/runtime/runtimeServices";

jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));
jest.mock("@/runtime/powerBankObserver", () => ({
  requestRemoteObservation: jest.fn(() => false),
}));

import {
  ensureRemoteMiningStore,
  getRemoteMiningConfig,
  getRemoteMiningScoutConfigName,
  getRemoteDefenderConfigName,
  runRemoteMining,
  processRemoteConfigLifecycle,
  getActiveDefenseReason,
  getRemoteThreatReason,
  REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY,
  upsertScoutConfig,
} from "@/runtime/remoteMining";
import { isDefenseMode } from "@/runtime/defenseMode";
import { requestRemoteObservation } from "@/runtime/powerBankObserver";

beforeEach(() => {
  registerRuntimeServices(undefined);
  (requestRemoteObservation as jest.Mock).mockReset().mockReturnValue(false);
});

function setupGameMap(exitsMap: Record<string, Record<string, string>>): void {
  if (!Game.map) (Game as any).map = {} as GameMap;
  Game.map.describeExits = jest.fn((roomName: string) => exitsMap[roomName] ?? null);
  (Game.map as any).findRoute = jest.fn((from: string, to: string) => {
    if (exitsMap[from]) {
      for (const [dir, room] of Object.entries(exitsMap[from])) {
        if (room === to) return [{ room: to, exit: Number(dir) }];
      }
    }
    return ERR_NO_PATH;
  });
  (Game.map as any).getRoomStatus = jest.fn(() => ({ status: "normal" }));
}

function createRclRoom(name: string, level: number): Room {
  Memory.rooms[name] = {} as RoomMemory;
  return {
    name,
    memory: Memory.rooms[name],
    controller: { my: true, level } as unknown as StructureController,
    energyCapacityAvailable: level >= 7 ? REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY : 2300,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createVisibleTargetRoom(
  name: string,
  options: {
    sources?: Source[];
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    reservationUsername?: string;
  } = {},
): Room {
  Memory.rooms[name] = {} as RoomMemory;
  const sources = options.sources ?? [];
  const hostileCreeps = options.hostileCreeps ?? [];
  const hostileStructures = options.hostileStructures ?? [];
  const controller: Partial<StructureController> = { my: false, level: 0 };
  if (options.reservationUsername) {
    (controller as any).reservation = {
      username: options.reservationUsername,
      ticksToEnd: 100,
    };
  }
  return {
    name,
    memory: Memory.rooms[name],
    controller: controller as StructureController,
    find: jest.fn((what: number, opts?: { filter?: (structure: Structure) => boolean }) => {
      if (what === FIND_SOURCES) return sources;
      if (what === FIND_HOSTILE_CREEPS) return hostileCreeps;
      if (what === FIND_HOSTILE_STRUCTURES) {
        return opts?.filter ? hostileStructures.filter(opts.filter) : hostileStructures;
      }
      if (what === FIND_STRUCTURES) return [];
      return [];
    }),
  } as unknown as Room;
}

function createSource(id: string): Source {
  return { id } as Source;
}

function createSpawn(room: Room, username = "me"): StructureSpawn {
  return {
    name: `Spawn_${room.name}`,
    room,
    owner: { username },
    memory: {},
  } as unknown as StructureSpawn;
}

function createRemoteInvaderCore(): StructureInvaderCore {
  return {
    id: "core-0" as Id<StructureInvaderCore>,
    structureType: STRUCTURE_INVADER_CORE,
    level: 0,
    hits: 100_000,
    hitsMax: 100_000,
    effects: [],
    pos: { x: 25, y: 25, roomName: "W1N0" } as RoomPosition,
  } as unknown as StructureInvaderCore;
}

function ensureConfigStore(): Record<string, import("@/types/system").CreepConfig> {
  Memory.data = Memory.data ?? {};
  Memory.data.creepConfigs = Memory.data.creepConfigs ?? {};
  return Memory.data.creepConfigs;
}

describe("runRemoteMining first come assignment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
  });

  it.each(["defending", "suspended"] as const)("%s 的既有外矿仍占用每房上限", status => {
    Memory.data = { remoteMining: { W1N0: { sourceRoom: "W1N1", targetRoom: "W1N0", status, sourceIds: [],
      assignedAt: 1, updatedAt: 1, suspendedAt: 99, suspendReason: "source_room_defense_mode", defendingSince: 99 } } } as Memory["data"];
    const source = createRclRoom("W1N1", 7); Game.rooms.W1N1 = source; Game.spawns.Spawn1 = createSpawn(source);
    setupGameMap({ W1N1: { "3": "W2N1" } });
    runRemoteMining();
    expect(ensureRemoteMiningStore().W2N1).toBeUndefined();
  });
  it("abandoned 的冷却到期后重新侦察，之前保持冷却", () => {
    const source = createRclRoom("W1N1", 7); Game.rooms.W1N1 = source; Game.spawns.Spawn1 = createSpawn(source);
    setupGameMap({ W1N1: { "1": "W1N0" } });
    Memory.data = { remoteMining: { W1N0: { sourceRoom: "W1N1", targetRoom: "W1N0", status: "abandoned", sourceIds: [],
      assignedAt: 1, updatedAt: 1, nextRetryAt: 150 } } };
    runRemoteMining(); expect(ensureRemoteMiningStore().W1N0.status).toBe("abandoned");
    Game.time = 150; runRemoteMining(); expect(ensureRemoteMiningStore().W1N0.status).toBe("scouting");
  });
  it("creates active task for visible cardinal room with exactly two sources", () => {
    const rcl7Room = createRclRoom("W1N1", 7);
    const targetRoom = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
    });
    Game.rooms.W1N1 = rcl7Room;
    Game.rooms.W1N0 = targetRoom;
    Game.spawns.Spawn1 = createSpawn(rcl7Room);
    setupGameMap({ W1N1: { "1": "W1N0" } });

    runRemoteMining();

    const task = ensureRemoteMiningStore().W1N0;
    expect(task).toMatchObject({
      status: "active",
      sourceRoom: "W1N1",
      sourceIds: ["src1", "src2"],
      assignedAt: 100,
      lastVerifiedAt: 100,
    });
  });
});

describe("remote Invader Core clearance", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;

  beforeEach(() => {
    jest.clearAllMocks();
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
  });

  function setupSourceRoom(): StructureSpawn {
    const sourceRoom = createRclRoom("W1N1", 7);
    Game.rooms[sourceRoom.name] = sourceRoom;
    const spawn = createSpawn(sourceRoom);
    Game.spawns[spawn.name] = spawn;
    return spawn;
  }

  function setupTask(
    status: import("@/runtime/remoteMining").RemoteMiningStatus = "active",
  ): import("@/runtime/remoteMining").RemoteMiningTask {
    const task: import("@/runtime/remoteMining").RemoteMiningTask = {
      sourceRoom: "W1N1",
      targetRoom: "W1N0",
      status,
      sourceIds: ["src1", "src2"],
      assignedAt: 50,
      updatedAt: 50,
    };
    store[task.targetRoom] = task;
    return task;
  }

  it("清掉 core 后的 Invader 预定仍保留 reserver 配置", () => {
    setupSourceRoom(); setupTask();
    const target = createVisibleTargetRoom("W1N0", { reservationUsername: "Invader" });
    Game.rooms.W1N0 = target;
    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    expect(Object.values(Memory.data!.creepConfigs!).some(config => config.role === "remoteMiningReserver" && config.roomName === "W1N1")).toBe(true);
  });
  function setupTarget(core?: StructureInvaderCore): Room {
    const target = createVisibleTargetRoom("W1N0", {
      sources: [createSource("src1"), createSource("src2")],
      hostileStructures: core ? [core] : [],
      reservationUsername: core ? "Invader" : undefined,
    });
    Game.rooms[target.name] = target;
    return target;
  }

  it("enters Core defense with one stable defender config and keeps scout vision", () => {
    setupSourceRoom();
    const target = setupTarget(createRemoteInvaderCore());
    const task = setupTask();

    expect(getActiveDefenseReason(target, task)).toBe("npc_invader_core");
    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    Game.time += 1;
    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader_core");
    expect(Memory.data!.creepConfigs![defenderName]).toEqual({
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    });
    expect(Memory.data!.creepConfigs![scoutName]).toEqual({
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    });
    expect(Object.keys(Memory.data!.creepConfigs!).filter((name) => name === defenderName)).toHaveLength(1);
  });

  it("does not mark completion or retain defender spawn eligibility without vision", () => {
    const spawn = setupSourceRoom();
    const task = setupTask("defending");
    task.defenseReason = "npc_invader_core";
    task.defendingSince = 80;
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![defenderName] = {
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    };
    spawn.memory.spawnList = [defenderName, defenderName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader_core");
    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });

  it("Observer 有实际视野时仅停侦察再产，保留现役 scout 与 Core 防守", () => {
    (requestRemoteObservation as jest.Mock).mockReturnValue(true);
    const spawn = setupSourceRoom();
    setupTarget(createRemoteInvaderCore());
    const task = setupTask();
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const otherScoutName = getRemoteMiningScoutConfigName("W1N1", "W2N1");
    Memory.data!.creepConfigs![scoutName] = {
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    };
    const scout = {
      memory: { role: "scout", configName: scoutName },
      room: Game.rooms.W1N1,
      suicide: jest.fn(),
    } as unknown as Creep;
    const defender = {
      memory: { role: "remoteDefender", configName: defenderName },
      room: Game.rooms.W1N1,
      suicide: jest.fn(),
    } as unknown as Creep;
    Game.creeps.scout = scout;
    Game.creeps.defender = defender;
    spawn.memory.spawnList = [scoutName, otherScoutName, defenderName, scoutName, "W1N1:claimer:0"];
    const otherSpawn = createSpawn(createRclRoom("W2N1", 7));
    otherSpawn.memory.spawnList = [scoutName];
    Game.spawns[otherSpawn.name] = otherSpawn;

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());

    expect(task.status).toBe("defending");
    expect(task.defenseReason).toBe("npc_invader_core");
    expect(Memory.data!.creepConfigs![defenderName]).toEqual({
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    });
    expect(Memory.data!.creepConfigs![scoutName]).toEqual({ role: "scout", args: ["W1N0"] });
    expect(spawn.memory.spawnList).toEqual([otherScoutName, defenderName, "W1N1:claimer:0"]);
    expect(otherSpawn.memory.spawnList).toEqual([scoutName]);
    expect(scout.suicide).not.toHaveBeenCalled();
    expect(defender.suicide).not.toHaveBeenCalled();
  });

  it("resumes immediately after visible Core disappearance and removes every queued duplicate", () => {
    const spawn = setupSourceRoom();
    setupTarget();
    const task = setupTask("defending");
    task.defenseReason = "npc_invader_core";
    task.defendingSince = 80;
    const defenderName = getRemoteDefenderConfigName("W1N1", "W1N0");
    const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");
    Memory.data!.creepConfigs![defenderName] = {
      role: "remoteDefender", args: ["W1N0"], roomName: "W1N1",
    };
    Memory.data!.creepConfigs![scoutName] = {
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    };
    spawn.memory.spawnList = [defenderName, scoutName, defenderName, scoutName, "W1N1:worker:0"];

    processRemoteConfigLifecycle(store, getRemoteMiningConfig());
    Game.time += 1;
    expect(() => processRemoteConfigLifecycle(store, getRemoteMiningConfig())).not.toThrow();

    expect(task.status).toBe("active");
    expect(task.defenseReason).toBeUndefined();
    expect(Memory.data!.creepConfigs![defenderName]).toBeUndefined();
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["W1N1:worker:0"]);
  });
});

describe("外矿 Observer 视野租约与 scout 回退", () => {
  let store: Record<string, import("@/runtime/remoteMining").RemoteMiningTask>;
  const scoutName = getRemoteMiningScoutConfigName("W1N1", "W1N0");

  function addTask(targetRoom = "W1N0"): void {
    store[targetRoom] = {
      sourceRoom: "W1N1", targetRoom, status: "defending", defenseReason: "npc_invader_core",
      sourceIds: ["src1", "src2"], assignedAt: 50, updatedAt: 50,
    };
  }

  beforeEach(() => {
    delete (global as any).__runtimeServices;
    registerRuntimeServices(undefined);
    Game.time = 100;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.runtime = {};
    Memory.data = {};
    ensureConfigStore();
    store = ensureRemoteMiningStore();
    addTask();
    (requestRemoteObservation as jest.Mock).mockReturnValue(true);
  });

  it("接受入队但持续无视野时首次宽限不会被逐 tick 请求续期", () => {
    for (let tick = 100; tick <= 125; tick++) {
      Game.time = tick;
      upsertScoutConfig("W1N1", "W1N0");
      expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    }
    Game.time = 126;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toEqual({
      role: "scout", args: ["W1N0"], roomName: "W1N1",
    });
  });

  it("实际视野恢复后停新增，再持续失明超过 25 tick 时回退", () => {
    upsertScoutConfig("W1N1", "W1N0");
    Game.time = 126;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    Game.time = 127;
    Game.rooms.W1N0 = createVisibleTargetRoom("W1N0");
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    delete Game.rooms.W1N0;
    Game.time = 152;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    Game.time = 153;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]?.roomName).toBe("W1N1");
  });

  it("没有覆盖或请求被拒绝时立即恢复原 scout 生产", () => {
    upsertScoutConfig("W1N1", "W1N0");
    (requestRemoteObservation as jest.Mock).mockReturnValue(false);
    Game.time = 101;
    Game.rooms.W1N0 = createVisibleTargetRoom("W1N0");
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]?.roomName).toBe("W1N1");
  });

  it("正常前进 tick 重建 Game 对象不会重开首次宽限", () => {
    for (let tick = 100; tick <= 126; tick++) {
      (global as any).Game = { ...Game, time: tick };
      upsertScoutConfig("W1N1", "W1N0");
    }
    expect(Memory.data!.creepConfigs![scoutName]?.roomName).toBe("W1N1");
  });

  it("同 tick 更换 Game 世界会丢弃旧租约", () => {
    upsertScoutConfig("W1N1", "W1N0");
    Game.time = 126;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeDefined();
    (global as any).Game = { ...Game };
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("时间倒退清除旧租约，不复用未来的视野或截止时间", () => {
    Game.rooms.W1N0 = createVisibleTargetRoom("W1N0");
    upsertScoutConfig("W1N1", "W1N0");
    delete Game.rooms.W1N0;
    Game.time = 80;
    upsertScoutConfig("W1N1", "W1N0");
    Game.time = 106;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]?.roomName).toBe("W1N1");
  });

  it("任务重分配时丢弃此前已耗尽的宽限", () => {
    upsertScoutConfig("W1N1", "W1N0");
    Game.time = 126;
    upsertScoutConfig("W1N1", "W1N0");
    store.W1N0.assignedAt = 126;
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("任务删除和 abandoned 会清理租约", () => {
    upsertScoutConfig("W1N1", "W1N0");
    Game.time = 126;
    delete store.W1N0;
    addTask("W2N0");
    upsertScoutConfig("W1N1", "W2N0");
    addTask();
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
    store.W1N0.status = "abandoned";
    Game.time = 152;
    upsertScoutConfig("W1N1", "W1N0");
    store.W1N0.status = "defending";
    upsertScoutConfig("W1N1", "W1N0");
    expect(Memory.data!.creepConfigs![scoutName]).toBeUndefined();
  });

  it("最多保留 64 个租约，满额目标立即回退而不挤出活跃目标", () => {
    for (let index = 0; index < 65; index++) addTask(`W${index + 2}N0`);
    for (let index = 0; index < 64; index++) upsertScoutConfig("W1N1", `W${index + 2}N0`);
    upsertScoutConfig("W1N1", "W66N0");
    const overflowName = getRemoteMiningScoutConfigName("W1N1", "W66N0");
    expect(Memory.data!.creepConfigs![overflowName]?.roomName).toBe("W1N1");
    Game.time = 126;
    upsertScoutConfig("W1N1", "W2N0");
    expect(Memory.data!.creepConfigs![getRemoteMiningScoutConfigName("W1N1", "W2N0")]?.roomName).toBe("W1N1");
  });

  it("500 tick 未使用的租约到期后释放容量", () => {
    for (let index = 0; index < 65; index++) addTask(`W${index + 2}N0`);
    for (let index = 0; index < 64; index++) upsertScoutConfig("W1N1", `W${index + 2}N0`);
    Game.time = 601;
    upsertScoutConfig("W1N1", "W66N0");
    expect(Memory.data!.creepConfigs![getRemoteMiningScoutConfigName("W1N1", "W66N0")]).toBeUndefined();
  });
});


it("容器在自己的衰减点扣血不判攻击，额外损伤才进入玩家防御", () => {
  Game.time = 123; Game.creeps = {}; Game.spawns = {};
  const source = { id: "source", pos: { x: 10, y: 10 } } as Source;
  const container = { id: "container", structureType: STRUCTURE_CONTAINER, pos: { x: 11, y: 10 }, hits: 10000, ticksToDecay: 1 } as StructureContainer;
  const hostile = { owner: { username: "enemy" } } as Creep;
  const room = { name: "W1N0", controller: { reservation: { username: "Invader", ticksToEnd: 4500 } },
    find: (kind: FindConstant, opts?: { filter?: (s: any) => boolean }) => {
      const objects = kind === FIND_STRUCTURES ? [container] : kind === FIND_HOSTILE_CREEPS ? [hostile] : [];
      return opts?.filter ? objects.filter(opts.filter) : objects;
    } } as unknown as Room;
  const task = { sourceRoom: "W1N1", targetRoom: room.name, status: "active", sourceIds: [source.id], assignedAt: 1, updatedAt: 1 } as import("@/runtime/remoteMining").RemoteMiningTask;
  Game.getObjectById = jest.fn(() => source) as unknown as Game["getObjectById"];
  expect(getRemoteThreatReason(room)).toBeNull();
  expect(getActiveDefenseReason(room, task)).toBeNull();
  Game.time += 1; container.hits -= CONTAINER_DECAY; container.ticksToDecay = CONTAINER_DECAY_TIME;
  expect(getActiveDefenseReason(room, task)).toBeNull();
  Game.time += 1; container.hits -= 1; container.ticksToDecay -= 1;
  expect(getActiveDefenseReason(room, task)).toBe("player_aggression");
});
