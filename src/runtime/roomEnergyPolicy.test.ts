import { resolveRoomEnergyPolicy, resolveRoomEnergyPolicyForRoom } from "@/runtime/roomEnergyPolicy";

describe("resolveRoomEnergyPolicy", () => {
  it("returns the existing resource-control defaults when config is absent", () => {
    expect(resolveRoomEnergyPolicy(undefined)).toEqual({
      energyFloor: 120_000,
      energyTarget: 200_000,
      energyExportStart: 250_000,
      terminalEnergyReserve: 25_000,
    });
  });

  it("clamps invalid values with the existing resource-control bounds", () => {
    expect(
      resolveRoomEnergyPolicy({
        energyFloor: -1,
        energyTarget: Number.POSITIVE_INFINITY,
        energyExportStart: 4_000_000,
        terminalEnergyReserve: 400_000,
      }),
    ).toEqual({
      energyFloor: 0,
      energyTarget: 200_000,
      energyExportStart: 3_000_000,
      terminalEnergyReserve: 300_000,
    });
  });
});

it("HUB 显式恢复阈值同时约束能量消费者与外运", () => {
  Memory.cfg = { hub: { enabled: true, hubRoomName: "W1N1" }, factoryControl: { enabled: true,
    hub: { energyFloor: 200_000, energyTarget: 250_000, energyCompressionStart: 400_000 } } };
  expect(resolveRoomEnergyPolicyForRoom("W1N1")).toMatchObject({ energyFloor: 200_000, energyTarget: 250_000, energyExportStart: 400_600, terminalEnergyReserve: 25_000 });
  expect(resolveRoomEnergyPolicyForRoom("W2N2").energyFloor).toBe(120_000);
});
