jest.mock("@/runtime/tickContext", () => ({
  ...jest.requireActual("@/runtime/tickContext"),
  isSpawnActive: jest.fn(() => true),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  recordFixedCpuAction: jest.fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

import { mountSpawn } from "@/mount/mountSpawn";
import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
} from "@/runtime/upgraderPolicy";

type SpawnPrototype = {
  work(this: StructureSpawn): void;
};

function createSpawn(name: string, room: Room, queue: string[]): StructureSpawn {
  return {
    name,
    room,
    spawning: null,
    memory: { spawnList: [...queue] },
    spawnCreep: jest.fn(() => OK),
  } as unknown as StructureSpawn;
}

describe("mountSpawn", () => {
  let prototype: SpawnPrototype;

  beforeEach(() => {
    jest.clearAllMocks();
    Game.time += 1;
    Game.creeps = {};
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Object.assign(global, { StructureSpawn: function StructureSpawn() {} });
    mountSpawn();
    prototype = (global as typeof global & {
      StructureSpawn: { prototype: SpawnPrototype };
    }).StructureSpawn.prototype;
    Memory.data = { creepConfigs: {} } as Memory["data"];
    Game.rooms = {};
    Game.spawns = {};
  });

  it("同tick多Spawn生产同角色不重名，配对Memory归属保持独立", () => {
    const room = { name: "E1N57", energyAvailable: 5600, energyCapacityAvailable: 5600 } as Room;
    const configs = ["E1N57:powerbank:E0N58:attacker", "E1N57:powerbank:W0N57:attacker"];
    configs.forEach(name => { Memory.data!.creepConfigs![name] = { role: "powerBankAttacker", roomName: room.name, args: [], body: [ATTACK, MOVE] }; });
    const first = createSpawn("Spawn1", room, [configs[0]]);
    const second = createSpawn("Spawn2", room, [configs[1]]);
    Game.spawns = { Spawn1: first, Spawn2: second };
    for (const spawn of [first, second]) { Object.setPrototypeOf(spawn, prototype); prototype.work.call(spawn); }
    const one = (first.spawnCreep as jest.Mock).mock.calls[0];
    const two = (second.spawnCreep as jest.Mock).mock.calls[0];
    expect(one[1]).not.toBe(two[1]);
    expect(one[2].memory.configName).toBe(configs[0]);
    expect(two[2].memory.configName).toBe(configs[1]);
  });

  it.each(["energy", "busy", "behind"])("战争任务%s未能立即执行时不阻止便宜外矿出生", (condition) => {
    const room = { name: "E1N57", energyAvailable: 12000, energyCapacityAvailable: 12900 } as Room;
    const war = "E1N57:war:E3N57:controllerAttacker:0";
    const mine = "E1N57:remoteMine:E1N58:harvester:source";
    Memory.data!.creepConfigs![war] = { role: "claimer", roomName: room.name, args: [], body: [...Array(19).fill(CLAIM), ...Array(19).fill(MOVE)] };
    Memory.data!.creepConfigs![mine] = { role: "colonizerHarvester", roomName: room.name, args: [], body: [WORK, CARRY, MOVE] };
    const first = createSpawn("Spawn1", room, condition === "behind" ? [mine, war] : [war]);
    const second = createSpawn("Spawn2", room, [mine]);
    if (condition === "busy") { room.energyAvailable = 12900; first.spawning = { name: "old", remainingTime: 100 } as Spawning; }
    if (condition === "behind") room.energyAvailable = 12900;
    Game.spawns = { Spawn1: first, Spawn2: second };
    Object.setPrototypeOf(second, prototype);
    prototype.work.call(second);
    expect(second.spawnCreep).toHaveBeenCalledTimes(1);
    expect((second.spawnCreep as jest.Mock).mock.calls[0][2].memory.configName).toBe(mine);
  });

  it("preserves authenticated RCL8 maintenance ownership over war and emergency queues", () => {
    const room = {
      name: "E4N58",
      energyAvailable: 300,
      energyCapacityAvailable: 5_600,
      controller: {
        my: true,
        level: 8,
        ticksToDowngrade: RCL8_UPGRADER_RECOVERY_START_TICKS,
      },
    } as Room;
    const maintenance = "E4N58:upgrader:0";
    const war = "E4N58:war:E5N58:g1:healer:0";
    const emergency = `E4N58:manual:maxcarrier:${Game.time}`;
    Memory.data = {
      manualUpgraders: {
        [room.name]: { createdAt: Game.time, updatedAt: Game.time, maintenance: true },
      },
      creepConfigs: {
        [maintenance]: {
          role: "upgrader",
          args: [room.name],
          roomName: room.name,
          body: [...RCL8_UPGRADER_MAINTENANCE_BODY],
        },
        [war]: { role: "healer", args: [], roomName: room.name, body: [HEAL, MOVE] },
        [emergency]: { role: "carrier", args: [], roomName: room.name, body: [CARRY, MOVE] },
      },
    } as Memory["data"];
    Game.rooms[room.name] = room;
    const maintenanceSpawn = createSpawn("Spawn1", room, [maintenance]);
    const warSpawn = createSpawn("Spawn2", room, [war]);
    const emergencySpawn = createSpawn("Spawn3", room, [emergency]);
    for (const spawn of [maintenanceSpawn, warSpawn, emergencySpawn]) {
      Object.setPrototypeOf(spawn, prototype);
    }
    Game.spawns = {
      Spawn1: maintenanceSpawn,
      Spawn2: warSpawn,
      Spawn3: emergencySpawn,
    };

    prototype.work.call(warSpawn);
    prototype.work.call(emergencySpawn);
    expect(warSpawn.spawnCreep).not.toHaveBeenCalled();
    expect(emergencySpawn.spawnCreep).not.toHaveBeenCalled();

    prototype.work.call(maintenanceSpawn);
    expect(maintenanceSpawn.spawnCreep).toHaveBeenCalledWith(
      RCL8_UPGRADER_MAINTENANCE_BODY,
      `upgrader-${Game.time}`,
      expect.objectContaining({
        memory: expect.objectContaining({ configName: maintenance }),
      }),
    );
    expect(maintenanceSpawn.memory.spawnList).toEqual([]);
  });

  it("locks Spawn20 to its safe exit and isolates success cleanup from failure retry", () => {
    {
      const room = {
        name: "E5N59",
        energyAvailable: 1_000,
        energyCapacityAvailable: 12_900,
      } as Room;
      const configName = `${room.name}:manual:maxcarrier:${Game.time}`;
      Memory.data = {
        creepConfigs: {
          [configName]: {
            role: "carrier",
            args: [],
            roomName: room.name,
            body: [CARRY, MOVE],
          },
        },
      } as Memory["data"];
      const spawn = createSpawn("Spawn20", room, [configName]);
      Object.setPrototypeOf(spawn, prototype);
      Game.spawns = { Spawn20: spawn };

      prototype.work.call(spawn);

      expect(spawn.spawnCreep).toHaveBeenCalledWith(
        [CARRY, MOVE],
        `carrier-${Game.time}`,
        expect.objectContaining({ directions: [TOP] }),
      );
      expect(spawn.memory.spawnList).toEqual([]);
      expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
    }

    // The failure fixture is rebuilt from scratch so the first scenario cannot leak queue/config state.
    {
      Game.time += 1;
      const room = {
        name: "E5N59",
        energyAvailable: 200,
        energyCapacityAvailable: 12_900,
      } as Room;
      const configName = `${room.name}:carrier:0`;
      Memory.data = {
        creepConfigs: {
          [configName]: {
            role: "carrier",
            args: [],
            roomName: room.name,
            body: [CARRY, CARRY, MOVE],
          },
        },
      } as Memory["data"];
      const spawn = createSpawn("Spawn20", room, [configName]);
      spawn.spawnCreep = jest.fn(() => ERR_NOT_ENOUGH_ENERGY);
      Object.setPrototypeOf(spawn, prototype);
      Game.spawns = { Spawn20: spawn };

      prototype.work.call(spawn);

      expect(spawn.memory.spawnList).toEqual([configName]);
      expect(spawn.memory._lastSpawnFail).toMatchObject({
        tick: Game.time,
        spawnName: "Spawn20",
        configName,
        role: "carrier",
        code: ERR_NOT_ENOUGH_ENERGY,
      });
      expect(Memory.data!.creepConfigs![configName]).toBeDefined();
      expect(spawn.spawnCreep).toHaveBeenCalledWith(
        [CARRY, CARRY, MOVE],
        `carrier-${Game.time}`,
        expect.objectContaining({ directions: [TOP] }),
      );
    }

    // 要落地的那一 tick（remainingTime 归零，含出生位被堵的冻结期）出生位
    // 被已出生 creep 占据：向其下达让位指令（memory 传递 + 直接 move）；
    // Spawn20 的出生位是 TOP 邻格（directions 约束），blocker 从自身周围
    // 离开且不得被推回出生格；无可用出口时不发。
    {
      const blockerMove = jest.fn(() => OK);
      const blockerPos = { x: 25, y: 25 };
      const blockerMemory: Record<string, unknown> = {};
      const blockerRoom = { room: undefined as unknown as Room };
      const blocker = {
        my: true,
        move: blockerMove,
        pos: blockerPos,
        memory: blockerMemory,
        get room() { return blockerRoom.room; },
      } as unknown as Creep;
      // PowerCreep 不在 LOOK_CREEPS 里但同样占据出生格：W1N57 现场证据
      // 表明 operator 站在出生格会让孵化永久冻结，必须被让位逻辑覆盖。
      const powerCreepMove = jest.fn(() => OK);
      const powerCreepMemory: Record<string, unknown> = {};
      const powerCreepPos = { x: 25, y: 24 };
      const powerCreepObj = {
        my: true,
        move: powerCreepMove,
        pos: powerCreepPos,
        memory: powerCreepMemory,
        get room() { return blockerRoom.room; },
      } as unknown as PowerCreep;
      const makePos = (
        x: number,
        y: number,
        terrain: (x: number, y: number) => string = () => "plain",
      ) => ({
        x,
        y,
        lookFor: (type: string): unknown[] => {
          if (type === LOOK_TERRAIN) {
            return [terrain(x, y)];
          }
          if (type === LOOK_CREEPS && x === blockerPos.x && y === blockerPos.y) {
            return [blocker];
          }
          if (type === LOOK_POWER_CREEPS && x === powerCreepPos.x && y === powerCreepPos.y) {
            return [powerCreepObj];
          }
          return [];
        },
      });
      const makeRoom = (name: string, terrain: (x: number, y: number) => string) =>
        ({ name, getPositionAt: (x: number, y: number) => makePos(x, y, terrain) }) as unknown as Room;
      const makeSpawningSpawn = (name: string, room: Room, remainingTime = 0) =>
        ({
          name,
          room,
          spawning: { name: "incoming", remainingTime },
          pos: makePos(25, 25),
          memory: { spawnList: ["queued"] },
          spawnCreep: jest.fn(),
        }) as unknown as StructureSpawn;

      // 默认 spawn：出生位 = spawn 8 邻格（spawn 自身格不可落 creep）。
      // blocker 站在 RIGHT 邻格 (26,25)：其邻格中出生格外的第一个可走
      // 方向是 TOP_RIGHT (27,24)；powerCreep 站 TOP 邻格 (25,24) 同样
      // 挡位，让向出生格外的 TOP (25,23)。两者均收到 memory 指令。
      // 孵化中期（remainingTime > 0，未到落地 tick）不赶人——出生格
      // 在此期间仍可正常使用。边界 1（> 0 最近值）同样不触发。
      blockerPos.x = 26;
      const openRoom = makeRoom("E1N57", () => "plain");
      blockerRoom.room = openRoom;
      const midIncubationSpawn = makeSpawningSpawn("Spawn1", openRoom, 42);
      Object.setPrototypeOf(midIncubationSpawn, prototype);
      prototype.work.call(midIncubationSpawn);
      expect(blockerMove).not.toHaveBeenCalled();
      expect(blockerMemory._spawnYield).toBeUndefined();
      expect(powerCreepMove).not.toHaveBeenCalled();
      expect(powerCreepMemory._spawnYield).toBeUndefined();

      // 要落地的那一 tick（remainingTime=0）：向挡位者下达让位指令。
      blockerMove.mockClear();
      powerCreepMove.mockClear();
      const openSpawn = makeSpawningSpawn("Spawn1", openRoom);
      Object.setPrototypeOf(openSpawn, prototype);
      prototype.work.call(openSpawn);
      expect(blockerMove).toHaveBeenCalledWith(TOP_RIGHT);
      expect(blockerMemory._spawnYield).toEqual({ dir: TOP_RIGHT, tick: Game.time });
      expect(powerCreepMove).toHaveBeenCalledWith(TOP);
      expect(powerCreepMemory._spawnYield).toEqual({ dir: TOP, tick: Game.time });
      expect(openSpawn.spawnCreep).not.toHaveBeenCalled();

      // 敌方 creep.memory 在引擎中为 undefined，不能写让位指令。
      blockerMove.mockClear();
      blocker.my = false;
      Object.defineProperty(blocker, "memory", { configurable: true, get: () => undefined });
      expect(() => prototype.work.call(openSpawn)).not.toThrow();
      expect(blockerMove).not.toHaveBeenCalled();
      blocker.my = true;
      Object.defineProperty(blocker, "memory", { configurable: true, value: blockerMemory });

      // 配置在孵化期间改变时，挡位仍读取本次孵化的真实出口。
      blockerMove.mockClear();
      powerCreepMove.mockClear();
      Memory.cfg ??= {};
      Memory.cfg.rooms ??= {};
      const previousRoomConfig = Memory.cfg.rooms[openRoom.name];
      Memory.cfg.rooms[openRoom.name] = { spawnExitDirections: { Spawn1: [TOP] } };
      const nativeExitSpawn = makeSpawningSpawn("Spawn1", openRoom);
      nativeExitSpawn.spawning!.directions = [RIGHT];
      Object.setPrototypeOf(nativeExitSpawn, prototype);
      prototype.work.call(nativeExitSpawn);
      expect(blockerMove).toHaveBeenCalledWith(TOP);
      expect(powerCreepMove).not.toHaveBeenCalled();
      if (previousRoomConfig) Memory.cfg.rooms[openRoom.name] = previousRoomConfig;
      else delete Memory.cfg.rooms[openRoom.name];

      // 边界锁定：remainingTime=1（> 0 最近值）不触发；-0.4（小数 needTime
      // 落地 / 冻结期真实取值）触发——防止未来误改为 === 0 使冻结场景回归。
      blockerMove.mockClear();
      powerCreepMove.mockClear();
      const almostDueSpawn = makeSpawningSpawn("Spawn1", openRoom, 1);
      Object.setPrototypeOf(almostDueSpawn, prototype);
      prototype.work.call(almostDueSpawn);
      expect(blockerMove).not.toHaveBeenCalled();
      expect(powerCreepMove).not.toHaveBeenCalled();

      blockerMove.mockClear();
      powerCreepMove.mockClear();
      const fractionalDueSpawn = makeSpawningSpawn("Spawn1", openRoom, -0.4);
      Object.setPrototypeOf(fractionalDueSpawn, prototype);
      prototype.work.call(fractionalDueSpawn);
      expect(blockerMove).toHaveBeenCalledWith(TOP_RIGHT);
      expect(powerCreepMove).toHaveBeenCalledWith(TOP);

      // 默认 spawn：blocker 站在 spawn 自身格 (25,25) 不挡出生位；
      // powerCreep 仍挡 (25,24)，只让 powerCreep。
      blockerMove.mockClear();
      powerCreepMove.mockClear();
      blockerPos.x = 25;
      const centerSpawn = makeSpawningSpawn("Spawn1", openRoom);
      Object.setPrototypeOf(centerSpawn, prototype);
      prototype.work.call(centerSpawn);
      expect(blockerMove).not.toHaveBeenCalled();
      expect(powerCreepMove).toHaveBeenCalledWith(TOP);

      // Spawn20：出生位 = TOP 邻格 (25,24)；blocker 与 powerCreep 同在
      // 出生位上，其 TOP (25,23) 为墙，其余邻格可走 → 两者都让向
      // TOP_RIGHT（不会推回出生位）。
      blockerMove.mockClear();
      powerCreepMove.mockClear();
      blockerPos.y = 24;
      const spawn20Room = makeRoom("E5N59", (x, y) => (y === 23 && x === 25 ? "wall" : "plain"));
      blockerRoom.room = spawn20Room;
      const spawn20 = makeSpawningSpawn("Spawn20", spawn20Room);
      Object.setPrototypeOf(spawn20, prototype);
      prototype.work.call(spawn20);
      expect(blockerMove).toHaveBeenCalledWith(TOP_RIGHT);
      expect(powerCreepMove).toHaveBeenCalledWith(TOP_RIGHT);

      // Spawn20：出生位四周全墙 → 不发指令。
      blockerMove.mockClear();
      powerCreepMove.mockClear();
      const walledSpawn20Room = makeRoom(
        "E5N59",
        (x, y) => (y === 25 || (y === 24 && (x === 24 || x === 26)) || y === 23) ? "wall" : "plain",
      );
      blockerRoom.room = walledSpawn20Room;
      const walledSpawn20 = makeSpawningSpawn("Spawn20", walledSpawn20Room);
      Object.setPrototypeOf(walledSpawn20, prototype);
      prototype.work.call(walledSpawn20);
      expect(blockerMove).not.toHaveBeenCalled();
      expect(powerCreepMove).not.toHaveBeenCalled();
    }
  });
});
