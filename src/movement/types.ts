import type { MoveProfile, MoveProfileName } from "@/movement/moveProfile";
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


export interface SafeZoneConstraint { roomName: string; revision: number | null; zone: ReadonlySet<number> }
export interface MoveToTargetOptions extends Partial<MoveProfile> {
  profile?: MoveProfileName;
  /** 由 resolveMovementPolicy 生成的内部安全区层，必须在业务 callback 之后应用。 */
  safeZone?: SafeZoneConstraint;
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
  /** 矩阵策略内容的稳定版本；内容变化必须换 key。动态逐步许可用 canMoveStep。 */
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
  avoidRooms?: string[];
}

export type MovementOptions = MoveToRoomOptions;

export interface TravelState {
  lastFailure?: { at: number; reason: "staticBlocked" | "policyDenied" | "budgetExhausted" | "dynamicBlocked" | "invalidPath" };
  /** 暂时不可达的有向房间出口；改用其它入口，不将整个目标房永久禁行。 */
  rejectedTransitions?: Record<string, number>;
  exitTarget?: { key: string; x: number; y: number; expiresAt: number };
  targetRoom: string;
  lastPosKey?: string;
  lastWasExit?: boolean;
  /** 位置停滞按帧观察；同 tick 的策略重试不能增加停滞次数。 */
  observedAt?: number;
  stuckTicks: number;

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
  observedAt?: number;
  stuckTicks: number;
  expiresAt: number;
}

export interface DynamicRouteCacheEntry {
  computedAt?: number;
  nextRoom: string | null;
  expiresAt: number;
}


export interface WorkAnchor {
  x: number;
  y: number;
  roomName: string;
  range: number;
}
