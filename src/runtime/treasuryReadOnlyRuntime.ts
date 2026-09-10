/** Thin attachment to the EXISTING production service; no lab assembly/imports.
 * Creating this observer at module load never reads Game or Memory. */
import { TREASURY_READ_ONLY_CONFIG } from "@/config/treasuryReadOnly";
import { getTreasuryService } from "@/runtime/runtimeServices";
import { createTreasuryReadOnlyObserver } from "@/runtime/treasury/readOnlyObservation";

const observer = createTreasuryReadOnlyObserver(TREASURY_READ_ONLY_CONFIG, {
  getTick: () => Game.time,
  getShard: () => Game.shard.name,
  cpu: () => ({ used: Game.cpu.getUsed(), tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }),
  getRoom: name => Game.rooms[name],
  getResourceCatalog: () => RESOURCES_ALL,
  getMemory: () => Memory,
  getService: getTreasuryService,
  emit: line => console.log(line),
});

/** All observer exceptions are contained inside run(); existing game-loop
 * fail-fast behavior for actual business phases remains unchanged. */
export function runTreasuryReadOnlyObservation(): void {
  observer.run();
}
