import { registerSpawnRequestOwner, type SpawnRequestOwner } from "@/runtime/spawnRequestOwners";
import { canSpawnDepositConfig } from "@/runtime/depositHarvest";
import { registerWarSpawn } from "@/runtime/war/store";

const deposit: SpawnRequestOwner = {
  id: "deposit",
  matches: (_name, config) => config.role === "depositHarvester",
  canExecute: canSpawnDepositConfig,
};
const war: SpawnRequestOwner = {
  id: "war",
  matches: name => name.includes(":war:"),
  accepted: registerWarSpawn,
};
export function registerSpawnRequestOwners(): void {
  registerSpawnRequestOwner(deposit);
  registerSpawnRequestOwner(war);
}
