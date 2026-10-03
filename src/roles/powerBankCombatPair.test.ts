jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(), moveToTarget: jest.fn(), moveToTargetRoom: jest.fn(),
}));
jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn() }));
jest.mock("@/runtime/runtimeServices", () => ({ getTickContextService: jest.fn() }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ measureCreepIntent: (fn: () => unknown) => fn() }));

import { powerBankAttackerRole } from "@/roles/powerBankAttacker";
import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { clearCreepMovementStateForTest, clearCreepMovementState, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { getMoveIntentReceipt, issueMove, isBlockerActivelyMoving } from "@/movement/traffic";
import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getTickContextService } from "@/runtime/runtimeServices";
import { createMockPowerBankCreep, createMockPowerBank } from "@mock/powerBank";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";

class PairPos {
  constructor(public x: number, public y: number, public roomName: string) {}
  getRangeTo(target: RoomPosition | { pos: RoomPosition }): number {
    const pos = "pos" in target ? target.pos : target;
    return pos.roomName !== this.roomName ? Infinity : Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }
  isNearTo(target: RoomPosition | { pos: RoomPosition }): boolean { return this.getRangeTo(target) <= 1; }
  getDirectionTo(target: RoomPosition): DirectionConstant {
    const dx = Math.sign(target.x - this.x), dy = Math.sign(target.y - this.y);
    return (dx === 0 ? (dy < 0 ? TOP : BOTTOM) : dx > 0 ?
      (dy < 0 ? TOP_RIGHT : dy > 0 ? BOTTOM_RIGHT : RIGHT) :
      (dy < 0 ? TOP_LEFT : dy > 0 ? BOTTOM_LEFT : LEFT));
  }
}

const SOURCE = "W0N0", TARGET = "E0N0", TASK = "pair-task";
let attacker: Creep, healer: Creep;
let pending: Map<Creep, DirectionConstant>;
let walls: Set<string>;
let routeDirection: DirectionConstant;
let targetDirection: DirectionConstant;
const attackerRole = powerBankAttackerRole(TARGET, `${SOURCE}|${TARGET}`);
const healerRole = powerBankHealerRole(TARGET, `${SOURCE}|${TARGET}`);

function position(creep: Creep): { x: number; y: number; roomName: string } {
  return { x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName };
}
function place(creep: Creep, x: number, y: number, roomName = SOURCE): void {
  const room = Game.rooms[roomName] ?? ({ name: roomName, findExitTo: jest.fn(() => RIGHT), lookForAt: jest.fn(() => []) } as unknown as Room);
  Game.rooms[roomName] = room;
  Object.assign(creep, { pos: new PairPos(x, y, roomName), room });
}
function calls(order: "attacker-first" | "healer-first"): void {
  const red = () => { attackerRole.source!(attacker); attackerRole.target(attacker); };
  const green = () => { healerRole.source!(healer); healerRole.target(healer); };
  if (order === "attacker-first") { red(); green(); } else { green(); red(); }
}
/** 原生意图仅入队；角色执行期间 Game.pos 始终是帧初状态。 */
function commitFrame(): void {
  // 按已读取 Engine 4.3 movement.add + creeps/tick 重现；不调用被测 receipt 几何。
  const offsets: Record<DirectionConstant, readonly [number, number]> = {
    [TOP]: [0, -1], [TOP_RIGHT]: [1, -1], [RIGHT]: [1, 0], [BOTTOM_RIGHT]: [1, 1],
    [BOTTOM]: [0, 1], [BOTTOM_LEFT]: [-1, 1], [LEFT]: [-1, 0], [TOP_LEFT]: [-1, -1],
  };
  const destinations = Object.values(Game.creeps).map((creep) => {
    const delta = pending.has(creep) ? offsets[pending.get(creep)!] : [0, 0];
    let x = Math.max(0, Math.min(49, creep.pos.x + delta[0]));
    let y = Math.max(0, Math.min(49, creep.pos.y + delta[1]));
    let roomName = creep.pos.roomName;
    const exit = x === 0 ? LEFT : y === 0 ? TOP : x === 49 ? RIGHT : y === 49 ? BOTTOM : undefined;
    if (exit !== undefined) {
      const nextRoom = Game.map.describeExits(roomName)?.[exit];
      if (nextRoom) {
        roomName = nextRoom;
        if (exit === LEFT) x = 49; else if (exit === RIGHT) x = 0;
        else if (exit === TOP) y = 49; else y = 0;
      }
    }
    return { creep, x, y, roomName };
  });
  for (const { creep, x, y, roomName } of destinations) place(creep, x, y, roomName);
  pending.clear();
  Game.time += 1;
}

