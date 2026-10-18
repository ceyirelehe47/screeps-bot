import { cleanupRoomPlannerMemory, cleanupRoomPlannerBuildRuntimeMemory } from "@/runtime/roomPlannerConstruction";
import { cleanupResourceControlMemory } from "@/runtime/resourceControl";
import { cleanupSynthesisControlMemory } from "@/runtime/synthesisControl";
import { cleanupSpawnPlannerMemory } from "@/runtime/spawnPlanner";
import { cleanupIllegalStructureCleanupMemory } from "@/runtime/workerTaskPool";
import { cleanupTowerEmergencyMemory, cleanupTowerCombatMemory } from "@/runtime/towerControl";
import { cleanupDefenseCoordinationMemory } from "@/runtime/defenseCoordination";
import { cleanupHubRuntimeMemory } from "@/runtime/hubPlanner";
import { getColonizationTargetRoomNames } from "@/runtime/colonization";
import { getPowerBankBoostOwnerReferences } from "@/runtime/powerBankHarvest";
import { getWarBoostOwnerReferences } from "@/runtime/war/store";
import { cleanupPowerBankBoostMemory } from "@/runtime/powerBankBoostMemory";
import { cleanupSynthesisBoostPause } from "@/runtime/synthesisControl";
import { getCreepConfigService } from "@/runtime/runtimeServices";

function activeBoostOwnerReferences(): ReadonlySet<string> {
  const refs = new Set([...getPowerBankBoostOwnerReferences(), ...getWarBoostOwnerReferences()]);
  for (const [, config] of getCreepConfigService().getReadIndex().entries) {
    for (const arg of config.args) refs.add(arg);
  }
  return refs;
}
import { cleanupWarTasks } from "@/runtime/war/api";
import { cleanupRescueTasks } from "@/runtime/rescue";
import { cleanupPortalDiscoveryMemory } from "@/runtime/portalDiscovery";
import { cleanupInterShardRemoteMemory } from "@/runtime/interShardControl";
import { cleanupCrossShardSignalMemory } from "@/runtime/crossShardSignals";
import { registerMemoryGcOwner } from "@/runtime/memoryGcRegistry";
import { cleanupCrossShardColonizationTasks } from "@/runtime/crossShardColonization";
import { cleanupDepositDiscoveryTasks } from "@/runtime/depositDiscovery";

const crossShard = { id: "crossShardColonization", cleanup: cleanupCrossShardColonizationTasks };
const deposit = { id: "depositHarvest", cleanup: cleanupDepositDiscoveryTasks };
const moreOwners = [
  { id: "cleanupRoomPlannerMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupRoomPlannerMemory(ownedRooms, getColonizationTargetRoomNames()) },
  { id: "cleanupRoomPlannerBuildRuntimeMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupRoomPlannerBuildRuntimeMemory(ownedRooms) },
  { id: "cleanupResourceControlMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupResourceControlMemory(ownedRooms) },
  { id: "cleanupSynthesisControlMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupSynthesisControlMemory(ownedRooms) },
  { id: "cleanupSpawnPlannerMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupSpawnPlannerMemory(ownedRooms) },
  { id: "cleanupIllegalStructureCleanupMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupIllegalStructureCleanupMemory(ownedRooms) },
  { id: "cleanupTowerEmergencyMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupTowerEmergencyMemory(ownedRooms) },
  { id: "cleanupTowerCombatMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupTowerCombatMemory(ownedRooms) },
  { id: "cleanupDefenseCoordinationMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupDefenseCoordinationMemory(ownedRooms) },
  { id: "cleanupHubRuntimeMemory", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupHubRuntimeMemory(ownedRooms) },
  { id: "boostPreparation", cleanup: () => cleanupPowerBankBoostMemory(activeBoostOwnerReferences()) },
  { id: "synthesisBoostPause", cleanup: () => cleanupSynthesisBoostPause(activeBoostOwnerReferences()) },
  { id: "war", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupWarTasks(ownedRooms) },
  { id: "rescue", cleanup: ({ ownedRooms }: import("@/runtime/memoryGcRegistry").MemoryGcContext) => cleanupRescueTasks(ownedRooms) },
  { id: "interShardPortals", cleanup: cleanupPortalDiscoveryMemory },
  { id: "crossShard.remotes", cleanup: cleanupInterShardRemoteMemory },
  { id: "crossShard.signals", cleanup: cleanupCrossShardSignalMemory },
];
export function registerTaskMemoryOwners(): void {
  registerMemoryGcOwner(crossShard); registerMemoryGcOwner(deposit);
  for (const owner of moreOwners) registerMemoryGcOwner(owner);
}
