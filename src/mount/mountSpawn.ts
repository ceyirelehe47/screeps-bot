import { readSpawnQueue, requestSpawn, consumeSpawnRequest, recordAcceptedSpawn, hasSpawnAcceptedIntent, rejectSpawnRequest } from "@/runtime/spawnRequests";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { fixedBodyExceedsCapacity, getSpawnAdmission } from "@/runtime/outboundMissionPolicy";
import { readSpawnExitDirections } from "@/config/deployment";
import { issueMove } from "@/movement/traffic";
import { isSpawnActive } from "@/runtime/tickContext";
import { getHarvesterBody, spawnProfiles } from "@/config/spawnProfiles";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { isRcl8MaintenanceUpgraderConfig } from "@/runtime/upgraderPolicy";
import { type CreepConfig, type RoleName } from "@/types/system";
import { canExecuteSpawnRequest, notifySpawnRequestAccepted } from "@/runtime/spawnRequestOwners";

let spawnNameGame: typeof Game | undefined;
let spawnNameTick = -1;
let reservedSpawnNames = new Set<string>();

function chooseCreepName(spawn: StructureSpawn, config: CreepConfig): string {
  if (config.name) return config.name;
  if (spawnNameGame !== Game || spawnNameTick !== Game.time) {
    spawnNameGame = Game; spawnNameTick = Game.time; reservedSpawnNames = new Set();
  }
  const base = `${getCreepNamePrefix(config.role)}-${Game.time}`;
  const occupied = (name: string) => reservedSpawnNames.has(name) || !!Game.creeps[name] ||
    Object.values(Game.spawns).some(other => other.spawning?.name === name);
  let name = base;
  if (occupied(name)) name = `${base}-${spawn.name}`;
  let suffix = 1;
  while (occupied(name)) name = `${base}-${spawn.name}-${suffix++}`;
  reservedSpawnNames.add(name);
  return name;
}

function isTransientConfigName(configName: string): boolean {
  return configName.includes(":manual:") || configName.includes(":emergency:");
}

function chooseBody(spawn: StructureSpawn, configName: string): BodyPartConstant[] {
  const config = getCreepConfigService().get(configName);
  if (config?.body && config.body.length > 0) {
    return [...config.body];
  }

  if (!config) {
    return [WORK, CARRY, MOVE];
  }

  if (config.role === "harvester") {
    return getHarvesterBody(spawn.room);
  }

  return spawnProfiles[config.role](spawn.room);
}

function getCreepNamePrefix(role: RoleName): string {
  if (role === "worker") {
    return "worker";
  }

  return role;
}

function getSpawnExitDirections(spawn: StructureSpawn): DirectionConstant[] | undefined {
  return readSpawnExitDirections(spawn.room.name, spawn.name);
}

const EXIT_DIRECTION_DELTAS: Readonly<Record<DirectionConstant, readonly [number, number]>> = {
  [TOP]: [0, -1],
  [TOP_RIGHT]: [1, -1],
  [RIGHT]: [1, 0],
  [BOTTOM_RIGHT]: [1, 1],
  [BOTTOM]: [0, 1],
  [BOTTOM_LEFT]: [-1, 1],
  [LEFT]: [-1, 0],
  [TOP_LEFT]: [-1, -1],
};

const DEFAULT_EXIT_DIRECTIONS: readonly DirectionConstant[] = [
  TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT,
];

function isClearExitTile(room: Room, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 49 || y < 0 || y > 49) {
    return false;
  }
  const pos = room.getPositionAt(x, y);
  if (!pos || pos.lookFor(LOOK_TERRAIN)[0] === "wall") {
    return false;
  }
  if (pos.lookFor(LOOK_STRUCTURES).some((structure) =>
    (OBSTACLE_OBJECT_TYPES as readonly string[]).includes(structure.structureType)
  )) {
    return false;
  }
  if (pos.lookFor(LOOK_CONSTRUCTION_SITES).some((site) =>
    !(OBSTACLE_OBJECT_TYPES as readonly string[]).includes(site.structureType) === false
  )) {
    return false;
  }
  if (pos.lookFor(LOOK_CREEPS).length > 0 || pos.lookFor(LOOK_POWER_CREEPS).length > 0) {
    return false;
  }
  return true;
}

