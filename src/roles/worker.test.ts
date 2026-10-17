jest.mock("@/roles/energyTargets", () => ({
  pickupEnergyFromPreferredTarget: jest.fn(),
}));

jest.mock("@/roles/shared", () => ({
  moveToRemoteWorkTarget: jest.fn(),
  moveToTarget: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => ScreepsReturnCode) => fn()),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  releasePickupReservation: jest.fn(),
}));

jest.mock("@/runtime/workerTaskPool", () => ({
  assignWorkerTask: jest.fn(),
  completeWorkerTaskIfDone: jest.fn(),
  getWorkerTaskTarget: jest.fn(),
  isWorkerTaskSafeForCreep: jest.fn(),
  releaseWorkerTask: jest.fn(),
  deferUnreachableWorkerTask: jest.fn(),
}));

import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { moveToRemoteWorkTarget, moveToTarget } from "@/roles/shared";
import { workerRole } from "@/roles/worker";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import {
  assignWorkerTask,
  completeWorkerTaskIfDone,
  getWorkerTaskTarget,
  isWorkerTaskSafeForCreep,
  releaseWorkerTask,
  deferUnreachableWorkerTask,
} from "@/runtime/workerTaskPool";
import type { WorkerTask, WorkerTaskType } from "@/types/system";

const mockedPickupEnergy = pickupEnergyFromPreferredTarget as jest.MockedFunction<
  typeof pickupEnergyFromPreferredTarget
>;
const mockedMoveToRemoteWorkTarget = moveToRemoteWorkTarget as jest.MockedFunction<
  typeof moveToRemoteWorkTarget
>;
const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;
const mockedReleasePickupReservation = releasePickupReservation as jest.MockedFunction<
  typeof releasePickupReservation
>;
const mockedAssignWorkerTask = assignWorkerTask as jest.MockedFunction<typeof assignWorkerTask>;
const mockedCompleteWorkerTaskIfDone = completeWorkerTaskIfDone as jest.MockedFunction<
  typeof completeWorkerTaskIfDone
>;
const mockedGetWorkerTaskTarget = getWorkerTaskTarget as jest.MockedFunction<
  typeof getWorkerTaskTarget
>;
const mockedIsWorkerTaskSafeForCreep = isWorkerTaskSafeForCreep as jest.MockedFunction<
  typeof isWorkerTaskSafeForCreep
>;
const mockedReleaseWorkerTask = releaseWorkerTask as jest.MockedFunction<
  typeof releaseWorkerTask
>;

interface MutableEnergy {
  value: number;
  capacity: number;
}

const target = {
  id: "worker-target-1",
  pos: { x: 20, y: 21, roomName: "W1N1" } as RoomPosition,
} as unknown as RoomObject;

function createTask(type: WorkerTaskType): WorkerTask {
  return {
    id: `${type}:worker-target-1`,
    type,
    targetId: "worker-target-1",
    roomName: "W1N1",
    priority: 300,
    assignedCreeps: ["worker-1"],
    maxAssignees: 1,
    status: "active",
    updatedAt: 100,
  };
}

function createCreep(initialEnergy = 50, capacity = 100): {
  creep: Creep;
  energy: MutableEnergy;
} {
  const energy = { value: initialEnergy, capacity };
  const creep = {
    name: "worker-1",
    room: { name: "W1N1" } as Room,
    memory: { role: "worker" },
    pos: { getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? energy.value : 0,
      getFreeCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY
          ? energy.capacity - energy.value
          : 0,
    },
    build: jest.fn(() => OK),
    upgradeController: jest.fn(() => OK),
    repair: jest.fn(() => OK),
    dismantle: jest.fn(() => OK),
  } as unknown as Creep;

  return { creep, energy };
}

function getActionMock(creep: Creep, type: WorkerTaskType): jest.Mock {
  if (type === "build") return creep.build as jest.Mock;
  if (type === "upgrade") return creep.upgradeController as jest.Mock;
  if (type === "repair") return creep.repair as jest.Mock;
  return creep.dismantle as jest.Mock;
}

