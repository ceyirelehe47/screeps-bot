import { createRuntimeMemoryService, type RuntimeMemoryService } from "@/runtime/memoryService";
import { createTickContextService, type TickContextService } from "@/runtime/tickContext";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { sealTreasuryAdapterRegistryForProduction } from "@/runtime/treasury/actionContracts";
import { sealTreasuryPolicyRegistryForProduction } from "@/runtime/treasury/policyAuthority";
import { treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

export interface CreepConfigService extends CreepApi {
  upsert(configName: string, role: RoleName, args: string[], roomName?: string): void;
}

export interface RuntimeServices {
  memory: RuntimeMemoryService;
  creepConfigs: CreepConfigService;
  tickContext: TickContextService;
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
  let treasuryRef: TreasuryService | undefined;
  const treasury = createTreasuryService({
    getRooms: () => tickContext.getMyRooms(),
    getTasks: () => treasuryTaskCommitmentView(
      Memory.data?.resourceControl?.tasks ?? {},
      treasuryRef?.kernelJournal().active ?? [],
    ),
  });
  treasuryRef = treasury;
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
