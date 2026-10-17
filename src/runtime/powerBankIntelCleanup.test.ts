jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));
import { cleanupPowerBankRoomIntel } from "@/runtime/powerBankIntelCleanup";
import { requestCombatObservation } from "@/runtime/powerBankObserver";

beforeEach(() => {
  jest.clearAllMocks();
  Game.time = 17;
  Game.rooms = {};
  Memory.runtime = {};
});

it("没有新视野时，过期记录继续避让并安排有界观察复核", () => {
  Game.time = 60_000;
  Memory.runtime!.powerBankOwnedRoomIntel = Object.fromEntries([1, 2, 3, 4].map(n => [`E${n}N1`, { owner: "enemy", lastSeenAt: 1 }]));
  cleanupPowerBankRoomIntel();
  expect(Object.keys(Memory.runtime!.powerBankOwnedRoomIntel!)).toHaveLength(4);
  expect(requestCombatObservation).toHaveBeenCalledTimes(3);
  cleanupPowerBankRoomIntel();
  expect(requestCombatObservation).toHaveBeenCalledTimes(3);
  Game.time += 500;
  cleanupPowerBankRoomIntel();
  expect(requestCombatObservation).toHaveBeenCalledWith("E4N1");
});

it("只清理原生视野确认无主或己方控制的危险记录，保留敌方 reservation", () => {
  Memory.runtime!.powerBankPermanentDangerRooms = { E1N1: true, E2N1: true, E3N1: true, E4N1: true, E5N1: true };
  Memory.runtime!.powerBankOwnedRoomIntel = { E1N1: { owner: "enemy", lastSeenAt: 1 }, E5N1: { owner: "enemy", lastSeenAt: 1 } };
  Game.rooms = {
    E1N1: { controller: {} },
    E2N1: { controller: { my: true } },
    E3N1: { controller: { reservation: { username: "enemy" } } },
    E4N1: { controller: { owner: { username: "enemy" } } },
  } as unknown as Game["rooms"];
  cleanupPowerBankRoomIntel();
  expect(Memory.runtime!.powerBankPermanentDangerRooms).toEqual({ E3N1: true, E4N1: true, E5N1: true });
  expect(Memory.runtime!.powerBankOwnedRoomIntel).toEqual({ E5N1: { owner: "enemy", lastSeenAt: 1 } });
});
