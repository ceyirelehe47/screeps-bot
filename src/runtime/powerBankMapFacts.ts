// 只共享当前原生帧的地图事实；所有权、危险集合和最终准入仍由调用方检查。
// 目录查询与多来源/Spawn 测距共用，避免同房反复执行原生状态查询。
const MAP_FACTS_LIMIT = 1024;
type RoomStatusFact = ReturnType<GameMap["getRoomStatus"]>;
type RoomExitsFact = ReturnType<GameMap["describeExits"]>;

interface MapFactsFrame {
  game: Game;
  tick: number;
  map: GameMap;
  statusReader: GameMap["getRoomStatus"];
  exitReader: GameMap["describeExits"];
  statuses: Map<string, RoomStatusFact>;
  exits: Map<string, RoomExitsFact>;
}

let frame: MapFactsFrame | undefined;

function currentFrame(): MapFactsFrame {
  if (!frame || frame.game !== Game || frame.tick !== Game.time || frame.map !== Game.map ||
      frame.statusReader !== Game.map.getRoomStatus || frame.exitReader !== Game.map.describeExits) {
    frame = {
      game: Game, tick: Game.time, map: Game.map,
      statusReader: Game.map.getRoomStatus, exitReader: Game.map.describeExits,
      statuses: new Map(), exits: new Map(),
    };
  }
  return frame;
}

function remember<T>(facts: Map<string, T>, roomName: string, value: T): T {
  if (facts.size >= MAP_FACTS_LIMIT) facts.delete(facts.keys().next().value!);
  facts.set(roomName, value);
  return value;
}

export function getPowerBankRoomStatus(roomName: string): RoomStatusFact {
  const current = currentFrame();
  if (current.statuses.has(roomName)) return current.statuses.get(roomName)!;
  // 异常原样交给各调用方的既有 fail-closed 分支，不记录成安全事实。
  const observed: RoomStatusFact = current.statusReader.call(current.map, roomName);
  const value = observed && typeof observed === "object" ? Object.freeze({ ...observed }) : observed;
  return remember(current.statuses, roomName, value);
}

export function getPowerBankRoomExits(roomName: string): RoomExitsFact {
  const current = currentFrame();
  if (current.exits.has(roomName)) return current.exits.get(roomName)!;
  const observed: RoomExitsFact = current.exitReader.call(current.map, roomName);
  const value = observed && typeof observed === "object" ? Object.freeze({ ...observed }) : observed;
  return remember(current.exits, roomName, value);
}
