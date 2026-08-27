export interface StoredPathStep {
  x: number;
  y: number;
}

export interface StoredRoomPosition {
  x: number;
  y: number;
  roomName: string;
}

export interface CachedTravelPath {
  key: string;
  sourceRoom: string;
  targetRoom: string;
  routeRooms: string[];
  positions: StoredRoomPosition[];
  generatedAt: number;
}

export interface MultiRoomTravelSegment {
  key: string;
  currentRoom: string;
  positions: StoredRoomPosition[];
  transitionIndex: number;
  cursor: number;
  reuseTtl: number;
  generatedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
}

export interface MoveToTargetOptions {
  swampCost?: number;
  plainCost?: number;
  reusePath?: number;
  maxRooms?: number;
  ignoreCreeps?: boolean;
  avoidExitTiles?: boolean;
  allowSourceContainerTarget?: boolean;
  costCallback?: (roomName: string, matrix: PathFinder["CostMatrix"]) => PathFinder["CostMatrix"];
  cacheKey?: string;
}

export interface MoveToRoomOptions extends MoveToTargetOptions {
  travelRange?: 1 | 3;
  avoidRooms?: string[];
}

export type MovementOptions = MoveToRoomOptions;

export interface TravelState {
  targetRoom: string;
  lastPosKey?: string;
  lastWasExit?: boolean;
  stuckTicks: number;
  multiRoomSegment?: MultiRoomTravelSegment;
  /** colonization 共享缓存路径的 per-creep 游标（路径对象本身跨 creep 共享，不能存游标）。 */
  cachedPathCursor?: number;
}

export interface MovePathState {
  key: string;
  steps: StoredPathStep[];
  /** 上次精确命中的 step 下标；正常前进只扫描 cursor 附近，偏离后回退全量恢复。 */
  cursor: number;
  targetRoom: string;
  targetX: number;
  targetY: number;
  range: 0 | 1 | 2 | 3;
  lastPosKey?: string;
  stuckTicks: number;
  expiresAt: number;
}

export interface DynamicRouteCacheEntry {
  nextRoom: string | null;
  expiresAt: number;
}

export interface RoomCostMatrixCacheEntry {
  /** 建立缓存时的房间拓扑指纹；变化即失效重建。 */
  revision: string;
  builtAt: number;
  matrix: CostMatrix;
}

export interface WorkAnchor {
  x: number;
  y: number;
  roomName: string;
  range: number;
}
