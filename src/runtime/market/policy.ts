import { DEFAULT_TERMINAL_ENERGY_RESERVE } from "@/runtime/roomEnergyPolicy";

export const MARKET_RESOURCES = ["H", "K", "L", "O", "U", "X", "Z"] as const;
export type MarketResource = typeof MARKET_RESOURCES[number];
export const isBaseMarketResource = (resource: string): resource is MarketResource =>
  (MARKET_RESOURCES as readonly string[]).includes(resource);

export interface CompactMarketPolicy {
  hardNetFloor: number;
  economicNetFloor: number;
  reserve: number;
  minNotional: number;
  maxPerDeal: number;
  minIntervalTicks: number;
  maxPerWindow: number;
  windowTicks: number;
  maxTransactionEnergy: number;
  terminalEnergyReserve: number;
}

export interface CompactMarketConfig {
  mode?: "off" | "dryRun" | "live";
  sampleIntervalTicks?: number;
  minBucket?: number;
  maxCpu?: number;
  overrides?: Partial<Record<MarketResource, Partial<CompactMarketPolicy>>>;
  /** 显式操作者批准与本地归档绑定；存在后旧卖出入口停止接管。 */
  cutover?: {
    sourceCommit: string;
    archiveHash: string;
    authorization: string;
    lanes: Array<{ roomName: string; resource: MarketResource; terminalId: string; controllerId: string }>;
  };
}

// r8 的普通数据投影；在 dryRun 首发中不改变生产 V3 的政策或许可。
const RESOURCE_DEFAULTS: Record<MarketResource, Pick<CompactMarketPolicy,
  "hardNetFloor" | "economicNetFloor" | "reserve" | "minNotional" | "minIntervalTicks">> = {
  H: { hardNetFloor: 428, economicNetFloor: 451, reserve: 16000, minNotional: 451000, minIntervalTicks: 1000 },
  K: { hardNetFloor: 33, economicNetFloor: 34, reserve: 10000, minNotional: 34000, minIntervalTicks: 1000 },
  L: { hardNetFloor: 161, economicNetFloor: 169, reserve: 10000, minNotional: 169000, minIntervalTicks: 100 },
  O: { hardNetFloor: 71, economicNetFloor: 74, reserve: 10000, minNotional: 74000, minIntervalTicks: 1000 },
  U: { hardNetFloor: 31, economicNetFloor: 32, reserve: 10000, minNotional: 32000, minIntervalTicks: 1000 },
  X: { hardNetFloor: 371, economicNetFloor: 390, reserve: 16000, minNotional: 390000, minIntervalTicks: 100 },
  Z: { hardNetFloor: 43, economicNetFloor: 45, reserve: 10000, minNotional: 45000, minIntervalTicks: 1000 },
};

export function resolveCompactMarketPolicy(resource: MarketResource, config?: CompactMarketConfig): CompactMarketPolicy | undefined {
  const policy: CompactMarketPolicy = {
    ...RESOURCE_DEFAULTS[resource], maxPerDeal: 1000, maxPerWindow: 1_000_000_000,
    windowTicks: 30_000, maxTransactionEnergy: 1000,
    terminalEnergyReserve: DEFAULT_TERMINAL_ENERGY_RESERVE,
    ...config?.overrides?.[resource],
  };
  if (!policy || !Object.values(policy).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
  if (policy.hardNetFloor <= 0 || policy.maxPerDeal < 1 || policy.maxPerDeal > 100_000 || policy.windowTicks < 1 ||
      ![policy.reserve, policy.maxPerDeal, policy.minIntervalTicks, policy.maxPerWindow, policy.windowTicks,
        policy.maxTransactionEnergy, policy.terminalEnergyReserve].every(Number.isSafeInteger)) return undefined;
  return policy;
}
