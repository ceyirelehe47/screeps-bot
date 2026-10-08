jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((action: () => ScreepsReturnCode) => action()),
}));
jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedSourceContainerPos: jest.fn(),
}));

import { colonizerHarvesterRole } from "@/roles/colonizerHarvester";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";

const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;
const mockedGetPlannedSourceContainerPos = getPlannedSourceContainerPos as jest.MockedFunction<typeof getPlannedSourceContainerPos>;

function createContainer(freeCapacity: number): StructureContainer {
  return {
    structureType: STRUCTURE_CONTAINER,
    store: {
      getFreeCapacity: jest.fn(() => freeCapacity),
    },
  } as unknown as StructureContainer;
}

function createPosition(
  x: number,
  y: number,
  structures: Structure[] = [],
  creeps: Creep[] = [],
): RoomPosition {
  return {
    x,
    y,
    roomName: "W1N0",
    lookFor: jest.fn((lookType: LookConstant) => {
      if (lookType === LOOK_STRUCTURES) return structures;
      if (lookType === LOOK_CREEPS) return creeps;
      return [];
    }),
    isEqualTo: jest.fn((target: RoomPosition) => target.x === x && target.y === y),
    inRangeTo: jest.fn((target: RoomPosition, range: number) =>
      Math.max(Math.abs(target.x - x), Math.abs(target.y - y)) <= range
    ),
  } as unknown as RoomPosition;
}

function createSource(workPos: RoomPosition): Source {
  return {
    id: "source-a" as Id<Source>,
    pos: {
      findInRange: jest.fn(() => []),
    },
    room: { name: workPos.roomName },
  } as unknown as Source;
}

function createCreep(roomName: string, pos: RoomPosition, carry = false): Creep {
  return {
    room: { name: roomName },
    memory: {},
    pos,
    body: [
      { type: WORK, hits: 100 },
      ...(carry ? [{ type: CARRY, hits: 100 }] : []),
    ],
    harvest: jest.fn(() => OK),
  } as unknown as Creep;
}

function bindSource(workPos: RoomPosition): Source {
  const source = createSource(workPos);
  Game.getObjectById = jest.fn(() => source) as typeof Game.getObjectById;
  mockedGetPlannedSourceContainerPos.mockReturnValue(workPos);
  return source;
}

