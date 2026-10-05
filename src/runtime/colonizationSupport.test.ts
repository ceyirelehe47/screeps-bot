jest.mock("@/runtime/powerBankBoost", () => ({ prepareBoosts: jest.fn(() => ({ status: "ready", labs: [] })), releaseBoostLabs: jest.fn() }));
jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: () => false }));
import { runColonizationSupport, supportConfigName, COLONIZATION_SUPPORT_BODY } from "@/runtime/colonizationSupport";
import { prepareBoosts } from "@/runtime/powerBankBoost";
import { runHubUpgradeControl } from "@/runtime/hubUpgradeControl";

const SOURCE = "E1N57", TARGET = "E3N54";
function room(name: string, level: number): Room {
  return { name, controller: { my: true, level }, find: () => [] } as unknown as Room;
}
describe("殖民 T3 支援生命周期", () => {
  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.time = 100; Game.spawns = {}; Game.creeps = {};
    Game.rooms = { [SOURCE]: room(SOURCE, 8) };
    Memory.cfg = { colonizationSupport: { [TARGET]: { enabled: true, sourceRoom: SOURCE, runId: "test" } } };
    Memory.data = {}; Memory.runtime = {}; Memory.creeps = {};
    (prepareBoosts as jest.Mock).mockClear();
  });
  it("先完成占领才产生支援，35 节身体与原普通 upgrader 管理分开", () => {
    runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET);
    expect(Memory.data!.creepConfigs![name]).toBeUndefined();
    expect(Memory.runtime!.colonizationSupport![TARGET].status).toBe("waiting_claim");
    Game.rooms[TARGET] = room(TARGET, 1); runColonizationSupport();
    expect(Memory.data!.creepConfigs![name]).toMatchObject({ role: "colonizerWorker", roomName: SOURCE,
      args: [TARGET, "", `colonizationSupport:${SOURCE}:${TARGET}`, "6", SOURCE], body: COLONIZATION_SUPPORT_BODY });
    expect(COLONIZATION_SUPPORT_BODY).toHaveLength(35);
    runHubUpgradeControl();
    expect(Memory.data!.creepConfigs![name]).toBeDefined();
  });
  it("殖民旗在 RCL3 移除后仍支援，强化按当前源房未强化 WORK 计算", () => {
    Game.rooms[TARGET] = room(TARGET, 4); Game.flags = {};
    runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET);
    Game.creeps.helper = { name: "helper", room: Game.rooms[SOURCE], memory: { configName: name, role: "colonizerWorker" },
      body: COLONIZATION_SUPPORT_BODY.map(type => ({ type, hits: 100 })) } as Creep;
    Game.time++; runColonizationSupport();
    expect(prepareBoosts).toHaveBeenCalledWith(`colonizationSupport:${SOURCE}:${TARGET}`, SOURCE, 8,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]), { requireLabEnergy: true });
    expect(Memory.data!.creepConfigs![name].roomName).toBe(SOURCE);
  });
  it("RCL6 立即撤销补派，完成闩在房间后来降级时保持，不自杀现役", () => {
    Game.rooms[TARGET] = room(TARGET, 5); runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET);
    const suicide = jest.fn();
    Game.creeps.helper = { name: "helper", room: Game.rooms[TARGET], memory: { configName: name, role: "colonizerWorker" }, body: [], suicide } as unknown as Creep;
    Game.spawns.s = { room: Game.rooms[SOURCE], memory: { spawnList: [name, "other"] }, spawning: null } as StructureSpawn;
    Game.time++; Game.rooms[TARGET].controller!.level = 6; runColonizationSupport();
    expect(Game.spawns.s.memory.spawnList).toEqual(["other"]);
    expect(Memory.data!.creepConfigs![name].roomName).toBeUndefined();
    expect(Memory.runtime!.colonizationSupport![TARGET]).toMatchObject({ status: "complete", completedAt: Game.time });
    Game.time++; Game.rooms[TARGET].controller!.level = 5; runColonizationSupport();
    expect(Memory.data!.creepConfigs![name].roomName).toBeUndefined();
    expect(suicide).not.toHaveBeenCalled();
  });
});
