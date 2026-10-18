import { setupPathFinderGlobal } from "@mock/movement";
jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(), moveToTarget: jest.fn(), moveToTargetRoom: jest.fn(),
}));
jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn(), getNextTravelRoom: jest.fn() }));
jest.mock("@/runtime/runtimeServices", () => ({ getTickContextService: jest.fn() }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: (fn: () => unknown) => fn(),
  measureCreepPathing: (fn: () => unknown) => fn(),
  measureSampledCpuPhase: (_label: string, fn: () => unknown) => fn(),
}));
jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));

import { coordinatePowerBankPairMovement, resolvePowerBankPair } from "@/roles/powerBankCombatPair";
import { powerBankAttackerRole } from "@/roles/powerBankAttacker";
import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { clearCreepMovementStateForTest, clearCreepMovementState, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { getMoveIntentReceipt, issueMove, isBlockerActivelyMoving, moveToAdjacentPosition } from "@/movement/traffic";
import { getCachedStaticTravelMatrix, getNextTravelRoom } from "@/movement/routing";
import { getTickContextService } from "@/runtime/runtimeServices";
import { createMockPowerBankCreep, createMockPowerBank } from "@mock/powerBank";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { moveToTarget as moveActualTarget } from "@/movement/pathing";

class PairPos {
  constructor(public x: number, public y: number, public roomName: string) {}
  getRangeTo(target: RoomPosition | { pos: RoomPosition } | number, y?: number): number {
    if (typeof target === "number") return Math.max(Math.abs(this.x - target), Math.abs(this.y - y!));
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
  // 原生 creeps/move 先整步拒绝越界，creeps/tick 再从最终原房坐标处理出口；
  // 独立计算，不调用被测 receipt 几何。
  const offsets: Record<DirectionConstant, readonly [number, number]> = {
    [TOP]: [0, -1], [TOP_RIGHT]: [1, -1], [RIGHT]: [1, 0], [BOTTOM_RIGHT]: [1, 1],
    [BOTTOM]: [0, 1], [BOTTOM_LEFT]: [-1, 1], [LEFT]: [-1, 0], [TOP_LEFT]: [-1, -1],
  };
  const destinations = Object.values(Game.creeps).map((creep) => {
    const delta = pending.has(creep) ? offsets[pending.get(creep)!] : [0, 0];
    const proposedX = creep.pos.x + delta[0], proposedY = creep.pos.y + delta[1];
    const rejected = proposedX < 0 || proposedX > 49 || proposedY < 0 || proposedY > 49;
    let x = rejected ? creep.pos.x : proposedX;
    let y = rejected ? creep.pos.y : proposedY;
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
  (getNextTravelRoom as jest.Mock).mockImplementation((from: string, to: string, encoded?: string) => encoded?.split("|")[1] ?? Game.map.describeExits(from)?.[routeDirection] ?? to);
  (getCachedStaticTravelMatrix as jest.Mock).mockImplementation((room: string) => ({
    get: (x: number, y: number) => walls.has(`${room}:${x}:${y}`) ? 255 : 0,
  }));
  attacker = createMockPowerBankCreep("powerBankAttacker", { id: "red", name: "red", memory: { taskId: TASK, pairGeneration: 1 } as Partial<PowerBankAttackerMemory> });
  healer = createMockPowerBankCreep("powerBankHealer", { id: "green", name: "green", memory: { taskId: TASK, pairGeneration: 1 } as Partial<PowerBankHealerMemory> });
  place(attacker, 10, 10); place(healer, 9, 10);
  Game.rooms[TARGET] = { name: TARGET, lookForAt: jest.fn(() => []) } as unknown as Room;
  for (const creep of [attacker, healer]) {
    (creep.move as jest.Mock).mockImplementation((direction: DirectionConstant) => { pending.set(creep, direction); return OK; });
    Object.assign(creep, { cancelOrder: jest.fn((method: string) => {
      if (method !== "move" || !pending.has(creep)) return ERR_NOT_FOUND;
      pending.delete(creep); return OK;
    }) });
  }
  Game.creeps = { red: attacker, green: healer };
  (getTickContextService as jest.Mock).mockReturnValue({ getAllCreeps: () => Object.values(Game.creeps), getMyRooms: () => [], getRoomContext: (owner: Room | string) => {
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
  it.each(["attacker-first", "healer-first"] as const)("历史清理已删 taskId/configName 的双人组进入母房回收：%s", order => {
    for (const actor of [attacker, healer]) { delete (actor.memory as any).taskId; delete actor.memory.configName; }
    Memory.data!.powerBankHarvest = {};
    calls(order);
    expect(attacker.memory._recycleToRoom).toBe(SOURCE);
    expect(healer.memory._recycleToRoom).toBe(SOURCE);
    expect(attacker.suicide).not.toHaveBeenCalled(); expect(healer.suicide).not.toHaveBeenCalled();
  });
  it.each(["attacker-first", "healer-first"] as const)("部分 PathFinder 路径仍为出房双人组提交移动意图：%s", order => {
    setupPathFinderGlobal();
    const find = jest.mocked(PathFinder.search).mockReturnValue({
      path: [new RoomPosition(11, 10, SOURCE)], ops: 1, cost: 1, incomplete: true,
    });
    (moveToTargetRoom as jest.Mock).mockImplementation((creep: Creep) =>
      moveActualTarget(creep, new RoomPosition(49, 10, SOURCE), 0));
    calls(order);
    expect(find).toHaveBeenCalledTimes(1);
    expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
    expect(getMoveIntentReceipt(attacker)?.to).toMatchObject({ x: 11, y: 10, roomName: SOURCE });
    expect(getMoveIntentReceipt(healer)?.to).toMatchObject({ x: 10, y: 10, roomName: SOURCE });
  });

  it("领队房内无路只换占位策略重试一次，成功后跟随同步提交", () => {
    (moveToTargetRoom as jest.Mock).mockReturnValueOnce(ERR_NO_PATH).mockImplementation((creep: Creep) => issueMove(creep, RIGHT));
    calls("attacker-first");
    expect(moveToTargetRoom).toHaveBeenCalledTimes(2);
    expect(moveToTargetRoom).toHaveBeenLastCalledWith(attacker, TARGET, expect.any(String), expect.objectContaining({ ignoreCreeps: false, reusePath: 0 }));
    expect(pending.has(attacker)).toBe(true); expect(pending.has(healer)).toBe(true);
  });

  it("静态出口断路不清除排除记录，也不重复搜索同一出口", () => {
    const edge = `${SOURCE}->${TARGET}`;
    (moveToTargetRoom as jest.Mock).mockImplementation((creep: Creep) => {
      ensureCreepMovementState(creep).travelState = {
        targetRoom: TARGET, stuckTicks: 0, rejectedTransitions: { [edge]: Game.time + 20 },
      };
      return ERR_NO_PATH;
    });
    calls("attacker-first");
    expect(moveToTargetRoom).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(attacker)!.travelState!.rejectedTransitions?.[edge]).toBe(Game.time + 20);
    expect(pending.size).toBe(0);
  });

  it("跟随连续两帧无路后领队回靠，第三帧重新聚拢", () => {
    place(attacker, 12, 10); place(healer, 9, 10);
    (moveToTarget as jest.Mock).mockReturnValue(ERR_NO_PATH);
    calls("attacker-first");
    expect(pending.size).toBe(0);
    commitFrame(); calls("healer-first");
    expect(pending.has(attacker)).toBe(true); expect(pending.has(healer)).toBe(false);
    commitFrame();
    expect(attacker.pos.getRangeTo(healer)).toBe(2);
    (moveToTarget as jest.Mock).mockImplementation((creep: Creep) => issueMove(creep, creep.pos.getDirectionTo(attacker.pos)));
    calls("attacker-first"); commitFrame();
    expect(attacker.pos.isNearTo(healer)).toBe(true);
  });
  it("越界斜步不保留任一位移分量，receipt 与原生原边界迁房坐标一致", () => {
    place(attacker, 0, 25, TARGET); place(healer, 0, 26, TARGET);
    expect(issueMove(attacker, TOP_LEFT)).toBe(OK);
    const receipt = getMoveIntentReceipt(attacker)!;
    expect(receipt.attempted).toEqual({ x: 0, y: 25, roomName: TARGET });
    expect(receipt.to).toEqual({ x: 49, y: 25, roomName: SOURCE });
    commitFrame();
    expect(position(attacker)).toEqual(receipt.to);
    expect(position(healer)).toEqual({ x: 49, y: 26, roomName: SOURCE });
  });
  it("同tick斜向出口候选共享格查询，source/target重复调用保持相同一组移动", () => {
    place(attacker, 48, 17); place(healer, 48, 18);
    walls.add(`${SOURCE}:49:19`); walls.add(`${TARGET}:0:19`); routeDirection = BOTTOM_RIGHT;
    const reads = new Map<string, number>();
    for (const name of [SOURCE, TARGET]) (Game.rooms[name].lookForAt as jest.Mock).mockImplementation((kind, x, y) => {
      const key = `${name}:${kind}:${x}:${y}`; reads.set(key, (reads.get(key) ?? 0) + 1); return [];
    });
    const pair = resolvePowerBankPair(attacker, Memory.data!.powerBankHarvest![TASK])!;
    coordinatePowerBankPairMovement(pair);
    const redCalls = (attacker.move as jest.Mock).mock.calls.length, greenCalls = (healer.move as jest.Mock).mock.calls.length;
    coordinatePowerBankPairMovement(pair);
    expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
    console.log(JSON.stringify({ kind: "pairQueryBudget", reads: [...reads.entries()].sort(), staticQueries: (getCachedStaticTravelMatrix as jest.Mock).mock.calls.length,
      output: [...pending].map(([c, d]) => [c.name, d]) }));
    expect(Math.max(...reads.values())).toBe(1);
    expect(attacker.move).toHaveBeenCalledTimes(redCalls); expect(healer.move).toHaveBeenCalledTimes(greenCalls);
  });

  it("同输入400creep出口查询性能样本，逐帧输出不变", () => {
    place(attacker, 48, 17); place(healer, 48, 18); routeDirection = BOTTOM_RIGHT;
    walls.add(`${SOURCE}:49:19`); walls.add(`${TARGET}:0:19`);
    for (let i = 0; i < 400; i++) {
      const extra = createMockPowerBankCreep("carrier", { id: `extra${i}`, name: `extra${i}` });
      place(extra, 5 + i % 40, 5 + Math.floor(i / 40)); Game.creeps[extra.name] = extra;
    }
    const pair = resolvePowerBankPair(attacker, Memory.data!.powerBankHarvest![TASK])!;
    const original = Object.values; let creepQueries = 0; let looks = 0; let matrixConstructions = 0;
    (getCachedStaticTravelMatrix as jest.Mock).mockImplementation((name: string) => { matrixConstructions++; return { get: (x: number, y: number) => walls.has(`${name}:${x}:${y}`) ? 255 : 0 }; });
    const values = jest.spyOn(Object, "values").mockImplementation((object: object) => {
      if (object === Game.creeps) creepQueries++; return original(object);
    });
    for (const name of [SOURCE, TARGET]) (Game.rooms[name].lookForAt as jest.Mock).mockImplementation(() => { looks++; return []; });
    const before = performance.now();
    try {
      for (let tick = 0; tick < 250; tick++) {
        Game.time++; pending.clear(); coordinatePowerBankPairMovement(pair); coordinatePowerBankPairMovement(pair);
        expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
      }
    } finally { values.mockRestore(); }
    console.log(JSON.stringify({ kind: "pairQueryPerformance", frames: 250, creeps: 402, creepQueries, looks,
      staticQueries: (getCachedStaticTravelMatrix as jest.Mock).mock.calls.length, matrixConstructions, elapsedMs: performance.now() - before,
      output: [pending.get(attacker), pending.get(healer)] }));
  });

  it("缓存的占位仍重读当帧让路意图，不缓存blocker是否已移动", () => {
    place(attacker, 48, 17); place(healer, 48, 18);
    const blocker = createMockPowerBankCreep("carrier", { id: "worker", name: "worker" });
    place(blocker, 0, 18, TARGET); Game.creeps.worker = blocker;
    (blocker.move as jest.Mock).mockImplementation((direction) => { pending.set(blocker, direction); return OK; });
    (getCachedStaticTravelMatrix as jest.Mock).mockImplementation((name) => ({ get: (x: number, y: number) =>
      (name === SOURCE && (x === 48 || x === 49) || name === TARGET && (x === 0 || x === 1)) && (y === 17 || y === 18) ? 0 : 255 }));
    const first = resolvePowerBankPair(attacker, Memory.data!.powerBankHarvest![TASK])!; coordinatePowerBankPairMovement(first);
    expect(pending.has(attacker)).toBe(false);
    expect(issueMove(blocker, RIGHT)).toBe(OK);
    coordinatePowerBankPairMovement({ ...first, task: { ...first.task } });
    expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
  });

  it.each(["service", "world", "tick"] as const)("%s变化使已缓存的封闭格失效", (change) => {
    place(attacker, 48, 17); place(healer, 48, 18);
    let open = false;
    (getCachedStaticTravelMatrix as jest.Mock).mockImplementation((name) => ({ get: (x: number, y: number) =>
      name === SOURCE && x === 48 && (y === 17 || y === 18) || open ? 0 : 255 }));
    const pair = resolvePowerBankPair(attacker, Memory.data!.powerBankHarvest![TASK])!; coordinatePowerBankPairMovement(pair);
    expect(pending.has(attacker)).toBe(false);
    open = true;
    if (change === "service") (getTickContextService as jest.Mock).mockReturnValue({ ...getTickContextService() });
    if (change === "world") Object.assign(global, { Game: { ...Game } });
    if (change === "tick") Game.time++;
    coordinatePowerBankPairMovement({ ...pair, task: { ...pair.task } });
    expect(pending.get(attacker)).toBe(RIGHT); expect(pending.get(healer)).toBe(RIGHT);
  });

  it.each(["attacker-first", "healer-first"] as const)("已对齐出口直穿：单体斜向末步会送绿进下一墙格时仍前进，%s", (order) => {
    place(attacker, 48, 17); place(healer, 48, 18);
    walls.add(`${SOURCE}:49:19`); walls.add(`${TARGET}:0:19`);
    routeDirection = BOTTOM_RIGHT;
    calls(order);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 0, y: 17, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 0, y: 18, roomName: TARGET });
    expect(attacker.move).toHaveBeenCalledWith(RIGHT);
    expect(healer.move).toHaveBeenCalledWith(RIGHT);
  });

  it.each(["attacker-first", "healer-first"] as const)("线形道路让路后领队继续前进，尾随短暂分离再用共同交通补位：%s", (order) => {
    const blocker = createMockPowerBankCreep("worker", { name: "worker", id: "worker" });
    place(blocker, 11, 10); Game.creeps.worker = blocker;
    (blocker.move as jest.Mock).mockImplementation((direction: DirectionConstant) => { pending.set(blocker, direction); return OK; });
    Game.map.getRoomTerrain = jest.fn(() => ({ get: (_x: number, y: number) => y === 10 ? 0 : TERRAIN_MASK_WALL })) as typeof Game.map.getRoomTerrain;
    (moveToTargetRoom as jest.Mock).mockImplementation((creep: Creep) =>
      moveToAdjacentPosition(creep, new PairPos(creep.pos.x + 1, 10, SOURCE) as RoomPosition));
    (moveToTarget as jest.Mock).mockImplementation((creep: Creep, target: Creep, range: number) =>
      creep.pos.getRangeTo(target) <= range ? OK : moveToAdjacentPosition(creep, new PairPos(creep.pos.x + 1, 10, SOURCE) as RoomPosition));
    calls(order);
    expect(attacker.cancelOrder).not.toHaveBeenCalled();
    expect(pending.get(attacker)).toBe(RIGHT);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 11, y: 10, roomName: SOURCE });
    expect(position(healer)).toEqual({ x: 9, y: 10, roomName: SOURCE });
    expect(position(blocker)).toEqual({ x: 10, y: 10, roomName: SOURCE });
    calls(order); commitFrame();
    expect(position(attacker)).toEqual({ x: 11, y: 10, roomName: SOURCE });
    expect(position(healer)).toEqual({ x: 10, y: 10, roomName: SOURCE });
    calls(order); commitFrame();
    expect(position(attacker)).toEqual({ x: 12, y: 10, roomName: SOURCE });
    expect(position(healer)).toEqual({ x: 11, y: 10, roomName: SOURCE });
    const occupied = Object.values(Game.creeps).map(c => `${c.pos.roomName}:${c.pos.x}:${c.pos.y}`);
    expect(new Set(occupied).size).toBe(occupied.length);
  });

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
    place(attacker, 48, 25); place(healer, 48, 26);
    (healer.move as jest.Mock).mockReturnValue(code);
    calls("attacker-first"); calls("healer-first");
    expect(attacker.cancelOrder).toHaveBeenCalledTimes(1); expect(attacker.cancelOrder).toHaveBeenCalledWith("move");
    expect(getMoveIntentReceipt(attacker)).toBeUndefined(); expect(pending.size).toBe(0);
    expect(getCreepMovementState(attacker)?.travelState?.targetRoom).toBe(TARGET);
    expect(getCreepMovementState(healer)?.travelState?.targetRoom).toBe(TARGET);
    commitFrame();
    expect(position(attacker)).toEqual({ x: 48, y: 25, roomName: SOURCE });
    expect(position(healer)).toEqual({ x: 48, y: 26, roomName: SOURCE });
  });

  it("does not fake a canceled move when native cancellation fails", () => {
    place(attacker, 48, 25); place(healer, 48, 26);
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
    Game.rooms[to] = { name: to, lookForAt: jest.fn(() => []) } as unknown as Room;
    Game.map.describeExits = jest.fn((room: string) => room === from ? { [direction]: to } : { [((direction + 3) % 8) + 1]: from }) as typeof Game.map.describeExits;
    place(attacker, red[0], red[1], from); place(healer, green[0], green[1], from);
    routeDirection = direction as DirectionConstant;
    calls("healer-first");
    expect(pending.get(attacker)).toBe(direction); expect(pending.get(healer)).toBe(direction);
    commitFrame();
    expect(position(attacker)).toEqual({ x: finalRed[0], y: finalRed[1], roomName: to });
    expect(position(healer)).toEqual({ x: finalGreen[0], y: finalGreen[1], roomName: to });
  });

  it("保存路线上的目标已被其他玩家占领时，两人的跨房意图都不发布", () => {
    place(attacker, 48, 25); place(healer, 48, 26);
    Game.rooms[TARGET].controller = { my: false, owner: { username: "enemy" } } as StructureController;
    calls("healer-first");
    expect(pending.size).toBe(0);
    commitFrame();
    expect(attacker.room.name).toBe(SOURCE);
    expect(healer.room.name).toBe(SOURCE);
  });

  it("下一房失去视野时，两人等待观察而不跨入未知房", () => {
    place(attacker, 48, 25); place(healer, 48, 26);
    delete Game.rooms[TARGET];
    calls("attacker-first");
    expect(pending.size).toBe(0);
  });

  it("红误入敌方出口时不把绿拉进去，红回到原房后再集合", () => {
    place(attacker, 0, 25, TARGET); place(healer, 48, 25, SOURCE);
    Game.rooms[TARGET].controller = { my: false, owner: { username: "enemy" } } as StructureController;
    calls("healer-first");
    expect(pending.has(healer)).toBe(false);
    commitFrame();
    expect(attacker.room.name).toBe(SOURCE);
    expect(healer.room.name).toBe(SOURCE);
    expect(attacker.pos.isNearTo(healer.pos)).toBe(true);
  });

  it.each(["attacker-first", "healer-first"] as const)("出口前两格都是墙时沿边重新排位，两人同步跨过合法出口：%s", (order) => {
    const north = "W0N1";
    const task = Memory.data!.powerBankHarvest![TASK];
    task.targetRoom = north;
    task.routeRooms = [SOURCE, north];
    Game.rooms[north] = { name: north, lookForAt: jest.fn(() => []) } as unknown as Room;
    Game.map.describeExits = jest.fn((room: string) => room === SOURCE ? { [TOP]: north } : { [BOTTOM]: SOURCE });
    place(attacker, 32, 1); place(healer, 31, 1);
    for (let x = 1; x <= 32; x++) {
      walls.add(`${SOURCE}:${x}:0`);
      walls.add(`${north}:${x}:49`);
    }
    routeDirection = TOP;
    for (let frame = 0; frame < 4 && attacker.room.name === SOURCE; frame++) {
      calls(order);
      commitFrame();
      expect(attacker.room.name).toBe(healer.room.name);
      expect(attacker.pos.isNearTo(healer.pos)).toBe(true);
    }
    expect(attacker.room.name).toBe(north);
    expect(healer.room.name).toBe(north);
    expect(attacker.pos.x).toBeGreaterThanOrEqual(33);
    expect(healer.pos.x).toBeGreaterThanOrEqual(33);
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

  it("stages from the shared route exit when the room's legacy findExitTo disagrees", () => {
    delete Memory.data!.powerBankHarvest![TASK].routeRooms;
    place(attacker, 48, 25); place(healer, 47, 25);
    attacker.room.findExitTo = jest.fn(() => TOP);
    Game.map.describeExits = jest.fn((room: string) => room === SOURCE ? { [RIGHT]: TARGET, [TOP]: "W0N1" } : { [LEFT]: SOURCE });
    const redLegacy = powerBankAttackerRole(TARGET), greenLegacy = powerBankHealerRole(TARGET);
    greenLegacy.target(healer); redLegacy.target(attacker);
    expect(attacker.move).not.toHaveBeenCalled();
    expect(attacker.cancelOrder).not.toHaveBeenCalled();
    expect(pending.has(attacker)).toBe(false); expect(pending.has(healer)).toBe(true);
    expect(pending.get(healer)).not.toBe(TOP);
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
    calls("attacker-first");
    expect(pending.get(attacker)).not.toBe(RIGHT);
    expect(pending.get(healer)).not.toBe(RIGHT);
    commitFrame();
    expect(attacker.room.name).toBe(SOURCE); expect(healer.room.name).toBe(SOURCE);
    expect(attacker.pos.isNearTo(healer.pos)).toBe(true);
    calls("healer-first"); commitFrame();
    expect(attacker.room.name).toBe(TARGET); expect(healer.room.name).toBe(TARGET);
    expect(healer.pos.y).not.toBe(26);
  });

  it("checks the follower's original-room exit tile as well as the migrated landing tile", () => {
    place(attacker, 48, 25); place(healer, 48, 26); walls.add(`${SOURCE}:49:26`);
    calls("attacker-first");
    expect(pending.get(attacker)).not.toBe(RIGHT); expect(pending.get(healer)).not.toBe(RIGHT);
    commitFrame();
    expect(attacker.room.name).toBe(SOURCE); expect(healer.room.name).toBe(SOURCE);
    calls("healer-first"); commitFrame();
    expect(attacker.room.name).toBe(TARGET); expect(healer.room.name).toBe(TARGET);
    expect(healer.pos.y).not.toBe(26);
  });

  it("拒绝含糊角落意图后动态选择已证明的其它双格方向", () => {
    place(attacker, 48, 1); place(healer, 48, 2); routeDirection = TOP_RIGHT;
    calls("attacker-first");
    expect(getMoveIntentReceipt(attacker)?.direction).toBe(RIGHT);
    expect(attacker.cancelOrder).toHaveBeenCalledWith("move");
    commitFrame();
    expect(position(attacker)).toEqual({ x: 0, y: 1, roomName: TARGET });
    expect(position(healer)).toEqual({ x: 0, y: 2, roomName: TARGET });
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
    (healer.memory as PowerBankHealerMemory).pairGeneration = 2;
    calls("attacker-first"); expect(pending.size).toBe(0);
  });
});
