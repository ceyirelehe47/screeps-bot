import type {
  HubCommittedProtectionSnapshot,
  HubProtectionAttempt,
} from "@/runtime/hubProtectionSnapshot";
import type {
  AllocationLedgerEntry,
  DirectRouteDecision,
  ProgressEdge,
  SynthesisDispatchAssignment,
  SynthesisRoomCapability,
} from "@/runtime/hubPlanner";
import type { MarketTerminalEnergyReadinessObservation } from "@/runtime/resourceControl";

declare global {
  interface ScreepsMemoryRuntime {
    lastDeployTag?: string;
    /** 部署身份（阶段 B）：bundle 首个 tick 写入，仅 build 改变时更新。 */
    lastDeployCommit?: string;
    lastDeployTree?: string;
    lastDeployBundleHash?: string;
    lastDeployBranch?: string;
    lastDeployAt?: number;
    energyPickup?: {
      terminalBootstrapRecovery?: Record<
        string,
        {
          healthySince?: number;
          lastObservedAt?: number;
          lastRecoveryPickupAt?: number;
        }
      >;
    };
    spawnPlanner?: {
      sourceWorkerCommutes: Record<
        string,
        {
          commute: number;
          updatedAt: number;
        }
      >;
    };
    roomPlannerBuild?: {
      rooms: Record<
        string,
        {
          lastRunAt?: number;
        }
      >;
    };
    linkNetwork?: Record<
      string,
      {
        updatedAt: number;
        senderIds: string[];
        receiverIds: string[];
      }
    >;
    towerEmergencyRamparts?: Record<string, Record<string, number>>;
    towerCombat?: Record<
      string,
      {
        focusTargetId?: string;
        lastFocusHits?: number;
        stalledTicks?: number;
        spreadUntil?: number;
      }
    >;
    illegalStructureCleanup?: {
      rooms: Record<
        string,
        {
          completedAt: number;
          layoutSavedAt: number;
        }
      >;
    };
    defenseCoordination?: Record<
      string,
      {
        fronts: Array<{
          id: string;
          hostileIds: string[];
          centroid: { x: number; y: number };
          threatScore: number;
        }>;
        towerFocusFrontId?: string;
        defenderAssignments?: Record<string, string>;
        defenderRoles?: Record<string, "primary" | "secondary">;
      }
    >;
    crossShard?: {
      remotes?: Record<
        string,
        {
          updatedAt: number;
          remoteUpdatedAt: number;
          portalCount: number;
          colonyCount: number;
          claimCount: number;
          roomCount: number;
        }
      >;
      claims?: Record<
        string,
        {
          updatedAt: number;
          by?: string;
        }
      >;
      rooms?: Record<
        string,
        {
          updatedAt: number;
          hasSpawn: boolean;
          hasStorage: boolean;
        }
      >;
    };
    resourceControl?: {
      updatedAt: number;
      capacityIndexBuildCount?: number;
      taskContributionIndex?: {
        initialTaskCount: number;
        syncCount: number;
        contributionEvaluationCount: number;
      };
      capacityPolicy?: {
        enabled?: boolean;
        terminalHeadroomRecoveryEnabled: boolean;
        storagePressureFreeCapacity: number;
        storageReliefTargetFreeCapacity: number;
        receiverStorageMinFreeCapacity: number;
        terminalPressureFreeCapacity: number;
        receiverTerminalMinFreeCapacity: number;
        terminalReliefTargetFreeCapacity: number;
      };
      eligibleReceiverCount?: number;
      receiverExcludedByReason?: Partial<
        Record<
          "capacity_state" | "storage_headroom" | "terminal_headroom" | "commitment_exhausted",
          number
        >
      >;
      suppressedStagingCount?: Partial<
        Record<
          | "receiver_capacity"
          | "source_depleted"
          | "source_inventory"
          | "fee_budget"
          | "terminal_headroom"
          | "window_limit"
          | "invalid_endpoint",
          number
        >
      >;
      rooms: Record<
        string,
        {
          state: "survival" | "balanced" | "export";
          capacityState?: "normal" | "pressure" | "emergency";
          storageUsedCapacity?: number;
          storageFreeCapacity?: number;
          terminalUsedCapacity?: number;
          terminalFreeCapacity?: number;
          localOffloadCapacityCommitment?: number;
          desiredTerminalFreeCapacity?: number;
          terminalRecoveryGap?: number;
          recoverableOffloadAmount?: number;
          stickyHeadroom?: boolean;
          stickyHeadroomReason?:
            | "storage_full"
            | "protected_inventory"
            | "carrier_backlog"
            | "no_offloadable_resource";
          capacityReservation?: {
            committed: number;
            remaining: number;
          };
          staging?: {
            admittedAmount: number;
            admittedTaskCount: number;
            admittedByResource: Partial<Record<ResourceConstant, number>>;
            suppressedCount: number;
            suppressedByReason: Partial<
              Record<
                | "receiver_capacity"
                | "source_depleted"
                | "source_inventory"
                | "fee_budget"
                | "terminal_headroom"
                | "window_limit"
                | "invalid_endpoint",
                number
              >
            >;
          };
          storageEnergy: number;
          terminalEnergy: number;
          energyFloor: number;
          energyTarget: number;
          energyExportStart: number;
          terminalEnergyReserve?: number;
          nativeMineralType?: MineralConstant;
          canMineNative: boolean;
          minerals: Partial<Record<ResourceConstant, number>>;
          taskHealth?: {
            pendingIncoming: number;
            pendingOutgoing: number;
            blockedIncoming: Partial<
              Record<
                "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
                number
              >
            >;
            blockedOutgoing: Partial<
              Record<
                "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
                number
              >
            >;
          };
          marketEnergyReadiness?: MarketTerminalEnergyReadinessObservation;
        }
      >;
      lastActions: string[];
      lastMarketActions: string[];
      taskSummary?: {
        pending: number;
        manualPending: number;
        automaticPending: number;
        blockedByReason: Partial<
          Record<
            "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
            number
          >
        >;
      };
      recentCapacityReliefRoutes?: Array<{
        tick: number;
        taskId: string;
        fromRoomName: string;
        toRoomName: string;
        resource: ResourceConstant;
        amount: number;
        transferCost: number;
      }>;
      synthesisBindings?: Record<
        string,
        {
          fromRoomName: string;
          updatedAt: number;
          expiresAt: number;
        }
      >;
    };
    marketSaleAutomation?: {
      updatedAt: number;
      requestedMode: "off" | "shadow" | "maker" | "direct" | "hybrid" | "emergencyStop";
      phase: "off" | "shadow" | "maker" | "direct" | "hybrid" | "requested" | "draining" | "stopped";
      configRevision?: string;
      shadowConfigRevision?: string;
      shadowConfigSignature?: string;
      shadowConsecutiveCycles: number;
      zeroConfirmations: number;
      lastZeroConfirmationTick?: number;
      managedOrderCount: number;
      managedOrders?: Array<{
        orderId: string;
        roomName: string;
        resourceType: ResourceConstant;
        remainingExposure: number;
        liveRemainingAmount?: number;
        policyCancelAtTick: number;
        backoffUntil?: number;
        pendingMutationKind?: "cancel" | "extend" | "reprice";
      }>;
      managedOrderSummaryTruncated?: boolean;
      orderSlots?: {
        total: number;
        current: number;
        free: number;
        /** Pending create serialization slots, not manual-order details. */
        reserved: number;
        minFree: number;
      };
      backoffSummary?: {
        activeCount: number;
        nextUntil?: number;
      };
      pendingCreateCount: number;
      pendingMutationCount: number;
      stagingAmount?: number;
      reservationAmount?: number;
      exposureAmount: number;
      rollingFeeMilli: number;
      creditReserve?: number;
      creditSummary?: {
        credits?: number;
        reserve?: number;
        reservedFeesThisTick?: number;
        availableAfterReserve?: number;
      };
      terminalClaims: string[];
      rejectedByReason: Record<string, number>;
      candidates: Record<
        string,
        {
          roomName: string;
          resource: ResourceConstant;
          revision: number;
          observedAt: number;
          expiresAt: number;
          stock: number;
          terminalStock: number;
          protectedAmount: number;
          forecastBuffer: number;
          outgoingProtected: number;
          carrierOrInFlight: number;
          managedExposure: number;
          sellableAmount: number;
          hardFloor?: number;
          economicFloor?: number;
          historyTrusted?: boolean;
          historyCompleteDayCount?: number;
          historyAcceptedDayCount?: number;
          historyFloor?: number;
          ratchetFloor?: number;
          effectiveNetFloor?: number;
          makerPrice?: number;
          makerNetPrice?: number;
          bestDirectNetPrice?: number;
          rejectedReason?: string;
        }
      >;
      canaryLock?: {
        roomName: string;
        resourceType: ResourceConstant;
        lockedAt: number;
        configRevision: string;
      };
      direct?: {
        strategyActive: boolean;
        shadowConsecutiveCycles: number;
        qualifiedAt?: number;
        activationAuthorized: boolean;
        canary?: {
          roomName: string;
          resourceType: ResourceConstant;
          lockedAt: number;
          configRevision: string;
          safetyFingerprint: string;
        };
        pendingCount: number;
        pendingByStatus: Record<string, number>;
        confirmedDealCount: number;
        pausedForReview: boolean;
        migrationBlockedReason?: string;
        baseResourceV3CpuTrace?: {
          observedAt: number;
          cpuAfterOuterSession: number | null;
          cpuAfterScopeCore: number | null;
          cpuAfterMarketFacts: number | null;
          cpuAfterShadowBatch: number | null;
          cpuAfterInnerApply: number | null;
          cpuCutPhase:
            | "outer_session"
            | "scope_core_read1"
            | "scope_core_read2"
            | "market_facts_read1"
            | "market_facts_read2"
            | "shadow_batch_read1"
            | "shadow_batch_read2"
            | "inner_apply"
            | "outer_precommit"
            | null;
          marketFactsDisposition:
            | "not_reached"
            | "skipped_no_consumer"
            | "read";
        };
        exposure: {
          pendingCount: number;
          quarantinedCount: number;
          resourceAmount: number;
          transactionEnergy: number;
          reconcileGapCount: number;
        };
        snapshot?: {
          observedAt: number;
          age: number;
          maxAgeTicks: number;
          fresh: boolean;
          configRevision: string;
          safetyFingerprint: string;
          canary?: {
            roomName: string;
            resourceType: ResourceConstant;
            lockedAt: number;
            configRevision: string;
            safetyFingerprint: string;
          };
          result:
            | "safe_opportunity"
            | "safe_no_opportunity"
            | "production_priority_wait"
            | "incomplete";
          structuralCandidateCount: number;
          eligibleStructuralCandidateCount: number;
          buyBook: {
            rawOrderCount: number;
            rawOrderLimit: number;
            eligibleOrderCount: number;
            eligibleOrderLimit: number;
            eligibleDepth: number;
            eligibleDistinctRoomCount: number;
            pricedOrderCount: number;
            safeCandidateCount: number;
            rejectedOrderCount: number;
            highestGrossPrice?: number;
            selectedOrderId?: string;
            cycleRejection?: string;
            orderRejectionCounts: Record<string, number>;
          };
          opportunity?: {
            orderId: string;
            orderRoomName: string;
            price: number;
            orderAmount: number;
            dealAmount: number;
            transactionEnergy: number;
            netCreditsMilli: number;
            worstCaseNetCreditsMilli: number;
            effectiveNetFloorMilli: number;
          };
          manualBuyOrderCount: number;
          manualSellOrderCount: number;
          zeroRemainingOwnOrderCount: number;
          effectiveNetFloor?: number;
          effectiveEnergyShadowPrice?: number;
          energyShadowObservedAt?: number;
          energyShadowComponents?: {
            hardFloor: number;
            explicit?: number;
            historyFloor?: number;
            ratchetFloor?: number;
          };
          rejectedByReason: Record<string, number>;
        };
      };
      recentActions: string[];
      safetyViolationCount: number;
    };
    factoryControl?: {
      updatedAt?: number;
      rooms: Record<
        string,
        {
          stage: "idle" | "acquiring" | "loading" | "producing" | "unloading" | "blocked" | "sleeping";
          activeTarget?: ResourceConstant;
          missing?: Partial<Record<ResourceConstant, number>>;
          sleepReason?: string;
          sleepUntilTick?: number;
          lastError?: string;
          lastTransitionAt: number;
          loadingSinceTick?: number;
        }
      >;
      claimedOrders?: Array<{
        orderId: string;
        roomName: string;
        tick: number;
        purpose: "sell" | "buy";
      }>;
    };
    synthesisControl?: {
      updatedAt: number;
      generatedTaskCount: number;
      failedTaskCount: number;
      successfulRunCount: number;
      lastActions: string[];
      bindings: Record<
        string,
        {
          fromRoomName: string;
          updatedAt: number;
          expiresAt: number;
        }
      >;
      rooms: Record<
        string,
        {
          stage: "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked";
          activeProduct?: ResourceConstant;
          reagentA?: ResourceConstant;
          reagentB?: ResourceConstant;
          targetAmount?: number;
          batchSize?: number;
          reagentLabIds: string[];
          productLabIds: string[];
          successfulRuns: number;
          pendingTasks: number;
          missing?: Partial<Record<ResourceConstant, number>>;
          cleanupTasks?: Array<{
            labId: string;
            resource: ResourceConstant;
            amount: number;
            target: "terminal" | "storage";
          }>;
          lastError?: string;
          lastTransitionAt: number;
          loadingSinceTick?: number;
          nextReactionAt?: number;
          boostPause?: {
            reason: "powerBankBoost";
            taskId: string;
            taskIds?: string[];
            createdTick: number;
            pausedPlan: {
              product: ResourceConstant;
              targetAmount: number;
              batchSize: number;
              donorRoomNames: string[];
            } | null;
            pausedStage: "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked";
          };
        }
      >;
    };
    hub?: {
      status?: "idle" | "importing" | "synthesizing" | "distributing" | "blocked";
      updatedAt?: number;
      activeProduct?: string;
      activeStep?: number;
      missingResources?: string[];
      lastPlanActions?: string[];
      needsPlan?: boolean;
      lastPlanTick?: number;
      lastError?: string;
      marketSellSurplus?: Partial<Record<ResourceConstant, number>>;
      protectionAttemptHighWater?: number;
      currentProtectionAttempt?: HubProtectionAttempt;
      committedProtectionSnapshot?: HubCommittedProtectionSnapshot;
      distributedSynthesis?: {
        roomCapabilities?: Record<string, SynthesisRoomCapability>;
        dispatchAssignments?: SynthesisDispatchAssignment[];
        allocationLedger?: Record<string, AllocationLedgerEntry>;
        routeDecisions?: DirectRouteDecision[];
        progressEdges?: ProgressEdge[];
      };
    };
    nukerControl?: {
      updatedAt: number;
      ghodiumProductionDemand: number;
      hubPlanDemandBaseline?: number;
      lastActions: string[];
      rooms: Record<
        string,
        {
          nukerId: string;
          reserveMode: boolean;
          ghodium: number;
          ghodiumCapacity: number;
          ghodiumDeficit: number;
          energy: number;
          energyCapacity: number;
          energyDeficit: number;
          safeEnergy: number;
          pendingIncomingGhodium: number;
          carrierTaskCount: number;
          lastError?: string;
        }
      >;
    };
    resourceReservations?: Record<
      string,
      {
        roomName: string;
        resource: ResourceConstant;
        holderId: string;
        amount: number;
        updatedAt: number;
        expiresAt: number;
        /**
         * 持久 typed owner identity（第五轮新增，附加于平铺字段之上；
         * 第六轮起 store key 编码完整 ownerToken）。kind: game-object /
         * logical-service / task / contract / legacy-unresolved；
         * legacy-unresolved 与暂时无法解析的 owner 一律保守计入
         * committed，只有 expiresAt 或显式 release 解除。
         */
        owner?: {
          kind: string;
          id: string;
          roomName?: string;
          namespace?: string;
          lifecycleRef?: string;
        };
      }
    >;
    /**
     * reservation owner 迁移版本标记：
     * - 2 = 裸 holderId 已补写 typed owner 字段（第五轮，store key 仍为
     *   `${room}:${resource}:${holderId}`）；
     * - 3 = store key 已重编码完整 ownerToken（kind 前缀 + logical-service
     *   namespace 段 + id）——同 id 不同 kind/namespace 的 owner 持久层分离。
     * 版本低于 3 且 store 非空时授权侧 fail closed（authorizationSafe 的
     * migration 条件），直至 migrateResourceReservationsForTypedOwner 成功推进。
     */
    resourceReservationsOwnerVersion?: 2 | 3;
    /**
     * Treasury 最小持久状态（绝不持久化 observation/overlay/journal/物理事实）：
     * - receipts：transaction 幂等 receipt。key 为 "t:"+transactionId 编码
     *   （防 "__proto__"/"constructor" 等合法 id 字面量的原型污染语义），
     *   value 为结算 tick；entryCount 为 settled 自有键计数（admission
     *   O(1) 权威，加载时校验）；nextExpiryTick 为过期调度元数据（空表
     *   null；非空 = min(settledAt)+retention+1——未到该 tick 的一切
     *   清理/满容回收路径零全表扫描）。
     *   生命周期：只自动回收结算 tick 早于 now-5000 且 value 完整有效的
     *   过期条目；未过期条目绝不因容量驱逐——满容（4096）且未到过期点时
     *   新 transaction O(1) 拒绝（fail closed）。损坏 value（非
     *   [0,Game.time] 安全整数）不迁移、不删除、整体阻断。version 1（裸键，
     *   raw key 原样编码，`abc` 与 `t:abc` 不碰撞）→ 2（前缀键+entryCount）
     *   → 3（+nextExpiryTick）有已知无损迁移（临时结构全量校验后原子替换，
     *   只执行一次）；未知/更高版本、entryCount 不符、存储键格式非法、
     *   value 损坏或元数据不一致（手工损坏）时 fail closed：原数据保留、
     *   拒绝一切新登记，直至人工处理（已可靠识别的旧 id 查询仍返回
     *   already_settled）。
     * - lifecycle：生命周期标记（lastBeginTick/lastEndTick），global reset
     *   检测与对账基准标记用。
     * - treasuryPerf：指标快照（确定性计数器 + shadow 状态），由 treasury
     *   shadow 低频写入，仅诊断用途。
     */
    treasury?: {
      receipts?: {
        version: 3;
        settled: Record<string, number>;
        updatedAt: number;
        entryCount: number;
        nextExpiryTick: number | null;
      };
      lifecycle?: {
        lastBeginTick?: number;
        lastEndTick?: number;
      };
      /**
       * write-fault marker（第五轮新增）：staged commit 意外写故障（receipt/
       * heap/handle 状态发布失败、endTick 时 handle 仍 executing 等）的最
       * 小、有界持久快照——只保留首个 unresolved 故障（根因），绝不持久化
       * 正常 transaction/journal/overlay。存在 unresolved marker 期间全部
       * Treasury writer fail closed（write_admission_locked），只有显式管理
       * /修复路径（clearTreasuryWriteFaultForRepair）可解除；global reset
       * 后凭本 marker 仍可发现 Treasury 曾发生 unresolved commit fault。
       */
      writeFault?: {
        transactionId: string;
        digest: string;
        tick: number;
        kind: string;
        source: string;
        phase: string;
        status: "unresolved";
        recordedAt: number;
      };
    };
    treasuryPerf?: Record<string, number | string>;
    powerBankBoost?: Record<
      string,
      {
        labs: Record<string, { labId: string; compound: ResourceConstant }>;
        taskId: string;
        sourceRoomName: string;
      }
    >;
    powerBankObserver?: {
      patrolIndex: number;
      updatedAt: number;
      lastObservedRooms: string[];
      coveredRooms: string[];
    };
    remoteMining?: {
      lastScanAt?: number;
    };
    /** Power bank scout transit danger rooms: roomName -> expiresAt tick. */
    transitDangerRooms?: Record<string, number>;
    /** Power bank scout hostile-owned or hostile-reserved transit rooms. */
    powerBankPermanentDangerRooms?: Record<string, true>;
  }
}

export {};