function expectMovementFor(creep: Creep, type: WorkerTaskType): void {
  if (type === "dismantle") {
    expect(mockedMoveToTarget).toHaveBeenCalledWith(creep, target.pos, 1, {
      swampCost: 8,
      reusePath: 5,
      ignoreCreeps: true,
    });
    expect(mockedMoveToRemoteWorkTarget).not.toHaveBeenCalled();
    return;
  }

  expect(mockedMoveToRemoteWorkTarget).toHaveBeenCalledWith(creep, target);
  expect(mockedMoveToTarget).not.toHaveBeenCalled();
}

function arrangeTask(type: WorkerTaskType): WorkerTask {
  const task = createTask(type);
  mockedAssignWorkerTask.mockReturnValue(task);
  mockedGetWorkerTaskTarget.mockReturnValue(target);
  return task;
}

function resetWorkerFixture(): void {
  jest.clearAllMocks();
  mockedPickupEnergy.mockReturnValue({ picked: false, outOfRange: false });
  mockedMoveToRemoteWorkTarget.mockReturnValue(OK);
  mockedMoveToTarget.mockReturnValue(OK);
  mockedAssignWorkerTask.mockReturnValue(null);
  mockedGetWorkerTaskTarget.mockReturnValue(target);
  mockedIsWorkerTaskSafeForCreep.mockReturnValue(true);
  mockedCompleteWorkerTaskIfDone.mockReturnValue(false);
}

beforeEach(resetWorkerFixture);

