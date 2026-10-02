import { clearCarrierTaskBoardForTest, getCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";
import { createAutomaticResourceTransferTask, type ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { clearLocalCarrierDestinationCapacityForTest, claimLocalCarrierDestinationCapacity } from "@/runtime/localCarrierDestinationCapacity";
import { runResourceControl } from "@/runtime/resourceControl";
import { inspectAutomaticSynthesisTransferDemand, resolveSynthesisStagingFeedCapacity } from "@/runtime/synthesisTransferDemand";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { reserveProductionResource } from "@/runtime/resourceReservation";

type MutableStore = StoreDefinition & { set(resource: ResourceConstant, amount: number): void };
function createMutableStore(
  capacity: number,
  initial: Partial<Record<ResourceConstant, number>>,
): MutableStore {
  const amounts: Partial<Record<ResourceConstant, number>> = { ...initial };
  const store = {
    ...initial,
    getUsedCapacity(resource?: ResourceConstant): number {
      if (resource) return amounts[resource] || 0;
      return Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
    },
    getFreeCapacity(): number {
      return Math.max(0, capacity - this.getUsedCapacity());
    },
    getCapacity(): number {
      return capacity;
    },
    set(resource: ResourceConstant, amount: number): void {
      const normalized = Math.max(0, Math.floor(amount));
      amounts[resource] = normalized;
      (store as unknown as Record<string, unknown>)[resource] = normalized;
    },
  } as unknown as MutableStore;
  return store;
}

function createMutableRoom(
  name: string,
  storageInitial: Partial<Record<ResourceConstant, number>>,
  terminalInitial: Partial<Record<ResourceConstant, number>>,
  storageCapacity = 1_000_000,
): Room {
  const storageStore = createMutableStore(storageCapacity, storageInitial);
  const terminalStore = createMutableStore(300_000, terminalInitial);
  const terminal = {
    id: `${name}-terminal`,
    structureType: STRUCTURE_TERMINAL,
    cooldown: 0,
    store: terminalStore,
    send: jest.fn((resource: ResourceConstant, amount: number, toRoomName: string) => {
      const receiver = Game.rooms[toRoomName]?.terminal;
      if (!receiver) return ERR_INVALID_TARGET;
      const transactionCost = Game.market.calcTransactionCost(amount, name, toRoomName);
      const requiredEnergy = transactionCost + (resource === RESOURCE_ENERGY ? amount : 0);
      if (terminalStore.getUsedCapacity(resource) < amount) return ERR_NOT_ENOUGH_RESOURCES;
      if (terminalStore.getUsedCapacity(RESOURCE_ENERGY) < requiredEnergy) {
        return ERR_NOT_ENOUGH_RESOURCES;
      }
      if (receiver.store.getFreeCapacity() < amount) return ERR_FULL;

      if (resource === RESOURCE_ENERGY) {
        terminalStore.set(
          RESOURCE_ENERGY,
          terminalStore.getUsedCapacity(RESOURCE_ENERGY) - requiredEnergy,
        );
      } else {
        terminalStore.set(resource, terminalStore.getUsedCapacity(resource) - amount);
        terminalStore.set(
          RESOURCE_ENERGY,
          terminalStore.getUsedCapacity(RESOURCE_ENERGY) - transactionCost,
        );
      }
      const receiverStore = receiver.store as unknown as MutableStore;
      receiverStore.set(resource, receiverStore.getUsedCapacity(resource) + amount);
      return OK;
    }),
  } as unknown as StructureTerminal;

  const room = {
    name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: storageStore,
    } as unknown as StructureStorage,
    terminal,
    find(type: FindConstant) {
      if (type === FIND_MINERALS || type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) return [];
      return [];
    },
  } as unknown as Room;
  (terminal as StructureTerminal & { room: Room }).room = room;
  return room;
}


function resetRuntimeServices(): void { delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices; }

describe("自动合成补料的实需与物理 staging", () => {
  let source: Room;
  let target: Room;
  let productLab: StructureLab;
  let task: ResourceTransferTask;

  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearLocalCarrierDestinationCapacityForTest();
    resetRuntimeServices();
    Memory.data = undefined;
    Game.rooms = {};
    Game.creeps = {};
    Game.time = 10;
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = { getUsed: jest.fn(() => 0) };
    Game.market = { calcTransactionCost: jest.fn(() => 2), getAllOrders: jest.fn(() => []), deal: jest.fn(() => OK) } as unknown as Market;
    source = createMutableRoom("E4N58", { energy: 1_315_864, OH: 913, Z: 6_530_607 }, { energy: 178_975, Z: 80_006 }, 8_000_000);
    target = createMutableRoom("E1N57", { energy: 317_938 }, { energy: 249_180, Z: 3_483 });
    Game.rooms[source.name] = source;
    Game.rooms[target.name] = target;
    const reagentLab = { id: "target-oh-lab", structureType: STRUCTURE_LAB, room: target, store: createMutableStore(3_000, { OH: 4 }) } as unknown as StructureLab;
    productLab = { id: "target-product-lab", structureType: STRUCTURE_LAB, room: target, store: createMutableStore(3_000, { UH2O: 2_355 }) } as unknown as StructureLab;
    target.find = jest.fn((type: FindConstant) => type === FIND_MY_STRUCTURES ? [reagentLab, productLab] : []) as unknown as Room["find"];
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10, taskMaxPerRun: 5, market: { enabled: false },
        capacityBalancing: { enabled: false, terminalReliefTargetFreeCapacity: 60_000, receiverTerminalMinFreeCapacity: 40_000 },
      },
      synthesisControl: { enabled: true, rooms: { E1N57: { enabled: true, reactions: [{ product: RESOURCE_UTRIUM_ACID, targetAmount: 2_385, batchSize: 1_000 }] } } },
    } as unknown as Memory["cfg"];
    Memory.runtime = {
      resourceControl: { updatedAt: 0, rooms: { E4N58: { capacityState: "pressure" } }, lastActions: [], lastMarketActions: [] },
      synthesisControl: { rooms: { E1N57: { activeProduct: RESOURCE_UTRIUM_ACID, stage: "acquiring", targetAmount: 2_385, batchSize: 1_000 } } },
    } as unknown as Memory["runtime"];
    const created = createAutomaticResourceTransferTask(source.name, target.name, RESOURCE_HYDROXIDE, 913, "synthesis:E1N57:UH2O");
    if (typeof created === "string") throw new Error(created);
    task = created.task;
  });

  function feeds(): number[] {
    return Object.values(getCarrierTasksByRoom(source.name)).filter((entry) => entry.type === "terminal_feed")
      .flatMap((entry) => entry.steps.filter((step) => step.resource === RESOURCE_HYDROXIDE).map((step) => step.amount));
  }

  it("在 41k 物理空位与零 ordinary headroom 中只搬真实所需 26，保留原 913 承诺", () => {
    expect(source.storage!.store.getFreeCapacity()).toBe(152_616);
    expect(source.terminal!.store.getFreeCapacity()).toBe(41_019);
    expect(inspectAutomaticSynthesisTransferDemand(task)).toMatchObject({ status: "bounded", amount: 26 });
    runResourceControl();
    expect(feeds()).toEqual([26]);
    expect(source.terminal!.send).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: "pending", amount: 913, remainingAmount: 913 });
    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({ admittedAmount: 26 });
    expect(Memory.cfg?.resourceControl?.capacityBalancing).toMatchObject({ terminalReliefTargetFreeCapacity: 60_000 });
  });

  it("ordinary 即使货已备齐也只发送 26；下一轮取消 887，保留已发送量与历史", () => {
    (source.terminal!.store as MutableStore).set(RESOURCE_HYDROXIDE, 913);
    runResourceControl();
    expect(source.terminal!.send).toHaveBeenCalledWith(RESOURCE_HYDROXIDE, 26, target.name, expect.anything());
    expect(task).toMatchObject({ amount: 913, remainingAmount: 887, status: "pending" });
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();
    expect(task).toMatchObject({ amount: 913, remainingAmount: 887, status: "cancelled", lastError: "automatic_synthesis_need_covered" });
    expect(Memory.data?.resourceControl?.tasks[task.id]).toBe(task);
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
  });

  it("已完成配方变成 idle 后仍取消原补料，绝不向满目标发送余量", () => {
    (productLab.store as MutableStore).set(RESOURCE_UTRIUM_ACID, 2_385);
    const state = Memory.runtime!.synthesisControl!.rooms[target.name];
    state.stage = "idle";
    state.activeProduct = undefined;
    task.remainingAmount = 887;
    runResourceControl();
    expect(task).toMatchObject({ status: "cancelled", amount: 913, remainingAmount: 887 });
    expect(source.terminal!.send).not.toHaveBeenCalled();
  });

  it("已有 Treasury 责任时需求收敛只 hold，不取消也不缩减旧余量", () => {
    (productLab.store as MutableStore).set(RESOURCE_UTRIUM_ACID, 2_385);
    task.remainingAmount = 887;
    task.treasurySlice = { schemaVersion: 1, runId: "treasury-production-T3-2026-10-02", workKey: "protected", attemptId: "attempt", amount: 26, phase: "active" };
    expect(inspectAutomaticSynthesisTransferDemand(task)).toEqual({ status: "held", reason: "treasury_responsibility_retained" });
    runResourceControl();
    expect(task).toMatchObject({ status: "pending", amount: 913, remainingAmount: 887, treasurySlice: { amount: 26, phase: "active" } });
  });

  it("structures2355 加本房已接受卸货的 30 产品 cargo 覆盖目标；外运或无accepted assignment不覆盖", () => {
    const name = "product-unloader";
    Game.creeps[name] = { name, room: target, memory: {}, store: createMutableStore(50, { UH2O: 30 }) } as unknown as Creep;
    const assignment = ensureCreepAssignmentState(name);
    assignment.synthesisCarrierPendingResource = RESOURCE_UTRIUM_ACID;
    assignment.synthesisCarrierPendingToId = target.terminal!.id;
    Game.getObjectById = jest.fn((id: string) => id === target.terminal!.id ? target.terminal : id === source.terminal!.id ? source.terminal : null) as unknown as Game["getObjectById"];
    expect(inspectAutomaticSynthesisTransferDemand(task)).toMatchObject({ status: "bounded", amount: 0 });
    assignment.synthesisCarrierPendingToId = source.terminal!.id;
    expect(inspectAutomaticSynthesisTransferDemand(task)).toMatchObject({ status: "bounded", amount: 26 });
    delete assignment.synthesisCarrierPendingToId;
    expect(inspectAutomaticSynthesisTransferDemand(task)).toMatchObject({ status: "bounded", amount: 26 });
  });

  it("扣除目的地在途 cargo 后物理空位不足时不 admission，也不创建搬运", () => {
    const claim = claimLocalCarrierDestinationCapacity({ claimantId: "existing-cargo", target: source.terminal!, resource: RESOURCE_ZYNTHIUM, requestedAmount: 41_019 });
    expect(claim?.amount).toBe(41_019);
    claim!.commit();
    runResourceControl();
    expect(feeds()).toEqual([]);
    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({ admittedAmount: 0, suppressedByReason: { terminal_headroom: 1 } });
    expect(task.remainingAmount).toBe(913);
  });

  it("出货费用也只占真实单批物理容量，不借生产例外预装 ordinary Energy 储备", () => {
    const terminal = source.terminal!.store as MutableStore;
    terminal.set(RESOURCE_ENERGY, 0);
    terminal.set(RESOURCE_ZYNTHIUM, 258_981);
    runResourceControl();
    const steps = Object.values(getCarrierTasksByRoom(source.name)).filter((entry) => entry.type === "terminal_feed").flatMap((entry) => entry.steps);
    expect(steps.map((step) => [step.resource, step.amount])).toEqual([[RESOURCE_ENERGY, 2], [RESOURCE_HYDROXIDE, 26]]);
    expect(task.remainingAmount).toBe(913);
  });

  it("物理 staging 例外仍尊重其他生产资源承诺", () => {
    reserveProductionResource(source.name, RESOURCE_HYDROXIDE, 913, "other-production");
    runResourceControl();
    expect(feeds()).toEqual([]);
    expect(source.terminal!.send).not.toHaveBeenCalled();
    expect(task.remainingAmount).toBe(913);
  });

  it.each(["manual", "compatibility", "disabled"])("%s 行为不获得 production physical 容量例外", (kind) => {
    if (kind === "manual") task.origin = "manual";
    if (kind === "compatibility") task.reason = "auto:synthesis:E1N57:UH2O";
    if (kind === "disabled") Memory.cfg!.synthesisControl!.enabled = false;
    runResourceControl();
    expect(feeds()).toEqual([]);
    expect(source.terminal!.send).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: "pending", amount: 913, remainingAmount: 913 });
  });

  it("不为 manual、非 exact reason、未启用或未配置配方开放容量例外", () => {
    task.origin = "manual";
    expect(inspectAutomaticSynthesisTransferDemand(task)).toEqual({ status: "unmanaged" });
    task.origin = "automatic";
    task.reason = "auto:synthesis:E1N57:UH2O";
    expect(inspectAutomaticSynthesisTransferDemand(task)).toEqual({ status: "unmanaged" });
    task.reason = "synthesis:E1N57:UH2O";
    Memory.cfg!.synthesisControl!.enabled = false;
    expect(inspectAutomaticSynthesisTransferDemand(task)).toEqual({ status: "unmanaged" });
    expect(resolveSynthesisStagingFeedCapacity(0, 41_019, 0, false, 26)).toBe(0);
    Memory.cfg!.synthesisControl!.enabled = true;
    Memory.cfg!.synthesisControl!.rooms[target.name].reactions = [];
    expect(inspectAutomaticSynthesisTransferDemand(task)).toEqual({ status: "unmanaged" });
  });

  it("同 tick 已接受但尚未反映在 live Store 的 26 intent 仍覆盖需求", () => {
    expect(inspectAutomaticSynthesisTransferDemand(task, 26)).toMatchObject({ status: "bounded", amount: 0 });
  });
});
