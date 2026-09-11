import type { CompatConfig } from "./treasuryCompatTypes";
/** Both enabled and the absolute tick window must be bound before any rollout.
 * This default is OFF. No Memory or environment-variable override.
 * 2026-09-11 limited online observation binding: shard1, S=73624800 (12 slots at
 * 100-tick intervals), rooms E3N59+E4N58, energy/H only. Reverted to OFF after close. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59", "E4N58"] as string[]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 73624800,
  endTick: 73625900,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
