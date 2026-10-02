import * as runtimeServices from "@/runtime/runtimeServices";
import { BUILD_INFO } from "@/buildMeta";
import { carrierRole } from "@/roles/carrier";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { resetTreasuryCoreLifecycleFactsForTest } from "@/runtime/treasury/kernel/kernel";
import { treasuryTaskCommitmentView, hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import {
  beginTreasuryProductionTick,
  endTreasuryProductionTick,
  registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask,
} from "@/runtime/treasuryTerminalTransfer";
import {
  clearMarketActionArbiterForTest,
  executeMarketDeal,
  executeTerminalSend,
} from "@/runtime/marketActionArbiter";
import { armTreasuryT2FirstLive, readTreasuryT2FirstLiveControl } from "@/runtime/treasuryT2FirstLiveControl";
import { clearCarrierTaskBoardForTest, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";

// Only unrelated fallback movement/energy selection is mocked. Carrier task
// selection, pending cargo, dispatch ownership and native guards stay real.
jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(() => null),
  isDroppedResourceTarget: jest.fn(() => false),
}));
jest.mock("@/roles/shared", () => ({ moveToTarget: jest.fn() }));
jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedStoragePos: jest.fn(() => null),
  getPlannedControllerLinkPos: jest.fn(() => null),
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

const sourceName = "E4N58";
const targetName = "E1N57";
const thirdName = "E5N59";
type Amounts = Partial<Record<ResourceConstant, number>>;
type MutableStore = StoreDefinition & Amounts;

function makeStore(amounts: Amounts, capacity = 300_000): MutableStore {
  const store = { ...amounts } as MutableStore;
  Object.defineProperties(store, {
    getUsedCapacity: { value(resource?: ResourceConstant) {
      return resource ? (store[resource] ?? 0)
        : Object.values(store).reduce((total, value) => total + (value ?? 0), 0);
    } },
    getFreeCapacity: { value() { return capacity - store.getUsedCapacity(); } },
    getCapacity: { value() { return capacity; } },
  });
  return store;
}

function makeRoom(name: string): Room {
  const room = {
    name,
    controller: { my: true, level: 8, owner: { username: "forster" } },
    find: () => [],
  } as unknown as Room;
  room.storage = {
    id: `${name}-storage`, room, structureType: STRUCTURE_STORAGE,
    pos: { x: 10, y: 10, roomName: name },
    store: makeStore({ [RESOURCE_ENERGY]: 100_000, [RESOURCE_KEANIUM]: 2_000 }, 1_000_000),
  } as unknown as StructureStorage;
  room.terminal = {
    id: `${name}-terminal`, room, structureType: STRUCTURE_TERMINAL,
    pos: { x: 11, y: 10, roomName: name },
    my: true, owner: { username: "forster" }, isActive: () => true, cooldown: 0,
    store: makeStore({ [RESOURCE_UTRIUM_HYDRIDE]: name === sourceName ? 10_000 : 200,
      [RESOURCE_KEANIUM]: 1_800, [RESOURCE_ENERGY]: 10_000 }),
    send: jest.fn(() => OK),
  } as unknown as StructureTerminal;
  return room;
}

function makeTask(): ResourceTransferTask {
  return {
    id: "real-UH-synthesis-task", resource: RESOURCE_UTRIUM_HYDRIDE,
    fromRoomName: sourceName, toRoomName: targetName, amount: 1_715,
    remainingAmount: 1_715, status: "pending", origin: "automatic",
    reason: "synthesis:E1N57:UH2O", createdAt: 90, updatedAt: 90, lastProgressAt: 90,
  };
}

