import type { CompatConfig } from "./treasuryCompatTypes";
/** Both enabled and the absolute tick window must be bound before any rollout.
 * This default is OFF. No Memory or environment-variable override.
 * 2026-09-11 formal limited online observation: shard1, S=73631900, twelve
 * 100-tick slots (endTick=S+1100), rooms E3N59+E4N58, energy/H only.
 * Restored to the accepted default OFF after the run closes. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59", "E4N58"] as string[]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 73631900,
  endTick: 73633000,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
