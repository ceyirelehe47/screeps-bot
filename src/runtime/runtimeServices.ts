import { createRuntimeMemoryService, type RuntimeMemoryService } from "@/runtime/memoryService";
import { createTickContextService, type TickContextService } from "@/runtime/tickContext";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { sealTreasuryAdapterRegistryForProduction } from "@/runtime/treasury/actionContracts";
import { sealTreasuryPolicyRegistryForProduction } from "@/runtime/treasury/policyAuthority";
import { treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import { treasuryT3CommittedOutgoingForLocation } from "@/runtime/treasuryT3LocationCommitments";
import { createCreepConfigService, type CreepConfigService } from "@/runtime/creepConfigService";

export type { CreepConfigService } from "@/runtime/creepConfigService";

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
    committedOutgoingForLocation: treasuryT3CommittedOutgoingForLocation,
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
