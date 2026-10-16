import { createMockFactory, createMockStore, MockFactoryConfig } from "@mock/powerBank";
import {
  runFactoryControl,
  getRequiredFactoryLevel,
} from "@/runtime/factoryControl";


interface FactoryRoomOptions {
  name?: string;
  rcl?: number;
  storageResources?: Record<string, number>;
  terminalResources?: Record<string, number>;
  factoryOverrides?: Partial<MockFactoryConfig>;
  hasController?: boolean;
  hasTerminal?: boolean;
}

interface FactoryRoomHandle {
  room: Room;
  factory: StructureFactory;
  storage: StructureStorage;
  terminal: StructureTerminal;
}

function createFactoryRoom(options: FactoryRoomOptions = {}): FactoryRoomHandle {
  const roomName = options.name ?? "W1N1";
  const rcl = options.rcl ?? 7;

  const storage: StructureStorage = {
    id: `${roomName}-storage` as Id<StructureStorage>,
    structureType: STRUCTURE_STORAGE,
    store: createMockStore(options.storageResources ?? { [RESOURCE_ENERGY]: 300000 }),
  } as unknown as StructureStorage;

  const terminal: StructureTerminal = {
    id: `${roomName}-terminal` as Id<StructureTerminal>,
    structureType: STRUCTURE_TERMINAL,
    cooldown: 0,
    store: createMockStore(options.terminalResources ?? { [RESOURCE_ENERGY]: 25000 }),
  } as unknown as StructureTerminal;

  const factory = createMockFactory({
    id: `${roomName}-factory`,
    roomName,
    level: rcl >= 7 ? 1 : 0,
    store: createMockStore({}),
    ...options.factoryOverrides,
  });

  const allStructures: any[] = [factory, storage, terminal];

  const roomObj: Partial<Room> = {
    name: roomName,
    controller: options.hasController !== false
      ? ({ my: true, level: rcl } as StructureController)
      : undefined,
    storage,
    terminal: options.hasTerminal !== false ? terminal : undefined,
  };
  Object.assign(roomObj, {
    factory,
    find: ((type: FindConstant, opts?: { filter?: (s: Structure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        return opts?.filter
          ? allStructures.filter((s: any) => opts.filter!(s as Structure))
          : allStructures;
      }
      return [];
    }) as Room["find"],
  });

  return {
    room: roomObj as Room,
    factory,
    storage,
    terminal,
  };
}

function setConfig(cfg: Record<string, unknown>): void {
  if (!Memory.cfg) Memory.cfg = {};
  Memory.cfg.factoryControl = cfg as any;
}

function setupGameRooms(rooms: Record<string, Room>): void {
  (Game as any).rooms = rooms;
  Game.time = 1000;
}

describe("factory level gate", () => {

  it("getRequiredFactoryLevel returns level from COMMODITIES", () => {
    expect(getRequiredFactoryLevel("battery" as ResourceConstant)).toBe(0);
    expect(getRequiredFactoryLevel("composite" as ResourceConstant)).toBe(1);
    expect(getRequiredFactoryLevel("crystal" as ResourceConstant)).toBe(2);
    expect(getRequiredFactoryLevel("liquid" as ResourceConstant)).toBe(3);
    expect(getRequiredFactoryLevel("circuit" as ResourceConstant)).toBe(4);
    expect(getRequiredFactoryLevel("device" as ResourceConstant)).toBe(5);
  });
});

describe("cooldown and capacity", () => {
  beforeEach(() => {
    const { clearCarrierTaskBoardForTest } = require("@/runtime/carrierTaskBoard");
    clearCarrierTaskBoardForTest();
  });

  it("blocks when consumption still cannot free enough capacity for output", () => {
    const { room, factory } = createFactoryRoom({
      storageResources: { [RESOURCE_ENERGY]: 500000 },
      factoryOverrides: {
        level: 0,
        store: createMockStore({ [RESOURCE_BATTERY]: 50, H: 2949 }, 3000),
        cooldown: 0,
      },
    });
    setupGameRooms({ W1N1: room });

    setConfig({
      enabled: true,
      targets: [{ resource: "energy", targetAmount: 525500 }],
    });

    runFactoryControl();

    const state = Memory.runtime?.factoryControl?.rooms?.W1N1;
    expect(state).toBeDefined();
    expect(state!.stage).toBe("blocked");
    expect(state!.sleepReason).toBe("factory_output_full");
    expect(state!.lastError).toBe("factory_full");
    expect(factory.produce).not.toHaveBeenCalled();
  });
});


it("带等级配方只在工厂等级相等且 Operate Factory 生效时补料", () => {
  const { clearCarrierTaskBoardForTest, listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  for (const [level, effectLevel, remaining, allowed] of [[2, 1, 10, false], [1, 1, 0, false], [1, 1, 10, true]]) {
    clearCarrierTaskBoardForTest(); Memory.runtime = undefined;
    const { room, factory } = createFactoryRoom({ storageResources: { energy: 300000, utrium_bar: 100, zynthium_bar: 100 },
      factoryOverrides: { level: Number(level) } });
    Object.assign(factory, { effects: [{ effect: PWR_OPERATE_FACTORY, level: effectLevel, ticksRemaining: remaining }] });
    setupGameRooms({ W1N1: room });
    setConfig({ enabled: true, targets: [{ resource: "composite", targetAmount: 100 }] });
    runFactoryControl();
    if (!allowed) {
      expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
      expect(factory.produce).not.toHaveBeenCalled();
    } else expect(Memory.runtime?.factoryControl?.rooms.W1N1.activeTarget).toBe("composite");
  }
});


it("工厂补料来源选择扣除 terminal 中待售锁定量", () => {
  const { clearCarrierTaskBoardForTest, listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  const { clearMarketSaleExposureReservationsForTest } = require("@/runtime/marketSaleExposure");
  clearCarrierTaskBoardForTest(); clearMarketSaleExposureReservationsForTest(); Memory.runtime = undefined;
  const { room, storage } = createFactoryRoom({ storageResources: { energy: 300000 }, terminalResources: { energy: 500000 } });
  setupGameRooms({ W1N1: room });
  setConfig({ enabled: true, targets: [{ resource: RESOURCE_BATTERY, targetAmount: 50 }] });
  Memory.data = { marketSaleAutomation: { managedOrders: {}, pendingDirectDeals: { held: {
    requestId: "held", status: "reconcile_gap", canaryRoomName: room.name, resource: RESOURCE_ENERGY,
    dealAmount: 400000, transactionEnergy: 0,
  } } } } as any;
  runFactoryControl();
  expect(listCarrierTasksByRoom(room.name).flatMap((task: any) => task.steps))
    .toContainEqual(expect.objectContaining({ resource: RESOURCE_ENERGY, fromId: storage.id }));
});


it("不支持的旧配方释放残留原料，仍保留下一个可生产配方的输入", () => {
  const { clearCarrierTaskBoardForTest, listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  clearCarrierTaskBoardForTest(); Memory.runtime = undefined;
  const { room, factory } = createFactoryRoom({ terminalResources: {}, factoryOverrides: { level: 1,
    store: createMockStore({ utrium_bar: 100, energy: 600 }) } });
  setupGameRooms({ W1N1: room });
  setConfig({ enabled: true, targets: [{ resource: "composite", targetAmount: 100 }, { resource: RESOURCE_BATTERY, targetAmount: 50 }] });
  runFactoryControl();
  const steps = listCarrierTasksByRoom(room.name).flatMap((task: any) => task.steps);
  expect(steps).toContainEqual(expect.objectContaining({ fromId: factory.id, resource: "utrium_bar", amount: 100 }));
  expect(steps.some((step: any) => step.fromId === factory.id && step.resource === RESOURCE_ENERGY)).toBe(false);
});
