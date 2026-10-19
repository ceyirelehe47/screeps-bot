export type CpuPriorityTier = "T0" | "T1" | "T2" | "T3" | "T4";
interface ProcessOptions {
  tier: CpuPriorityTier;
  every: number;
  minBucket: number;
  after?: readonly string[];
  requires?: readonly string[];
}
const process = <Id extends string>(id: Id, tier: CpuPriorityTier, options: Partial<Omit<ProcessOptions, "tier">> = {}) => ({
  id, tier, every: 1, minBucket: tier === "T2" ? 1000 : tier === "T3" ? 5000 : tier === "T4" ? 8000 : 0, ...options,
});

/** 声明式生产拓扑：防御优先；其余阶段保留既有依赖顺序。after 是顺序约束，requires 是当 tick 成功依赖。 */
export const RUNTIME_PROCESSES = [
  process("announceDeploy", "T0"),
  process("coreDefense", "T0"), process("defenseMode", "T0", { after: ["coreDefense"] }),
  process("homeDefense", "T0", { after: ["defenseMode"] }), process("towerControl", "T0", { after: ["defenseMode"] }),
  process("marketSafetyLatch", "T0", { after: ["towerControl"] }),
  process("marketSalePreflight", "T2"), process("homeDefenseSupply", "T2", { after: ["homeDefense"], requires: ["marketSalePreflight"] }),
  process("pixelGenerator", "T4"), process("productionMonitor", "T4"),
  process("nukerControl", "T2"), process("hubPlanner", "T3"), process("hubUpgradeControl", "T2"),
  process("synthesisControl", "T2", { after: ["hubPlanner"] }), process("factoryControl", "T2"), process("mineralExtraction", "T2"),
  process("resourceControl", "T2", { after: ["synthesisControl"], requires: ["marketSalePreflight"] }),
  process("marketSaleAutomation", "T2", { after: ["resourceControl"], requires: ["marketSalePreflight"] }),
  process("hubProgressAnalytics", "T4"), process("hubProgressOverlay", "T4"), process("externalTelemetryExport", "T4"),
  process("memoryCleanup", "T2"), process("portalDiscovery", "T3"), process("flagControl", "T1"),
  process("crossShardSignals", "T1"), process("interShardControl", "T1"), process("warControl", "T2"),
  process("powerBankObserver", "T3"), process("powerBankHarvest", "T2"), process("depositHarvest", "T2"),
  process("powerCreepLifecycle", "T1"), process("powerCreepControl", "T2"), process("powerSpawnControl", "T2"), process("roomPlannerConstruction", "T3"),
  process("linkControl", "T1"), process("refreshWorkerTasks", "T1"), process("bootstrapRooms", "T1"),
  process("remoteMining", "T1"), process("scheduleSpawnTasks", "T1"),
  process("spawnWork", "T1", { after: ["scheduleSpawnTasks"] }), process("creepWork", "T1", { after: ["spawnWork"] }),
  process("trafficResolution", "T1", { after: ["creepWork"] }),
  process("empireInventoryShadow", "T4"),
] as const;

export type RuntimeProcessId = typeof RUNTIME_PROCESSES[number]["id"];
export type RuntimeProcessSpec = { id: string } & ProcessOptions;
export const PROCESS_SPECS: ReadonlyMap<string, RuntimeProcessSpec> = new Map<string, RuntimeProcessSpec>([
  ...RUNTIME_PROCESSES.map(spec => [spec.id, spec] as const),
  ["treasuryBeginTick", process("treasuryBeginTick", "T0")],
  ["treasuryEndTick", process("treasuryEndTick", "T0")],
  ["treasuryT1Shadow", process("treasuryT1Shadow", "T4")],
]);
