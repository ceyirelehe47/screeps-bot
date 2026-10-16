/**
 * 已签名协议的部署身份。修改这些值需要新策略/permit 与旧责任迁移，
 * 不能通过 Memory 别名重解释尚未结算的任务、历史凭证或资金授权。
 */
export const AUTHORITY_EXECUTOR_SHARD = "shard1" as const;
export const AUTHORITY_ROOMS = Object.freeze({
  hydrogenSource: "E3N59",
  reagentSource: "E4N58",
  synthesisHub: "E1N57",
  legacyXSeller: "E6N59",
  legacyXBuyer: "E21S49",
  zSeller: "E7N57",
  synthesisReason: "synthesis:E1N57:UH2O",
} as const);

/** 普通房间策略的兼容默认值，Memory.cfg.rooms 可覆盖，不初始化 Memory。 */
const DEFAULT_SPAWN_EXITS: Readonly<Record<string, Readonly<Record<string, readonly DirectionConstant[]>>>> = {
  E5N59: { Spawn20: [1] }, // 北侧；数值常量让静态身份配置不依赖 Game 初始化。
};

export function readSpawnExitDirections(roomName: string, spawnName: string): DirectionConstant[] | undefined {
  const fallback = DEFAULT_SPAWN_EXITS[roomName]?.[spawnName];
  const raw = Memory.cfg?.rooms?.[roomName]?.spawnExitDirections?.[spawnName];
  if (raw === undefined) return fallback ? [...fallback] : undefined;
  if (!Array.isArray(raw) || raw.length > 8 ||
      raw.some(value => !Number.isInteger(value) || value < 1 || value > 8) ||
      new Set(raw).size !== raw.length) return fallback ? [...fallback] : undefined;
  return raw.length ? [...raw] : undefined;
}
