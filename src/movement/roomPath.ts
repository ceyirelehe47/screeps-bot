import { applyMovementCreepObstacles, getRoomStaticMatrix } from "@/movement/pathing";
import { searchMovementPath, searchPlanningPath } from "@/movement/pathSearch";

/** 距离估计与特殊单位同样使用统一内核，避免原生 findPathTo 绕过 ops 账本。 */
export function searchRoomPath(origin: RoomPosition, target: RoomPosition, options: Omit<PathFinderOpts, "roomCallback"> & { range?: number; mover?: AnyCreep } = {},
  purpose: "planning" | "execution" = "planning") {
  const { range = 0, mover, ...searchOptions } = options;
  const search = purpose === "planning" ? searchPlanningPath : searchMovementPath;
  return search(origin, { pos: target, range }, {
    maxRooms: 1, maxOps: 2000, plainCost: 2, swampCost: 10, ...searchOptions,
    roomCallback: name => {
      if ((searchOptions.maxRooms ?? 1) === 1 && name !== origin.roomName) return false;
      const matrix = getRoomStaticMatrix(name);
      return mover ? applyMovementCreepObstacles(matrix, mover, name) : matrix;
    },
  });
}
