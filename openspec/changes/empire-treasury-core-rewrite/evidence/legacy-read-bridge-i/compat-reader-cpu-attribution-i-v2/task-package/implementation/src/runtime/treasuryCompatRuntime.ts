import { TREASURY_COMPAT_CONFIG } from "./treasuryCompatConfig";
import { createTreasuryCompatPreview } from "./treasuryCompatRead";
import { createCompatibilityReadCore } from "./treasuryCompatReadCore.generated";
/** This is attached to the OLD main, with no getTreasuryService()/begin/end.
 * Factory definitions are lazy. A disabled observer never opens read modules. */
const preview = createTreasuryCompatPreview(TREASURY_COMPAT_CONFIG, {
  tick: () => Game.time,
  shard: () => Game.shard.name,
  cpu: () => ({ used: Game.cpu.getUsed(), tickLimit: Game.cpu.tickLimit, bucket: Game.cpu.bucket }),
  room: name => Game.rooms[name],
  memory: () => Memory,
  resources: () => RESOURCES_ALL,
  readers: createCompatibilityReadCore,
  emit: line => console.log(line),
}, { cpuDiagnostics: true });
export function runTreasuryCompatRead(): void { preview.run(); }
