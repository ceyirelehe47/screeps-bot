import type { CreepApi, RoleName } from "@/types/system";
import type { HubProgressSnapshot } from "@/runtime/hubProgress";
import type { CpuMonitorHeapSnapshot } from "@/runtime/cpuMonitor";
import type { AddFactoryTaskResult, CancelFactoryTaskResult, FactoryTask } from "@/runtime/factoryControl";
import type { StartWarOptions, StartWarPatrolOptions, StartWarPatrolResult, StartWarResult, StopWarOptions, StopWarResult, WarStatusSnapshot } from "@/runtime/warControl";
import type { RemoteDefenseStatusSnapshot } from "@/runtime/console/remoteDefenseCommands";
import type { MarketDirectContinuousPermitRequest } from "@/runtime/marketDirectContinuousAutomation";
import type { OperatorDirectPendingEvidence } from "@/runtime/marketSaleDirectPending";
import type { MarketBaseResourcePermitRequest } from "@/runtime/marketSaleAutomation";
import type { PowerCreepTask } from "@/runtime/powerCreepTypes";

type ResourceTransferTaskConsoleRecord = {
  id: string;
  resource: ResourceConstant;
  fromRoomName: string;
  toRoomName: string;
  amount: number;
  remainingAmount: number;
  status: "pending" | "done" | "cancelled" | "failed";
  createdAt: number;
  updatedAt: number;
  reason?: string;
  lastError?: string;
};

type ManualResourceTransferRequest =
  | [toRoomName: string, resource: ResourceConstant, amount: number, reason?: string]
  | {
      toRoomName: string;
      resource: ResourceConstant;
      amount: number;
      reason?: string;
    };

type AddResourceTransferTasksResult = {
  ok: true;
  fromRoomName: string;
  created: ResourceTransferTaskConsoleRecord[];
  errors: Array<{
    index: number;
    request: ManualResourceTransferRequest;
    error: string;
  }>;
};

