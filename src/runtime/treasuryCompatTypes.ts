/** Structural read ports only. No TreasuryService, lifecycle or dispatch API. */
export interface CompatConfig {
  readonly enabled: boolean;
  readonly shardName: string;
  readonly rooms: readonly string[];
  readonly resources: readonly string[];
  readonly startTick: number;
  readonly endTick: number;
  readonly intervalTicks: number;
  readonly minBucket: number;
  readonly maxSampleCpu: number;
  readonly reserveCpu: number;
  readonly maxLogBytes: number;
}
export interface CompatObservation {
  readonly epoch: { readonly observedAtTick: number };
  location(room: string, kind: "storage" | "terminal"): {
    readonly exists: boolean; readonly structureId?: string;
    readonly amounts: Readonly<Record<string, number>>;
    readonly usedCapacity: number; readonly freeCapacity: number;
  };
}
export interface CompatIndex {
  readonly completeness: { readonly complete: boolean; readonly globalIncomplete: boolean;
    readonly incompleteScopeCount: number; readonly invalidRecords: number };
  readonly metrics: Readonly<Record<string, number | boolean>>;
  outgoing(room: string, resource: string): number;
  incoming(room: string, resource: string): number;
  reservedProduction(room: string, resource: string): number;
  commitmentCompleteness(room: string, resource: string): string;
}
export interface CompatReadBuilders {
  buildObservation(options: { scope: "market-fresh"; epochSeq: number;
    rooms: readonly Room[] }): CompatObservation;
  buildCommitments(options: { tick: number; tasks: Record<string, unknown>;
    reservations: Record<string, unknown>; observation: CompatObservation }): CompatIndex;
}
export interface CompatPorts {
  tick(): number;
  shard(): string;
  cpu(): { used: number; tickLimit: number; bucket: number };
  room(name: string): Room | undefined;
  memory(): unknown;
  resources(): readonly string[];
  /** Fresh mutable reader state per sample; audited definitions may be reused. */
  readers(): CompatReadBuilders;
  emit(line: string): void;
}
