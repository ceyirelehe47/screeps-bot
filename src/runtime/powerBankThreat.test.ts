import { getPowerBankRoomThreat } from "@/runtime/powerBankThreat";

function roomWithEnemies(creeps: Partial<Creep>[] = [], powers: Partial<PowerCreep>[] = []): Room {
  return { find: jest.fn((kind: FindConstant) => kind === FIND_HOSTILE_CREEPS ? creeps : kind === FIND_HOSTILE_POWER_CREEPS ? powers : []) } as unknown as Room;
}

describe("PowerBank 观察威胁", () => {
  it("不把敌方纯MOVE侦察兵当作战斗威胁", () => {
    expect(getPowerBankRoomThreat(roomWithEnemies([{ getActiveBodyparts: jest.fn(() => 0) }]))).toBe(false);
  });
  it.each([ATTACK, RANGED_ATTACK, HEAL])("识别敌方有效 %s 部件", (part) => {
    expect(getPowerBankRoomThreat(roomWithEnemies([{ getActiveBodyparts: jest.fn((kind: BodyPartConstant) => kind === part ? 1 : 0) }]))).toBe(true);
  });
  it("未知敌方能力及敌方PowerCreep保守拒绝新投入", () => {
    expect(getPowerBankRoomThreat(roomWithEnemies([{}]))).toBe(true);
    expect(getPowerBankRoomThreat(roomWithEnemies([], [{}]))).toBe(true);
  });
});
