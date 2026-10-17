import { runAutoReserveFlags } from "@/runtime/autoReserveFlag";
import { isRoomInReserveMode } from "@/runtime/roomReserve";

function createRoom(name: string, storageEnergy: number, level = 4, terminalEnergy = 0): Room {
  const storage = {
    pos: { x: 20, y: 20, roomName: name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? storageEnergy : 0,
    },
  } as unknown as StructureStorage;
  const room = {
    name,
    controller: { my: true, level } as StructureController,
    storage,
    terminal: {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? terminalEnergy : 0,
      },
    } as unknown as StructureTerminal,
    find: jest.fn(() => []),
    createFlag: jest.fn((_pos: RoomPosition, flagName?: string) => flagName || name),
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}


function setRoomPolicy(roomName: string, energyFloor: number, energyTarget: number): void {
  Memory.cfg = {
    resourceControl: {
      rooms: {
        [roomName]: { energyFloor, energyTarget },
      },
    },
  };
}

describe("runAutoReserveFlags", () => {
  beforeEach(() => {
    Game.rooms = {};
    Game.flags = {};
    Memory.cfg = {};
  });

  it("RCL4 使用小房间储备，显式房间配置仍优先", () => {
    const room = createRoom("W1N1", 15_000, 4);
    runAutoReserveFlags();
    expect(room.createFlag).not.toHaveBeenCalled();
    setRoomPolicy(room.name, 75_000, 110_000);
    runAutoReserveFlags();
    expect(room.createFlag).toHaveBeenCalled();
  });

  it("creates the auto reserve flag below the room's configured energyFloor", () => {
    const room = createRoom("W1N1", 74_999);
    setRoomPolicy(room.name, 75_000, 110_000);
    runAutoReserveFlags();
    expect(room.createFlag).toHaveBeenCalledWith(room.storage?.pos, "RESERVE_W1N1");
  });

  it("does not create the auto reserve flag at the configured energyFloor", () => {
    const room = createRoom("W1N2", 40_000);
    setRoomPolicy(room.name, 40_000, 60_000);
    runAutoReserveFlags();
    expect(room.createFlag).not.toHaveBeenCalled();
  });
});

it("真实 intent 不修改 Game.flags 时，自动创建与移除仍立即影响本 tick 出征判断", () => {
  Game.flags = {}; Game.rooms = {}; Game.time++;
  const room = createRoom("W3N3", 1);
  expect(isRoomInReserveMode(room.name)).toBe(false);
  runAutoReserveFlags();
  expect(Game.flags.RESERVE_W3N3).toBeUndefined();
  expect(isRoomInReserveMode(room.name)).toBe(true);
  Game.time++;
  Game.flags.RESERVE_W3N3 = { name: "RESERVE_W3N3", pos: room.storage!.pos, remove: jest.fn(() => OK) } as unknown as Flag;
  Object.assign(room.storage!.store, { getUsedCapacity: () => 1_000_000 });
  expect(isRoomInReserveMode(room.name)).toBe(true);
  runAutoReserveFlags();
  expect(Game.flags.RESERVE_W3N3).toBeDefined();
  expect(isRoomInReserveMode(room.name)).toBe(false);
  // 同房的人工 RESERVE 旗仍然生效，自动旗移除不能覆盖它。
  Game.flags.RESERVE = { name: "RESERVE", pos: room.storage!.pos } as Flag;
  expect(isRoomInReserveMode(room.name)).toBe(true);
});


it("关键工地存在时仍维持低能量出征闸门", () => {
  const room = createRoom("W4N4", 1);
  room.find = jest.fn(() => [{ structureType: STRUCTURE_SPAWN }]) as Room["find"];
  runAutoReserveFlags();
  expect(room.createFlag).toHaveBeenCalled();
  const flag = { name: "RESERVE_W4N4", pos: room.storage!.pos, remove: jest.fn() } as unknown as Flag;
  Game.flags.RESERVE_W4N4 = flag;
  runAutoReserveFlags();
  expect(flag.remove).not.toHaveBeenCalled();
});
