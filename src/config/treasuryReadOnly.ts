import type { TreasuryReadOnlyConfig } from "@/runtime/treasury/readOnlyObservation";

/** Production-side diagnostic ONLY. Enabling or deploying is a separate task.
 * Empty scope is deliberately NOT interpreted as "all rooms". No Memory flag,
 * environment-variable override, experiment config or writable console API. */
export const TREASURY_READ_ONLY_CONFIG: TreasuryReadOnlyConfig = Object.freeze({
  enabled: false,
  shardName: "",
  rooms: Object.freeze([] as string[]),
  resources: Object.freeze(["energy", "H"]),
  intervalTicks: 100,
  maxSampleCpu: 2,
  reserveCpu: 5,
  minBucket: 2000,
  maxLogBytes: 16384,
});
