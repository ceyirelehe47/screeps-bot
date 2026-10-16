import { ensureClearedNpcLootHandoff } from "@/runtime/flagHauling";
import { isInvaderSalvageTarget } from "@/runtime/invaderSalvageSafety";
import { WAR_CLEAR_DEBOUNCE_TICKS } from "./constants";
import type { WarTask } from "./store";
import { getHostilePresence } from "./observation";

export function runNpcLootHandoffs(store: Record<string, WarTask>): void {
  for (const task of Object.values(store)) {
    if (task.status === "failed") continue;
    const room = Game.rooms[task.targetRoom];
    if (!room) continue;
    if (!isInvaderSalvageTarget(room)) {
      delete task.lootAfterClear;
      continue;
    }
    if (task.lootAfterClear !== true) task.lootAfterClear = true;
    const hostile = getHostilePresence(room, task);
    if (hostile.hostileCreeps || hostile.hostileStructures) {
      if (!task.sharedSquadWatchId) delete task.combatClearSince;
      continue;
    }
    task.combatClearSince ??= Game.time;
    if (Game.time - task.combatClearSince + 1 >= WAR_CLEAR_DEBOUNCE_TICKS) ensureClearedNpcLootHandoff(task.sourceRoom, task.targetRoom);
  }
}
