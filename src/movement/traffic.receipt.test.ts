import { cancelMoveIntent, getMoveIntentDestination, getMoveIntentReceipt, issueMove } from "@/movement/traffic";
import { moveToTarget } from "@/movement/pathing";
import { createMockPowerBankCreep } from "@mock/powerBank";
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ measureCreepIntent: (fn: () => unknown) => fn() }));

beforeEach(() => {
  Game.time += 1;
  Object.assign(Game, { map: { describeExits: jest.fn((name: string) => name === "W0N0" ? { [RIGHT]: "E0N0" } : { [LEFT]: "W0N0" }) } });
});

describe("actual move receipts", () => {
  it("copies immutable coordinates only after native move accepts and expires next tick", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", { roomName: "W0N0", x: 10, y: 10 });
    expect(issueMove(creep, RIGHT)).toBe(OK);
    const receipt = getMoveIntentReceipt(creep)!;
    expect(receipt.from).toEqual({ x: 10, y: 10, roomName: "W0N0" });
    expect(receipt.to).toEqual({ x: 11, y: 10, roomName: "W0N0" });
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.from)).toBe(true);
    creep.pos.x = 12;
    expect(receipt.from.x).toBe(10);
    Game.time += 1; expect(getMoveIntentReceipt(creep)).toBeUndefined();
  });
  it("tracks the last accepted intent and does not erase it for a failed attempt", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker");
    issueMove(creep, RIGHT);
    (creep.move as jest.Mock).mockReturnValue(ERR_TIRED);
    expect(issueMove(creep, TOP)).toBe(ERR_TIRED);
    expect(getMoveIntentReceipt(creep)!.direction).toBe(RIGHT);
    (creep.move as jest.Mock).mockReturnValue(OK); issueMove(creep, LEFT);
    expect(getMoveIntentReceipt(creep)!.direction).toBe(LEFT);
  });
  it("does not create a receipt for canonical in-range OK", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker");
    expect(moveToTarget(creep, creep.pos, 1)).toBe(OK);
    expect(creep.move).not.toHaveBeenCalled(); expect(getMoveIntentReceipt(creep)).toBeUndefined();
  });
  it("keeps same-name power creep and standard creep receipts separate", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", { name: "same" });
    const powerCreep = { ...creep, powers: {}, id: "pc", name: "same", move: jest.fn(() => OK) } as unknown as PowerCreep;
    issueMove(creep, RIGHT); issueMove(powerCreep, TOP);
    expect(getMoveIntentReceipt(creep)!.direction).toBe(RIGHT); expect(getMoveIntentReceipt(powerCreep)!.direction).toBe(TOP);
  });
  it("cancels only the still-current successful receipt and preserves it when cancellation fails", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker");
    Object.assign(creep, { cancelOrder: jest.fn(() => ERR_NOT_FOUND) });
    issueMove(creep, RIGHT); const first = getMoveIntentReceipt(creep)!;
    expect(cancelMoveIntent(creep, first)).toBe(false); expect(getMoveIntentReceipt(creep)).toBe(first);
    issueMove(creep, TOP); const second = getMoveIntentReceipt(creep)!;
    expect(cancelMoveIntent(creep, first)).toBe(false);
    (creep.cancelOrder as jest.Mock).mockReturnValue(OK);
    expect(cancelMoveIntent(creep, second)).toBe(true); expect(getMoveIntentReceipt(creep)).toBeUndefined();
  });
  it("does not reuse receipts across a new Game owner at the same tick", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker");
    issueMove(creep, RIGHT);
    Object.assign(global, { Game: { ...Game } });
    expect(getMoveIntentReceipt(creep)).toBeUndefined();
  });
  it("distinguishes the attempted exit tile from the migrated position, and records entry bounce", () => {
    const creep = createMockPowerBankCreep("powerBankAttacker", { roomName: "W0N0", x: 48, y: 25 });
    issueMove(creep, RIGHT);
    expect(getMoveIntentReceipt(creep)!.attempted).toEqual({ x: 49, y: 25, roomName: "W0N0" });
    expect(getMoveIntentReceipt(creep)!.to).toEqual({ x: 0, y: 25, roomName: "E0N0" });
    expect(getMoveIntentDestination({ x: 0, y: 25, roomName: "E0N0" }, TOP)).toEqual({ x: 49, y: 24, roomName: "W0N0" });
    expect(getMoveIntentDestination({ x: 0, y: 25, roomName: "E0N0" }, RIGHT)).toEqual({ x: 1, y: 25, roomName: "E0N0" });
  });
  it("does not project inaccessible closed rooms as a valid final tile", () => {
    Game.map.getRoomStatus = jest.fn(() => ({ status: "closed" as const, timestamp: null }));
    expect(getMoveIntentDestination({ x: 48, y: 25, roomName: "W0N0" }, RIGHT)).toBeNull();
  });
  it("requires a proven one-axis map exit for border destinations", () => {
    expect(getMoveIntentDestination({ x: 48, y: 25, roomName: "W0N0" }, TOP_RIGHT)).toEqual({ x: 0, y: 24, roomName: "E0N0" });
    expect(getMoveIntentDestination({ x: 48, y: 1, roomName: "W0N0" }, TOP_RIGHT)).toBeNull();
    expect(getMoveIntentDestination({ x: 0, y: 25, roomName: "W0N0" }, LEFT)).toBeNull();
  });
});
