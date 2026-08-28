import type { CreepConfig } from "@/types/system";
import type { DirectAutomationState } from "@/runtime/marketSaleDirectAutomation";
import type {
  ContinuousPendingProjection,
  MarketDirectContinuousAutomationState,
} from "@/runtime/marketDirectContinuousAutomation";
import type { PendingDirectDeal } from "@/runtime/marketSaleDirectPending";
import type { MarketSaleFeeLedgerState } from "@/runtime/marketSaleFeeLedger";
import type {
  MarketAccountClaim,
  MarketActionJournalEntry,
} from "@/runtime/marketActionArbiter";
import type { MarketBaseResourceV3RuntimeState } from "@/runtime/marketBaseResourceAutomation";
import type {
  MarketBaseResourceActivationAnchor,
  MarketBaseResourceContinuousReviewSnapshot,
} from "@/runtime/marketSaleAutomation";
import type { RemoteMiningTask } from "@/runtime/remoteMining";

declare global {
  interface ScreepsMemoryData {
    creepConfigs?: Record<string, CreepConfig>;
    manualUpgraders?: Record<
      string,
      {
        createdAt: number;
        updatedAt: number;
        maintenance?: true;
      }
    >;
    marketSaleAutomation?: {
      managedOrders: Record<
        string,
        {
          orderId: string;
          roomName: string;
          resourceType: ResourceConstant;
          price: number;
          originalAmount: number;
          lastRemainingAmount: number;
          remainingExposure: number;
          feeDebtMilli: number;
          createdAt: number;
          lastSeenAt: number;
          lastFillAt?: number;
          policyCancelAtTick: number;
          /** Public Game.market Order.created value (game tick). */
          serverCreatedTick: number;
          backoffUntil?: number;
          externalMutationGap?: {
            detectedAt: number;
            expectedPrice: number;
            observedPrice: number;
            expectedTotalAmount: number;
            observedTotalAmount?: number;
            conservativeExposure: number;
          };
          disappearanceGap?: {
            detectedAt: number;
            reason:
              | "unknown_disappearance"
              | "server_expiry_refund_mismatch";
          };
        }
      >;
      pendingCreate?: {
        requestId: string;
        requestedAt: number;
        baselineOrderIds: string[];
        baselineHash: string;
        leaseEpoch: string;
        tuple: {
          type: ORDER_BUY | ORDER_SELL;
          resourceType: ResourceConstant;
          roomName?: string;
          price: number;
          totalAmount: number;
          createdNotBefore: number;
          createdNotAfter: number;
        };
        feeMilli: number;
        exposure: number;
        zeroDeltaConfirmations: number;
        lastZeroDeltaTick?: number;
        status: "prepared" | "submitted" | "ambiguous";
        creditsBefore?: number;
        terminalStockBefore?: number;
        outgoingKeysBefore?: string[];
        baselineOrderFingerprints?: Record<string, string>;
        operatorResolutionCandidateIds?: string[];
        audit: Array<{
          tick: number;
          action: string;
          candidateIds: string[];
        }>;
      };
      pendingMutations: Record<
        string,
        {
          kind: "cancel" | "extend" | "reprice";
          orderId: string;
          requestedAt: number;
          pre: {
            price: number;
            totalAmount: number;
            remainingAmount: number;
            active?: boolean;
          };
          requested: {
            price?: number;
            addAmount?: number;
          };
          prospectiveFeeMilli: number;
          conservativeExposure: number;
          status: "prepared" | "submitted" | "reconcile_gap";
        }
      >;
      feeEvents: Array<{
        id: string;
        tick: number;
        resource: ResourceConstant;
        amountMilli: number;
        kind: "create" | "extend" | "reprice" | "refund" | "carry";
      }>;
      feeLedger?: MarketSaleFeeLedgerState;
      carriedFeeDebtMilli: Partial<Record<ResourceConstant, number>>;
      trustedFloors: Partial<
        Record<
          ResourceConstant,
          {
            value: number;
            marketDate: string;
            updatedAt: number;
          }
        >
      >;
      processedTransactionKeys: string[];
      canaryLock?: {
        roomName: string;
        resourceType: ResourceConstant;
        lockedAt: number;
        configRevision: string;
      };
      drain?: {
        phase: "off" | "shadow" | "maker" | "direct" | "hybrid" | "requested" | "draining" | "stopped";
        targetMode?: "off" | "shadow";
        zeroConfirmations: number;
        lastZeroConfirmationTick?: number;
      };
      operatorAudit: Array<{
        tick: number;
        action: string;
        orderId?: string;
        requestId?: string;
        candidateIds?: string[];
      }>;
      directAutomation?:
        | DirectAutomationState
        | (MarketDirectContinuousAutomationState & {
            baseResourceV3?: MarketBaseResourceV3RuntimeState;
          });
      pendingDirectDeals?: Record<
        string,
        Partial<PendingDirectDeal> | ContinuousPendingProjection
      >;
      marketStaging?: Record<string, { amount: number }>;
      marketReservations?: Record<string, { amount: number }>;
      directMarketClaim?: MarketAccountClaim;
      marketActionJournal?: MarketActionJournalEntry[];
      baseResourceV3ActivationAnchor?: MarketBaseResourceActivationAnchor;
      baseResourceV3ActivationAnchorMirror?: MarketBaseResourceActivationAnchor;
      baseResourceV3ActivationBlocker?: {
        schemaVersion: 1;
        hashRevision: "market-base-resource-activation-blocker-v1";
        code: string;
        detectedAt: number;
        detailHash: string;
      };
      baseResourceV3ProposedContinuousReview?: {
        proposalId: string;
        snapshots: readonly MarketBaseResourceContinuousReviewSnapshot[];
      };
      baseResourceV3ProposedTransition?: {
        proposalId: string;
        laneId: string;
        targetStage: "canary" | "continuous" | "suspend";
        transitionLaneIds: readonly string[];
      };
    };
    resourceControl?: {
      taskSchemaVersion?: number;
      tasks?: Record<
        string,
        {
          id: string;
          resource: ResourceConstant;
          fromRoomName: string;
          toRoomName: string;
          amount: number;
          remainingAmount: number;
          status: "pending" | "done" | "cancelled" | "failed";
          createdAt: number;
          updatedAt: number;
          origin: "manual" | "automatic";
          lastProgressAt: number;
          blockedReason?: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee";
          blockedSince?: number;
          reason?: string;
          lastError?: string;
        }
      >;
    };
    factoryTasks?: Record<
      string,
      {
        id: string;
        roomName: string;
        type: "decompress_battery";
        status: "pending" | "loading" | "producing" | "unloading" | "done" | "cancelled" | "failed";
        requestedBatteryAmount: number;
        remainingBatteryAmount: number;
        producedEnergyAmount: number;
        createdAt: number;
        updatedAt: number;
        completedAt?: number;
        lastError?: string;
      }
    >;
    colonization?: Record<
      string,
      {
        targetRoom: string;
        sourceRoom: string;
        status: "claiming" | "clearing" | "waiting_plan" | "bootstrapping" | "managed";
        mode?: "normal" | "npcStronghold";
        flagName: string;
        planReady: boolean;
        claimCompleted: boolean;
        scoutSafe?: boolean;
        scoutRouteRooms?: string[];
        cachedTravelPath?: {
          key: string;
          sourceRoom: string;
          targetRoom: string;
          routeRooms: string[];
          positions: { x: number; y: number; roomName: string }[];
          generatedAt: number;
        };
        /** 持久路径生成失败/被运行时验证删除后的重试节流（同一 key）。 */
        travelPathRetryAt?: number;
        travelPathRetryKey?: string;
        dangerousRooms?: string[];
        temporaryDangerousRooms?: Record<string, number>;
        permanentDangerousRooms?: string[];
        scoutedAt?: number;
        safeRouteRetryAt?: number;
        safeRouteRetryKey?: string;
        createdAt: number;
        updatedAt: number;
      }
    >;
    war?: Record<
      string,
      {
        targetRoom: string;
        sourceRoom: string;
        status: "queued" | "staging" | "clearing" | "downgrading" | "patrol_waiting" | "done" | "failed";
        reason: "npc_reservation" | "manual";
        routeRooms?: string[];
        squad?: "standard" | "t3Duo";
        boostTier?: "t3";
        boostLabs?: string[];
        boostStatus?: "preparing" | "ready" | "failed";
        oneShot?: boolean;
        failReason?: string;
        attempts: number;
        createdAt: number;
        updatedAt: number;
        statusSince?: number;
        lastHostileSeenAt?: number;
        clearSince?: number;
        completedAt?: number;
        assetsReleasedAt?: number;
        controllerAttackerLastQueuedAt?: number;
        generationCounter?: number;
        activeGeneration?: {
          id: number;
          phase: "preparing" | "assembling" | "deployed";
          createdAt: number;
          boostTaskId: string;
          boostGateOpenedAt?: number;
          deployedAt?: number;
          configNames: {
            meleeAttacker: string;
            healer: string;
          };
        };
        patrolRooms?: string[];
        patrolIndex?: number;
        patrolInterval?: number;
        patrolNextSweepAt?: number;
      }
    >;
    roomPlanner?: {
      [roomName: string]: {
        layout: { [structureType: string]: { x: number; y: number }[] };
        timestamp: string;
        savedAt: number;
      };
    };
    rescue?: Record<
      string,
      {
        targetRoom: string;
        sourceRoom: string;
        status: "bootstrapping" | "managed";
        flagName: string;
        routeRooms?: string[];
        createdAt: number;
        updatedAt: number;
      }
    >;
    flagHauling?: Record<
      string,
      {
        targetRoom: string;
        sourceRoom: string;
        flagName: string;
        targetX: number;
        targetY: number;
        createdAt: number;
        updatedAt: number;
      }
    >;
    crossShardColonization?: Record<
      string,
      {
        targetShard: string;
        targetRoom: string;
        preferredSourceRoom?: string;
        sourceRoom?: string;
        status:
          | "planning"
          | "ready"
          | "spawning"
          | "in_transit"
          | "claimed"
          | "bootstrapping"
          | "completed"
          | "blocked"
          | "failed";
        flagName: string;
        reason?: string;
        portalId?: string;
        portalRoom?: string;
        destinationRoom?: string;
        claimerConfigName?: string;
        claimerName?: string;
        bootstrapConfigNames?: string[];
        bootstrapDispatchedAt?: number;
        launchedAt?: number;
        claimedAt?: number;
        completedAt?: number;
        lastObservedAt?: number;
        createdAt: number;
        updatedAt: number;
        lastReadyAt?: number;
      }
    >;
    interShardPortals?: Record<
      string,
      {
        id: string;
        originRoom: string;
        destinationShard: string;
        destinationRoom?: string;
        discoveredAt: number;
        lastSeenAt: number;
        ticksToDecay?: number;
      }
    >;
    powerBankHarvest?: Record<string, PowerBankHarvestTask>;
    powerBankHarvestHistory?: PowerBankHarvestHistoryEntry[];
    remoteMining?: Record<string, RemoteMiningTask>;
  }
}

export {};
