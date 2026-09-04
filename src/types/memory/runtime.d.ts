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
        /**
         * v7（第十七轮第十五节）：proof level 显式三级——identity-bound
         * （完整 modern 身份、禁携带 lowlevelSource）/ lowlevel（digest +
         * durableIdentityDigest + 受控 lowlevelSource、禁 modern contract/
         * cohort 字段）/ legacy（无身份、只作 replay blocker）。v6 及更早
         * 的 "modern" 由版本化迁移归级（无 lowlevelSource → identity-bound、
         * 有合法 lowlevelSource → lowlevel、矛盾 fail closed 原数据保留）。
         */
        version: 8;
        settled: Record<
          string,
          | {
              level: "identity-bound" | "lowlevel" | "legacy";
              settledAtTick: number;
              digest?: string;
              contractDigest?: string;
              authorizationCohortDigest?: string;
              durableIdentityDigest?: string;
              /** 【第十六轮 v6】lowlevel provenance（仅 lowlevel proof 携带；受控枚举）。 */
              lowlevelSource?: string;
              /** 【第十八轮 v8】tr1_ rearm receipt 的 lineage proof（缺 proof 的旧 tr1_ receipt 只作 replay blocker）。 */
              lineageId?: string;
              lineageGeneration?: number;
              parentTransactionId?: string;
              lineageBindingDigest?: string;
            }
          | number
        >;
        updatedAt: number;
        entryCount: number;
        nextExpiryTick: number | null;
      };
      lifecycle?: {
        lastBeginTick?: number;
        lastEndTick?: number;
      };
      /**
       * write-fault marker（第五轮新增、第七轮补严形状契约）：staged commit
       * 意外写故障（receipt/heap/handle 状态发布失败、endTick 时 handle 仍
       * executing 等）的最小、有界持久快照——只保留首个 unresolved 故障
       * （根因），绝不持久化正常 transaction/journal/overlay。phase 分为
       * commit 类（receipt_publish/heap_publish/journal_publish/
       * overlay_publish/handle_state/commit_unexpected——Game 已 OK）与
       * execution-unknown 类（executing_at_end_tick/
       * action_threw_execution_unknown/action_returned_non_ok_abort_failed）
       * ——resolution 的允许性依赖该分类。detail 为 ≤192 字符有界异常摘要。
       * 存在 unresolved marker（含形状损坏的 marker——一律视为存在 fault，
       * fail closed）期间全部 Treasury writer 阻断，只有显式 fault
       * resolution 协议可解除。
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
        detail?: string;
        /** 【第十三轮】forensic marker 绑定的完整 attempt identity（缺失 = legacy forensic proof）。 */
        attemptIdentity?: {
          contractDigest?: string;
          authorizationCohortDigest?: string;
          durableIdentityDigest?: string;
        };
        /**
         * 【第十七轮第十四节 v2】class-aware attempt identity：authority
         * class、lowlevelSource、lineage/rearm binding digest、parent/child
         * generation。缺失（v1 marker）= class 不可证明——class-aware 清除
         * 按 insufficient 保守处理（绝不猜测 class）。
         */
        markerVersion?: 2;
        authorityClass?: "identity-bound" | "lowlevel" | "legacy" | "forensic";
        lowlevelSource?: string;
        lineageBindingDigest?: string;
        attemptGeneration?: number;
      };
      /**
       * durable intent / WAL（第八轮新增、第九轮升级 v2）：Game API 调用
       * 之前的最小持久权威——transaction identity、payload digest、action
       * kind、canonical postings（唯一资产事实副本）、授权身份、完整合同
       * 身份（v2：contractId/contractDigest/adapterVersion）、有界 durable
       * reconciliation payload（v2：adapter.durableFacts 的版本化对账事实，
       * ≤512 字符——不持久化完整 args/observation）、执行 phase、结构
       * incarnation 与有界审计来源。phase 状态机区分"尚未调用 Game API"
       * （ready）与"已进入 callback"（executing/returned_non_ok/
       * ok_pending_commit/execution_unknown 等）；phase 迁移为严格状态机
       * （期望前序 + digest/contract 一致校验，幂等仅限同 identity）。entry
       * key 为 "i:"+transactionId；entryCount 为自有键计数（load 校验与统一
       * recovery slot admission 的 O(1) 权威）；上限 64（与 quarantine 同
       * 上限——一笔 transaction 恒占一个 recovery slot）。global reset 后首次
       * load 全量验证（key 编码/digest/outcome 与 settlement 枚举/postings
       * 逐腿/安全整数/聚合溢出）——损坏与未知版本 fail closed；v1/v2 数据
       * 按保守单调表原子迁移（旧 phase → (outcome, settlement)；未知 phase
       * fail closed）。beginTick 恢复按 (outcome, settlement) 事实等级分级
       * （第十轮：not_started+ready 确认未执行关闭；returned_non_ok/
       * returned_ok 保留事实等级；其余保守转 execution-unknown）；quarantine
       * 写失败时 intent 保留为最终保守权威（emergency intent authority）。
       * 绝不持久化完整 observation/service/journal/任意大 payload。
       */
      intents?: {
        /**
         * v6（第十四轮）：显式 authorityLevel + lowlevel 严格矩阵
         * （lowlevelSource 来源标记必填；迁移定级不再把 partial-modern
         * 归入 lowlevel——部分现代事实一律 forensic 隔离）。
         */
        version: 7;
        entries: Record<
          string,
          {
            transactionId: string;
            /** 【第十三轮】显式 authority 等级（不得由 optional 字段推断）。 */
            authorityLevel: "modern" | "legacy" | "forensic" | "lowlevel";
            /** 【第十四轮】lowlevel 显式来源标记（lowlevel 等级必填）。 */
            lowlevelSource?: string;
            digest: string;
            actionKind: string;
            kind: string;
            source: string;
            authorizationDigest?: string;
            contractId?: string;
            contractDigest?: string;
            adapterVersion?: number;
            /** adapter registration identity（第十二轮：durable identity 重算输入）。 */
            adapterRegistrationId?: string;
            /** 稳定 adapter/reconciler 语义身份（第十二轮 3.5）。 */
            adapterSemanticIdentity?: string;
            durablePayload?: string;
            durablePayloadVersion?: number;
            postings: Array<{
              roomName: string;
              locationKind: string;
              resource: string;
              delta: number;
            }>;
            /** execution outcome（第十轮 v3：事实等级，单调不可回退）。 */
            outcome: string;
            /** settlement workflow state（第十轮 v3：与 outcome 正交）。 */
            settlement: string;
            structureId?: string;
            /** 完整 structure descriptor（第十一轮 v4：bindingKind/role/identity/type/room/incarnation/required/version）。 */
            structureFacts?: Array<{
              bindingKind: string;
              role: string;
              roomName: string;
              locationKind: string;
              structureId: string;
              objectId?: string;
              expectedType?: string;
              expectedRoom?: string;
              required: boolean;
              version: number;
            }>;
            ownerIdentity?: string;
            policyIdentity?: string;
            /** durable authorization cohort 事实（第十一轮 3.13.4；结构见 TreasuryAuthorizationCohortFacts）。 */
            authorizationCohort?: {
              ownerIdentity: string;
              policyId: string;
              policyVersion: number;
              policyRegistrationId: string;
              policyDecisionDigest: string;
              emergencyOverride: boolean;
              epochSeq: number;
              revisions: {
                commitmentRevision: number;
                projectionRevision: number;
                quarantineRevision: number;
                intentRevision: number;
                reservationStoreRevision: number;
              };
              adapterRegistrationId: string;
              contractId: string;
              contractDigest: string;
              transactionId: string;
              authorizationLegDigests: string[];
              receiverCapacityDigest: string;
              issuedTick: number;
              authorizationDigest: string;
            };
            /** canonical cohort digest（Treasury 计算）。 */
            authorizationCohortDigest?: string;
            /** 统一 durable action identity digest（第十一轮 3.13.5；第十二轮 load 重算验证）。 */
            durableIdentityDigest?: string;
            /** 【第十七轮第十一节】tr1_ rearm child 的 lineage/rearm binding digest（initial attempt 不携带）。 */
            lineageBindingDigest?: string;
            auditSource?: string;
            createdAtTick: number;
            updatedAtTick: number;
          }
        >;
        entryCount: number;
        updatedAt: number;
      };
      /**
       * durable quarantine（第六轮新增、第七轮升级版本化 schema v1）：
       * executing（Game 结果未知）或 commit-faulted 的 prepared transaction
       * 转入的持久隔离——跨 global reset 与 service 重建存活，继续占用
       * 资源、容量与 transaction identity（授权计入流出量、正净流入占用
       * free capacity），不进入 committed projection。entry key 为
       * "q:"+transactionId；entryCount 为自有键计数（load 校验与 fault-slot
       * admission 的 O(1) 权威）；prepare admission 保证 持久条目数 +
       * active handle 数 < 64（第 65 条 fault 在 prepare 前被拒，不再产生
       * 溢出丢 identity 的路径）；overflowed 为第六轮 legacy 溢出标志
       * （存在即永久 fail closed，显式 repair 才可清除）。deltas 为单一
       * canonical posting 事实（容量占用由其派生）。v2（第十轮 5.1 durable
       * authority cohesion）：entry 保留完整合同事实（contract ID/digest、
       * actionKind、adapterVersion、durable payload/version、authorization
       * bundle digest、owner/policy identity、structure incarnation facts）
       * 与 execution outcome（事实等级，单调）+ settlement（隔离态）——
       * global reset 后可重建完整 action-specific reconciler 输入；v1 数据
       * load 时原子迁移（phase 单调推导 outcome、并存 intent 合同事实合并、
       * 无并存 intent 标记 legacyV1——不参与 contract-backed resolution）。
       * global reset 后首次 load 全量验证（key 编码/digest/phase/outcome/
       * settlement/合同字段枚举/非零安全整数/聚合溢出）——损坏 fail closed
       * （原数据不动、新 prepare 阻断、resolution 拒绝）。解除只有显式
       * fault resolution。
       */
      quarantine?: {
        /**
         * v5（第十四轮）：lowlevel 严格矩阵（lowlevelSource 来源标记必填；
         * 迁移定级不再把 partial-modern 归入 lowlevel——部分现代事实一律
         * forensic 隔离）。
         */
        version: 6;
        entries: Record<
          string,
          {
            /** 【第十三轮】显式 authority 等级（不得由 optional 字段推断）。 */
            authorityLevel: "modern" | "legacy" | "forensic" | "lowlevel";
            /** 【第十四轮】lowlevel 显式来源标记（lowlevel 等级必填）。 */
            lowlevelSource?: string;
            transactionId: string;
            digest: string;
            tick: number;
            kind: string;
            source: string;
            phase: string;
            deltas: Array<{
              roomName: string;
              locationKind: string;
              resource: string;
              delta: number;
            }>;
            recordedAt: number;
            /** execution outcome（第十轮 v2：事实等级，单调不可回退）。 */
            outcome: string;
            /** settlement workflow state（隔离态恒 quarantined；resolving 由 staged resolution 驱动）。 */
            settlement: string;
            contractId?: string;
            contractDigest?: string;
            actionKind?: string;
            adapterVersion?: number;
            /** adapter registration identity（第十二轮：durable identity 重算输入）。 */
            adapterRegistrationId?: string;
            /** 稳定 adapter/reconciler 语义身份（第十二轮 3.5）。 */
            adapterSemanticIdentity?: string;
            durablePayload?: string;
            durablePayloadVersion?: number;
            authorizationDigest?: string;
            ownerIdentity?: string;
            policyIdentity?: string;
            /** 完整 structure descriptor（第十一轮 v3：与 intent structureFacts 同形状）。 */
            structureFacts?: Array<{
              bindingKind: string;
              role: string;
              roomName: string;
              locationKind: string;
              structureId: string;
              objectId?: string;
              expectedType?: string;
              expectedRoom?: string;
              required: boolean;
              version: number;
            }>;
            /** durable authorization cohort 事实（第十一轮 3.13.4；结构见 TreasuryAuthorizationCohortFacts）。 */
            authorizationCohort?: {
              ownerIdentity: string;
              policyId: string;
              policyVersion: number;
              policyRegistrationId: string;
              policyDecisionDigest: string;
              emergencyOverride: boolean;
              epochSeq: number;
              revisions: {
                commitmentRevision: number;
                projectionRevision: number;
                quarantineRevision: number;
                intentRevision: number;
                reservationStoreRevision: number;
              };
              adapterRegistrationId: string;
              contractId: string;
              contractDigest: string;
              transactionId: string;
              authorizationLegDigests: string[];
              receiverCapacityDigest: string;
              issuedTick: number;
              authorizationDigest: string;
            };
            /** canonical cohort digest（Treasury 计算）。 */
            authorizationCohortDigest?: string;
            /** 统一 durable action identity digest（第十二轮 load 重算验证）。 */
            durableIdentityDigest?: string;
            /** 【第十七轮第十一节】tr1_ rearm child 的 lineage binding（从 intent 事实转移继承）。 */
            lineageBindingDigest?: string;
            /** v1 迁移且无并存 intent 补全（不参与 contract-backed resolution）。 */
            legacyV1?: boolean;
            /** forensic incomplete authority（第十二轮 3.8：intent 缺失时的防御性直写，隔离不自动解释）。 */
            forensic?: { reason: "intent_missing_fallback"; detail: string };
          }
        >;
        entryCount: number;
        overflowed?: boolean;
      };
      /**
       * pre-execution authorization fault authority（第十一轮新增 version 1）：
       * internal_authorization_fault（Game callback 未调用且 authorization
       * 已完整回滚）的可恢复 durable not-started authority——redemption 注入
       * 故障回滚后、写 write-fault marker 前建立；acknowledge-rolled-back
       * resolution（not-executed final tombstone + preExecution 标志）解除并
       * 释放 marker 与 entry。entry key 为 "af:"+transactionId；上限 64；
       * load 全量验证，未知版本/损坏 fail closed。不再形成无恢复路径的
       * 永久全局锁。
       */
      authorizationFaults?: {
        /**
         * v4（第十四轮）：lowlevel 严格矩阵（lowlevelSource 来源标记必填）+
         * health probe metadata 门禁 + read-back 完整身份比较。
         */
        version: 4;
        entries: Record<
          string,
          {
            /** 【第十三轮】显式 authority 等级（不得由 optional 字段推断）。 */
            authorityLevel: "modern" | "legacy" | "forensic" | "lowlevel";
            /** 【第十四轮】lowlevel 显式来源标记（lowlevel 等级必填）。 */
            lowlevelSource?: string;
            transactionId: string;
            digest: string;
            contractId?: string;
            contractDigest?: string;
            actionKind?: string;
            authorizationDigest?: string;
            authorizationCohortDigest?: string;
            /** 完整 cohort facts（第十二轮 3.2；结构见 TreasuryAuthorizationCohortFacts）。 */
            authorizationCohort?: Record<string, unknown>;
            adapterVersion?: number;
            adapterRegistrationId?: string;
            adapterSemanticIdentity?: string;
            ownerIdentity?: string;
            policyIdentity?: string;
            structureFacts?: Array<Record<string, unknown>>;
            durableIdentityDigest?: string;
            /** 【第十七轮第十一节】tr1_ rearm child 的 lineage binding（从 intent 事实转移继承）。 */
            lineageBindingDigest?: string;
            /** v1 迁移 entry（身份事实不完整——仅按 digest 匹配的旧协议解除）。 */
            legacyV1?: boolean;
            postings: Array<{
              roomName: string;
              locationKind: string;
              resource: string;
              delta: number;
            }>;
            faultTick: number;
            outcome: "not_started";
            rollbackConfirmed: true;
            source: string;
            detail?: string;
          }
        >;
        entryCount: number;
        updatedAt: number;
      };
      /**
       * resolution tombstone（第七轮新增、第八轮升级 version 2 + staged）：
       * 显式 fault resolution 的有界幂等记录与 staged 状态机载体——key 为
       * "r:"+transactionId，使 receipt retention 过期后的重复管理调用仍能
       * 返回 already_resolved 而非模糊 not_found。stage：resolving = staged
       * resolution 进行中（中断后由 beginTick 的 recoverStagedResolutions
       * 幂等恢复——receipt 已写则 finalize、无进展则回滚）；final = 完成。
       * actionTick 保留原始动作 tick 供审计（settledAtTick 才是 receipt
       * retention 起点——resolve-as-committed 会将既有 receipt 真正刷新到
       * resolution tick）。reconcilerKind 记录结论来源的注册 reconciler。
       * entryCount 为自有键计数（load 校验权威）；上限 256 条；写入时惰性
       * 清理 resolvedAtTick 超过 5000 tick 的过期项；超上限且无可清理时在
       * 任何原状态变化之前拒绝（fail closed，绝不丢弃已存 tombstone）。
       * v1（无 entryCount/stage）无损升级；损坏/未知版本 fail closed。
       */
      resolutions?: {
        /**
         * v6（第十六轮）：lowlevel proof 绑定显式 provenance（lowlevelSource
         * 受控枚举；v5 及更早的低层 tombstone 无此字段 = 来源不可证明的隔离
         * 态，不自动释放）；v5（第十五轮第八节）：显式 forensic 管理
         * provenance（forensicProvenance——migration-derived forensic 无此
         * 字段 → 永久隔离）。
         * v4（第十四轮第十一节）：显式 proof class（identity-bound/lowlevel/
         * legacy/forensic——required/forbidden 身份字段矩阵由 proofLevel 声明，
         * 不再由 optional 字段存在性隐式猜测；v3 迁移：全身份 → identity-
         * bound、全缺 → legacy、部分 → forensic 隔离）。
         */
        version: 7;
        entries: Record<
          string,
          {
            transactionId: string;
            digest: string;
            resolution: "committed" | "not-executed";
            stage: "resolving" | "final";
            /** 【第十四轮】显式 proof class。 */
            proofLevel: "identity-bound" | "lowlevel" | "legacy" | "forensic";
            actionTick: number;
            settledAtTick?: number;
            observationTick: number;
            resolvedAtTick: number;
            reconcilerKind?: string;
            source?: string;
            preExecution?: boolean;
            contractDigest?: string;
            authorizationCohortDigest?: string;
            durableIdentityDigest?: string;
            /** 【第十六轮 v6】lowlevel provenance（仅 proofLevel=lowlevel 携带）。 */
            lowlevelSource?: string;
            /** 【第十五轮 v5】显式 forensic 管理 provenance（仅 proofLevel=forensic 携带）。 */
            forensicProvenance?: {
              protocol: string;
              acknowledgement: "explicit_management";
              confirmedBy?: string;
              capabilityDigest?: string;
              attempt: {
                digest: string;
                contractDigest?: string;
                authorizationCohortDigest?: string;
                durableIdentityDigest?: string;
              };
              confirmedAtTick: number;
              source: string;
              allowAutomaticCompletion: boolean;
            };
          }
        >;
        entryCount: number;
        updatedAt: number;
      };
      /**
       * 【第十七轮第五节】durable attempt lineage / retired-attempt store（v1）：
       * 每条业务重试链一个有界 record——root/current attempt ID 与完整
       * identity、generation、状态机（retiring → rearm_ready → capability_
       * issued → child_intent_pending → child_active → chain_committed；或
       * non_rearmable_retired / forensic_isolated）、next child、retry
       * semantic digest、authority class、retirement 三段完成标志。
       * entry key 为 "l:"+rootTransactionId；硬容量 64（满载 fail closed，
       * 不驱逐——普通运行不得自动删除 record）；root/current/next-child
       * O(1) 索引（global reset 首次 load 一次全表验证重建；索引只是定位
       * 器、Memory record 是权威）。root attempt ID 只要存在 lineage record
       * 即永久 retired（final not-executed tombstone 按普通 retention 驱逐
       * 后仍阻断同 ID 直接 prepare——驱逐资格 = lineage replacement 完整）。
       */
      attemptLineage?: {
        version: 1;
        entries: Record<
          string,
          {
            lineageId: string;
            rootTransactionId: string;
            rootIdentity: {
              digest: string;
              contractDigest?: string;
              authorizationCohortDigest?: string;
              durableIdentityDigest?: string;
              lowlevelSource?: string;
            };
            currentTransactionId: string;
            currentIdentity: {
              digest: string;
              contractDigest?: string;
              authorizationCohortDigest?: string;
              durableIdentityDigest?: string;
              lowlevelSource?: string;
            };
            actionKind: string;
            adapterSemanticIdentity?: string;
            ownerIdentity?: string;
            generation: number;
            state:
              | "retiring"
              | "rearm_ready"
              | "capability_issued"
              | "child_intent_pending"
              | "child_active"
              | "chain_committed"
              | "non_rearmable_retired"
              | "forensic_isolated";
            resolutionState: "unresolved" | "not_executed" | "committed";
            nextChildTransactionId?: string;
            retrySemanticDigest?: string;
            authorityClass: "identity-bound" | "lowlevel";
            lowlevelSource?: string;
            bindingDigest?: string;
            rearmable: boolean;
            nonRearmReason?: string;
            retirement: {
              lineagePublished: boolean;
              authorityReleased: boolean;
              markerCleaned: boolean;
            };
            recordRevision: number;
            createdAtTick: number;
            updatedAtTick: number;
          }
        >;
        entryCount: number;
        updatedAt: number;
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