declare global {
  const __BUILD_VERSION__: string;
  const __BUILD_GIT_HASH__: string;
  const __BUILD_TIME__: string;
  const __BUILD_TAG__: string;
  const __BUILD_COMMIT__: string;
  const __BUILD_TREE__: string;
  const __BUILD_BRANCH__: string;
  const __BUILD_DIRTY__: string;
  const __BUILD_DEPLOY_BRANCH__: string;

  var creepApi: CreepApi;
  var __screepsMounted: boolean | undefined;
  var RP: (
    room: string | Room,
    showPlan?: boolean,
  ) => { [structureType: string]: { x: number; y: number }[] } | false;
  var runPlan: (room: string | Room) => boolean;
  var visualizePlan: (roomName: string) => boolean;
  var listPlanCache: () => void;
  var clearRoomPlanCache: (roomName: string) => void;
  var savePlanToMemory: (roomName: string) => boolean;
  var reportProduction: (roomName?: string) => void;
  var reportProductionGlobal: () => void;
  var grantMarketSaleMutationLease:
    | typeof import("@/runtime/marketSaleAutomation").grantMarketSaleMutationLease
    | undefined;
  var revokeMarketSaleMutationLease:
    | typeof import("@/runtime/marketSaleAutomation").revokeMarketSaleMutationLease
    | undefined;
  var attestMarketSalePendingCreate:
    | typeof import("@/runtime/marketSaleAutomation").attestMarketSalePendingCreate
    | undefined;
  var resolveMarketSalePendingCreateAbsence:
    | typeof import("@/runtime/marketSaleAutomation").resolveMarketSalePendingCreateAbsence
    | undefined;
  var resolveMarketSaleExternalOrderMutation:
    | ((
        orderId: string,
        verifiedRemainingFeeDebtMilli: number,
      ) => {
        ok: boolean;
        error?: string;
        carriedFeeDebtMilli?: number;
      })
    | undefined;
  var resolveMarketSaleOrderDisappearance:
    | ((
        orderId: string,
        classification: "policy_cancelled" | "server_expired",
        verifiedRefundMilli?: number,
      ) => {
        ok: boolean;
        error?: string;
        refundedFeeDebtMilli?: number;
        carriedFeeDebtMilli?: number;
      })
    | undefined;
  var expandMarketSaleCanary:
    | typeof import("@/runtime/marketSaleAutomation").expandMarketSaleCanary
    | undefined;
  var emergencyStopMarketSaleAutomation:
    | typeof import("@/runtime/marketSaleAutomation").emergencyStopMarketSaleAutomation
    | undefined;
  var marketSaleAutomationStatus:
    | typeof import("@/runtime/marketSaleAutomation").marketSaleAutomationStatus
    | undefined;
  var resolveMarketSaleDirectPending:
    | ((
        evidence: OperatorDirectPendingEvidence,
      ) => {
        ok: boolean;
        error?: string;
        duplicate?: boolean;
      })
    | undefined;
  var proposeMarketDirectContinuousPermit:
    | ((
        request: MarketDirectContinuousPermitRequest,
      ) => {
        ok: boolean;
        error?: string;
        permit?: unknown;
        accountIdentity?: string;
      })
    | undefined;
  var acceptMarketDirectContinuousPermit:
    | ((
        permitId: string,
      ) => {
        ok: boolean;
        error?: string;
        permitId?: string;
        idempotent?: boolean;
      })
    | undefined;
  var marketDirectContinuousStatus:
    | (() => unknown)
    | undefined;
  var proposeMarketBaseResourcePermit:
    | ((
        request?: MarketBaseResourcePermitRequest,
      ) => {
        ok: boolean;
        error?: string;
        [key: string]: unknown;
      })
    | undefined;
  var proposeMarketBaseResourcePolicyMigration:
    | (() => {
        ok: boolean;
        error?: string;
        [key: string]: unknown;
      })
    | undefined;
  var acceptMarketBaseResourcePermit:
    | ((
        proposalId: string,
      ) => {
        ok: boolean;
        error?: string;
        [key: string]: unknown;
      })
    | undefined;
  var marketBaseResourceStatus:
    | (() => unknown)
    | undefined;
  var spawnMaxCarrier:
    typeof import("@/runtime/console/operationsCommands").spawnMaxCarrierCommand;
  var spawnMaxCarrierRaw:
    typeof import("@/runtime/console/operationsCommands").spawnMaxCarrierRaw;
  var startUpgrader: (roomName: string) => string;
  var startUpgraderRaw: (roomName: string) => unknown;
  var stopUpgrader: (roomName: string) => string;
  var stopUpgraderRaw: (roomName: string) => unknown;
  var upgraderStatus: (roomName?: string) => string;
  var upgraderStatusRaw: (roomName?: string) => unknown;
  var stopColonization: (targetRoom?: string) => string;
  var stopColonizationRaw: (targetRoom?: string) =>
    | {
        ok: true;
        scope: "all" | "room";
        targetRoom?: string;
        stoppedColonizationRooms: string[];
        stoppedCrossShardTasks: string[];
        stoppedWarRooms: string[];
        removedConfigs: number;
        removedQueuedTasks: number;
        cancelledSpawns: number;
        suicidedCreeps: number;
      }
    | string;
  var stopWar: (targetRoom: string, suicide?: boolean) => string;
  var stopWarRaw: (targetRoom: string, options?: StopWarOptions) => StopWarResult | string;
  var startWar: (targetRoom: string, sourceRoom: string, squad?: "standard" | "t3Duo", routeRooms?: string[] | string, oneShot?: boolean) => string;
  var startWarRaw: (targetRoom: string, sourceRoom: string, options?: StartWarOptions) => StartWarResult | string;
  var startWarPatrol: (sourceRoom: string, targetRooms: string[] | string, intervalTicks?: number) => string;
  var startWarPatrolRaw: (sourceRoom: string, targetRooms: string[] | string, options?: StartWarPatrolOptions) => StartWarPatrolResult | string;
  var warStatus: (targetRoom?: string) => string;
  var warStatusRaw: (targetRoom?: string) => WarStatusSnapshot;
  var startTelemetry: (sampleInterval?: number, segmentId?: number) => string;
  var startTelemetryRaw: (sampleInterval?: number, segmentId?: number) =>
    | {
        ok: true;
        enabled: boolean;
        previousEnabled: boolean;
        sampleInterval: number;
        segmentId: number;
      }
    | string;
  var stopTelemetry: () => string;
  var stopTelemetryRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    segmentId: number;
  };
  var statusTelemetry: () => string;
  var statusTelemetryRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    segmentId: number;
  };
  var startCpuProfiler: (sampleInterval?: number, historyLimit?: number) => string;
  var startCpuProfilerRaw: (sampleInterval?: number, historyLimit?: number) =>
    | {
        ok: true;
        enabled: boolean;
        previousEnabled: boolean;
        sampleInterval: number;
        historyLimit: number;
      }
    | string;
  var stopCpuProfiler: () => string;
  var stopCpuProfilerRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    historyLimit: number;
  };
  var statusCpuProfiler: () => string;
  var statusCpuProfilerRaw: () => {
    ok: true;
    enabled: boolean;
    previousEnabled: boolean;
    sampleInterval: number;
    historyLimit: number;
  };
  var cpuMonitor: () => string;
  var cpuMonitorRaw: () => {
    ok: true;
    version: 2;
    enabled: boolean;
    sampleInterval: number;
    historyLimit: number;
    historySize: number;
    latest:
      | {
          tick: number;
          shard: string;
          totalUsed: number;
          bucket: number;
          limit: number;
          tickLimit: number;
          phases: Record<string, number>;
          fixedActionCounts: Record<string, number>;
          untracked: number;
          emaTotalUsed: number;
          rooms: Record<
            string,
            {
              totalUsed: number;
              roles: Record<string, { count: number; used: number }>;
            }
          >;
          heap: CpuMonitorHeapSnapshot | null;
        }
      | null;
    recentHistory: Array<{
      tick: number;
      shard: string;
      totalUsed: number;
      bucket: number;
      limit: number;
      tickLimit: number;
      phases: Record<string, number>;
      fixedActionCounts: Record<string, number>;
      untracked: number;
      emaTotalUsed: number;
      rooms: Record<
        string,
        {
          totalUsed: number;
          roles: Record<string, { count: number; used: number }>;
        }
      >;
      heap: CpuMonitorHeapSnapshot | null;
    }>;
    summary:
      | {
          ticks: number;
          avgTotalUsed: number;
          maxTotalUsed: number;
          minBucket: number;
          maxBucket: number;
          avgBucket: number;
          avgUntracked: number;
          avgPhases: Record<string, number>;
          avgFixedActionCounts: Record<string, number>;
          emaTotalUsed: number;
        }
      | null;
  };
  var statusSynthesisControl: () => string;
  var statusSynthesisControlRaw: () => {
    ok: true;
    enabled: boolean;
    state:
      | {
          updatedAt: number;
          generatedTaskCount: number;
          failedTaskCount: number;
          successfulRunCount: number;
          lastActions: string[];
        }
      | null;
  };
  var statusHub: () => string;
  var statusHubRaw: () => Record<string, unknown>;
  var stopHub: () => string;
  var stopHubRaw: () => Record<string, unknown>;
  var hubProgress: () => string;
  var hubProgressRaw: () => HubProgressSnapshot;
  var memoryAudit: typeof import("@/runtime/consoleCommands").memoryAudit;
  var memoryAuditRaw: typeof import("@/runtime/consoleCommands").memoryAuditRaw;
  var addResourceTransferTask: (
    fromRoomName: string,
    toRoomName: string,
    resource: ResourceConstant,
    amount: number,
    reason?: string,
  ) => string;
  var addResourceTransferTaskRaw: (
    fromRoomName: string,
    toRoomName: string,
    resource: ResourceConstant,
    amount: number,
    reason?: string,
  ) =>
      | {
          ok: true;
          task: ResourceTransferTaskConsoleRecord;
        }
      | string;
  var addResourceTransferTasks: (
    fromRoomName: string,
    requests: ManualResourceTransferRequest[],
    reason?: string,
  ) => string;
  var addResourceTransferTasksRaw: (
    fromRoomName: string,
    requests: ManualResourceTransferRequest[],
    reason?: string,
  ) => AddResourceTransferTasksResult | string;
  var cancelResourceTransferTask: (taskId: string) => string;
  var cancelResourceTransferTaskRaw: (taskId: string) =>
    | {
        ok: true;
        taskId: string;
        previousStatus: "pending" | "done" | "cancelled" | "failed";
      }
    | string;
  var listResourceTransferTasks: () => string;
  var listResourceTransferTasksRaw: () => {
    ok: true;
    tasks: ResourceTransferTaskConsoleRecord[];
  };
  var addFactoryTask: (roomName: string, type: "decompress_battery", amount: number) => string;
  var addFactoryTaskRaw: (roomName: string, type: "decompress_battery", amount: number) => AddFactoryTaskResult | string;
  var decompressBattery: (roomName: string, amount: number) => string;
  var decompressBatteryRaw: (roomName: string, amount: number) => AddFactoryTaskResult | string;
  var cancelFactoryTask: (taskId: string) => string;
  var cancelFactoryTaskRaw: (taskId: string) => CancelFactoryTaskResult | string;
  var listFactoryTasks: (roomName?: string) => string;
  var listFactoryTasksRaw: (roomName?: string) => FactoryTask[];
  var remoteDefenseStatus: (targetRoom: string) => string;
  var remoteDefenseStatusRaw: (targetRoom: string) => RemoteDefenseStatusSnapshot | string;
  var powerBankStatus: () => string;
  var powerBankStatusRaw: () => PowerBankStatusSnapshot;

  type PowerBankHarvestStatus =
    | "discovered"
    | "preparing_boosts"
    | "spawning"
    | "boosting"
    | "renewing"
    | "travelling"
    | "attacking"
    | "hauling"
    | "complete"
    | "failed"
    | "aborted";

  type PowerBankReinforcementStage = "spawning" | "renewing" | "boosting" | "travelling" | "attacking";

  type PowerBankHarvestTier = 6 | 7 | 8;

  type PowerBankHarvestOutcome =
    | "success"
    | "partial"
    | "expired"
    | "contested"
    | "zero_yield"
    | "lost"
    | "aborted"
    | "failed";

  interface PowerBankReinforcementState {
    index: number;
    generation?: number;
    stage: PowerBankReinforcementStage;
    attackerId?: string;
    healerId?: string;
    attackerReady?: boolean;
    healerReady?: boolean;
    combatReady?: boolean;
    boostOwnerId?: string;
    boostLabs?: string[];
    lastMemberChangeAt?: number;
    /** Tick when the current reinforcement stage was first observed. */
    stageEnteredAt?: number;
    /** Tick when stage/ownership changed or the pair reached a recently unseen position. */
    lastProgressAt?: number;
    /** Current compact position signature for the reinforcement pair. */
    lastPairPosKey?: string;
    /** Stage/member ownership signature for the current progress window. */
    progressIdentityKey?: string;
    /** Bounded recent position history used to detect short movement cycles. */
    recentPairPosKeys?: string[];
    /** Reinforcement-local blocker, independent from active Bank progress. */
    blocker?: string;
    /** Last tick when a stalled travelling pair had movement state cleared. */
    lastRepathAt?: number;
  }

  interface PowerBankHarvestTask {
    id: string;
    status: PowerBankHarvestStatus;
    sourceRoom: string;
    targetRoom: string;
    bankId: string;
    bankPos: { x: number; y: number };
    hits: number;
    power: number;
    ticksToDecay: number;
    freeTiles: number;
    discoveredTick: number;
    lastSeenTick: number;
    attackerId?: string;
    healerId?: string;
    haulerIds: string[];
    boostLabs: string[];
    compoundTransferTaskIds: string[];
    /** Body tier (RCL number) selected by viability assessment. */
    tier?: PowerBankHarvestTier;
    /** Linear distance from source room to target room. */
    routeDistance?: number;
    /** Number of haulers needed to collect the dropped power. */
    haulerCount?: number;
    /** Viability failure reason(s), set when status becomes failed. */
    failReason?: string;
    /** Tick when task entered a terminal state (complete/failed/aborted). */
    terminalTick?: number;
    /** Whether the attacker has been fully boosted and is ready. */
    attackerReady?: boolean;
    /** Whether the healer has been fully boosted and is ready. */
    healerReady?: boolean;
    /** Tick when the task entered hauling after the bank disappeared. */
    haulingStartedTick?: number;
    /** Tick when the target room was visible with no dropped power remaining. */
    haulingEmptySince?: number;
    /** Optional replacement combat pair prepared while the active pair keeps attacking. */
    reinforcement?: PowerBankReinforcementState;
    /** Absolute tick at which the observed bank is expected to decay. */
    bankExpiresAt?: number;
    /** Tick at which the current status was entered. */
    stageEnteredAt?: number;
    /** Tick of the most recent state, hits, member, pickup or delivery progress. */
    lastProgressAt?: number;
    /** Last observed bank hits used by the attacking watchdog. */
    lastBankHits?: number;
    /** Last tick at which bank hits decreased. */
    lastBankProgressAt?: number;
    /** Most recent tick on which the target room or bank was visible. */
    lastVisibleAt?: number;
    /** Stable machine-readable reason why the task cannot currently advance. */
    blocker?: string;
    /** Earliest tick at which a transiently blocked operation may retry. */
    nextAttemptAt?: number;
    /** Explicit active pair generation; legacy tasks omit it. */
    activeGeneration?: number;
    /** Config index currently owned by the active pair. */
    activeIndex?: number;
    /** Manager-owned combat gate for the active pair. */
    combatReady?: boolean;
    /** Owner ID used for the active pair's Boost transaction. */
    primaryBoostOwnerId?: string;
    /** Active pair Boost lab snapshot, separate from legacy boostLabs. */
    primaryBoostLabs?: string[];
    /** Route shared by all task-owned creeps, including source and target. */
    routeRooms?: string[];
    /** Danger rooms captured when the route was selected. */
    avoidRooms?: string[];
    /** Planned post-boost combat and timing values. */
    plannedDps?: number;
    plannedHps?: number;
    plannedTtk?: number;
    plannedKillTick?: number;
    plannedHaulerSpawnStartTick?: number;
    plannedHaulerArrivalTick?: number;
    minimumCombatTtl?: number;
    /** Tick on which the manager first confirmed the bank absent in a visible room. */
    bankGoneTick?: number;
    /** Absolute hauling watchdog deadline. */
    haulingDeadlineAt?: number;
    /** Result ledger; values are monotonic. */
    observedPower?: number;
    pickedUpPower?: number;
    deliveredPower?: number;
    lostPower?: number;
    outcome?: PowerBankHarvestOutcome;
    /** Ensures terminal cleanup and history append happen once. */
    terminalCleanupDone?: boolean;
  }

  interface PowerBankHarvestHistoryEntry {
    taskId: string;
    sourceRoom: string;
    targetRoom: string;
    power: number;
    status: PowerBankHarvestStatus;
    outcome?: PowerBankHarvestOutcome;
    failReason?: string;
    discoveredTick: number;
    terminalTick: number;
    observedPower: number;
    pickedUpPower: number;
    deliveredPower: number;
    lostPower: number;
  }

  interface PowerBankStatusTaskSnapshot {
    taskId: string;
    status: PowerBankHarvestStatus;
    sourceRoom: string;
    targetRoom: string;
    stageAge: number;
    expiresIn: number | null;
    lastProgressAge: number;
    blocker: string | null;
    activeGeneration: number | null;
    combatReady: boolean;
    attackerId: string | null;
    healerId: string | null;
    reinforcementGeneration: number | null;
    reinforcementStage: PowerBankReinforcementStage | null;
    reinforcementCombatReady: boolean;
    reinforcementAttackerReady: boolean;
    reinforcementHealerReady: boolean;
    reinforcementAttackerId: string | null;
    reinforcementHealerId: string | null;
    reinforcementStageAge: number | null;
    reinforcementLastProgressAge: number | null;
    reinforcementBlocker: string | null;
    plannedDps: number | null;
    plannedHps: number | null;
    plannedTtk: number | null;
    haulerSpawnIn: number | null;
    haulerArrivalIn: number | null;
    haulerCount: number;
    observedPower: number;
    pickedUpPower: number;
    deliveredPower: number;
    lostPower: number;
    outcome: PowerBankHarvestOutcome | null;
  }

  interface PowerBankStatusSnapshot {
    ok: true;
    tick: number;
    tasks: PowerBankStatusTaskSnapshot[];
    history: PowerBankHarvestHistoryEntry[];
  }

  interface PowerBankScoutMemory {
    taskId: string;
  }

  interface PowerBankAttackerMemory {
    taskId: string;
    pairGeneration?: number;
  }

  interface PowerBankHealerMemory {
    taskId: string;
    pairGeneration?: number;
  }

  interface PowerBankHaulerMemory {
    taskId: string;
    powerBankDeliveryRoom?: string;
    capacityBlockedSince?: number;
  }

  interface Memory {
    cfg?: ScreepsMemoryConfig;
    runtime?: ScreepsMemoryRuntime;
    data?: ScreepsMemoryData;
    analytics?: ScreepsMemoryAnalytics;
  }

  interface CreepMemory {
    role?: RoleName;
    roleArgs?: string[];
    configName?: string;
    working?: boolean;
    ready?: boolean;
    _spawnYield?: { dir: DirectionConstant; tick: number };
    colonizationLastHits?: number;
    colonizationLastSeenAt?: number;
    colonizationLastRoomName?: string;
    colonizationLastRoomHostileOwned?: boolean;
    colonizationLastHadHostileCreepAttack?: boolean;
    colonizationDeathHandled?: boolean;
    scoutVisitedRooms?: string[];
    _patrol?: { patrolIndex?: number };
    _lastHits?: number;
    _rmcWait?: { ticks: number };
    _rmcSelectedSource?: string;
    _remoteWorkerRepairTargetId?: Id<StructureContainer>;
    _warBreachTargetId?: Id<StructureRampart | StructureWall>;
    _warBreachResumeUntil?: number;
    _warCounterstrike?: {
      targetId: Id<Creep>;
      targetX: number;
      targetY: number;
      createdAt: number;
      originX: number;
      originY: number;
      approachX: number;
      approachY: number;
      healerCoordinated?: boolean;
      healerReadyAt?: number;
      healerSwap?: boolean;
    };
    _warCounterstrikeSuppressedTargetIds?: Id<Creep>[];
    _warMoveIntentAt?: number;
    _warPartnerConfigName?: string;
    _warDetached?: boolean;
    _warQueued?: boolean;
    _move?: {
      dest?: {
        x: number;
        y: number;
        room: string;
      };
      path?: string;
      time?: number;
      room?: string;
    };
  }

  interface PowerCreepMemory {
    homeRoom?: string;
    tasks?: PowerCreepTask[];
    regenSourceIds?: string[];
    nextRegenSourceIndex?: number;
    lastControlTick?: number;
    _spawnYield?: { dir: DirectionConstant; tick: number };
  }

  interface RoomMemory {
    workerConstructionTier?: 0 | 1 | 2 | 3;
    coreRampartHits?: Record<string, number>;
  }

  interface SpawnMemory {
    spawnList?: string[];
    _lastSpawnFail?: {
      tick: number;
      spawnName: string;
      configName: string;
      role: string;
      code: number;
      bodyCost: number;
      bodyParts: number;
      roomEnergyAvailable: number;
      roomEnergyCapacityAvailable: number;
    };
  }

  interface Creep {
    work(): void;
  }

  interface StructureSpawn {
    work(): void;
    addTask(configName: string): number;
    mainSpawn(configName: string): boolean;
  }
}

export {};