function getSpawnBirthPositions(spawn: StructureSpawn): RoomPosition[] {
  // 配置更新只影响后续孵化；已在孵化的 creep 以引擎保存的出口为准。
  const nativeExits = spawn.spawning?.directions;
  const exits = Array.isArray(nativeExits) ? nativeExits : getSpawnExitDirections(spawn);
  if (!exits || exits.length === 0) {
    // 无 directions 约束时新生儿由引擎放置在 spawn 相邻的可用格
    // （spawn 自身格不可落 creep），出生位集合取全部 8 邻格；挡位
    // creep 只会出现在可走格上，无需在此预过滤地形。
    const positions: RoomPosition[] = [];
    for (const [dx, dy] of BIRTH_TILE_DELTAS) {
      const pos = spawn.room.getPositionAt(spawn.pos.x + dx, spawn.pos.y + dy);
      if (pos) {
        positions.push(pos);
      }
    }
    return positions;
  }
  const positions: RoomPosition[] = [];
  for (const direction of exits) {
    const [dx, dy] = EXIT_DIRECTION_DELTAS[direction];
    const pos = spawn.room.getPositionAt(spawn.pos.x + dx, spawn.pos.y + dy);
    if (pos) {
      positions.push(pos);
    }
  }
  return positions;
}

const BIRTH_TILE_DELTAS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/**
 * 出生位被已出生 creep / PowerCreep 占据会让 Spawning 冻结到移开为止。
 * PowerCreep 不在 LOOK_CREEPS 里，但同样占据出生格——现场证据（W1N57
 * Spawn6 冻结 2.4 天）表明 operator 站在唯一可用出生格时孵化永久冻结，
 * 因此两类挡位者都必须处理。指令经 memory 传递并在各自 work 入口优先
 * 消费——普通 creep 的逻辑后于 spawn.work 执行，直接 move() 会被挡位者
 * 随后执行的自身移动逻辑覆盖；powerCreepControl 虽先于 spawnWork 执行
 * （指令滞后一 tick 消费，TTL 2 覆盖），但 spawn 侧直接 move 后于其任务
 * 逻辑、同 tick 生效。同时保留一次直接 move，覆盖停摆（无逻辑）挡位者
 * 的场景。remainingTime 理论上恒为 number；极端 undefined 时下方比较为
 * false（不触发），退化为冻结等待，失败方向安全。
 */
function directBlockingCreepsOffSpawn(spawn: StructureSpawn): void {
  const birthPositions = getSpawnBirthPositions(spawn);
  const blockers: Array<Creep | PowerCreep> = birthPositions.flatMap((pos) => [
    ...pos.lookFor(LOOK_CREEPS),
    ...pos.lookFor(LOOK_POWER_CREEPS),
  ]);
  if (blockers.length === 0) {
    return;
  }
  const birthKeys = new Set(birthPositions.map((pos) => `${pos.x}:${pos.y}`));
  for (const blocker of blockers) {
    if (!blocker.my) continue;
    const exit = DEFAULT_EXIT_DIRECTIONS.find((direction) => {
      const [dx, dy] = EXIT_DIRECTION_DELTAS[direction];
      const x = blocker.pos.x + dx;
      const y = blocker.pos.y + dy;
      return !birthKeys.has(`${x}:${y}`) && isClearExitTile(spawn.room, x, y);
    });
    if (exit) {
      blocker.memory._spawnYield = { dir: exit, tick: Game.time };
      issueMove(blocker, exit);
    }
  }
}

function isWarConfigName(configName: string): boolean {
  return configName.includes(":war:");
}

function isSourceRoomCarrierConfig(spawn: StructureSpawn, configName: string): boolean {
  const config = getCreepConfigService().get(configName);
  return config?.role === "carrier" && config.roomName === spawn.room.name;
}

function isEmergencyCarrierConfigName(roomName: string, configName: string): boolean {
  return configName.startsWith(`${roomName}:manual:maxcarrier:`);
}

