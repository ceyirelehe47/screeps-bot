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
    /** 【Defense Focus-Fire Sidecar】每房间每 tick 的协同集火 plan（目标与
     *  actor 分配；plannedAtTick 与 Game.time 不符视为过期，消费方回退）。
     *  【Remediation III】三分类 / 击杀预算 / engagement 分离 / fallback
     *  候选与运行期共享解析缓存。 */
    defenseEngagement?: Record<
      string,
      {
        roomName: string;
        plannedAtTick: number;
        focusTargetId: string | null;
        /** 主目标三分类（killable_this_tick / positive_pressure / suppression_only）。 */
        focusTargetClass?: string;
        /** 主目标在联合预算内是否可击杀（false = 共享战略压制目标）。 */
        killExpected: boolean;
        focusAssignedDamage: number;
        /** 主目标完整击杀预算（pressure/suppression 类为 null）。 */
        focusKillBudget?: number | null;
        focusExpectedHeal: number;
        towerAssignments: Record<string, string>;
        defenderAssignments: Record<string, string>;
        /** Defender slot → 作战 assignment（目标与接敌位置分离；targetId=null
         *  为显式 hold——fresh plan 仍是权威，不回退独立选敌；participation=
         *  not_participating 是唯一允许消费方走旧独立行为的显式语义——entry
         *  缺失不是不参与，fresh plan 存在时默认 hold；reservedPosition 为
         *  本 tick 不离开当前位置的参与 Defender（direct attack /
         *  ranged_attack / hold / 站位 engage_position）当前所站合法
         *  boundary Rampart 的房间级保留事实——移动腾位者不保留）。 */
        defenderEngagements?: Record<
          string,
          {
            targetId: string | null;
            mode: string;
            position?: { x: number; y: number };
            positionKind?: string;
            participation?: string;
            reservedPosition?: { x: number; y: number };
          }
        >;
        /** 【Remediation IV 十六】Defender front 约束（fallback revision 的
         *  front-local 替代依据——eligibleTargetIds 为预计算集合）。 */
        defenderFronts?: Record<string, { frontId?: string; eligibleTargetIds: string[] }>;
        /** 【Remediation V 十】per-defender 唯一分配的候选集合持久化（hostileId
         *  → boundary rampart 候选 + 他属占用标记——fallback revision 消费）。 */
        engagementCandidatesByTargetId?: Record<string, { id: string; x: number; y: number; occupied?: boolean }[]>;
        /** 【Remediation VI 6.3】参与 Defender 的本 tick 真实 facts（role + 当前
         *  坐标——planner 输入快照持久化；fallback revision 按真实位置/role 评分）。 */
        defenderFactsBySlot?: Record<string, { role: string; x: number; y: number }>;
        /** 【Remediation IV 十六 / V 十】运行期房间级 fallback 修订计划（每房间每
         *  tick 至多一次生成；Tower 与 Defender 共同消费——per-defender 独立位置
         *  重新分配，unaffected 原位置保留）。 */
        fallbackRevision?: {
          tick: number;
          towerTargetByTowerId: Record<string, string | null>;
          defenderEngagementBySlot: Record<
            string,
            { targetId: string | null; mode: string; position?: { x: number; y: number }; positionKind?: string; reservedPosition?: { x: number; y: number } }
          >;
          emergencyHealByTowerId: Record<string, string>;
          requests: number;
        };
        /** hostileId → 接敌位置（inside=直接接敌 / boundary=合法 rampart）。 */
        engagementByTargetId?: Record<string, { x: number; y: number; kind: string }>;
        emergencyHealByTowerId: Record<string, string>;
        /** 共享 fallback 候选顺序（resolver 逐个探活）。 */
        fallbackTargetIds?: string[];
        /** 运行期共享 fallback 解析缓存（每房间每 tick 至多一次）。 */
        fallbackResolution?: { tick: number; resolvedTargetId: string | null; requests: number };
        fallbackReason?: string;
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
     * - 3 = store key 已重编码 ownerToken v3（第六轮，kind 前缀 +
     *   logical-service namespace 段 + id）；
     * - 4 = store key 重编码 canonical owner token v4（第七轮，长度前缀
     *   `ow2:<kindCode>:<nsLen>:<namespace><id>`——字段边界无歧义）。
     * 版本低于 4 且 store 非空时授权侧 fail closed；schema activation
     * gate（ensureReservationSchemaActivated）在一切 mutation 前推进迁移。
     */
    resourceReservationsOwnerVersion?: 2 | 3 | 4;
    /**
     * reservation store 损坏标志（第七轮）：GC/验证发现 malformed entry 时
     * 写入有界描述（该 entry 原样保留不删除）——存在期间一切 reservation
     * mutation 拒绝、authorizationSafe/write readiness fail closed，只有
     * 显式 repair（验证全 store 合法后清除）可解除。
     */
    resourceReservationsCorrupted?: string;
    /**
     * 【Core Rewrite I】Treasury 新内核持久根（v1）。一项未完成工作 = 一个
     * 有界活跃聚合（active，键 = attemptId，上限 64）；只有该聚合内当前
     * attempt 的正向许可（heap-only，不持久化）可进入动作调用；ring 为
     * 近期明细环（上限 128，不参与授权）。发行 frontier 单调不回退；分配
     * 失败烧掉序号（burned 计数），不为洞建永久记录。
     * 遇到旧 Memory.runtime.treasury 业务数据（intents/quarantine/receipts
     * 等）时内核报告 incompatible 并阻断写入——不解析、不擦除。
     * - treasuryPerf：指标快照（shadow 低频写入，仅诊断）。
     */
    treasuryCore?: {
      version: number;
      installEpochId: string;
      issuance: { frontier: number; burned: number };
      lifecycle: { lastBeginTick: number | null; lastEndTick: number | null };
      active: Record<string, {
        workKey: string;
        attemptId: string;
        generation: number;
        parentAttemptId: string | null;
        phase: "pending" | "dispatching" | "outcome_unknown" | "closing" | "retry_ready";
        admittedAtTick: number;
        updatedAtTick: number;
        identity: {
          actionKind: string;
          adapterVersion: number;
          adapterRegistrationId: string;
          adapterSemanticIdentity: string;
          canonicalDigest: string;
          postingsDigest: string;
          retryFactsDigest: string | null;
          durableFacts: { version: number; payload: string } | null;
        };
        worstCase: readonly { roomName: string; locationKind: string; resource: string; outflow: number }[];
        invocation: { atTick: number } | null;
        external: { accepted: boolean; atTick: number } | null;
        outcome: "unknown" | "committed" | "not_executed";
        outcomeEvidence: {
          kind: "adapter_execution_semantics" | "adapter_reconcile" | "external_settlement_receipt";
          conclusion: "executed" | "not_executed" | "still_uncertain";
          source: string;
          atTick: number;
        } | null;
        cleanup: { consumerKeys: readonly string[]; failures: number };
        retryDeadlineTick: number | null;
        lastError: string | null;
      }>;
      ring: {
        attemptId: string;
        workKey: string;
        generation: number;
        terminalPhase: "committed" | "not_executed" | "retry_expired" | "abandoned";
        closedAtTick: number;
      }[];
      ringCursor: number;
      counters: {
        admitted: number;
        dispatched: number;
        settledCommitted: number;
        settledNotExecuted: number;
        unknown: number;
        rearmings: number;
        rejectedAdmissions: number;
        recoveryAdvances: number;
        cleanupFailures: number;
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
