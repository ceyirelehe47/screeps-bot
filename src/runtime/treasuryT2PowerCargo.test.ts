jest.mock("@/movement/pathing", () => ({
  moveToTarget: jest.fn(),
}));

import * as runtimeServices from "@/runtime/runtimeServices";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import {
  enqueuePowerCreepTask,
  listPowerCreepTasks,
  resetPowerCreepControlCacheForTest,
  runPowerCreepControl,
} from "@/runtime/powerCreepControl";
import { armTreasuryT2FirstLive, readTreasuryT2FirstLiveControl } from "@/runtime/treasuryT2FirstLiveControl";
import { hasTerminalCargoEffectThisTick } from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import {
  beginTreasuryProductionTick,
  endTreasuryProductionTick,
  registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask,
} from "@/runtime/treasuryTerminalTransfer";
import {
  applyT2Stores,
  initializeT2,
  t2Ledger,
  t2Receipt,
  T2_SOURCE,
  T2_TARGET,
} from "../../test/treasuryT2Fixture";

function powerPos(roomName: string): RoomPosition {
  return { x: 20, y: 20, roomName, getRangeTo: () => 1 } as unknown as RoomPosition;
}

/** Only the native engine action is stubbed; the active task scheduler and T2 flow remain real. */
function installOperateExtension(room: Room, storageEnergy = 0): PowerCreep {
  Object.assign(room.controller!, { isPowerEnabled: true });
  Object.assign(room.storage!, {
    room,
    structureType: STRUCTURE_STORAGE,
    pos: powerPos(room.name),
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_ENERGY ? storageEnergy : 0,
      getFreeCapacity: () => 1_000_000 - storageEnergy,
      getCapacity: () => 1_000_000,
    },
  });
  Object.assign(room.terminal!, { pos: powerPos(room.name) });
  // Empty Storage still has ample ordinary Terminal reserve plus both transfer fees.
  (room.terminal!.store as unknown as Record<string, number>).energy = 100_000;
  const extension = {
    id: `${room.name}-extension`,
    structureType: STRUCTURE_EXTENSION,
    store: { getUsedCapacity: () => 0, getFreeCapacity: () => 50, getCapacity: () => 50 },
  } as unknown as StructureExtension;
  const powerSpawn = {
    id: `${room.name}-power-spawn`,
    my: true,
    structureType: STRUCTURE_POWER_SPAWN,
    pos: powerPos(room.name),
    store: { getUsedCapacity: () => 0, getFreeCapacity: () => 5_100, getCapacity: () => 5_100 },
  } as unknown as StructurePowerSpawn;
  room.find = jest.fn((type: FindConstant, options?: { filter?: (structure: AnyStoreStructure) => boolean }) => {
    const structures = type === FIND_MY_STRUCTURES ? [powerSpawn, extension]
      : type === FIND_STRUCTURES ? [room.storage!, room.terminal!, powerSpawn, extension] : [];
    return options?.filter ? structures.filter(options.filter) : structures;
  }) as Room["find"];
  const powerCreep = {
    name: room.name,
    memory: { homeRoom: room.name },
    room,
    pos: powerPos(room.name),
    ticksToLive: 1_000,
    powers: { [PWR_OPERATE_EXTENSION]: { level: 1, cooldown: 0 } },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_OPS || resource === undefined ? 20 : 0,
      getFreeCapacity: () => 80,
      getCapacity: () => 100,
    },
    usePower: jest.fn(() => OK),
    spawn: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
  } as unknown as PowerCreep;
  Game.powerCreeps = { [powerCreep.name]: powerCreep };
  // Start with a real existing task, so held execution must preserve its identity.
  enqueuePowerCreepTask(powerCreep, "operate_extension", (storageEnergy > 0 ? room.storage! : room.terminal!).id);
  powerCreep.memory.tasks![0].createdAt = Game.time - 1;
  return powerCreep;
}