function isSpawnableEmergencyCarrierConfig(spawn: StructureSpawn, configName: string): boolean {
  if (!isEmergencyCarrierConfigName(spawn.room.name, configName)) {
    return false;
  }

  const config = getCreepConfigService().get(configName);
  if (config?.role !== "carrier" || config.roomName !== spawn.room.name || !config.body ||
      config.body.length === 0 || config.body.length > MAX_CREEP_SIZE) {
    return false;
  }

  const bodyCost = config.body.reduce((sum, part) => {
    const partCost = BODYPART_COST[part];
    return typeof partCost === "number" && Number.isFinite(partCost) ? sum + partCost : Number.NaN;
  }, 0);
  return Number.isFinite(bodyCost) && bodyCost <= spawn.room.energyCapacityAvailable;
}

function hasWaitingEmergencyCarrierOnAnotherSpawn(spawn: StructureSpawn): boolean {
  return Object.values(Game.spawns).some((candidate) => {
    if (candidate === spawn || candidate.room.name !== spawn.room.name || !isSpawnActive(candidate)) {
      return false;
    }

    const configName = candidate.memory.spawnList?.[0];
    return !!configName && isSpawnableEmergencyCarrierConfig(candidate, configName);
  });
}

function hasWaitingWarSpawn(spawn: StructureSpawn): boolean {
  return Object.values(Game.spawns).some((candidate) => {
    if (candidate.room.name !== spawn.room.name) {
      return false;
    }
    if (!isSpawnActive(candidate)) {
      return false;
    }
    if (candidate.spawning) return false;
    // 只为当帧能执行的战争队首保留能量；排在后面或尚缺能量的任务不能锁住房间经济。
    return (candidate.memory.spawnList ?? []).slice(0, 1).some((configName) => {
      if (!isWarConfigName(configName) || !getCreepConfigService().get(configName)) {
        return false;
      }

      const bodyCost = chooseBody(candidate, configName)
        .reduce((sum, part) => sum + BODYPART_COST[part], 0);
      return bodyCost <= candidate.room.energyAvailable;
    });
  });
}

function shouldYieldEnergyToWar(spawn: StructureSpawn, configName: string): boolean {
  if (isRoomInReserveMode(spawn.room.name)) return false;
  const config = getCreepConfigService().get(configName);
  if (config?.role === "homeDefender" || config?.roomName === spawn.room.name && ["miner", "harvester"].includes(config.role)) return false;
  if (isWarConfigName(configName) || isSourceRoomCarrierConfig(spawn, configName)) {
    return false;
  }
  return hasWaitingWarSpawn(spawn);
}

function shouldYieldToEmergencyCarrier(spawn: StructureSpawn, configName: string): boolean {
  return !isEmergencyCarrierConfigName(spawn.room.name, configName) &&
    hasWaitingEmergencyCarrierOnAnotherSpawn(spawn);
}

function hasWaitingRcl8MaintenanceOnAnotherSpawn(spawn: StructureSpawn): boolean {
  const creepConfigs = getCreepConfigService();
  return Object.values(Game.spawns).some((candidate) => {
    if (
      candidate === spawn ||
      candidate.room.name !== spawn.room.name ||
      candidate.spawning ||
      !isSpawnActive(candidate)
    ) {
      return false;
    }

    const configName = candidate.memory.spawnList?.[0];
    return !!configName && isRcl8MaintenanceUpgraderConfig(
      configName,
      creepConfigs.get(configName),
    );
  });
}

