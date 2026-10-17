jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: jest.fn(() => false) }));
jest.mock("@/runtime/roomReserve", () => ({ isRoomInReserveMode: jest.fn(() => false) }));
import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { isSpawnConfigEconomicallyBlocked, canStartOutboundMission } from "@/runtime/outboundMissionPolicy";
import { pushBlockingCreep } from "@/movement/traffic";

describe("本房防御与储备的出征边界", () => {
  beforeEach(() => { jest.mocked(isDefenseMode).mockReturnValue(false); jest.mocked(isRoomInReserveMode).mockReturnValue(false); });
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
