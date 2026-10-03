import { runPowerBankHarvest } from "@/runtime/powerBankHarvest";
import {
  POWER_BANK_BODY_TIERS,
  POWER_BANK_STATUS,
  getPowerBankConfigName,
} from "@/runtime/powerBankConstants";
import { getCreepConfigService, registerRuntimeServices } from "@/runtime/runtimeServices";
import { clearDefenseModeCacheForTest } from "@/runtime/defenseMode";
import {
  createMockLab,
  createMockPowerBank,
  createMockPowerBankCreep,
  createMockStore,
  MockPos,
} from "@mock/powerBank";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import * as powerBankPathDistance from "@/runtime/powerBankPathDistance";
import * as powerBankObserver from "@/runtime/powerBankObserver";
import { getPowerBankLifecycleFailure, getPowerBankStageTimeout } from "@/runtime/powerBankTaskState";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type PowerBankTestMemory = CreepMemory & { taskId?: string };

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const SOURCE_ROOM = "E5N55";
const SECONDARY_SOURCE_ROOM = "E6N55";
const TARGET_ROOM = "E0N60";

function makeTask(overrides: Partial<PowerBankHarvestTask> = {}): PowerBankHarvestTask {
  return {
    id: overrides.id ?? "pb-test",
    status: overrides.status ?? POWER_BANK_STATUS.DISCOVERED,
    sourceRoom: overrides.sourceRoom ?? "",
    targetRoom: overrides.targetRoom ?? TARGET_ROOM,
    bankId: overrides.bankId ?? "bank-0",
    bankPos: overrides.bankPos ?? { x: 25, y: 25 },
    hits: overrides.hits ?? 2_000_000,
    power: overrides.power ?? 5000,
    ticksToDecay: overrides.ticksToDecay ?? 5000,
    freeTiles: overrides.freeTiles ?? 8,
    discoveredTick: overrides.discoveredTick ?? 1,
    lastSeenTick: overrides.lastSeenTick ?? 1,
    attackerId: overrides.attackerId,
    healerId: overrides.healerId,
    haulerIds: overrides.haulerIds ?? [],
    boostLabs: overrides.boostLabs ?? [],
    compoundTransferTaskIds: overrides.compoundTransferTaskIds ?? [],
    tier: overrides.tier,
    routeDistance: overrides.routeDistance ?? 5,
    pathDistance: overrides.pathDistance,
    combatTravelTicks: overrides.combatTravelTicks,
    haulerOutboundTravelTicks: overrides.haulerOutboundTravelTicks,
    haulerReturnTravelTicks: overrides.haulerReturnTravelTicks,
    haulerCount: overrides.haulerCount,
    failReason: overrides.failReason,
    terminalTick: overrides.terminalTick,
    attackerReady: overrides.attackerReady,
    healerReady: overrides.healerReady,
    haulingStartedTick: overrides.haulingStartedTick,
    haulingEmptySince: overrides.haulingEmptySince,
    reinforcement: overrides.reinforcement,
    bankExpiresAt: overrides.bankExpiresAt,
    stageEnteredAt: overrides.stageEnteredAt,
    lastProgressAt: overrides.lastProgressAt,
    lastBankHits: overrides.lastBankHits,
    lastBankProgressAt: overrides.lastBankProgressAt,
    lastVisibleAt: overrides.lastVisibleAt,
    blocker: overrides.blocker,
    nextAttemptAt: overrides.nextAttemptAt,
    activeGeneration: overrides.activeGeneration,
    activeIndex: overrides.activeIndex,
    combatReady: overrides.combatReady,
    primaryBoostOwnerId: overrides.primaryBoostOwnerId,
    primaryBoostLabs: overrides.primaryBoostLabs,
    routeRooms: overrides.routeRooms,
    avoidRooms: overrides.avoidRooms,
    plannedDps: overrides.plannedDps,
    plannedHps: overrides.plannedHps,
    plannedTtk: overrides.plannedTtk,
    plannedKillTick: overrides.plannedKillTick,
    minimumCombatTtl: overrides.minimumCombatTtl,
    bankGoneTick: overrides.bankGoneTick,
    haulingDeadlineAt: overrides.haulingDeadlineAt,
    observedPower: overrides.observedPower,
    pickedUpPower: overrides.pickedUpPower,
    deliveredPower: overrides.deliveredPower,
    lostPower: overrides.lostPower,
    outcome: overrides.outcome,
    terminalCleanupDone: overrides.terminalCleanupDone,
  };
}

