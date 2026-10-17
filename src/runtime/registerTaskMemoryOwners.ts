import { registerMemoryGcOwner } from "@/runtime/memoryGcRegistry";
import { cleanupCrossShardColonizationTasks } from "@/runtime/crossShardColonization";
import { cleanupDepositDiscoveryTasks } from "@/runtime/depositDiscovery";

const crossShard = { id: "crossShardColonization", cleanup: cleanupCrossShardColonizationTasks };
const deposit = { id: "depositHarvest", cleanup: cleanupDepositDiscoveryTasks };
export function registerTaskMemoryOwners(): void {
  registerMemoryGcOwner(crossShard); registerMemoryGcOwner(deposit);
}
