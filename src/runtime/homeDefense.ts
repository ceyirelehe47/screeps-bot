import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import { clearBoostLabTasks } from "@/runtime/boostControl";
import { canTowersHandleHostiles } from "@/runtime/towerControl";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { assignDefenderSlot, clearDefenseCoordination, getRoomDefenseCoordination, setDefenderRole, writeDefenseFronts } from "@/runtime/defenseCoordination";
import { buildDefenseFronts } from "@/runtime/defenseFronts";
import { buildFocusFireRoomInput, planRoomEngagement, writeRoomEngagementPlan, clearRoomEngagementPlan } from "@/runtime/defenseFocusFire";
import { getBoundaryRamparts } from "@/runtime/safeZoneHelpers";

const DEFAULT_MAX_DEFENDERS = 3;

function getConfigName(roomName: string, index: number): string {
  return `${roomName}:homeDefense:defender:${index}`;
}

function getSpawnsForRoom(roomName: string): StructureSpawn[] {
  return getTickContextService().getSpawnsByRoom(roomName);
}

function isConfigQueuedInSpawns(spawns: StructureSpawn[], configName: string): boolean {
  return spawns.some((spawn) => spawn.memory.spawnList?.includes(configName) ?? false);
}

function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  return [...spawns].sort((left, right) => {
    const loadDiff = getSpawnQueueLoad(left) - getSpawnQueueLoad(right);
    if (loadDiff !== 0) return loadDiff;
    return left.name.localeCompare(right.name);
  })[0];
}

function isLiveOrSpawning(configName: string): boolean {
  const tickContext = getTickContextService();
  if (tickContext.getCreepsByConfigName(configName).length > 0) return true;

  for (const room of tickContext.getMyRooms()) {
    for (const spawn of tickContext.getSpawnsByRoom(room.name)) {
      if (spawn.spawning && Memory.creeps[spawn.spawning.name]?.configName === configName) {
        return true;
      }
    }
  }

  return false;
}

function getMaxDefenders(): number {
  const configured = Memory.cfg?.homeDefense?.maxDefenders;
  return typeof configured === "number" && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_DEFENDERS;
}

function calcDesiredDefenderCount(room: Room, hostiles: Creep[], frontCount: number): number {
  if (hostiles.length === 0 || frontCount === 0) {
    return 0;
  }

  if (frontCount === 1) {
    const towersHandleAll = canTowersHandleHostiles(room, hostiles);
    return towersHandleAll ? 0 : Math.min(getMaxDefenders(), Math.max(1, Math.ceil(hostiles.length / 2)));
  }

  return Math.min(getMaxDefenders(), frontCount);
}

function ensureDefenders(room: Room, desiredCount: number): void {
  const configStore = getMemoryService().getCreepConfigStore();
  const spawns = getSpawnsForRoom(room.name);
  if (spawns.length === 0) return;

  for (let i = 0; i < desiredCount; i++) {
    const configName = getConfigName(room.name, i);
    configStore[configName] = {
      role: "homeDefender",
      args: [room.name, String(i)],
      roomName: room.name,
    };

    if (!isLiveOrSpawning(configName)) {
      const queued = isConfigQueuedInSpawns(spawns, configName);
      if (!queued) {
        const targetSpawn = selectLeastLoadedSpawn(spawns);
        if (targetSpawn) targetSpawn.addTask(configName);
      }
    }
  }
}

function removeDefendersAbove(roomName: string, startIndex: number): void {
  const configStore = getCreepConfigService();
  const spawns = getTickContextService().getSpawnsByRoom(roomName);

  for (let i = startIndex; i < getMaxDefenders(); i++) {
    const configName = getConfigName(roomName, i);
    configStore.remove(configName);

    for (const spawn of spawns) {
      if (spawn.memory.spawnList) {
        spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
      }
    }
  }
}

function stopQueuedDefenderSpawning(roomName: string, desiredCount: number): void {
  const configStore = getCreepConfigService();
  const spawns = getTickContextService().getSpawnsByRoom(roomName);

  for (let i = desiredCount; i < getMaxDefenders(); i++) {
    const configName = getConfigName(roomName, i);

    for (const spawn of spawns) {
      if (spawn.memory.spawnList) {
        spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
      }
    }

    if (!isLiveOrSpawning(configName)) {
      configStore.remove(configName);
    }
  }
}