function setupOwnedRoom(
  roomName: string,
  opts: {
    rcl?: number;
    energyCapacity?: number;
    compounds?: Partial<Record<ResourceConstant, number>>;
    spawnCount?: number;
    storeCapacity?: number;
    labCount?: number;
  } = {},
): Room {
  const compounds = opts.compounds ?? {
    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
    [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
  };
  const storageResources = {
    [RESOURCE_ENERGY]: 50_000,
    ...compounds,
  } as Record<string, number>;
  const labs = Array.from({ length: opts.labCount ?? 2 }, (_, index) => createMockLab({
    id: `${roomName}-lab${index}`,
    roomName,
    store: { [RESOURCE_ENERGY]: 3000 },
  }));
  const room = {
    name: roomName,
    controller: { my: true, level: opts.rcl ?? 8 },
    energyCapacityAvailable: opts.energyCapacity ?? 12_000,
    storage: { pos: new RoomPosition(20, 20, roomName), store: createMockStore(storageResources, opts.storeCapacity ?? 100_000) },
    terminal: { pos: new RoomPosition(21, 20, roomName), store: createMockStore({}, opts.storeCapacity ?? 50_000), cooldown: 0 },
    find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES ? labs : []),
  } as unknown as Room;
  Game.rooms[roomName] = room;

  for (let index = 1; index <= (opts.spawnCount ?? 1); index += 1) {
    Game.spawns[`${roomName}-spawn${index}`] = {
      name: `${roomName}-spawn${index}`,
      pos: new RoomPosition(10 + index, 10, roomName),
      room,
      memory: { spawnList: [] },
      spawning: null,
      isActive: () => true,
      renewCreep: jest.fn(() => OK),
    } as unknown as StructureSpawn;
  }
  return room;
}

function setupSourceRoom(options: { energyCapacity?: number; spawnCount?: number } = {}): void {
  setupOwnedRoom(SOURCE_ROOM, options);
}

function setupTargetRoom(): void {
  Game.rooms[TARGET_ROOM] = { name: TARGET_ROOM, find: () => [] } as unknown as Room;
}

function setupDiscoveredBank(task: PowerBankHarvestTask): void {
  const bank = createMockPowerBank({
    id: task.bankId,
    roomName: task.targetRoom,
    hits: task.hits,
    power: task.power,
    ticksToDecay: task.ticksToDecay,
  });
  Game.rooms[task.targetRoom] = {
    name: task.targetRoom,
    find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? [bank] : []),
  } as unknown as Room;
}

function setupGameMap(): void {
  if (!Game.map) (Game as any).map = {} as GameMap;
  Game.map.getRoomLinearDistance = jest.fn(() => 5);
  Game.map.findRoute = jest.fn(() => [{ room: "corridor", exit: FIND_EXIT_RIGHT }]);
}

function setupStore(): Record<string, PowerBankHarvestTask> {
  if (!Memory.data) Memory.data = {};
  Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvestHistory = [];
  return Memory.data.powerBankHarvest;
}

function addTask(task: PowerBankHarvestTask): void {
  Memory.data!.powerBankHarvest![task.id] = task;
}

function getTask(id: string): PowerBankHarvestTask | undefined {
  return Memory.data?.powerBankHarvest?.[id];
}

function mockPrepareBoosts(status: "preparing" | "ready" | "failed", labs: string[] = []): jest.SpyInstance {
  const module = require("@/runtime/powerBankBoost");
  return jest.spyOn(module, "prepareBoosts").mockReturnValue({ status, labs });
}

function mockReleaseBoostLabs(): jest.SpyInstance {
  const module = require("@/runtime/powerBankBoost");
  return jest.spyOn(module, "releaseBoostLabs").mockImplementation(() => {});
}

function setupOwnedCombatPair(options: {
  taskId: string;
  generation?: number;
  index?: number;
  roomName?: string;
  ticksToLive?: number;
}): { attacker: Creep; healer: Creep } {
  const generation = options.generation ?? 0;
  const index = options.index ?? generation;
  const roomName = options.roomName ?? TARGET_ROOM;
  const attackerConfigName = getPowerBankConfigName(
    SOURCE_ROOM,
    TARGET_ROOM,
    "attacker",
    index,
    options.taskId,
    generation,
  );
  const healerConfigName = getPowerBankConfigName(
    SOURCE_ROOM,
    TARGET_ROOM,
    "healer",
    index,
    options.taskId,
    generation,
  );
  const attacker = createMockPowerBankCreep("powerBankAttacker", {
    name: `attacker-g${generation}`,
    id: `attacker-g${generation}-id`,
    roomName,
    x: 24,
    y: 24,
    memory: {
      role: "powerBankAttacker",
      taskId: options.taskId,
      configName: attackerConfigName,
      pairGeneration: generation,
    } as Partial<CreepMemory>,
    body: [
      { type: TOUGH as BodyPartConstant, hits: 100 },
      { type: ATTACK as BodyPartConstant, hits: 100 },
      { type: MOVE as BodyPartConstant, hits: 100 },
    ],
  });
  const healer = createMockPowerBankCreep("powerBankHealer", {
    name: `healer-g${generation}`,
    id: `healer-g${generation}-id`,
    roomName,
    x: 25,
    y: 24,
    memory: {
      role: "powerBankHealer",
      taskId: options.taskId,
      configName: healerConfigName,
      pairGeneration: generation,
    } as Partial<CreepMemory>,
    body: [
      { type: HEAL as BodyPartConstant, hits: 100 },
      { type: MOVE as BodyPartConstant, hits: 100 },
    ],
  });
  if (options.ticksToLive !== undefined) {
    (attacker as Creep & { ticksToLive: number }).ticksToLive = options.ticksToLive;
    (healer as Creep & { ticksToLive: number }).ticksToLive = options.ticksToLive;
  }
  Game.creeps[attacker.name] = attacker;
  Game.creeps[healer.name] = healer;
  return { attacker, healer };
}

