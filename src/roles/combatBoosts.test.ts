jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/runtime/powerBankBoostMemory", () => ({
  getAssignedPowerBankBoostLabId: jest.fn(),
}));

import { prepareCombatBoost } from "@/roles/combatBoosts";
import { getAssignedPowerBankBoostLabId } from "@/runtime/powerBankBoostMemory";
import { createMockStore } from "@mock/powerBank";

const mockedGetAssignedLabId = getAssignedPowerBankBoostLabId as jest.MockedFunction<
  typeof getAssignedPowerBankBoostLabId
>;

function createAttacker(): Creep {
  return {
    body: [{ type: ATTACK, hits: 100 }],
    memory: {},
    pos: { isNearTo: jest.fn(() => true) } as unknown as RoomPosition,
  } as unknown as Creep;
}


function createBoostLab(energy: number): StructureLab {
  return {
    id: "lab-1" as Id<StructureLab>,
    store: createMockStore({
      [RESOURCE_CATALYZED_UTRIUM_ACID]: LAB_BOOST_MINERAL,
      [RESOURCE_ENERGY]: energy,
    }),
    boostCreep: jest.fn(() => OK),
  } as unknown as StructureLab;
}

describe("prepareCombatBoost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetAssignedLabId.mockReturnValue("lab-1");
  });

  it("does not issue a boost intent when the assigned lab lacks energy", () => {
    const lab = createBoostLab(0);
    Game.getObjectById = jest.fn(() => lab) as typeof Game.getObjectById;

    const ready = prepareCombatBoost(
      createAttacker(),
      "war:E1N57:E2N54:g1",
      RESOURCE_CATALYZED_UTRIUM_ACID,
    );

    expect(ready).toBe(false);
    expect(lab.boostCreep).not.toHaveBeenCalled();
  });

  it("issues a boost intent when the assigned lab has mineral and energy", () => {
    const lab = createBoostLab(LAB_BOOST_ENERGY);
    Game.getObjectById = jest.fn(() => lab) as typeof Game.getObjectById;
    const creep = createAttacker();

    const ready = prepareCombatBoost(
      creep,
      "war:E1N57:E2N54:g1",
      RESOURCE_CATALYZED_UTRIUM_ACID,
    );

    expect(ready).toBe(false);
    expect(lab.boostCreep).toHaveBeenCalledWith(creep);
  });
});


it.each([false, true])("非战争 boost 等待超时后保留身份并直接工作（已分配但缺料=%s）", hasLab => {
  const creep = { ...createAttacker(), name: `helper-${hasLab}`, room: { name: "W1N1" }, memory: { configName: "W1N1:colonizationSupport:W1N2:worker:0" } } as unknown as Creep;
  Game.creeps = { [creep.name]: creep }; Game.time = 1000;
  const lab = createBoostLab(0);
  Game.getObjectById = jest.fn(() => hasLab ? lab : null) as typeof Game.getObjectById;
  expect(prepareCombatBoost(creep, "support-owner", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
  Game.time += 100;
  expect(prepareCombatBoost(creep, "support-owner", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(true);
  expect(creep.memory.configName).toBe("W1N1:colonizationSupport:W1N2:worker:0");
  expect(creep.memory._recycleToRoom).toBeUndefined(); expect(creep.memory._warDetached).toBeUndefined();
  Game.time++;
  expect(prepareCombatBoost(creep, "support-owner", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(true);
});
it("战争缺少强化时超时仍回收，不放行无强化出击", () => {
  const creep = { ...createAttacker(), name: "war-wait", room: { name: "W1N1" }, memory: { configName: "W1N1:war:W1N2:meleeAttacker:0" } } as unknown as Creep;
  Game.creeps = { [creep.name]: creep }; Game.time = 2000; Game.getObjectById = jest.fn(() => null);
  expect(prepareCombatBoost(creep, "war-owner", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
  Game.time += 100;
  expect(prepareCombatBoost(creep, "war-owner", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
  expect(creep.memory._warDetached).toBe(true); expect(creep.memory.configName).toBeUndefined();
});
