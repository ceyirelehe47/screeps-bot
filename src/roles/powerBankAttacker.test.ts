jest.mock("@/runtime/runtimeServices", () => ({ getTickContextService: jest.fn() }));
jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn(() => ({ get: () => 0 })) }));
jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { powerBankAttackerRole } from "@/roles/powerBankAttacker";
import { clearCreepMovementStateForTest, getCreepMovementState } from "@/movement/creepState";
import {
  createMockPowerBankCreep,
  createMockPowerBank,
  MockPos,
  type MockCreepConfig,
} from "@mock/powerBank";

const { clearMovementState, moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  clearMovementState: jest.Mock;
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const { getTickContextService } = jest.requireMock("@/runtime/runtimeServices") as { getTickContextService: jest.Mock };

const TARGET_ROOM = "E3N60";
const TASK_ID = "task-0";
const BANK_ID = "powerbank-0";
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
    bankId: BANK_ID,
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
    x: 24,
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
  return { attacker, healer };
}

function setupBank() {
  const bank = createMockPowerBank({ id: BANK_ID, roomName: TARGET_ROOM });
  (Game.getObjectById as jest.Mock) = jest.fn((id: string) => {
    if (id === BANK_ID) return bank;
    return Object.values(Game.creeps).find((creep) => creep.id === id) ?? null;
  });
  return bank;
}

describe("powerBankAttackerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCreepMovementStateForTest();
    Object.assign(global, { RoomPosition: MockPos });
    Game.time = 1000;
    Game.creeps = {} as Record<string, Creep>;
    getTickContextService.mockReturnValue({ getRoomContext: (owner: Room | string) => {
      const name = typeof owner === "string" ? owner : owner.name;
      return {
        room: typeof owner === "string" ? { name } : owner,
        getMyCreeps: () => Object.values(Game.creeps).filter((creep) => creep.room.name === name),
        getStructures: () => [], getConstructionSites: () => [], getSources: () => [], getMinerals: () => [], getDeposits: () => [],
      };
    } });
    (Memory as any).data = {};
    (Memory as any).runtime = {};
  });

  it("attacks only the task-owned bank when the pair is combat ready", () => {
    setupTask();
    const bank = setupBank();
    const { attacker } = setupPair();

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).toHaveBeenCalledTimes(1);
    expect(attacker.attack).toHaveBeenCalledWith(bank);
    expect(clearMovementState).toHaveBeenCalledWith(attacker);
  });

  it("does not bind a same-task healer whose member ID is not task-owned", () => {
    setupTask({ healerId: "expected-healer" });
    setupBank();
    const { attacker } = setupPair();

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("moves inward and brings the exact follower through a proven split room boundary", () => {
    setupTask({ status: "travelling", attackerReady: true, healerReady: true });
    const { attacker, healer } = setupPair(
      { roomName: "E0N0", x: 0, y: 25 },
      { roomName: "W0N0", x: 48, y: 25 },
    );
    (Game as any).map = { getRoomTerrain: jest.fn(() => ({ get: () => 0 })), describeExits: jest.fn((name: string) => name === "W0N0" ? { [RIGHT]: "E0N0" } : { [LEFT]: "W0N0" }) };

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(healer.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(attacker)?.pathingRequestedAt).toBe(Game.time);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(attacker.attack).not.toHaveBeenCalled();
  });

  it("falls back to the traffic path when occupied-aware Bank pathing has no route", () => {
    setupTask();
    setupBank();
    const { attacker } = setupPair({ x: 10, y: 10 }, { x: 11, y: 10 });
    (attacker.attack as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);
    moveToTarget.mockReturnValueOnce(ERR_NO_PATH).mockReturnValueOnce(OK);

    powerBankAttackerRole(TARGET_ROOM).target(attacker);

    expect(moveToTarget).toHaveBeenNthCalledWith(
      1,
      attacker,
      expect.anything(),
      1,
      expect.objectContaining({ ignoreCreeps: false, reusePath: 0 }),
    );
    expect(moveToTarget).toHaveBeenNthCalledWith(
      2,
      attacker,
      expect.anything(),
      1,
      expect.objectContaining({ ignoreCreeps: true, reusePath: 0 }),
    );
  });
});
