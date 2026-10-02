import {
  cpuMonitorCommand,
  cpuMonitorRaw,
  registerCpuProfilerConsoleCommands,
  startCpuProfiler,
  startCpuProfilerCommand,
  startCpuProfilerRaw,
  statusCpuProfilerCommand,
  statusCpuProfilerRaw,
  stopCpuProfilerCommand,
  stopCpuProfilerExport,
  stopCpuProfilerRaw,
} from "@/runtime/console/cpuProfilerCommands";
import {
  registerOperationsConsoleCommands,
  spawnMaxCarrier,
  spawnMaxCarrierCommand,
  spawnMaxCarrierRaw,
  startUpgraderCommand,
  startUpgraderRaw,
  startWarCommand,
  startWarPatrolCommand,
  startWarPatrolRaw,
  startWarRaw,
  stopColonization,
  stopColonizationCommand,
  stopColonizationRaw,
  stopUpgraderCommand,
  stopUpgraderRaw,
  upgraderStatusCommand,
  upgraderStatusRaw,
  stopWarCommand,
  stopWarRaw,
  warStatusCommand,
  warStatusRaw,
} from "@/runtime/console/operationsCommands";
import {
  registerTelemetryConsoleCommands,
  startTelemetry,
  startTelemetryCommand,
  startTelemetryRaw,
  statusTelemetryCommand,
  statusTelemetryRaw,
  stopTelemetryCommand,
  stopTelemetryExport,
  stopTelemetryRaw,
} from "@/runtime/console/telemetryCommands";
import {
  addResourceTransferTaskCommand,
  addResourceTransferTaskRaw,
  addResourceTransferTasksCommand,
  addResourceTransferTasksRaw,
  cancelResourceTransferTaskCommand,
  cancelResourceTransferTaskRaw,
  listResourceTransferTasksCommand,
  listResourceTransferTasksRaw,
  registerResourceTransferConsoleCommands,
} from "@/runtime/console/resourceTransferCommands";
import {
  addFactoryTaskCommand,
  addFactoryTaskRaw,
  cancelFactoryTaskCommand,
  cancelFactoryTaskRaw,
  decompressBatteryCommand,
  decompressBatteryRaw,
  listFactoryTasksCommand,
  listFactoryTasksRaw,
  registerFactoryTaskConsoleCommands,
} from "@/runtime/console/factoryTaskCommands";
import {
  registerRemoteDefenseConsoleCommands,
  remoteDefenseStatusCommand,
  remoteDefenseStatusRaw,
} from "@/runtime/console/remoteDefenseCommands";
import { clearHubSynthesisReactions } from "@/runtime/hubPlanner";
import { collectHubProgressSnapshot } from "@/runtime/hubProgress";
import { buildMemoryAuditSnapshot, MemoryAuditSnapshot } from "@/runtime/memoryAudit";
import { powerBankStatusCommand, powerBankStatusRaw } from "@/runtime/powerBankStatus";
import {
  armTreasuryT1FirstLive,
  heartbeatTreasuryT1FirstLive,
  closeTreasuryT1FirstLive,
  treasuryT1FirstLiveStatus,
} from "@/runtime/treasuryT1FirstLiveControl";

import { armTreasuryT2FirstLive, heartbeatTreasuryT2FirstLive, closeTreasuryT2FirstLive, treasuryT2FirstLiveStatus } from "@/runtime/treasuryT2FirstLiveControl";
import { armTreasuryT3FirstLive, prepareTreasuryT3FirstLive, heartbeatTreasuryT3FirstLive, closeTreasuryT3FirstLive, treasuryT3FirstLiveStatus } from "@/runtime/treasuryT3FirstLiveControl";

interface SynthesisControlStatusResult {
  ok: true;
  enabled: boolean;
  state:
    | {
        updatedAt: number;
        generatedTaskCount: number;
        failedTaskCount: number;
        successfulRunCount: number;
        lastActions: string[];
      }
    | null;
}

export function statusSynthesisControlRaw(): SynthesisControlStatusResult {
  const state = Memory.runtime?.synthesisControl;
  return {
    ok: true,
    enabled: Memory.cfg?.synthesisControl?.enabled === true,
    state: state
      ? {
          updatedAt: state.updatedAt,
          generatedTaskCount: state.generatedTaskCount,
          failedTaskCount: state.failedTaskCount,
          successfulRunCount: state.successfulRunCount,
          lastActions: state.lastActions,
        }
      : null,
  };
}

export function statusSynthesisControlCommand(): string {
  return JSON.stringify(statusSynthesisControlRaw());
}

export function statusHubRaw(): Record<string, unknown> {
  const hub = Memory.cfg?.hub;
  if (!hub?.hubRoomName) {
    return { enabled: false, hubRoomName: null, status: "not_configured" };
  }
  const synthesisRoom = Memory.runtime?.synthesisControl?.rooms?.[hub.hubRoomName];
  return {
    enabled: hub.enabled ?? false,
    hubRoomName: hub.hubRoomName,
    status: hub.enabled ? "active" : "disabled",
    activeProduct: synthesisRoom?.activeProduct ?? null,
    activeStage: synthesisRoom?.stage ?? null,
    lastError: Memory.runtime?.hub?.lastError ?? null,
    needsPlan: Memory.runtime?.hub?.needsPlan ?? false,
    targetCompounds: hub.targetCompounds ?? [],
  };
}

