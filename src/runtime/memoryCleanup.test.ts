import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import {
  clearPickupReservationStoreForTest,
  getPickupReservationsByRoom,
} from "@/runtime/energyPickupReservation";
import {
  listProductionReservations,
  reserveProductionResource,
} from "@/runtime/resourceReservation";
import type { CreepConfig } from "@/types/system";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

const SUPPORTED_ROLE_NAMES = [
  "harvester",
  "mineralHarvester",
  "miner",
  "carrier",
  "worker",
  "upgrader",
  "hubUpgrader",
  "scout",
  "claimer",
  "colonizerHarvester",
  "colonizerWorker",
  "meleeAttacker",
  "healer",
  "homeDefender",
  "crossShardClaimer",
  "crossShardColonizerHarvester",
  "crossShardColonizerWorker",
  "flagScout",
  "remoteCarrier",
  "remoteMiningCarrier",
  "powerBankScout",
  "powerBankAttacker",
  "powerBankHealer",
  "powerBankHauler",
  "remoteMiningReserver",
  "remoteWorker",
  "remoteDefender",
] as const satisfies readonly CreepMemory["role"][];

const UNSUPPORTED_ROLE_NAMES = ["unknownRole", "constructor", "toString", "__proto__"] as const;

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createOwnedRoom(name: string): Room {
  return {
    name,
    memory: {} as RoomMemory,
    controller: { my: true, level: 8 } as StructureController,
    find: () => [],
  } as unknown as Room;
}

function createManagedCreep(configName: string, role: CreepMemory["role"]): Creep {
  return { memory: { configName, role } as CreepMemory } as unknown as Creep;
}

type ManagedWorkforceRole = "harvester" | "miner" | "mineralHarvester" | "carrier" | "worker";

interface CanonicalManagedConfigFixture {
  configName: string;
  config: CreepConfig;
}

function createCanonicalManagedConfig(
  roomName: string,
  role: ManagedWorkforceRole,
  discriminator: string | number,
): CanonicalManagedConfigFixture {
  const discriminatorText = String(discriminator);
  const args = role === "carrier" || role === "worker" ? [] : [discriminatorText];
  return {
    configName: `${roomName}:${role}:${discriminatorText}`,
    config: { role, args, roomName },
  };
}

function createSpawn(
  name: string,
  room: Room,
  queue: string[],
  options: { active?: boolean; spawningName?: string } = {},
): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    room,
    memory: { spawnList: [...queue] },
    spawning: options.spawningName ? ({ name: options.spawningName } as Spawning) : null,
    isActive: jest.fn(() => options.active ?? true),
  } as unknown as StructureSpawn;
}

function snapshotManagedGcState(): {
  configs: Record<string, CreepConfig>;
  queues: Record<string, string[]>;
} {
  return {
    configs: Object.fromEntries(
      Object.entries(Memory.data?.creepConfigs ?? {}).map(([configName, config]) => [
        configName,
        { ...config, args: [...config.args] },
      ]),
    ),
    queues: Object.fromEntries(
      Object.values(Game.spawns).map((spawn) => [spawn.name, [...(spawn.memory.spawnList ?? [])]]),
    ),
  };
}

