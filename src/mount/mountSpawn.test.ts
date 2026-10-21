import { registerSpawnRequestOwners } from "@/runtime/registerSpawnRequestOwners";
registerSpawnRequestOwners();
import { registerOutboundMissionOwners } from "@/runtime/registerOutboundMissionOwners";
registerOutboundMissionOwners();
jest.mock("@/runtime/tickContext", () => ({
  ...jest.requireActual("@/runtime/tickContext"),
  isSpawnActive: jest.fn(() => true),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  recordFixedCpuAction: jest.fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

import { mountSpawn } from "@/mount/mountSpawn";
import { DEPOSIT_BODY } from "@/runtime/depositViability";
import { type DepositHarvestTask } from "@/runtime/depositHarvest";
import { releaseWarTaskOwner } from "@/runtime/warControl";
import { RCL8_UPGRADER_MAINTENANCE_BODY, RCL8_UPGRADER_RECOVERY_START_TICKS } from "@/runtime/upgraderPolicy";

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

  it("紧急 carrier 等在忙碌 spawn 时，空闲 spawn 仍可执行本地请求", () => {
    const room = { name: "W1N1", energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const emergency = `W1N1:manual:maxcarrier:${Game.time}`;
    const worker = "W1N1:worker:0";
    Memory.data!.creepConfigs![emergency] = { role: "carrier", roomName: room.name, args: [], body: [CARRY, MOVE] };
    Memory.data!.creepConfigs![worker] = { role: "worker", roomName: room.name, args: [], body: [WORK, CARRY, MOVE] };
    const busy = createSpawn("Busy", room, [emergency]);
    busy.spawning = { name: "old", remainingTime: 100 } as Spawning;
    const idle = createSpawn("Idle", room, [worker]);
    Game.spawns = { Busy: busy, Idle: idle }; Game.rooms = { W1N1: room }; Game.flags = {};
    Object.setPrototypeOf(idle, prototype); prototype.work.call(idle);
    expect(idle.spawnCreep).toHaveBeenCalledWith([WORK, CARRY, MOVE], expect.any(String), expect.any(Object));
  });

  it("deposit fresh 门未通过时保留请求，允许后面的 worker 出生", () => {
    const room = { name: "W1N1", energyAvailable: 3000, energyCapacityAvailable: 3000 } as Room;
    const deposit = "W1N1:deposit:d:g0", worker = "W1N1:worker:0";
    Memory.data!.depositHarvest = { d: { id: "d", sourceRoom: room.name, status: "spawning", generation: 0,
      configName: deposit, spawnReadyAt: Game.time - 1 } as DepositHarvestTask };
    Memory.data!.creepConfigs![deposit] = { role: "depositHarvester", roomName: room.name, args: ["d", room.name],
      taskId: "d", spawnOnce: {}, body: [...DEPOSIT_BODY] };
    Memory.data!.creepConfigs![worker] = { role: "worker", roomName: room.name, args: [], body: [WORK, CARRY, MOVE] };
    const spawn = createSpawn("Spawn1", room, [deposit, worker]);
    Game.spawns = { Spawn1: spawn }; Game.rooms = { W1N1: room }; Game.flags = {};
    Object.setPrototypeOf(spawn, prototype); prototype.work.call(spawn);
    expect((spawn.spawnCreep as jest.Mock).mock.calls[0][2].memory.configName).toBe(worker);
    expect(spawn.memory.spawnList).toEqual([deposit]);
  });

  it("超容量固定队首被移出并留下诊断，同 tick 后续可支付单位出生", () => {
    const room = { name: "W1N1", energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const blocked = "W1N1:colonizationSupport:W2N2:upgrader", worker = "W1N1:worker:0";
    Memory.data!.creepConfigs![blocked] = { role: "colonizerUpgrader", roomName: room.name, args: [], body: [HEAL, HEAL, MOVE] };
    Memory.data!.creepConfigs![worker] = { role: "worker", roomName: room.name, args: [], body: [WORK, CARRY, MOVE] };
    const spawn = createSpawn("Spawn1", room, [blocked, worker]);
    Game.rooms = { W1N1: room }; Game.spawns = { Spawn1: spawn }; Game.flags = {};
    Object.setPrototypeOf(spawn, prototype);
    prototype.work.call(spawn);
    expect(spawn.spawnCreep).toHaveBeenCalledWith([WORK, CARRY, MOVE], expect.any(String), expect.any(Object));
    expect(spawn.memory.spawnList).toEqual([]);
    expect(spawn.memory._lastSpawnFail).toMatchObject({ configName: blocked, bodyCost: 550, roomEnergyCapacityAvailable: 300 });
  });

  it.each(["powerBankAttacker", "powerBankHealer", "powerBankHauler"] as const)("RESERVE 下已启动 PB 的 %s 不被队首清理丢弃", role => {
    const room = { name: "W1N1", energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const name = `W1N1:powerbank:W2N2:${role}`;
    Memory.data!.powerBankHarvest = { bank: { id: "bank", sourceRoom: room.name, targetRoom: "W2N2", status: "spawning" } as PowerBankHarvestTask };
    Memory.data!.creepConfigs![name] = { role, roomName: room.name, args: ["W2N2"], taskId: "bank", body: [MOVE] };
    Game.flags = { RESERVE: { name: "RESERVE", pos: { roomName: room.name } } as Flag };
    const spawn = createSpawn("Spawn1", room, [name]);
    Game.rooms = { W1N1: room }; Game.spawns = { Spawn1: spawn };
    Object.setPrototypeOf(spawn, prototype);
    prototype.work.call(spawn);
    expect(spawn.spawnCreep).toHaveBeenCalledWith([MOVE], expect.any(String), expect.objectContaining({ memory: expect.objectContaining({ configName: name }) }));
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("RESERVE 下已出生 attacker 的 healer 搭档不会被队首清理", () => {
    const room = { name: "W1N1", energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const red = "W1N1:war:W2N2:g1:meleeAttacker:0", green = "W1N1:war:W2N2:g1:healer:0";
    Memory.data!.war = { W2N2: { targetRoom: "W2N2", sourceRoom: room.name, status: "clearing", reason: "manual", attempts: 1,
      createdAt: Game.time, updatedAt: Game.time, members: { [red]: { configName: red, creepNames: ["red"], spawnedAt: Game.time - 1 } },
      activeGeneration: { id: 1, phase: "assembling", createdAt: Game.time - 1, boostTaskId: "boost",
        configNames: { meleeAttacker: red, healer: green } } } };
    Memory.data!.creepConfigs![green] = { role: "healer", roomName: room.name, args: ["W2N2"], body: [HEAL, MOVE] };
    Game.flags = { RESERVE: { name: "RESERVE", pos: { roomName: room.name } } as Flag };
    const spawn = createSpawn("Spawn1", room, [green]);
    Game.rooms = { W1N1: room }; Game.spawns = { Spawn1: spawn };
    Object.setPrototypeOf(spawn, prototype); prototype.work.call(spawn);
    expect(spawn.spawnCreep).toHaveBeenCalledWith([HEAL, MOVE], expect.any(String), expect.objectContaining({ memory: expect.objectContaining({ configName: green }) }));
  });
  it("RESERVE 下已受理 deposit 保留孵化资格，仍须当 tick fresh 路径门通过", () => {
    const room = { name: "W1N1", energyAvailable: 3000, energyCapacityAvailable: 3000 } as Room;
    const name = "W1N1:deposit:d:g0";
    const task = { id: "d", sourceRoom: room.name, status: "spawning", generation: 0, configName: name, spawnReadyAt: Game.time } as DepositHarvestTask;
    Memory.data!.depositHarvest = { d: task };
    Memory.data!.creepConfigs![name] = { role: "depositHarvester", roomName: room.name, args: ["d", room.name], taskId: "d", spawnOnce: {}, body: [...DEPOSIT_BODY] };
    Game.flags = { RESERVE: { name: "RESERVE", pos: { roomName: room.name } } as Flag };
    const spawn = createSpawn("Spawn1", room, [name]);
    Game.rooms = { W1N1: room }; Game.spawns = { Spawn1: spawn };
    Object.setPrototypeOf(spawn, prototype); prototype.work.call(spawn);
    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    (spawn.spawnCreep as jest.Mock).mockClear();
    Game.time++; spawn.memory.spawnList = [name]; prototype.work.call(spawn);
    expect(spawn.spawnCreep).not.toHaveBeenCalled();
  });
  it("战争孵化接受后同 tick 停止任务，尚未进入 Game.creeps 的 Memory 也会解绑", () => {
    const room = { name: "E1N57", controller: { my: true, level: 8 }, energyAvailable: 300, energyCapacityAvailable: 300 } as unknown as Room;
    const name = "E1N57:war:E3N57:meleeAttacker:0";
    Memory.creeps = {};
    Memory.data!.war = { E3N57: { targetRoom: "E3N57", sourceRoom: room.name, status: "clearing", reason: "manual", attempts: 1,
      createdAt: Game.time, updatedAt: Game.time, membersVersion: 1, members: {} } };
    Memory.data!.creepConfigs![name] = { role: "meleeAttacker", name: "war-born", roomName: room.name, args: ["E3N57"], body: [ATTACK, MOVE] };
    const spawn = createSpawn("Spawn1", room, []); Game.rooms = { E1N57: room }; Game.spawns = { Spawn1: spawn };
    (spawn.spawnCreep as jest.Mock).mockImplementation((_body, creepName, options) => { Memory.creeps[creepName] = options.memory; return OK; });
    Object.setPrototypeOf(spawn, prototype);
    expect((spawn as unknown as { mainSpawn(config: string): boolean }).mainSpawn(name)).toBe(true);
    expect(Game.creeps["war-born"]).toBeUndefined();
    expect(Memory.data!.war!.E3N57.members?.[name].creepNames).toContain("war-born");
    expect(releaseWarTaskOwner("E3N57")).toMatchObject({ ok: true, removedTask: true });
    expect(Memory.creeps["war-born"]).toMatchObject({ _warDetached: true, roleArgs: ["E3N57"] });
    expect(Memory.creeps["war-born"].configName).toBeUndefined();
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
      const makeSpawningSpawn = (name: string, room: Room, remainingTime = 0) => {
        // 各孵化出口场景是独立帧，不能沿用上一个场景已受理的移动收据。
        Game.time++;
        return ({
          name,
          room,
          spawning: { name: "incoming", remainingTime },
          pos: makePos(25, 25),
          memory: { spawnList: ["queued"] },
          spawnCreep: jest.fn(),
        }) as unknown as StructureSpawn;
      };

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
