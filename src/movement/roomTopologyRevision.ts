import { getTickContextService } from "@/runtime/runtimeServices";

// 房间拓扑指纹：为跨 tick CostMatrix 缓存提供失效信号。
//
// 指纹组成（全部是矩阵内容的输入，且获取成本远低于构建矩阵）：
// - controller level / 所有权（RCL 变化会改变可建结构与 routing 的 controller 区域）；
// - 结构类型+坐标折叠（矩阵中 road=1 / 非通行 0xff 的全部来源）；
// - 自家工地类型+坐标折叠（矩阵屏蔽自家工地）；
// - RoomPlanner savedAt（getSourceContainerPositionsForRoom 的布局输入）；
// - 远程采矿任务的 containerPositions 折叠（无实际结构也会被矩阵标记 0xfe）。
//
// 折叠使用求和（顺序无关），同一 tick 内每房间只计算一次并 memo；
// 缓存条目数自然有界（本 tick 请求过指纹的可见房间数），tick 变化即整体重建。
// 指纹碰撞理论上存在，由调用方的有限 TTL 兜底。

const structureTypeCodes = new Map<string, number>();

function getStructureTypeCode(structureType: string): number {
  const existing = structureTypeCodes.get(structureType);
  if (existing !== undefined) {
    return existing;
  }
  const next = structureTypeCodes.size + 1;
  structureTypeCodes.set(structureType, next);
  return next;
}

function foldPosition(total: number, code: number, x: number, y: number): number {
  return (total + code * 1013 + x * 5179 + y * 65537) | 0;
}

interface RoomTopologyRevisionCache {
  tick: number;
  revisions: Map<string, string>;
}

let revisionCache: RoomTopologyRevisionCache = { tick: -1, revisions: new Map() };

export function getRoomTopologyRevision(roomName: string): string {
  if (revisionCache.tick !== Game.time) {
    revisionCache = { tick: Game.time, revisions: new Map() };
  }

  const cached = revisionCache.revisions.get(roomName);
  if (cached !== undefined) {
    return cached;
  }

  const room = Game.rooms[roomName];
  let structureFold = 0;
  let siteFold = 0;
  let controllerLevel = -1;
  let controllerOwned = 0;

  if (room) {
    controllerLevel = room.controller?.level ?? -1;
    controllerOwned = room.controller?.my ? 1 : 0;

    const roomContext = getTickContextService().getRoomContext(room);
    const structures = roomContext?.getStructures() ?? room.find(FIND_STRUCTURES);
    for (const structure of structures) {
      structureFold = foldPosition(structureFold, getStructureTypeCode(structure.structureType) * 2, structure.pos.x, structure.pos.y);
    }

    const sites = roomContext?.getConstructionSites() ?? room.find(FIND_CONSTRUCTION_SITES);
    for (const site of sites) {
      if (!site.my) {
        continue;
      }
      siteFold = foldPosition(siteFold, getStructureTypeCode(site.structureType) * 2 + 1, site.pos.x, site.pos.y);
    }
  }

  const savedAt = Memory.data?.roomPlanner?.[roomName]?.savedAt ?? 0;

  let remoteContainerFold = 0;
  const remoteTasks = Memory.data?.remoteMining;
  if (remoteTasks) {
    for (const task of Object.values(remoteTasks)) {
      if (task.status !== "active" || task.targetRoom !== roomName) {
        continue;
      }
      for (const pos of Object.values(task.containerPositions ?? {})) {
        if (pos.roomName !== roomName) {
          continue;
        }
        remoteContainerFold = foldPosition(remoteContainerFold, 1, pos.x, pos.y);
      }
    }
  }

  const revision = `${controllerLevel}|${controllerOwned}|${structureFold}|${siteFold}|${savedAt}|${remoteContainerFold}`;
  revisionCache.revisions.set(roomName, revision);
  return revision;
}

export function clearRoomTopologyRevisionCacheForTest(): void {
  revisionCache = { tick: -1, revisions: new Map() };
}
