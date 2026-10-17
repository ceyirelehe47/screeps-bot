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
  /** 仅战斗推进要求完整可达证明；普通旅行允许沿半截路径前进后重搜。 */
  requireCompletePath?: boolean;
  /** 业务本 tick 已证明完整的房内路径；直接交给交通层，不再另做寻路。 */
  verifiedPath?: readonly StoredRoomPosition[];
  /** 业务安全策略检查实际下一步；寻路、缓存和交通仍由共用引擎执行。 */
  canMoveStep?: (destination: RoomPosition) => boolean;
  /** routing 的房内出口步仍属于此旅行；普通房内目标会结束旧旅行状态。 */
  travelTargetRoom?: string;
  swampCost?: number;
  plainCost?: number;
  reusePath?: number;
  maxRooms?: number;
  ignoreCreeps?: boolean;
  avoidExitTiles?: boolean;
  allowSourceContainerTarget?: boolean;
  /** Portal 在静态矩阵中默认阻挡；显式以 Portal 格为目标时豁免目标格（跨 shard 进入传送门）。 */
  allowPortalTarget?: boolean;
  costCallback?: (roomName: string, matrix: PathFinder["CostMatrix"]) => PathFinder["CostMatrix"];
  cacheKey?: string;
}

export interface MoveToRoomOptions extends MoveToTargetOptions {
  /** 业务按同一实际敌情给出过房成本；Infinity 禁行。须用稳定 key 隔离路线缓存。 */
  routeRoomCost?: (roomName: string) => number;
  routePolicyKey?: string;
  /** 业务已提供 Keeper 禁区矩阵及逐步安全门时，可规划穿过 Keeper 房间。 */
  allowSourceKeeperRooms?: boolean;
  /** 清剿按当前战斗威胁续路；经济角色保持控制器/结构避让。 */
  routePurpose?: "normal" | "combat";
  travelRange?: 1 | 3;
  avoidRooms?: string[];
}

export type MovementOptions = MoveToRoomOptions;

export interface TravelState {
  /** 暂时不可达的有向房间出口；改用其它入口，不将整个目标房永久禁行。 */
  rejectedTransitions?: Record<string, number>;
  exitTarget?: { key: string; x: number; y: number; expiresAt: number };
  targetRoom: string;
  lastPosKey?: string;
  lastWasExit?: boolean;
  stuckTicks: number;
  multiRoomSegment?: MultiRoomTravelSegment;
  /** colonization 共享缓存路径的 per-creep 游标（路径对象本身跨 creep 共享，不能存游标）。 */
  cachedPathCursor?: number;
  /** 上次跟随的 colonization 缓存路径 key；key 变化（版本升级或重新生成）时重置 cachedPathCursor。 */
  cachedPathKey?: string;
  /**
   * 完整跨房搜索的退避状态（防 stuck 期逐 tick 10000-op 重搜）：
   * - fullSearchBackoffUntil：下一次允许完整搜索的 tick；
   * - fullSearchBackoffLevel：连续无进展的搜索级别，驱动 1/2/4/8/16 指数间隔；
   * - fullSearchSignature：上次搜索的输入签名（route/danger/target/options 折叠），
   *   变化（如危险房集合更新）时立即清零退避允许重试。
   * creep 位置恢复移动（stuckTicks 归零）时整体清除。
   */
  fullSearchBackoffUntil?: number;
  fullSearchBackoffLevel?: number;
  fullSearchSignature?: string;
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
  computedAt?: number;
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
