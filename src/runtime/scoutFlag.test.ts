jest.mock("@/runtime/runtimeServices", () => ({
  getMemoryService: () => ({ getCreepConfigStore: () => Memory.data!.creepConfigs! }),
  getTickContextService: () => ({ getCreepsByConfigName: (name: string) => Object.values(Game.creeps).filter(c => c.memory.configName === name) }),
}));
import { runScoutByFlag } from "@/runtime/scoutFlag";

it("删除侦察旗只记录一次取消，并清理待孵化队列", () => {
  const configName = "scout:flag:SCOUT_test";
  Memory.data = { creepConfigs: { [configName]: { role: "flagScout", args: ["W2N2", "25", "25"], roomName: "W1N1" } } };
  Game.creeps = { scout: { memory: { configName } } as Creep }; Game.flags = {};
  Game.spawns = { Spawn: { memory: { spawnList: [configName, "keep"] } } as StructureSpawn };
  const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    runScoutByFlag(); Game.time += 1; runScoutByFlag();
    expect(log.mock.calls.filter(call => String(call[0]).includes("[scout] cancelled"))).toHaveLength(1);
    expect(Game.spawns.Spawn.memory.spawnList).toEqual(["keep"]);
    expect(Memory.data!.creepConfigs![configName].roomName).toBeUndefined();
  } finally { log.mockRestore(); }
});
