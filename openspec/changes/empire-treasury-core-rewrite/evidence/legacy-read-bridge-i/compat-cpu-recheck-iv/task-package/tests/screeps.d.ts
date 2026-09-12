// Minimal compile-only fixture; not a substitute for the repository's Screeps types.
type ResourceConstant = string;
interface FakeStore { getUsedCapacity(resource?: ResourceConstant): number; getFreeCapacity(): number; getCapacity(): number; }
interface FakeStructure { my: boolean; id: string; store: FakeStore; isActive(): boolean; }
interface StructureTerminal extends FakeStructure { cooldown: number; }
interface Room { name: string; controller?: { my: boolean }; storage?: FakeStructure; terminal?: StructureTerminal; }
declare const Game: { time: number; shard: { name: string }; rooms: Record<string,Room>; cpu: {getUsed():number;tickLimit:number;bucket:number} };
declare const Memory: unknown;
declare const RESOURCES_ALL: readonly string[];
