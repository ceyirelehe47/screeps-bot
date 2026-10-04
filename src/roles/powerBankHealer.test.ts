jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { createMockPowerBankCreep, type MockCreepConfig } from "@mock/powerBank";

const { moveToTarget } = jest.requireMock("@/roles/shared") as {
  clearMovementState: jest.Mock;
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const ATTACKER_ID = "attacker-0";
const HEALER_ID = "healer-0";
const HEALER_BODY = [
  { type: HEAL as BodyPartConstant, hits: 100 },
  { type: MOVE as BodyPartConstant, hits: 100 },
];

type TaskOverrides = Partial<PowerBankHarvestTask> & {
  activeGeneration?: number;
  combatReady?: boolean;
  routeRooms?: string[];
  avoidRooms?: string[];
};

function setupTask(overrides: TaskOverrides = {}): PowerBankHarvestTask {
  const task = {
    id: TASK_ID,
    status: "attacking",
    sourceRoom: "W1N1",
    targetRoom: TARGET_ROOM,
    bankId: "pb-0",
    bankPos: { x: 25, y: 25 },
    hits: 2_000_000,
    power: 5000,
    ticksToDecay: 5000,
    freeTiles: 8,
    discoveredTick: 100,
    lastSeenTick: 100,
    attackerId: ATTACKER_ID,
    healerId: HEALER_ID,
    attackerReady: true,
    healerReady: true,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
    ...overrides,
  } as PowerBankHarvestTask;
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.powerBankHarvest) Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvest[TASK_ID] = task;
  return task;
}

function pairMemory(role: "powerBankAttacker" | "powerBankHealer", generation?: number): Partial<CreepMemory> {
  return {
    role,
    taskId: TASK_ID,
    ...(generation === undefined ? {} : { pairGeneration: generation }),
  } as Partial<CreepMemory>;
}

function setupPair(
  attackerOverrides: Partial<MockCreepConfig> = {},
  healerOverrides: Partial<MockCreepConfig> = {},
  generation?: number,
): { attacker: Creep; healer: Creep } {
  const attacker = createMockPowerBankCreep("powerBankAttacker", {
    id: ATTACKER_ID,
    name: ATTACKER_ID,
    roomName: TARGET_ROOM,
    x: 25,
    y: 25,
    ...attackerOverrides,
    memory: {
      ...pairMemory("powerBankAttacker", generation),
      ...(attackerOverrides.memory ?? {}),
    },
  });
  const healer = createMockPowerBankCreep("powerBankHealer", {
    id: HEALER_ID,
    name: HEALER_ID,
    roomName: attacker.room.name,
    x: attacker.pos.x - 1,
    y: attacker.pos.y,
    body: HEALER_BODY,
    ...healerOverrides,
    memory: {
      ...pairMemory("powerBankHealer", generation),
      ...(healerOverrides.memory ?? {}),
    },
  });
  Game.creeps = { [attacker.name]: attacker, [healer.name]: healer };
  (Game.getObjectById as jest.Mock) = jest.fn((id: string) =>
    Object.values(Game.creeps).find((creep) => creep.id === id) ?? null
  );
  return { attacker, healer };
}

describe("powerBankHealerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCreepMovementStateForTest();
    Game.time = 1000;
    (Memory as any).data = {};
    (Memory as any).runtime = {};
    Game.creeps = {} as Record<string, Creep>;
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    (Game as any).map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
    };
  });

  it("retires an orphaned powerbank healer after task cleanup", () => {
    const healer = createMockPowerBankCreep("powerBankHealer", {
      roomName: TARGET_ROOM,
      body: HEALER_BODY,
      memory: {
        role: "powerBankHealer",
        taskId: TASK_ID,
        configName: "W1N1:powerbank:E3N60:healer:owner:task:g1",
      } as Partial<CreepMemory>,
    });

    powerBankHealerRole(TARGET_ROOM).source?.(healer);

    expect(healer.suicide).toHaveBeenCalled();
    expect(healer.heal).not.toHaveBeenCalled();
  });

  it("heals and approaches the exact task-owned attacker during combat", () => {
    setupTask();
    const { attacker, healer } = setupPair(
      { x: 25, y: 25, hits: 3000, hitsMax: 4000 },
      { x: 28, y: 25 },
    );

    powerBankHealerRole(TARGET_ROOM).target(healer);

    expect(healer.rangedHeal).toHaveBeenCalledWith(attacker);
    expect(moveToTarget).toHaveBeenCalledWith(
      healer,
      attacker,
      1,
      expect.objectContaining({ maxRooms: 1, ignoreCreeps: false, reusePath: 0 }),
    );
  });

  it("recovers its HEAL when the attacker is full and reflection cannot be sustained", () => {
    setupTask();
    const { attacker, healer } = setupPair({}, { hits: 3100, hitsMax: 5000,
      body: [...Array.from({ length: 25 }, (_, i) => ({ type: HEAL, hits: i < 19 ? 0 : 100 })),
        ...Array.from({ length: 25 }, () => ({ type: MOVE, hits: 100 }))] });
    powerBankHealerRole(TARGET_ROOM).target(healer);
    expect(healer.heal).toHaveBeenCalledWith(healer);
    expect(healer.heal).not.toHaveBeenCalledWith(attacker);
  });
});
