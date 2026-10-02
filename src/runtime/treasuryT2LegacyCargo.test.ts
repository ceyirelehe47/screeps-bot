import * as runtimeServices from "@/runtime/runtimeServices";
import { remoteCarrierRole } from "@/roles/remoteCarrier";
import { clearRemoteSafetyCacheForTest, remoteMiningCarrierRole } from "@/roles/remoteMiningCarrier";
import { powerBankHaulerRole } from "@/roles/powerBankHauler";
import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { clearCreepAssignmentStateForTest, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { clearPickupReservationStoreForTest, reservePickupTarget } from "@/runtime/energyPickupReservation";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { armTreasuryT2FirstLive } from "@/runtime/treasuryT2FirstLiveControl";
import { beginTreasuryProductionTick, endTreasuryProductionTick,
  registerTreasuryProductionTerminalTransfer, runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { applyT2Stores, initializeT2, t2Ledger, t2Receipt, t2Room, T2_SOURCE, T2_TARGET } from "../../test/treasuryT2Fixture";

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(), moveToTargetRoom: jest.fn(), clearMovementState: jest.fn(),
}));

type MutableStore = StoreDefinition & Partial<Record<ResourceConstant, number>>;
type CargoKind = "remote-withdraw" | "remote-transfer" | "mining-transfer" | "power-transfer" | "reserved-energy-withdraw";
const cargoKinds: readonly CargoKind[] = ["remote-withdraw", "remote-transfer", "mining-transfer",
  "power-transfer", "reserved-energy-withdraw"];

function store(amounts: Partial<Record<ResourceConstant, number>>, capacity: number): MutableStore {
  const value = { ...amounts } as MutableStore;
  Object.defineProperties(value, {
    getUsedCapacity: { value(resource?: ResourceConstant) {
      return resource ? value[resource] ?? 0 : Object.values(value).reduce((sum, amount) => sum + (amount ?? 0), 0);
    } },
    getFreeCapacity: { value() { return capacity - value.getUsedCapacity(); } },
    getCapacity: { value() { return capacity; } },
  });
  return value;
}