export function mountSpawn(): void {
  StructureSpawn.prototype.addTask = function addTask(configName: string): number {
    return requestSpawn(this, configName);
  };

  StructureSpawn.prototype.mainSpawn = function mainSpawn(configName: string): boolean {
    const creepConfigs = getCreepConfigService();
    const config = creepConfigs.get(configName);
    if (!config) {
      return true;
    }

    if (hasSpawnAcceptedIntent(this.name) || !canExecuteSpawnRequest(configName, config)) return false;

    const body = chooseBody(this, configName);
    if (body.reduce((sum, part) => sum + BODYPART_COST[part], 0) > this.room.energyCapacityAvailable) {
      this.memory._lastSpawnFail = { tick: Game.time, spawnName: this.name, configName, role: config.role,
        code: ERR_NOT_ENOUGH_ENERGY, bodyCost: body.reduce((sum, part) => sum + BODYPART_COST[part], 0),
        bodyParts: body.length, roomEnergyAvailable: this.room.energyAvailable, roomEnergyCapacityAvailable: this.room.energyCapacityAvailable };
      return true;
    }
    const name = chooseCreepName(this, config);
    const options: SpawnOptions = {
      memory: {
        role: config.role,
        roleArgs: [...config.args],
        configName,
        ready: false,
        working: false,
      },
    };
    const directions = getSpawnExitDirections(this);
    if (directions) {
      options.directions = directions;
    }
    const code = this.spawnCreep(body, name, options);

    if (code === OK) {
      recordAcceptedSpawn(this, configName, name);
      notifySpawnRequestAccepted(configName, config, name);
      recordFixedCpuAction("spawnWork");
      if (isTransientConfigName(configName)) {
        creepConfigs.remove(configName);
      }
    } else {
      this.memory._lastSpawnFail = {
        tick: Game.time,
        spawnName: this.name,
        configName,
        role: config.role,
        code,
        bodyCost: body.reduce((sum, part) => sum + BODYPART_COST[part], 0),
        bodyParts: body.length,
        roomEnergyAvailable: this.room.energyAvailable,
        roomEnergyCapacityAvailable: this.room.energyCapacityAvailable,
      };
    }

    return code === OK;
  };

  StructureSpawn.prototype.work = function work(): void {
    if (this.spawning) {
      // 只在要落地的那一 tick（remainingTime 归零，含出生位被堵的冻结期）
      // 赶人：孵化进行中出生格仍可正常使用，提前驱离会打断在 spawn 邻格
      // 工作的 creep。
      if (this.spawning.remainingTime <= 0) {
        directBlockingCreepsOffSpawn(this);
      }
      return;
    }

    if (!isSpawnActive(this)) {
      return;
    }

    while (readSpawnQueue(this).length) {
      const queue = readSpawnQueue(this);
      const config = getCreepConfigService().get(queue[0]);
      const exceedsCapacity = !!config && fixedBodyExceedsCapacity(config, this.room.energyCapacityAvailable);
      const admission = config && getSpawnAdmission(queue[0], config);
      if (config && !exceedsCapacity && admission?.allowed) break;
      if (config && exceedsCapacity) {
        this.memory._lastSpawnFail = { tick: Game.time, spawnName: this.name, configName: queue[0], role: config.role,
          code: ERR_NOT_ENOUGH_ENERGY, bodyCost: (config.body ?? []).reduce((sum, part) => sum + BODYPART_COST[part], 0),
          bodyParts: config.body?.length ?? 0, roomEnergyAvailable: this.room.energyAvailable,
          roomEnergyCapacityAvailable: this.room.energyCapacityAvailable };
      }
      const reason = !config ? "missing_config" : exceedsCapacity ? "body_capacity" :
        admission?.allowed === false ? admission.reason : "missing_config";
      rejectSpawnRequest(this, queue[0], reason);
    }
    const queue = readSpawnQueue(this);
    if (queue.length === 0) {
      return;
    }

    const currentTask = queue[0];
    const currentConfig = getCreepConfigService().get(currentTask);
    const isRcl8Maintenance = isRcl8MaintenanceUpgraderConfig(currentTask, currentConfig);
    if (currentConfig?.role !== "homeDefender" && !isRcl8Maintenance && hasWaitingRcl8MaintenanceOnAnotherSpawn(this)) {
      return;
    }
    if (!isRcl8Maintenance && shouldYieldEnergyToWar(this, currentTask)) {
      return;
    }
    if (!isRcl8Maintenance && shouldYieldToEmergencyCarrier(this, currentTask)) {
      return;
    }
    const success = this.mainSpawn(currentTask);
    if (success) {
      consumeSpawnRequest(this, currentTask);
    }
  };
}
