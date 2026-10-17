import type { CpuMonitorMemoryV2 } from "@/runtime/cpuMonitor";
import type { HubProgressSnapshot } from "@/runtime/hubProgress";
import type { WarStatusTaskSnapshot } from "@/runtime/warControl";
import type { PowerBankPathDiagnostics } from "@/runtime/powerBankPathDistance";

declare global {
  interface ScreepsMemoryAnalytics {
    production?: {
      rooms?: Record<
        string,
        {
          updatedAt: number;
          signal?: {
            looseEnergyTrend: number;
            sourceEnergyTrend: number;
            upgradeRate: number;
            spawnBusy: number;
          };
          latest?: {
            tick: number;
            looseEnergy: number;
            storedEnergy: number;
            sourceEnergy: number;
            workerCount: number;
            carrierCount: number;
            harvesterCount: number;
            spawnSpawning: number;
            controllerLevel: number;
            controllerProgress: number;
          };
        }
      >;
    };
    war?: {
      updatedAt: number;
      clearDebounceTicks: number;
      tasks: Record<string, WarStatusTaskSnapshot>;
    };
    cpuMonitor?: CpuMonitorMemoryV2;
    /** 仅 CPU profiler 采样 tick 更新；每个 global/采样间隔窗口至多 32 个房间对。 */
    powerBankPathDiagnostics?: PowerBankPathDiagnostics;
    hub?: HubProgressSnapshot;
  }
}

export {};
