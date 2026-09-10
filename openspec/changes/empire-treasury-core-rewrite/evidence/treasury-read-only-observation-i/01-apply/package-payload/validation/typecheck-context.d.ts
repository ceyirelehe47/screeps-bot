// LOCAL CHECK ONLY: selected API declarations, NOT the repository or official
// installed game types. Full project typecheck remains an Agent acceptance gate.
type ResourceConstant = string;
interface StoreDefinition { getUsedCapacity(r?: ResourceConstant): number | null; getFreeCapacity(): number | null; getCapacity(): number | null; }
interface StructureStorage { id: string; my: boolean; store: StoreDefinition; isActive(): boolean; }
interface StructureTerminal extends StructureStorage { cooldown: number; }
interface Room { name: string; controller?: { my: boolean; level: number }; storage?: StructureStorage; terminal?: StructureTerminal; }
declare const Game: { time: number; shard: {name: string}; rooms: Record<string,Room>; cpu: {getUsed():number; tickLimit:number; bucket:number} };
declare const Memory: unknown;
declare const RESOURCES_ALL: string[];
declare const console: {log(s:string):void};
declare module "@/runtime/treasury/types" { export type TreasuryLocationKind = 'storage'|'terminal'; }
declare module "@/runtime/treasury/facade" {
  type K = 'storage'|'terminal';
  interface Epoch { observedAtTick:number; worldSequence:number; }
  interface Location {exists:boolean; structureId?:string; amounts:Readonly<Record<string,number>>; usedCapacity:number; freeCapacity:number; }
  interface Observation { epoch:Epoch; hasRoom(s:string):boolean; isStale():boolean; location(s:string,k:K):Location; }
  interface Index {builtAtTick:number; revision:number; completeness:{complete:boolean; globalIncomplete:boolean; incompleteScopeCount:number; invalidRecords:number}; metrics:{taskRecords:number; reservationRecords:number}; commitmentCompleteness(s:string,r:string):string; outgoing(s:string,r:string):number; incoming(s:string,r:string):number; reservedProduction(s:string,r:string):number;}
  interface Q {resource:string; rooms?:readonly string[]; locations?:readonly K[]; allowProjected?:boolean; allowIncoming?:boolean; subtractOutgoing?:boolean; subtractReservations?:boolean; withhold?:number;}
  interface Balance {observed:number; committed:number; incoming:number; spendable:number; epoch:Epoch; contextStatus:string; commitmentStatus:string; authorizationSafe:boolean; authorizationBlockers:readonly string[]; writeAdmission:{ready:boolean; blockers:readonly string[]};}
  export interface TreasuryService {observation():Observation; commitments():Index; query(q:Q):Balance; riskAdjustedFreeCapacity(r:string,k:K):number; kernelJournal():{legacyStores:readonly string[];health:{status:'absent'|'healthy'|'unhealthy'|'incompatible';reason:string|null;ringDegraded:string|null}; active:readonly {phase:string}[];ring:readonly unknown[]};}
}
declare module "@/runtime/runtimeServices" { import type {TreasuryService} from '@/runtime/treasury/facade'; export function getTreasuryService():TreasuryService; }
