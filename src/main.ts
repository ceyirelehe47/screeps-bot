import { errorMapper, reportRuntimeError } from "@/modules/errorMapper";
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
import { runDepositHarvest } from "@/runtime/depositHarvest";
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
import {
  beginTreasuryProductionTick,
  endTreasuryProductionTick,
  registerTreasuryProductionTerminalTransfer,
  runTreasuryT1ShadowObservation,
} from "@/runtime/treasuryTerminalTransfer";

registerTreasuryProductionTerminalTransfer();
mountAll();
registerGlobalApi();
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
  // 普通阶段在编排边界隔离；T0 防御另有房间/单塔边界，避免一处故障阻断其余防御。
  const runPhase = (phase: string, work: () => void): void => {
    try {
      cpuProfiler.measure(phase, work);
    } catch (error) {
      if (!isPermitChainStorageUnavailableError(error)) reportRuntimeError(`phase:${phase}`, error);
    }
  };
  let treasuryLifecycleStarted = false;
  runPhase("treasuryBeginTick", () => {
    treasuryLifecycleStarted = beginTreasuryProductionTick();
  });

  try {
    runPhase("announceDeploy", announceDeploy);
    runPhase("marketSalePreflight", runMarketSalePreflight);
    // 保留冻结生产顺序中的 phase；模块本身由代码级闩永久关闭。
    runPhase("pixelGenerator", runPixelGenerator);
    runPhase("productionMonitor", runProductionMonitor);
    runPhase("nukerControl", runNukerControl);
    runPhase("hubPlanner", runHubPlanner);
    runPhase("hubUpgradeControl", runHubUpgradeControl);
    runPhase("synthesisControl", runSynthesisControl);
    runPhase("factoryControl", runFactoryControl);
    runPhase("mineralExtraction", runMineralExtraction);
    runPhase("resourceControl", runResourceControl);
    runPhase("marketSaleAutomation", runLiveMarketSaleAutomation);
    runPhase("hubProgressAnalytics", runHubProgressAnalytics);
    runPhase("hubProgressOverlay", renderHubProgressOverlays);
    runPhase("externalTelemetryExport", runExternalTelemetryExport);
    runPhase("memoryCleanup", runMemoryCleanup);
    runPhase("portalDiscovery", runPortalDiscovery);
    runPhase("flagControl", runFlagControl);
    runPhase("crossShardSignals", runCrossShardSignals);
    runPhase("interShardControl", runInterShardControl);
    runPhase("warControl", runWarControl);
    runPhase("powerBankObserver", runPowerBankObserver);
    runPhase("powerBankHarvest", runPowerBankHarvest);
    runPhase("depositHarvest", runDepositHarvest);
    runPhase("powerCreepControl", runPowerCreepControl);
    runPhase("powerSpawnControl", runPowerSpawnControl);
    runPhase("roomPlannerConstruction", runRoomPlannerConstruction);
    runPhase("linkControl", runLinkControl);
    runPhase("coreDefense", runCoreDefense);
    runPhase("defenseMode", runDefenseMode);
    runPhase("homeDefense", runHomeDefense);
    runPhase("towerControl", runTowerControl);
    runPhase("refreshWorkerTasks", refreshWorkerTasks);
    runPhase("bootstrapRooms", bootstrapRooms);
    runPhase("remoteMining", runRemoteMining);
    runPhase("scheduleSpawnTasks", scheduleSpawnTasks);

    runPhase("spawnWork", () => {
      tickContext.getAllSpawns().forEach((spawn) => {
        try {
          cpuProfiler.measureRoomPhase("spawnWork", spawn.room.name, () => spawn.work());
        } catch (error) {
          reportRuntimeError(`spawn:${spawn.name}`, error);
        }
      });
    });
    runPhase("creepWork", () => {
      tickContext.getAllCreeps().forEach((creep) => {
        try {
          cpuProfiler.measureCreep(creep, () => creep.work());
        } catch (error) {
          reportRuntimeError(`creep:${creep.name}`, error);
        }
      });
    });
    // 库存影子等价验证（Phase 1 只读观察者）：低频对账新索引与直读 Store，
    // 不参与任何生产决策；详见 empireInventoryShadow.ts。
    runPhase("empireInventoryShadow", runEmpireInventoryShadowCheck);
  } finally {
    try {
      runPhase("treasuryT1Shadow", runTreasuryT1ShadowObservation);
      if (treasuryLifecycleStarted) {
        runPhase("treasuryEndTick", endTreasuryProductionTick);
      }
    } finally {
      try {
        cpuProfiler.flush();
      } catch (error) {
        reportRuntimeError("cpuProfiler.flush", error);
      } finally {
        try { finishMemoryStorageTick(); }
        catch (error) { reportRuntimeError("memoryStorage.finish", error); }
      }
    }
  }
}

export const loop = errorMapper(gameLoop);
