jest.mock("@/roles/shared", () => ({ moveToTargetRoom: jest.fn() }));
jest.mock("@/roles/worker", () => ({ workerRole: () => ({ source: jest.fn(() => true), target: jest.fn(() => false) }) }));
jest.mock("@/roles/combatBoosts", () => ({ prepareCombatBoost: jest.fn(() => true) }));
jest.mock("@/runtime/energyPickupReservation", () => ({ releasePickupReservation: jest.fn() }));
jest.mock("@/runtime/workerTaskPool", () => ({ releaseWorkerTask: jest.fn() }));
import { colonizerWorkerRole } from "@/roles/colonizerWorker";
import { moveToTargetRoom } from "@/roles/shared";
import { prepareCombatBoost } from "@/roles/combatBoosts";

const SOURCE = "E1N57", TARGET = "E4N57", ROUTE = "E1N57|E2N57|E3N57|E4N57";
function creep(energy = 0): Creep {
  return { name: "helper", room: { name: SOURCE }, store: { energy, getUsedCapacity: () => energy }, drop: jest.fn(() => OK) } as unknown as Creep;
}
describe("T3 支援空手出发与 RCL6 交回", () => {
  beforeEach(() => {
    Memory.cfg = { colonizationSupport: { [TARGET]: { enabled: true, sourceRoom: SOURCE } } };
    Memory.runtime = {};
    Game.rooms = { [TARGET]: { name: TARGET, controller: { my: true, level: 1 }, find: () => [] } as unknown as Room };
    (moveToTargetRoom as jest.Mock).mockClear(); (prepareCombatBoost as jest.Mock).mockClear();
  });
  it("赴目标前仅在源房强化；空载 travel 不进入任何取能逻辑", () => {
    const role = colonizerWorkerRole(TARGET, ROUTE, "boost-owner", "6", SOURCE), actor = creep();
    expect(role.prepare!(actor)).toBe(true);
    expect(prepareCombatBoost).toHaveBeenCalledWith(actor, "boost-owner", RESOURCE_CATALYZED_GHODIUM_ACID);
    expect(role.source!(actor)).toBe(false);
    expect(moveToTargetRoom).toHaveBeenCalledWith(actor, TARGET, ROUTE, expect.any(Object));
  });
  it("携能的意外源房状态先放下再赴任，目标房才调用本地 worker", () => {
    const role = colonizerWorkerRole(TARGET, ROUTE, "boost-owner", "6", SOURCE), actor = creep(50);
    role.source!(actor);
    expect(actor.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    actor.room = Game.rooms[TARGET];
    expect(role.source!(actor)).toBe(true);
  });
  it("RCL6 停止建设升级，余能留在殖民房，随后空手回源房", () => {
    const role = colonizerWorkerRole(TARGET, ROUTE, "boost-owner", "6", SOURCE), actor = creep(50);
    Game.rooms[TARGET].controller!.level = 6; actor.room = Game.rooms[TARGET];
    expect(role.target(actor)).toBe(false);
    expect(actor.drop).toHaveBeenCalledWith(RESOURCE_ENERGY);
    const empty = creep(); empty.room = Game.rooms[TARGET]; role.source!(empty);
    expect(moveToTargetRoom).toHaveBeenCalledWith(empty, SOURCE, "E4N57|E3N57|E2N57|E1N57", expect.any(Object));
    expect(prepareCombatBoost).not.toHaveBeenCalled();
  });
});
