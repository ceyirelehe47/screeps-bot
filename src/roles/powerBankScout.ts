import type { RoleFactory } from "@/types/system";
import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { getPowerBankSearchCandidates, getPowerBankSearchRooms } from "@/runtime/powerBankSearch";
import { getPowerBankRoomStatus } from "@/runtime/powerBankMapFacts";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { moveToTargetRoom } from "@/roles/shared";

const TRANSIT_DANGER_TTL = 500;

interface PatrolMemory {
  patrolIndex?: number;
  patrolDirection?: 1 | -1;
  originRoomName?: string;
  catalogVersion?: 1;
  catalogKey?: string;
  targetRoomName?: string;
  targetScope?: "sources" | "origin";
}

function ensurePatrolMemory(creep: Creep): PatrolMemory {
  if (!creep.memory._patrol) {
    creep.memory._patrol = {};
  }
  return creep.memory._patrol as PatrolMemory;
}

function getCurrentPatrolTarget(patrol: PatrolMemory, rooms: readonly string[]): string {
  const index = Number.isSafeInteger(patrol.patrolIndex) ? patrol.patrolIndex! : 0;
  return rooms[((index % rooms.length) + rooms.length) % rooms.length];
}

function advancePatrol(patrol: PatrolMemory, rooms: readonly string[]): void {
  const length = rooms.length;
  if (length <= 1) return;

  const rawIndex = Number.isSafeInteger(patrol.patrolIndex) ? patrol.patrolIndex! : 0;
  const current = ((rawIndex % length) + length) % length;
  const direction = patrol.patrolDirection === -1 ? -1 : 1;
  const lastIndex = length - 1;

  if (current === lastIndex) {
    patrol.patrolIndex = lastIndex - 1;
    patrol.patrolDirection = -1;
    return;
  }

  if (current === 0 && direction === -1) {
    patrol.patrolIndex = 1;
    patrol.patrolDirection = 1;
    return;
  }

  patrol.patrolIndex = current + direction;
  patrol.patrolDirection = direction;
}

function createRoomStatusCheck(checked: Map<string, boolean>): (roomName: string) => boolean {
  // 往返可能经过同一房两次；异常也只在本次选房中读取一次，不跨 tick 缓存许可。
  return (roomName) => {
    const cached = checked.get(roomName);
    if (cached !== undefined) return cached;
    let open = false;
    try {
      if (typeof Game.map.getRoomStatus !== "function") open = true;
      else {
        const status = getPowerBankRoomStatus(roomName);
        open = status !== null && status.status !== "closed";
      }
    } catch {
      // 保持完整目录对 closed、缺失状态和原生查询异常的 fail-closed 语义。
    }
    checked.set(roomName, open);
    return open;
  };
}

function selectPatrolTarget(
  patrol: PatrolMemory,
  rooms: readonly string[],
  danger: ReadonlySet<string>,
  isOpen: (roomName: string) => boolean,
  currentRoom: string,
): { target?: string; anyOpen: boolean } {
  let anyOpen = false;
  // 从中间向一端开始时，需要完整往返周期才能覆盖另一端，不能只走 rooms.length 步。
  const steps = rooms.length <= 1 ? rooms.length : 2 * (rooms.length - 1);
  for (let step = 0; step < steps; step += 1) {
    const roomName = getCurrentPatrolTarget(patrol, rooms);
    if (!danger.has(roomName) && isOpen(roomName)) {
      anyOpen = true;
      if (roomName !== currentRoom) return { target: roomName, anyOpen };
    }
    advancePatrol(patrol, rooms);
  }
  return { anyOpen };
}

function scanRoomForPowerBanks(creep: Creep): void {
  if (!isPowerBankSearchRoom(creep.room.name)) {
    return;
  }

  const banks = creep.room.find(FIND_STRUCTURES).filter(
    (s): s is StructurePowerBank => s.structureType === STRUCTURE_POWER_BANK,
  );

  for (const bank of banks) {
    recordPowerBankDiscovery(bank);
  }
}

function hasHostileCombatPresence(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  for (const h of hostiles) {
    if (
      h.getActiveBodyparts(ATTACK) > 0 ||
      h.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      h.getActiveBodyparts(HEAL) > 0
    ) {
      return true;
    }
  }
  if (room.find(FIND_HOSTILE_POWER_CREEPS).length > 0) {
    return true;
  }
  return false;
}

function hasHostileController(room: Room): boolean {
  if (room.controller?.owner && !room.controller.my) {
    return true;
  }
  if (room.controller?.reservation && !room.controller.my) {
    const myUser =
      Object.values(Game.spawns)[0]?.owner.username ||
      Object.values(Game.creeps)[0]?.owner.username;
    if (!myUser || room.controller.reservation.username !== myUser) {
      return true;
    }
  }
  return false;
}

function markTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.transitDangerRooms) Memory.runtime.transitDangerRooms = {};
  Memory.runtime.transitDangerRooms[roomName] = Game.time + TRANSIT_DANGER_TTL;
}

function markPermanentTransitDanger(roomName: string): void {
  if (!Memory.runtime) Memory.runtime = {};
  if (!Memory.runtime.powerBankPermanentDangerRooms) Memory.runtime.powerBankPermanentDangerRooms = {};
  Memory.runtime.powerBankPermanentDangerRooms[roomName] = true;
}

export function getActiveTransitDangerRooms(): string[] {
  const runtime = Memory.runtime;
  if (!runtime) return [];

  const now = Game.time;
  const active = new Set<string>();
  const permanent = runtime.powerBankPermanentDangerRooms;
  if (permanent) {
    for (const room of Object.keys(permanent)) {
      active.add(room);
    }
  }

  const temporary = runtime.transitDangerRooms;
  if (temporary) {
    for (const [room, expiresAt] of Object.entries(temporary)) {
      if (expiresAt <= now) {
        delete temporary[room];
        continue;
      }
      active.add(room);
    }
  }

  return [...active];
}