function mockObjects(...objects: Array<{ id: string }>): void {
  Game.getObjectById = jest.fn((id: string) =>
    objects.find((object) => object.id === id) ?? null,
  ) as unknown as typeof Game.getObjectById;
}

function setupReadyReinforcementHandoff(options: {
  taskId: string;
  activeAttackerTtl: number;
  activeHealerTtl: number;
  remainingAttackTicks?: number;
}): {
  active: { attacker: Creep; healer: Creep };
  reinforcement: { attacker: Creep; healer: Creep };
} {
  const remainingAttackTicks = options.remainingAttackTicks ?? 100;
  const active = setupOwnedCombatPair({ taskId: options.taskId, ticksToLive: options.activeAttackerTtl });
  (active.attacker as Creep & { ticksToLive: number }).ticksToLive = options.activeAttackerTtl;
  (active.healer as Creep & { ticksToLive: number }).ticksToLive = options.activeHealerTtl;
  const reinforcement = setupOwnedCombatPair({
    taskId: options.taskId,
    generation: 1,
    index: 1,
    ticksToLive: 1400,
  });
  const boostedDamage = POWER_BANK_BODY_TIERS[8].attacker
    .filter((part) => part === ATTACK).length * ATTACK_POWER * 4;
  const bank = createMockPowerBank({
    id: `${options.taskId}-bank`,
    hits: remainingAttackTicks * boostedDamage,
    ticksToDecay: 5000,
  });
  mockObjects(
    active.attacker as Creep & { id: string },
    active.healer as Creep & { id: string },
    reinforcement.attacker as Creep & { id: string },
    reinforcement.healer as Creep & { id: string },
    bank as StructurePowerBank & { id: string },
  );
  addTask(makeTask({
    id: options.taskId,
    status: POWER_BANK_STATUS.ATTACKING,
    sourceRoom: SOURCE_ROOM,
    bankId: bank.id,
    attackerId: active.attacker.id as string,
    healerId: active.healer.id as string,
    activeGeneration: 0,
    activeIndex: 0,
    combatReady: true,
    tier: 8,
    routeDistance: 2,
    bankExpiresAt: Game.time + 5000,
    lastBankHits: bank.hits,
    lastBankProgressAt: Game.time,
    reinforcement: {
      index: 1,
      generation: 1,
      stage: "attacking",
      attackerId: reinforcement.attacker.id as string,
      healerId: reinforcement.healer.id as string,
      attackerReady: true,
      healerReady: true,
      combatReady: true,
      boostOwnerId: `${options.taskId}:reinforcement:g1`,
      boostLabs: [],
    },
  }));
  return { active, reinforcement };
}

function resetPowerBankFixture(): void {
  jest.restoreAllMocks();
  Object.assign(global, { RoomPosition: MockPos });
  clearCreepMovementStateForTest();
  resetRuntimeServices();
  registerRuntimeServices();
  Game.time = 100;
  Game.creeps = {};
  Game.spawns = {};
  Game.rooms = {};
  Memory.creeps = {};
  setupGameMap();
  setupStore();
  clearDefenseModeCacheForTest();
  mockPrepareBoosts("ready");
  jest.spyOn(powerBankObserver, "requestPowerBankObservation").mockReturnValue(true);
  jest.spyOn(powerBankObserver, "getPowerBankRoomThreat").mockReturnValue(false);
  jest.spyOn(powerBankPathDistance, "measurePowerBankTravel").mockReturnValue({
    status: "ready",
    pathDistance: 100,
    combatTravelTicks: 100,
    haulerOutboundTravelTicks: 100,
    haulerReturnTravelTicks: 100,
  });
  jest.spyOn(powerBankPathDistance, "canMeasurePowerBankTravelThisTick").mockReturnValue(true);
}

