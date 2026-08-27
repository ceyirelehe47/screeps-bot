import { roleRegistry } from "@/roles";
import { clearMovementState } from "@/roles/shared";
import { decodeCrossShardTravelerName } from "@/runtime/crossShardNaming";
import { measureCreepDecision } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import type { RoleFactory } from "@/types/system";

function tryRestoreRoleFromName(creep: Creep): boolean {
  const traveler = decodeCrossShardTravelerName(creep.name);
  if (!traveler) {
    return false;
  }

  const restoredRoleByKind = {
    claimer: "crossShardClaimer",
    harvester: "crossShardColonizerHarvester",
    worker: "crossShardColonizerWorker",
  } as const;

  creep.memory.role = restoredRoleByKind[traveler.kind];
  creep.memory.roleArgs = [
    traveler.targetShard,
    traveler.targetRoom,
    traveler.portalRoom,
    traveler.destinationRoom || "",
  ];
  creep.memory.ready = false;
  creep.memory.working = false;

  return true;
}

/**
 * RoleLifecycle 实例缓存：所有 RoleFactory 均为无状态闭包（状态都在
 * creep.memory 或 runtime 服务中），同一 config / role+args 签名的多个
 * creep 可安全共享同一实例，避免每 creep 每 tick 重建对象和闭包。
 *
 * 失效条件：
 * - config 路径：CreepConfigService.get 返回的 config 对象引用变化（upsert
 *   在内容不变时保持对象引用不变）或 role/args 逐元素不一致（防御原地改写）；
 * - memory 路径：签名 key 由当前 role+roleArgs 现场计算，天然随 memory 变化；
 * - global reset：模块级缓存随代码重载一并消失。
 *
 * 容量：以 config 数量与 memory 角色签名数量为界，均由游戏内实体数天然限制。
 */
interface RoleLifecycleCacheEntry {
  configRef?: unknown;
  role: string;
  args: readonly string[];
  lifecycle: ReturnType<RoleFactory>;
}

const roleLifecycleCache = new Map<string, RoleLifecycleCacheEntry>();

export function clearRoleLifecycleCacheForTest(): void {
  roleLifecycleCache.clear();
}

function roleArgsSignature(args: readonly string[]): string {
  return args.map((arg) => arg ?? "").join("");
}

function isCacheEntryCurrent(
  entry: RoleLifecycleCacheEntry,
  configRef: unknown | undefined,
  role: string,
  args: readonly string[],
): boolean {
  if (entry.role !== role || entry.args.length !== args.length) {
    return false;
  }
  for (let index = 0; index < args.length; index += 1) {
    if ((entry.args[index] ?? "") !== (args[index] ?? "")) {
      return false;
    }
  }
  return entry.configRef === configRef;
}

function getOrCreateRoleLifecycle(
  cacheKey: string,
  configRef: unknown | undefined,
  role: string,
  args: readonly string[],
): ReturnType<RoleFactory> | null {
  const roleFactory = roleRegistry[role as keyof typeof roleRegistry];
  if (!roleFactory) {
    roleLifecycleCache.delete(cacheKey);
    return null;
  }

  const cached = roleLifecycleCache.get(cacheKey);
  if (cached && isCacheEntryCurrent(cached, configRef, role, args)) {
    return cached.lifecycle;
  }

  const lifecycle = roleFactory(...args);
  roleLifecycleCache.set(cacheKey, {
    ...(configRef === undefined ? {} : { configRef }),
    role,
    args: [...args],
    lifecycle,
  });
  return lifecycle;
}

function resolveRoleLogic(creep: Creep): ReturnType<(typeof roleRegistry)[keyof typeof roleRegistry]> | null {
  const creepConfigs = getCreepConfigService();
  const configName = creep.memory.configName;
  if (configName) {
    const config = creepConfigs.get(configName);
    if (config) {
      // config 引用相等 + role/args 一致 ⇔ factory 输出等价，直接复用。
      return getOrCreateRoleLifecycle(
        `config:${configName}`,
        config,
        config.role,
        config.args,
      );
    }
    // config 已被删除：清掉该 key 的陈旧实例，防止错误复用。
    roleLifecycleCache.delete(`config:${configName}`);
  }

  const memoryRole = creep.memory.role;
  if (!memoryRole) {
    if (tryRestoreRoleFromName(creep)) {
      const restoredRole = creep.memory.role;
      if (restoredRole) {
        return getOrCreateRoleLifecycle(
          `memory:${restoredRole}|${roleArgsSignature(creep.memory.roleArgs || [])}`,
          undefined,
          restoredRole,
          creep.memory.roleArgs || [],
        );
      }
    }

    return null;
  }

  return getOrCreateRoleLifecycle(
    `memory:${memoryRole}|${roleArgsSignature(creep.memory.roleArgs || [])}`,
    undefined,
    memoryRole,
    creep.memory.roleArgs || [],
  );
}

export function mountCreep(): void {
  Creep.prototype.work = function work(): void {
    // spawn 让位指令优先：挡位 creep 的自身移动逻辑会覆盖 spawn 侧的
    // 直接 move（spawn.work 先执行），本 tick 让出一步并跳过自身行为，
    // 解除孵化冻结；指令带 tick，过期即忽略并清除。
    const spawnYield = this.memory._spawnYield;
    if (spawnYield) {
      delete this.memory._spawnYield;
      if (Game.time - spawnYield.tick >= 0 && Game.time - spawnYield.tick <= 2) {
        this.move(spawnYield.dir);
        return;
      }
    }

    const logic = measureCreepDecision(() => resolveRoleLogic(this));
    if (!logic) {
      clearMovementState(this);
      this.say("no-config");
      return;
    }

    if (!this.memory.ready) {
      this.memory.ready = measureCreepDecision(() => (logic.prepare ? logic.prepare(this) : true));
      return;
    }

    const isWorking = this.memory.working ?? false;
    let shouldSwitch = false;

    if (isWorking) {
      shouldSwitch = logic.target(this);
    } else if (logic.source) {
      shouldSwitch = logic.source(this);
    } else {
      shouldSwitch = true;
    }

    if (shouldSwitch) {
      clearMovementState(this);
      this.memory.working = !isWorking;

      const switchedToWorking = this.memory.working === true;
      if (switchedToWorking) {
        logic.target(this);
      } else if (logic.source) {
        logic.source(this);
      }
    }
  };
}
