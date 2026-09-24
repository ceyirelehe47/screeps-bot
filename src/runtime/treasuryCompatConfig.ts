import type { CompatConfig } from "./treasuryCompatTypes";
export const TREASURY_COMPAT_CONFIG: CompatConfig = Object.freeze({
  enabled: true,
  shardName: "shard1",
  rooms: Object.freeze(["E3N59","E4N58"]),
  resources: Object.freeze(["energy","H"]),
  startTick: 73918900,
  endTick: 73919200,
  intervalTicks: 100,
  minBucket: 2000,
  maxSampleCpu: 10,
  reserveCpu: 25,
  maxLogBytes: 16384,
});
