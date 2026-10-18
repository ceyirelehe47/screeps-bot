import { minerRole } from "./miner";
import { resetCreepExecutionForTest, runCreepStep } from "@/runtime/creepExecution";
import { createMockPowerBankCreep, createMockStore, MockPos } from "@mock/powerBank";
import { shouldPauseEnergyExtraction } from "@/runtime/energyInflowGuard";
jest.mock("@/runtime/sourceWorkPosition", () => ({ getPlannedSourceContainerPos: () => null }));
jest.mock("@/runtime/sourceLink", () => ({ getSourceAdjacentLink: () => null }));
jest.mock("@/runtime/energyInflowGuard", () => ({ shouldPauseEnergyExtraction: jest.fn(() => false) }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ measureCreepIntent: (fn: () => unknown) => fn() }));
jest.mock("@/roles/shared", () => ({ moveToTarget: jest.fn() }));

it("reuses an actual miner harvest while rechecking the stop policy and next-tick cargo capacity", () => {
  resetCreepExecutionForTest(); Game.time++;
  const findInRange = jest.fn(() => []);
  const source = { id: "source", energy: 1000, pos: { x: 10, y: 10, roomName: "W1N1", findInRange } } as unknown as Source;
  Game.getObjectById = jest.fn(() => source) as typeof Game.getObjectById;
  const creep = createMockPowerBankCreep("miner", { x: 10, y: 11, roomName: "W1N1", body: [{ type: WORK, hits: 100 }, { type: CARRY, hits: 100 }, { type: MOVE, hits: 100 }] });
  creep.harvest = jest.fn(() => OK);
  creep.store = createMockStore({}) as Creep["store"];
  const role = minerRole("source");
  runCreepStep(creep, role, "source");
  expect(creep.harvest).toHaveBeenCalledTimes(1); expect(findInRange).toHaveBeenCalledTimes(1);
  Game.time++; creep.pos = new MockPos(10, 11, "W1N1") as unknown as RoomPosition;
  runCreepStep(creep, role, "source");
  expect(creep.harvest).toHaveBeenCalledTimes(2); expect(findInRange).toHaveBeenCalledTimes(1);
  (shouldPauseEnergyExtraction as jest.Mock).mockReturnValue(true);
  Game.time++; runCreepStep(creep, role, "source");
  expect(creep.harvest).toHaveBeenCalledTimes(2);
  expect(findInRange).toHaveBeenCalledTimes(2);
});
