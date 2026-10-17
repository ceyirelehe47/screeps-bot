import { countCarrierCargo, refreshCarrierCargoActor } from "@/runtime/carrierCargo";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { createTickContextService } from "@/runtime/tickContext";

it("索引建立后同 tick 新接货与重定向对后续消费者立即可见，旧目的地不重复计数", () => {
  clearCreepAssignmentStateForTest(); Game.time++;
  Game.creeps = { carrier: { name: "carrier", store: { getUsedCapacity: () => 30 } } as unknown as Creep };
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

it("全量快照与 cargo 索引共享枚举，重定向不重复登记，下一 tick 清除旧快照", () => {
  Game.time++;
  Game.creeps = { carrier: { name: "carrier", store: { getUsedCapacity: () => 30 } } as unknown as Creep };
  const context = createTickContextService();
  const all = context.getAllCreeps();
  const state = ensureCreepAssignmentState("carrier");
  state.synthesisCarrierPendingToId = "terminal"; state.synthesisCarrierPendingResource = RESOURCE_HYDROXIDE;
  delete state.synthesisCarrierPendingReturnToId;
  expect(context.getCarrierCargoActors("terminal", RESOURCE_HYDROXIDE)).toEqual(["carrier"]);
  context.refreshCarrierCargoActor("carrier"); context.refreshCarrierCargoActor("carrier");
  expect(context.getCarrierCargoActors("terminal", RESOURCE_HYDROXIDE)).toEqual(["carrier"]);
  expect(context.getAllCreeps()).toBe(all);
  Game.time++; Game.creeps = {};
  expect(context.getCarrierCargoActors("terminal", RESOURCE_HYDROXIDE)).toEqual([]);
});
