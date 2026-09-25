import {
  createMarketBaseRoomAdmissionPolicy,
  createMarketBaseSharedPolicy,
  MARKET_BASE_BOOK_EMA_MAX_AGE_TICKS,
  MARKET_BASE_BOOK_EMA_TICK_TIME_CONSTANT,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  buildMarketBaseDynamicFloorState,
  marketBaseDerivedLaneSetFingerprint,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  updateMarketBaseBookEma,
  type MarketBaseRoomObservation,
  validateMarketBaseFloorBootstrap,
} from "@/runtime/marketBaseResourcePolicy";



function observation(
  roomName: string,
  overrides: Partial<MarketBaseRoomObservation> = {},
): MarketBaseRoomObservation {
  return {
    roomName,
    visible: true,
    controllerMy: true,
    controllerOwner: "Forst",
    terminalId: `terminal-${roomName}`,
    terminalOwned: true,
    roomClass: "normal",
    ...overrides,
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireSuccessfulRooms(
  result: ReturnType<typeof reconcileMarketBaseSellerRooms>,
): Extract<typeof result, { ok: true }> {
  if (result.ok === false) {
    throw new Error(`unexpected blockers: ${result.blockers.join(",")}`);
  }
  return result;
}

describe("marketBaseResourcePolicy 重合同（bootstrap 准入 + 房/lane 建立）", () => {
  // Jest 预算归并（reduce-jest-suite-to-500 约定）：原 catalog/bootstrap
  // 与 room admission 两个参数化变体合并为单一代表性重合同用例。
  it("bootstrap fail-closed 与新房 generation/lane 建立覆盖同一合同面", () => {
    expect(
      validateMarketBaseFloorBootstrap(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP),
    ).toEqual({ valid: true, invalidReasons: [] });

    const missing = jsonClone(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP) as Record<
      string,
      any
    >;
    delete missing.resources.O;
    expect(validateMarketBaseFloorBootstrap(missing).invalidReasons).toContain(
      "base_floor_bootstrap_resource_set_mismatch",
    );

    const digest = jsonClone(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP) as Record<
      string,
      any
    >;
    digest.evidenceSha256 = "0".repeat(64);
    expect(validateMarketBaseFloorBootstrap(digest).invalidReasons).toContain(
      "base_floor_bootstrap_evidence_digest_mismatch",
    );

    const rollback = jsonClone(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP) as Record<
      string,
      any
    >;
    rollback.historyDate = "2026-07-26";
    expect(
      validateMarketBaseFloorBootstrap(rollback, {
        minimumHistoryDate: "2026-07-27",
      }).invalidReasons,
    ).toEqual(
      expect.arrayContaining([
        "base_floor_bootstrap_history_date_mismatch",
        "base_floor_bootstrap_history_date_rollback",
      ]),
    );

    expect(
      validateMarketBaseFloorBootstrap(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP, {
        previousFingerprint: MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint,
      }).invalidReasons,
    ).toContain("base_floor_bootstrap_duplicate");

    const admission = createMarketBaseRoomAdmissionPolicy("Forst");
    const shared = createMarketBaseSharedPolicy("Forst");
    const rooms = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    expect(rooms.sellerRooms).toHaveLength(1);
    expect(rooms.sellerRooms[0]).toMatchObject({
      roomName: "E1N1",
      incarnation: 1,
      previousInstanceId: null,
      status: "admitted",
    });

    const lanes = reconcileMarketBaseDerivedLanes({
      sharedPolicyFingerprint: shared.fingerprint,
      sellerRooms: rooms.sellerRooms,
    });
    expect(lanes.ok).toBe(true);
    expect(lanes.lanes).toHaveLength(7);
    expect(lanes.newLaneIds).toHaveLength(7);
    expect(
      lanes.lanes?.every(
        (lane) =>
          lane.stage === "shadow" &&
          lane.status === "suspended" &&
          lane.shadowEvidence.completeCycles === 0,
      ),
    ).toBe(true);
    expect(lanes.laneSetFingerprint).toBe(
      marketBaseDerivedLaneSetFingerprint(lanes.lanes!),
    );
  });
});

describe("2026-09-25 价格再校准", () => {
  it("以 14 个完整日 p25 保留旧底价或重定较低底价，并维持 Direct 动态界", () => {
    const p25 = {
      H: 609.405, K: 37.623, L: 546.789, O: 81.802,
      U: 34.92, X: 433.099, Z: 62.857,
    } as const;
    const old = {
      H: { hard: 428, economic: 451 },
      K: { hard: 96, economic: 101 },
      L: { hard: 161, economic: 169 },
      O: { hard: 138, economic: 145 },
      U: { hard: 44, economic: 46 },
      X: { hard: 480, economic: 480 },
      Z: { hard: 43, economic: 45 },
    } as const;
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
      const economic = Math.min(old[resource].economic, Math.ceil(p25[resource] * 0.9));
      expect(policy.economicFloor).toBe(economic);
      expect(policy.hardFloor).toBe(Math.min(old[resource].hard, Math.ceil(economic * 0.95)));
      expect(policy.minOrderNotional).toBe(economic * 1_000);
      expect(policy.directNetBidRatio).toBe(0.85);
      expect(policy.dynamicFloorMode).toBe("enforce");
      expect(policy.laneReserve).toBe(100_000);
    }
  });
});

describe("Market Base 动态地板投影（bookEMA + 库存分量 + 日限幅）", () => {
  // Jest 预算归并：EMA 边界、地板合成+跨日锚、无盈余退化三个参数化
  // 变体合并为单一代表性重合同用例。
  it("EMA seed/α/回退与投影合成、日锚限幅、无盈余退化覆盖同一合同面", () => {
    const seed = updateMarketBaseBookEma({
      previousEma: null,
      previousObservedAt: 0,
      observedPrice: 500,
      tick: 100,
    });
    expect(seed.ema).toBe(500);
    expect(seed.observedAt).toBe(100);
    // 一整个时间常数后 α=1−e^−1。
    const next = updateMarketBaseBookEma({
      previousEma: seed.ema,
      previousObservedAt: seed.observedAt,
      observedPrice: 400,
      tick: 100 + MARKET_BASE_BOOK_EMA_TICK_TIME_CONSTANT,
    });
    expect(next.ema).toBeCloseTo(
      (1 - Math.exp(-1)) * 400 + Math.exp(-1) * 500,
      8,
    );
    // 非法观测价格不更新。
    const invalid = updateMarketBaseBookEma({
      previousEma: next.ema,
      previousObservedAt: next.observedAt,
      observedPrice: -1,
      tick: 200,
    });
    expect(invalid.ema).toBe(next.ema);
    expect(invalid.observedAt).toBe(next.observedAt);

    const hPolicy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE.H;
    const state = buildMarketBaseDynamicFloorState({
      previous: undefined,
      tick: 1_000,
      marketDate: "2026-08-22",
      bookBestPrices: [{ resource: "H", price: 460 }],
      laneSurplus: [
        // surplusRatio = 200_000/80_000 = 2.5 → factor=(2.5−1)/(3−1)=0.75
        { resource: "H", sellable: 200_000, rollingMax: 80_000 },
      ],
      ratchetFloorByResource: { H: 520 },
    });
    const h = state.entries.find((entry) => entry.resource === "H")!;
    expect(h.bookEma).toBe(460);
    expect(h.surplusRatio).toBe(2.5);
    expect(h.inventoryFactor).toBeCloseTo(0.75, 10);
    // 高库存时按 Direct 净价比例下探，但硬底价仍兜底。
    expect(h.dynamicFloor).toBe(hPolicy.hardFloor);
    expect(h.dailyAnchor).toBe(hPolicy.hardFloor);
    expect(h.anchorDate).toBe("2026-08-22");
    // 其余资源无观测：EMA null、dynamicFloor null、状态安全。
    const x = state.entries.find((entry) => entry.resource === "X")!;
    expect(x.bookEma).toBeNull();
    expect(x.dynamicFloor).toBeNull();

    // 次日订单簿崩到 300：EMA 拉低后投影受 15%/日限幅，
    // 下限 = anchor × 0.85。
    const decayed = buildMarketBaseDynamicFloorState({
      previous: state,
      tick: 30_000,
      marketDate: "2026-08-23",
      bookBestPrices: [{ resource: "H", price: 300 }],
      laneSurplus: [
        { resource: "H", sellable: 240_000, rollingMax: 80_000 },
      ],
      ratchetFloorByResource: { H: 520 },
    });
    const hNext = decayed.entries.find((entry) => entry.resource === "H")!;
    expect(hNext.inventoryFactor).toBe(1);
    const anchor = h.dailyAnchor;
    // 次日 EMA≈302.8，库存折让后的值低于 hard 428。
    // 跨日限幅下限 = 前日锚×0.85 < 428 → 投影落在 hardFloor，
    // 且新日锚立为限幅后的实际投影值。
    expect(hNext.dynamicFloor).toBeCloseTo(
      Math.max(hPolicy.hardFloor, anchor * 0.85, 300 * 0.85),
      10,
    );
    expect(hNext.dailyAnchor).toBeCloseTo(hNext.dynamicFloor as number, 10);
    expect(hNext.dynamicFloor).toBeGreaterThanOrEqual(anchor * 0.85 - 1e-9);
    expect(hNext.dynamicFloor).toBeGreaterThanOrEqual(hPolicy.hardFloor);

    // EMA 停滞超过两个时间常数（2τ=14400 tick）：df 降级 null（回退
    // ratchet 语义），EMA 状态与日锚保留。
    const stale = buildMarketBaseDynamicFloorState({
      previous: state,
      tick: 1_000 + MARKET_BASE_BOOK_EMA_MAX_AGE_TICKS + 1,
      marketDate: "2026-08-22",
      bookBestPrices: [],
      laneSurplus: [],
      ratchetFloorByResource: { H: 520 },
    });
    const hStale = stale.entries.find((entry) => entry.resource === "H")!;
    expect(hStale.bookEma).toBe(460);
    expect(hStale.dynamicFloor).toBeNull();
    expect(hStale.dailyAnchor).toBe(hPolicy.hardFloor);

    // 观测中断 3 日后恢复：跨日限幅按日序差叠加——下限 = 前锚×0.85³。
    // X seed 590（ratchet 同值）→ 3 日后观测 300：硬底价 371 兜底，
    // 多日下限 590×0.85³≈362.3；单日限幅则仍会卡在 501.5。
    const xSeed = buildMarketBaseDynamicFloorState({
      previous: undefined,
      tick: 2_000,
      marketDate: "2026-08-22",
      bookBestPrices: [{ resource: "X", price: 590 }],
      laneSurplus: [],
      ratchetFloorByResource: { X: 590 },
    });
    const xRecovered = buildMarketBaseDynamicFloorState({
      previous: xSeed,
      tick: 2_000 + 3 * 24_000,
      marketDate: "2026-08-25",
      bookBestPrices: [{ resource: "X", price: 300 }],
      laneSurplus: [],
      ratchetFloorByResource: { X: 590 },
    });
    const xNext = xRecovered.entries.find(
      (entry) => entry.resource === "X",
    )!;
    expect(xNext.dynamicFloor).toBeCloseTo(
      Math.max(MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE.X.hardFloor, 590 * Math.pow(0.85, 3), 300),
      6,
    );
    expect(xNext.dynamicFloor).not.toBeCloseTo(
      Math.max(MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE.X.hardFloor, 590 * 0.85, 300),
      6,
    );

    const noSurplus = buildMarketBaseDynamicFloorState({
      previous: undefined,
      tick: 500,
      marketDate: "2026-08-22",
      bookBestPrices: [{ resource: "X", price: 505 }],
      laneSurplus: [],
      ratchetFloorByResource: { X: 589.857 },
    });
    const xNoSurplus = noSurplus.entries.find(
      (entry) => entry.resource === "X",
    )!;
    expect(xNoSurplus.surplusRatio).toBeNull();
    expect(xNoSurplus.inventoryFactor).toBe(0);
    // 无盈余时不折让，bookEMA 505 仍可作为动态观察值。
    expect(xNoSurplus.dynamicFloor).toBeCloseTo(505, 10);
  });
});
