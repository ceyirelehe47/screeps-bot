import { canUseColonizationTransit, colonizationTransitKey } from "@/runtime/colonizationSupport";
import { getColonizationTravelPathKey } from "@/movement/routing";

describe("单次殖民路线的被动所有权通行许可", () => {
  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.time += 1; Game.rooms = {};
    Memory.cfg = { colonizationSupport: { E4N57: { enabled: true, sourceRoom: "E1N57", allowedTransitRooms: ["E3N57"] } } };
  });
  it("只放行指定 source/target/corridor；敌方被动所有权和空塔可通行", () => {
    Game.rooms.E3N57 = { name: "E3N57", controller: { my: false, owner: { username: "TooAngel" } },
      find: (kind: FindConstant) => kind === FIND_HOSTILE_STRUCTURES ? [{ structureType: STRUCTURE_STORAGE }] : [] } as unknown as Room;
    expect(canUseColonizationTransit("E1N57", "E4N57", "E3N57")).toBe(true);
    expect(canUseColonizationTransit("E2N57", "E4N57", "E3N57")).toBe(false);
    expect(canUseColonizationTransit("E1N57", "E3N54", "E3N57")).toBe(false);
    expect(canUseColonizationTransit("E1N57", "E4N57", "E2N57")).toBe(false);
  });
  it("当前可开火塔、战斗 creep 或 PowerCreep 都不能因许可穿过", () => {
    for (const threat of ["tower", "creep", "power"] as const) {
      Game.time++; Game.rooms.E3N57 = { name: "E3N57", find: (kind: FindConstant) => {
        if (threat === "tower" && kind === FIND_HOSTILE_STRUCTURES) return [{ structureType: STRUCTURE_TOWER, store: { getUsedCapacity: () => 10 } }];
        if (threat === "creep" && kind === FIND_HOSTILE_CREEPS) return [{ getActiveBodyparts: (type: BodyPartConstant) => type === ATTACK ? 1 : 0 }];
        if (threat === "power" && kind === FIND_HOSTILE_POWER_CREEPS) return [{}];
        return [];
      } } as unknown as Room;
      expect(canUseColonizationTransit("E1N57", "E4N57", "E3N57")).toBe(false);
    }
  });
  it("许可撤销使持久路径 key 失效，其他任务的 key 保持原合同", () => {
    const route = ["E1N57", "E2N57", "E3N57", "E4N57"];
    const before = getColonizationTravelPathKey("E1N57", "E4N57", route, []);
    expect(colonizationTransitKey("E1N57", "E4N57")).toBe("E3N57");
    Memory.cfg!.colonizationSupport!.E4N57.allowedTransitRooms = [];
    expect(getColonizationTravelPathKey("E1N57", "E4N57", route, [])).not.toBe(before);
    const unrelated = getColonizationTravelPathKey("E2N57", "E4N57", route, []);
    Memory.cfg!.colonizationSupport!.E4N57.allowedTransitRooms = ["E3N57"];
    expect(getColonizationTravelPathKey("E2N57", "E4N57", route, [])).toBe(unrelated);
  });
});