function syncDefenderAssignments(roomName: string, desiredCount: number, frontCount: number): void {
  const slotsByFront = new Map<string, string[]>();

  for (let i = 0; i < getMaxDefenders(); i++) {
    const slot = String(i);
    const assignedFrontId = i < desiredCount && frontCount > 0 ? `front:${i % frontCount}` : undefined;
    assignDefenderSlot(roomName, slot, assignedFrontId);

    if (!assignedFrontId) {
      setDefenderRole(roomName, slot, undefined);
      continue;
    }

    const slots = slotsByFront.get(assignedFrontId) || [];
    slots.push(slot);
    slotsByFront.set(assignedFrontId, slots);
  }

  for (const slots of slotsByFront.values()) {
    setDefenderRole(roomName, slots[0], "primary");
    for (let i = 1; i < slots.length; i++) {
      setDefenderRole(roomName, slots[i], "secondary");
    }
  }
}

/**
 * 【Defense Focus-Fire Sidecar】每房间每 tick 一次快照 + 一次评分，生成
 * 唯一 engagement plan（Tower 与主防 Creep 共享的联合伤害预算/分火/紧急
 * 治疗仲裁目标分配）。planner 为纯函数；本处只负责快照采集与持久化。
 * 【Remediation III 十六】combat target 与 engagement position 分离：敌在
 * 安全区内=直接接敌；敌在边界外=最近合法 boundary rampart（复用既有
 * safeZoneHelpers 防线系统——planner 不建立平行站位模型）。
 * 【Remediation IV 十三/十五】采集 front eligibility（assigned front 的
 * hostile 集合预计算）与 per-defender 唯一 Rampart 分配的候选集合
 * （boundary ramparts + 他属占用标记——Defender 默认只处理本 front）。
 */
