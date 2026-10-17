/** 固定生产阶段的只读降载建议；业务执行器不消费本模块的结果。 */
export type CpuPriorityTier = "T0" | "T1" | "T2" | "T3" | "T4";
const PHASE_TIERS: Readonly<Record<string, CpuPriorityTier>> = {
  treasuryBeginTick: "T0", announceDeploy: "T0", marketSalePreflight: "T0",
  coreDefense: "T0", defenseMode: "T0", homeDefense: "T0", towerControl: "T0",
  bootstrapRooms: "T1", scheduleSpawnTasks: "T1", spawnWork: "T1", creepWork: "T1",
  linkControl: "T1", flagControl: "T1", crossShardSignals: "T1", interShardControl: "T1",
  warControl: "T1", powerBankHarvest: "T1", depositHarvest: "T1", remoteMining: "T1",
  refreshWorkerTasks: "T1", treasuryEndTick: "T0",
  nukerControl: "T2", hubUpgradeControl: "T2", synthesisControl: "T2", factoryControl: "T2",
  mineralExtraction: "T2", resourceControl: "T2", marketSaleAutomation: "T2",
  powerCreepControl: "T2", powerSpawnControl: "T2", memoryCleanup: "T2",
  hubPlanner: "T3", portalDiscovery: "T3", powerBankObserver: "T3", roomPlannerConstruction: "T3",
  pixelGenerator: "T4", productionMonitor: "T4", hubProgressAnalytics: "T4",
  hubProgressOverlay: "T4", externalTelemetryExport: "T4", empireInventoryShadow: "T4", treasuryT1Shadow: "T4",
};

export interface CpuSchedulerShadow {
  mode: "shadow";
  evaluated: Record<CpuPriorityTier, number>;
  wouldDefer: Record<string, { tier: CpuPriorityTier; reason: "bucket" | "cpu"; used: number }>;
}

export function createCpuSchedulerShadow(): CpuSchedulerShadow {
  return { mode: "shadow", evaluated: { T0: 0, T1: 0, T2: 0, T3: 0, T4: 0 }, wouldDefer: {} };
}

/** 复用 profiler 已有读数；未知/嵌套阶段不会扩大标签集合。 */
export function observeCpuScheduling(shadow: CpuSchedulerShadow, phase: string, used: number, cpu: Pick<CPU, "bucket" | "limit" | "tickLimit">): void {
  const tier = Object.prototype.hasOwnProperty.call(PHASE_TIERS, phase) ? PHASE_TIERS[phase] : undefined;
  if (!tier) return;
  shadow.evaluated[tier]++;
  if (tier === "T0" || tier === "T1") return;
  const bucketFloor = tier === "T2" ? 1000 : tier === "T3" ? 5000 : 8000;
  const budgetRatio = tier === "T2" ? 0.95 : tier === "T3" ? 0.8 : 0.7;
  const budget = Math.max(0, Math.min(cpu.limit * budgetRatio, cpu.tickLimit - 20));
  const reason = cpu.bucket < bucketFloor ? "bucket" : used >= budget ? "cpu" : undefined;
  if (reason) shadow.wouldDefer[phase] = { tier, reason, used: Math.round(used * 100) / 100 };
}
