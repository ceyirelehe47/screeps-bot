import { errorMapper } from "@/modules/errorMapper";
import { mountAll } from "@/mount";
import { announceDeploy } from "@/runtime/deployAnnounce";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { runInterShardControl } from "@/runtime/interShardControl";
import { runCrossShardSignals } from "@/runtime/crossShardSignals";
import { runPixelGenerator } from "@/runtime/pixelGenerator";
import { runPortalDiscovery } from "@/runtime/portalDiscovery";
import { registerProductionApi, runProductionMonitor } from "@/runtime/productionMonitor";
import { runResourceControl } from "@/runtime/resourceControl";
import { runSynthesisControl } from "@/runtime/synthesisControl";
import { runFactoryControl } from "@/runtime/factoryControl";
import { runHubPlanner } from "@/runtime/hubPlanner";
import { runHubUpgradeControl } from "@/runtime/hubUpgradeControl";
import { runMineralExtraction } from "@/runtime/mineralExtraction";
import { runExternalTelemetryExport } from "@/runtime/externalTelemetry";
import { bootstrapRooms } from "@/runtime/bootstrap";
import { runCoreDefense } from "@/runtime/coreDefense";
import { runHomeDefense } from "@/runtime/homeDefense";
import { runDefenseMode } from "@/runtime/defenseMode";
import { runFlagControl } from "@/runtime/flagControl";
import { runLinkControl } from "@/runtime/linkControl";
import { runRoomPlannerConstruction } from "@/runtime/roomPlannerConstruction";
import { registerGlobalApi } from "@/runtime/creepApi";
import { registerConsoleCommands } from "@/runtime/consoleCommands";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { runTowerControl } from "@/runtime/towerControl";
import { runWarControl } from "@/runtime/warControl";
import { runPowerBankObserver } from "@/runtime/powerBankObserver";
import { runPowerBankHarvest } from "@/runtime/powerBankHarvest";
import { runPowerCreepControl } from "@/runtime/powerCreepControl";
import { runPowerSpawnControl } from "@/runtime/powerSpawnControl";
import { runNukerControl } from "@/runtime/nukerControl";
import { refreshWorkerTasks } from "@/runtime/workerTaskPool";
import { createTickCpuProfiler, setActiveTickCpuProfiler } from "@/runtime/cpuPhaseProfiler";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { runHubProgressAnalytics, renderHubProgressOverlays } from "@/runtime/hubProgress";
import { runRemoteMining } from "@/runtime/remoteMining";
import { runMarketSalePreflight } from "@/runtime/marketSaleAutomation";
import { runLiveMarketSaleAutomation } from "@/runtime/marketSaleRuntime";
import { runEmpireInventoryShadowCheck } from "@/runtime/empireInventoryShadow";

mountAll();
registerGlobalApi();
registerConsoleCommands();
registerProductionApi();

export function addNumbers(num1: number, num2: number): number {
  return num1 + num2;
}

function gameLoop(): void {
  const cpuProfiler = createTickCpuProfiler();
  setActiveTickCpuProfiler(cpuProfiler);
  // 本 tick 的 spawn/creep 快照由 TickContext 统一维护，避免与各模块重复
  // Object.values 扫描；快照在 tick 内不可变。
  const tickContext = getTickContextService();

  cpuProfiler.measure("announceDeploy", announceDeploy);
  cpuProfiler.measure("marketSalePreflight", runMarketSalePreflight);
  // 保留冻结生产顺序中的 phase；模块本身由代码级闩永久关闭。
  cpuProfiler.measure("pixelGenerator", runPixelGenerator);
  cpuProfiler.measure("productionMonitor", runProductionMonitor);
  cpuProfiler.measure("nukerControl", runNukerControl);
  cpuProfiler.measure("hubPlanner", runHubPlanner);
  cpuProfiler.measure("hubUpgradeControl", runHubUpgradeControl);
  cpuProfiler.measure("synthesisControl", runSynthesisControl);
  cpuProfiler.measure("factoryControl", runFactoryControl);
  cpuProfiler.measure("mineralExtraction", runMineralExtraction);
  cpuProfiler.measure("resourceControl", runResourceControl);
  cpuProfiler.measure("marketSaleAutomation", runLiveMarketSaleAutomation);
  cpuProfiler.measure("hubProgressAnalytics", runHubProgressAnalytics);
  cpuProfiler.measure("hubProgressOverlay", renderHubProgressOverlays);
  cpuProfiler.measure("externalTelemetryExport", runExternalTelemetryExport);
  cpuProfiler.measure("memoryCleanup", runMemoryCleanup);
  cpuProfiler.measure("portalDiscovery", runPortalDiscovery);
  cpuProfiler.measure("flagControl", runFlagControl);
  cpuProfiler.measure("crossShardSignals", runCrossShardSignals);
  cpuProfiler.measure("interShardControl", runInterShardControl);
  cpuProfiler.measure("warControl", runWarControl);
  cpuProfiler.measure("powerBankObserver", runPowerBankObserver);
  cpuProfiler.measure("powerBankHarvest", runPowerBankHarvest);
  cpuProfiler.measure("powerCreepControl", runPowerCreepControl);
  cpuProfiler.measure("powerSpawnControl", runPowerSpawnControl);
  cpuProfiler.measure("roomPlannerConstruction", runRoomPlannerConstruction);
  cpuProfiler.measure("linkControl", runLinkControl);
  cpuProfiler.measure("coreDefense", runCoreDefense);
  cpuProfiler.measure("defenseMode", runDefenseMode);
  cpuProfiler.measure("homeDefense", runHomeDefense);
  cpuProfiler.measure("towerControl", runTowerControl);
  cpuProfiler.measure("refreshWorkerTasks", refreshWorkerTasks);
  cpuProfiler.measure("bootstrapRooms", bootstrapRooms);
  cpuProfiler.measure("remoteMining", runRemoteMining);
  cpuProfiler.measure("scheduleSpawnTasks", scheduleSpawnTasks);

  cpuProfiler.measure("spawnWork", () => {
    tickContext.getAllSpawns().forEach((spawn) => {
      cpuProfiler.measureRoomPhase("spawnWork", spawn.room.name, () => spawn.work());
    });
  });
  cpuProfiler.measure("creepWork", () => {
    tickContext.getAllCreeps().forEach((creep) => {
      cpuProfiler.measureCreep(creep, () => creep.work());
    });
  });
  // 库存影子等价验证（Phase 1 只读观察者）：低频对账新索引与直读 Store，
  // 不参与任何生产决策；详见 empireInventoryShadow.ts。
  cpuProfiler.measure("empireInventoryShadow", runEmpireInventoryShadowCheck);
  cpuProfiler.flush();
}

export const loop = errorMapper(gameLoop);
