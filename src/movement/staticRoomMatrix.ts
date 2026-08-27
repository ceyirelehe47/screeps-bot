import { getTickContextService } from "@/runtime/runtimeServices";
import type { RoomTickContext } from "@/runtime/tickContext";
import { isWalkableConstructionSite, isWalkableStructure } from "@/movement/common";

/**
 * 单房移动（pathing 的 costCallback）与跨房移动（routing 的 roomCallback）
 * 共用的静态 CostMatrix 构建层。
 *
 * 引擎在 costCallback / roomCallback 返回新矩阵后不会补回默认障碍，因此
 * 自建矩阵必须完整复刻引擎默认矩阵的静态语义：
 * - terrain wall；
 * - OBSTACLE_OBJECT_TYPES 中的自然对象：Source / Mineral / Deposit / Controller；
 * - Portal：引擎默认矩阵把 Portal 一并视作障碍，避免路径意外踏上传送门；
 *   显式以 Portal 为目标（range=0）时由调用方豁免目标格（allowPortalTarget）；
 * - 不可通行 Structure（Rampart 按 my/isPublic 判定可通行）与 Road 成本 1；
 * - 自家不可通行 ConstructionSite（自家 road 工地按成本 1 预留）。
 *
 * 动态障碍（creep / PowerCreep）绝不进入本层：矩阵按拓扑指纹跨 tick 缓存，
 * 动态障碍由调用方每 tick 在 clone 上叠加。
 */

export interface StaticRoomMatrixSources {
  structures: Structure<StructureConstant>[];
  constructionSites: ConstructionSite[];
  sources: Source[];
  minerals: Mineral[];
  deposits: Deposit[];
  controller: StructureController | undefined;
}

const EMPTY_STRUCTURES: Structure<StructureConstant>[] = Object.freeze([]) as Structure<StructureConstant>[];
const EMPTY_SITES: ConstructionSite[] = Object.freeze([]) as ConstructionSite[];
const EMPTY_SOURCES: Source[] = Object.freeze([]) as Source[];
const EMPTY_MINERALS: Mineral[] = Object.freeze([]) as Mineral[];
const EMPTY_DEPOSITS: Deposit[] = Object.freeze([]) as Deposit[];

/** 不可见房间：只有 terrain 可查，自然对象与结构状态未知，留 0 走引擎默认。 */
export const TERRAIN_ONLY_ROOM_MATRIX_SOURCES: StaticRoomMatrixSources = {
  structures: EMPTY_STRUCTURES,
  constructionSites: EMPTY_SITES,
  sources: EMPTY_SOURCES,
  minerals: EMPTY_MINERALS,
  deposits: EMPTY_DEPOSITS,
  controller: undefined,
};

export function collectStaticRoomMatrixSources(room: Room, roomContext: RoomTickContext | null): StaticRoomMatrixSources {
  return {
    structures: roomContext?.getStructures() ?? room.find(FIND_STRUCTURES),
    constructionSites: roomContext?.getConstructionSites() ?? room.find(FIND_CONSTRUCTION_SITES),
    sources: roomContext?.getSources() ?? room.find(FIND_SOURCES),
    minerals: roomContext?.getMinerals() ?? room.find(FIND_MINERALS),
    deposits: room.find(FIND_DEPOSITS),
    controller: room.controller,
  };
}

export function buildStaticRoomCostMatrix(roomName: string, sources: StaticRoomMatrixSources): CostMatrix {
  const matrix = buildStaticTerrainMatrix(roomName);

  // Source / Mineral / Deposit / Controller 都是 OBSTACLE_OBJECT_TYPES；
  // mock 环境的 controller 可能没有 pos，按无障碍处理。
  const controller = sources.controller;
  if (controller?.pos) {
    matrix.set(controller.pos.x, controller.pos.y, 0xff);
  }
  for (const source of sources.sources) {
    matrix.set(source.pos.x, source.pos.y, 0xff);
  }
  for (const mineral of sources.minerals) {
    matrix.set(mineral.pos.x, mineral.pos.y, 0xff);
  }
  for (const deposit of sources.deposits) {
    matrix.set(deposit.pos.x, deposit.pos.y, 0xff);
  }

  for (const structure of sources.structures) {
    if (structure.structureType === STRUCTURE_ROAD) {
      if (matrix.get(structure.pos.x, structure.pos.y) < 0xfe) {
        matrix.set(structure.pos.x, structure.pos.y, 1);
      }
      continue;
    }

    if (structure.structureType === STRUCTURE_PORTAL) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
      continue;
    }

    if (!isWalkableStructure(structure)) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }

  for (const site of sources.constructionSites) {
    if (!site.my) {
      continue;
    }
    if (!isWalkableConstructionSite(site)) {
      matrix.set(site.pos.x, site.pos.y, 0xff);
    } else if (site.structureType === STRUCTURE_ROAD && matrix.get(site.pos.x, site.pos.y) < 0xfe) {
      matrix.set(site.pos.x, site.pos.y, 1);
    }
  }

  return matrix;
}

// 静态地形矩阵：wall 置 0xff，其余保持 0（0 表示沿用引擎的 plain/swamp
// 默认成本）。terrain 是房间不可变数据，因此该矩阵可安全跨 tick 缓存。
function buildStaticTerrainMatrix(roomName: string): CostMatrix {
  const matrix = new PathFinder.CostMatrix();
  const terrain = Game.map.getRoomTerrain(roomName);
  for (let y = 0; y < 50; y += 1) {
    for (let x = 0; x < 50; x += 1) {
      if (terrain.get(x, y) & TERRAIN_MASK_WALL) {
        matrix.set(x, y, 0xff);
      }
    }
  }
  return matrix;
}