function checkAndMarkTransitDanger(creep: Creep): void {
  const roomName = creep.room.name;
  const lastHits = creep.memory._lastHits;
  const currentHits = creep.hits;
  creep.memory._lastHits = currentHits;

  const damaged = lastHits !== undefined && currentHits < lastHits;
  if (hasHostileController(creep.room)) {
    markPermanentTransitDanger(roomName);
  }
  if (damaged || hasHostileCombatPresence(creep.room)) {
    markTransitDanger(roomName);
  }
}

export const powerBankScoutRole: RoleFactory = () => ({
  source: (creep: Creep): boolean => {
    const patrol = ensurePatrolMemory(creep);
    const migrateLegacyPatrol = patrol.catalogVersion !== 1 &&
      (patrol.patrolIndex !== undefined || patrol.patrolDirection !== undefined || patrol.originRoomName !== undefined);
    const configName = creep.memory.configName;
    const configuredOrigin = configName ? Memory.data?.creepConfigs?.[configName]?.roomName : undefined;
    const origin = configuredOrigin || patrol.originRoomName || creep.room.name;
    if (patrol.originRoomName !== origin) {
      patrol.originRoomName = origin;
      patrol.patrolIndex = 0;
      patrol.patrolDirection = 1;
      delete patrol.targetRoomName;
      delete patrol.targetScope;
    }

    checkAndMarkTransitDanger(creep);
    scanRoomForPowerBanks(creep);

    const avoidRooms = getActiveTransitDangerRooms();
    const danger = new Set(avoidRooms);
    // 输入每 tick 仍 fresh；跨 tick 复用的只有纯几何目录与目标身份，不缓存开放许可。
    const sourceRooms = getPowerBankSearchCandidates();
    const originRooms = getPowerBankSearchCandidates(origin);
    const catalogKey = JSON.stringify([origin, sourceRooms, originRooms]);
    const catalogChanged = patrol.catalogKey !== undefined && patrol.catalogKey !== catalogKey;
    patrol.catalogKey = catalogKey;
    const checked = new Map<string, boolean>();
    const isOpen = createRoomStatusCheck(checked);

    if (migrateLegacyPatrol) {
      // 旧 index 属于“开放且非危险”列表，不能当成几何 index。仅升级这一帧读取完整目录。
      const freshSources = getPowerBankSearchRooms();
      const freshSourceSet = new Set(freshSources);
      for (const roomName of sourceRooms) checked.set(roomName, freshSourceSet.has(roomName));
      const scope = freshSources.length > 0 ? "sources" : "origin";
      const legacyRooms = (scope === "sources" ? freshSources : originRooms.filter(isOpen))
        .filter((roomName) => !danger.has(roomName));
      patrol.catalogVersion = 1;
      if (legacyRooms.length === 0) return false;
      patrol.targetRoomName = getCurrentPatrolTarget(patrol, legacyRooms);
      patrol.targetScope = scope;
    }
    patrol.catalogVersion = 1;

    let target = patrol.targetRoomName;
    let scope = patrol.targetScope ?? "sources";
    let rooms = scope === "sources" ? sourceRooms : originRooms;
    // 原点回退只在本轮来源不变时延续；真实来源或世界边界变化后重新优先检查来源并集。
    if (scope === "origin" && catalogChanged) target = undefined;
    const targetIndex = target === undefined ? -1 : rooms.indexOf(target);
    if (targetIndex >= 0) patrol.patrolIndex = targetIndex;
    if (target !== undefined && targetIndex >= 0 && !danger.has(target) && isOpen(target) && creep.room.name !== target) {
      moveToTargetRoom(creep, target, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
      return false;
    }

    const previousTarget = target;
    const previousScope = scope;
    const setCursor = (nextScope: "sources" | "origin", nextRooms: readonly string[]) => {
      scope = nextScope;
      rooms = nextRooms;
      const previousIndex = previousScope === scope && previousTarget !== undefined ? rooms.indexOf(previousTarget) : -1;
      patrol.patrolIndex = previousIndex >= 0 ? previousIndex : 0;
      if (previousIndex < 0) patrol.patrolDirection = 1;
      if (previousTarget === creep.room.name && previousIndex >= 0) advancePatrol(patrol, rooms);
    };
    setCursor("sources", sourceRooms);
    let selection = selectPatrolTarget(patrol, rooms, danger, isOpen, creep.room.name);
    // 旧逻辑先判来源开放，再过滤危险房。存在开放但危险的来源房时仍 hold，不借原点绕开危险。
    const hasOpenSource = selection.anyOpen || (selection.target === undefined && sourceRooms.some(isOpen));
    if (!selection.target && !hasOpenSource) {
      setCursor("origin", originRooms);
      selection = selectPatrolTarget(patrol, rooms, danger, isOpen, creep.room.name);
    }

    target = selection.target;
    if (!target) {
      // 只剩当前开放房时保留身份，下次抵达选房仍可发现新开放候选；全关闭则无任务等待。
      target = selection.anyOpen && rooms.includes(creep.room.name) && !danger.has(creep.room.name)
        ? creep.room.name : undefined;
    }
    patrol.targetRoomName = target;
    patrol.targetScope = scope;
    if (!target || target === creep.room.name) return false;

    moveToTargetRoom(creep, target, undefined, { plainCost: 1, swampCost: 1, reusePath: 5, avoidRooms });
    return false;
  },
  target: (): boolean => false,
});
