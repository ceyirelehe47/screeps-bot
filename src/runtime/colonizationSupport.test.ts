jest.mock("@/runtime/powerBankBoost", () => ({ prepareBoosts: jest.fn(() => ({ status: "ready", labs: [] })), releaseBoostLabs: jest.fn() }));
jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: () => false }));
jest.mock("@/runtime/workerTaskPool", () => ({ releaseWorkerTask: jest.fn() }));
jest.mock("@/runtime/energyPickupReservation", () => ({ releasePickupReservation: jest.fn() }));
import { runColonizationSupport, supportConfigName, COLONIZATION_SUPPORT_BODY } from "@/runtime/colonizationSupport";
import { prepareBoosts } from "@/runtime/powerBankBoost";
import { runHubUpgradeControl } from "@/runtime/hubUpgradeControl";
import { releaseWorkerTask } from "@/runtime/workerTaskPool";

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
  it("先完成占领才产生支援，15 WORK / 10 CARRY / 25 MOVE 与普通 upgrader 管理分开", () => {
    runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET);
    expect(Memory.data!.creepConfigs![name]).toBeUndefined();
    expect(Memory.runtime!.colonizationSupport![TARGET].status).toBe("waiting_claim");
    Game.rooms[TARGET] = room(TARGET, 1); runColonizationSupport();
    expect(Memory.data!.creepConfigs![name]).toMatchObject({ role: "colonizerUpgrader", roomName: SOURCE,
      args: [TARGET, "", `colonizationSupport:${SOURCE}:${TARGET}`, "6", SOURCE], body: COLONIZATION_SUPPORT_BODY });
    expect(COLONIZATION_SUPPORT_BODY).toHaveLength(50);
    expect(COLONIZATION_SUPPORT_BODY.filter(part => part === WORK)).toHaveLength(15);
    expect(COLONIZATION_SUPPORT_BODY.filter(part => part === CARRY)).toHaveLength(10);
    expect(COLONIZATION_SUPPORT_BODY.filter(part => part === MOVE)).toHaveLength(25);
    runHubUpgradeControl();
    expect(Memory.data!.creepConfigs![name]).toBeDefined();
  });
  it("旧 35 节现役继续服役但不补员，常规名释放给新身体，死亡后清除过渡配置", () => {
    Game.rooms[TARGET] = room(TARGET, 2); runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET), suicide = jest.fn();
    const oldBody = [...Array(15).fill(WORK), ...Array(5).fill(CARRY), ...Array(15).fill(MOVE)];
    Game.creeps.old = { name: "old", room: Game.rooms[TARGET], memory: { configName: name, role: "colonizerUpgrader" },
      body: oldBody.map(type => ({ type, hits: 100, boost: type === WORK ? RESOURCE_CATALYZED_GHODIUM_ACID : undefined })), suicide } as unknown as Creep;
    Game.time++; runColonizationSupport();
    const retiring = `${name}:retiring:old`;
    expect(Game.creeps.old.memory.configName).toBe(retiring);
    expect(Memory.data!.creepConfigs![retiring]).toMatchObject({ role: "colonizerUpgrader", body: oldBody });
    expect(Memory.data!.creepConfigs![retiring].roomName).toBeUndefined();
    expect(Memory.data!.creepConfigs![name]).toMatchObject({ roomName: SOURCE, body: COLONIZATION_SUPPORT_BODY });
    expect(suicide).not.toHaveBeenCalled();
    Game.creeps = {}; Game.time++; runColonizationSupport();
    expect(Memory.data!.creepConfigs![retiring]).toBeUndefined();
    expect(Memory.data!.creepConfigs![name].roomName).toBe(SOURCE);
  });
  it("殖民旗在 RCL3 移除后仍支援，强化按当前源房未强化 WORK 计算", () => {
    Game.rooms[TARGET] = room(TARGET, 4); Game.flags = {};
    runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET);
    Game.creeps.helper = { name: "helper", room: Game.rooms[SOURCE], memory: { configName: name, role: "colonizerUpgrader" },
      body: COLONIZATION_SUPPORT_BODY.map(type => ({ type, hits: 100 })) } as Creep;
    Game.time++; runColonizationSupport();
    expect(prepareBoosts).toHaveBeenCalledWith(`colonizationSupport:${SOURCE}:${TARGET}`, SOURCE, 8,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]), { requireLabEnergy: true });
    expect(Memory.data!.creepConfigs![name].roomName).toBe(SOURCE);
  });
  it("现役与旧身体支援原位改为 upgrader 并释放 worker 租约，不新增单位或改身体", () => {
    Game.rooms[TARGET] = room(TARGET, 2);
    const name = supportConfigName(SOURCE, TARGET), retiring = `${name}:retiring:old`;
    const oldArgs = [TARGET, "", `colonizationSupport:${SOURCE}:${TARGET}`, "6", SOURCE];
    Memory.data!.creepConfigs = {
      [name]: { role: "colonizerWorker", args: [...oldArgs], roomName: SOURCE, body: COLONIZATION_SUPPORT_BODY },
      [retiring]: { role: "colonizerWorker", args: [...oldArgs] },
    };
    const helper = (n: string, cfg: string) => ({ name: n, room: Game.rooms[TARGET], memory: { configName: cfg, role: "colonizerWorker", ready: true },
      body: COLONIZATION_SUPPORT_BODY.map(type => ({ type, hits: 100, boost: type === WORK ? RESOURCE_CATALYZED_GHODIUM_ACID : undefined })) } as Creep);
    Game.creeps = { helper: helper("helper", name), old: helper("old", retiring) };
    (releaseWorkerTask as jest.Mock).mockClear(); runColonizationSupport();
    for (const c of Object.values(Game.creeps)) {
      expect(c.memory.role).toBe("colonizerUpgrader");
      expect(c.memory.ready).toBe(false);
      expect(releaseWorkerTask).toHaveBeenCalledWith(c);
      expect(Memory.data!.creepConfigs![c.memory.configName!].role).toBe("colonizerUpgrader");
    }
    expect(Object.keys(Game.creeps)).toHaveLength(2);
    expect(Memory.data!.creepConfigs![retiring].roomName).toBeUndefined();
    runHubUpgradeControl();
    expect(Memory.data!.creepConfigs![name].role).toBe("colonizerUpgrader");
    expect(Memory.data!.creepConfigs![retiring].role).toBe("colonizerUpgrader");
  });
  it("RCL6 立即撤销补派，完成闩在房间后来降级时保持，不自杀现役", () => {
    Game.rooms[TARGET] = room(TARGET, 5); runColonizationSupport();
    const name = supportConfigName(SOURCE, TARGET);
    const suicide = jest.fn();
    Game.creeps.helper = { name: "helper", room: Game.rooms[TARGET], memory: { configName: name, role: "colonizerUpgrader" }, body: [], suicide } as unknown as Creep;
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
