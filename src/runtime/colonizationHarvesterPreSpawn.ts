import { searchPlanningPath } from "@/movement/pathSearch";
import { getRoomStaticMatrix } from "@/movement/pathing";
import { getMemoryService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

const CACHE_TTL = 1000;
const QUEUE_BUFFER = 30;
let searchTick = -1;
let searches = 0;

/** 新房持久采矿支援按完整许可路线补员，不把母房出口当作通勤终点。 */
export function colonizationHarvesterPreSpawnThreshold(
  spawn: StructureSpawn, configName: string, config: CreepConfig, body: BodyPartConstant[],
): number | undefined {
  if (config.role !== "colonizerHarvester") return undefined;
  const [home, kind, target, role, sourceId] = configName.split(":");
  const policy = Memory.cfg?.colonizationSupport?.[target];
  if (kind !== "colonizationSupport" || role !== "harvester" || home !== spawn.room.name ||
      policy?.sourceRoom !== home || policy.enabled !== true ||
      config.args[0] !== target || config.args[1] !== sourceId) return undefined;
  const route = (config.args[2] ?? "").split("|").filter(room => /^[WE]\d+[NS]\d+$/.test(room));
  const allowedRooms = new Set([home, ...route, target]);
  const hops = Math.max(1, route.length - 1, Game.map?.getRoomLinearDistance?.(home, target) ?? 1);
  const source = Game.getObjectById<Source>(sourceId as Id<Source>);
  const goal = source?.pos ?? new RoomPosition(25, 25, target);
  const moves = body.filter(part => part === MOVE).length;
  const weight = body.filter(part => part !== MOVE && part !== CARRY).length;
  const stepTicks = (cost: number): number => Math.max(1, Math.ceil(weight * cost / Math.max(1, moves * 2)));
  // 定期清理按首段识别所属母房，保持与既有通勤缓存相同的键契约。
  const key = `${home}:colony-v1:${spawn.pos.x}:${spawn.pos.y}:${target}:${goal.x}:${goal.y}:${weight}:${moves}:${route.join("|")}`;
  const cache = (getMemoryService().ensureRuntime().spawnPlanner ??= { sourceWorkerCommutes: {} }).sourceWorkerCommutes;
  const previous = cache[key];
  let commute = previous && Game.time - previous.updatedAt <= CACHE_TTL ? previous.commute : undefined;
  if (commute === undefined) {
    commute = 150 * hops * stepTicks(2);
    if (searchTick !== Game.time) { searchTick = Game.time; searches = 0; }
    if (source && searches < 1) {
      searches += 1;
      const matrices = new Map<string, CostMatrix>();
      const terrains = new Map<string, ReturnType<GameMap["getRoomTerrain"]>>();
      const result = searchPlanningPath(spawn.pos, { pos: goal, range: 1 }, {
        plainCost: 2, swampCost: 10, maxRooms: Math.min(16, allowedRooms.size), maxOps: 2000,
        roomCallback: roomName => {
          if (!allowedRooms.has(roomName)) return false;
          const matrix = getRoomStaticMatrix(roomName);
          matrices.set(roomName, matrix);
          return matrix;
        },
      });
      if (!result.incomplete && result.path.length > 0) {
        commute = result.path.reduce((sum, pos) => {
          const road = matrices.get(pos.roomName)?.get(pos.x, pos.y) === 1;
          let terrain = terrains.get(pos.roomName);
          if (!terrain) { terrain = Game.map.getRoomTerrain(pos.roomName); terrains.set(pos.roomName, terrain); }
          return sum + stepTicks(road ? 1 : (terrain.get(pos.x, pos.y) & TERRAIN_MASK_SWAMP) ? 10 : 2);
        }, 0);
      }
      cache[key] = { commute, updatedAt: Game.time };
    }
  }
  return commute + body.length * CREEP_SPAWN_TIME + QUEUE_BUFFER;
}