describe("powerBankHarvest", () => {
  beforeEach(() => {
    resetPowerBankFixture();
  });

  it("取得当前 PB 视野且排除战斗威胁后才测路，等待不冒充失败", () => {
    setupSourceRoom();
    jest.spyOn(powerBankObserver, "hasPowerBankObserverCoverage").mockReturnValue(true);
    const task = makeTask({ bankExpiresAt: Game.time + 5000 });
    addTask(task);

    runPowerBankHarvest();
    expect(getTask(task.id)).toMatchObject({ status: "discovered", blocker: "target_not_visible" });
    expect(powerBankObserver.requestPowerBankObservation).toHaveBeenCalledWith(TARGET_ROOM);
    expect(powerBankPathDistance.measurePowerBankTravel).not.toHaveBeenCalled();
    task.stageEnteredAt = Game.time - 600;
    expect(getPowerBankLifecycleFailure(task)).toBeUndefined();
    expect(getPowerBankLifecycleFailure({ ...task, bankExpiresAt: Game.time })).toBe("bank_expired");

    Game.time += 1;
    setupTargetRoom();
    runPowerBankHarvest();
    expect(getTask(task.id)?.blocker).toBe("target_bank_unconfirmed");
    expect(powerBankPathDistance.measurePowerBankTravel).not.toHaveBeenCalled();

    Game.time += 1;
    setupDiscoveredBank(task);
    jest.mocked(powerBankObserver.getPowerBankRoomThreat).mockReturnValue(true);
    runPowerBankHarvest();
    expect(getTask(task.id)).toMatchObject({ status: "discovered", blocker: "target_combat_threat" });
    expect(powerBankPathDistance.measurePowerBankTravel).not.toHaveBeenCalled();
    expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
  });

  it("本来源 active Spawn 未测完不准入，但不否决其它完整可行来源", () => {
    setupOwnedRoom(SOURCE_ROOM, { spawnCount: 2 });
    setupOwnedRoom(SECONDARY_SOURCE_ROOM);
    jest.spyOn(powerBankObserver, "hasPowerBankObserverCoverage").mockReturnValue(true);
    const task = makeTask({ hits: 100_000, power: 1000, bankExpiresAt: Game.time + 5000 });
    setupDiscoveredBank(task);
    addTask(task);
    jest.mocked(powerBankPathDistance.measurePowerBankTravel).mockImplementation((input) => {
      if (input.sourceSpawnPos.roomName === SOURCE_ROOM && input.sourceSpawnPos.x === 12) {
        return { status: "pending", reason: "budget", retryAt: Game.time + 1 };
      }
      const secondary = input.sourceSpawnPos.roomName === SECONDARY_SOURCE_ROOM;
      return {
        status: "ready",
        pathDistance: secondary ? 80 : 400,
        combatTravelTicks: secondary ? 120 : 600,
        haulerOutboundTravelTicks: secondary ? 80 : 400,
        haulerReturnTravelTicks: secondary ? 140 : 650,
      };
    });

    runPowerBankHarvest();
    expect(powerBankPathDistance.measurePowerBankTravel).toHaveBeenCalledTimes(3);
    expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
    expect(getTask(task.id)).toMatchObject({
      status: "preparing_boosts",
      sourceRoom: SECONDARY_SOURCE_ROOM,
      routeDistance: 2,
      pathDistance: 80,
      combatTravelTicks: 120,
      haulerOutboundTravelTicks: 80,
      haulerReturnTravelTicks: 140,
    });
    const measuredTravel = { ...task, status: POWER_BANK_STATUS.TRAVELLING, combatTravelTicks: 700, routeDistance: 1 };
    expect(getPowerBankStageTimeout(measuredTravel)).toBe(950);
    expect(getPowerBankStageTimeout({ ...measuredTravel, combatTravelTicks: undefined })).toBe(300);
  });

  it("预算用尽仍先校验当前视野、Bank与威胁，但不扫描来源", () => {
    const source = setupOwnedRoom(SOURCE_ROOM);
    jest.spyOn(powerBankObserver, "hasPowerBankObserverCoverage").mockReturnValue(true);
    jest.mocked(powerBankPathDistance.canMeasurePowerBankTravelThisTick).mockReturnValue(false);
    const task = makeTask({ bankExpiresAt: Game.time + 5000 });
    addTask(task);

    runPowerBankHarvest();
    expect(task.blocker).toBe("target_not_visible");
    expect(powerBankPathDistance.canMeasurePowerBankTravelThisTick).not.toHaveBeenCalled();
    Game.time += 1;
    setupTargetRoom();
    runPowerBankHarvest();
    expect(task.blocker).toBe("target_bank_unconfirmed");
    expect(powerBankPathDistance.canMeasurePowerBankTravelThisTick).not.toHaveBeenCalled();
    Game.time += 1;
    setupDiscoveredBank(task);
    jest.mocked(powerBankObserver.getPowerBankRoomThreat).mockReturnValue(true);
    runPowerBankHarvest();
    expect(task.blocker).toBe("target_combat_threat");
    expect(powerBankPathDistance.canMeasurePowerBankTravelThisTick).not.toHaveBeenCalled();

    Game.time += 5;
    jest.mocked(powerBankObserver.getPowerBankRoomThreat).mockReturnValue(false);
    runPowerBankHarvest();
    expect(task).toMatchObject({ status: "discovered", sourceRoom: "", blocker: "path_measurement_pending", nextAttemptAt: Game.time + 1 });
    expect(task.lastSeenTick).toBe(Game.time);
    expect(powerBankPathDistance.measurePowerBankTravel).not.toHaveBeenCalled();
    expect(Game.map.findRoute).not.toHaveBeenCalled();
    expect(source.find).not.toHaveBeenCalled();
    expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
  });

  it("新测量耗尽预算即停止后续Lab物流评估，本来源未完整时继续等待", () => {
    setupOwnedRoom(SOURCE_ROOM, { spawnCount: 2 });
    const secondaryRoom = setupOwnedRoom(SECONDARY_SOURCE_ROOM);
    jest.spyOn(powerBankObserver, "hasPowerBankObserverCoverage").mockReturnValue(true);
    const task = makeTask({ hits: 100_000, power: 1000, bankExpiresAt: Game.time + 5000 });
    setupDiscoveredBank(task);
    addTask(task);
    let available = true;
    jest.mocked(powerBankPathDistance.canMeasurePowerBankTravelThisTick).mockImplementation(() => available);
    jest.mocked(powerBankPathDistance.measurePowerBankTravel).mockImplementation(() => {
      available = false;
      return { status: "ready", pathDistance: 400, combatTravelTicks: 600,
        haulerOutboundTravelTicks: 400, haulerReturnTravelTicks: 650 };
    });

    runPowerBankHarvest();
    expect(powerBankPathDistance.measurePowerBankTravel).toHaveBeenCalledTimes(1);
    // cheap route 预规划覆盖两个来源，但未有 PF 配额的来源不扫描 Lab/物流。
    expect(Game.map.findRoute).toHaveBeenCalledTimes(2);
    expect(secondaryRoom.find).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: "discovered", sourceRoom: "", blocker: "path_measurement_pending" });
    expect(task.pathDistance).toBeUndefined();

    expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
  });

  it("writes task ownership when a boosted pair transitions to travelling", () => {
    setupSourceRoom();
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
    const attacker = createMockPowerBankCreep("powerBankAttacker", {
      name: "attacker-0",
      id: "attacker-0-id",
      roomName: SOURCE_ROOM,
      memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      body: [
        { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
        { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
        { type: MOVE as BodyPartConstant, hits: 100 },
      ],
    });
    const healer = createMockPowerBankCreep("powerBankHealer", {
      name: "healer-0",
      id: "healer-0-id",
      roomName: SOURCE_ROOM,
      memory: { configName: healerConfigName, role: "powerBankHealer" },
    });
    delete (attacker.memory as PowerBankTestMemory).taskId;
    delete (healer.memory as PowerBankTestMemory).taskId;
    Game.creeps[attacker.name] = attacker;
    Game.creeps[healer.name] = healer;
    addTask(makeTask({
      id: "pb-taskid-test",
      status: POWER_BANK_STATUS.BOOSTING,
      sourceRoom: SOURCE_ROOM,
      tier: 8,
    }));

    runPowerBankHarvest();

    expect(getTask("pb-taskid-test")?.status).toBe(POWER_BANK_STATUS.TRAVELLING);
    expect((attacker.memory as PowerBankTestMemory).taskId).toBe("pb-taskid-test");
    expect((healer.memory as PowerBankTestMemory).taskId).toBe("pb-taskid-test");
  });

  it("defense 模式原子中止 boost 与源房 fail-closed 选择覆盖同一合同面", () => {
    setupSourceRoom();
    const releaseSpy = mockReleaseBoostLabs();
    const configName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const configStore = getCreepConfigService();
    configStore.add(configName, "powerBankAttacker", TARGET_ROOM);
    addTask(makeTask({
      status: POWER_BANK_STATUS.PREPARING_BOOSTS,
      sourceRoom: SOURCE_ROOM,
      tier: 8,
      boostLabs: ["lab-a", "lab-b"],
    }));
    jest.spyOn(require("@/runtime/defenseMode"), "isDefenseMode").mockReturnValue(true);

    runPowerBankHarvest();

    expect(getTask("pb-test")).toBeUndefined();
    expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
      taskId: "pb-test",
      status: POWER_BANK_STATUS.ABORTED,
      failReason: "defense_mode",
      terminalTick: Game.time,
    }));
    expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    expect(configStore.get(configName)).toBeUndefined();

    // Jest 预算归并：源房 fail-closed 选择（compounds/route）与 defense
    // 中止同属防御性放弃/重选合同面。
    {
      for (const rejectedBy of ["compounds", "route"] as const) {
        resetPowerBankFixture();
        setupOwnedRoom(SOURCE_ROOM, rejectedBy === "compounds" ? {
          compounds: {
            [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 1,
          },
        } : {});
        setupOwnedRoom(SECONDARY_SOURCE_ROOM);
        jest.spyOn(require("@/runtime/powerBankObserver"), "hasPowerBankObserverCoverage")
          .mockReturnValue(true);
        jest.spyOn(require("@/runtime/powerBankBoost"), "findBestDonorRoom").mockReturnValue(null);
        Game.map.findRoute = jest.fn((fromRoom: string) => {
          if (fromRoom === SOURCE_ROOM) {
            return rejectedBy === "route"
              ? ERR_NO_PATH
              : [{ room: TARGET_ROOM, exit: FIND_EXIT_RIGHT }];
          }
          return rejectedBy === "route"
            ? [{ room: TARGET_ROOM, exit: FIND_EXIT_RIGHT }]
            : [
                { room: "E4N60", exit: FIND_EXIT_RIGHT },
                { room: TARGET_ROOM, exit: FIND_EXIT_RIGHT },
              ];
        }) as typeof Game.map.findRoute;
        const discovered = makeTask({
          id: `pb-source-${rejectedBy}`,
          hits: 100_000,
          power: 1000,
          ticksToDecay: 5000,
          discoveredTick: Game.time,
          lastSeenTick: Game.time,
          bankExpiresAt: Game.time + 5000,
        });
        setupDiscoveredBank(discovered);
        addTask(discovered);

        runPowerBankHarvest();

        expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
        expect(getTask(`pb-source-${rejectedBy}`)).toMatchObject({
          status: POWER_BANK_STATUS.PREPARING_BOOSTS,
          sourceRoom: SECONDARY_SOURCE_ROOM,
          routeDistance: rejectedBy === "route" ? 1 : 2,
        });
      }
    }
  });

  it("主队可在当前寿命内打完时，增援准备时间不能触发第二队", () => {
    Game.time = 400;
    setupSourceRoom();
    const pair = setupOwnedCombatPair({ taskId: "pb-single-enough", ticksToLive: 400 });
    const bank = createMockPowerBank({ id: "bank-single-enough", hits: 500_000, ticksToDecay: 5000 });
    mockObjects(pair.attacker, pair.healer, bank);
    addTask(makeTask({
      id: "pb-single-enough", status: POWER_BANK_STATUS.ATTACKING,
      sourceRoom: SOURCE_ROOM, bankId: bank.id, tier: 8,
      attackerId: pair.attacker.id, healerId: pair.healer.id,
      activeGeneration: 0, activeIndex: 0, combatReady: true,
      routeDistance: 2, lastBankHits: bank.hits,
      lastBankProgressAt: Game.time, stageEnteredAt: Game.time,
      bankExpiresAt: Game.time + 5000,
    }));

    runPowerBankHarvest();

    expect(getTask("pb-single-enough")?.reinforcement).toBeUndefined();
    expect(Object.keys(Memory.data?.creepConfigs ?? {}).some((name) => name.includes(":attacker:1:") || name.includes(":healer:1:"))).toBe(false);
  });

  it("requests recovery at 100 idle ticks and fails closed after the 250-tick progress deadline", () => {
    Game.time = 400;
    setupSourceRoom();
    const pair = setupOwnedCombatPair({ taskId: "pb-stalled" });
    const bank = createMockPowerBank({ id: "bank-stalled", hits: 500_000, ticksToDecay: 5000 });
    mockObjects(
      pair.attacker as Creep & { id: string },
      pair.healer as Creep & { id: string },
      bank as StructurePowerBank & { id: string },
    );
    addTask(makeTask({
      id: "pb-stalled",
      status: POWER_BANK_STATUS.ATTACKING,
      sourceRoom: SOURCE_ROOM,
      bankId: bank.id,
      attackerId: pair.attacker.id as string,
      healerId: pair.healer.id as string,
      activeGeneration: 0,
      activeIndex: 0,
      combatReady: true,
      tier: 8,
      routeDistance: 2,
      lastBankHits: 500_000,
      lastBankProgressAt: Game.time - 101,
      stageEnteredAt: 100,
      bankExpiresAt: Game.time + 5000,
    }));
    addTask(makeTask({
      id: "pb-stalled-terminal",
      status: POWER_BANK_STATUS.ATTACKING,
      sourceRoom: SOURCE_ROOM,
      tier: 8,
      lastBankProgressAt: Game.time - 251,
      lastVisibleAt: Game.time,
      stageEnteredAt: 100,
      bankExpiresAt: Game.time + 5000,
    }));

    runPowerBankHarvest();

    expect(getTask("pb-stalled")?.reinforcement).toMatchObject({
      generation: 1,
      index: 1,
      stage: "spawning",
      combatReady: false,
      boostOwnerId: "pb-stalled:reinforcement:g1",
    });
    expect(getTask("pb-stalled-terminal")).toBeUndefined();
    expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
      taskId: "pb-stalled-terminal",
      status: POWER_BANK_STATUS.FAILED,
      failReason: "attack_no_progress",
    }));
  });

  it("atomically hands active ownership to a ready generation and retires only the old pair", () => {
    setupSourceRoom();
    const taskId = "pb-proactive-handoff-ownership";
    const { active, reinforcement } = setupReadyReinforcementHandoff({
      taskId,
      activeAttackerTtl: 175,
      activeHealerTtl: 400,
      remainingAttackTicks: 100,
    });
    const oldAttackerConfig = active.attacker.memory.configName!;
    const oldHealerConfig = active.healer.memory.configName!;
    const newAttackerConfig = reinforcement.attacker.memory.configName!;
    const newHealerConfig = reinforcement.healer.memory.configName!;
    const configStore = Memory.data!.creepConfigs ??= {};
    for (const [configName, role, generation] of [
      [oldAttackerConfig, "powerBankAttacker", 0],
      [oldHealerConfig, "powerBankHealer", 0],
      [newAttackerConfig, "powerBankAttacker", 1],
      [newHealerConfig, "powerBankHealer", 1],
    ] as const) {
      configStore[configName] = {
        role,
        args: [TARGET_ROOM, ""],
        roomName: SOURCE_ROOM,
        taskId,
        powerBankGeneration: generation,
      };
    }
    Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [
      oldAttackerConfig,
      oldHealerConfig,
      newAttackerConfig,
      newHealerConfig,
    ];

    runPowerBankHarvest();

    expect(getTask(taskId)).toMatchObject({
      activeGeneration: 1,
      activeIndex: 1,
      attackerId: reinforcement.attacker.id,
      healerId: reinforcement.healer.id,
      combatReady: true,
      primaryBoostOwnerId: `${taskId}:reinforcement:g1`,
    });
    expect(getTask(taskId)?.reinforcement).toBeUndefined();
    expect((active.attacker.memory as PowerBankTestMemory).taskId).toBeUndefined();
    expect((active.healer.memory as PowerBankTestMemory).taskId).toBeUndefined();
    expect(active.attacker.suicide).toHaveBeenCalledTimes(1);
    expect(active.healer.suicide).toHaveBeenCalledTimes(1);
    expect((reinforcement.attacker.memory as PowerBankTestMemory).taskId).toBe(taskId);
    expect((reinforcement.healer.memory as PowerBankTestMemory).taskId).toBe(taskId);
    expect(reinforcement.attacker.suicide).not.toHaveBeenCalled();
    expect(reinforcement.healer.suicide).not.toHaveBeenCalled();
    expect(getCreepConfigService().get(oldAttackerConfig)).toBeUndefined();
    expect(getCreepConfigService().get(oldHealerConfig)).toBeUndefined();
    expect(getCreepConfigService().get(newAttackerConfig)).toBeDefined();
    expect(getCreepConfigService().get(newHealerConfig)).toBeDefined();
    expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([
      newAttackerConfig,
      newHealerConfig,
    ]);
  });

  it("separates bank disappearance from terminal yield and records each terminal task once", () => {
    setupSourceRoom();
    setupTargetRoom();
    const pair = setupOwnedCombatPair({ taskId: "pb-bank-gone" });
    mockObjects(pair.attacker as Creep & { id: string }, pair.healer as Creep & { id: string });
    addTask(makeTask({
      id: "pb-bank-gone",
      status: POWER_BANK_STATUS.ATTACKING,
      sourceRoom: SOURCE_ROOM,
      attackerId: pair.attacker.id as string,
      healerId: pair.healer.id as string,
      activeGeneration: 0,
      activeIndex: 0,
      combatReady: true,
      tier: 8,
      bankExpiresAt: Game.time + 5000,
      lastBankProgressAt: Game.time,
    }));
    addTask(makeTask({
      id: "pb-zero-yield",
      status: POWER_BANK_STATUS.HAULING,
      sourceRoom: SOURCE_ROOM,
      power: 5000,
      observedPower: 0,
      pickedUpPower: 0,
      deliveredPower: 0,
      haulingEmptySince: Game.time - 100,
      haulingStartedTick: Game.time - 100,
      haulingDeadlineAt: Game.time + 1000,
      stageEnteredAt: Game.time - 100,
      bankExpiresAt: Game.time + 1000,
    }));
    addTask(makeTask({
      id: "pb-partial-delivery",
      status: POWER_BANK_STATUS.HAULING,
      sourceRoom: SOURCE_ROOM,
      power: 5000,
      observedPower: 5000,
      pickedUpPower: 3000,
      deliveredPower: 1000,
      haulingEmptySince: Game.time - 100,
      haulingStartedTick: Game.time - 100,
      haulingDeadlineAt: Game.time + 1000,
      stageEnteredAt: Game.time - 100,
      bankExpiresAt: Game.time + 1000,
    }));
    addTask(makeTask({
      id: "pb-terminal-once",
      status: POWER_BANK_STATUS.FAILED,
      sourceRoom: SOURCE_ROOM,
      terminalTick: Game.time,
      failReason: "test_terminal",
      outcome: "failed",
    }));

    runPowerBankHarvest();

    expect(getTask("pb-bank-gone")).toMatchObject({
      status: POWER_BANK_STATUS.HAULING,
      bankGoneTick: Game.time,
      haulingStartedTick: Game.time,
    });
    expect(getTask("pb-bank-gone")?.outcome).toBeUndefined();
    expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
      taskId: "pb-zero-yield",
      status: POWER_BANK_STATUS.FAILED,
      outcome: "contested",
      failReason: "power_not_observed_or_stolen",
      deliveredPower: 0,
      lostPower: 5000,
    }));
    expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
      taskId: "pb-partial-delivery",
      status: POWER_BANK_STATUS.COMPLETE,
      outcome: "partial",
      deliveredPower: 1000,
      lostPower: 4000,
    }));
    expect(Memory.data?.powerBankHarvestHistory?.filter((entry) => entry.taskId === "pb-terminal-once"))
      .toHaveLength(1);
    runPowerBankHarvest();
    expect(Memory.data?.powerBankHarvestHistory?.filter((entry) => entry.taskId === "pb-terminal-once"))
      .toHaveLength(1);
  });


  it("hauling cleanup removes combat configs left under a previous source room", () => {
    setupSourceRoom();
    setupTargetRoom();
    const staleRoom = setupOwnedRoom(SECONDARY_SOURCE_ROOM);
    const staleSpawn = Game.spawns[`${SECONDARY_SOURCE_ROOM}-spawn1`];

    const taskId = "pb-stale-room";
    const staleAttacker = getPowerBankConfigName(SECONDARY_SOURCE_ROOM, TARGET_ROOM, "attacker", 0, taskId, 0);
    const staleHealer = getPowerBankConfigName(SECONDARY_SOURCE_ROOM, TARGET_ROOM, "healer", 0, taskId, 0);
    const currentAttacker = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0, taskId, 0);
    const taskHauler = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "hauler", 0, taskId, 0);
    const configStore = Memory.data!.creepConfigs ??= {};
    configStore[staleAttacker] = {
      role: "powerBankAttacker",
      args: [TARGET_ROOM, `${SECONDARY_SOURCE_ROOM}|${TARGET_ROOM}`],
      roomName: SECONDARY_SOURCE_ROOM,
      taskId,
      powerBankGeneration: 0,
    };
    configStore[staleHealer] = {
      role: "powerBankHealer",
      args: [TARGET_ROOM, `${SECONDARY_SOURCE_ROOM}|${TARGET_ROOM}`],
      roomName: SECONDARY_SOURCE_ROOM,
      taskId,
      powerBankGeneration: 0,
    };
    configStore[currentAttacker] = {
      role: "powerBankAttacker",
      args: [TARGET_ROOM, `${SOURCE_ROOM}|${TARGET_ROOM}`],
      roomName: SOURCE_ROOM,
      taskId,
      powerBankGeneration: 0,
    };
    configStore[taskHauler] = {
      role: "powerBankHauler",
      args: [TARGET_ROOM, `${SOURCE_ROOM}|${TARGET_ROOM}`],
      roomName: SOURCE_ROOM,
      taskId,
    };
    staleSpawn.memory.spawnList = [staleAttacker, staleHealer];

    addTask(makeTask({
      id: taskId,
      status: POWER_BANK_STATUS.HAULING,
      sourceRoom: SOURCE_ROOM,
      power: 1000,
      observedPower: 1000,
      haulingStartedTick: Game.time,
      haulingDeadlineAt: Game.time + 1000,
      stageEnteredAt: Game.time,
      bankExpiresAt: Game.time + 1000,
    }));

    runPowerBankHarvest();

    expect(getCreepConfigService().get(staleAttacker)).toBeUndefined();
    expect(getCreepConfigService().get(staleHealer)).toBeUndefined();
    expect(getCreepConfigService().get(currentAttacker)).toBeUndefined();
    expect(getCreepConfigService().get(taskHauler)).toBeDefined();
    expect(staleSpawn.memory.spawnList).not.toContain(staleAttacker);
    expect(staleSpawn.memory.spawnList).not.toContain(staleHealer);
    expect(staleRoom).toBeDefined();
  });
});
