jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: jest.fn(() => false) }));
jest.mock("@/runtime/roomReserve", () => ({ isRoomInReserveMode: jest.fn(() => false) }));
import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { isSpawnConfigEconomicallyBlocked, canStartOutboundMission, canContinueWarMission } from "@/runtime/outboundMissionPolicy";
import type { WarTask } from "@/runtime/war/store";
import type { DepositHarvestTask } from "@/runtime/depositHarvest";
import { pushBlockingCreep } from "@/movement/traffic";

describe("本房防御与储备的出征边界", () => {
  beforeEach(() => { Game.creeps = {}; Game.spawns = {}; Memory.creeps = {}; Memory.data = {} as NonNullable<Memory["data"]>; jest.mocked(isDefenseMode).mockReturnValue(false); jest.mocked(isRoomInReserveMode).mockReturnValue(false); });
  it.each(["powerBankAttacker", "powerBankHealer", "powerBankHauler"] as const)("储备允许已承诺任务的 %s，拒绝新任务、错来源、错目标和已结束任务", role => {
    jest.mocked(isRoomInReserveMode).mockReturnValue(true);
    const task = { id: "bank", sourceRoom: "W1N1", targetRoom: "W2N2", status: "spawning" } as PowerBankHarvestTask;
    Memory.data!.powerBankHarvest = { bank: task };
    const config = { role, roomName: "W1N1", args: ["W2N2"], taskId: "bank" };
    expect(isSpawnConfigEconomicallyBlocked("pb-config", config)).toBe(false);
    for (const status of ["discovered", "complete", "failed", "aborted"] as const) {
      task.status = status;
      expect(isSpawnConfigEconomicallyBlocked("pb-config", config)).toBe(true);
    }
    task.status = "travelling";
    expect(isSpawnConfigEconomicallyBlocked("pb-config", { ...config, taskId: "missing" })).toBe(true);
    expect(isSpawnConfigEconomicallyBlocked("pb-config", { ...config, roomName: "W3N3" })).toBe(true);
    expect(isSpawnConfigEconomicallyBlocked("pb-config", { ...config, args: ["W4N4"] })).toBe(true);
    jest.mocked(isDefenseMode).mockReturnValue(true);
    expect(isSpawnConfigEconomicallyBlocked("pb-config", config)).toBe(true);
  });
  it("war 只放行已投入任务的当前代搭档，新任务即使 clearing 也不借状态放行", () => {
    jest.mocked(isRoomInReserveMode).mockReturnValue(true);
    const red = "W1N1:war:W2N2:g2:meleeAttacker:0", green = "W1N1:war:W2N2:g2:healer:0";
    const task = { targetRoom: "W2N2", sourceRoom: "W1N1", status: "clearing", reason: "manual", attempts: 1,
      createdAt: Game.time, updatedAt: Game.time, activeGeneration: { id: 2, phase: "assembling", createdAt: Game.time,
        boostTaskId: "boost", configNames: { meleeAttacker: red, healer: green } } } as WarTask;
    const cfg = { role: "healer" as const, roomName: "W1N1", args: ["W2N2"] };
    Memory.data!.war = { W2N2: task };
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
    task.members = { [red]: { configName: red, creepNames: [], spawnedAt: Game.time - 1 } };
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(false);
    for (const status of ["queued", "done", "failed"] as const) {
      task.status = status; expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
    }
    task.status = "staging";
    expect(isSpawnConfigEconomicallyBlocked(green.replace("g2", "g1"), cfg)).toBe(true);
    expect(isSpawnConfigEconomicallyBlocked(green, { ...cfg, args: ["W3N3"] })).toBe(true);
    expect(isSpawnConfigEconomicallyBlocked(green, { ...cfg, roomName: "W3N3" })).toBe(true);
    task.members = { [red.replace("g2", "g1")]: { configName: red.replace("g2", "g1"), creepNames: [], spawnedAt: Game.time - 1 } };
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
    task.activeGeneration!.boostGateOpenedAt = Game.time - 1;
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(false);
    jest.mocked(isDefenseMode).mockReturnValue(true);
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
    expect(canContinueWarMission(task)).toBe(false);
  });
  it("legacy war 用实际排队/孵化/活体识别投入，脱离任务和孤立配置不放行", () => {
    jest.mocked(isRoomInReserveMode).mockReturnValue(true);
    const red = "W1N1:war:W2N2:meleeAttacker:0", green = "W1N1:war:W2N2:healer:0";
    const task = { targetRoom: "W2N2", sourceRoom: "W1N1", status: "clearing" } as WarTask;
    Memory.data!.war = { W2N2: task };
    const cfg = { role: "healer" as const, roomName: "W1N1", args: ["W2N2"] };
    Memory.data!.creepConfigs = { [red]: { ...cfg, role: "meleeAttacker" }, [green]: cfg };
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
    const spawn = { room: { name: "W1N1" }, memory: { spawnList: [red] }, spawning: null } as unknown as StructureSpawn;
    Game.spawns = { S: spawn };
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(false);
    spawn.memory.spawnList = []; spawn.spawning = { name: "born" } as Spawning;
    Memory.creeps.born = { role: "meleeAttacker", configName: red };
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(false);
    spawn.spawning = null;
    Game.creeps.born = { memory: { role: "meleeAttacker", configName: red } } as Creep;
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(false);
    Game.creeps.born.memory._warDetached = true;
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
    delete Memory.data!.war!.W2N2;
    expect(isSpawnConfigEconomicallyBlocked(green, cfg)).toBe(true);
  });
  it("deposit 仅豁免已受理的同源单代 owner，终态与错配配置仍阻止", () => {
    jest.mocked(isRoomInReserveMode).mockReturnValue(true);
    const name = "W1N1:deposit:d:g0";
    const task = { id: "d", sourceRoom: "W1N1", status: "spawning", generation: 0, configName: name } as DepositHarvestTask;
    Memory.data!.depositHarvest = { d: task };
    const cfg = { role: "depositHarvester" as const, roomName: "W1N1", args: ["d", "W1N1"], taskId: "d" };
    expect(isSpawnConfigEconomicallyBlocked(name, cfg)).toBe(false);
    for (const status of ["discovered", "outbound", "harvesting", "returning", "unloading", "complete", "aborted", "failed"] as const) {
      task.status = status; expect(isSpawnConfigEconomicallyBlocked(name, cfg)).toBe(true);
    }
    task.status = "spawning";
    for (const invalid of [{ ...cfg, taskId: "missing" }, { ...cfg, roomName: "W3N3" }, { ...cfg, args: ["d", "W3N3"] }]) {
      expect(isSpawnConfigEconomicallyBlocked(name, invalid)).toBe(true);
    }
    task.generation = 1; expect(isSpawnConfigEconomicallyBlocked(name, cfg)).toBe(true);
    task.generation = 0;
    expect(isSpawnConfigEconomicallyBlocked(name + "other", cfg)).toBe(true);
    jest.mocked(isDefenseMode).mockReturnValue(true);
    expect(isSpawnConfigEconomicallyBlocked(name, cfg)).toBe(true);
  });
  it("储备期暂停昂贵出征，保留本地采矿和外矿收入补员", () => {
    jest.mocked(isRoomInReserveMode).mockReturnValue(true);
    expect(canStartOutboundMission("W1N1")).toBe(false);
    expect(isSpawnConfigEconomicallyBlocked("W1N1:war:W2N2:0", { role: "meleeAttacker", roomName: "W1N1", args: [] })).toBe(true);
    expect(isSpawnConfigEconomicallyBlocked("W1N1:miner:0", { role: "miner", roomName: "W1N1", args: [] })).toBe(false);
    expect(isSpawnConfigEconomicallyBlocked("W1N1:remoteMine:W2N2:0", { role: "remoteCarrier", roomName: "W1N1", args: [] })).toBe(false);
  });
  it("本房防御时已排队的外派配置受阻，防御者继续出生且不会被交通推走", () => {
    jest.mocked(isDefenseMode).mockReturnValue(true);
    expect(isSpawnConfigEconomicallyBlocked("W1N1:remoteMine:W2N2:0", { role: "remoteCarrier", roomName: "W1N1", args: [] })).toBe(true);
    expect(isSpawnConfigEconomicallyBlocked("W1N1:homeDefender:0", { role: "homeDefender", roomName: "W1N1", args: [] })).toBe(false);
    const defender = { body: [], memory: { role: "homeDefender" }, room: { name: "W1N1" }, move: jest.fn() } as unknown as Creep;
    expect(pushBlockingCreep({} as Creep, defender)).toBe(false);
    expect(defender.move).not.toHaveBeenCalled();
  });
});
