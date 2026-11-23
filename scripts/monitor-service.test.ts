import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const MONITOR_SCRIPT = resolve(REPO_ROOT, "scripts/monitor-service.mjs");

function executeFixture(
  fixturePath: string,
): { output: string; payload: Record<string, any> } {
  const output = execFileSync(
    process.execPath,
    [
      MONITOR_SCRIPT,
      "--once",
      "--memory-fixture",
      fixturePath,
      "--segment-id",
      "off",
      "--output",
      "off",
      "--no-http",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  const jsonStart = output.indexOf("\n{");
  if (jsonStart < 0) {
    throw new Error(`monitor CLI 未输出 JSON: ${output}`);
  }
  return {
    output,
    payload: JSON.parse(output.slice(jsonStart + 1)),
  };
}

function readFixtureProjection(fixtureName: string): Record<string, any> {
  return executeFixture(
    resolve(REPO_ROOT, `scripts/fixtures/${fixtureName}`),
  ).payload;
}

it.each([true, false])("自动选 shard 后 segment 沿用同一端点，存在带时间戳的 shard=%s", dated => {
  const preload = `globalThis.fetch = async url => {
    const shard = url.searchParams.get("shard");
    let data = {};
    if (url.pathname.endsWith("/memory-segment")) data = { shard };
    if (url.searchParams.get("path") === "runtime" && shard === "shard1" && ${dated}) {
      data = { lastDeployTag: "build@2026-01-01T00:00:00Z" };
    }
    return Response.json({ ok: 1, data });
  };`;
  const output = execFileSync(process.execPath, [
    "--import", "data:text/javascript," + encodeURIComponent(preload), MONITOR_SCRIPT, "--once",
    "--shards", "shard1", "--segment-id", "8", "--token", "fixture", "--output", "off",
  ], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, SCREEPS_MONITOR_SHARD: "", SCREEPS_MONITOR_MEMORY_FIXTURE: "" } });
  const payload = JSON.parse(output.slice(output.indexOf("\n{") + 1));
  expect(payload.memory.selectedShard).toBe(dated ? "shard1" : "(default)");
  expect(payload.segment.selectedShard).toBe(payload.memory.selectedShard);
  expect(payload.segment.snapshot.parsed.shard).toBe(dated ? "shard1" : null);
});