function setStage(status: PowerBankHarvestStatus): void { Memory.data!.powerBankHarvest![TASK].status = status; }

beforeEach(() => {
  jest.clearAllMocks();
  clearCreepMovementStateForTest();
  Game.time += 1;
  Object.assign(global, { RoomPosition: PairPos });
  Game.rooms = {};
  Game.powerCreeps = {};
  Object.assign(Game, { map: {
    describeExits: jest.fn((room: string) => room === SOURCE ? { [RIGHT]: TARGET } : { [LEFT]: SOURCE }),
    getRoomTerrain: jest.fn(() => ({ get: () => 0 })),
  } });
  walls = new Set(); pending = new Map(); routeDirection = RIGHT; targetDirection = RIGHT;
  (getCachedStaticTravelMatrix as jest.Mock).mockImplementation((room: string) => ({
    get: (x: number, y: number) => walls.has(`${room}:${x}:${y}`) ? 255 : 0,
  }));
  attacker = createMockPowerBankCreep("powerBankAttacker", { id: "red", name: "red", memory: { taskId: TASK, pairGeneration: 1 } });
  healer = createMockPowerBankCreep("powerBankHealer", { id: "green", name: "green", memory: { taskId: TASK, pairGeneration: 1 } });
  place(attacker, 10, 10); place(healer, 9, 10);
  for (const creep of [attacker, healer]) {
    (creep.move as jest.Mock).mockImplementation((direction: DirectionConstant) => { pending.set(creep, direction); return OK; });
    Object.assign(creep, { cancelOrder: jest.fn((method: string) => {
      if (method !== "move" || !pending.has(creep)) return ERR_NOT_FOUND;
      pending.delete(creep); return OK;
    }) });
  }
  Game.creeps = { red: attacker, green: healer };
  (getTickContextService as jest.Mock).mockReturnValue({ getRoomContext: (owner: Room | string) => {
    const name = typeof owner === "string" ? owner : owner.name;
    return {
    room: Game.rooms[name],
    getMyCreeps: () => Object.values(Game.creeps).filter((creep) => creep.room.name === name),
    getStructures: () => [], getConstructionSites: () => [], getSources: () => [], getMinerals: () => [], getDeposits: () => [],
  }; } });
  const bank = createMockPowerBank({ id: "bank", x: 25, y: 10, roomName: TARGET });
  Game.getObjectById = jest.fn((id: string) => id === "bank" ? bank : Object.values(Game.creeps).find((creep) => creep.id === id) ?? null) as typeof Game.getObjectById;
  (Memory as any).data = { powerBankHarvest: { [TASK]: {
    id: TASK, status: "travelling", sourceRoom: SOURCE, targetRoom: TARGET, bankId: "bank",
    attackerId: "red", healerId: "green", activeGeneration: 1, combatReady: true,
    routeRooms: [SOURCE, TARGET], haulerIds: [], boostLabs: [], compoundTransferTaskIds: [],
  } } };
  (Memory as any).runtime = {};
  (clearMovementState as jest.Mock).mockImplementation((creep: Creep) => clearCreepMovementState(creep));
  (moveToTargetRoom as jest.Mock).mockImplementation((creep: Creep, room: string) =>
    creep.room.name === room ? OK : issueMove(creep, routeDirection));
  (moveToTarget as jest.Mock).mockImplementation((creep: Creep, target: RoomPosition | { pos: RoomPosition }, range: number) =>
    creep.pos.getRangeTo(target) <= range ? OK : issueMove(creep, targetDirection));
});

