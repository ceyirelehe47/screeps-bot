import type { CompatConfig } from "./treasuryCompatTypes";
/** Both enabled and the absolute tick window must be bound before any rollout.
 * This default is OFF. No Memory or environment-variable override. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: false,
  shardName: "",
  rooms: Object.freeze([] as string[]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 0,
  endTick: 0,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
