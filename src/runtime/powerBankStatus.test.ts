import {
  powerBankStatusCommand,
  powerBankStatusRaw,
} from "@/runtime/powerBankStatus";
import { POWER_BANK_STATUS } from "@/runtime/powerBankConstants";

function makeTask(overrides: Partial<PowerBankHarvestTask> = {}): PowerBankHarvestTask {
  return {
    id: overrides.id ?? "pb-status",
    status: overrides.status ?? POWER_BANK_STATUS.ATTACKING,
    sourceRoom: overrides.sourceRoom ?? "E5N55",
    targetRoom: overrides.targetRoom ?? "E0N60",
    bankId: overrides.bankId ?? "bank-status",
    bankPos: overrides.bankPos ?? { x: 25, y: 25 },
    hits: overrides.hits ?? 1_000_000,
    power: overrides.power ?? 3000,
    ticksToDecay: overrides.ticksToDecay ?? 2000,
    freeTiles: overrides.freeTiles ?? 4,
    discoveredTick: overrides.discoveredTick ?? 50,
    lastSeenTick: overrides.lastSeenTick ?? 90,
    haulerIds: overrides.haulerIds ?? [],
    boostLabs: overrides.boostLabs ?? [],
    compoundTransferTaskIds: overrides.compoundTransferTaskIds ?? [],
    ...overrides,
  };
}

describe("powerBankStatus", () => {
  beforeEach(() => {
    Game.time = 100;
    Memory.data = {
      powerBankHarvest: {},
      powerBankHarvestHistory: [],
    };
  });

  it("projects stage age, deadline slack, pair state and recovery ledger", () => {
    const task = makeTask({
      stageEnteredAt: 80,
      lastProgressAt: 95,
      bankExpiresAt: 500,
      activeGeneration: 2,
      combatReady: true,
      attackerId: "attacker-2",
      healerId: "healer-2",
      reinforcement: {
        index: 3,
        generation: 3,
        stage: "travelling",
        attackerId: "attacker-3",
        healerId: "healer-3",
        attackerReady: true,
        healerReady: false,
        combatReady: true,
        stageEnteredAt: 90,
        lastProgressAt: 96,
        blocker: "reinforcement_travel_no_progress",
      },
      blocker: "active_pair_not_adjacent",
      plannedDps: 1920,
      plannedHps: 300,
      plannedTtk: 521,
      pathDistance: 180,
      combatTravelTicks: 240,
      haulerOutboundTravelTicks: 180,
      haulerReturnTravelTicks: 260,
      plannedHaulerSpawnStartTick: 130,
      plannedHaulerArrivalTick: 230,
      observedPower: 3000,
      pickedUpPower: 1250,
      deliveredPower: 500,
    });
    Memory.data!.powerBankHarvest![task.id] = task;

    expect(powerBankStatusRaw().tasks[0]).toMatchObject({
      taskId: "pb-status",
      stageAge: 20,
      expiresIn: 400,
      lastProgressAge: 5,
      activeGeneration: 2,
      combatReady: true,
      reinforcementGeneration: 3,
      reinforcementStage: "travelling",
      reinforcementCombatReady: true,
      reinforcementAttackerReady: true,
      reinforcementHealerReady: false,
      reinforcementAttackerId: "attacker-3",
      reinforcementHealerId: "healer-3",
      reinforcementStageAge: 10,
      reinforcementLastProgressAge: 4,
      reinforcementBlocker: "reinforcement_travel_no_progress",
      blocker: "active_pair_not_adjacent",
      plannedDps: 1920,
      pathDistance: 180,
      combatTravelTicks: 240,
      haulerOutboundTravelTicks: 180,
      haulerReturnTravelTicks: 260,
      haulerSpawnIn: 30,
      haulerArrivalIn: 130,
      deliveredPower: 500,
    });
    expect(JSON.parse(powerBankStatusCommand()).ok).toBe(true);
  });

  it("returns explicit empty reinforcement fields when no replacement exists", () => {
    const task = makeTask();
    Memory.data!.powerBankHarvest![task.id] = task;

    expect(powerBankStatusRaw().tasks[0]).toMatchObject({
      pathDistance: null,
      combatTravelTicks: null,
      haulerOutboundTravelTicks: null,
      haulerReturnTravelTicks: null,
      reinforcementGeneration: null,
      reinforcementStage: null,
      reinforcementCombatReady: false,
      reinforcementAttackerReady: false,
      reinforcementHealerReady: false,
      reinforcementAttackerId: null,
      reinforcementHealerId: null,
      reinforcementStageAge: null,
      reinforcementLastProgressAge: null,
      reinforcementBlocker: null,
    });
  });
});
