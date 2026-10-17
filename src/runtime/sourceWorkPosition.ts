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

