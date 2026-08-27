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
 * 失效条件（全部基于稳定的值签名，不依赖对象引用）：
 * - config 路径：configName + role + args 逐元素比较（CreepConfig 只有
 *   role/args/roomName 三个字段，factory 只消费 role/args；Memory 对象
 *   每 tick 可能被替换为等价新引用，引用相等会漏命中）；
 * - memory 路径：签名 key 由当前 role+roleArgs 现场计算，天然随 memory 变化；
 * - global reset：模块级缓存随代码重载一并消失。
 *
 * 容量：ROLE_LIFECYCLE_CACHE_MAX 上限 + lastUsedAt LRU 淘汰，防止历史
 * config / 临时 fallback 签名无限增长。
 */
interface RoleLifecycleCacheEntry {
  role: string;
  args: readonly string[];
  lifecycle: ReturnType<RoleFactory>;
  lastUsedAt: number;
}

const ROLE_LIFECYCLE_CACHE_MAX = 256;
const roleLifecycleCache = new Map<string, RoleLifecycleCacheEntry>();

export function clearRoleLifecycleCacheForTest(): void {
  roleLifecycleCache.clear();
}

/** 仅供测试观测缓存条目数。 */
export function getRoleLifecycleCacheSizeForTest(): number {
  return roleLifecycleCache.size;
}

function roleArgsSignature(args: readonly string[]): string {
  // JSON 编码带元素定界，["a,b"] 与 ["a","b"] 等拼接碰撞对必须产生不同
  // 签名；nullish 归一为空串，保证输入始终可序列化且稳定。
  return JSON.stringify(args.map((arg) => arg ?? ""));
}

function isCacheEntryCurrent(entry: RoleLifecycleCacheEntry, role: string, args: readonly string[]): boolean {
  if (entry.role !== role || entry.args.length !== args.length) {
    return false;
  }
  for (let index = 0; index < args.length; index += 1) {
    if ((entry.args[index] ?? "") !== (args[index] ?? "")) {
      return false;
    }
  }
  return true;
}

function evictLeastRecentlyUsedRoleLifecycles(): void {
  while (roleLifecycleCache.size > ROLE_LIFECYCLE_CACHE_MAX) {
    let oldestKey: string | undefined;
    let oldestUsedAt = Infinity;
    for (const [key, entry] of roleLifecycleCache.entries()) {
      if (entry.lastUsedAt < oldestUsedAt) {
        oldestUsedAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) {
      break;
    }
    roleLifecycleCache.delete(oldestKey);
  }
}

function getOrCreateRoleLifecycle(
  cacheKey: string,
  role: string,
  args: readonly string[],
): ReturnType<RoleFactory> | null {
  const roleFactory = roleRegistry[role as keyof typeof roleRegistry];
  if (!roleFactory) {
    roleLifecycleCache.delete(cacheKey);
    return null;
  }

  const cached = roleLifecycleCache.get(cacheKey);
  if (cached && isCacheEntryCurrent(cached, role, args)) {
    cached.lastUsedAt = Game.time;
    return cached.lifecycle;
  }

  const lifecycle = roleFactory(...args);
  roleLifecycleCache.set(cacheKey, {
    role,
    args: [...args],
    lifecycle,
    lastUsedAt: Game.time,
  });
  evictLeastRecentlyUsedRoleLifecycles();
  return lifecycle;
}

function resolveRoleLogic(creep: Creep): ReturnType<(typeof roleRegistry)[keyof typeof roleRegistry]> | null {
  const creepConfigs = getCreepConfigService();
  const configName = creep.memory.configName;
  if (configName) {
    const config = creepConfigs.get(configName);
    if (config) {
      // configName+role+args 值签名一致 ⇔ factory 输出等价，直接复用；
      // 不比较对象引用（Memory 每 tick 重解析后引用不稳定）。
      return getOrCreateRoleLifecycle(
        `config:${configName}`,
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
          restoredRole,
          creep.memory.roleArgs || [],
        );
      }
    }

    return null;
  }

  return getOrCreateRoleLifecycle(
    `memory:${memoryRole}|${roleArgsSignature(creep.memory.roleArgs || [])}`,
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
