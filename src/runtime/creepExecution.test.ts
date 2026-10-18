import { compactCreepMemory, resetCreepExecutionForTest, runCreepStep } from "./creepExecution";
import type { RoleLifecycle } from "@/types/system";
jest.mock("@/movement/traffic", () => ({ getMoveIntentReceipt: () => undefined }));
const actor = () => ({ id: "a", name: "a", room: { name: "W1N1" }, pos: { x: 10, y: 10 }, memory: {} }) as Creep;
beforeEach(() => { Game.time = 100; resetCreepExecutionForTest(); });

it("reuses a validated sticky action across new tick objects and falls back after stage or position changes", () => {
  const run = jest.fn(() => true), step = jest.fn(() => ({ kind: "continue" as const, sticky: { until: 105, run } }));
  const logic: RoleLifecycle = { target: () => false, step };
  runCreepStep(actor(), logic, "source");
  runCreepStep(actor(), logic, "source");
  expect(step).toHaveBeenCalledTimes(1);
  Game.time++;
  runCreepStep(actor(), logic, "source");
  expect(run).toHaveBeenCalledTimes(1);
  expect(step).toHaveBeenCalledTimes(1);
  const moved = actor(); moved.pos.x++;
  Game.time++; runCreepStep(moved, logic, "source");
  expect(step).toHaveBeenCalledTimes(2);
  Game.time++; runCreepStep(moved, logic, "target");
  expect(step).toHaveBeenCalledTimes(3);
});

it("wakes sleeping actors on owner facts, expires bounded sleeps and recovers after heap reset", () => {
  let awake = false;
  const step = jest.fn(() => ({ kind: "sleep" as const, until: Game.time + 1000, wake: () => awake }));
  const logic: RoleLifecycle = { target: () => false, step };
  runCreepStep(actor(), logic, "source");
  Game.time++; runCreepStep(actor(), logic, "source"); expect(step).toHaveBeenCalledTimes(1);
  awake = true; Game.time++; runCreepStep(actor(), logic, "source"); expect(step).toHaveBeenCalledTimes(2);
  awake = false; Game.time += 25; runCreepStep(actor(), logic, "source"); expect(step).toHaveBeenCalledTimes(3);
  resetCreepExecutionForTest(); runCreepStep(actor(), logic, "source"); expect(step).toHaveBeenCalledTimes(4);
});

it("compacts only default or obsolete fields and preserves traveller args, accepted cargo and retirement identity", () => {
  const memory = { role: "powerBankHauler", ready: false, working: false, roleArgs: ["bank", "route"], taskId: "bank", _recycleToRoom: "W1N1", powerBankPendingTransfer: { tick: 10, before: 500, amount: 500, taskId: "bank" }, _move: { path: "old" } } as CreepMemory & PowerBankHaulerMemory;
  const before = JSON.stringify(memory).length;
  expect(compactCreepMemory(memory)).toBe(3);
  expect(memory.roleArgs).toEqual(["bank", "route"]);
  expect(memory.taskId).toBe("bank"); expect(memory._recycleToRoom).toBe("W1N1");
  expect(memory.powerBankPendingTransfer?.amount).toBe(500);
  expect(JSON.stringify(memory).length).toBeLessThan(before);
  expect(compactCreepMemory(memory)).toBe(0);
  expect(compactCreepMemory({ roleArgs: [] } as CreepMemory)).toBe(1);
});
