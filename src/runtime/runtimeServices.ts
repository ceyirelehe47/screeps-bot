import { createRuntimeMemoryService, type RuntimeMemoryService } from "@/runtime/memoryService";
import { createTickContextService, type TickContextService } from "@/runtime/tickContext";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { sealTreasuryAdapterRegistryForProduction } from "@/runtime/treasury/actionContracts";
import { sealTreasuryPolicyRegistryForProduction } from "@/runtime/treasury/policyAuthority";
import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

export interface CreepConfigService extends CreepApi {
  upsert(configName: string, role: RoleName, args: string[], roomName?: string): void;
}

export interface RuntimeServices {
  memory: RuntimeMemoryService;
  creepConfigs: CreepConfigService;
  tickContext: TickContextService;
  /** 帝国国库：资产观察/承诺索引/投影/对账的统一入口（Gateway）。 */
  treasury: TreasuryService;
}

type RuntimeGlobalWithServices = typeof global & {
  __runtimeServices?: RuntimeServices;
};

const runtimeGlobal: RuntimeGlobalWithServices = global;
const UPSERTED_CREEP_CONFIG_KEYS = new Set<keyof CreepConfig>([
  "role",
  "args",
  "roomName",
]);

function areStringArraysEqual(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < right.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(left, index) || left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function isUpsertedConfigCurrent(current: CreepConfig | undefined, next: CreepConfig): boolean {
  if (!current) {
    return false;
  }

  return (
    Object.keys(current).every((key) => UPSERTED_CREEP_CONFIG_KEYS.has(key as keyof CreepConfig)) &&
    current.role === next.role &&
    current.roomName === next.roomName &&
    areStringArraysEqual(current.args, next.args)
  );
}

function createCreepConfigService(memory: RuntimeMemoryService): CreepConfigService {
  return {
    add(configName, role, ...args) {
      memory.getCreepConfigStore()[configName] = { role, args };
      return `${configName} updated: role=${role}, args=${args.join(",")}`;
    },

    remove(configName) {
      delete memory.getCreepConfigStore()[configName];
      return `${configName} removed`;
    },

    get(configName) {
      return memory.getCreepConfigStore()[configName];
    },

    list(prefix) {
      const all = memory.getCreepConfigStore();
      if (!prefix) {
        return { ...all };
      }

      const filtered: Record<string, CreepConfig> = {};
      for (const key of Object.keys(all)) {
        if (key.startsWith(prefix)) {
          filtered[key] = all[key];
        }
      }

      return filtered;
    },

    upsert(configName, role, args, roomName) {
      const current = this.get(configName);
      const next: CreepConfig = { role, args, roomName };
      if (!isUpsertedConfigCurrent(current, next)) {
        memory.getCreepConfigStore()[configName] = next;
      }
    },
  };
}

function createRuntimeServices(): RuntimeServices {
  const memory = createRuntimeMemoryService();
  const creepConfigs = createCreepConfigService(memory);
  const tickContext = createTickContextService();
  // Treasury 的房间源注入 tickContext 快照（复用既有 myRooms 缓存，零 room.find）；
  // 任务/预留源由 facade 默认直读 Memory 路径（查询零写，不 ensure）。
  const treasury = createTreasuryService({ getRooms: () => tickContext.getMyRooms() });
  // 生产装配完成：seal adapter/policy registry（第十一轮 3.13.2/3.13.3——
  // 运行中动态注册拒绝；测试不经本装配路径，registry 状态隔离由测试自行管理）。
  sealTreasuryAdapterRegistryForProduction();
  sealTreasuryPolicyRegistryForProduction();
  return {
    memory,
    creepConfigs,
    tickContext,
    treasury,
  };
}

export function registerRuntimeServices(services?: RuntimeServices): RuntimeServices {
  if (!runtimeGlobal.__runtimeServices) {
    runtimeGlobal.__runtimeServices = services || createRuntimeServices();
  }
  return runtimeGlobal.__runtimeServices;
}

export function getRuntimeServices(): RuntimeServices {
  return registerRuntimeServices();
}

export function getCreepConfigService(): CreepConfigService {
  return getRuntimeServices().creepConfigs;
}

export function getMemoryService(): RuntimeMemoryService {
  return getRuntimeServices().memory;
}

export function getTickContextService(): TickContextService {
  return getRuntimeServices().tickContext;
}

export function getTreasuryService(): TreasuryService {
  return getRuntimeServices().treasury;
}