describe("T2 active PowerCreep terminal energy cargo", () => {
  let context: ReturnType<typeof initializeT2>;
  let serviceSpy: jest.SpyInstance;

  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    resetPowerCreepControlCacheForTest();
    clearCreepMovementStateForTest();
    clearMarketSaleExposureReservationsForTest();
    context = initializeT2();
    Memory.powerCreeps = {};
    Game.powerCreeps = {};
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(context.treasury);
  });
  afterEach(() => { endTreasuryProductionTick(); serviceSpy.mockRestore(); });

  function arm(): void {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt)).toEqual({ ok: true, reason: "armed" });
  }

  function runT2(): void {
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target, [context.task]), true, jest.fn());
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect((context.source.terminal!.send as jest.Mock).mock.calls[0].slice(0, 3))
      .toEqual([RESOURCE_UTRIUM_HYDRIDE, 100, T2_TARGET]);
  }

  function confirmAndRelease(): void {
    const receipt = t2Receipt(context.source, context.target, "T2-power-cargo-confirmed");
    endTreasuryProductionTick();
    applyT2Stores(context.source, context.target);
    Game.market.incomingTransactions = [receipt];
    Game.market.outgoingTransactions = [receipt];
    for (let tick = 0; tick < 16; tick += 1) {
      Game.time += 1;
      beginTreasuryProductionTick();
      endTreasuryProductionTick();
      if (!hasTreasuryTerminalFence(T2_SOURCE) && !hasTreasuryTerminalFence(T2_TARGET)) break;
    }
    const canonicalTask = Memory.data!.resourceControl!.tasks[context.task.id] as ResourceTransferTask;
    expect(canonicalTask.remainingAmount).toBe(1_615);
    expect(canonicalTask.treasurySlice).toBeUndefined();
    expect(hasTreasuryTerminalFence(T2_SOURCE)).toBe(false);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  }

  it.each([T2_SOURCE, T2_TARGET])("held T2 preserves %s terminal fallback task through a real send and settlement", (roomName) => {
    const room = Game.rooms[roomName];
    const powerCreep = installOperateExtension(room);
    const initialTask = { ...listPowerCreepTasks(powerCreep)[0] };
    const terminalEnergy = room.terminal!.store.getUsedCapacity(RESOURCE_ENERGY);
    arm();
    runPowerCreepControl();
    expect(powerCreep.usePower).not.toHaveBeenCalled();
    expect(listPowerCreepTasks(powerCreep)).toEqual([initialTask]);
    expect(room.terminal!.store.getUsedCapacity(RESOURCE_ENERGY)).toBe(terminalEnergy);
    runT2();
    runPowerCreepControl();
    expect(powerCreep.usePower).not.toHaveBeenCalled();
    expect(listPowerCreepTasks(powerCreep)).toEqual([initialTask]);
    expect(context.task.remainingAmount).toBe(1_715);
    confirmAndRelease();
    Game.time += 1;
    runPowerCreepControl();
    expect(powerCreep.usePower).toHaveBeenCalledTimes(1);
    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_OPERATE_EXTENSION, room.terminal);
    expect(listPowerCreepTasks(powerCreep)).toEqual([]);
  });

  const ordinaryCases = [T2_SOURCE, T2_TARGET].flatMap((roomName) =>
    (["OK", "throw", "malformed"] as const).map((outcome) => [roomName, outcome] as const));
  it.each(ordinaryCases)("ordinary %s terminal operate_extension %s prevents same-tick T2 arm", (roomName, outcome) => {
    const room = Game.rooms[roomName];
    const powerCreep = installOperateExtension(room);
    const initialTask = { ...listPowerCreepTasks(powerCreep)[0] };
    const beforeEnergy = room.terminal!.store.getUsedCapacity(RESOURCE_ENERGY);
    (powerCreep.usePower as jest.Mock).mockImplementation(() => {
      if (outcome !== "OK") {
        // Uncertain invocation can have a real Store effect despite its missing result.
        (room.terminal!.store as unknown as Record<string, number>).energy -= 50;
      }
      if (outcome === "throw") throw new Error("unknown native power result");
      return outcome === "malformed" ? undefined : OK;
    });
    if (outcome === "throw") expect(() => runPowerCreepControl()).toThrow("unknown native power result");
    else expect(() => runPowerCreepControl()).not.toThrow();
    expect(powerCreep.usePower).toHaveBeenCalledTimes(1);
    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_OPERATE_EXTENSION, room.terminal);
    expect(room.terminal!.store.getUsedCapacity(RESOURCE_ENERGY))
      .toBe(beforeEnergy - (outcome === "OK" ? 0 : 50));
    expect(hasTerminalCargoEffectThisTick(roomName)).toBe(true);
    expect(listPowerCreepTasks(powerCreep)).toEqual(outcome === "OK" ? [] : [initialTask]);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt))
      .toEqual({ ok: false, reason: "terminal_action_this_tick" });
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
    expect(beginTreasuryProductionTick()).toBe(false);
    expect(runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target, [context.task]), true, jest.fn()))
      .toEqual({ handled: false });
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(context.task.remainingAmount).toBe(1_715);
    expect(context.task.treasurySlice).toBeUndefined();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toBeUndefined();
  });

  const storageCases = [T2_SOURCE, T2_TARGET].flatMap((roomName) =>
    (["ordinary-first", "T2-first"] as const).map((order) => [roomName, order] as const));
  it.each(storageCases)("%s nonterminal storage operate_extension remains runnable with %s", (roomName, order) => {
    const room = Game.rooms[roomName];
    const powerCreep = installOperateExtension(room, 1_000);
    if (order === "T2-first") { arm(); runT2(); }
    runPowerCreepControl();
    expect(powerCreep.usePower).toHaveBeenCalledTimes(1);
    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_OPERATE_EXTENSION, room.storage);
    expect(listPowerCreepTasks(powerCreep)).toEqual([]);
    expect(hasTerminalCargoEffectThisTick(roomName)).toBe(false);
    if (order === "ordinary-first") { arm(); runT2(); }
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  });
});
