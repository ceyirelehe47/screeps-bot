/**
 * Carrier 最佳候选选择回归测试（任务书阶段 C3）：
 * 单次循环选择与原 filter→map→sort→[0] 语义一致——
 * priority 降序 → from 距离升序 → 平局保留列表原顺序。
 */
import { carrierRole } from "@/roles/carrier";
import {
  clearCarrierTaskBoardForTest,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest } from "@/runtime/creepAssignmentState";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";

jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(),
  isDroppedResourceTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  getPickupReservationClaimAmount: jest.fn(() => 800),
  getPickupTargetEnergyAmount: jest.fn(() => 0),
  getReservedPickupTarget: jest.fn(() => null),
  releasePickupReservation: jest.fn(),
  reservePickupTarget: jest.fn(() => false),
}));

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedStoragePos: jest.fn(() => null),
  getPlannedControllerLinkPos: jest.fn(() => null),
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

const { getEnergyStoreTarget } = jest.requireMock("@/roles/energyTargets") as {
  getEnergyStoreTarget: jest.Mock;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    find: () => [],
    terminal: {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10_000,
      },
    } as unknown as StructureTerminal,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10_000,
      },
    } as unknown as StructureStorage,
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

function createContainer(
  room: Room,
  id: string,
  x: number,
  contents: Partial<Record<ResourceConstant, number>> = {},
): StructureContainer {
  return {
    id,
    structureType: STRUCTURE_CONTAINER,
    room,
    pos: { x, y: 10, roomName: room.name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource !== undefined) {
          return contents[resource] ?? 0;
        }
        return Object.values(contents).reduce((total, amount) => total + (amount ?? 0), 0);
      },
      getFreeCapacity: () => 10_000,
    },
  } as unknown as StructureContainer;
}

function createMineralHaulDraft(
  id: string,
  priority: number,
  resource: ResourceConstant,
  from: StructureContainer,
  to: StructureContainer,
): CarrierTaskDraft {
  return {
    id,
    type: "mineral_haul",
    priority,
    steps: [{
      id: `${id}:step`,
      resource,
      fromKind: "container",
      toKind: "container",
      fromId: from.id,
      toId: to.id,
      amount: 500,
    }],
  };
}

function installObjects(objects: AnyStoreStructure[]): void {
  const byId = new Map<string, AnyStoreStructure>(
    objects.map((object) => [object.id as string, object]),
  );
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
    (id: string) => byId.get(id) ?? null,
  ) as unknown as Game["getObjectById"];
}

function createCreep(room: Room, name: string): Creep {
  const creep = {
    name,
    room,
    memory: {},
    // 距离 = 目标 x 坐标，便于构造确定性的距离序。
    pos: {
      getRangeTo: (pos: RoomPosition) => pos.x,
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined ? 0 : 0),
      getFreeCapacity: () => 800,
    },
    withdraw: jest.fn(() => OK),
    transfer: jest.fn(() => OK),
  } as unknown as Creep;
  Game.creeps[name] = creep;
  return creep;
}

describe("carrier best-candidate selection", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearLocalCarrierDestinationCapacityForTest();
    resetRuntimeServices();
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Memory.rooms = {};
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    Memory.data = undefined;
    getEnergyStoreTarget.mockReset();
    getEnergyStoreTarget.mockReturnValue(null);
  });

  it("优先级降序：高优远任务胜过低优近任务", () => {
    const room = createRoom("W1N1");
    const nearSource = createContainer(room, `${room.name}-$near-src`, 2, { [RESOURCE_UTRIUM]: 5_000 });
    const farSource = createContainer(room, `${room.name}-$far-src`, 40, { [RESOURCE_KEANIUM]: 5_000 });
    const sink = createContainer(room, `${room.name}-$sink`, 45);
    installObjects([nearSource, farSource, sink]);
    // 先发布低优任务（列表序在前），再发布高优任务。
    replaceCarrierTasksForProducerRoom("tie-test", room.name, [
      createMineralHaulDraft("low-near", 10, RESOURCE_UTRIUM, nearSource, sink),
      createMineralHaulDraft("high-far", 50, RESOURCE_KEANIUM, farSource, sink),
    ]);

    const creep = createCreep(room, "carrier-priority");
    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(farSource, RESOURCE_KEANIUM, 500);
  });

  it("同优先级时距离升序：近任务胜过远任务", () => {
    const room = createRoom("W2N2");
    const farSource = createContainer(room, `${room.name}-$far-src`, 40, { [RESOURCE_UTRIUM]: 5_000 });
    const nearSource = createContainer(room, `${room.name}-$near-src`, 3, { [RESOURCE_KEANIUM]: 5_000 });
    const sink = createContainer(room, `${room.name}-$sink`, 45);
    installObjects([farSource, nearSource, sink]);
    // 先发布远任务（列表序在前），验证距离规则压过列表顺序。
    replaceCarrierTasksForProducerRoom("tie-test", room.name, [
      createMineralHaulDraft("equal-far", 20, RESOURCE_UTRIUM, farSource, sink),
      createMineralHaulDraft("equal-near", 20, RESOURCE_KEANIUM, nearSource, sink),
    ]);

    const creep = createCreep(room, "carrier-distance");
    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(nearSource, RESOURCE_KEANIUM, 500);
  });

  it("完全平局时保留列表原顺序（先发布的任务胜出）", () => {
    const room = createRoom("W3N3");
    const firstSource = createContainer(room, `${room.name}-$first-src`, 7, { [RESOURCE_UTRIUM]: 5_000 });
    const secondSource = createContainer(room, `${room.name}-$second-src`, 7, { [RESOURCE_KEANIUM]: 5_000 });
    const sink = createContainer(room, `${room.name}-$sink`, 45);
    installObjects([firstSource, secondSource, sink]);
    replaceCarrierTasksForProducerRoom("tie-test", room.name, [
      createMineralHaulDraft("tie-first", 20, RESOURCE_UTRIUM, firstSource, sink),
      createMineralHaulDraft("tie-second", 20, RESOURCE_KEANIUM, secondSource, sink),
    ]);

    const creep = createCreep(room, "carrier-tie");
    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(firstSource, RESOURCE_UTRIUM, 500);
  });

  it("同一任务多步骤时选择距离最近的取货点", () => {
    const room = createRoom("W4N4");
    const farSource = createContainer(room, `${room.name}-$task-far-src`, 40, { [RESOURCE_UTRIUM]: 5_000 });
    const nearSource = createContainer(room, `${room.name}-$task-near-src`, 4, { [RESOURCE_KEANIUM]: 5_000 });
    const sink = createContainer(room, `${room.name}-$sink`, 45);
    installObjects([farSource, nearSource, sink]);
    replaceCarrierTasksForProducerRoom("tie-test", room.name, [{
      id: "multi-step",
      type: "mineral_haul",
      priority: 100,
      steps: [
        {
          id: "far-step",
          resource: RESOURCE_UTRIUM,
          fromKind: "container",
          toKind: "container",
          fromId: farSource.id,
          toId: sink.id,
          amount: 500,
        },
        {
          id: "near-step",
          resource: RESOURCE_KEANIUM,
          fromKind: "container",
          toKind: "container",
          fromId: nearSource.id,
          toId: sink.id,
          amount: 500,
        },
      ],
    }]);

    const creep = createCreep(room, "carrier-steps");
    carrierRole().source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(nearSource, RESOURCE_KEANIUM, 500);
  });
});
