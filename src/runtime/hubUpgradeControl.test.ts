jest.mock("@/runtime/powerBankBoost", () => ({
  releaseBoostLabs: jest.fn(),
}));

import { HUB_UPGRADER_BODY, runHubUpgradeControl } from "@/runtime/hubUpgradeControl";
import { releaseBoostLabs } from "@/runtime/powerBankBoost";
import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
  RCL8_UPGRADER_RECOVERY_STOP_TICKS,
} from "@/runtime/upgraderPolicy";

const mockedReleaseBoostLabs = releaseBoostLabs as jest.MockedFunction<typeof releaseBoostLabs>;

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createUpgraderRoom(
  level = 7,
  my = true,
  name = "E4N58",
  ticksToDowngrade = level === 8 ? 200_000 : 150_000,
): Room {
  return {
    name,
    controller: { level, my, ticksToDowngrade } as StructureController,
    energyCapacityAvailable: 5600,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createUpgrader(
  name: string,
  configName: string,
  body: readonly BodyPartConstant[] = HUB_UPGRADER_BODY,
): Creep {
  const roomName = configName.split(":")[0]!;
  return {
    name,
    room: Game.rooms[roomName],
    memory: { role: "upgrader", configName },
    body: body.map((type) => ({
      type,
      hits: 100,
    })),
    suicide: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("runHubUpgradeControl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Memory.cfg = { hub: { enabled: true, hubRoomName: "E4N58" } } as Memory["cfg"];
    Memory.data = { creepConfigs: {} };
    Memory.runtime = {};
    Memory.creeps = {};
    Game.creeps = {};
    Game.spawns = {};
    delete Game.flags.RESERVE_E4N58;
    Game.rooms.E4N58 = createUpgraderRoom();
    delete Game.rooms.W1N57;
    delete Game.rooms.W1N58;
  });

  it("keeps RCL8 maintenance through the hysteresis band and cleans it at the stop threshold", () => {
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      RCL8_UPGRADER_RECOVERY_START_TICKS,
    );
    runHubUpgradeControl();
    const createdAt = Memory.data?.manualUpgraders?.E4N58?.createdAt;
    expect(Memory.data?.manualUpgraders?.E4N58?.maintenance).toBe(true);
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toMatchObject({
      role: "upgrader",
      args: ["E4N58"],
      roomName: "E4N58",
      body: [...RCL8_UPGRADER_MAINTENANCE_BODY],
    });
    expect(mockedReleaseBoostLabs).not.toHaveBeenCalled();
    Memory.runtime!.powerBankBoost = {
      "upgrader:E4N58": { taskId: "upgrader:E4N58", sourceRoomName: "E4N58", labs: {} },
      "hubUpgrade:E4N58": { taskId: "hubUpgrade:E4N58", sourceRoomName: "E4N58", labs: {} },
    };
    runHubUpgradeControl();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");

    delete Memory.runtime!.powerBankBoost;
    runHubUpgradeControl();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledTimes(2);

    Game.rooms.E4N58.controller!.ticksToDowngrade = RCL8_UPGRADER_RECOVERY_START_TICKS + 1;
    runHubUpgradeControl();
    expect(Memory.data?.manualUpgraders?.E4N58?.createdAt).toBe(createdAt);
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeDefined();

    const maintenance = createUpgrader(
      "maintenance",
      "E4N58:upgrader:0",
      RCL8_UPGRADER_MAINTENANCE_BODY,
    );
    Game.creeps.maintenance = maintenance;
    Game.rooms.E4N58.controller!.ticksToDowngrade = RCL8_UPGRADER_RECOVERY_STOP_TICKS;
    runHubUpgradeControl();
    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeUndefined();
    expect(maintenance.suicide).toHaveBeenCalledTimes(1);
  });

  it("removes the ordinary production chain without suiciding a live upgrader", () => {
    const configName = "E4N58:upgrader:0";
    const spawningName = "ordinary-spawning";
    const cancel = jest.fn(() => OK);
    const liveUpgrader = createUpgrader("ordinary-live", configName);
    Memory.data = {
      manualUpgraders: {
        E4N58: { createdAt: Game.time - 100, updatedAt: Game.time - 10 },
      },
      creepConfigs: {
        [configName]: {
          role: "upgrader",
          args: ["E4N58", "upgrader:E4N58"],
          roomName: "E4N58",
          body: [...HUB_UPGRADER_BODY],
        },
      },
    };
    Memory.creeps![spawningName] = {
      role: "upgrader",
      configName,
    } as CreepMemory;
    Game.creeps[liveUpgrader.name] = liveUpgrader;
    Game.spawns.Spawn1 = {
      memory: { spawnList: [configName, "keep"] },
      spawning: { name: spawningName, cancel },
    } as unknown as StructureSpawn;

    runHubUpgradeControl();

    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(["keep"]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(liveUpgrader.suicide).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });
});
