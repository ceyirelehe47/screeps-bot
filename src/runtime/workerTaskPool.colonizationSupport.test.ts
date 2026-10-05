import { refreshWorkerTasks, getWorkerTasksByRoom, clearWorkerTaskBoardForTest } from "@/runtime/workerTaskPool";

it("本次殖民的实际支援与 bootstrap worker 计入升级席位，其他 source 不计入", () => {
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
  clearWorkerTaskBoardForTest(); Game.time = 3;
  const room = { name: "E4N57", memory: {}, controller: { id: "controller", my: true, level: 2 }, find: () => [] } as unknown as Room;
  Game.rooms = { E4N57: room };
  Memory.cfg = { colonizationSupport: { E4N57: { enabled: true, sourceRoom: "E1N57" } } };
  const actor = (name: string, configName: string, role: string) => ({ name, room, memory: { configName, role } }) as Creep;
  Game.creeps = {
    local: actor("local", "E4N57:worker:0", "worker"),
    helper: actor("helper", "E1N57:colonizationSupport:E4N57:worker:0", "colonizerWorker"),
    bootstrap: actor("bootstrap", "E1N57:colonize:E4N57:worker:0", "colonizerWorker"),
    retiring: actor("retiring", "E1N57:colonizationSupport:E4N57:worker:0:retiring:old", "colonizerWorker"),
    other: actor("other", "E2N57:colonize:E4N57:worker:0", "colonizerWorker"),
  };
  refreshWorkerTasks();
  expect(getWorkerTasksByRoom(room.name)["upgrade:controller"].maxAssignees).toBe(4);
  Game.time = 6; Memory.cfg!.colonizationSupport!.E4N57.enabled = false; refreshWorkerTasks();
  expect(getWorkerTasksByRoom(room.name)["upgrade:controller"].maxAssignees).toBe(1);
});
