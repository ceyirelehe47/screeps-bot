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

it.each([true, false])("源矿 link 消失且矿工满载时先卸货再采集（有容器=%s）", hasContainer => {
  Game.time++;
  const creep = createMockPowerBankCreep("miner", { x: 10, y: 11, roomName: "W1N1" });
  const source = { id: "source", pos: new MockPos(10, 10, "W1N1") } as unknown as Source;
  source.pos.findInRange = jest.fn(() => []) as RoomPosition["findInRange"];
  const container = { structureType: STRUCTURE_CONTAINER, store: createMockStore({}) } as StructureContainer;
  creep.pos.findInRange = jest.fn(() => hasContainer ? [container] : []) as RoomPosition["findInRange"];
  creep.store = createMockStore({ [RESOURCE_ENERGY]: 50 }, 50) as Creep["store"];
  creep.harvest = jest.fn(() => OK); creep.transfer = jest.fn(() => OK); creep.drop = jest.fn(() => OK);
  Game.getObjectById = jest.fn(() => source) as typeof Game.getObjectById;
  jest.mocked(shouldPauseEnergyExtraction).mockReturnValue(true);
  const role = minerRole("source");
  expect(role.source!(creep)).toBe(true);
  expect(creep.harvest).not.toHaveBeenCalled();
  expect(role.target(creep)).toBe(true);
  if (hasContainer) expect(creep.transfer).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
  else expect(creep.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
});
