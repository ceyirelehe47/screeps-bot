import { runRescueByFlag } from "@/runtime/rescue";
import { getCreepConfigService, registerRuntimeServices } from "@/runtime/runtimeServices";

it("撤掉救援旗后，召回已出发的成员并清理任务", () => {
  Game.time++;
  Game.flags = {};
  Game.spawns = {};
  Game.rooms = {};
  Memory.data = { rescue: { W2N2: { sourceRoom: "W1N1", targetRoom: "W2N2", flagName: "RESCUE",
    status: "bootstrapping", createdAt: Game.time - 1, updatedAt: Game.time - 1 } } };
  const name = "W1N1:rescue:W2N2:worker:0";
  const creep = { name: "rescue-worker", room: { name: "W2N2" }, memory: { role: "colonizerWorker", configName: name } } as Creep;
  Game.creeps = { [creep.name]: creep };
  registerRuntimeServices();
  getCreepConfigService().set(name, { role: "colonizerWorker", args: ["W2N2"], roomName: "W1N1" });

  runRescueByFlag();

  expect(creep.memory._recycleToRoom).toBe("W1N1");
  expect(creep.memory.configName).toBeUndefined();
  expect(getCreepConfigService().get(name)).toBeUndefined();
  expect(Memory.data?.rescue?.W2N2).toBeUndefined();
});
