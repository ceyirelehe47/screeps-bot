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
