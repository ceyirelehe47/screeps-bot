/** 单房 A* 夹具：遵守地形、矩阵、目标 range 和 maxOps；不模拟跨房搜索或引擎 CPU 成本。 */
export function searchSingleRoom(
  origin: RoomPosition,
  input: Parameters<PathFinder["search"]>[1],
  options: PathFinderOpts = {},
): PathFinderPath {
  const goals = (Array.isArray(input) ? input : [input]).map(goal => "pos" in goal ? goal : { pos: goal, range: 0 });
  const resolvedMatrix = options.roomCallback?.(origin.roomName);
  if (resolvedMatrix === false || !goals.length) return { path: [], ops: 0, cost: 0, incomplete: true };
  const matrix = resolvedMatrix === true ? undefined : resolvedMatrix;
  const terrain = Game.map.getRoomTerrain(origin.roomName);
  const plain = options.plainCost ?? 1, swamp = options.swampCost ?? 5;
  const distance = (x: number, y: number) => Math.min(...goals.map(goal =>
    Math.max(0, Math.max(Math.abs(x - goal.pos.x), Math.abs(y - goal.pos.y)) - goal.range)));
  const anchor = goals.reduce((best, goal) =>
    Math.abs(origin.x - goal.pos.x) + Math.abs(origin.y - goal.pos.y) <
    Math.abs(origin.x - best.pos.x) + Math.abs(origin.y - best.pos.y) ? goal : best);
  const tieDistance = (x: number, y: number) => Math.abs(x - anchor.pos.x) + Math.abs(y - anchor.pos.y);
  type Node = { key: number; cost: number; h: number; tie: number; f: number };
  const heap: Node[] = [];
  const less = (a: Node, b: Node) => a.f < b.f || a.f === b.f && (a.h < b.h || a.h === b.h && a.tie < b.tie);
  const push = (node: Node) => {
    let index = heap.length; heap.push(node);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!less(node, heap[parent])) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = node;
  };
  const pop = (): Node => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], last)) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  const costs = new Float64Array(2500).fill(Infinity), previous = new Int32Array(2500).fill(-1);
  const closed = new Uint8Array(2500);
  const start = origin.y * 50 + origin.x;
  costs[start] = 0;
  const initialH = distance(origin.x, origin.y);
  push({ key: start, cost: 0, h: initialH, tie: tieDistance(origin.x, origin.y), f: initialH });
  let best = start, bestH = initialH, ops = 0, complete = false;
  while (heap.length && ops < (options.maxOps ?? 2000)) {
    const node = pop();
    if (closed[node.key]) continue;
    closed[node.key] = 1; ops++;
    const x = node.key % 50, y = Math.floor(node.key / 50);
    if (node.h < bestH) { best = node.key; bestH = node.h; }
    if (node.h === 0) { best = node.key; complete = true; break; }
    for (const [dx, dy] of [[1, 0], [0, -1], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, -1], [-1, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      const ground = terrain.get(nx, ny), custom = matrix?.get(nx, ny) ?? 0;
      if (ground & TERRAIN_MASK_WALL || custom >= 255) continue;
      const key = ny * 50 + nx, cost = node.cost + (custom || (ground & TERRAIN_MASK_SWAMP ? swamp : plain));
      if (cost >= costs[key] || cost > (options.maxCost ?? Infinity)) continue;
      costs[key] = cost; previous[key] = node.key;
      const h = distance(nx, ny);
      push({ key, cost, h, tie: tieDistance(nx, ny), f: cost + h });
    }
  }
  const path: RoomPosition[] = [];
  for (let cursor = best; cursor !== start && cursor !== -1; cursor = previous[cursor]) {
    path.push(new RoomPosition(cursor % 50, Math.floor(cursor / 50), origin.roomName));
  }
  path.reverse();
  return { path, incomplete: !complete, ops, cost: costs[best] };
}

/** findPathTo 与 PathFinder 夹具共用 A*，仅转换调用形状与返回的方向字段。 */
export function findSingleRoomPath(origin: RoomPosition, target: RoomPosition | { pos: RoomPosition }, options: FindPathOpts = {}): PathStep[] {
  const pos = "pos" in target ? target.pos : target;
  const result = searchSingleRoom(origin, { pos, range: options.range ?? 0 }, {
    maxOps: options.maxOps, maxRooms: options.maxRooms, plainCost: options.plainCost, swampCost: options.swampCost,
    roomCallback: name => { const matrix = new PathFinder.CostMatrix(); return options.costCallback?.(name, matrix) || matrix; },
  });
  let previous = origin;
  return result.path.map(step => {
    const dx = step.x - previous.x, dy = step.y - previous.y;
    const direction = previous.getDirectionTo(step);
    previous = step;
    return { x: step.x, y: step.y, dx, dy, direction };
  });
}
