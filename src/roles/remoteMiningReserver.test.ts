jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

jest.mock("@/runtime/remoteMining", () => ({
  getMyUsername: jest.fn(() => "Player1"),
}));

import { remoteMiningReserverRole } from "@/roles/remoteMiningReserver";
import { moveToTarget } from "@/roles/shared";

function makeController(overrides: Partial<StructureController> = {}): StructureController {
  return {
    my: false,
    owner: undefined,
    reservation: undefined,
    ...overrides,
  } as unknown as StructureController;
}

function makeCreep(room: Room, extras: Partial<Creep> = {}): Creep {
  return {
    room,
    reserveController: jest.fn(() => OK),
    claimController: jest.fn(),
    attackController: jest.fn(),
    ...extras,
  } as unknown as Creep;
}

function makeRoom(name: string, controller: StructureController | null): Room {
  return {
    name,
    controller,
  } as unknown as Room;
}

describe("remoteMiningReserverRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("target phase – reservation", () => {

    it("moves toward controller when not in range", () => {
      const controller = makeController();
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room, {
        reserveController: jest.fn(() => ERR_NOT_IN_RANGE),
      });

      remoteMiningReserverRole("W5N5").target(creep);

      expect(creep.reserveController).toHaveBeenCalledWith(controller);
      expect(moveToTarget).toHaveBeenCalledWith(creep, controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
    });
  });

  describe("target phase – safety guards", () => {

    it("清除 Invader 预定，清零后立即切回正常 reserve", () => {
      const controller = makeController({ reservation: { username: "Invader", ticksToEnd: 4000 } });
      const creep = makeCreep(makeRoom("W5N5", controller), { attackController: jest.fn(() => OK) });
      const role = remoteMiningReserverRole("W5N5");
      role.target(creep);
      expect(creep.attackController).toHaveBeenCalledWith(controller);
      expect(creep.reserveController).not.toHaveBeenCalled();
      delete controller.reservation;
      role.target(creep);
      expect(creep.reserveController).toHaveBeenCalledWith(controller);
    });
    it("does nothing on a hostile-reserved controller", () => {
      const controller = makeController({
        reservation: { username: "OtherPlayer", ticksToEnd: 4000 },
      });
      const room = makeRoom("W5N5", controller);
      const creep = makeCreep(room);

      const result = remoteMiningReserverRole("W5N5").target(creep);

      expect(result).toBe(false);
      expect(creep.reserveController).not.toHaveBeenCalled();
      expect(creep.claimController).not.toHaveBeenCalled();
      expect(creep.attackController).not.toHaveBeenCalled();
    });
  });
});
