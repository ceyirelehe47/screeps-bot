jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureSampledCpuPhase: (_label: string, fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
  measureCreepDecision: (fn: () => any) => fn(),
  isPerCreepPhaseTimingEnabled: () => false,
  measureCpuPhase: (_phase: string, fn: () => any) => fn(),
}));

jest.mock("@/roles", () => ({
  roleRegistry: {
    powerBankHauler: (...args: string[]) => {
      const actual = jest.requireActual("@/roles/powerBankHauler") as typeof import("@/roles/powerBankHauler");
      return actual.powerBankHaulerRole(...args);
    },
  },
}));

import { powerBankHaulerRole } from "@/roles/powerBankHauler";
import { getPowerBankEncodedRouteBetween } from "@/roles/powerBankCombatPair";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearRoleLifecycleCacheForTest, mountCreep } from "@/mount/mountCreep";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const SOURCE_ROOM = "W1N1";
const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_POS = { x: 25, y: 25 };

function setupTask(
  status: PowerBankHarvestStatus = "hauling",
  overrides: Partial<PowerBankHarvestTask> = {},
): PowerBankHarvestTask {
  const task: PowerBankHarvestTask = {
    id: TASK_ID,
    status,
    sourceRoom: SOURCE_ROOM,
    targetRoom: TARGET_ROOM,
    bankId: "pb-0",
    bankPos: BANK_POS,
    hits: 2_000_000,
    power: 5000,
    ticksToDecay: 5000,
    freeTiles: 8,
    discoveredTick: 100,
    lastSeenTick: 100,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
    ...overrides,
  };
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.powerBankHarvest) Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvest![TASK_ID] = task;
  return task;
}

function createHauler(overrides: {
  roomName?: string;
  x?: number;
  y?: number;
  store?: Record<string, number>;
  carryCapacity?: number;
}): Creep {
  return createMockPowerBankCreep("powerBankHauler", {
    roomName: overrides.roomName ?? TARGET_ROOM,
    x: overrides.x ?? 20,
    y: overrides.y ?? 20,
    store: overrides.store ?? {},
    carryCapacity: overrides.carryCapacity ?? 1600,
    memory: { role: "powerBankHauler", taskId: TASK_ID, configName: `${SOURCE_ROOM}:powerbank:${TARGET_ROOM}:hauler:0` } as Partial<CreepMemory>,
  });
}

function createDeliveryRoom(
  roomName: string,
  options: {
    terminalFree?: number;
    storageFree?: number;
    hostile?: boolean;
  } = {},
): Room {
  const capacity = 10_000;
  const makeStructure = (
    kind: typeof STRUCTURE_TERMINAL | typeof STRUCTURE_STORAGE,
    free: number | undefined,
  ): StructureTerminal | StructureStorage | undefined => {
    if (free === undefined) return undefined;
    return {
      id: `${roomName}-${kind}` as Id<StructureTerminal | StructureStorage>,
      structureType: kind,
      pos: new MockPos(20, 20, roomName) as unknown as RoomPosition,
      store: createMockStore({ [RESOURCE_POWER]: capacity - free }, capacity),
    } as unknown as StructureTerminal | StructureStorage;
  };

  const hostile = { id: `${roomName}-hostile` } as Creep;
  return {
    name: roomName,
    controller: { my: true } as StructureController,
    terminal: makeStructure(STRUCTURE_TERMINAL, options.terminalFree) as StructureTerminal | undefined,
    storage: makeStructure(STRUCTURE_STORAGE, options.storageFree) as StructureStorage | undefined,
    find: jest.fn((constant: FindConstant) => {
      if (constant === FIND_HOSTILE_CREEPS) return options.hostile ? [hostile] : [];
      return [];
    }),
  } as unknown as Room;
}

