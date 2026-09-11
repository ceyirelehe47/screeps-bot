import type { CompatConfig } from "./treasuryCompatTypes";
/** Both enabled and the absolute tick window must be bound before any rollout.
 * This default is OFF. No Memory or environment-variable override.
 * 2026-09-11 probe-only binding (never uploaded): shard1, S=73634100, rooms
 * E3N59+E4N58. Bound only to give the no-upload collector stability probe a
 * realistic profile; the final observation binding replaces this commit. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59", "E4N58"] as string[]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 73634100,
  endTick: 73635200,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
