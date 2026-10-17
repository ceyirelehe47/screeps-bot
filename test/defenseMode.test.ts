jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
  getCreepConfigService: jest.fn(),
  getMemoryService: jest.fn(),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(),
  getSafeZonePlanRevision: jest.fn(),
}));

import {
  clearDefenseModeCacheForTest,
  getPlayerHostiles,
  isDefenseMode,
} from "@/runtime/defenseMode";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone, getSafeZonePlanRevision } from "@/runtime/safeZone";

const ROOM_W1N1 = "W1N1";
const ROOM_W2N2 = "W2N2";
const SAFE_ZONE = new Set([25 * 50 + 25]);

function makePos(x: number, y: number, roomName: string) {
  return { x, y, roomName };
}

function makeHostile(overrides: Record<string, unknown> = {}): Creep {
  const owner = (overrides.owner ?? { username: "Enemy" }) as { username: string };
  return {
    id: `hostile_${Math.random().toString(36).slice(2, 6)}` as Id<Creep>,
    pos: makePos(25, 25, ROOM_W1N1),
    owner,
    getActiveBodyparts: jest.fn(() => 0),
    ...overrides,
  } as unknown as Creep;
}

function withActiveParts(creep: Creep, ...parts: BodyPartConstant[]): Creep {
  const activeParts = new Set(parts);
  (creep.getActiveBodyparts as jest.Mock).mockImplementation((part: BodyPartConstant) =>
    activeParts.has(part) ? 1 : 0,
  );
  return creep;
}

function makeRoomWithFind(items: Creep[] = [], roomName = ROOM_W1N1): Room {
  return {
    name: roomName,
    find: jest.fn((_type: number, opts?: { filter?: (creep: Creep) => boolean }) =>
      opts?.filter ? items.filter(opts.filter) : items,
    ),
  } as unknown as Room;
}

function useMyRooms(rooms: Room[]) {
  const tickContext = {
    getMyRooms: jest.fn(() => rooms),
    getCreepsByConfigName: jest.fn(() => []),
  };
  (getTickContextService as jest.Mock).mockReturnValue(tickContext);
  return tickContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearDefenseModeCacheForTest();
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  (getSafeZonePlanRevision as jest.Mock).mockReturnValue(null);
  useMyRooms([]);
  (getCreepConfigService as jest.Mock).mockReturnValue({
    get: jest.fn(() => undefined),
    list: jest.fn(() => ({})),
  });
  Game.time = 100;
});

describe("current-tick Defense Mode snapshot", () => {
  test("首次读取发生在显式 updater 之前时仍返回当前状态", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room = makeRoomWithFind([hostile]);
    useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
  });

  test("tick 变化时重建并反映 hostile 消失和再次出现", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostiles = [withActiveParts(makeHostile(), ATTACK)];
    const room = makeRoomWithFind(hostiles);
    const tickContext = useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    hostiles.length = 0;
    Game.time += 1;
    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    hostiles.push(withActiveParts(makeHostile(), HEAL));
    Game.time += 1;
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(3);
  });

  test("多房构建失败只将故障房置为防御，下一 tick 重试而不拖垮健康房", () => {
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room1 = makeRoomWithFind([hostile], ROOM_W1N1);
    const room2 = makeRoomWithFind([], ROOM_W2N2);
    const tickContext = useMyRooms([room1, room2]);
    let shouldFail = true;
    (getSafeZone as jest.Mock).mockImplementation((roomName: string) => {
      if (roomName === ROOM_W2N2 && shouldFail) throw new Error("safe-zone failure");
      return SAFE_ZONE;
    });

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(isDefenseMode(ROOM_W2N2)).toBe(true);
    expect(room1.find).toHaveBeenCalledTimes(1);
    shouldFail = false; Game.time++;

    expect(isDefenseMode(ROOM_W2N2)).toBe(false);
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(2);
    expect(room1.find).toHaveBeenCalledTimes(2);
    expect(room2.find).toHaveBeenCalledTimes(1);
  });
});

describe("getPlayerHostiles shared predicate", () => {
  test("复用 TickContext cache 并覆盖玩家与 NPC 危险部件边界", () => {
    const cachedHostile = withActiveParts(makeHostile(), ATTACK);
    const getHostileCreeps = jest.fn(() => [cachedHostile]);
    (getTickContextService as jest.Mock).mockReturnValue({
      getRoomContext: jest.fn(() => ({ getHostileCreeps })),
      getMyRooms: jest.fn(() => []),
      getCreepsByConfigName: jest.fn(() => []),
    });
    const cachedRoom = makeRoomWithFind([]);

    expect(getPlayerHostiles(cachedRoom)).toEqual([cachedHostile]);
    expect(getHostileCreeps).toHaveBeenCalledTimes(1);
    expect(cachedRoom.find).not.toHaveBeenCalled();

    (getTickContextService as jest.Mock).mockReturnValue({
      getRoomContext: jest.fn(() => null),
      getMyRooms: jest.fn(() => []),
      getCreepsByConfigName: jest.fn(() => []),
    });
    for (const part of [ATTACK, RANGED_ATTACK, WORK, HEAL] as BodyPartConstant[]) {
      const hostile = withActiveParts(makeHostile(), part);
      expect(getPlayerHostiles(makeRoomWithFind([hostile]))).toHaveLength(1);
    }

    const npcCases: Array<[string, BodyPartConstant[], boolean]> = [
      ["Source Keeper", [ATTACK, WORK, HEAL], false],
      ["Invader", [ATTACK], false],
      ["Invader", [RANGED_ATTACK], false],
      ["Invader", [WORK], true],
      ["Invader", [HEAL], true],
      ["Enemy", [], false],
    ];
    for (const [username, parts, expected] of npcCases) {
      const hostile = withActiveParts(makeHostile({ owner: { username } }), ...parts);
      expect(getPlayerHostiles(makeRoomWithFind([hostile]))).toHaveLength(expected ? 1 : 0);
    }
  });
});
