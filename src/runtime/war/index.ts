import { withWarSpawnIndex } from "./spawnIndex";
import { admitWarTasks } from "./admission";
import { getSquadPolicy } from "./squadPolicy/index";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import type { WarTask } from "./store";
import { ensureWarStore } from "./store";
import { isTowerDrainDuoTask } from "./squadPolicy/index";
import { releaseWarTaskAssets } from "./production";
import { resetWarObservationMemo } from "./observation";
import { runNpcLootHandoffs } from "./loot";
import { runWarRebuildWatches } from "./rebuildWatch";
import { writeWarTelemetry } from "./telemetry";

export function runWarControl(): void { withWarSpawnIndex(runWarTick); }
function runWarTick(): void {
  resetWarObservationMemo();
  const store = ensureWarStore();
  const tasks = Object.values(store);
  for (const task of tasks) {
    const terminal = task.status === "done" || task.status === "failed";
    if (terminal && (
      typeof task.assetsReleasedAt !== "number"
      || !Number.isFinite(task.assetsReleasedAt)
      || task.assetsReleasedAt < 0
    )) {
      releaseWarTaskAssets(task);
    }
  }
  admitWarTasks(store);

  measureSampledCpuPhase("war.rebuild", () => runWarRebuildWatches(store));
  measureSampledCpuPhase("war.loot", () => runNpcLootHandoffs(store));
  measureSampledCpuPhase("war.telemetry", writeWarTelemetry);
}