describe("T2 guards real legacy terminal cargo execution points", () => {
  let context: ReturnType<typeof initializeT2>;
  let serviceSpy: jest.SpyInstance;

  function configureRoom(room: Room): void {
    Object.assign(room.terminal!, { pos: { x: 11, y: 10, roomName: room.name },
      store: store({ [RESOURCE_UTRIUM_HYDRIDE]: room.name === T2_SOURCE ? 4_000 : 200,
        [RESOURCE_ENERGY]: 100_000 }, 300_000) });
    Object.assign(room.storage!, { room, structureType: STRUCTURE_STORAGE,
      pos: { x: 10, y: 10, roomName: room.name },
      store: store({ [RESOURCE_ENERGY]: 100_000 }, 1_000_000) });
    room.find = jest.fn((type: FindConstant, options?: { filter?: (target: AnyStoreStructure) => boolean }) => {
      const structures = type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES ? [room.terminal!] : [];
      return options?.filter ? structures.filter(options.filter) : structures;
    }) as Room["find"];
  }

  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    clearCreepAssignmentStateForTest(); clearPickupReservationStoreForTest();
    clearRemoteSafetyCacheForTest(); clearMarketSaleExposureReservationsForTest();
    Game.creeps = {}; Game.spawns = {};
    context = initializeT2();
    configureRoom(context.source); configureRoom(context.target);
    Game.rooms.E3N59 = t2Room("E3N59"); configureRoom(Game.rooms.E3N59);
    Game.map = { getRoomLinearDistance: () => 1, findRoute: () => [],
      getRoomTerrain: () => ({ get: () => 0 }) } as unknown as GameMap;
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(context.treasury);
  });
  afterEach(() => { endTreasuryProductionTick(); serviceSpy.mockRestore(); });

  function armAndSend(): void {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt)).toEqual({ ok: true, reason: "armed" });
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target, [context.task]), true, jest.fn());
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(context.treasury.kernelJournal().active[0]).toMatchObject({ phase: "outcome_unknown" });
  }

  function confirmAndRelease(): void {
    const tx = t2Receipt(context.source, context.target, "legacy-cargo-T2-confirmed");
    endTreasuryProductionTick(); applyT2Stores(context.source, context.target);
    Game.market.incomingTransactions = [tx]; Game.market.outgoingTransactions = [tx];
    for (let n = 0; n < 12; n += 1) {
      Game.time += 1; beginTreasuryProductionTick(); endTreasuryProductionTick();
      if (!hasTreasuryTerminalFence(T2_SOURCE) && !hasTreasuryTerminalFence(T2_TARGET)) break;
    }
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1_615);
    expect((Memory.data!.resourceControl!.tasks[context.task.id] as typeof context.task).treasurySlice).toBeUndefined();
    expect(hasTreasuryTerminalFence(T2_SOURCE)).toBe(false);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  }

  function makeCargo(roomName: string, kind: CargoKind, storageFull = true): {
    creep: Creep; run: () => void; native: jest.Mock; resource: ResourceConstant;
    direction: "withdraw" | "transfer"; kind: CargoKind; task?: PowerBankHarvestTask;
  } {
    const room = Game.rooms[roomName];
    const direction = kind.endsWith("withdraw") ? "withdraw" : "transfer";
    const resource = kind === "power-transfer" ? RESOURCE_POWER : RESOURCE_ENERGY;
    const amounts: Partial<Record<ResourceConstant, number>> = { [resource]: direction === "transfer" ? 100 : 0 };
    const creep = { name: `legacy-${roomName}-${kind}`, room,
      memory: { configName: `${roomName}:haul:E5N59:carrier:0` }, ticksToLive: 1_000,
      pos: { x: 10, y: 11, roomName, getRangeTo: () => 1 },
      store: store(amounts, 100),
      withdraw: jest.fn(() => { (creep.store as MutableStore)[resource] = 100; return OK; }),
      transfer: jest.fn(() => { (creep.store as MutableStore)[resource] = 0; return OK; }),
      suicide: jest.fn(() => OK), getActiveBodyparts: () => 0,
    } as unknown as Creep;
    Game.creeps[creep.name] = creep;
    let run: () => void;
    let task: PowerBankHarvestTask | undefined;
    if (kind === "remote-withdraw") run = () => { remoteCarrierRole(roomName).source?.(creep); };
    else if (kind === "remote-transfer") run = () => { remoteCarrierRole("E5N59").target(creep); };
    else if (kind === "mining-transfer") {
      // Real delivery policy falls back to Terminal only when Storage is full.
      if (storageFull) room.storage!.store = store({ [RESOURCE_ENERGY]: 1_000_000 }, 1_000_000) as StructureStorage["store"];
      run = () => { remoteMiningCarrierRole("E5N59").target(creep); };
    } else if (kind === "power-transfer") {
      // Synthetic stopped task with already-held cargo: no PowerBank activity,
      // spawning, bank attack or real production write is involved.
      task = { id: "synthetic-stopped-power-task", status: "aborted", sourceRoom: roomName,
        targetRoom: "E5N59", bankId: "synthetic-bank", bankPos: { x: 25, y: 25 },
        hits: 0, power: 100, ticksToDecay: 0, freeTiles: 0, discoveredTick: 90,
        lastSeenTick: 90, haulerIds: [creep.name], boostLabs: [], compoundTransferTaskIds: [],
      } as PowerBankHarvestTask;
      Memory.data!.powerBankHarvest = { [task.id]: task };
      (creep.memory as PowerBankHaulerMemory).taskId = task.id;
      run = () => { powerBankHaulerRole("E5N59").target(creep); };
    } else {
      // Preserve an actual pre-existing Terminal reservation, rather than
      // replacing the energy-selection module with a fabricated return value.
      expect(reservePickupTarget(creep, room.terminal!, 100)).toBe(true);
      run = () => { pickupEnergyFromPreferredTarget(creep); };
    }
    return { creep, run, native: creep[direction] as jest.Mock, resource, direction, kind, task };
  }

  function expectNative(cargo: ReturnType<typeof makeCargo>, roomName: string): void {
    expect(cargo.native).toHaveBeenCalledTimes(1);
    expect(cargo.native.mock.calls[0][0]).toBe(Game.rooms[roomName].terminal);
    expect(cargo.native.mock.calls[0][1]).toBe(cargo.resource);
    if (cargo.kind === "remote-withdraw" || cargo.kind === "power-transfer") {
      expect(cargo.native.mock.calls[0][2]).toBe(100);
    } else expect(cargo.native.mock.calls[0]).toHaveLength(2);
    if (cargo.direction === "transfer") expect(cargo.creep.store.getUsedCapacity(cargo.resource)).toBe(0);
  }

  const cases = [T2_SOURCE, T2_TARGET].flatMap((roomName) => cargoKinds.map((kind) => [roomName, kind] as const));

  it.each(cases)("real %s %s native first rejects a same-tick T2 binding", (roomName, kind) => {
    const cargo = makeCargo(roomName, kind);
    cargo.run(); expectNative(cargo, roomName);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt))
      .toEqual({ ok: false, reason: "terminal_action_this_tick" });
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(context.task.remainingAmount).toBe(1_715);
  });

  it.each(cases)("T2 responsibility holds real %s %s and resumes original cargo after confirmed release", (roomName, kind) => {
    const postAdmissionStorageFull = roomName === T2_TARGET && kind === "mining-transfer";
    const cargo = makeCargo(roomName, kind, !postAdmissionStorageFull);
    armAndSend();
    if (postAdmissionStorageFull) {
      // The receiver was eligible at takeover. This synthetic later Storage
      // view forces the actual role's Terminal fallback while T2 already holds
      // responsibility; it does not claim a natural Storage-filling chain.
      Game.rooms[roomName].storage!.store = store({ [RESOURCE_ENERGY]: 1_000_000 }, 1_000_000) as StructureStorage["store"];
    }
    cargo.run();
    expect(cargo.native).not.toHaveBeenCalled();
    expect(cargo.creep.store.getUsedCapacity(cargo.resource)).toBe(cargo.direction === "transfer" ? 100 : 0);
    expect(cargo.creep.suicide).not.toHaveBeenCalled();
    if (cargo.task) expect(cargo.task.deliveredPower ?? 0).toBe(0);
    if (kind === "reserved-energy-withdraw") {
      expect(getCreepAssignmentState(cargo.creep.name)?.energyPickupTargetId).toBe(Game.rooms[roomName].terminal!.id);
    }
    confirmAndRelease(); Game.time += 1; cargo.run(); expectNative(cargo, roomName);
    if (cargo.task) expect(cargo.task.deliveredPower).toBe(100);
  });

  it.each([T2_SOURCE, T2_TARGET])("T2 keeps ordinary remoteMining Storage delivery runnable in %s", (roomName) => {
    const cargo = makeCargo(roomName, "mining-transfer");
    Game.rooms[roomName].storage!.store = store({ [RESOURCE_ENERGY]: 100_000 }, 1_000_000) as StructureStorage["store"];
    armAndSend(); cargo.run();
    expect(cargo.native).toHaveBeenCalledWith(Game.rooms[roomName].storage!, RESOURCE_ENERGY);
    expect(cargo.creep.store.getUsedCapacity()).toBe(0);
  });

  it("refuses an already full receiver Storage before arm and leaves its real Terminal fallback runnable", () => {
    const cargo = makeCargo(T2_TARGET, "mining-transfer");
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt))
      .toEqual({ ok: false, reason: "shared_receiver_capacity_protected" });
    cargo.run(); expectNative(cargo, T2_TARGET);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each(cargoKinds)("T2 responsibility permits actual %s native in old unrelated E3N59", (kind) => {
    const cargo = makeCargo("E3N59", kind);
    armAndSend(); cargo.run(); expectNative(cargo, "E3N59");
    expect(hasTreasuryTerminalFence("E3N59")).toBe(false);
  });
});
