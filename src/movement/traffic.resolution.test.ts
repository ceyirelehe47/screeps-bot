import { getMoveIntentReceipt, issueMove, registerSquadMovement, resolveTrafficIntents } from "./traffic";
import { getTickContextService } from "@/runtime/runtimeServices";
jest.mock("@/runtime/runtimeServices", () => ({ getTickContextService: jest.fn() }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ measureCreepIntent: (fn: () => unknown) => fn() }));
let actors: Creep[];
function actor(name: string, x: number, y: number, roomName = "W0N0"): Creep {
  const creep = { id: name, name, pos: { x, y, roomName }, room: { name: roomName }, memory: {},
    move: jest.fn(() => OK), cancelOrder: jest.fn(() => OK) } as unknown as Creep;
  actors.push(creep); return creep;
}
beforeEach(() => {
  Game.time++; actors = []; Game.powerCreeps = {};
  Game.map = { ...Game.map, describeExits: jest.fn(name => name === "W0N0" ? { [RIGHT]: "E0N0" } : { [LEFT]: "W0N0" }) } as GameMap;
  (getTickContextService as jest.Mock).mockReturnValue({ getAllCreeps: () => actors });
});
it("keeps the first native accepted move and requires its receipt for an explicit replacement", () => {
  const a = actor("a", 10, 10);
  expect(issueMove(a, RIGHT)).toBe(OK);
  expect(issueMove(a, RIGHT)).toBe(OK);
  expect(issueMove(a, TOP)).toBe(ERR_BUSY);
  expect(a.move).toHaveBeenCalledTimes(1);
  const old = getMoveIntentReceipt(a)!;
  expect(issueMove(a, TOP, old)).toBe(OK);
  expect(getMoveIntentReceipt(a)!.direction).toBe(TOP);
});
it("resolves duplicate destinations deterministically", () => {
  const b = actor("b", 12, 10), a = actor("a", 10, 10);
  issueMove(b, LEFT); issueMove(a, RIGHT);
  expect(resolveTrafficIntents()).toEqual({ checked: 2, canceled: 1, unresolved: 0 });
  expect(a.cancelOrder).not.toHaveBeenCalled(); expect(b.cancelOrder).toHaveBeenCalledWith("move");
});
it("propagates stationary blockers but preserves swaps and closed movement cycles", () => {
  const a = actor("a", 10, 10), b = actor("b", 11, 10); actor("stationary", 12, 10);
  issueMove(a, RIGHT); issueMove(b, RIGHT);
  expect(resolveTrafficIntents().canceled).toBe(2);
  Game.time++; actors.pop();
  issueMove(a, RIGHT); issueMove(b, LEFT);
  expect(resolveTrafficIntents().canceled).toBe(0);
});
it("cancels both crossing members when one loses a destination, preserving an unrelated winner", () => {
  const leader = actor("z-leader", 48, 10), follower = actor("z-follower", 48, 11), other = actor("a-other", 48, 12);
  registerSquadMovement({ owner: "pb", taskId: "b", generation: 2, leader, follower });
  issueMove(leader, RIGHT); issueMove(follower, RIGHT); issueMove(other, TOP_RIGHT);
  expect(resolveTrafficIntents().canceled).toBe(2);
  expect(getMoveIntentReceipt(leader)).toBeUndefined(); expect(getMoveIntentReceipt(follower)).toBeUndefined();
  expect(getMoveIntentReceipt(other)).toBeDefined();
});
it("keeps failed native attempts out of the solver and reports failed cancellations", () => {
  const a = actor("a", 10, 10), b = actor("b", 11, 10);
  (b.move as jest.Mock).mockReturnValue(ERR_TIRED);
  expect(issueMove(b, RIGHT)).toBe(ERR_TIRED); expect(getMoveIntentReceipt(b)).toBeUndefined();
  issueMove(a, RIGHT); (a.cancelOrder as jest.Mock).mockReturnValue(ERR_NOT_FOUND);
  expect(resolveTrafficIntents()).toEqual({ checked: 1, canceled: 0, unresolved: 1 });
  expect(getMoveIntentReceipt(a)).toBeDefined();
});

it("lets an actor take over its provisional yield while keeping formal moves protected", () => {
  const a = actor("a", 10, 10);
  expect(issueMove(a, RIGHT, undefined, "yield")).toBe(OK);
  expect(issueMove(a, LEFT)).toBe(OK);
  expect(getMoveIntentReceipt(a)).toMatchObject({ direction: LEFT, kind: "role" });
  expect(issueMove(a, RIGHT, undefined, "yield")).toBe(ERR_BUSY);
});
