import {
  beginHubProtectionAttempt,
  buildCommittedHubProtectionSnapshot,
  observeHubProtectionConfigIncarnation,
  publishCommittedHubProtectionSnapshot,
  readFreshCommittedHubProtectionSnapshot,
  type HubProtectionConfigInput,
  type HubRuntimeProtectionExtension,
} from "@/runtime/hubProtectionSnapshot";

const HUB_ROOM = "W1N1";
const TICK = 10_000;

function config(
  overrides: Partial<HubProtectionConfigInput> = {},
): HubProtectionConfigInput {
  return {
    enabled: true,
    hubRoomName: HUB_ROOM,
    planInterval: 50,
    reservePerRoom: 5_000,
    hubReservePerCompound: 10_000,
    targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    storagePauseFreeCapacity: 100_000,
    surplusThreshold: 1_500,
    internalOnly: true,
    distributedStorage: true,
    ...overrides,
  };
}

function distributedRuntime(
  hydrogenResidual = 3_000,
): HubRuntimeProtectionExtension & {
  distributedSynthesis: {
    dispatchAssignments: unknown[];
    routeDecisions: unknown[];
    allocationLedger: Record<string, unknown>;
  };
} {
  return {
    distributedSynthesis: {
      dispatchAssignments: [
        {
          roomName: HUB_ROOM,
          product: RESOURCE_HYDROXIDE,
          targetAmount: 1_000,
          isHubRoom: true,
        },
      ],
      routeDecisions: [],
      allocationLedger: {
        [RESOURCE_HYDROGEN]: {
          resource: RESOURCE_HYDROGEN,
          totalAmount: hydrogenResidual,
          roomCommitments: { [HUB_ROOM]: hydrogenResidual },
        },
        [RESOURCE_CATALYZED_UTRIUM_ACID]: {
          resource: RESOURCE_CATALYZED_UTRIUM_ACID,
          totalAmount: 50_000,
          roomCommitments: { [HUB_ROOM]: 50_000 },
        },
      },
    },
  };
}

function commit(
  runtime: ReturnType<typeof distributedRuntime>,
  cfg = config(),
  planMode: "distributed" | "fallback" | "blocked" = "distributed",
  tick = TICK,
) {
  const attempt = beginHubProtectionAttempt(runtime, cfg, tick);
  const snapshot = buildCommittedHubProtectionSnapshot({
    revision: attempt.attemptRevision,
    configIncarnation: attempt.configIncarnation,
    tick,
    expiresAt: tick + 50,
    config: cfg,
    runtime,
    synthesisRooms: {},
    transferTasks: {},
    planMode,
  });
  publishCommittedHubProtectionSnapshot(runtime, attempt, snapshot);
  return snapshot;
}

describe("Hub committed market protection snapshot", () => {

  it("OH 五万目标绑定配置指纹和 committed marker，变更或损坏后必须重规划", () => {
    const runtime = distributedRuntime();
    const cfg = config({ targetCompounds: [RESOURCE_HYDROXIDE], hubOnlyReservePerCompound: 50000 });
    const snapshot = commit(runtime, cfg);
    expect(snapshot.marker.hubOnlyReservePerCompound).toBe(50000);
    expect(readFreshCommittedHubProtectionSnapshot(runtime, cfg, TICK)).toBeDefined();
    expect(readFreshCommittedHubProtectionSnapshot(runtime, { ...cfg, hubOnlyReservePerCompound: 20000 }, TICK)).toBeUndefined();
    runtime.committedProtectionSnapshot = { ...snapshot, marker: { ...snapshot.marker, hubOnlyReservePerCompound: 0 } };
    expect(readFreshCommittedHubProtectionSnapshot(runtime, cfg, TICK)).toBeUndefined();
  });

  it("never reuses a prior config incarnation after A→B→A", () => {
    const runtime = distributedRuntime();
    const configA = config();
    const first = commit(runtime, configA);
    const firstIncarnation = first.configIncarnation;

    const configB = config({ surplusThreshold: 2_000 });
    const observedB = observeHubProtectionConfigIncarnation(
      runtime,
      configB,
      TICK + 1,
    );
    const observedAAgain = observeHubProtectionConfigIncarnation(
      runtime,
      configA,
      TICK + 2,
    );

    expect(observedB.changed).toBe(true);
    expect(observedB.observation.incarnation).toBe(firstIncarnation + 1);
    expect(observedAAgain.changed).toBe(true);
    expect(observedAAgain.observation.incarnation).toBe(
      firstIncarnation + 2,
    );
    expect(runtime.protectionConfigIncarnationHighWater).toBe(
      firstIncarnation + 2,
    );
    expect(
      readFreshCommittedHubProtectionSnapshot(
        runtime,
        configA,
        TICK + 2,
      ),
    ).toBeUndefined();
  });

  it("advances past a one-sided config-incarnation high-water rollback", () => {
    const runtime = distributedRuntime();
    const configA = config();
    const first = commit(runtime, configA);
    runtime.protectionConfigIncarnationHighWater = 0;

    const recovered = observeHubProtectionConfigIncarnation(
      runtime,
      configA,
      TICK + 1,
    );

    expect(recovered.changed).toBe(true);
    expect(recovered.observation.incarnation).toBe(
      first.configIncarnation + 1,
    );
    expect(runtime.protectionConfigIncarnationHighWater).toBe(
      first.configIncarnation + 1,
    );
    expect(
      readFreshCommittedHubProtectionSnapshot(
        runtime,
        configA,
        TICK + 1,
      ),
    ).toBeUndefined();
  });
});