describe("monitor-service ResourceControl terminal headroom projection", () => {
  test("投影容量策略、receiver 统计和逐房 headroom 诊断", () => {
    const payload = readFixtureProjection("resource-control-headroom-monitor.json");
    const resourceControl = payload.memory.resourceControl;

    expect(resourceControl.capacityPolicy).toEqual({
      enabled: true,
      terminalHeadroomRecoveryEnabled: true,
      storagePressureFreeCapacity: 80000,
      storageReliefTargetFreeCapacity: 120000,
      receiverStorageMinFreeCapacity: 140000,
      terminalPressureFreeCapacity: 30000,
      terminalReliefTargetFreeCapacity: 60000,
      receiverTerminalMinFreeCapacity: 50000,
    });
    expect(resourceControl.eligibleReceiverCount).toBe(1);
    expect(resourceControl.receiverExcludedByReason).toEqual({
      storage_headroom: 1,
    });
    expect(resourceControl.suppressedStagingCount).toEqual({
      fee_budget: 1,
      receiver_capacity: 2,
    });
    expect(resourceControl.capacityIndexBuildCount).toBe(1);
    expect(resourceControl.logistics).toEqual({
      available: true,
      livenessAvailable: true,
      snapshotIncoherent: false,
      inconclusive: false,
      snapshotAttestationMatched: true,
      coherenceRetryCount: 0,
      initialEpochSkew: false,
      schemaVersion: 1,
      updatedAt: 2000,
      expiresAt: 2010,
      requestedMode: "shadow",
      effectiveAuthority: "legacy",
      blocker: null,
      complete: true,
      projectionTruncated: false,
      inScopeByOrigin: {
        synthesis_room: 1,
      },
      outOfScopeByOrigin: {
        synthesis_distributed_demand: 2,
      },
      intent: {
        total: 1,
        active: 1,
        fresh: 1,
        stale: 0,
        paired: 1,
        inputDrift: 0,
        emitted: 1,
        dropped: 0,
        truncated: false,
      },
      comparison: {
        total: 1,
        matched: 1,
        different: 0,
        unresolved: 0,
        byReason: {
          equal: 1,
        },
        dimensions: {
          donor: { matched: 1, different: 0, unresolved: 0 },
          route: { matched: 1, different: 0, unresolved: 0 },
          priority: { matched: 1, different: 0, unresolved: 0 },
          demandCoverage: { matched: 1, different: 0, unresolved: 0 },
          receiverHeadroom: { matched: 1, different: 0, unresolved: 0 },
          predictedStagingEligibility: {
            matched: 1,
            different: 0,
            unresolved: 0,
          },
        },
        samples: [
          {
            intentId: "logistics-intent:synthesis:W1N1:X",
            status: "equal",
            reason: "equal",
            differingDimensions: [],
            legacySourceRoomName: "W2N1",
            shadowSourceRoomName: "W2N1",
            predictedStagingEligibility: "eligible",
          },
        ],
      },
      matcher: {
        indexBuilds: 1,
        candidateEvaluations: 2,
        transactionCostEvaluations: 2,
        totalTransactionCostEvaluations: 2,
        candidateBudget: 128,
        budgetExhausted: false,
        continuationCursor: null,
      },
      // 这里只证明边界结束时没有可见 Shadow records；瞬时 send/deal
      // attempt 由本地 disabled-vs-shadow mock gate 验证，不由 live 投影声称。
      safety: {
        measurementBoundary: "observable_state_diff_v1",
        nonLegacyAuthorityRecords: 0,
        activeContracts: 0,
        activeLeases: 0,
        activeClaims: 0,
        shadowArbiterActorRecords: 0,
        shadowClaimRecords: 0,
        shadowJournalRecords: 0,
        shadowCarrierTaskRecords: 0,
        shadowReceiverReservationRecords: 0,
        violations: [],
      },
      resources: {
        dataItems: 4,
        runtimeItems: 4,
        dataBytes: 349,
        runtimeBytes: 1714,
        totalBytes: 2063,
        withinLimit: true,
        observedDataItems: 4,
        observedDataBytes: 349,
        observedRuntimeItems: 4,
        observedRuntimeBytes: 1714,
      },
      cpu: {
        measurementAvailable: true,
        captureUsed: 0.1,
        used: 0.35,
        cpuGateEligible: false,
        gateInconclusive: true,
      },
    });
    expect(resourceControl.taskSummary).toEqual({
      pending: 4,
      manualPending: 1,
      automaticPending: 3,
      blockedByReason: {
        receiver_capacity: 2,
        source_depleted: 1,
      },
      livenessAvailable: true,
      demandCoveringIncoming: 2,
      coverageExpiredIncoming: 1,
      coverageExpiredByReason: {
        automatic_receiver_capacity_coverage_timeout: 1,
      },
    });

    expect(resourceControl.rooms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomName: "W1N1",
          storageUsedCapacity: 870000,
          storageFreeCapacity: 130000,
          localOffloadCapacityCommitment: 6000,
          desiredTerminalFreeCapacity: 60000,
          terminalRecoveryGap: 30000,
          recoverableOffloadAmount: 10000,
          stickyHeadroom: true,
          stickyHeadroomReason: "carrier_backlog",
          capacityReservation: {
            committed: 22000,
            remaining: 0,
          },
          staging: {
            admittedAmount: 2000,
            admittedTaskCount: 1,
            admittedByResource: {
              O: 2000,
            },
            suppressedCount: 3,
            suppressedByReason: {
              fee_budget: 1,
              receiver_capacity: 2,
            },
          },
        }),
        expect.objectContaining({
          roomName: "W2N1",
          storageUsedCapacity: 860000,
          storageFreeCapacity: 140000,
          terminalUsedCapacity: 200000,
          terminalFreeCapacity: 100000,
          stickyHeadroom: false,
          stickyHeadroomReason: null,
          staging: {
            admittedAmount: 0,
            admittedTaskCount: 0,
            admittedByResource: {},
            suppressedCount: 0,
            suppressedByReason: {},
          },
        }),
      ]),
    );

    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, any>;
    const planning = fixture.data.marketSaleAutomation.directAutomation.baseResourceV3
      .lastPlanningSnapshot;
    planning.cpuTrace = {
      observedAt: 700,
      cpuAfterOuterSession: 1,
      cpuAfterScopeCore: 2,
      cpuAfterMarketFacts: 3,
      cpuAfterShadowBatch: 4,
      cpuAfterInnerApply: 5,
      cpuCutPhase: null,
      marketFactsDisposition: "read",
    };
    fixture.runtime.marketSaleAutomation.direct.baseResourceV3CpuTrace = {
      observedAt: 701,
      cpuAfterOuterSession: 6,
      cpuAfterScopeCore: 12,
      cpuAfterMarketFacts: 19,
      cpuAfterShadowBatch: 24,
      cpuAfterInnerApply: 25,
      cpuCutPhase: "outer_precommit",
      marketFactsDisposition: "read",
    };

    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "screeps-monitor-cpu-trace-"));
    const fixturePath = resolve(temporaryDirectory, "fixture.json");
    try {
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const current = executeFixture(fixturePath).payload.memory;
      const projected =
        current.marketSaleAutomation.direct.baseResourceV3;
      expect(projected.cpuTrace).toEqual({
        observedAt: 701,
        cpuAfterOuterSession: 6,
        cpuAfterScopeCore: 12,
        cpuAfterMarketFacts: 19,
        cpuAfterShadowBatch: 24,
        cpuAfterInnerApply: 25,
        cpuCutPhase: "outer_precommit",
        marketFactsDisposition: "read",
      });
      expect(projected.planning.cpuTrace).toEqual(projected.cpuTrace);
      expect(current.hub.distributedSynthesis).toEqual({
        livenessAvailable: true,
        blockedTargets: ["XUH2O"],
        invariantViolations: [
          "duplicate_room_assignment:E7N57:GH2O,XUH2O",
        ],
        configReconcile: {
          revision: 17,
          refreshedRooms: ["E7N57"],
          clearedRooms: ["E8N57"],
          skippedBusyRooms: ["E9N57"],
          foreignOwnerRooms: ["E3N59"],
        },
      });

      delete fixture.analytics.hub;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const runtimeOnlyHub = executeFixture(fixturePath).payload.memory.hub;
      expect(runtimeOnlyHub.available).toBe(false);
      expect(runtimeOnlyHub.updatedAt).toBeNull();
      expect(runtimeOnlyHub.distributedSynthesis.livenessAvailable).toBe(true);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }

    const legacy = readFixtureProjection(
      "resource-control-monitor.json",
    ).memory;
    expect(legacy.resourceControl.taskSummary).toEqual({
      pending: 1,
      manualPending: 0,
      automaticPending: 1,
      blockedByReason: {
        receiver_capacity: 1,
      },
      livenessAvailable: false,
      demandCoveringIncoming: null,
      coverageExpiredIncoming: null,
      coverageExpiredByReason: null,
    });
    expect(legacy.resourceControl.logistics).toEqual({
      available: false,
      livenessAvailable: false,
      snapshotIncoherent: false,
      inconclusive: false,
      snapshotAttestationMatched: false,
      coherenceRetryCount: 0,
      initialEpochSkew: false,
      schemaVersion: null,
      updatedAt: null,
      expiresAt: null,
      requestedMode: null,
      effectiveAuthority: null,
      blocker: null,
      complete: null,
      projectionTruncated: null,
      inScopeByOrigin: null,
      outOfScopeByOrigin: null,
      intent: null,
      comparison: null,
      matcher: null,
      safety: null,
      resources: null,
      cpu: null,
    });
    expect(legacy.hub.distributedSynthesis).toEqual({
      livenessAvailable: false,
      blockedTargets: null,
      invariantViolations: null,
      configReconcile: null,
    });
  });
});

