import { getRoomStaticMatrix } from "@/movement/pathing";
import { getMemoryService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

const CACHE_TTL = 1000;
const QUEUE_BUFFER = 30;
let searchTick = -1;
let searches = 0;

/** 常规外矿的补员不能把 findPathTo 到本房出口的长度当作完整通勤。 */
export function remoteHarvesterPreSpawnThreshold(
  spawn: StructureSpawn, configName: string, config: CreepConfig, body: BodyPartConstant[],
): number | undefined {
  if (config.role !== "colonizerHarvester") return undefined;
  const [home, kind, target, role, sourceId] = configName.split(":");
  const task = Memory.data?.remoteMining?.[target];
  if (kind !== "remoteMine" || role !== "harvester" || home !== spawn.room.name ||
      task?.sourceRoom !== home || task.status !== "active" || !task.sourceIds.includes(sourceId) ||
      config.args[0] !== target || config.args[1] !== sourceId) return undefined;

  const source = Game.getObjectById<Source>(sourceId as Id<Source>);
  const saved = task.containerPositions?.[sourceId];
  const goal = source?.pos ?? (saved?.roomName === target
    ? new RoomPosition(saved.x, saved.y, saved.roomName) : new RoomPosition(25, 25, target));
  const moveParts = body.filter(part => part === MOVE).length;
  const weight = body.filter(part => part !== MOVE && part !== CARRY).length;
  const stepTicks = (cost: number): number => Math.max(1, Math.ceil(weight * cost / Math.max(1, moveParts * 2)));
  // v2 隔离旧版只测到出口的短缓存；按真实 Spawn 起点和身体区分。
  const key = `remote-v2:${home}:${spawn.pos.x}:${spawn.pos.y}:${target}:${goal.x}:${goal.y}:${weight}:${moveParts}`;
  const runtime = getMemoryService().ensureRuntime();
  const cache = (runtime.spawnPlanner ??= { sourceWorkerCommutes: {} }).sourceWorkerCommutes;
  const previous = cache[key];
  let commute = previous && Game.time - previous.updatedAt <= CACHE_TTL ? previous.commute : undefined;
  if (commute === undefined) {
    // 搜索耗尽或缺少矿点位置时仍保留通勤预算，不退化成死后补员。
    commute = Math.max(150, task.roadPlan?.positions.length ?? 0) * stepTicks(2);
    if (searchTick !== Game.time) { searchTick = Game.time; searches = 0; }
    if ((source || saved) && searches < 1) {
      searches += 1;
      const matrices = new Map<string, CostMatrix>();
      const result = PathFinder.search(spawn.pos, { pos: goal, range: source ? 1 : 0 }, {
        plainCost: 2, swampCost: 10, maxRooms: 2, maxOps: 2000,
        roomCallback: roomName => {
          if (roomName !== home && roomName !== target) return false;
          const matrix = getRoomStaticMatrix(roomName);
          matrices.set(roomName, matrix);
          return matrix;
        },
      });
      if (!result.incomplete && result.path.length > 0) {
        commute = result.path.reduce((sum, pos) => {
          const road = matrices.get(pos.roomName)?.get(pos.x, pos.y) === 1;
          const swamp = (Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) & TERRAIN_MASK_SWAMP) !== 0;
          return sum + stepTicks(road ? 1 : swamp ? 10 : 2);
        }, 0);
      }
      cache[key] = { commute, updatedAt: Game.time };
    }
  }
  return commute + body.length * CREEP_SPAWN_TIME + QUEUE_BUFFER;
}
