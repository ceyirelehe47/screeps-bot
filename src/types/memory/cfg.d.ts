import type { RoomType } from "@/types/system";

declare global {
  interface ScreepsMemoryConfig {
    rooms?: Record<
      string,
      {
        type?: RoomType;
      }
    >;
    worker?: {
      maxPerRoom?: number;
      dynamicBeforeRcl4?: boolean;
      dynamicMaxBonus?: number;
      useWorkPosAllocation?: boolean;
    };
    energyPickup?: {
      preferredMin?: number;
      /** Room names where carriers may withdraw ENERGY from terminal as a generic pickup source. */
      terminalPickupRooms?: Record<string, boolean>;
      /** Explicit, temporary room grants for Spawn/Extension Terminal bootstrap recovery. */
      terminalBootstrapRecoveryRooms?: Record<string, boolean>;
    };
    pixelGenerator?: {
      enabled?: boolean;
    };
    roomPlannerBuild?: {
      enabled?: boolean;
      maxNewSitesPerRoom?: number;
    };
    productionMonitor?: {
      enabled?: boolean;
    };
    crossShard?: {
      enabled?: boolean;
    };
    telemetry?: {
      enabled?: boolean;
      sampleInterval?: number;
      segmentId?: number;
    };
    movementMetrics?: {
      /** 显式观测模式：off（不记录）/ totals（默认，仅累计 totals）/ rooms（含房间分桶，定向诊断用）。 */
      mode?: "off" | "totals" | "rooms";
      /** @deprecated 旧开关，等价于 mode:"totals"；显式 mode 优先。 */
      roomStats?: boolean;
    };
    marketSaleDiagnostics?: {
      /** 市场子 phase 临时诊断窗口（提交 A 测量用）：窗口到期自动关闭。 */
      enabled?: boolean;
      windowTicks?: number;
    };
    cpuProfiler?: {
      enabled?: boolean;
      sampleInterval?: number;
      historyLimit?: number;
      emaAlpha?: number;
      roomRoleAggregation?: boolean;
      heapStats?: boolean;
      fixedActionCpuCost?: number;
    };
    synthesisControl?: {
      enabled?: boolean;
      sampleInterval?: number;
      defaultBatchSize?: number;
      rooms?: Record<
        string,
        {
          enabled?: boolean;
          batchSize?: number;
          donorRoomNames?: string[];
          reagentLabIds?: string[];
          reactions?: Array<
            {
              product?: ResourceConstant;
              targetAmount?: number;
              batchSize?: number;
              donorRoomNames?: string[];
            }
          >;
        }
      >;
    };
    homeDefense?: {
      boostTarget?: number;
      maxDefenders?: number;
      maxBoostBuyPrice?: number;
      maxBoostDealEnergyCostRatio?: number;
      rooms?: Record<string, { boostLabId?: string }>;
    };
    resourceControl?: {
      enabled?: boolean;
      sampleInterval?: number;
      taskMaxPerRun?: number;
      capacityBalancing?: {
        enabled?: boolean;
        terminalHeadroomRecoveryEnabled?: boolean;
        storagePressureFreeCapacity?: number;
        storageReliefTargetFreeCapacity?: number;
        receiverStorageMinFreeCapacity?: number;
        terminalPressureFreeCapacity?: number;
        terminalReliefTargetFreeCapacity?: number;
        receiverTerminalMinFreeCapacity?: number;
        maxPlannedAmountPerTask?: number;
        maxNewTasksPerRun?: number;
        automaticTaskNoProgressTtl?: number;
        sourceDepletedGraceTicks?: number;
        t3ReservePerRoom?: number;
      };
      rooms?: Record<
        string,
        {
          energyFloor?: number;
          energyTarget?: number;
          energyExportStart?: number;
          terminalEnergyReserve?: number;
          transferBatchSize?: number;
          mineralFloor?: Partial<Record<ResourceConstant, number>>;
          mineralExportStart?: Partial<Record<ResourceConstant, number>>;
        }
      >;
      market?: {
        enabled?: boolean;
        emergencyBuyEnabled?: boolean;
        nativeMineralAutoSellThreshold?: number;
        maxDealsPerRun?: number;
        minDealAmount?: number;
        maxDealAmount?: number;
        maxDealEnergyCostRatio?: number;
        minSellPrice?: Partial<Record<ResourceConstant, number>>;
        maxBuyPrice?: Partial<Record<ResourceConstant, number>>;
        sellResources?: ResourceConstant[];
        buyResources?: ResourceConstant[];
      };
      synthesis?: {
        enabled?: boolean;
        maxGeneratedPerRun?: number;
        rooms?: Record<
          string,
          {
            demands?: Partial<Record<ResourceConstant, number>>;
            donorRoomNames?: string[];
          }
        >;
      };
    };
    marketSaleAutomation?: {
      mode?: "off" | "shadow" | "maker" | "direct" | "hybrid" | "emergencyStop";
      directCapability?:
        | "legacy-canary"
        | "continuous-v2"
        | "continuous-v3";
      shadowStrategy?: "maker" | "direct";
      configRevision?: string;
      sellResources?: ResourceConstant[];
      hardFloor?: Partial<Record<ResourceConstant, number>>;
      economicFloor?: Partial<Record<ResourceConstant, number>>;
      forecastBuffer?: Partial<Record<ResourceConstant, number>>;
      minDealAmount?: number;
      maxDealAmount?: number;
      makerBatchAmount?: number;
      maxManagedOrders?: number;
      minFreeOrderSlots?: number;
      creditReserve?: number;
      rollingFeeBudget?: number;
      feeWindowTicks?: number;
      terminalEnergyReserve?: number;
      energyShadowPrice?: number;
      directDiscountRatio?: number;
      minHistoryDays?: number;
      minHistoryTransactions?: number;
      minHistoryVolume?: number;
      historyFloorRatio?: number;
      historyMaxAgeDays?: number;
      minReferenceOrderAmount?: number;
      minReferenceOrderNotional?: number;
      minReferenceOrderCount?: number;
      minReferenceDistinctRooms?: number;
      referenceDepthMultiplier?: number;
      maxHistoryAskDeviationRatio?: number;
      makerAskFloorRatio?: number;
      makerHistoryVolumeRatio?: number;
      orderPolicyTtl?: number;
      mutationBackoffTicks?: number;
      maxDirectDealAmount?: number;
      maxDirectDealsPerCycle?: number;
      minDirectOrderAmount?: number;
      minDirectOrderNotional?: number;
      maxDirectRawOrdersScannedPerCycle?: number;
      maxDirectEligibleOrdersPricedPerCycle?: number;
      maxDirectTransactionEnergy?: number;
      directCanaryMaxConfirmedDeals?: number;
      energyShadowHardFloor?: number;
      planningSnapshotMaxAgeTicks?: number;
      canary?: {
        enabled?: boolean;
        allowExpansion?: boolean;
      };
      orderMutationLease?: {
        epoch: string;
        grantedAt: number;
        expiresAt: number;
        baselineHash: string;
        revokedAt?: number;
        revokeReason?: string;
      };
    };
    hub?: {
      enabled?: boolean;
      hubRoomName?: string;
      /** @deprecated Upgraders are now maintained automatically in every owned room. */
      upgraderRoomNames?: string[];
      planInterval?: number;
      reservePerRoom?: number;
      hubReservePerCompound?: number;
      targetCompounds?: ResourceConstant[];
      storagePauseFreeCapacity?: number;
      surplusThreshold?: number;
      internalOnly?: boolean;
      marketSellEnabled?: boolean;
      /** When true (default), non-T3 surplus stays local; only T3 centralizes to hub. */
      distributedStorage?: boolean;
    };
    factoryControl?: {
      enabled?: boolean;
      terminalEnergyReserve?: number;
      market?: {
        enabled?: boolean;
        sellResources?: ResourceConstant[];
        minSellPrice?: Partial<Record<ResourceConstant, number>>;
        minNetCredits?: number;
        minOrderAmount?: number;
        minPriceRatio?: number;
        maxEnergyCostRatio?: number;
        orderBlacklist?: string[];
        orderAllowlist?: string[];
        roomAllowlist?: string[];
        purchaseEnabled?: boolean;
        maxBuyPrice?: Partial<Record<ResourceConstant, number>>;
        maxBatch?: number;
        dailyBudget?: number;
        creditReserve?: number;
        buyResources?: ResourceConstant[];
      };
      targetQueue?: ResourceConstant[];
      targets?: Array<{
        resource: ResourceConstant;
        targetAmount?: number;
        cap?: number;
      }>;
      resourceFloors?: Partial<Record<ResourceConstant, number>>;
      productionCaps?: Partial<Record<ResourceConstant, number>>;
      sleepSettings?: {
        cooldownOnError?: number;
        cooldownOnMissing?: number;
        maxSleepTicks?: number;
      };
      rooms?: Record<
        string,
        {
          enabled?: boolean;
          targetQueue?: ResourceConstant[];
          targets?: Array<{
            resource: ResourceConstant;
            targetAmount?: number;
            cap?: number;
          }>;
          resourceFloors?: Partial<Record<ResourceConstant, number>>;
          productionCaps?: Partial<Record<ResourceConstant, number>>;
          sleepTicks?: number;
        }
      >;
    };
    remoteMining?: {
      enabled?: boolean;
      scanInterval?: number;
      roadInterval?: number;
      scoutTimeout?: number;
      maxRemoteRoomsPerSourceRoom?: number;
      maintenanceReserveEnergy?: number;
      maxRemoteSitesPerRun?: number;
      remoteSafeTicksToResume?: number;
      remoteReservationRenewAt?: number;
    };
  }
}

export {};
