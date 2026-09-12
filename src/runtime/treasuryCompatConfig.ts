import type { CompatConfig } from "./treasuryCompatTypes";
/** Observation 0003: one frozen absolute window; no Memory or environment override. */
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59", "E4N58"]),
  resources: Object.freeze(["energy", "H"]),
  startTick: 73646500,
  endTick: 73647600,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 2,
  reserveCpu: 5,
  maxLogBytes: 16384,
});
