import { countCarrierCargo, refreshCarrierCargoActor } from "@/runtime/carrierCargo";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";

it("索引建立后同 tick 新接货与重定向对后续消费者立即可见，旧目的地不重复计数", () => {
  clearCreepAssignmentStateForTest(); Game.time++;
  Game.creeps = { carrier: { store: { getUsedCapacity: () => 30 } } as unknown as Creep };
  expect(countCarrierCargo("terminal", RESOURCE_HYDROXIDE)).toBe(0);
  const state = ensureCreepAssignmentState("carrier");
  state.synthesisCarrierPendingToId = "terminal"; state.synthesisCarrierPendingResource = RESOURCE_HYDROXIDE;
  refreshCarrierCargoActor("carrier");
  expect(countCarrierCargo("terminal", RESOURCE_HYDROXIDE)).toBe(30);
  state.synthesisCarrierPendingToId = "lab"; refreshCarrierCargoActor("carrier");
  expect(countCarrierCargo("terminal", RESOURCE_HYDROXIDE)).toBe(0);
  expect(countCarrierCargo("lab", RESOURCE_HYDROXIDE)).toBe(30);
  state.synthesisCarrierPendingReturnToId = "storage";
  expect(countCarrierCargo("lab", RESOURCE_HYDROXIDE)).toBe(0);
});
