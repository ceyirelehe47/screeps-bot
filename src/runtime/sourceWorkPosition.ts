export function getPlannedSourceContainerPos(source: Source): RoomPosition | null {
  const roomName = source.room?.name ?? source.pos.roomName;
  const remoteTask = Memory.data?.remoteMining?.[roomName];
  const remoteContainerPos =
    remoteTask?.status === "active" &&
    remoteTask.targetRoom === roomName &&
    !Game.rooms[roomName]?.controller?.my
      ? remoteTask.containerPositions?.[source.id]
      : undefined;
  if (remoteContainerPos?.roomName === roomName) {
    return new RoomPosition(remoteContainerPos.x, remoteContainerPos.y, roomName);
  }

  const layout = Memory.data?.roomPlanner?.[roomName]?.layout;
  if (!layout) return null;

  // Container explicitly in layout (autoplanner chose no link for this source).
  const containerPos = (layout[STRUCTURE_CONTAINER] ?? []).find(
    (c) => Math.abs(c.x - source.pos.x) <= 1 && Math.abs(c.y - source.pos.y) <= 1,
  );
  if (containerPos) return new RoomPosition(containerPos.x, containerPos.y, roomName);

  // Source has a planned link — the autoplanner recorded a work_pos instead.
  // A proto container is placed there until the link is built.
  const workPos = (layout["work_pos"] ?? []).find(
    (wp) => Math.abs(wp.x - source.pos.x) <= 1 && Math.abs(wp.y - source.pos.y) <= 1,
  );
  return workPos ? new RoomPosition(workPos.x, workPos.y, roomName) : null;
}


// Per-tick cache for getSourceContainerPositionsForRoom. The function is called
// repeatedly from pathing/routing while building cost matrices; the underlying
// room.find(FIND_SOURCES / FIND_MINERALS) and mineral findInRange work is
// identical within a tick. Cache resets when Game.time changes.
let sourceContainerPositionsCache: {
  tick: number;
  entries: Map<string, { x: number; y: number }[]>;
} = { tick: -1, entries: new Map() };

function computeSourceContainerPositionsForRoom(roomName: string): { x: number; y: number }[] {
  const remoteContainerPositions = getRemoteMiningContainerPositionsForRoom(roomName);
  const layout = Memory.data?.roomPlanner?.[roomName]?.layout;
  const room = Game.rooms[roomName];
  if (!layout || !room) return remoteContainerPositions;
  const sources = room.find(FIND_SOURCES);

  // Containers explicitly planned (no link at source).
  const fromContainers = (layout[STRUCTURE_CONTAINER] ?? []).filter((pos) =>
    sources.some((s) => Math.abs(pos.x - s.pos.x) <= 1 && Math.abs(pos.y - s.pos.y) <= 1),
  );

  // Work positions for sources that have a planned link (proto container lives here).
  const containerKeys = new Set(fromContainers.map((p) => `${p.x}:${p.y}`));
  const fromWorkPos = (layout["work_pos"] ?? []).filter((wp) => {
    if (containerKeys.has(`${wp.x}:${wp.y}`)) return false;
    return sources.some((s) => Math.abs(wp.x - s.pos.x) <= 1 && Math.abs(wp.y - s.pos.y) <= 1);
  });

  const minerals = room.find(FIND_MINERALS);
  const mineralPositions: { x: number; y: number }[] = [];
  for (const mineral of minerals) {
    mineralPositions.push({ x: mineral.pos.x, y: mineral.pos.y });
    const containers = mineral.pos.findInRange(FIND_STRUCTURES, 1).filter(
      (s) => s.structureType === STRUCTURE_CONTAINER,
    );
    for (const c of containers) {
      mineralPositions.push({ x: c.pos.x, y: c.pos.y });
    }
  }

  const seen = new Set<string>();
  const unique: { x: number; y: number }[] = [];
  for (const pos of [...fromContainers, ...fromWorkPos, ...mineralPositions, ...remoteContainerPositions]) {
    const key = `${pos.x}:${pos.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(pos);
    }
  }
  return unique;
}

export function getSourceContainerPositionsForRoom(roomName: string): { x: number; y: number }[] {
  if (sourceContainerPositionsCache.tick !== Game.time) {
    sourceContainerPositionsCache = { tick: Game.time, entries: new Map() };
  }

  const cached = sourceContainerPositionsCache.entries.get(roomName);
  if (cached) {
    // Defensive copy so callers iterating/pushing cannot mutate the cached array.
    return cached.slice();
  }

  const computed = computeSourceContainerPositionsForRoom(roomName);
  sourceContainerPositionsCache.entries.set(roomName, computed);
  return computed.slice();
}

function getRemoteMiningContainerPositionsForRoom(roomName: string): { x: number; y: number }[] {
  const tasks = Memory.data?.remoteMining;
  if (!tasks) return [];
  if (Game.rooms[roomName]?.controller?.my) return [];

  const seen = new Set<string>();
  const positions: { x: number; y: number }[] = [];
  for (const task of Object.values(tasks)) {
    if (task.status !== "active" || task.targetRoom !== roomName) continue;

    for (const pos of Object.values(task.containerPositions ?? {})) {
      if (pos.roomName !== roomName) continue;

      const key = `${pos.x}:${pos.y}`;
      if (seen.has(key)) continue;

      seen.add(key);
      positions.push({ x: pos.x, y: pos.y });
    }
  }

  return positions;
}

