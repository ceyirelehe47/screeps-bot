import { carrierRole } from "@/roles/carrier";
import {
  clearCarrierTaskBoardForTest,
  listCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
  type CarrierTaskStep,
} from "@/runtime/carrierTaskBoard";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  getCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import { clearPickupReservationStoreForTest } from "@/runtime/energyPickupReservation";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import {
  cancelResourceTransferTask,
  createAutomaticResourceTransferTask,
  recordResourceTransferTaskProgress,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import { terminalFeedBoundTaskIdentity } from "@/runtime/terminalFeedTarget";

/**
 * 真实 carrier/任务板/assignment 回归；只装夹 native 世界与 native intent。
 * Store 按 Screeps 语义在下一 tick 生效，不能用同步 Store 掩盖承诺缺口。
 */
interface NativeStoreFixture {
  store: Creep["store"];
  get(resource: ResourceConstant): number;
  set(resource: ResourceConstant, amount: number): void;
}

function createNativeStore(
  capacity: number,
  contents: Partial<Record<ResourceConstant, number>> = {},
): NativeStoreFixture {
  const values: Partial<Record<ResourceConstant, number>> = { ...contents };
  const view = Object.create(null) as Record<string, unknown>;
  const used = (resource?: ResourceConstant): number => resource === undefined
    ? Object.values(values).reduce((sum, amount) => sum + (amount ?? 0), 0)
    : values[resource] ?? 0;
  const set = (resource: ResourceConstant, amount: number): void => {
    values[resource] = amount;
    if (amount > 0) view[resource] = amount;
    else delete view[resource];
  };
  Object.defineProperties(view, {
    getUsedCapacity: { value: used },
    getFreeCapacity: { value: () => Math.max(0, capacity - used()) },
    getCapacity: { value: () => capacity },
  });
  for (const resource of Object.keys(values) as ResourceConstant[]) {
    set(resource, values[resource] ?? 0);
  }
  return { store: view as unknown as Creep["store"], get: used, set };
}

interface NativeCarrierFixture {
  creep: Creep;
  inventory: NativeStoreFixture;
  withdraw: jest.Mock;
  transfer: jest.Mock;
  acceptedTransfers: { target: AnyStoreStructure; resource: ResourceConstant; amount: number }[];
}

interface FeedScenario {
  room: Room;
  storage: StructureStorage;
  terminal: StructureTerminal;
  storageInventory: NativeStoreFixture;
  terminalInventory: NativeStoreFixture;
  addCarrier(name: string, capacity?: number): NativeCarrierFixture;
  publish(options?: { amount?: number; bound?: number | null; boundTask?: ResourceTransferTask }): void;
  nextTick(): void;
}

let scenarioSequence = 0;

function createFeedScenario(options: {
  terminalStock?: number;
  storageStock?: number;
  storageCapacity?: number;
} = {}): FeedScenario {
  const roomName = `W${240 + scenarioSequence++}N1`;
  const pendingIntents = new Map<string, () => void>();
  const inventories = new Map<string, NativeStoreFixture>();
  const storageInventory = createNativeStore(options.storageCapacity ?? 10_000, {
    [RESOURCE_HYDROXIDE]: options.storageStock ?? 2_000,
  });
  const terminalInventory = createNativeStore(10_000, {
    [RESOURCE_HYDROXIDE]: options.terminalStock ?? 0,
  });
  const room = {
    name: roomName,
    controller: { my: true, level: 6 },
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: (find: FindConstant) => find === FIND_STRUCTURES || find === FIND_MY_STRUCTURES
      ? [storage, terminal]
      : [],
  } as unknown as Room;
  const storage = {
    id: `${roomName}-storage`, room, my: true, structureType: STRUCTURE_STORAGE,
    pos: { x: 10, y: 10, roomName }, store: storageInventory.store,
  } as unknown as StructureStorage;
  const terminal = {
    id: `${roomName}-terminal`, room, my: true, structureType: STRUCTURE_TERMINAL,
    pos: { x: 11, y: 10, roomName }, store: terminalInventory.store,
  } as unknown as StructureTerminal;
  Object.assign(room, { storage, terminal });
  inventories.set(storage.id, storageInventory);
  inventories.set(terminal.id, terminalInventory);
  Game.rooms[roomName] = room;
  Game.getObjectById = jest.fn((id: string) => id === storage.id ? storage
    : id === terminal.id ? terminal : Game.creeps[id] ?? null) as unknown as Game["getObjectById"];

  return {
    room, storage, terminal, storageInventory, terminalInventory,
    addCarrier(name, capacity = 800) {
      const inventory = createNativeStore(capacity);
      const acceptedTransfers: NativeCarrierFixture["acceptedTransfers"] = [];
      const withdraw = jest.fn((from: AnyStoreStructure, resource: ResourceConstant, amount?: number) => {
        const nativeAmount = amount ?? Math.min(from.store.getUsedCapacity(resource), inventory.store.getFreeCapacity(resource));
        if (nativeAmount <= 0 || nativeAmount > from.store.getUsedCapacity(resource)) return ERR_NOT_ENOUGH_RESOURCES;
        if (nativeAmount > inventory.store.getFreeCapacity(resource)) return ERR_FULL;
        pendingIntents.set(name, () => {
          const fromInventory = inventories.get(from.id)!;
          const applied = Math.min(nativeAmount, fromInventory.get(resource), inventory.store.getFreeCapacity(resource));
          fromInventory.set(resource, fromInventory.get(resource) - applied);
          inventory.set(resource, inventory.get(resource) + applied);
        });
        return OK;
      });
      const transfer = jest.fn((to: AnyStoreStructure, resource: ResourceConstant, amount?: number) => {
        const carried = inventory.get(resource);
        if (carried <= 0 || (amount !== undefined && amount > carried)) return ERR_NOT_ENOUGH_RESOURCES;
        if (to.store.getFreeCapacity(resource) <= 0) return ERR_FULL;
        const nativeAmount = Math.min(amount ?? carried, to.store.getFreeCapacity(resource));
        if (nativeAmount <= 0) return ERR_INVALID_ARGS;
        acceptedTransfers.push({ target: to, resource, amount: nativeAmount });
        pendingIntents.set(name, () => {
          const toInventory = inventories.get(to.id)!;
          const applied = Math.min(nativeAmount, inventory.get(resource), to.store.getFreeCapacity(resource));
          inventory.set(resource, inventory.get(resource) - applied);
          toInventory.set(resource, toInventory.get(resource) + applied);
        });
        return OK;
      });
      const creep = {
        id: name, name, room, my: true, memory: {}, ticksToLive: 1_000,
        pos: { x: 10, y: 11, roomName, getRangeTo: () => 1 },
        store: inventory.store, withdraw, transfer, suicide: jest.fn(() => OK),
        getActiveBodyparts: () => 1,
      } as unknown as Creep;
      Game.creeps[name] = creep;
      inventories.set(name, inventory);
      return { creep, inventory, withdraw, transfer, acceptedTransfers };
    },
    publish({ amount = 26, bound = 26, boundTask } = {}) {
      const step: CarrierTaskStep & { destinationTargetAmount?: number } = {
        id: `OH:${storage.id}->${terminal.id}`,
        resource: RESOURCE_HYDROXIDE, fromKind: "storage", toKind: "terminal",
        fromId: storage.id, toId: terminal.id, amount,
        ...(bound === null ? {} : { destinationTargetAmount: bound }),
        ...(boundTask ? {
          boundResourceTransferTaskId: boundTask.id,
          boundResourceTransferTaskIdentity: terminalFeedBoundTaskIdentity(boundTask),
        } : {}),
      };
      const draft: CarrierTaskDraft = {
        id: `resourceControl:terminal_feed:${roomName}:OH`,
        type: "terminal_feed", priority: 80, steps: [step],
      };
      replaceCarrierTasksForProducerRoom("resourceControl:preload", roomName, [draft]);
    },
    nextTick() {
      for (const apply of pendingIntents.values()) apply();
      pendingIntents.clear();
      Game.time += 1;
    },
  };
}

function installBoundSynthesisDemand(scenario: FeedScenario): {
  task: ResourceTransferTask;
  receiverInventory: NativeStoreFixture;
} {
  const roomName = `E${240 + scenarioSequence}N1`;
  const receiverInventory = createNativeStore(10_000);
  const reagentInventory = createNativeStore(3_000, { [RESOURCE_HYDROXIDE]: 4 });
  const room = {
    name: roomName,
    controller: { my: true, level: 8 },
    storage: null,
    find: (find: FindConstant) => find === FIND_MY_STRUCTURES ? [reagentLab] : [],
  } as unknown as Room;
  const terminal = {
    id: `${roomName}-terminal`, room, my: true, structureType: STRUCTURE_TERMINAL,
    store: receiverInventory.store,
  } as unknown as StructureTerminal;
  const reagentLab = {
    id: `${roomName}-OH-lab`, room, my: true, structureType: STRUCTURE_LAB,
    store: reagentInventory.store,
  } as unknown as StructureLab;
  Object.assign(room, { terminal });
  Game.rooms[roomName] = room;
  const previousResolver = Game.getObjectById;
  Game.getObjectById = jest.fn((id: string) => id === terminal.id ? terminal
    : id === reagentLab.id ? reagentLab : previousResolver(id as Id<AnyStoreStructure>)) as unknown as Game["getObjectById"];
  Memory.cfg = {
    synthesisControl: {
      enabled: true,
      rooms: {
        [roomName]: {
          enabled: true,
          reactions: [{ product: RESOURCE_UTRIUM_ACID, targetAmount: 30, batchSize: 1_000 }],
        },
      },
    },
  } as unknown as Memory["cfg"];
  Memory.runtime = {
    synthesisControl: {
      rooms: {
        [roomName]: { activeProduct: RESOURCE_UTRIUM_ACID, stage: "acquiring", targetAmount: 30, batchSize: 1_000 },
      },
    },
  } as unknown as Memory["runtime"];
  const created = createAutomaticResourceTransferTask(
    scenario.room.name, roomName, RESOURCE_HYDROXIDE, 913, `synthesis:${roomName}:UH2O`,
  );
  if (typeof created === "string") throw new Error(created);
  return { task: created.task, receiverInventory };
}

function markAcceptedCargo(
  scenario: FeedScenario,
  carrier: NativeCarrierFixture,
  resource: ResourceConstant,
  amount: number,
  targetId: string = scenario.terminal.id,
): void {
  carrier.inventory.set(resource, amount);
  Object.assign(ensureCreepAssignmentState(carrier.creep.name), {
    synthesisCarrierPendingPickupTick: Game.time - 1,
    synthesisCarrierPendingFromId: scenario.storage.id,
    synthesisCarrierPendingToId: targetId,
    synthesisCarrierPendingResource: resource,
    synthesisCarrierPendingTaskType: "terminal_feed",
  });
}

function terminalTransferAmount(
  scenario: FeedScenario,
  carrier: NativeCarrierFixture,
): number {
  return carrier.acceptedTransfers
    .filter(({ target, resource }) => target === scenario.terminal && resource === RESOURCE_HYDROXIDE)
    .reduce((sum, { amount }) => sum + amount, 0);
}

describe("carrier terminal_feed 的实时绝对目的库存约束", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearPickupReservationStoreForTest();
    clearLocalCarrierDestinationCapacityForTest();
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.time = 10_000 + scenarioSequence * 100;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
    Memory.rooms = {};
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("公共任务板保留目的库存标量，旧板数 tick 不刷新也只搬入 26 OH", () => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier("bounded-stale-board");
    const role = carrierRole();
    scenario.publish();
    expect(listCarrierTasksByRoom(scenario.room.name)[0].steps[0])
      .toMatchObject({ amount: 26, destinationTargetAmount: 26 });

    expect(role.source?.(carrier.creep)).toBe(true);
    expect(carrier.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 26);
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    scenario.nextTick();
    role.target(carrier.creep);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    scenario.nextTick();

    for (let tick = 0; tick < 5; tick += 1) {
      if (carrier.inventory.store.getUsedCapacity() > 0) role.target(carrier.creep);
      else role.source?.(carrier.creep);
      scenario.nextTick();
    }
    expect(carrier.withdraw).toHaveBeenCalledTimes(1);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    expect(scenario.storageInventory.get(RESOURCE_HYDROXIDE)).toBe(1_974);
  });

  it("两个 carrier 的同 tick withdraw 共享 26 上界，即使本 tick Store 都是零", () => {
    const scenario = createFeedScenario();
    const first = scenario.addCarrier("bounded-first", 20);
    const second = scenario.addCarrier("bounded-second", 20);
    const role = carrierRole();
    scenario.publish();

    role.source?.(first.creep);
    role.source?.(second.creep);
    expect(first.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 20);
    expect(second.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 6);
    expect(first.inventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    expect(second.inventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    scenario.nextTick();
    role.target(first.creep);
    role.target(second.creep);
    scenario.nextTick();
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(26);
  });

  it("目的 Terminal 的已接受在途 OH 也占用上界，其他 actor 只能再取 6", () => {
    const scenario = createFeedScenario();
    const inFlight = scenario.addCarrier("accepted-in-flight");
    const newcomer = scenario.addCarrier("newcomer");
    markAcceptedCargo(scenario, inFlight, RESOURCE_HYDROXIDE, 20);
    scenario.publish();

    carrierRole().source?.(newcomer.creep);
    expect(newcomer.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 6);
  });

  it("同一 carrier 在 Store 尚未变化的本 tick 重入 source 不覆盖已接受的 26 pickup", () => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier("same-tick-reentry");
    const role = carrierRole();
    scenario.publish();

    role.source?.(carrier.creep);
    role.source?.(carrier.creep);
    expect(carrier.withdraw).toHaveBeenCalledTimes(1);
    scenario.nextTick();
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    expect(getCreepAssignmentState(carrier.creep.name)?.synthesisCarrierPendingToId).toBe(scenario.terminal.id);
  });

  it("live 库存 24 加已接受在途 2 时拒绝新的 stale pickup", () => {
    const scenario = createFeedScenario({ terminalStock: 24 });
    const inFlight = scenario.addCarrier("accepted-last-two");
    const newcomer = scenario.addCarrier("fulfilled-newcomer");
    markAcceptedCargo(scenario, inFlight, RESOURCE_HYDROXIDE, 2);
    scenario.publish();

    carrierRole().source?.(newcomer.creep);
    expect(newcomer.withdraw).not.toHaveBeenCalled();
  });

  it.each(["other-resource", "other-destination"])("%s 的 accepted cargo 不占 OH 目的上界", (kind) => {
    const scenario = createFeedScenario();
    const inFlight = scenario.addCarrier(`unrelated-${kind}`);
    const newcomer = scenario.addCarrier(`unrelated-newcomer-${kind}`);
    markAcceptedCargo(scenario, inFlight,
      kind === "other-resource" ? RESOURCE_UTRIUM : RESOURCE_HYDROXIDE,
      800, kind === "other-destination" ? scenario.storage.id : scenario.terminal.id);
    scenario.publish();

    carrierRole().source?.(newcomer.creep);
    expect(newcomer.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 26);
  });

  it("withdraw 失败释放同 tick 上界，下一名 carrier 仍可领取 26", () => {
    const scenario = createFeedScenario();
    const first = scenario.addCarrier("failed-withdraw");
    const second = scenario.addCarrier("after-failed-withdraw");
    first.withdraw.mockImplementationOnce(() => ERR_NOT_ENOUGH_RESOURCES);
    scenario.publish();

    carrierRole().source?.(first.creep);
    carrierRole().source?.(second.creep);
    expect(second.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 26);
  });

  it.each([false, true])("到货前库存变为 24：移除板=%s，只交 2 且把余下 24 实际退回源 Storage", (removeBoard) => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier(`late-stock-${removeBoard}`);
    const role = carrierRole();
    scenario.publish();
    role.source?.(carrier.creep);
    scenario.nextTick();
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    if (removeBoard) replaceCarrierTasksForProducerRoom("resourceControl:preload", scenario.room.name, []);
    scenario.terminalInventory.set(RESOURCE_HYDROXIDE, 24);

    for (let tick = 0; tick < 4; tick += 1) {
      role.target(carrier.creep);
      if (carrier.inventory.get(RESOURCE_HYDROXIDE) > 0) {
        expect(getCreepAssignmentState(carrier.creep.name)?.synthesisCarrierPendingToId).toBeDefined();
      }
      scenario.nextTick();
      expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBeLessThanOrEqual(26);
    }
    expect(terminalTransferAmount(scenario, carrier)).toBe(2);
    expect(carrier.transfer).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 24);
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    expect(scenario.storageInventory.get(RESOURCE_HYDROXIDE)).toBe(1_998);
    for (const [target] of carrier.transfer.mock.calls) {
      expect([scenario.terminal, scenario.storage]).toContain(target);
    }
  });

  it("Terminal 已满足且 Storage 满时持有原责任，多 tick 不落入 generic Terminal cleanup", () => {
    const scenario = createFeedScenario({ storageStock: 26, storageCapacity: 26 });
    const carrier = scenario.addCarrier("no-safe-return");
    const role = carrierRole();
    scenario.publish();
    role.source?.(carrier.creep);
    scenario.nextTick();
    scenario.storageInventory.set(RESOURCE_HYDROXIDE, 26);
    scenario.terminalInventory.set(RESOURCE_HYDROXIDE, 26);
    replaceCarrierTasksForProducerRoom("resourceControl:preload", scenario.room.name, []);

    for (let tick = 0; tick < 4; tick += 1) {
      role.target(carrier.creep);
      expect(carrier.transfer).not.toHaveBeenCalled();
      expect(getCreepAssignmentState(carrier.creep.name)?.synthesisCarrierPendingToId).toBe(scenario.terminal.id);
      scenario.nextTick();
    }
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(26);
  });

  it("两个已取货 carrier 到货时库存突增，同 tick transfer 总量至多补剩余 2", () => {
    const scenario = createFeedScenario();
    const first = scenario.addCarrier("late-first", 20);
    const second = scenario.addCarrier("late-second", 20);
    const role = carrierRole();
    scenario.publish();
    role.source?.(first.creep);
    role.source?.(second.creep);
    scenario.nextTick();
    scenario.terminalInventory.set(RESOURCE_HYDROXIDE, 24);

    role.target(first.creep);
    role.target(second.creep);
    expect(terminalTransferAmount(scenario, first) + terminalTransferAmount(scenario, second)).toBeLessThanOrEqual(2);
    scenario.nextTick();
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBeLessThanOrEqual(26);
  });

  it("真实需求已被跨房到货覆盖后，旧绑定板即使源 Terminal 又变零也不再装第二批", () => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier("sent-demand-covered");
    const { task, receiverInventory } = installBoundSynthesisDemand(scenario);
    const role = carrierRole();
    scenario.publish({ boundTask: task });
    role.source?.(carrier.creep);
    expect(carrier.withdraw).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 26);
    scenario.nextTick();
    role.target(carrier.creep);
    scenario.nextTick();
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(26);

    // 装夹真实 send 生效后的下一 tick 世界；不调用或伪造生产 native writer。
    scenario.nextTick();
    scenario.terminalInventory.set(RESOURCE_HYDROXIDE, 0);
    receiverInventory.set(RESOURCE_HYDROXIDE, 26);
    task.remainingAmount -= 26;
    recordResourceTransferTaskProgress(task);
    for (let tick = 0; tick < 4; tick += 1) {
      role.source?.(carrier.creep);
      scenario.nextTick();
    }
    expect(carrier.withdraw).toHaveBeenCalledTimes(1);
    expect(task).toMatchObject({ status: "pending", amount: 913, remainingAmount: 887 });
    expect(scenario.storageInventory.get(RESOURCE_HYDROXIDE)).toBe(1_974);
    expect(listCarrierTasksByRoom(scenario.room.name)[0].steps[0]).toMatchObject({ amount: 26 });
  });

  it("pickup 已接受后任务取消且板移除，实际退回原 Storage；返回 tick 保留原 provenance，空货后清除 return/bound 字段", () => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier("cancelled-accepted-cargo");
    const { task } = installBoundSynthesisDemand(scenario);
    const taskIdentity = terminalFeedBoundTaskIdentity(task);
    const role = carrierRole();
    scenario.publish({ boundTask: task });
    role.source?.(carrier.creep);
    scenario.nextTick();
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    expect(cancelResourceTransferTask(task.id)).toMatchObject({ ok: true, previousStatus: "pending" });
    replaceCarrierTasksForProducerRoom("resourceControl:preload", scenario.room.name, []);

    role.target(carrier.creep);
    expect(carrier.transfer).toHaveBeenCalledWith(scenario.storage, RESOURCE_HYDROXIDE, 26);
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(26);
    expect(scenario.storageInventory.get(RESOURCE_HYDROXIDE)).toBe(1_974);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    expect(getCreepAssignmentState(carrier.creep.name)).toMatchObject({
      synthesisCarrierPendingFromId: scenario.storage.id,
      synthesisCarrierPendingToId: scenario.terminal.id,
      synthesisCarrierPendingResource: RESOURCE_HYDROXIDE,
      synthesisCarrierPendingReturnToId: scenario.storage.id,
      synthesisCarrierPendingDestinationTargetAmount: 26,
      synthesisCarrierPendingBoundResourceTransferTaskId: task.id,
      synthesisCarrierPendingBoundResourceTransferTaskIdentity: taskIdentity,
      synthesisCarrierPendingDeliveryTick: Game.time,
    });

    scenario.nextTick();
    expect(carrier.inventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    expect(scenario.storageInventory.get(RESOURCE_HYDROXIDE)).toBe(2_000);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(0);
    role.target(carrier.creep);
    const cleaned = getCreepAssignmentState(carrier.creep.name) ?? {};
    for (const field of [
      "synthesisCarrierPendingFromId", "synthesisCarrierPendingToId", "synthesisCarrierPendingResource",
      "synthesisCarrierPendingReturnToId", "synthesisCarrierPendingDestinationTargetAmount",
      "synthesisCarrierPendingBoundResourceTransferTaskId", "synthesisCarrierPendingBoundResourceTransferTaskIdentity",
    ]) expect(cleaned).not.toHaveProperty(field);
    expect(carrier.transfer).toHaveBeenCalledTimes(1);
  });

  it.each(["createdAt", "origin", "destination", "reason"])("同 ID 业务任务的 %s 被替换后，旧身份板不再接受 pickup", (identityField) => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier(`changed-task-${identityField}`);
    const { task } = installBoundSynthesisDemand(scenario);
    scenario.publish({ boundTask: task });
    if (identityField === "createdAt") task.createdAt += 1;
    if (identityField === "origin") task.origin = "manual";
    if (identityField === "destination") task.toRoomName = "E399N1";
    if (identityField === "reason") task.reason = `synthesis:${task.toRoomName}:ZH2O`;

    carrierRole().source?.(carrier.creep);
    expect(carrier.withdraw).not.toHaveBeenCalled();
    expect(scenario.storageInventory.get(RESOURCE_HYDROXIDE)).toBe(2_000);
  });

  it("旧 draft 无目的库存标量，保留每次按 step.amount=800 取货的原行为", () => {
    const scenario = createFeedScenario();
    const carrier = scenario.addCarrier("legacy-unbounded");
    const role = carrierRole();
    scenario.publish({ amount: 800, bound: null });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      role.source?.(carrier.creep);
      scenario.nextTick();
      role.target(carrier.creep);
      scenario.nextTick();
    }
    expect(carrier.withdraw.mock.calls.map(([, , amount]) => amount)).toEqual([800, 800]);
    expect(scenario.terminalInventory.get(RESOURCE_HYDROXIDE)).toBe(1_600);
  });
});
