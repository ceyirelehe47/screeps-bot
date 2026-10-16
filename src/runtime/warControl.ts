/** 战争公开入口；调度与策略实现位于 war/。 */
export * from "./war/api";
export { runWarControl } from "./war/index";
export type { WarSquad, WarBoostTier, StopWarOptions, StartWarOptions, StartWarPatrolOptions, StartWarResult, StopWarResult, StartWarPatrolResult, WarStatusCreepSnapshot, WarStatusTaskSnapshot, WarStatusSnapshot } from "./war/store";
