import { getTickContextService } from "@/runtime/runtimeServices";
import { recordMovementMetric } from "@/movement/metrics";

// 房间拓扑指纹：为跨 tick CostMatrix 缓存提供失效信号。
//
// 指纹组成（全部是矩阵内容的输入，且获取成本远低于构建矩阵）：
// - controller level / 所有权（RCL 变化会改变可建结构与 routing 的 controller 区域）；
// - 结构：逐对象混合 structureType+x+y+可通行状态 后求和（顺序无关，但
//   对象内部各字段先混合，两个结构交换位置时各自的 hash 都会改变）；
// - 自家工地：同样的逐对象混合（矩阵屏蔽自家工地）；
// - Deposit：逐对象混合（会中途出现/消失，静态矩阵按 0xff 屏蔽）；
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

// 影响 isWalkableStructure 判定的动态状态：Rampart 的 my/isPublic。
function getStructureWalkState(structure: Structure<StructureConstant>): number {
  if (structure.structureType === STRUCTURE_RAMPART) {
    const rampart = structure as StructureRampart;
    return (rampart.my ? 1 : 0) | (rampart.isPublic ? 2 : 0);
  }
  return 0;
}

// 逐对象 hash：type/x/y/walkState 先在对象内部混合（乘法散列 + xor），
// 再累加进折叠和。若对 type、x、y 分别求和，两个不同类型结构交换坐标时
// 折叠和不变，会漏检拓扑变化。
function foldTopologyObject(total: number, code: number, x: number, y: number, walkState: number): number {
  const objectHash =
    Math.imul(code, 0x9e3779b1) ^
    Math.imul(x + 1, 0x85ebca6b) ^
    Math.imul(y + 1, 0xc2b2ae35) ^
    Math.imul(walkState + 1, 0x27d4eb2f);
  return (total + objectHash) | 0;
}

interface RoomTopologyRevisionCache {
  tick: number;
  revisions: Map<string, string>;
}

let revisionCache: RoomTopologyRevisionCache = { tick: -1, revisions: new Map() };

// 上一 tick 各房间的指纹值：跨 tick 比较检测"指纹变化"，为
// topologyRevisionChanges 计数器提供观测（矩阵缓存因指纹变化而重建时
// 才计数，正常稳定房间为 0）。条目数自然有界（见过的房间数）。
const lastSeenRevisions = new Map<string, string>();

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
  let depositFold = 0;
  let controllerLevel = -1;
  let controllerOwned = 0;

  if (room) {
    controllerLevel = room.controller?.level ?? -1;
    controllerOwned = room.controller?.my ? 1 : 0;

    const roomContext = getTickContextService().getRoomContext(room);
    const structures = roomContext?.getStructures() ?? room.find(FIND_STRUCTURES);
    for (const structure of structures) {
      structureFold = foldTopologyObject(
        structureFold,
        getStructureTypeCode(structure.structureType) * 2,
        structure.pos.x,
        structure.pos.y,
        getStructureWalkState(structure),
      );
    }

    const sites = roomContext?.getConstructionSites() ?? room.find(FIND_CONSTRUCTION_SITES);
    for (const site of sites) {
      if (!site.my) {
        continue;
      }
      siteFold = foldTopologyObject(
        siteFold,
        getStructureTypeCode(site.structureType) * 2 + 1,
        site.pos.x,
        site.pos.y,
        0,
      );
    }

    // Deposit 会中途出现/消失（采空后冷却重生），静态矩阵按 0xff 屏蔽，
    // 指纹必须覆盖其存在与位置。Source/Mineral/Controller 位置在房间生成
    // 后恒定，首次可见构建后不会变化，无需进入指纹。Portal 是 Structure，
    // 已随结构折叠覆盖出现/消失。
    for (const deposit of room.find(FIND_DEPOSITS)) {
      depositFold = foldTopologyObject(
        depositFold,
        getStructureTypeCode("deposit") * 2 + 1,
        deposit.pos.x,
        deposit.pos.y,
        0,
      );
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
        remoteContainerFold = foldTopologyObject(remoteContainerFold, 1, pos.x, pos.y, 0);
      }
    }
  }

  const revision = `${controllerLevel}|${controllerOwned}|${structureFold}|${siteFold}|${depositFold}|${savedAt}|${remoteContainerFold}`;
  const previousRevision = lastSeenRevisions.get(roomName);
  if (previousRevision !== undefined && previousRevision !== revision) {
    recordMovementMetric("topologyRevisionChanges", roomName);
  }
  lastSeenRevisions.set(roomName, revision);
  revisionCache.revisions.set(roomName, revision);
  return revision;
}

export function clearRoomTopologyRevisionCacheForTest(): void {
  revisionCache = { tick: -1, revisions: new Map() };
  lastSeenRevisions.clear();
}