describe("colonizerHarvesterRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.rooms = {};
    Memory.runtime = {};
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
  });
  it("交接完成的多余增援只前往新房Spawn回收，不再采矿", () => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    const creep = createCreep("W1N0", createPosition(10, 10));
    creep.memory.configName = "W1N1:colonizationSupport:W1N0:harvester:source-a:retiring:old";
    creep.memory._colonizationRetiring = "W1N0";
    const spawn = { name: "Local", room: creep.room, recycleCreep: jest.fn(() => ERR_NOT_IN_RANGE) } as unknown as StructureSpawn;
    Game.spawns = { Local: spawn };
    colonizerHarvesterRole("W1N0", "source-a").source!(creep);
    expect(spawn.recycleCreep).toHaveBeenCalledWith(creep);
    expect(moveToTarget).toHaveBeenCalledWith(creep, spawn, 1);
    expect(creep.harvest).not.toHaveBeenCalled();
  });
  it("持久增援的采矿许可解绑后停止采矿并按原路线返乡", () => {
    const creep = createCreep("W1N0", createPosition(10, 10));
    creep.memory.configName = "W1N1:colonizationSupport:W1N0:harvester:source-a";
    Memory.data = { creepConfigs: { [creep.memory.configName]: { role: "colonizerHarvester", args: ["W1N0", "source-a", "W1N1|W1N0"] } } };
    colonizerHarvesterRole("W1N0", "source-a", "W1N1|W1N0").source!(creep);
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", "W1N0|W1N1", expect.any(Object));
  });
  it.each([
    ["colonizationSupport", true],
    ["remoteMine", false],
  ] as const)("%s 己方工作位被占用且当前已能采矿时的站位策略", (kind, harvestHere) => {
    const workPos = createPosition(10, 10, [], [{ my: true } as Creep]);
    const creep = createCreep("W1N0", createPosition(12, 12));
    const source = bindSource(workPos);
    Object.assign(source.pos, { x: 11, y: 11, roomName: "W1N0" });
    creep.memory.configName = `W1N1:${kind}:W1N0:harvester:source-a`;
    Memory.data = { creepConfigs: { [creep.memory.configName]: { role: "colonizerHarvester", roomName: "W1N1", args: ["W1N0", "source-a"] } } };
    colonizerHarvesterRole("W1N0", "source-a").source!(creep);
    if (harvestHere) {
      expect(creep.harvest).toHaveBeenCalledWith(source);
      expect(mockedMoveToTarget).not.toHaveBeenCalled();
    } else {
      expect(creep.harvest).not.toHaveBeenCalled();
      expect(mockedMoveToTarget).toHaveBeenCalledWith(creep, workPos, 1, { reusePath: 5 });
    }
  });

  it("stops the invalid harvest intent while standing on its full work container", () => {
    const workPos = createPosition(10, 10, [createContainer(0)]);
    const creep = createCreep("W1N0", workPos);
    bindSource(workPos);

    expect(colonizerHarvesterRole("W1N0", "source-a").source?.(creep)).toBe(false);

    expect(creep.harvest).not.toHaveBeenCalled();
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
  });

  it("moves toward the assigned work position instead of stalling on an unrelated full container", () => {
    const unrelatedPos = createPosition(20, 20, [createContainer(0)]);
    const workPos = createPosition(10, 10);
    const creep = createCreep("W1N0", unrelatedPos);
    bindSource(workPos);

    expect(colonizerHarvesterRole("W1N0", "source-a").source?.(creep)).toBe(false);

    expect(mockedMoveToTarget).toHaveBeenCalledWith(
      creep,
      workPos,
      0,
      { reusePath: 5, allowSourceContainerTarget: true },
    );
    expect(unrelatedPos.lookFor).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it("外矿母房超本地库存目标仍采集，只有实际 Storage 空间不足时停并随空间恢复继续", () => {
    let free = 100_000;
    Game.rooms.E1N57 = {
      controller: { my: true }, energyAvailable: 12_000, energyCapacityAvailable: 12_900,
      storage: { store: { getUsedCapacity: () => 327_000, getFreeCapacity: () => free } },
      terminal: { store: { getUsedCapacity: () => 243_000 } },
    } as unknown as Room;
    Memory.runtime = {
      resourceControl: { updatedAt: Game.time, rooms: { E1N57: {
        capacityState: "pressure", energyFloor: 120_000, energyTarget: 200_000,
        terminalEnergyReserve: 20_000,
      } } },
    } as unknown as NonNullable<Memory["runtime"]>;
    const workPos = createPosition(10, 10, [createContainer(1000)]);
    const creep = createCreep("W1N0", workPos);
    creep.memory.configName = "E1N57:remoteMine:W1N0:harvester:source-a";
    bindSource(workPos);
    const role = colonizerHarvesterRole("W1N0", "source-a");

    role.source?.(creep);
    expect(creep.harvest).toHaveBeenCalledTimes(1);
    free = 4_999;
    Game.time += 1;
    role.source?.(creep);
    expect(creep.harvest).toHaveBeenCalledTimes(1);
    free = 5_000;
    Game.time += 1;
    role.source?.(creep);
    expect(creep.harvest).toHaveBeenCalledTimes(2);
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
  });

  it("外矿有母房余量时仍保留源容器满且无 CARRY 的不掉落保护", () => {
    Game.rooms.E1N57 = {
      controller: { my: true }, storage: { store: { getFreeCapacity: () => 100_000 } },
    } as unknown as Room;
    const workPos = createPosition(10, 10, [createContainer(0)]);
    const creep = createCreep("W1N0", workPos);
    creep.memory.configName = "E1N57:remoteMine:W1N0:harvester:source-a";
    bindSource(workPos);
    colonizerHarvesterRole("W1N0", "source-a").source?.(creep);
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
  });
});