describe("runMemoryCleanup", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearPickupReservationStoreForTest();
    Game.time = 17;
    Game.rooms = { W1N1: createOwnedRoom("W1N1") };
    Game.creeps = {};
    Game.spawns = {};
    getPickupReservationsByRoom("W2N2").target1 = {
      kind: "structure",
      claims: { DeadCarrier: { amount: 50, until: 10 } },
    };
    Memory.creeps = {};
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("does not prune link-network cache outside the 17-tick cadence", () => {
    Game.time = 18;
    Memory.runtime = {
      linkNetwork: {
        W1N1: { updatedAt: 10, senderIds: ["owned-sender"], receiverIds: ["owned-receiver"] },
        W9N9: { updatedAt: 11, senderIds: ["unseen-sender"], receiverIds: ["unseen-receiver"] },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Memory.runtime?.linkNetwork).toEqual({
      W1N1: { updatedAt: 10, senderIds: ["owned-sender"], receiverIds: ["owned-receiver"] },
      W9N9: { updatedAt: 11, senderIds: ["unseen-sender"], receiverIds: ["unseen-receiver"] },
    });
  });

  it("expires terminal War owners by completedAt with legacy statusSince fallback", () => {
    Game.time = 221;
    const configName = "W1N1:war:W2N2:meleeAttacker:0";
    const survivor = {
      name: "war-survivor",
      memory: {
        role: "meleeAttacker",
        roleArgs: ["W2N2", "", "", "", ""],
        configName,
      },
      suicide: jest.fn(() => OK),
    } as unknown as Creep;
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [configName]);
    Game.creeps = { [survivor.name]: survivor };
    Game.spawns = { [spawn.name]: spawn };
    Memory.data = {
      war: {
        W2N2: {
          targetRoom: "W2N2",
          sourceRoom: "W1N1",
          status: "done",
          reason: "npc_reservation",
          attempts: 1,
          createdAt: 1,
          statusSince: 20,
          completedAt: 20,
          updatedAt: 220,
        },
        W3N3: {
          targetRoom: "W3N3",
          sourceRoom: "W1N1",
          status: "failed",
          reason: "npc_reservation",
          attempts: 1,
          createdAt: 1,
          statusSince: 20,
          updatedAt: 220,
        },
      },
      creepConfigs: {
        [configName]: { role: "meleeAttacker", args: [...survivor.memory.roleArgs!], roomName: "W1N1" },
      },
    } as Memory["data"];

    runMemoryCleanup();

    expect(Memory.data?.war).toEqual({});
    expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual([]);
    expect(survivor.memory._warDetached).toBe(true);
    expect(survivor.memory.configName).toBeUndefined();
    expect(survivor.suicide).not.toHaveBeenCalled();
  });

  it("keeps owned link cache while pruning visible-lost/unseen cache and dead creep memory", () => {
    const visibleLostRoom = createOwnedRoom("W2N2");
    visibleLostRoom.controller!.my = false;
    Game.rooms = { W1N1: createOwnedRoom("W1N1"), W2N2: visibleLostRoom };
    Memory.creeps.DeadWorker = { role: "worker" } as CreepMemory;
    Memory.runtime = {
      linkNetwork: {
        W1N1: { updatedAt: 10, senderIds: ["owned-sender"], receiverIds: ["owned-receiver"] },
        W2N2: { updatedAt: 11, senderIds: ["lost-sender"], receiverIds: ["lost-receiver"] },
        W9N9: { updatedAt: 12, senderIds: ["unseen-sender"], receiverIds: ["unseen-receiver"] },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Memory.creeps.DeadWorker).toBeUndefined();
    expect(Memory.runtime?.linkNetwork).toEqual({
      W1N1: { updatedAt: 10, senderIds: ["owned-sender"], receiverIds: ["owned-receiver"] },
    });
  });

  it("deletes idle and orphans live canonical configs for reserved and lost rooms", () => {
    const reservedRoom = createOwnedRoom("W4N4");
    Game.rooms = { W1N1: Game.rooms.W1N1, W4N4: reservedRoom };
    Memory.cfg = { rooms: { W4N4: { type: "reserved" } } };
    const reservedIdle = createCanonicalManagedConfig("W4N4", "worker", 0);
    const reservedLive = createCanonicalManagedConfig("W4N4", "carrier", 0);
    const lostIdle = createCanonicalManagedConfig("W9N9", "worker", 8);
    const lostLive = [
      createCanonicalManagedConfig("W9N9", "harvester", "source-h"),
      createCanonicalManagedConfig("W9N9", "miner", "source-m"),
      createCanonicalManagedConfig("W9N9", "mineralHarvester", "mineral-a"),
      createCanonicalManagedConfig("W9N9", "carrier", 0),
      createCanonicalManagedConfig("W9N9", "worker", 0),
    ];
    const fixtures = [reservedIdle, reservedLive, lostIdle, ...lostLive];
    Memory.data = {
      creepConfigs: Object.fromEntries(fixtures.map(({ configName, config }) => [configName, config])),
    };
    Game.creeps = {
      ReservedCarrier: createManagedCreep(reservedLive.configName, reservedLive.config.role),
      ...Object.fromEntries(lostLive.map(({ configName, config }, index) => [
        `LostManaged${index}`,
        createManagedCreep(configName, config.role),
      ])),
    };
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, fixtures.map(({ configName }) => configName));
    Game.spawns = { [spawn.name]: spawn };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[reservedIdle.configName]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[lostIdle.configName]).toBeUndefined();
    for (const { configName, config } of [reservedLive, ...lostLive]) {
      expect(Memory.data?.creepConfigs?.[configName]).toEqual({ role: config.role, args: config.args });
    }
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("preserves Game and Spawn-memory in-flight references before dead-memory cleanup", () => {
    const gameSpawning = createCanonicalManagedConfig("W8N8", "worker", 0);
    const memorySpawning = createCanonicalManagedConfig("W8N8", "carrier", 0);
    Memory.data = {
      creepConfigs: {
        [gameSpawning.configName]: gameSpawning.config,
        [memorySpawning.configName]: memorySpawning.config,
      },
    };
    const gameSpawningName = "GameSpawningWorker";
    Game.creeps[gameSpawningName] = {
      ...createManagedCreep(gameSpawning.configName, gameSpawning.config.role),
      name: gameSpawningName,
      spawning: true,
    } as Creep;
    Memory.creeps[gameSpawningName] = {
      role: gameSpawning.config.role,
      configName: gameSpawning.configName,
    } as CreepMemory;
    const memorySpawningName = "MemorySpawningCarrier";
    Memory.creeps[memorySpawningName] = {
      role: memorySpawning.config.role,
      configName: memorySpawning.configName,
    } as CreepMemory;
    const spawnA = createSpawn("SpawnA", Game.rooms.W1N1, [gameSpawning.configName], {
      spawningName: gameSpawningName,
    });
    const spawnB = createSpawn("SpawnB", Game.rooms.W1N1, [memorySpawning.configName], {
      spawningName: memorySpawningName,
    });
    Game.spawns = { [spawnA.name]: spawnA, [spawnB.name]: spawnB };

    runMemoryCleanup();

    for (const { configName, config } of [gameSpawning, memorySpawning]) {
      expect(Memory.data?.creepConfigs?.[configName]).toEqual({ role: config.role, args: config.args });
    }
    expect(Memory.creeps[gameSpawningName]).toBeDefined();
    expect(Memory.creeps[memorySpawningName]).toBeDefined();
    expect(spawnA.memory.spawnList).toEqual([]);
    expect(spawnB.memory.spawnList).toEqual([]);
  });

  it("preserves canonical-looking mismatches and manual queued configs fail-safe", () => {
    const fixtures: Record<string, CreepConfig> = {
      "W6N6:worker:0": { role: "carrier", args: [], roomName: "W6N6" },
      "W6N6:carrier:0": { role: "carrier", args: ["unexpected"], roomName: "W6N6" },
      "W6N6:worker:1": { role: "worker", args: [], roomName: "W6N7" },
      [`W1N1:manual:maxcarrier:${Game.time}`]: {
        role: "carrier",
        args: [],
        roomName: "W1N1",
        body: [CARRY, MOVE],
      },
    };
    const queue = Object.keys(fixtures);
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, queue);
    Game.spawns = { [spawn.name]: spawn };
    Memory.data = { creepConfigs: fixtures };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs).toEqual(fixtures);
    expect(spawn.memory.spawnList).toEqual(queue);
  });

  it("collects expired reservations, stale recovery entries, and orphaned power-bank boost state", () => {
    reserveProductionResource("W1N1", "energy" as ResourceConstant, 500, "expiredCarrier");
    Memory.runtime!.resourceReservations!["W1N1:energy:ow2:lu:0:expiredCarrier"].expiresAt = Game.time - 1; // v4 canonical token key
    reserveProductionResource("W1N1", "energy" as ResourceConstant, 300, "activeCarrier");
    Memory.cfg = {
      energyPickup: { terminalBootstrapRecoveryRooms: { W1N1: true, W2N2: false } },
    };
    Memory.runtime = {
      ...Memory.runtime,
      energyPickup: {
        terminalBootstrapRecovery: {
          W1N1: { healthySince: 10, lastObservedAt: 16 },
          W2N2: { healthySince: 11, lastObservedAt: 16 },
          W3N3: { healthySince: 12, lastObservedAt: 16 },
        },
      },
      powerBankBoost: {
        "pb-ghost": {
          taskId: "pb-ghost",
          sourceRoomName: "W1N1",
          labs: {
            [RESOURCE_CATALYZED_UTRIUM_ACID]: {
              labId: "W1N1-lab-1",
              compound: RESOURCE_CATALYZED_UTRIUM_ACID,
            },
          },
        },
      },
      synthesisControl: {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W1N1: {
            stage: "idle",
            lastTransitionAt: Game.time,
            boostPause: {
              reason: "powerBankBoost",
              taskId: "pb-ghost",
              createdTick: Game.time - 200,
              pausedPlan: null,
              pausedStage: "synthesizing",
            },
          },
        },
      },
    } as unknown as Memory["runtime"];
    Memory.data = { powerBankHarvest: {} } as Memory["data"];

    runMemoryCleanup();

    expect(getPickupReservationsByRoom("W2N2")).toEqual({});
    expect(listProductionReservations()).toEqual([
      expect.objectContaining({ holderId: "activeCarrier", amount: 300 }),
    ]);
    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery).toEqual({
      W1N1: { healthySince: 10, lastObservedAt: 16 },
    });
    expect(Memory.runtime?.powerBankBoost?.["pb-ghost"]).toBeUndefined();
    expect((Memory.runtime as any).synthesisControl.rooms.W1N1.boostPause).toBeUndefined();
  });

  it("keeps every catalog role, rejects prototype-like roles, and converges idempotently", () => {
    const supported = Object.fromEntries(SUPPORTED_ROLE_NAMES.map((role) => [
      `manual:role-catalog:${role}`,
      { role, args: [] } as CreepConfig,
    ]));
    const unsupported = Object.fromEntries(UNSUPPORTED_ROLE_NAMES.map((role) => [
      `manual:invalid-role:${role}`,
      { role, args: [] } as unknown as CreepConfig,
    ]));
    const originalQueue = [...Object.keys(unsupported), ...Object.keys(supported)];
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, originalQueue);
    Game.spawns = { [spawn.name]: spawn };
    Memory.data = { creepConfigs: { ...supported, ...unsupported } };

    runMemoryCleanup();
    for (const configName of Object.keys(supported)) {
      expect(Memory.data?.creepConfigs?.[configName]).toEqual(supported[configName]);
    }
    for (const configName of Object.keys(unsupported)) {
      expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    }
    expect(spawn.memory.spawnList).toEqual(originalQueue);

    Game.time += 17;
    runMemoryCleanup();
    expect(spawn.memory.spawnList).toEqual(Object.keys(supported));
    const converged = snapshotManagedGcState();
    runMemoryCleanup();
    expect(snapshotManagedGcState()).toEqual(converged);
  });
});
