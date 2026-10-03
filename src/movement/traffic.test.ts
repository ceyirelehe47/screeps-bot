import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";
import { cancelMoveIntent, getMoveIntentReceipt, issueMove, moveToAdjacentPosition } from "@/movement/traffic";

jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
}));

import { getTickContextService } from "@/runtime/runtimeServices";

function setupRoomContext(creeps: Creep[] = []) {
  (getTickContextService as jest.Mock).mockReturnValue({
    getRoomContext: jest.fn(() => ({
      room: { name: "W1N1", controller: undefined },
      getMyCreeps: jest.fn(() => creeps),
      getStructures: jest.fn(() => []),
      getConstructionSites: jest.fn(() => []),
      getSources: jest.fn(() => []),
      getMinerals: jest.fn(() => []),
      getDeposits: jest.fn(() => []),
    })),
  });
}

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => any) => fn(),
}));

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | { pos: RoomPosition }): number {
    const pos = "pos" in target ? target.pos : target;
    return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }

  public getDirectionTo(target: RoomPosition): DirectionConstant {
    const dx = Math.sign(target.x - this.x);
    const dy = Math.sign(target.y - this.y);
    if (dx === 0 && dy === -1) return TOP;
    if (dx === 1 && dy === -1) return TOP_RIGHT;
    if (dx === 1 && dy === 0) return RIGHT;
    if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
    if (dx === 0 && dy === 1) return BOTTOM;
    if (dx === -1 && dy === 1) return BOTTOM_LEFT;
    if (dx === -1 && dy === 0) return LEFT;
    return TOP_LEFT;
  }
}

function makeCreep(name: string, x: number, y: number, roomName = "W1N1") {
  const pos = new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
  return {
    name,
    pos,
    room: { name: roomName } as Room,
    move: jest.fn(() => OK),
    memory: {},
  } as unknown as Creep;
}


function planHeadOnStep(creep: Creep, target: RoomPosition): void {
  ensureCreepMovementState(creep).movePathState = {
    key: "head-on",
    steps: [
      { x: creep.pos.x, y: creep.pos.y },
      { x: target.x, y: target.y },
    ],
    cursor: -1,
    targetRoom: target.roomName,
    targetX: target.x,
    targetY: target.y,
    range: 0,
    stuckTicks: 0,
    expiresAt: Game.time + 1,
  };
}

describe("moveToAdjacentPosition", () => {
  beforeEach(() => {
    clearCreepMovementStateForTest();
    Game.powerCreeps = {};
    Object.assign(global, { RoomPosition: MockRoomPosition });
    Object.assign(Game, {
      map: {
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
      },
    });
  });

  it("returns ERR_BUSY when stationary blocker returns ERR_TIRED on push attempt", () => {
    const pusher = makeCreep("pusher", 10, 10);
    const blocker = makeCreep("blocker", 11, 10);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    const nextPos = new MockRoomPosition(11, 10, "W1N1") as unknown as RoomPosition;

    setupRoomContext([pusher, blocker]);

    const result = moveToAdjacentPosition(pusher, nextPos);

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
  });

  it("实际下一格空闲时不会推动身后或其它邻格的 creep", () => {
    const actor = makeCreep("actor", 10, 10), behind = makeCreep("heal", 9, 10), beside = makeCreep("worker", 11, 11);
    setupRoomContext([actor, behind, beside]);
    expect(moveToAdjacentPosition(actor, new MockRoomPosition(11, 10, "W1N1") as RoomPosition)).toBe(OK);
    expect(actor.move).toHaveBeenCalledWith(RIGHT);
    expect(behind.move).not.toHaveBeenCalled(); expect(beside.move).not.toHaveBeenCalled();
  });

  it("已提交让路移动的挡位者只移动一次，不因帧初坐标再次被推回去", () => {
    const actor = makeCreep("actor", 10, 10), blocker = makeCreep("blocker", 11, 10);
    setupRoomContext([actor, blocker]);
    expect(issueMove(blocker, RIGHT)).toBe(OK);
    expect(moveToAdjacentPosition(actor, blocker.pos)).toBe(OK);
    expect(blocker.move).toHaveBeenCalledTimes(1);
    expect(blocker.move).toHaveBeenCalledWith(RIGHT);
  });

  it("普通单位也遵守已提交的下一格，取消真实意图后该落点才重新可用", () => {
    const actor = makeCreep("actor", 10, 10), other = makeCreep("other", 11, 11);
    setupRoomContext([actor, other]);
    Object.assign(other, { cancelOrder: jest.fn(() => OK) });
    issueMove(other, TOP);
    const destination = new MockRoomPosition(11, 10, "W1N1") as RoomPosition;
    expect(moveToAdjacentPosition(actor, destination)).toBe(ERR_BUSY);
    expect(actor.move).not.toHaveBeenCalled(); expect(other.move).toHaveBeenCalledTimes(1);
    expect(cancelMoveIntent(other, getMoveIntentReceipt(other)!)).toBe(true);
    expect(moveToAdjacentPosition(actor, destination)).toBe(OK);
    expect(actor.move).toHaveBeenCalledWith(RIGHT);
  });

  it("fails closed when only one War member points at the other", () => {
    const attacker = makeCreep("attacker-drift", 10, 10);
    const healer = makeCreep("healer-drift", 11, 10);
    const attackerConfig = "W1N1:war:W2N2:meleeAttacker:0";
    const healerConfig = "W1N1:war:W2N2:healer:0";
    Object.assign(attacker.memory, {
      role: "meleeAttacker",
      configName: attackerConfig,
      _warPartnerConfigName: healerConfig,
    });
    Object.assign(healer.memory, {
      role: "healer",
      configName: healerConfig,
      _warPartnerConfigName: "W1N1:war:W2N2:meleeAttacker:other",
    });
    planHeadOnStep(healer, attacker.pos);
    setupRoomContext([attacker, healer]);

    const result = moveToAdjacentPosition(attacker, healer.pos);

    expect(result).toBe(OK);
    expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
  });
});