export function statusHubCommand(): string {
  return JSON.stringify(statusHubRaw(), null, 2);
}

export function stopHubRaw(): Record<string, unknown> {
  const hub = Memory.cfg?.hub;
  const hubRoomName = hub?.hubRoomName;
  if (!hubRoomName) {
    return { ok: false, error: "hub_not_configured" };
  }
  hub.enabled = false;
  clearHubSynthesisReactions(hubRoomName);
  return { ok: true, hubRoomName, enabled: false, reactionsCleared: true };
}

export function stopHubCommand(): string {
  return JSON.stringify(stopHubRaw(), null, 2);
}

export function hubProgressRaw(): ReturnType<typeof collectHubProgressSnapshot> {
  return collectHubProgressSnapshot();
}

export function hubProgressCommand(): string {
  return JSON.stringify(hubProgressRaw(), null, 2);
}

export function memoryAuditRaw(): MemoryAuditSnapshot {
  return buildMemoryAuditSnapshot(Memory);
}

export function memoryAudit(): string {
  return JSON.stringify(memoryAuditRaw(), null, 2);
}

export function registerConsoleCommands(): void {
  registerOperationsConsoleCommands();
  registerTelemetryConsoleCommands();
  registerCpuProfilerConsoleCommands();
  global.statusSynthesisControl = statusSynthesisControlCommand;
  global.statusSynthesisControlRaw = statusSynthesisControlRaw;
  global.statusHub = statusHubCommand;
  global.statusHubRaw = statusHubRaw;
  global.stopHub = stopHubCommand;
  global.stopHubRaw = stopHubRaw;
  global.hubProgress = hubProgressCommand;
  global.hubProgressRaw = hubProgressRaw;
  global.memoryAudit = memoryAudit;
  global.memoryAuditRaw = memoryAuditRaw;
  global.armTreasuryT2FirstLive = armTreasuryT2FirstLive;
  global.heartbeatTreasuryT2FirstLive = heartbeatTreasuryT2FirstLive;
  global.closeTreasuryT2FirstLive = closeTreasuryT2FirstLive;
  global.treasuryT2FirstLiveStatus = treasuryT2FirstLiveStatus;
  global.armTreasuryT3FirstLive = armTreasuryT3FirstLive;
  global.prepareTreasuryT3FirstLive = prepareTreasuryT3FirstLive;
  global.heartbeatTreasuryT3FirstLive = heartbeatTreasuryT3FirstLive;
  global.closeTreasuryT3FirstLive = closeTreasuryT3FirstLive;
  global.treasuryT3FirstLiveStatus = treasuryT3FirstLiveStatus;
  global.armTreasuryT1FirstLive = armTreasuryT1FirstLive;
  global.heartbeatTreasuryT1FirstLive = heartbeatTreasuryT1FirstLive;
  global.closeTreasuryT1FirstLive = closeTreasuryT1FirstLive;
  global.treasuryT1FirstLiveStatus = treasuryT1FirstLiveStatus;
  global.powerBankStatus = powerBankStatusCommand;
  global.powerBankStatusRaw = powerBankStatusRaw;
  registerResourceTransferConsoleCommands();
  registerFactoryTaskConsoleCommands();
  registerRemoteDefenseConsoleCommands();
}

export {
  addResourceTransferTaskCommand,
  addResourceTransferTaskRaw,
  addResourceTransferTasksCommand,
  addResourceTransferTasksRaw,
  addFactoryTaskCommand,
  addFactoryTaskRaw,
  cpuMonitorCommand,
  cpuMonitorRaw,
  cancelFactoryTaskCommand,
  cancelFactoryTaskRaw,
  cancelResourceTransferTaskCommand,
  cancelResourceTransferTaskRaw,
  decompressBatteryCommand,
  decompressBatteryRaw,
  listFactoryTasksCommand,
  listFactoryTasksRaw,
  listResourceTransferTasksCommand,
  listResourceTransferTasksRaw,
  remoteDefenseStatusCommand,
  remoteDefenseStatusRaw,
  powerBankStatusCommand,
  powerBankStatusRaw,
  spawnMaxCarrier,
  spawnMaxCarrierCommand,
  spawnMaxCarrierRaw,
  startUpgraderCommand,
  startUpgraderRaw,
  startWarCommand,
  startWarPatrolCommand,
  startWarPatrolRaw,
  startWarRaw,
  startCpuProfiler,
  startCpuProfilerCommand,
  startCpuProfilerRaw,
  statusCpuProfilerCommand,
  statusCpuProfilerRaw,
  stopCpuProfilerCommand,
  stopCpuProfilerExport,
  stopCpuProfilerRaw,
  stopColonization,
  stopColonizationCommand,
  stopColonizationRaw,
  stopUpgraderCommand,
  stopUpgraderRaw,
  stopWarCommand,
  stopWarRaw,
  warStatusCommand,
  warStatusRaw,
  upgraderStatusCommand,
  upgraderStatusRaw,
  startTelemetry,
  startTelemetryCommand,
  startTelemetryRaw,
  statusTelemetryCommand,
  statusTelemetryRaw,
  stopTelemetryCommand,
  stopTelemetryExport,
  stopTelemetryRaw,
};