function planRoomFocusFire(room: Room, hostiles: Creep[], fronts: { id: string; hostileIds: string[] }[]): void {
  if (hostiles.length === 0 || fronts.length === 0) {
    return;
  }
  const coordination = getRoomDefenseCoordination(room.name);
  const slotsByCreepName: Record<string, string> = {};
  const rolesBySlot: Record<string, "primary" | "secondary"> = {};
  if (coordination?.defenderRoles) {
    for (const [slot, role] of Object.entries(coordination.defenderRoles)) {
      rolesBySlot[slot] = role;
    }
  }
  const defenders = room.find(FIND_MY_CREEPS, { filter: (creep) => creep.memory.role === "homeDefender" });
  for (const defender of defenders) {
    // 【Remediation V 十一】canonical slot 单一来源：spawn config 的最后段
    //（与 defenseCoordination 的 String(i) / RoleFactory 注入的 args[1] 同源）。
    // configName 缺失（Memory.creeps 残缺——异常）时不再以 creep name 回落
    //（planner 键与消费 slot 不一致会形成 fresh plan 有 entry 而消费方查
    // 不到的错配——该 defender 不入 plan，消费侧按"fresh plan 缺 assignment
    // 默认 hold"处理）。
    const configName = Memory.creeps[defender.name]?.configName ?? "";
    const slotFromConfig = configName.split(":").pop() ?? "";
    if (slotFromConfig.length > 0) {
      slotsByCreepName[defender.name] = slotFromConfig;
    }
  }
  const plannedDefenders = defenders.filter((defender) => slotsByCreepName[defender.name] !== undefined);
  const wounded = (getTickContextService().getRoomContext(room)?.getMyCreeps() || []).filter(
    (creep) => creep.hits < creep.hitsMax,
  );
  // 【Remediation IV 十三】Defender front eligibility：assigned front 的
  // hostile 集合（预计算——planner / fallback revision 内层 O(1) 判定）。
  const roomHostileIds = hostiles.map((hostile) => hostile.id as string);
  const defenderFronts: Record<string, { frontId?: string; eligibleHostileIds: Set<string> }> = {};
  if (coordination?.defenderAssignments) {
    for (const [slot, frontId] of Object.entries(coordination.defenderAssignments)) {
      const front = fronts.find((candidate) => candidate.id === frontId);
      if (front) {
        defenderFronts[slot] = { frontId, eligibleHostileIds: new Set(front.hostileIds) };
      }
    }
  }
  // 【Remediation IV 十七】接敌位置采集（既有防线系统单一权威）。
  const safeZone = getSafeZone(room.name);
  const hostileEngagements: Record<string, { x: number; y: number; kind: "inside" | "boundary" }> = {};
  const hostileEngagementCandidates: Record<string, { id: string; x: number; y: number; occupied?: boolean }[]> = {};
  if (safeZone.size > 0) {
    const boundaryRamparts = getBoundaryRamparts(room, safeZone);
    // 他属占用检测（其它 my creep 脚下的 rampart——采集一次共享）。
    const occupiedRampartKeys = new Set<string>();
    for (const creep of room.find(FIND_MY_CREEPS)) {
      if (creep.memory.role === "homeDefender") continue;
      for (const structure of creep.pos.lookFor(LOOK_STRUCTURES)) {
        if (structure.structureType === STRUCTURE_RAMPART && (structure as StructureRampart).my) {
          occupiedRampartKeys.add(`${structure.pos.x},${structure.pos.y}`);
        }
      }
    }
    const candidates = boundaryRamparts
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((rampart) => ({
        id: rampart.id,
        x: rampart.pos.x,
        y: rampart.pos.y,
        ...(occupiedRampartKeys.has(`${rampart.pos.x},${rampart.pos.y}`) ? { occupied: true } : {}),
      }));
    for (const hostile of hostiles) {
      if (safeZone.has(hostile.pos.x * 50 + hostile.pos.y)) {
        hostileEngagements[hostile.id] = { x: hostile.pos.x, y: hostile.pos.y, kind: "inside" };
        continue;
      }
      // 最近合法 boundary rampart（chebyshev 最近；平手按 id 稳定决胜）。
      let nearest: StructureRampart | null = null;
      let nearestRange = Infinity;
      for (const rampart of boundaryRamparts) {
        const range = Math.max(Math.abs(rampart.pos.x - hostile.pos.x), Math.abs(rampart.pos.y - hostile.pos.y));
        if (range < nearestRange || (range === nearestRange && nearest !== null && rampart.id < nearest.id)) {
          nearest = rampart;
          nearestRange = range;
        }
      }
      if (nearest) {
        hostileEngagements[hostile.id] = { x: nearest.pos.x, y: nearest.pos.y, kind: "boundary" };
        // 【Remediation IV 十五】per-defender 唯一分配的候选集合（全部
        // boundary ramparts——按目标距离稳定排序，occupied 标记由采集层
        // 一次给出；planner 的 allocate 保证每候选至多一 Defender）。
        hostileEngagementCandidates[hostile.id] = candidates
          .slice()
          .sort(
            (left, right) =>
              Math.max(Math.abs(left.x - hostile.pos.x), Math.abs(left.y - hostile.pos.y)) -
                Math.max(Math.abs(right.x - hostile.pos.x), Math.abs(right.y - hostile.pos.y)) ||
              left.id.localeCompare(right.id),
          );
      }
    }
  }
  const input = buildFocusFireRoomInput({
    roomName: room.name,
    hostiles,
    towers: getTickContextService().getRoomContext(room)?.getTowers() || [],
    defenders: plannedDefenders,
    defenderSlots: slotsByCreepName,
    defenderRoles: rolesBySlot,
    wounded,
    hostileEngagements,
    ...(Object.keys(hostileEngagementCandidates).length > 0 ? { hostileEngagementCandidates } : {}),
    ...(Object.keys(defenderFronts).length > 0 ? { defenderFronts } : {}),
  });
  writeRoomEngagementPlan(planRoomEngagement(input, Game.time));
}

export function runHomeDefense(): void {
  const tickContext = getTickContextService();

  for (const room of tickContext.getMyRooms()) {
    const safeZone = getSafeZone(room.name);
    if (safeZone.size === 0) {
      clearDefenseCoordination(room.name);
      continue;
    }

    const playerHostiles = getPlayerHostiles(room);
    const fronts = buildDefenseFronts(playerHostiles);
    if (playerHostiles.length > 0) {
      writeDefenseFronts(room.name, fronts);
      const desiredCount = calcDesiredDefenderCount(room, playerHostiles, fronts.length);
      syncDefenderAssignments(room.name, desiredCount, fronts.length);

      if (desiredCount === 0) {
        stopQueuedDefenderSpawning(room.name, 0);
        clearBoostLabTasks(room.name);
      } else {
        ensureDefenders(room, desiredCount);
        stopQueuedDefenderSpawning(room.name, desiredCount);
        clearBoostLabTasks(room.name);
      }
      planRoomFocusFire(room, playerHostiles, fronts);
    } else {
      removeDefendersAbove(room.name, 0);
      clearDefenseCoordination(room.name);
      clearRoomEngagementPlan(room.name);
      clearBoostLabTasks(room.name);
    }
  }
}