describe("PowerBank same-frame pair movement", () => {
  it.each(["attacker-first", "healer-first"] as const)("advances both each tick, independent of %s and source/target reentry", (order) => {
    for (let frame = 0; frame < 2; frame += 1) {
      const redBefore = position(attacker), greenBefore = position(healer);
      const previousRedCalls = (attacker.move as jest.Mock).mock.calls.length;
      const previousGreenCalls = (healer.move as jest.Mock).mock.calls.length;
      calls(order); calls(order);
      expect(position(attacker)).toEqual(redBefore); expect(position(healer)).toEqual(greenBefore);
      expect(attacker.move).toHaveBeenCalledTimes(previousRedCalls + 1);
      expect(healer.move).toHaveBeenCalledTimes(previousGreenCalls + 1);
      expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
      commitFrame();
      expect(position(attacker)).toEqual({ ...redBefore, x: redBefore.x + 1 });
      expect(position(healer)).toEqual(redBefore);
      expect(attacker.pos.isNearTo(healer.pos)).toBe(true);
    }
  });

  it("shares the bank approach plan even when the healer executes first", () => {
    setStage("attacking"); place(attacker, 10, 10, TARGET); place(healer, 9, 10, TARGET);
    calls("healer-first");
    expect(moveToTarget).toHaveBeenCalledTimes(1);
    expect(moveToTarget).toHaveBeenCalledWith(attacker, expect.objectContaining({ id: "bank" }), 1, expect.objectContaining({ ignoreCreeps: false }));
    expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
    expect(healer.heal).toHaveBeenCalledWith(attacker);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 11, y: 10, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 10, y: 10, roomName: TARGET });
  });

  it("keeps attack and heal while the pair holds beside the bank", () => {
    setStage("attacking"); place(attacker, 24, 10, TARGET); place(healer, 23, 10, TARGET);
    calls("healer-first");
    expect(attacker.attack).toHaveBeenCalled(); expect(healer.heal).toHaveBeenCalledWith(attacker);
    expect(pending.size).toBe(0);
  });

  it("never treats canonical OK without a native move as a next step", () => {
    (moveToTargetRoom as jest.Mock).mockReturnValue(OK);
    calls("healer-first");
    expect(attacker.move).not.toHaveBeenCalled(); expect(healer.move).not.toHaveBeenCalled();
  });

  it.each(["attacker", "healer"] as const)("holds both when %s is fatigued", (member) => {
    (member === "attacker" ? attacker : healer).fatigue = 2;
    calls("healer-first");
    expect(moveToTargetRoom).not.toHaveBeenCalled(); expect(pending.size).toBe(0);
  });

  it.each(["attacker", "healer"] as const)("holds both when %s has no active MOVE", (member) => {
    const creep = member === "attacker" ? attacker : healer;
    (creep.getActiveBodyparts as jest.Mock).mockImplementation((part: BodyPartConstant) => part === MOVE ? 0 : 1);
    calls("attacker-first"); expect(pending.size).toBe(0);
  });

  it("does not override a current push or spawn-yield move", () => {
    issueMove(healer, TOP);
    ensureCreepMovementState(healer).movementPushedAt = Game.time;
    calls("attacker-first");
    expect(pending.get(healer)).toBe(TOP); expect(attacker.move).not.toHaveBeenCalled();
    expect(healer.move).toHaveBeenCalledTimes(1);
  });

  it("retains the pending spawn-yield order before the yielding role has run", () => {
    healer.memory._spawnYield = { tick: Game.time, dir: TOP };
    calls("attacker-first"); expect(pending.size).toBe(0);
  });

  it.each([ERR_TIRED, ERR_NO_BODYPART, ERR_BUSY])("cancels only the leader's owned move when follower submission returns %s", (code) => {
    (healer.move as jest.Mock).mockReturnValue(code);
    calls("attacker-first"); calls("healer-first");
    expect(attacker.cancelOrder).toHaveBeenCalledTimes(1); expect(attacker.cancelOrder).toHaveBeenCalledWith("move");
    expect(getMoveIntentReceipt(attacker)).toBeUndefined(); expect(pending.size).toBe(0);
    expect(getCreepMovementState(attacker)).toBeUndefined();
    expect(getCreepMovementState(healer)).toBeUndefined();
    expect(isBlockerActivelyMoving(attacker)).toBe(false);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 10, y: 10, roomName: SOURCE });
    expect(position(healer)).toEqual({ x: 9, y: 10, roomName: SOURCE });
  });

  it("does not fake a canceled move when native cancellation fails", () => {
    (healer.move as jest.Mock).mockReturnValue(ERR_TIRED);
    (attacker.cancelOrder as jest.Mock).mockReturnValue(ERR_NOT_FOUND);
    calls("healer-first");
    expect(getMoveIntentReceipt(attacker)).toBeDefined();
    expect(pending.get(attacker)).toBe(RIGHT);
    expect(pending.has(healer)).toBe(false);
  });

  it("restores traffic activity after mount phase cleanup without duplicating moves", () => {
    calls("attacker-first");
    clearCreepMovementState(attacker); clearCreepMovementState(healer);
    calls("healer-first");
    expect(attacker.move).toHaveBeenCalledTimes(1); expect(healer.move).toHaveBeenCalledTimes(1);
    expect(ensureCreepMovementState(attacker).pathingRequestedAt).toBe(Game.time);
    expect(ensureCreepMovementState(healer).pathingRequestedAt).toBe(Game.time);
  });

  it.each([
    { direction: RIGHT, from: SOURCE, to: TARGET, red: [48, 25], green: [48, 26], finalRed: [0, 25], finalGreen: [0, 26] },
    { direction: LEFT, from: TARGET, to: SOURCE, red: [1, 25], green: [1, 26], finalRed: [49, 25], finalGreen: [49, 26] },
    { direction: TOP, from: SOURCE, to: "W0N1", red: [25, 1], green: [26, 1], finalRed: [25, 49], finalGreen: [26, 49] },
    { direction: BOTTOM, from: SOURCE, to: "W0S0", red: [25, 48], green: [26, 48], finalRed: [25, 0], finalGreen: [26, 0] },
  ])("crosses direction $direction with both members in one native frame", ({ direction, from, to, red, green, finalRed, finalGreen }) => {
    const task = Memory.data!.powerBankHarvest![TASK];
    task.sourceRoom = from; task.targetRoom = to; task.routeRooms = [from, to];
    Game.map.describeExits = jest.fn((room: string) => room === from ? { [direction]: to } : { [((direction + 3) % 8) + 1]: from }) as typeof Game.map.describeExits;
    place(attacker, red[0], red[1], from); place(healer, green[0], green[1], from);
    routeDirection = direction as DirectionConstant;
    calls("healer-first");
    expect(pending.get(attacker)).toBe(direction); expect(pending.get(healer)).toBe(direction);
    commitFrame();
    expect(position(attacker)).toEqual({ x: finalRed[0], y: finalRed[1], roomName: to });
    expect(position(healer)).toEqual({ x: finalGreen[0], y: finalGreen[1], roomName: to });
  });

  it("moves both inside after landing, rather than bouncing the follower into the previous room", () => {
    place(attacker, 48, 25); place(healer, 48, 26);
    calls("healer-first"); commitFrame();
    expect(position(attacker)).toEqual({ x: 0, y: 25, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 0, y: 26, roomName: TARGET });
    calls("attacker-first");
    expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 1, y: 25, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 1, y: 26, roomName: TARGET });
  });

  it("chooses a shared alternative when the follower's first inward destination is blocked", () => {
    place(attacker, 0, 25, TARGET); place(healer, 0, 26, TARGET);
    walls.add(`${TARGET}:1:26`);
    calls("healer-first");
    expect(pending.get(attacker)).toBe(TOP_RIGHT); expect(pending.get(healer)).toBe(TOP_RIGHT);
    expect(attacker.cancelOrder).not.toHaveBeenCalled();
    commitFrame();
    expect(position(attacker)).toEqual({ x: 1, y: 24, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 1, y: 25, roomName: TARGET });
  });

  it("aligns the tail at an exit first, then crosses together", () => {
    place(attacker, 48, 25); place(healer, 47, 25);
    calls("attacker-first");
    expect(attacker.move).not.toHaveBeenCalled(); expect(healer.move).toHaveBeenCalledTimes(1);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 48, y: 25, roomName: SOURCE });
    expect(healer.pos.x).toBe(48); expect(healer.pos.roomName).toBe(SOURCE);
    calls("healer-first"); commitFrame();
    expect(attacker.pos.roomName).toBe(TARGET); expect(healer.pos.roomName).toBe(TARGET);
    expect(attacker.pos.isNearTo(healer.pos)).toBe(true);
  });

  it("stages from the actual canonical exit when a legacy dynamic route differs from findExitTo", () => {
    delete Memory.data!.powerBankHarvest![TASK].routeRooms;
    place(attacker, 48, 25); place(healer, 47, 25);
    attacker.room.findExitTo = jest.fn(() => TOP);
    Game.map.describeExits = jest.fn((room: string) => room === SOURCE ? { [RIGHT]: TARGET, [TOP]: "W0N1" } : { [LEFT]: SOURCE });
    const redLegacy = powerBankAttackerRole(TARGET), greenLegacy = powerBankHealerRole(TARGET);
    greenLegacy.target(healer); redLegacy.target(attacker);
    expect(attacker.cancelOrder).toHaveBeenCalledWith("move");
    expect(pending.has(attacker)).toBe(false); expect(pending.has(healer)).toBe(true);
    commitFrame();
    expect(attacker.pos.roomName).toBe(SOURCE); expect(healer.pos.x).toBe(48);
    redLegacy.target(attacker); greenLegacy.target(healer); commitFrame();
    expect(attacker.pos.roomName).toBe(TARGET); expect(healer.pos.roomName).toBe(TARGET);
    expect(attacker.pos.isNearTo(healer.pos)).toBe(true);
  });

  it("supports the canonical diagonal exit direction without inventing a cardinal step", () => {
    place(attacker, 48, 25); place(healer, 48, 26); routeDirection = TOP_RIGHT;
    calls("attacker-first"); commitFrame();
    expect(position(attacker)).toEqual({ x: 0, y: 24, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 0, y: 25, roomName: TARGET });
  });

  it.each(["wall", "creep"] as const)("does not let red cross when green's destination contains a %s", (kind) => {
    place(attacker, 48, 25); place(healer, 48, 26);
    if (kind === "wall") walls.add(`${TARGET}:0:26`);
    else {
      const blocker = createMockPowerBankCreep("worker", { id: "blocker", name: "blocker" });
      place(blocker, 0, 26, TARGET); Game.creeps.blocker = blocker;
    }
    calls("attacker-first"); expect(pending.size).toBe(0);
    expect(attacker.cancelOrder).toHaveBeenCalledWith("move"); expect(healer.move).not.toHaveBeenCalled();
  });

  it("checks the follower's original-room exit tile as well as the migrated landing tile", () => {
    place(attacker, 48, 25); place(healer, 48, 26); walls.add(`${SOURCE}:49:26`);
    calls("attacker-first");
    expect(pending.size).toBe(0); expect(healer.move).not.toHaveBeenCalled();
    expect(attacker.cancelOrder).toHaveBeenCalledWith("move");
  });

  it("rejects an unproven corner crossing", () => {
    place(attacker, 48, 1); place(healer, 48, 2); routeDirection = TOP_RIGHT;
    calls("attacker-first"); expect(pending.size).toBe(0); expect(getMoveIntentReceipt(attacker)).toBeUndefined();
  });

  it("rejoins a legacy split at a proven border with safe inward and follower crossing steps", () => {
    place(attacker, 0, 25, TARGET); place(healer, 48, 25, SOURCE);
    calls("healer-first"); commitFrame();
    expect(position(attacker)).toEqual({ x: 1, y: 25, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 0, y: 25, roomName: TARGET });
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  it("uses a safe shared alternative while rejoining a split with a blocked inward tile", () => {
    place(attacker, 0, 25, TARGET); place(healer, 48, 25, SOURCE); walls.add(`${TARGET}:1:25`);
    calls("attacker-first");
    expect(pending.get(attacker)).toBe(TOP_RIGHT); expect(pending.get(healer)).toBe(RIGHT);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 1, y: 24, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 0, y: 25, roomName: TARGET });
  });

  it("uses shared rejoin pathing while the leader waits after ordinary separation", () => {
    place(healer, 7, 10);
    calls("attacker-first");
    expect(moveToTarget).toHaveBeenCalledWith(healer, attacker, 1, expect.objectContaining({ ignoreCreeps: false }));
    expect(attacker.move).not.toHaveBeenCalled(); expect(healer.move).toHaveBeenCalledTimes(1);
  });

  it("does not bind a replacement generation while coordinating from the other role", () => {
    healer.memory.pairGeneration = 2;
    calls("attacker-first"); expect(pending.size).toBe(0);
  });
});
