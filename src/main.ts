import { enforceLegacyMarketSafetyLatch } from "@/runtime/marketSaleConfig";
import { resolveTrafficIntents } from "@/movement/traffic";
import { registerSpawnRequestOwners } from "@/runtime/registerSpawnRequestOwners";
import { createProcessScheduler } from "@/runtime/processScheduler";
import { markCpuTickPhase, completeCpuTickHealth } from "@/runtime/cpuTickHealth";
import { errorMapper, reportRuntimeError } from "@/modules/errorMapper";
import { registerOutboundMissionOwners } from "@/runtime/registerOutboundMissionOwners";
import { registerTaskMemoryOwners } from "@/runtime/registerTaskMemoryOwners";
import { mountAll } from "@/mount";
import { announceDeploy } from "@/runtime/deployAnnounce";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { beginMemoryStorageTick, finishMemoryStorageTick } from "@/runtime/memoryStorage";
import { isPermitChainStorageUnavailableError } from "@/runtime/permitChainStorageGuard";
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
import { runHomeDefense, runHomeDefenseSupply } from "@/runtime/homeDefense";
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
import { runDepositHarvest } from "@/runtime/depositHarvest";
import { runPowerCreepControl, runPowerCreepLifecycle } from "@/runtime/powerCreepControl";
import { runPowerSpawnControl } from "@/runtime/powerSpawnControl";
import { runNukerControl } from "@/runtime/nukerControl";
import { refreshWorkerTasks } from "@/runtime/workerTaskPool";
import { createTickCpuProfiler, setActiveTickCpuProfiler } from "@/runtime/cpuPhaseProfiler";
import { getTickContextService } from "@/runtime/runtimeServices";
import { runHubProgressAnalytics, renderHubProgressOverlays } from "@/runtime/hubProgress";
import { runRemoteMining } from "@/runtime/remoteMining";
import { runMarketSalePreflight } from "@/runtime/marketSaleAutomation";
import { runLiveMarketSaleAutomation } from "@/runtime/marketSaleRuntime";
import { runEmpireInventoryShadowCheck } from "@/runtime/empireInventoryShadow";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer, runTreasuryT1ShadowObservation } from "@/runtime/treasuryTerminalTransfer";

registerOutboundMissionOwners();
registerTaskMemoryOwners();
registerSpawnRequestOwners();
registerTreasuryProductionTerminalTransfer();
registerGlobalApi();
mountAll();
registerConsoleCommands();
registerProductionApi();

export function addNumbers(num1: number, num2: number): number {
  return num1 + num2;
}

function gameLoop(): void {
  beginMemoryStorageTick();
  const cpuProfiler = createTickCpuProfiler();
  setActiveTickCpuProfiler(cpuProfiler);
  // 本 tick 的 spawn/creep 快照由 TickContext 统一维护，避免与各模块重复
  // Object.values 扫描；快照在 tick 内不可变。
  const tickContext = getTickContextService();
  const scheduler = createProcessScheduler((phase, work) => cpuProfiler.measure(phase, work), (phase, error) => {
    if (!isPermitChainStorageUnavailableError(error)) reportRuntimeError(`phase:${phase}`, error);
  });
  const runPhase = scheduler.runPhase;
  let treasuryLifecycleStarted = false;
  runPhase("treasuryBeginTick", () => {
    treasuryLifecycleStarted = beginTreasuryProductionTick();
  });

  try {
    scheduler.runAll({
      announceDeploy: announceDeploy,
      marketSafetyLatch: enforceLegacyMarketSafetyLatch,
      marketSalePreflight: runMarketSalePreflight,
      pixelGenerator: runPixelGenerator,
      productionMonitor: runProductionMonitor,
      nukerControl: runNukerControl,
      hubPlanner: runHubPlanner,
      hubUpgradeControl: runHubUpgradeControl,
      synthesisControl: runSynthesisControl,
      factoryControl: runFactoryControl,
      mineralExtraction: runMineralExtraction,
      resourceControl: runResourceControl,
      marketSaleAutomation: runLiveMarketSaleAutomation,
      hubProgressAnalytics: runHubProgressAnalytics,
      hubProgressOverlay: renderHubProgressOverlays,
      externalTelemetryExport: runExternalTelemetryExport,
      memoryCleanup: runMemoryCleanup,
      portalDiscovery: runPortalDiscovery,
      flagControl: runFlagControl,
      crossShardSignals: runCrossShardSignals,
      interShardControl: runInterShardControl,
      warControl: runWarControl,
      powerBankObserver: runPowerBankObserver,
      powerBankHarvest: runPowerBankHarvest,
      depositHarvest: runDepositHarvest,
      powerCreepLifecycle: runPowerCreepLifecycle,
      powerCreepControl: runPowerCreepControl,
      powerSpawnControl: runPowerSpawnControl,
      roomPlannerConstruction: runRoomPlannerConstruction,
      linkControl: runLinkControl,
      coreDefense: runCoreDefense,
      defenseMode: runDefenseMode,
      homeDefense: runHomeDefense,
      homeDefenseSupply: runHomeDefenseSupply,
      towerControl: runTowerControl,
      refreshWorkerTasks: refreshWorkerTasks,
      bootstrapRooms: bootstrapRooms,
      remoteMining: runRemoteMining,
      scheduleSpawnTasks: scheduleSpawnTasks,
      spawnWork: () => {
        tickContext.getAllSpawns().forEach((spawn) => {
          try {
            cpuProfiler.measureRoomPhase("spawnWork", spawn.room.name, () => spawn.work());
          } catch (error) {
            reportRuntimeError(`spawn:${spawn.name}`, error);
          }
        });
      },
      creepWork: () => {
        tickContext.getAllCreeps().forEach((creep) => {
          try {
            cpuProfiler.measureCreep(creep, () => creep.work());
          } catch (error) {
            reportRuntimeError(`creep:${creep.name}`, error);
          }
        });
      },
      trafficResolution: () => { resolveTrafficIntents(); },
      empireInventoryShadow: runEmpireInventoryShadowCheck,
    });
  } finally {
    try {
      runPhase("treasuryT1Shadow", runTreasuryT1ShadowObservation);
      if (treasuryLifecycleStarted) {
        runPhase("treasuryEndTick", endTreasuryProductionTick);
      }
    } finally {
      markCpuTickPhase("cpuProfiler.flush");
      try {
        cpuProfiler.flush();
      } catch (error) {
        reportRuntimeError("cpuProfiler.flush", error);
      } finally {
        markCpuTickPhase("processScheduler.finish");
        try { scheduler.finish(); }
        catch (error) { reportRuntimeError("processScheduler.finish", error); }
        markCpuTickPhase("memoryStorage.finish");
        try { finishMemoryStorageTick(); completeCpuTickHealth(); }
        catch (error) { reportRuntimeError("memoryStorage.finish", error); }
      }
    }
  }
}

export const loop = errorMapper(gameLoop);
