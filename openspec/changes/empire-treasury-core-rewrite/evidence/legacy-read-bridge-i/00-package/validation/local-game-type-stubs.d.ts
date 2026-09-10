type ResourceConstant = string;
interface Store { getUsedCapacity(resource?: ResourceConstant): number; getCapacity(resource?: ResourceConstant): number | null; getFreeCapacity(resource?: ResourceConstant): number; }
interface StructureStorage { id:string;my:boolean;store:Store;isActive():boolean; }
interface StructureTerminal extends StructureStorage { cooldown:number; }
interface Room { name:string;controller?:{my:boolean};storage?:StructureStorage;terminal?:StructureTerminal; }
declare const Game: { time:number;shard:{name:string};rooms:Record<string,Room>;cpu:{getUsed():number;tickLimit:number;bucket:number} };
declare const Memory: unknown;
declare const RESOURCES_ALL: readonly string[];
