import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";

/** 矩阵约束层只提高成本；明确的目标豁免由调用方提供。 */
export function applySourceContainerLayer(matrix: CostMatrix, roomName: string, allowedTarget?: { x: number; y: number; roomName: string }): void {
  for (const pos of getSourceContainerPositionsForRoom(roomName)) {
    if (allowedTarget?.roomName === roomName && allowedTarget.x === pos.x && allowedTarget.y === pos.y) continue;
    matrix.set(pos.x, pos.y, Math.max(matrix.get(pos.x, pos.y), 254));
  }
}

export function blockRoomExits(matrix: CostMatrix, allowed: readonly { x: number; y: number }[] = []): void {
  const allowedKeys = new Set(allowed.map(pos => pos.x * 50 + pos.y));
  const block = (x: number, y: number) => { if (!allowedKeys.has(x * 50 + y)) matrix.set(x, y, 255); };
  for (let index = 0; index < 50; index++) {
    block(0, index); block(49, index); block(index, 0); block(index, 49);
  }
}

export function applyControllerZoneLayer(matrix: CostMatrix, room: Room): void {
  if (!room.controller?.my) return;
  const pos = room.controller.pos;
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
    const x = pos.x + dx, y = pos.y + dy;
    if (x >= 1 && x <= 48 && y >= 1 && y <= 48) matrix.set(x, y, Math.max(matrix.get(x, y), 254));
  }
}
