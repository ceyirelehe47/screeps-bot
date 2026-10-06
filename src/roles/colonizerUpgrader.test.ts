jest.mock("@/roles/shared", () => ({ moveToTargetRoom: jest.fn(), moveToTarget: jest.fn() }));
jest.mock("@/roles/combatBoosts", () => ({ prepareCombatBoost: jest.fn(() => true) }));
jest.mock("@/roles/energyTargets", () => ({ pickupEnergyFromPreferredTarget: jest.fn(() => ({ picked: false, outOfRange: false })) }));
jest.mock("@/runtime/energyPickupReservation", () => ({ releasePickupReservation: jest.fn() }));
import { colonizerUpgraderRole } from "@/roles/colonizerUpgrader";
import { moveToTargetRoom, moveToTarget } from "@/roles/shared";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import { createMockStore } from "@mock/powerBank";

const SOURCE = "E1N57", TARGET = "E4N57", ROUTE = "E1N57|E2N57|E3N57|E4N57";
function room(name: string, level: number, structures: Structure[] = []): Room {
  const r = { name, find: jest.fn(() => structures) } as unknown as Room;
  r.controller = { my: true, level, pos: { getRangeTo: () => 2 }, room: r } as unknown as StructureController;
  return r;
}
function actor(r: Room, energy = 0): Creep {
  return { name: "helper", room: r, pos: { getRangeTo: () => 1 }, store: createMockStore({ energy }, 500),
    memory: {}, drop: jest.fn(() => OK), withdraw: jest.fn(() => OK), upgradeController: jest.fn(() => OK),
    build: jest.fn(), repair: jest.fn(), dismantle: jest.fn() } as unknown as Creep;
}
function localSource(type: StructureConstant, energy = 500): Structure {
  return { structureType: type, pos: { getRangeTo: () => 2 }, store: createMockStore({ energy }, 1000) } as unknown as Structure;
}
describe("殖民 upgrader：直接升级与本地取能", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Memory.cfg = { colonizationSupport: { [TARGET]: { enabled: true, sourceRoom: SOURCE } } };
    Memory.runtime = {};
    Memory.data = {};
    Game.spawns = {}; Game.creeps = {};
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.rooms = { [SOURCE]: room(SOURCE, 8), [TARGET]: room(TARGET, 2) };
  });
  const role = () => colonizerUpgraderRole(TARGET, ROUTE, "boost-owner", "6", SOURCE);
  function queueMiner(r: Room, energy: number) {
    r.energyAvailable = energy; r.energyCapacityAvailable = 800;
    const name = `${r.name}:harvester:source-a`;
    Memory.data!.creepConfigs = { [name]: { role: "harvester", args: ["source-a"], roomName: r.name } };
    Game.spawns.ColonySpawn = { name: "ColonySpawn", room: r, memory: { spawnList: [name] } } as unknown as StructureSpawn;
  }
  it("本地矿工队列缺650能量时不取能，并释放拾取租约", () => {
    const r = Game.rooms[TARGET], c = actor(r);
    queueMiner(r, 300);
    expect(role().source!(c)).toBe(false);
    expect(c.withdraw).not.toHaveBeenCalled();
    expect(pickupEnergyFromPreferredTarget).not.toHaveBeenCalled();
    expect(releasePickupReservation).toHaveBeenCalledWith(c);
  });
  it("矿工补员缺能量时把持有的能量放回房间，够支付后继续直接升级", () => {
    const r = Game.rooms[TARGET], c = actor(r, 500);
    queueMiner(r, 300);
    expect(role().target(c)).toBe(false);
    expect(c.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(c.upgradeController).not.toHaveBeenCalled();
    r.energyAvailable = 650;
    role().target(c);
    expect(c.upgradeController).toHaveBeenCalledWith(r.controller);
    expect(c.build).not.toHaveBeenCalled();
  });
  it("源房只增强并空手 travel，不调用本地取能或升级", () => {
    const c = actor(Game.rooms[SOURCE]);
    expect(role().prepare!(c)).toBe(true);
    expect(prepareCombatBoost).toHaveBeenCalledWith(c, "boost-owner", RESOURCE_CATALYZED_GHODIUM_ACID);
    expect(role().source!(c)).toBe(false);
    expect(moveToTargetRoom).toHaveBeenCalledWith(c, TARGET, ROUTE, expect.any(Object));
    expect(pickupEnergyFromPreferredTarget).not.toHaveBeenCalled();
    expect(c.upgradeController).not.toHaveBeenCalled();
  });
  it("携能的意外源房状态先放下再赴任", () => {
    const c = actor(Game.rooms[SOURCE], 50); role().source!(c);
    expect(c.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });
  it("有建造需求时仍直接升级 RCL1 控制器，不执行 worker 建造维修", () => {
    const r = Game.rooms[TARGET]; r.controller!.level = 1;
    const c = actor(r, 500); expect(role().target(c)).toBe(false);
    expect(c.upgradeController).toHaveBeenCalledWith(r.controller);
    expect(c.build).not.toHaveBeenCalled(); expect(c.repair).not.toHaveBeenCalled(); expect(c.dismantle).not.toHaveBeenCalled();
    expect(r.find).not.toHaveBeenCalled();
  });
  it("控制器 Link 优先于 Container；只从殖民房设施取能", () => {
    const container = localSource(STRUCTURE_CONTAINER), link = localSource(STRUCTURE_LINK);
    const r = Game.rooms[TARGET] = room(TARGET, 3, [container, link]);
    const c = actor(r); expect(role().source!(c)).toBe(false);
    expect(c.withdraw).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
    expect(pickupEnergyFromPreferredTarget).not.toHaveBeenCalled();
  });
  it("没有控制器设施时按 upgrader 的 Storage 后本地拾取顺序取能", () => {
    const r = Game.rooms[TARGET]; r.storage = localSource(STRUCTURE_STORAGE) as StructureStorage;
    const c = actor(r); role().source!(c);
    expect(c.withdraw).toHaveBeenCalledWith(r.storage, RESOURCE_ENERGY);
    delete r.storage; (c.withdraw as jest.Mock).mockClear(); role().source!(c);
    expect(pickupEnergyFromPreferredTarget).toHaveBeenCalledWith(c, { swampCost: 8 });
    expect(c.withdraw).not.toHaveBeenCalled();
  });
  it("升级越界时向控制器 range3 移动，能量耗尽后切回取能", () => {
    const c = actor(Game.rooms[TARGET], 50); (c.upgradeController as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);
    role().target(c); expect(moveToTarget).toHaveBeenCalledWith(c, c.room.controller, 3);
    const empty = actor(Game.rooms[TARGET]); expect(role().target(empty)).toBe(true);
    expect(empty.upgradeController).not.toHaveBeenCalled();
  });
  it("RCL6 停止升级，余能留在殖民房，再空手回源房", () => {
    Game.rooms[TARGET].controller!.level = 6; const c = actor(Game.rooms[TARGET], 50);
    expect(role().target(c)).toBe(false); expect(c.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(c.upgradeController).not.toHaveBeenCalled();
    role().source!(actor(Game.rooms[TARGET]));
    expect(moveToTargetRoom).toHaveBeenCalledWith(expect.anything(), SOURCE, "E4N57|E3N57|E2N57|E1N57", expect.any(Object));
  });
  it("未认领与停用后不取能、不升级", () => {
    Game.rooms[TARGET].controller!.my = false;
    const c = actor(Game.rooms[TARGET], 50); role().target(c);
    expect(c.upgradeController).not.toHaveBeenCalled();
    Game.rooms[TARGET].controller!.my = true; Memory.cfg!.colonizationSupport![TARGET].enabled = false;
    role().source!(c); expect(pickupEnergyFromPreferredTarget).not.toHaveBeenCalled();
    expect(c.upgradeController).not.toHaveBeenCalled();
  });
});