describe("powerBankHaulerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Memory as any).data = {};
    Game.creeps = {} as Record<string, Creep>;
    Game.rooms = {} as Record<string, Room>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Game.map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) } as unknown as RoomTerrain)),
      findRoute: jest.fn(() => [{ exit: RIGHT, room: SOURCE_ROOM }]),
    } as unknown as GameMap;
    (global as typeof global & { RoomPosition: typeof MockPos }).RoomPosition = MockPos;
    delete (global as any).__runtimeServices;
    clearCreepMovementStateForTest();
    clearRoleLifecycleCacheForTest();
  });

  describe("wait at safe range while bank alive", () => {

    it("moves to power bank vicinity before attacking starts", () => {
      setupTask("travelling");
      const hauler = createHauler({ roomName: TARGET_ROOM, x: 10, y: 10 });

      const role = powerBankHaulerRole(TARGET_ROOM);
      const result = role.source(hauler);

      expect(moveToTarget).toHaveBeenCalledWith(
        hauler,
        expect.objectContaining({ roomName: TARGET_ROOM }),
        0,
        expect.objectContaining({ reusePath: 10, ignoreCreeps: true, avoidExitTiles: true }),
      );
      expect(result).toBe(false);
    });
  });

  describe("安全备用投递房", () => {
    it("原来源 terminal 和 storage 满载时前往 TTL 内可达的安全己方备用房", () => {
      const task = setupTask("hauling");
      Game.rooms[SOURCE_ROOM] = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 0, storageFree: 0 });
      const alternateRoom = createDeliveryRoom("W2N1", { terminalFree: 5000 });
      Game.rooms[alternateRoom.name] = alternateRoom;
      const hauler = createHauler({
        roomName: TARGET_ROOM,
        store: { [RESOURCE_POWER]: 600 },
        carryCapacity: 1000,
      });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 500;

      const role = powerBankHaulerRole(TARGET_ROOM);
      expect(role.target(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        alternateRoom.name,
        undefined,
        expect.objectContaining({ profile: "travel", reusePath: 10 }),
      );

      hauler.room = alternateRoom;
      hauler.pos = new MockPos(20, 19, alternateRoom.name) as unknown as RoomPosition;
      expect(role.target(hauler)).toBe(false);
      expect(hauler.transfer).toHaveBeenCalledWith(alternateRoom.terminal, RESOURCE_POWER, 600);
      expect(task.deliveredPower ?? 0).toBe(0);
      hauler.store[RESOURCE_POWER] = 0; Game.time += 1; role.target(hauler);
      expect(task.deliveredPower).toBe(600);
      expect((task as any).lastProgressAt).toBe(Game.time);
      expect((hauler.memory as any).powerBankDeliveryRoom).toBe(alternateRoom.name);
    });
  });

  describe("任务路线方向与第二趟搬运", () => {
    const routeSource = "E3N58";
    const middleRoom = "E3N59";
    const corridor = [routeSource, middleRoom, TARGET_ROOM];

    it.each([
      { label: "bank", currentRoom: TARGET_ROOM, expectedRoute: [TARGET_ROOM, middleRoom, routeSource].join("|") },
      { label: "middle room", currentRoom: middleRoom, expectedRoute: [middleRoom, routeSource].join("|") },
      { label: "outside the task corridor", currentRoom: "E4N59", expectedRoute: undefined },
    ])("returns cargo from $label without replaying the forward task route", ({ currentRoom, expectedRoute }) => {
      const task = setupTask("hauling", { sourceRoom: routeSource, routeRooms: [...corridor] });
      Game.rooms[routeSource] = createDeliveryRoom(routeSource, { terminalFree: 1000 });
      const hauler = createHauler({ roomName: currentRoom, store: { [RESOURCE_POWER]: 100 } });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 1000;
      (Game.map.findRoute as jest.Mock).mockReturnValue([
        { exit: BOTTOM, room: middleRoom },
        { exit: BOTTOM, room: routeSource },
      ]);

      // 真实 role 的公共移动实参必须与目标方向一致；不只测试已正确的纯 helper。
      const role = powerBankHaulerRole(TARGET_ROOM, corridor.join("|"));
      expect(role.target(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledTimes(1);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler,
        routeSource,
        expectedRoute,
        expect.objectContaining({ profile: "travel", reusePath: 10, avoidRooms: [] }),
      );
      expect(hauler.transfer).not.toHaveBeenCalled();
      expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(100);
      expect((hauler.memory as CreepMemory & { taskId?: string }).taskId).toBe(TASK_ID);
      expect(task.routeRooms).toEqual(corridor);
    });

    it.each([
      { label: "bank", currentRoom: TARGET_ROOM, expectedRoute: [TARGET_ROOM, middleRoom, routeSource].join("|") },
      { label: "middle room", currentRoom: middleRoom, expectedRoute: [middleRoom, routeSource].join("|") },
      { label: "outside the task corridor", currentRoom: "E4N59", expectedRoute: undefined },
    ])("returns legacy cargo from $label using the encoded fallback direction", ({ currentRoom, expectedRoute }) => {
      const task = setupTask("hauling", { sourceRoom: routeSource });
      expect(task.routeRooms).toBeUndefined();
      Game.rooms[routeSource] = createDeliveryRoom(routeSource, { terminalFree: 1000 });
      const hauler = createHauler({ roomName: currentRoom, store: { [RESOURCE_POWER]: 100 } });
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 1000;

      const role = powerBankHaulerRole(TARGET_ROOM, corridor.join("|"));
      expect(role.target(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledTimes(1);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler, routeSource, expectedRoute, expect.objectContaining({ profile: "travel", avoidRooms: [] }),
      );
      expect(hauler.transfer).not.toHaveBeenCalled();
      expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(100);
      expect(task.routeRooms).toBeUndefined();
    });

    it.each([
      { label: "a visible source room", sourceVisible: true },
      { label: "a source room without vision", sourceVisible: false },
    ])("returns taskless cargo from the middle toward $label using the reversed role route", ({ sourceVisible }) => {
      setupTask("hauling", { sourceRoom: routeSource });
      const hauler = createHauler({ roomName: middleRoom, store: { [RESOURCE_POWER]: 100 } });
      hauler.memory.configName = `${routeSource}:powerbank:${TARGET_ROOM}:hauler:0`;
      hauler.memory.roleArgs = [TARGET_ROOM, corridor.join("|")];
      // 模拟 terminalCleanup 已释放任务绑定与记录，但保留载货和原 roleArgs。
      delete (hauler.memory as CreepMemory & { taskId?: string }).taskId;
      delete Memory.data!.powerBankHarvest![TASK_ID];
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 1000;
      if (sourceVisible) {
        Game.rooms[routeSource] = createDeliveryRoom(routeSource, { terminalFree: 1000 });
      }
      (Game.map.findRoute as jest.Mock).mockReturnValue([{ exit: TOP, room: routeSource }]);

      const role = powerBankHaulerRole(...hauler.memory.roleArgs);
      expect(role.source(hauler)).toBe(false);
      expect(moveToTargetRoom).toHaveBeenCalledTimes(1);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        hauler, routeSource, [middleRoom, routeSource].join("|"),
        expect.objectContaining({ profile: "travel", reusePath: 10, avoidRooms: [] }),
      );
      expect(hauler.transfer).not.toHaveBeenCalled();
      expect(hauler.suicide).not.toHaveBeenCalled();
      expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(100);
      expect((hauler.memory as CreepMemory & { taskId?: string }).taskId).toBeUndefined();
      expect(Memory.data!.powerBankHarvest![TASK_ID]).toBeUndefined();
      expect(hauler.memory.roleArgs).toEqual([TARGET_ROOM, corridor.join("|")]);
    });

    it("directs legacy fallback toward a combat partner without overriding a current task corridor", () => {
      const task = setupTask("travelling", { sourceRoom: routeSource });
      expect(getPowerBankEncodedRouteBetween(task, middleRoom, TARGET_ROOM, corridor.join("|")))
        .toBe([middleRoom, TARGET_ROOM].join("|"));
      expect(getPowerBankEncodedRouteBetween(task, "E4N59", TARGET_ROOM, corridor.join("|")))
        .toBeUndefined();
      expect(getPowerBankEncodedRouteBetween(task, middleRoom, "E5N60", corridor.join("|")))
        .toBeUndefined();
      expect(getPowerBankEncodedRouteBetween(task, middleRoom, TARGET_ROOM, ""))
        .toBeUndefined();
      task.routeRooms = [...corridor];
      expect(getPowerBankEncodedRouteBetween(task, TARGET_ROOM, routeSource, "E4N60|E5N60"))
        .toBe([TARGET_ROOM, middleRoom, routeSource].join("|"));
    });

    it("salvages power in an automatically searchable highway outside the former patrol list", () => {
      const roomName = "E0N61";
      const dropped = {
        id: "non-patrol-power" as Id<Resource>, resourceType: RESOURCE_POWER, amount: 100,
        pos: new MockPos(20, 20, roomName) as unknown as RoomPosition,
      } as Resource;
      const room = {
        name: roomName,
        find: jest.fn((constant: FindConstant) => constant === FIND_DROPPED_RESOURCES ? [dropped] : []),
      } as unknown as Room;
      const hauler = createHauler({ roomName, x: 20, y: 19, carryCapacity: 100 });
      hauler.room = room;
      (hauler.pickup as jest.Mock).mockImplementation((resource: Resource) => {
        expect(hauler.pos.isNearTo(resource)).toBe(true);
        return OK;
      });
      expect(powerBankHaulerRole(roomName).source(hauler)).toBe(false);
      expect(hauler.pickup).toHaveBeenCalledWith(dropped);
      expect(hauler.suicide).not.toHaveBeenCalled();
    });

    it("mounted work unloads, returns to the bank and really picks up a second load", () => {
      const task = setupTask("hauling", {
        sourceRoom: routeSource,
        routeRooms: [...corridor],
        power: 200,
        deliveredPower: 0,
      });
      const sourceRoom = createDeliveryRoom(routeSource, { terminalFree: 1000 });
      const terminal = sourceRoom.terminal as StructureTerminal;
      const initialPower = terminal.store.getUsedCapacity(RESOURCE_POWER);
      const dropped = {
        id: "second-load-power" as Id<Resource>,
        resourceType: RESOURCE_POWER,
        amount: 100,
        pos: new MockPos(BANK_POS.x, BANK_POS.y, TARGET_ROOM) as unknown as RoomPosition,
      };
      const bankRoom = {
        name: TARGET_ROOM,
        find: jest.fn((constant: FindConstant) =>
          constant === FIND_DROPPED_RESOURCES && dropped.amount > 0 ? [dropped] : []),
      } as unknown as Room;
      const transitRoom = { name: middleRoom, find: jest.fn(() => []) } as unknown as Room;
      Game.rooms = { [routeSource]: sourceRoom, [middleRoom]: transitRoom, [TARGET_ROOM]: bankRoom };
      const hauler = createHauler({ roomName: routeSource, store: { [RESOURCE_POWER]: 100 }, carryCapacity: 100 });
      hauler.room = sourceRoom;
      hauler.pos = new MockPos(20, 19, routeSource) as unknown as RoomPosition;
      hauler.memory.ready = true;
      hauler.memory.working = true;
      // config 不存在时 mount 必须得到真实 targetRoom，否则旧源会绕过出错分支而假绿灯。
      hauler.memory.roleArgs = [TARGET_ROOM, corridor.join("|")];
      (hauler as Creep & { ticksToLive: number }).ticksToLive = 1200;
      Game.creeps[hauler.name] = hauler;
      let transferIntent: { target: StructureTerminal; amount: number } | undefined;
      let pickupIntent: Resource | undefined;
      (hauler.transfer as jest.Mock).mockImplementation((target: StructureTerminal, resource: ResourceConstant, amount: number) => {
        expect(target).toBe(terminal);
        expect(resource).toBe(RESOURCE_POWER);
        expect(hauler.pos.isNearTo(target)).toBe(true);
        transferIntent = { target, amount };
        return OK;
      });
      (hauler.pickup as jest.Mock).mockImplementation((resource: Resource) => {
        expect(resource).toBe(dropped);
        expect(hauler.pos.isNearTo(resource)).toBe(true);
        pickupIntent = resource;
        return OK;
      });
      const advanceTick = (): void => {
        // 意图成功时当前 Store 不变；仅在提交后的下一 tick 暴露真实持有量。
        if (transferIntent) {
          hauler.store[RESOURCE_POWER] -= transferIntent.amount;
          transferIntent.target.store[RESOURCE_POWER] += transferIntent.amount;
          transferIntent = undefined;
        }
        if (pickupIntent) {
          const amount = Math.min(pickupIntent.amount, hauler.store.getFreeCapacity(RESOURCE_POWER));
          hauler.store[RESOURCE_POWER] += amount;
          dropped.amount -= amount;
          pickupIntent = undefined;
        }
        Game.time += 1;
      };
      const arrive = (room: Room): void => {
        hauler.room = room;
        hauler.pos = new MockPos(
          room === bankRoom ? BANK_POS.x : 20,
          room === bankRoom ? BANK_POS.y - 1 : 19,
          room.name,
        ) as unknown as RoomPosition;
      };
      const creepGlobal = global as unknown as { Creep?: typeof Creep };
      const previousCreep = creepGlobal.Creep;
      class MountedCreepMock {}
      creepGlobal.Creep = MountedCreepMock as unknown as typeof Creep;
      mountCreep();
      Object.setPrototypeOf(hauler, Creep.prototype);
      try {
        hauler.work();
        expect(hauler.transfer).toHaveBeenCalledWith(terminal, RESOURCE_POWER, 100);
        expect(hauler.memory.working).toBe(true);
        expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(100);
        expect(hauler.pickup).not.toHaveBeenCalled();
        advanceTick();

        hauler.work();
        expect(moveToTargetRoom).toHaveBeenLastCalledWith(
          hauler, TARGET_ROOM, corridor.join("|"), expect.objectContaining({ profile: "travel" }),
        );
        expect(hauler.memory.working).toBe(true);
        expect(hauler.pickup).not.toHaveBeenCalled();
        advanceTick();
        arrive(transitRoom);
        hauler.work();
        expect(hauler.pickup).not.toHaveBeenCalled();
        advanceTick();
        arrive(bankRoom);

        // 只调用真实 mount；旧 target 返回 false 会停在 working，永远不调用 source.pickup。
        hauler.work();
        expect(hauler.memory.working).toBe(false);
        expect(hauler.pickup).toHaveBeenCalledTimes(1);
        expect(hauler.pickup).toHaveBeenCalledWith(dropped);
        expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(0);
        expect(hauler.suicide).not.toHaveBeenCalled();
        advanceTick();
        expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(100);
        expect(dropped.amount).toBe(0);

        hauler.work();
        expect(hauler.memory.working).toBe(true);
        expect(hauler.pickup).toHaveBeenCalledTimes(1);
        advanceTick();
        arrive(sourceRoom);
        hauler.work();
        expect(hauler.transfer).toHaveBeenCalledTimes(2);
        expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(100);
        advanceTick();
        expect(hauler.store.getUsedCapacity(RESOURCE_POWER)).toBe(0);
        expect(terminal.store.getUsedCapacity(RESOURCE_POWER) - initialPower).toBe(200);
        expect(task.deliveredPower).toBe(100); // 最后一批还需由角色确认下一帧 cargo。
        hauler.work();
        expect(task.deliveredPower).toBe(200);
        expect((hauler.memory as CreepMemory & { taskId?: string }).taskId).toBe(TASK_ID);
      } finally {
        if (previousCreep === undefined) {
          delete creepGlobal.Creep;
        } else {
          creepGlobal.Creep = previousCreep;
        }
        clearRoleLifecycleCacheForTest();
      }
    });
  });
it("transfer OK 但下一 tick cargo 不变不会记交付，同 tick 也不重复提交", () => {
  const task = setupTask("hauling", { deliveredPower: 0 }); Game.time = 100;
  const home = createDeliveryRoom(SOURCE_ROOM, { terminalFree: 5000 }); Game.rooms[SOURCE_ROOM] = home;
  const hauler = createHauler({ roomName: SOURCE_ROOM, store: { [RESOURCE_POWER]: 500 } });
  hauler.room = home; hauler.pos = new MockPos(20, 19, SOURCE_ROOM) as unknown as RoomPosition;
  const role = powerBankHaulerRole(TARGET_ROOM);
  role.target(hauler); role.target(hauler);
  expect(hauler.transfer).toHaveBeenCalledTimes(1); expect(task.deliveredPower).toBe(0);
  Game.time++; role.target(hauler);
  expect(hauler.transfer).toHaveBeenCalledTimes(2); expect(task.deliveredPower).toBe(0);
  hauler.store[RESOURCE_POWER] = 0; Game.time++; role.target(hauler); role.target(hauler);
  expect(task.deliveredPower).toBe(500);
});


});