describe("workerRole", () => {
  it("switches from source after a pickup or when the store becomes full", () => {
    for (const scenario of [
      { label: "picked energy", pickup: { picked: true, outOfRange: false }, energy: 20 },
      { label: "became full", pickup: { picked: false, outOfRange: false }, energy: 100 },
    ]) {
      resetWorkerFixture();
      const { creep } = createCreep(scenario.energy, 100);
      mockedPickupEnergy.mockReturnValue(scenario.pickup);

      expect(workerRole().source!(creep)).toBe(true);
      expect(mockedPickupEnergy).toHaveBeenCalledWith(creep, { swampCost: 8 });
      expect(mockedReleasePickupReservation).toHaveBeenCalledWith(creep);
    }
  });

  it("stays in source while no pickup exists or energy movement is pending", () => {
    for (const scenario of [
      { label: "no pickup target", pickup: { picked: false, outOfRange: false } },
      { label: "walking to energy", pickup: { picked: false, outOfRange: true } },
    ]) {
      resetWorkerFixture();
      const { creep } = createCreep(0, 100);
      mockedPickupEnergy.mockReturnValue(scenario.pickup);

      expect(workerRole().source!(creep)).toBe(false);
      expect(mockedReleasePickupReservation).not.toHaveBeenCalled();
    }
  });

  it("handles missing, vanished, and unsafe task preconditions without issuing work", () => {
    for (const energy of [50, 0]) {
      resetWorkerFixture();
      const { creep } = createCreep(energy);
      expect(workerRole().target(creep)).toBe(energy === 0);
      expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
    }

    resetWorkerFixture();
    const missingTask = arrangeTask("build");
    const { creep: missingTargetCreep } = createCreep(0);
    mockedGetWorkerTaskTarget.mockReturnValue(null);
    expect(workerRole().target(missingTargetCreep)).toBe(true);
    expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(missingTargetCreep);
    expect(mockedIsWorkerTaskSafeForCreep).not.toHaveBeenCalled();
    expect(getActionMock(missingTargetCreep, missingTask.type)).not.toHaveBeenCalled();

    resetWorkerFixture();
    const unsafeTask = arrangeTask("repair");
    const { creep: unsafeCreep } = createCreep(50);
    mockedIsWorkerTaskSafeForCreep.mockReturnValue(false);
    expect(workerRole().target(unsafeCreep)).toBe(false);
    expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(unsafeCreep);
    expect(getActionMock(unsafeCreep, unsafeTask.type)).not.toHaveBeenCalled();
  });

  it("executes every supported task with its role-specific movement contract", () => {
    for (const type of ["build", "upgrade", "repair", "dismantle"] as WorkerTaskType[]) {
      resetWorkerFixture();
      const task = arrangeTask(type);
      const { creep } = createCreep(50);

      expect(workerRole().target(creep)).toBe(false);
      expect(getActionMock(creep, type)).toHaveBeenCalledWith(target);
      expectMovementFor(creep, type);
      expect(mockedCompleteWorkerTaskIfDone).toHaveBeenCalledWith(task);
      expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
    }
  });

  it("releases every supported assignment after ERR_INVALID_TARGET", () => {
    for (const type of ["build", "upgrade", "repair", "dismantle"] as WorkerTaskType[]) {
      resetWorkerFixture();
      arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_INVALID_TARGET);

      expect(workerRole().target(creep)).toBe(false);
      expectMovementFor(creep, type);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
      expect(mockedCompleteWorkerTaskIfDone).not.toHaveBeenCalled();
    }
  });

  it("cleans up completed and energy-exhausted assignments but keeps dismantle active", () => {
    for (const type of ["build", "upgrade", "repair", "dismantle"] as WorkerTaskType[]) {
      resetWorkerFixture();
      const task = arrangeTask(type);
      const { creep } = createCreep(50);
      mockedCompleteWorkerTaskIfDone.mockReturnValue(true);

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedCompleteWorkerTaskIfDone).toHaveBeenCalledWith(task);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    }

    for (const type of ["build", "upgrade", "repair"] as const) {
      resetWorkerFixture();
      arrangeTask(type);
      const { creep, energy } = createCreep(1);
      getActionMock(creep, type).mockImplementation(() => {
        energy.value = 0;
        return OK;
      });

      expect(workerRole().target(creep)).toBe(true);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    }

    resetWorkerFixture();
    arrangeTask("dismantle");
    const { creep: dismantler } = createCreep(0);
    expect(workerRole().target(dismantler)).toBe(false);
    expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
  });

  it("keeps or releases unreachable work according to the task retry contract", () => {
    for (const type of ["upgrade"] as const) {
      resetWorkerFixture();
      arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_NOT_IN_RANGE);
      mockedMoveToRemoteWorkTarget.mockReturnValue(ERR_NO_PATH);

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedMoveToRemoteWorkTarget).toHaveBeenCalledWith(creep, target);
      expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
    }

    for (const type of ["repair", "dismantle"] as const) {
      resetWorkerFixture();
      arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_NOT_IN_RANGE);
      if (type === "repair") {
        mockedMoveToRemoteWorkTarget.mockReturnValue(ERR_NO_PATH);
      } else {
        mockedMoveToTarget.mockReturnValue(ERR_NO_PATH);
      }

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
      expect(mockedCompleteWorkerTaskIfDone).not.toHaveBeenCalled();
    }
  });

  it("releases unknown task types and derives the phase signal from remaining energy", () => {
    for (const energy of [50, 0]) {
      resetWorkerFixture();
      const unknownTask = {
        ...createTask("build"),
        type: "unknown",
      } as unknown as WorkerTask;
      mockedAssignWorkerTask.mockReturnValue(unknownTask);
      mockedGetWorkerTaskTarget.mockReturnValue(target);
      const { creep } = createCreep(energy);

      expect(workerRole().target(creep)).toBe(energy === 0);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
      expect(creep.build).not.toHaveBeenCalled();
      expect(creep.upgradeController).not.toHaveBeenCalled();
      expect(creep.repair).not.toHaveBeenCalled();
      expect(creep.dismantle).not.toHaveBeenCalled();
      expect(mockedMoveToRemoteWorkTarget).not.toHaveBeenCalled();
      expect(mockedMoveToTarget).not.toHaveBeenCalled();
    }
  });
});


it("建造目标无路可达时释放并暂缓重试", () => {
  const { creep } = createCreep(100, 100);
  const task = arrangeTask("build");
  (creep.build as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);
  mockedMoveToRemoteWorkTarget.mockReturnValue(ERR_NO_PATH);
  expect(workerRole().target(creep)).toBe(false);
  expect(deferUnreachableWorkerTask).toHaveBeenCalledWith(creep, task);
});