describe("monitor-service Hub protection projection", () => {

  test("损坏 Memory 的超长字符串与整行日志均被硬截断", () => {
    const sourcePath = resolve(
      REPO_ROOT,
      "scripts/fixtures/market-sale-continuous-monitor.json",
    );
    const fixture = JSON.parse(
      readFileSync(sourcePath, "utf8"),
    ) as Record<string, any>;
    fixture.analytics.production = {
      rooms: {
        W1N1: {
          latest: { tick: 2000 },
        },
      },
    };
    const oversized = "x".repeat(8_192);
    fixture.analytics.hub.protectionAttempt.reason =
      oversized;
    const baseResourceV3 =
      fixture.data.marketSaleAutomation.directAutomation
        .baseResourceV3;
    baseResourceV3.scope.accountIdentity = oversized;
    baseResourceV3.catalog.resources[0] = oversized;
    baseResourceV3.lastPlanningSnapshot.blocker =
      oversized;
    baseResourceV3.blocker = oversized;
    baseResourceV3.quotaProjection.lanes = {
      [oversized]: {
        limit: 1,
        confirmed: 0,
        reserved: 0,
        used: 0,
        remaining: 1,
      },
    };
    fixture.runtime.marketSaleAutomation.direct.entries[0]
      .resourceType = oversized;
    fixture.runtime.hub.distributedSynthesis.invariantViolations =
      Array.from(
        { length: 110 },
        (_, index) => index === 0 ? oversized : `violation:${index}`,
      );
    fixture.runtime.hub.distributedSynthesis.configReconcile.refreshedRooms =
      Array.from({ length: 110 }, (_, index) => `W${index}N1`);
    fixture.runtime.resourceControl = {
      updatedAt: 2000,
      taskSummary: {
        pending: 0,
        manualPending: 0,
        automaticPending: 0,
        blockedByReason: {},
        demandCoveringIncoming: 0,
        coverageExpiredIncoming: 1,
        coverageExpiredByReason: {
          automatic_receiver_capacity_coverage_timeout: 1,
          [oversized]: 999,
        },
      },
      logistics: JSON.parse(
        JSON.stringify(
          (
            JSON.parse(
              readFileSync(
                resolve(
                  REPO_ROOT,
                  "scripts/fixtures/resource-control-headroom-monitor.json",
                ),
                "utf8",
              ),
            ) as Record<string, any>
          ).runtime.resourceControl.logistics,
        ),
      ),
    };
    const resourceControlFixture = JSON.parse(
      readFileSync(
        resolve(
          REPO_ROOT,
          "scripts/fixtures/resource-control-headroom-monitor.json",
        ),
        "utf8",
      ),
    ) as Record<string, any>;
    fixture.data.resourceControl = {
      tasks: {},
      logistics: JSON.parse(
        JSON.stringify(
          resourceControlFixture.data.resourceControl.logistics,
        ),
      ),
    };
    const validLogistics = JSON.parse(
      JSON.stringify(
        fixture.runtime.resourceControl.logistics,
      ),
    ) as Record<string, any>;
    const validDataLogistics = JSON.parse(
      JSON.stringify(
        fixture.data.resourceControl.logistics,
      ),
    ) as Record<string, any>;

    const refreshRuntimeResourceAttestation = (
      logistics: Record<string, any>,
    ): void => {
      const rejectionTupleCount = logistics.comparison.samples.reduce(
        (total: number, sample: Record<string, any>) =>
          total + (Array.isArray(sample.candidate?.rejectionCounts)
            ? sample.candidate.rejectionCounts.length
            : 0),
        0,
      );
      logistics.resources.runtimeItems =
        logistics.comparison.samples.length +
        rejectionTupleCount +
        logistics.safety.violations.length +
        Object.keys(logistics.inScopeByOrigin).length +
        Object.keys(logistics.outOfScopeByOrigin).length +
        Object.keys(logistics.comparison.byReason).length +
        Object.keys(
          logistics.comparison.byDecisionDelta || {},
        ).length +
        Object.keys(
          logistics.comparison.byCausalCode || {},
        ).length;
      for (let iteration = 0; iteration < 6; iteration += 1) {
        logistics.resources.runtimeBytes = Buffer.byteLength(
          JSON.stringify(logistics),
          "utf8",
        );
        logistics.resources.totalBytes =
          logistics.resources.dataBytes +
          logistics.resources.runtimeBytes;
        logistics.resources.withinLimit =
          logistics.resources.dataBytes <= 16_384 &&
          logistics.resources.runtimeBytes <= 16_384 &&
          logistics.resources.totalBytes <= 32_768;
      }
    };

    const createLogisticsEpochPair = (
      epoch: number,
    ): {
      runtimeResourceControl: Record<string, any>;
      dataResourceControl: Record<string, any>;
    } => {
      const dataResourceControl = JSON.parse(
        JSON.stringify(fixture.data.resourceControl),
      ) as Record<string, any>;
      const dataLogistics = dataResourceControl.logistics;
      dataLogistics.i[0][10] = epoch;
      dataLogistics.i[0][11] = epoch;
      dataLogistics.i[0][12] = epoch + 10;
      dataLogistics.o[0][6] = epoch;
      dataLogistics.p[0][3] = epoch;
      dataLogistics.p[0][4] = epoch + 10;

      const runtimeResourceControl = JSON.parse(
        JSON.stringify(fixture.runtime.resourceControl),
      ) as Record<string, any>;
      runtimeResourceControl.updatedAt = epoch;
      runtimeResourceControl.logistics.updatedAt = epoch;
      runtimeResourceControl.logistics.expiresAt = epoch + 10;
      runtimeResourceControl.logistics.resources.dataBytes =
        Buffer.byteLength(JSON.stringify(dataLogistics), "utf8");
      refreshRuntimeResourceAttestation(
        runtimeResourceControl.logistics,
      );
      return { runtimeResourceControl, dataResourceControl };
    };

    const createV2Logistics = (): Record<string, any> => {
      const logistics = JSON.parse(
        JSON.stringify(validLogistics),
      ) as Record<string, any>;
      logistics.schemaVersion = 2;
      logistics.comparison = {
        total: 1,
        matched: 1,
        different: 0,
        unresolved: 0,
        byReason: { equal: 1 },
        byDecisionDelta: { same_route: 1 },
        byCausalCode: { matched: 1 },
        dimensions: logistics.comparison.dimensions,
        sampled: 1,
        detailsDropped: 0,
        samples: [
          {
            intentId: "logistics-intent:synthesis:W1N1:X",
            targetRoomName: "W1N1",
            resource: "X",
            status: "equal",
            reason: "equal",
            decisionDelta: "same_route",
            direction: "same",
            causalCode: "matched",
            differingDimensions: [],
            legacy: {
              kind: "route",
              sourceRoomName: "W2N1",
              coverage: "covered",
              capacity: "eligible",
              staging: "eligible",
              amount: 100,
              actionAmount: 100,
              feeAmount: 5,
              terminalReadyAt: 2000,
              requiredEnergy: 5,
              energyCommitmentAmount: 5,
              terminalAllocatedAmount: 80,
              stagingRequiredAmount: 20,
              terminalEnergyAllocatedAmount: 3,
              feeStagingRequiredAmount: 2,
            },
            shadow: {
              kind: "route",
              sourceRoomName: "W2N1",
              coverage: "covered",
              capacity: "eligible",
              staging: "eligible",
              amount: 100,
              actionAmount: 100,
              feeAmount: 5,
              terminalReadyAt: 2000,
              requiredEnergy: 5,
              energyCommitmentAmount: 5,
              terminalAllocatedAmount: 80,
              stagingRequiredAmount: 20,
              terminalEnergyAllocatedAmount: 3,
              feeStagingRequiredAmount: 2,
            },
            candidate: {
              donorCount: 2,
              evaluatedCount: 2,
              feasibleCount: 1,
              rejectedCount: 1,
              rejectionCounts: [["source_protection", 1]],
              topSourceRoom: "W2N1",
              legacySource: {
                sourceRoom: "W2N1",
                disposition: "selected",
              },
              receiver: {
                kind: "present",
                receiverEligible: true,
                storageHeadroom: 140000,
                terminalHeadroom: 100000,
                resourceHeadroom: 100000,
              },
            },
          },
        ],
      };
      logistics.cpu = {
        attributionVersion: 2,
        sampleTick: 2000,
        measurementAvailable: true,
        producerUsed: 1,
        consumerUsed: 0.75,
      };
      refreshRuntimeResourceAttestation(logistics);
      return logistics;
    };

    const cpuEntryAt = (
      tick: number,
      resourceControlUsed: number,
    ): Record<string, any> => ({
      tick,
      shard: "shard1",
      totalUsed: 10,
      bucket: 10000,
      limit: 120,
      tickLimit: 500,
      phases: { resourceControl: resourceControlUsed },
      fixedActionCounts: {},
      untracked: 0,
      emaTotalUsed: 10,
      rooms: {},
      heap: null,
    });

    const temporaryDirectory = mkdtempSync(
      resolve(tmpdir(), "screeps-monitor-bounds-"),
    );
    const fixturePath = resolve(
      temporaryDirectory,
      "fixture.json",
    );
    try {
      writeFileSync(
        fixturePath,
        JSON.stringify(fixture),
        "utf8",
      );
      const { payload } = executeFixture(fixturePath);
      const hub = payload.memory.hub;
      const base =
        payload.memory.marketSaleAutomation.direct
          .baseResourceV3;
      expect(hub.protectionAttempt.reason).toHaveLength(256);
      expect(
        hub.distributedSynthesis.invariantViolations,
      ).toHaveLength(100);
      expect(
        hub.distributedSynthesis.invariantViolations[0],
      ).toHaveLength(256);
      expect(
        hub.distributedSynthesis.configReconcile.refreshedRooms,
      ).toHaveLength(100);
      expect(
        payload.memory.resourceControl.taskSummary
          .coverageExpiredByReason,
      ).toEqual({
        automatic_receiver_capacity_coverage_timeout: 1,
      });
      expect(base.roster.accountIdentity).toHaveLength(256);
      expect(base.catalog.resources.values[6]).toHaveLength(
        256,
      );
      expect(base.planning.blocker).toHaveLength(256);
      expect(base.blocker.code).toHaveLength(256);
      expect(
        Object.keys(base.quota.lanes.samples)[0],
      ).toHaveLength(256);

      const cpu2000 = cpuEntryAt(2000, 4);
      const validV2Logistics = createV2Logistics();
      fixture.runtime.resourceControl.logistics = validV2Logistics;
      fixture.analytics.cpuMonitor = {
        version: 2,
        updatedAt: 2000,
        sampleInterval: 10,
        historyLimit: 120,
        latest: cpu2000,
        history: [cpu2000],
        summary: null,
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const v2Projection = executeFixture(fixturePath).payload.memory
        .resourceControl.logistics;
      expect(v2Projection).toEqual(
        expect.objectContaining({
          schemaVersion: 2,
          livenessAvailable: true,
          snapshotAttestationMatched: true,
          comparison: expect.objectContaining({
            byDecisionDelta: { same_route: 1 },
            byCausalCode: { matched: 1 },
            sampled: 1,
            detailsDropped: 0,
          }),
          cpu: {
            attributionVersion: 2,
            sampleTick: 2000,
            measurementAvailable: true,
            producerUsed: 1,
            consumerUsed: 0.75,
            shadowUsed: 1.75,
            outerResourceControlUsed: 4,
            gateUsed: 5,
            cpuGateEligible: true,
            gateInconclusive: false,
          },
        }),
      );
      expect(v2Projection.comparison.samples[0]).toEqual(
        expect.objectContaining({
          reason: "equal",
          producerReason: null,
          decisionDelta: "same_route",
          direction: "same",
          causalCode: "matched",
          legacy: expect.objectContaining({ kind: "route" }),
          shadow: expect.objectContaining({ kind: "route" }),
          candidate: expect.objectContaining({
            rejectedCount: 1,
            rejectionCounts: [["source_protection", 1]],
          }),
        }),
      );

      const missingReceiverProof = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      missingReceiverProof.comparison.samples[0]
        .candidate.receiver.receiverEligible = false;
      refreshRuntimeResourceAttestation(missingReceiverProof);
      fixture.runtime.resourceControl.logistics = missingReceiverProof;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      const impossibleRouteCoverage = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      impossibleRouteCoverage.comparison.samples[0].legacy.coverage =
        "unknown";
      impossibleRouteCoverage.comparison.samples[0].shadow.coverage =
        "unknown";
      refreshRuntimeResourceAttestation(impossibleRouteCoverage);
      fixture.runtime.resourceControl.logistics =
        impossibleRouteCoverage;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      const equalBothNoRoute = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      equalBothNoRoute.comparison.byDecisionDelta = {
        both_no_route: 1,
      };
      const bothNoRouteSample =
        equalBothNoRoute.comparison.samples[0];
      bothNoRouteSample.decisionDelta = "both_no_route";
      bothNoRouteSample.legacy = {
        kind: "none",
        blocker: "no_donor",
        coverage: "none",
        capacity: "unknown",
        staging: "unknown",
      };
      bothNoRouteSample.shadow = {
        kind: "unmatched",
        reason: "no_donor",
        coverage: "none",
        capacity: "unknown",
        staging: "unknown",
        uncoveredAmount: 100,
      };
      bothNoRouteSample.candidate = {
        donorCount: 0,
        evaluatedCount: 0,
        feasibleCount: 0,
        rejectedCount: 0,
        rejectionCounts: [],
        receiver: { kind: "missing" },
      };
      equalBothNoRoute.matcher.candidateEvaluations = 0;
      equalBothNoRoute.matcher.transactionCostEvaluations = 0;
      equalBothNoRoute.matcher.totalTransactionCostEvaluations = 0;
      refreshRuntimeResourceAttestation(equalBothNoRoute);
      fixture.runtime.resourceControl.logistics = equalBothNoRoute;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const equalBothNoRouteProjection =
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics;
      expect(equalBothNoRouteProjection.livenessAvailable).toBe(true);
      expect(
        equalBothNoRouteProjection.comparison.samples[0],
      ).toEqual(expect.objectContaining({
        status: "equal",
        decisionDelta: "both_no_route",
        legacy: expect.objectContaining({ coverage: "none" }),
        shadow: expect.objectContaining({ coverage: "none" }),
      }));

      const impossibleNoDonorCapacity = JSON.parse(
        JSON.stringify(equalBothNoRoute),
      ) as Record<string, any>;
      impossibleNoDonorCapacity.comparison.samples[0].shadow.capacity =
        "blocked";
      refreshRuntimeResourceAttestation(impossibleNoDonorCapacity);
      fixture.runtime.resourceControl.logistics =
        impossibleNoDonorCapacity;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      const unequalBothNoRoute = JSON.parse(
        JSON.stringify(equalBothNoRoute),
      ) as Record<string, any>;
      unequalBothNoRoute.comparison.samples[0].shadow.coverage =
        "partial";
      refreshRuntimeResourceAttestation(unequalBothNoRoute);
      fixture.runtime.resourceControl.logistics = unequalBothNoRoute;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      const changedConsumer = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      changedConsumer.cpu.consumerUsed = 2;
      refreshRuntimeResourceAttestation(changedConsumer);
      fixture.runtime.resourceControl.logistics = changedConsumer;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const changedConsumerCpu = executeFixture(fixturePath).payload.memory
        .resourceControl.logistics.cpu;
      expect(changedConsumerCpu).toEqual(
        expect.objectContaining({
          shadowUsed: 3,
          gateUsed: 5,
          cpuGateEligible: true,
        }),
      );

      const consumerOutsideOuter = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      consumerOutsideOuter.cpu.consumerUsed = 5;
      refreshRuntimeResourceAttestation(consumerOutsideOuter);
      fixture.runtime.resourceControl.logistics = consumerOutsideOuter;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const consumerOutsideOuterCpu =
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.cpu;
      expect(consumerOutsideOuterCpu).toEqual(
        expect.objectContaining({
          shadowUsed: 6,
          outerResourceControlUsed: 4,
          gateUsed: 5,
          cpuGateEligible: false,
          gateInconclusive: false,
        }),
      );

      const cpuWithLegacyField = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      cpuWithLegacyField.cpu.captureUsed = 1;
      refreshRuntimeResourceAttestation(cpuWithLegacyField);
      fixture.runtime.resourceControl.logistics = cpuWithLegacyField;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const nonExactCpuProjection =
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics;
      expect(nonExactCpuProjection.livenessAvailable).toBe(false);
      expect(nonExactCpuProjection.cpu.cpuGateEligible).toBe(false);

      const cpu1999 = cpuEntryAt(1999, 99);
      fixture.runtime.resourceControl.logistics = validV2Logistics;
      fixture.analytics.cpuMonitor = {
        ...fixture.analytics.cpuMonitor,
        updatedAt: 1999,
        latest: cpu1999,
        history: [cpu1999],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const missingSameTickCpu = executeFixture(fixturePath).payload.memory
        .resourceControl.logistics;
      expect(missingSameTickCpu.livenessAvailable).toBe(true);
      expect(missingSameTickCpu.cpu).toEqual(
        expect.objectContaining({
          sampleTick: 2000,
          outerResourceControlUsed: null,
          gateUsed: null,
          cpuGateEligible: false,
          gateInconclusive: true,
        }),
      );

      const mismatchedSampleTick = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      mismatchedSampleTick.cpu.sampleTick = 1999;
      refreshRuntimeResourceAttestation(mismatchedSampleTick);
      fixture.runtime.resourceControl.logistics = mismatchedSampleTick;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const mismatchedSampleTickCpu =
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.cpu;
      expect(mismatchedSampleTickCpu).toEqual(
        expect.objectContaining({
          sampleTick: 1999,
          outerResourceControlUsed: null,
          gateUsed: null,
          cpuGateEligible: false,
          gateInconclusive: true,
        }),
      );

      fixture.analytics.cpuMonitor = {
        version: 2,
        updatedAt: 2000,
        sampleInterval: 10,
        historyLimit: 120,
        latest: cpu2000,
        history: [cpu2000],
        summary: null,
      };
      const producerReasonOnly = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      producerReasonOnly.comparison.samples[0].producerReason =
        "unsafe_candidate";
      refreshRuntimeResourceAttestation(producerReasonOnly);
      fixture.runtime.resourceControl.logistics = producerReasonOnly;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const producerReasonProjection =
        executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      expect(producerReasonProjection.livenessAvailable).toBe(true);
      expect(producerReasonProjection.comparison.samples[0]).toEqual(
        expect.objectContaining({
          reason: "equal",
          producerReason: "unsafe_candidate",
          causalCode: "matched",
        }),
      );

      const nonCanonicalRejections = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      const candidate =
        nonCanonicalRejections.comparison.samples[0].candidate;
      candidate.rejectedCount = 2;
      candidate.rejectionCounts = [
        ["source_protection", 1],
        ["receiver_capacity", 1],
      ];
      refreshRuntimeResourceAttestation(nonCanonicalRejections);
      fixture.runtime.resourceControl.logistics =
        nonCanonicalRejections;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      const legacyBlockedShadowSafe = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      const unsafeRouteSample =
        legacyBlockedShadowSafe.comparison.samples[0];
      legacyBlockedShadowSafe.comparison.matched = 0;
      legacyBlockedShadowSafe.comparison.different = 1;
      legacyBlockedShadowSafe.comparison.byReason = {
        expected_policy_difference: 1,
      };
      legacyBlockedShadowSafe.comparison.byCausalCode = {
        route_fact_difference: 1,
      };
      legacyBlockedShadowSafe.comparison.dimensions.receiverHeadroom = {
        matched: 0,
        different: 1,
        unresolved: 0,
      };
      unsafeRouteSample.status = "different";
      unsafeRouteSample.reason = "expected_policy_difference";
      unsafeRouteSample.direction = "policy_difference";
      unsafeRouteSample.causalCode = "route_fact_difference";
      unsafeRouteSample.differingDimensions = [
        "receiverHeadroom",
      ];
      unsafeRouteSample.legacy.capacity = "blocked";
      refreshRuntimeResourceAttestation(legacyBlockedShadowSafe);
      fixture.runtime.resourceControl.logistics = legacyBlockedShadowSafe;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const legacyBlockedProjection =
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics;
      expect(legacyBlockedProjection.livenessAvailable).toBe(true);
      expect(
        legacyBlockedProjection.comparison.samples[0].reason,
      ).toBe("expected_policy_difference");

      const legacyBlockedFalselyUnsafe = JSON.parse(
        JSON.stringify(legacyBlockedShadowSafe),
      ) as Record<string, any>;
      legacyBlockedFalselyUnsafe.comparison.byReason = {
        unsafe_candidate: 1,
      };
      legacyBlockedFalselyUnsafe.comparison.samples[0].reason =
        "unsafe_candidate";
      refreshRuntimeResourceAttestation(legacyBlockedFalselyUnsafe);
      fixture.runtime.resourceControl.logistics =
        legacyBlockedFalselyUnsafe;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      const legacyNoneShadowSafe = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      const legacyNoneSample =
        legacyNoneShadowSafe.comparison.samples[0];
      legacyNoneShadowSafe.comparison.matched = 0;
      legacyNoneShadowSafe.comparison.different = 1;
      legacyNoneShadowSafe.comparison.byReason = {
        legacy_unpaired: 1,
      };
      legacyNoneShadowSafe.comparison.byDecisionDelta = {
        shadow_only_route: 1,
      };
      legacyNoneShadowSafe.comparison.byCausalCode = {
        no_donor: 1,
      };
      for (const dimensionName of ["donor", "route"]) {
        legacyNoneShadowSafe.comparison.dimensions[dimensionName] = {
          matched: 0,
          different: 1,
          unresolved: 0,
        };
      }
      legacyNoneSample.status = "different";
      legacyNoneSample.reason = "legacy_unpaired";
      legacyNoneSample.decisionDelta = "shadow_only_route";
      legacyNoneSample.direction = "shadow_more_permissive";
      legacyNoneSample.causalCode = "no_donor";
      legacyNoneSample.differingDimensions = ["donor", "route"];
      legacyNoneSample.legacy = {
        kind: "none",
        blocker: "no_donor",
        coverage: "none",
        capacity: "blocked",
        staging: "unknown",
      };
      delete legacyNoneSample.candidate.legacySource;
      refreshRuntimeResourceAttestation(legacyNoneShadowSafe);
      fixture.runtime.resourceControl.logistics = legacyNoneShadowSafe;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const legacyNoneProjection =
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics;
      expect(legacyNoneProjection.livenessAvailable).toBe(true);
      expect(legacyNoneProjection.comparison.samples[0]).toEqual(
        expect.objectContaining({
          reason: "legacy_unpaired",
          shadow: expect.objectContaining({ kind: "route" }),
        }),
      );

      const unsafeUnmatched = JSON.parse(
        JSON.stringify(validV2Logistics),
      ) as Record<string, any>;
      const unsafeSample = unsafeUnmatched.comparison.samples[0];
      unsafeUnmatched.comparison.matched = 0;
      unsafeUnmatched.comparison.different = 1;
      unsafeUnmatched.comparison.byReason = { unsafe_candidate: 1 };
      unsafeUnmatched.comparison.byDecisionDelta = {
        legacy_only_route: 1,
      };
      unsafeUnmatched.comparison.byCausalCode = {
        receiver_capacity: 1,
      };
      for (const dimension of Object.values(
        unsafeUnmatched.comparison.dimensions,
      ) as Array<Record<string, number>>) {
        dimension.matched = 0;
        dimension.different = 1;
      }
      unsafeSample.status = "different";
      unsafeSample.reason = "unsafe_candidate";
      unsafeSample.decisionDelta = "legacy_only_route";
      unsafeSample.direction = "shadow_more_conservative";
      unsafeSample.causalCode = "receiver_capacity";
      unsafeSample.differingDimensions = ["route"];
      unsafeSample.shadow = {
        kind: "unmatched",
        reason: "receiver_capacity",
        coverage: "none",
        capacity: "blocked",
        staging: "unknown",
        uncoveredAmount: 100,
      };
      unsafeSample.candidate.feasibleCount = 0;
      unsafeSample.candidate.rejectedCount = 2;
      unsafeSample.candidate.rejectionCounts = [
        ["receiver_capacity", 1],
        ["source_protection", 1],
      ];
      delete unsafeSample.candidate.topSourceRoom;
      refreshRuntimeResourceAttestation(unsafeUnmatched);
      fixture.runtime.resourceControl.logistics = unsafeUnmatched;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      expect(
        executeFixture(fixturePath).payload.memory.resourceControl
          .logistics.livenessAvailable,
      ).toBe(false);

      fixture.runtime.resourceControl.logistics = validLogistics;
      delete fixture.analytics.cpuMonitor;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");

      const epoch1997 = createLogisticsEpochPair(1997);
      const epoch1998 = createLogisticsEpochPair(1998);
      const epoch1999 = createLogisticsEpochPair(1999);
      const epoch2000 = createLogisticsEpochPair(2000);

      fixture.__monitorMemoryPathReads = {
        "runtime.resourceControl": [
          epoch1997.runtimeResourceControl,
          epoch1997.runtimeResourceControl,
        ],
        "data.resourceControl": [
          epoch1997.dataResourceControl,
        ],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const normalBracketSnapshot =
        executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      expect(normalBracketSnapshot).toEqual(
        expect.objectContaining({
          updatedAt: 1997,
          livenessAvailable: true,
          snapshotIncoherent: false,
          inconclusive: false,
          snapshotAttestationMatched: true,
          coherenceRetryCount: 0,
          initialEpochSkew: false,
        }),
      );

      fixture.__monitorMemoryPathReads = {
        "runtime.resourceControl": [
          epoch1997.runtimeResourceControl,
          epoch1997.runtimeResourceControl,
          epoch1998.runtimeResourceControl,
          epoch1998.runtimeResourceControl,
        ],
        "data.resourceControl": [
          epoch1998.dataResourceControl,
          epoch1998.dataResourceControl,
        ],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const recoveredCoherentSnapshot =
        executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      expect(recoveredCoherentSnapshot).toEqual(
        expect.objectContaining({
          updatedAt: 1998,
          livenessAvailable: true,
          snapshotIncoherent: false,
          inconclusive: false,
          snapshotAttestationMatched: true,
          coherenceRetryCount: 1,
          initialEpochSkew: true,
        }),
      );

      fixture.__monitorMemoryPathReads = {
        "runtime.resourceControl": [
          epoch1997.runtimeResourceControl,
          epoch1997.runtimeResourceControl,
          epoch1999.runtimeResourceControl,
          epoch1999.runtimeResourceControl,
        ],
        "data.resourceControl": [
          epoch1998.dataResourceControl,
          epoch2000.dataResourceControl,
        ],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const persistentlyTornSnapshot =
        executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      expect(persistentlyTornSnapshot).toEqual(
        expect.objectContaining({
          updatedAt: 1999,
          livenessAvailable: false,
          snapshotIncoherent: true,
          inconclusive: true,
          snapshotAttestationMatched: false,
          coherenceRetryCount: 1,
          initialEpochSkew: true,
        }),
      );

      const sameEpochUnattestedData = JSON.parse(
        JSON.stringify(epoch2000.dataResourceControl),
      ) as Record<string, any>;
      sameEpochUnattestedData.logistics.s[0] =
        "differentControl:room";
      fixture.__monitorMemoryPathReads = {
        "runtime.resourceControl": [
          epoch2000.runtimeResourceControl,
          epoch2000.runtimeResourceControl,
        ],
        "data.resourceControl": [sameEpochUnattestedData],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const sameEpochAttestationFailure =
        executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      expect(sameEpochAttestationFailure).toEqual(
        expect.objectContaining({
          updatedAt: 2000,
          livenessAvailable: false,
          snapshotIncoherent: false,
          inconclusive: false,
          snapshotAttestationMatched: false,
          coherenceRetryCount: 0,
          initialEpochSkew: false,
        }),
      );
      expect(
        sameEpochAttestationFailure.resources.dataBytes,
      ).toBe(
        sameEpochAttestationFailure.resources.observedDataBytes,
      );

      delete fixture.__monitorMemoryPathReads;
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");

      const executeLogisticsMutation = (
        mutate: (logistics: Record<string, any>) => void,
        refreshAttestation = true,
      ): Record<string, any> => {
        const logistics = JSON.parse(
          JSON.stringify(validLogistics),
        ) as Record<string, any>;
        mutate(logistics);
        if (refreshAttestation) {
          refreshRuntimeResourceAttestation(logistics);
        }
        fixture.runtime.resourceControl.logistics = logistics;
        fixture.data.resourceControl.logistics = JSON.parse(
          JSON.stringify(validDataLogistics),
        );
        writeFileSync(
          fixturePath,
          JSON.stringify(fixture),
          "utf8",
        );
        return executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      };

      const executeDataLogisticsMutation = (
        mutate: (logistics: Record<string, any>) => void,
        refreshAttestation = true,
      ): Record<string, any> => {
        const runtimeLogistics = JSON.parse(
          JSON.stringify(validLogistics),
        );
        fixture.runtime.resourceControl.logistics = runtimeLogistics;
        const dataLogistics = JSON.parse(
          JSON.stringify(validDataLogistics),
        ) as Record<string, any>;
        mutate(dataLogistics);
        fixture.data.resourceControl.logistics = dataLogistics;
        if (refreshAttestation) {
          runtimeLogistics.resources.dataItems =
            Array.isArray(dataLogistics.i) &&
            Array.isArray(dataLogistics.o) &&
            Array.isArray(dataLogistics.f) &&
            Array.isArray(dataLogistics.p)
              ? (2 * dataLogistics.i.length) +
                dataLogistics.o.length +
                dataLogistics.f.length +
                dataLogistics.p.length
              : 0;
          runtimeLogistics.resources.dataBytes = Buffer.byteLength(
            JSON.stringify(dataLogistics),
            "utf8",
          );
          refreshRuntimeResourceAttestation(runtimeLogistics);
        }
        writeFileSync(
          fixturePath,
          JSON.stringify(fixture),
          "utf8",
        );
        return executeFixture(fixturePath).payload.memory
          .resourceControl.logistics;
      };

      const currentTickAnalytics = fixture.analytics.production;
      delete fixture.analytics.production;
      expect(
        executeLogisticsMutation(() => {}).livenessAvailable,
      ).toBe(false);
      fixture.analytics.production = currentTickAnalytics;

      const dataItemMismatch = executeDataLogisticsMutation(
        (logistics) => {
          logistics.s.push("zz-producer");
          logistics.p.push([
            8, 7, 4, 2000, 2010, 0, 0, 0, 0, 0, 32, 0,
          ]);
        },
        false,
      );
      expect(dataItemMismatch.resources).toEqual(
        expect.objectContaining({
          dataItems: 4,
          observedDataItems: 5,
        }),
      );
      expect(dataItemMismatch).toEqual(
        expect.objectContaining({
          snapshotIncoherent: false,
          inconclusive: false,
          snapshotAttestationMatched: false,
          coherenceRetryCount: 0,
          initialEpochSkew: false,
        }),
      );
      expect(dataItemMismatch.livenessAvailable).toBe(false);
      fixture.data.resourceControl.logistics = JSON.parse(
        JSON.stringify(validDataLogistics),
      );

      const malformedWireArity = executeDataLogisticsMutation(
        (logistics) => {
          logistics.o[0].pop();
        },
      );
      expect(malformedWireArity.resources.dataItems).toBe(
        malformedWireArity.resources.observedDataItems,
      );
      expect(malformedWireArity.resources.dataBytes).toBe(
        malformedWireArity.resources.observedDataBytes,
      );
      expect(malformedWireArity.livenessAvailable).toBe(false);
      const invalidWireIndex = executeDataLogisticsMutation(
        (logistics) => {
          logistics.i[0][0] = 999;
        },
      );
      expect(invalidWireIndex.livenessAvailable).toBe(false);
      const unknownWireEnum = executeDataLogisticsMutation(
        (logistics) => {
          logistics.i[0][4] = 99;
        },
      );
      expect(unknownWireEnum.livenessAvailable).toBe(false);
      const negativeWireAmount = executeDataLogisticsMutation(
        (logistics) => {
          logistics.i[0][8] = -1;
        },
      );
      expect(negativeWireAmount.livenessAvailable).toBe(false);
      const unknownWireResource = executeDataLogisticsMutation(
        (logistics) => {
          logistics.s[3] = "not-a-screeps-resource";
        },
      );
      expect(unknownWireResource.livenessAvailable).toBe(false);
      const cursorBehindGeneration = executeDataLogisticsMutation(
        (logistics) => {
          logistics.c = 0;
        },
      );
      expect(cursorBehindGeneration.resources.dataBytes).toBe(
        cursorBehindGeneration.resources.observedDataBytes,
      );
      expect(cursorBehindGeneration.livenessAvailable).toBe(false);
      const missingProducerSnapshot = executeDataLogisticsMutation(
        (logistics) => {
          logistics.s.pop();
          logistics.p = [];
        },
      );
      expect(missingProducerSnapshot.livenessAvailable).toBe(false);
      const mismatchedSnapshotEmission = executeDataLogisticsMutation(
        (logistics) => {
          logistics.p[0][7] = 2;
          logistics.p[0][8] = 2;
        },
      );
      expect(mismatchedSnapshotEmission.livenessAvailable).toBe(false);
      const snapshotExpiryGap = executeDataLogisticsMutation(
        (logistics) => {
          logistics.p[0][4] = 2009;
        },
      );
      expect(snapshotExpiryGap.livenessAvailable).toBe(false);
      const discontinuousDecisionOrder = executeDataLogisticsMutation(
        (logistics) => {
          logistics.o[0][5] = 1;
        },
      );
      expect(discontinuousDecisionOrder.livenessAvailable).toBe(false);
      const canonicalCodeUnitWire = executeDataLogisticsMutation(
        (logistics) => {
          logistics.s.push("é");
          logistics.p.push([
            8, 7, 4, 2000, 2010, 0, 0, 0, 0, 0, 32, 0,
          ]);
        },
      );
      expect(canonicalCodeUnitWire.livenessAvailable).toBe(true);
      const nonCanonicalWire = executeDataLogisticsMutation(
        (logistics) => {
          logistics.s.push("unused-string");
        },
      );
      expect(nonCanonicalWire.resources.dataBytes).toBe(
        nonCanonicalWire.resources.observedDataBytes,
      );
      expect(nonCanonicalWire.livenessAvailable).toBe(false);
      const oversizedWireCollection = executeDataLogisticsMutation(
        (logistics) => {
          logistics.p = Array.from(
            { length: 33 },
            () => [...logistics.p[0]],
          );
        },
      );
      expect(
        oversizedWireCollection.resources.observedDataItems,
      ).toBeNull();
      expect(oversizedWireCollection.livenessAvailable).toBe(false);
      const oversizedWireBytes = executeDataLogisticsMutation(
        (logistics) => {
          logistics.s[0] = "x".repeat(17_000);
        },
      );
      expect(
        oversizedWireBytes.resources.observedDataBytes,
      ).toBeGreaterThan(16_384);
      expect(oversizedWireBytes.livenessAvailable).toBe(false);

      expect(
        executeLogisticsMutation((logistics) => {
          logistics.expiresAt = 1999;
        }).livenessAvailable,
      ).toBe(false);
      const unknownEnum = executeLogisticsMutation(
        (logistics) => {
          logistics.requestedMode = "mystery";
        },
      );
      expect(unknownEnum.requestedMode).toBeNull();
      expect(unknownEnum.livenessAvailable).toBe(false);
      const unknownCountKey = executeLogisticsMutation(
        (logistics) => {
          logistics.inScopeByOrigin = {
            unknown_origin: 1,
          };
        },
      );
      expect(unknownCountKey.inScopeByOrigin).toEqual({});
      expect(unknownCountKey.livenessAvailable).toBe(false);
      const originCountMismatch = executeLogisticsMutation(
        (logistics) => {
          logistics.inScopeByOrigin.synthesis_room = 2;
        },
      );
      expect(originCountMismatch.livenessAvailable).toBe(false);
      const freshnessCountMismatch = executeLogisticsMutation(
        (logistics) => {
          logistics.intent.fresh = 0;
        },
      );
      expect(freshnessCountMismatch.livenessAvailable).toBe(false);
      const comparisonCountMismatch = executeLogisticsMutation(
        (logistics) => {
          logistics.intent.active = 0;
        },
      );
      expect(comparisonCountMismatch.livenessAvailable).toBe(false);
      const fakeDisabledSuccess = executeLogisticsMutation(
        (logistics) => {
          logistics.requestedMode = "disabled";
        },
      );
      expect(fakeDisabledSuccess.available).toBe(true);
      expect(fakeDisabledSuccess.livenessAvailable).toBe(false);
      const negativeCpu = executeLogisticsMutation(
        (logistics) => {
          logistics.cpu.used = -0.01;
        },
      );
      expect(negativeCpu.cpu.used).toBeNull();
      expect(negativeCpu.livenessAvailable).toBe(false);
      const oversizedProjection = executeLogisticsMutation(
        (logistics) => {
          logistics.resources.dataItems = 161;
          logistics.resources.dataBytes = 0;
          logistics.resources.runtimeBytes = 16_385;
          logistics.resources.totalBytes = 16_385;
        },
        false,
      );
      expect(oversizedProjection.resources.dataItems).toBeNull();
      expect(oversizedProjection.resources.runtimeBytes).toBeNull();
      expect(oversizedProjection.livenessAvailable).toBe(false);
      const oversizedCombined = executeLogisticsMutation(
        (logistics) => {
          logistics.resources.dataBytes = 20_000;
          logistics.resources.runtimeBytes = 13_000;
          logistics.resources.totalBytes = 33_000;
          logistics.resources.withinLimit = false;
        },
        false,
      );
      expect(oversizedCombined.resources.dataBytes).toBeNull();
      expect(oversizedCombined.resources.totalBytes).toBeNull();
      expect(oversizedCombined.livenessAvailable).toBe(false);
      const observableRecord = executeLogisticsMutation(
        (logistics) => {
          logistics.safety.shadowJournalRecords = 1;
        },
      );
      expect(observableRecord.safety.shadowJournalRecords).toBe(1);
      expect(observableRecord.livenessAvailable).toBe(false);
      const impossibleActiveContract = executeLogisticsMutation(
        (logistics) => {
          logistics.safety.activeContracts = 1;
        },
      );
      expect(impossibleActiveContract.safety.activeContracts).toBe(1);
      expect(impossibleActiveContract.livenessAvailable).toBe(false);
      const unknownMeasurementBoundary = executeLogisticsMutation(
        (logistics) => {
          logistics.safety.measurementBoundary = "attempt_counter_v1";
        },
      );
      expect(
        unknownMeasurementBoundary.safety.measurementBoundary,
      ).toBeNull();
      expect(unknownMeasurementBoundary.livenessAvailable).toBe(false);
      const truncatedIntent = executeLogisticsMutation(
        (logistics) => {
          logistics.intent.dropped = 1;
          logistics.intent.truncated = true;
        },
      );
      expect(truncatedIntent.intent).toEqual(
        expect.objectContaining({
          dropped: 1,
          truncated: true,
        }),
      );
      expect(truncatedIntent.livenessAvailable).toBe(false);
      const exhaustedMatcher = executeLogisticsMutation(
        (logistics) => {
          logistics.matcher.candidateEvaluations = 128;
          logistics.matcher.budgetExhausted = true;
        },
      );
      expect(exhaustedMatcher.matcher.budgetExhausted).toBe(true);
      expect(exhaustedMatcher.livenessAvailable).toBe(false);
      const oversizedCostScan = executeLogisticsMutation(
        (logistics) => {
          logistics.matcher.transactionCostEvaluations = 4_353;
          logistics.matcher.totalTransactionCostEvaluations = 4_353;
        },
      );
      expect(
        oversizedCostScan.matcher.transactionCostEvaluations,
      ).toBeNull();
      expect(oversizedCostScan.livenessAvailable).toBe(false);
      const incompleteProjection = executeLogisticsMutation(
        (logistics) => {
          logistics.complete = false;
          logistics.projectionTruncated = true;
        },
      );
      expect(incompleteProjection.complete).toBe(false);
      expect(incompleteProjection.projectionTruncated).toBe(true);
      expect(incompleteProjection.livenessAvailable).toBe(false);
      const unavailableCpu = executeLogisticsMutation(
        (logistics) => {
          logistics.cpu.measurementAvailable = false;
          logistics.cpu.used = 0;
        },
      );
      expect(unavailableCpu.cpu).toEqual({
        measurementAvailable: false,
        captureUsed: 0.1,
        used: 0,
        cpuGateEligible: false,
        gateInconclusive: true,
      });
      expect(unavailableCpu.livenessAvailable).toBe(false);
      const oversizedSafety = executeLogisticsMutation(
        (logistics) => {
          logistics.safety.violations = Array.from(
            { length: 25 },
            (_, index) => index === 0
              ? oversized
              : `logistics-violation:${index}`,
          );
        },
      );
      expect(oversizedSafety.safety.violations).toHaveLength(20);
      expect(oversizedSafety.safety.violations[0]).toHaveLength(256);
      expect(oversizedSafety.livenessAvailable).toBe(false);
      const malformedSample = executeLogisticsMutation(
        (logistics) => {
          logistics.comparison.samples[0].status = "same";
        },
      );
      expect(malformedSample.comparison.samples[0].status).toBeNull();
      expect(malformedSample.livenessAvailable).toBe(false);

      fixture.runtime.hub.distributedSynthesis.blockedTargets = [123];
      fixture.runtime.resourceControl.taskSummary.coverageExpiredByReason = {
        unknown_timeout: 1,
      };
      writeFileSync(fixturePath, JSON.stringify(fixture), "utf8");
      const malformed = executeFixture(fixturePath).payload.memory;
      expect(malformed.hub.distributedSynthesis.livenessAvailable).toBe(false);
      expect(malformed.resourceControl.taskSummary.livenessAvailable).toBe(false);

      const service = spawnSync(
        process.execPath,
        [
          MONITOR_SCRIPT,
          "--memory-fixture",
          fixturePath,
          "--segment-id",
          "off",
          "--output",
          "off",
          "--no-http",
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 1_000,
        },
      );
      const memoryLogLine = service.stdout
        .split("\n")
        .find((line) =>
          line.startsWith("[monitor][memory]"),
        );
      expect(memoryLogLine).toBeDefined();
      expect(memoryLogLine!.length).toBeLessThanOrEqual(4_096);
      expect(
        memoryLogLine!.endsWith(" …[truncated]"),
      ).toBe(true);
    } finally {
      rmSync(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