describe("T2 real endpoint send/deal and carrier concurrency", () => {
  let source: Room;
  let target: Room;
  let third: Room;
  let task: ResourceTransferTask;
  let treasury: TreasuryService;
  let serviceSpy: jest.SpyInstance;
  const extraObjects = new Map<string, AnyStoreStructure>();

  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));

  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    resetTreasuryCoreLifecycleFactsForTest();
    clearMarketActionArbiterForTest();
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearMarketSaleExposureReservationsForTest();
    clearLocalCarrierDestinationCapacityForTest();
    extraObjects.clear();
    (global as typeof global & { __DEPLOY_BUNDLE_HASH__?: string }).__DEPLOY_BUNDLE_HASH__ = "test-bundle";
    Game.time = 100;
    Game.shard = { name: "shard1" } as Game["shard"];
    Game.cpu = { getUsed: () => 0, tickLimit: 500, bucket: 10_000 } as Game["cpu"];
    source = makeRoom(sourceName);
    target = makeRoom(targetName);
    third = makeRoom(thirdName);
    Game.rooms = { [sourceName]: source, [targetName]: target, [thirdName]: third,
      E3N59: makeRoom("E3N59"), E6N59: makeRoom("E6N59") };
    Game.creeps = {};
    Game.spawns = {};
    Game.getObjectById = jest.fn((id: string) => extraObjects.get(id) ??
      Object.values(Game.rooms).flatMap((room) => [room.storage, room.terminal])
        .find((object) => object?.id === id) ?? null) as Game["getObjectById"];
    Game.market = { calcTransactionCost: jest.fn(() => 10), getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK), incomingTransactions: [], outgoingTransactions: [] } as unknown as Market;
    task = makeTask();
    Memory.rooms = {};
    Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "off" },
      treasuryTerminalTransferT2: { mode: "off" }, synthesisControl: { enabled: true,
        rooms: { [targetName]: { enabled: true,
          reactions: [{ product: RESOURCE_UTRIUM_ACID, targetAmount: 5_000, batchSize: 2_500 }] } } },
    } as unknown as Memory["cfg"];
    Memory.data = { resourceControl: { tasks: { [task.id]: task } } } as unknown as Memory["data"];
    Memory.runtime = { lastDeployTag: BUILD_INFO.tag,
      lastDeployBundleHash: BUILD_INFO.bundleHash,
      synthesisControl: { updatedAt: 100, generatedTaskCount: 0, failedTaskCount: 0,
        successfulRunCount: 0, lastActions: [], bindings: {}, rooms: {
          [targetName]: { stage: "acquiring", activeProduct: RESOURCE_UTRIUM_ACID,
            reagentA: RESOURCE_UTRIUM_HYDRIDE, reagentB: RESOURCE_HYDROXIDE,
            targetAmount: 5_000, batchSize: 2_500, reagentLabIds: [], productLabIds: [],
            successfulRuns: 0, pendingTasks: 1, lastTransitionAt: 90 } },
      },
    } as Memory["runtime"];
    treasury = createTreasuryService({
      getRooms: () => Object.values(Game.rooms),
      getTasks: () => treasuryTaskCommitmentView(Memory.data?.resourceControl?.tasks ?? {},
        treasury.kernelJournal().active),
    });
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(treasury);
  });

  afterEach(() => { endTreasuryProductionTick(); serviceSpy.mockRestore(); });

  function canonicalTask(): ResourceTransferTask {
    return Memory.data!.resourceControl!.tasks[task.id] as ResourceTransferTask;
  }

  function ledger(): ReceiverCapacityLedger {
    return new ReceiverCapacityLedger({
      receivers: [{ roomName: targetName, storageFreeCapacity: 800_000,
        terminalFreeCapacity: target.terminal!.store.getFreeCapacity(),
        getTerminalResourceFreeCapacity: () => target.terminal!.store.getFreeCapacity() }],
      tasks: [canonicalTask()], storageSafetyReserve: 0, terminalSafetyReserve: 0,
      isTaskEndpointValid: () => true, isTaskHealthy: () => true,
    });
  }

  function arm(): void {
    expect(armTreasuryT2FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
  }

  function runT2(): void {
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(canonicalTask(), ledger(), true, jest.fn());
  }

  function treasuryNativeCalls(): unknown[][] {
    return (source.terminal!.send as jest.Mock).mock.calls.filter((call) =>
      call[0] === RESOURCE_UTRIUM_HYDRIDE && call[1] === 100 && call[2] === targetName);
  }

  /** Engine evidence, not hand-written quota/mode release. */
  function confirmAndRelease(): void {
    const calls = treasuryNativeCalls();
    expect(calls).toHaveLength(1);
    const transaction = { transactionId: "T2-concurrency-confirmed", time: Game.time,
      sender: { username: "forster" }, recipient: { username: "forster" },
      from: sourceName, to: targetName, resourceType: RESOURCE_UTRIUM_HYDRIDE,
      amount: 100, description: calls[0][3] };
    endTreasuryProductionTick();
    const from = source.terminal!.store as MutableStore;
    const to = target.terminal!.store as MutableStore;
    from[RESOURCE_UTRIUM_HYDRIDE]! -= 100;
    from[RESOURCE_ENERGY]! -= 10;
    to[RESOURCE_UTRIUM_HYDRIDE]! += 100;
    Game.market.incomingTransactions = [transaction as unknown as Transaction];
    Game.market.outgoingTransactions = [transaction as unknown as Transaction];
    for (let n = 0; n < 16; n += 1) {
      Game.time += 1;
      beginTreasuryProductionTick();
      endTreasuryProductionTick();
      if (!hasTreasuryTerminalFence(sourceName) && !hasTreasuryTerminalFence(targetName)) break;
    }
    expect(canonicalTask().remainingAmount).toBe(1_615);
    expect(canonicalTask().treasurySlice).toBeUndefined();
    expect(hasTreasuryTerminalFence(sourceName)).toBe(false);
    expect(hasTreasuryTerminalFence(targetName)).toBe(false);
    expect(treasuryNativeCalls()).toHaveLength(1);
  }

  type OrdinaryAction = "send-in" | "send-out" | "market-buy" | "market-sell";
  function ordinary(action: OrdinaryAction, roomName: string): ScreepsReturnCode {
    if (action === "send-in" || action === "send-out") {
      return executeTerminalSend({
        terminal: action === "send-in" ? third.terminal! : Game.rooms[roomName].terminal!,
        resourceType: RESOURCE_KEANIUM, amount: 10, transactionCost: 10,
        destinationRoomName: action === "send-in" ? roomName : thirdName,
        actor: "resourceControl:ordinary",
      });
    }
    return executeMarketDeal("ordinary-order", 10, roomName, "resourceControl:ordinary", {
      orderType: action === "market-buy" ? ORDER_SELL : ORDER_BUY,
      resourceType: RESOURCE_KEANIUM, orderRoomName: thirdName,
    });
  }

  const nativeCases = [sourceName, targetName].flatMap((roomName) =>
    (["send-in", "send-out", "market-buy", "market-sell"] as const)
      .map((action) => [roomName, action] as const));

  it.each(nativeCases)("ordinary %s %s first prevents a same-tick Treasury binding", (roomName, action) => {
    expect(ordinary(action, roomName)).toBe(OK);
    expect(armTreasuryT2FirstLive(task.id, task.createdAt))
      .toEqual({ ok: false, reason: "terminal_action_this_tick" });
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
    expect(beginTreasuryProductionTick()).toBe(false);
    expect(runTreasuryTerminalTransferTask(task, ledger(), true, jest.fn())).toEqual({ handled: false });
    expect(treasuryNativeCalls()).toHaveLength(0);
    expect(task.treasurySlice).toBeUndefined();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toBeUndefined();
    expect(task.remainingAmount).toBe(1_715);
    endTreasuryProductionTick();
    // Apply the preceding ordinary native result before the next observation.
    const endpoint = Game.rooms[roomName].terminal!.store as MutableStore;
    if (action === "send-in") {
      endpoint[RESOURCE_KEANIUM]! += 10;
      (third.terminal!.store as MutableStore)[RESOURCE_KEANIUM]! -= 10;
      (third.terminal!.store as MutableStore)[RESOURCE_ENERGY]! -= 10;
    } else {
      endpoint[RESOURCE_KEANIUM]! += action === "market-buy" ? 10 : -10;
      endpoint[RESOURCE_ENERGY]! -= 10;
      if (action === "send-out") (third.terminal!.store as MutableStore)[RESOURCE_KEANIUM]! += 10;
    }
    Game.time += 1;
    arm();
    runT2();
    expect(treasuryNativeCalls()).toHaveLength(1);
  });

  it.each(nativeCases)("Treasury first blocks ordinary %s %s until real settlement", (roomName, action) => {
    arm();
    expect(ordinary(action, roomName)).toBe(ERR_BUSY);
    runT2();
    expect(treasuryNativeCalls()).toHaveLength(1);
    const nativeSends = Object.values(Game.rooms).reduce((n, room) =>
      n + (room.terminal!.send as jest.Mock).mock.calls.length, 0);
    expect(ordinary(action, roomName)).toBe(ERR_BUSY);
    expect(Object.values(Game.rooms).reduce((n, room) =>
      n + (room.terminal!.send as jest.Mock).mock.calls.length, 0)).toBe(nativeSends);
    expect(Game.market.deal).not.toHaveBeenCalled();
    confirmAndRelease();
    Game.time += 1;
    expect(ordinary(action, roomName)).toBe(OK);
  });

  it("T2 responsibility leaves old E3N59 and unrelated room native business runnable", () => {
    arm();
    runT2();
    expect(hasTreasuryTerminalFence(sourceName)).toBe(true);
    expect(hasTreasuryTerminalFence(targetName)).toBe(true);
    expect(hasTreasuryTerminalFence("E3N59")).toBe(false);
    expect(hasTreasuryTerminalFence("E6N59")).toBe(false);
    expect(ordinary("send-out", "E3N59")).toBe(OK);
    expect(ordinary("market-buy", "E6N59")).toBe(OK);
    expect(Game.rooms.E3N59.terminal!.send).toHaveBeenCalledTimes(1);
    expect(Game.market.deal).toHaveBeenCalledTimes(1);
    expect(treasuryNativeCalls()).toHaveLength(1);
  });

  function makeCarrier(roomName: string, direction: "withdraw" | "transfer"): Creep {
    const room = Game.rooms[roomName];
    const lab = { id: `${roomName}-lab`, room, structureType: STRUCTURE_LAB,
      pos: { x: 12, y: 10, roomName }, store: makeStore({}, 3_000) } as unknown as StructureLab;
    extraObjects.set(lab.id, lab);
    const from = direction === "withdraw" ? room.terminal! : room.storage!;
    const to = direction === "withdraw" ? lab : room.terminal!;
    replaceCarrierTasksForProducerRoom(direction === "withdraw" ? "synthesisControl" : "resourceControl:preload",
      roomName, [{ id: `T2-cargo-${roomName}-${direction}`,
        type: direction === "withdraw" ? "lab_supply" : "terminal_feed",
        dispatchClass: "capacity_relief", priority: 100,
        steps: [{ id: "cargo-step", resource: RESOURCE_KEANIUM,
          fromKind: direction === "withdraw" ? "terminal" : "storage",
          toKind: direction === "withdraw" ? "lab" : "terminal",
          fromId: from.id, toId: to.id, amount: 100 }] }]);
    let carried = 0;
    const carrier = { name: `carrier-${roomName}-${direction}`, room, memory: {},
      pos: { getRangeTo: () => 1 },
      store: { [RESOURCE_KEANIUM]: 0,
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_KEANIUM ? carried : 0,
        getFreeCapacity: () => 800 - carried },
      withdraw: jest.fn(() => { carried = 100; return OK; }),
      transfer: jest.fn(() => { carried = 0; return OK; }),
      suicide: jest.fn(),
    } as unknown as Creep;
    Game.creeps[carrier.name] = carrier;
    if (direction === "transfer") {
      // Natural real role pickup on the preceding tick establishes the plan;
      // the test does not seed a synthetic pending delivery assignment.
      Game.time = 99;
      carrierRole().source?.(carrier);
      expect(carrier.withdraw).toHaveBeenCalledWith(from, RESOURCE_KEANIUM, 100);
      expect(getCreepAssignmentState(carrier.name)?.synthesisCarrierPendingToId).toBe(to.id);
      Game.time = 100;
    }
    return carrier;
  }

  const cargoCases = [sourceName, targetName].flatMap((roomName) =>
    (["withdraw", "transfer"] as const).map((direction) => [roomName, direction] as const));

  function executeCargo(carrier: Creep, direction: "withdraw" | "transfer"): void {
    if (direction === "withdraw") carrierRole().source?.(carrier);
    else carrierRole().target(carrier);
  }

  it.each(cargoCases)("real carrier %s %s first prevents a same-tick Treasury binding", (roomName, direction) => {
    const carrier = makeCarrier(roomName, direction);
    executeCargo(carrier, direction);
    expect(carrier[direction]).toHaveBeenCalledWith(Game.rooms[roomName].terminal!, RESOURCE_KEANIUM,
      ...(direction === "withdraw" ? [100] : []));
    expect(armTreasuryT2FirstLive(task.id, task.createdAt))
      .toEqual({ ok: false, reason: "terminal_action_this_tick" });
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
    expect(beginTreasuryProductionTick()).toBe(false);
    expect(treasuryNativeCalls()).toHaveLength(0);
    expect(task.treasurySlice).toBeUndefined();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toBeUndefined();
    expect(task.remainingAmount).toBe(1_715);
    endTreasuryProductionTick();
    (Game.rooms[roomName].terminal!.store as MutableStore)[RESOURCE_KEANIUM]! +=
      direction === "withdraw" ? -100 : 100;
    Game.time += 1;
    arm();
    runT2();
    expect(treasuryNativeCalls()).toHaveLength(1);
  });

  it.each(cargoCases)("Treasury first delays real carrier %s %s and preserves cargo through settlement", (roomName, direction) => {
    const carrier = makeCarrier(roomName, direction);
    arm();
    executeCargo(carrier, direction);
    expect(carrier[direction]).not.toHaveBeenCalled();
    runT2();
    expect(treasuryNativeCalls()).toHaveLength(1);
    executeCargo(carrier, direction);
    expect(carrier[direction]).not.toHaveBeenCalled();
    if (direction === "transfer") {
      expect(carrier.store.getUsedCapacity(RESOURCE_KEANIUM)).toBe(100);
      expect(getCreepAssignmentState(carrier.name)?.synthesisCarrierPendingToId).toBe(Game.rooms[roomName].terminal!.id);
    }
    confirmAndRelease();
    Game.time += 1;
    executeCargo(carrier, direction);
    expect(carrier[direction]).toHaveBeenCalledWith(Game.rooms[roomName].terminal!, RESOURCE_KEANIUM,
      ...(direction === "withdraw" ? [100] : []));
    if (direction === "transfer") expect(carrier.store.getUsedCapacity()).toBe(0);
  });

  it.each(["E3N59", "E6N59"].flatMap((roomName) =>
    (["withdraw", "transfer"] as const).map((direction) => [roomName, direction] as const)))
  ("T2 responsibility permits real carrier %s %s outside its endpoints", (roomName, direction) => {
    const carrier = makeCarrier(roomName, direction);
    arm();
    runT2();
    executeCargo(carrier, direction);
    expect(carrier[direction]).toHaveBeenCalledWith(Game.rooms[roomName].terminal!, RESOURCE_KEANIUM,
      ...(direction === "withdraw" ? [100] : []));
    expect(treasuryNativeCalls()).toHaveLength(1);
    expect(hasTreasuryTerminalFence(roomName)).toBe(false);
  });
});
