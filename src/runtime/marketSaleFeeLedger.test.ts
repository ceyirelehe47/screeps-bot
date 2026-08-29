import {
  advanceFeeLedgerWindow,
  applyFillFeeDebt,
  commitProspectiveFeeReservation,
  createEmptyMarketSaleFeeLedger,
  createFeeLedgerBlocked,
  markExternalOrderMutationFeeGap,
  reconcileDisappearedOrderFeeDebt,
  reserveProspectiveFee,
  resolveExternalOrderMutationFeeGap,
  resolveFeeLedgerInvalid,
  takeCarriedFeeDebt,
  validateFeeLedger,
  type FeeLedgerLimits,
} from "@/runtime/marketSaleFeeLedger";

const LIMITS: FeeLedgerLimits = {
  feeWindowTicks: 10,
  fillReceiptWindowTicks: 20,
  maxFeeEvents: 8,
  maxSameTickReservations: 4,
  maxProcessedFills: 8,
};


describe("fill idempotency and fee-debt allocation", () => {
  it("uses transactionId+orderId exactly once and preserves pricing rounding remainder", () => {
    const first = applyFillFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "order-1",
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 3,
      limits: LIMITS,
    });
    expect(first).toMatchObject({
      applied: true,
      duplicate: false,
      reconcileGap: false,
      allocation: {
        allocatedFeeDebtMilli: 3,
        remainingFeeDebtMilli: 7,
        postRemainingAmount: 2,
      },
    });

    const duplicate = applyFillFeeDebt({
      ledger: first.ledger,
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "order-1",
      feeDebtMilli: 7,
      filledAmount: 1,
      preRemainingAmount: 3,
      limits: LIMITS,
    });
    expect(duplicate).toMatchObject({
      applied: false,
      duplicate: true,
      reconcileGap: false,
    });
    expect(duplicate.ledger.processedFills).toHaveLength(1);
  });

  it("fails closed at receipt capacity and admits new evidence only after the receipt window expires", () => {
    const singleReceiptLimits = {
      ...LIMITS,
      fillReceiptWindowTicks: 2,
      maxProcessedFills: 1,
    };
    const first = applyFillFeeDebt({
      ledger: createEmptyMarketSaleFeeLedger(),
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "order-1",
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 2,
      limits: singleReceiptLimits,
    });
    const full = applyFillFeeDebt({
      ledger: first.ledger,
      gameTime: 101,
      transactionId: "tx-2",
      orderId: "order-1",
      feeDebtMilli: 5,
      filledAmount: 1,
      preRemainingAmount: 1,
      limits: singleReceiptLimits,
    });
    expect(full.ledger.reconcileGap?.reason).toBe("fill_receipt_capacity");

    const afterExpiry = applyFillFeeDebt({
      ledger: { ...first.ledger, reconcileGap: undefined },
      gameTime: 102,
      transactionId: "tx-2",
      orderId: "order-1",
      feeDebtMilli: 5,
      filledAmount: 1,
      preRemainingAmount: 1,
      limits: singleReceiptLimits,
    });
    expect(afterExpiry.applied).toBe(true);
    expect(afterExpiry.ledger.processedFills).toHaveLength(1);
  });
});

describe("fee ledger fail-closed（损坏不得被解释为预算为零使用）", () => {
  const GATE_INPUT = {
    gameTime: 100,
    action: "extend" as const,
    prospectiveFeeMilli: 100,
    creditsMilli: 10_000_000,
    creditReserveMilli: 0,
    rollingFeeBudgetMilli: 1_000,
    limits: LIMITS,
  };

  /** rolling 预算已耗尽的完好账本（窗口内 1000 milli 全部花掉）。 */
  function exhaustedLedger() {
    return {
      feeEvents: [
        { id: "evt-1", tick: 95, action: "create" as const, feeMilli: 900 },
        { id: "evt-2", tick: 96, action: "extend" as const, feeMilli: 100 },
      ],
      sameTickReservations: [],
      processedFills: [],
      carriedFeeDebtMilli: {},
    };
  }

  it("预算已耗尽的账本损坏单字段：tagged invalid + blocker 拒绝，而非空窗口放行", () => {
    // 对照 1：同预算的完好账本 → gate 因 rolling_fee_budget 拒绝。
    const intact = reserveProspectiveFee({
      ...GATE_INPUT,
      reservationId: "r-intact",
      ledger: exhaustedLedger(),
    });
    expect(intact.allowed).toBe(false);
    expect(intact.reasons).toContain("rolling_fee_budget");

    // 同条目数，但一条 feeMilli 损坏（负数）→ tagged invalid（非静默）。
    const corrupted = exhaustedLedger();
    (corrupted.feeEvents[1] as { feeMilli: number }).feeMilli = -1;
    const validation = validateFeeLedger(corrupted);
    expect(validation.status).toBe("invalid");
    if (validation.status === "invalid") {
      expect(validation.reason.length).toBeGreaterThan(0);
    }

    // fail-closed 替身：空窗口 + 不可绕过 blocker → gate 以
    // fee_ledger_invalid 拒绝（不会因空窗口被解释成预算为零使用）。
    const blocked = createFeeLedgerBlocked("fee event feeMilli", 100);
    const gated = reserveProspectiveFee({
      ...GATE_INPUT,
      reservationId: "r-blocked",
      ledger: blocked,
    });
    expect(gated.allowed).toBe(false);
    expect(gated.reasons).toContain("fee_ledger_invalid");
    // blocker 优先且不可被其余判定掩盖。
    expect(gated.reasons[0]).toBe("fee_ledger_invalid");
  });

  it("同条目数但 reservation / receipt / carried debt 字段损坏逐项检出", () => {
    const base = createEmptyMarketSaleFeeLedger();
    // reservation status 损坏。
    expect(
      validateFeeLedger({
        ...base,
        sameTickReservations: [
          { id: "r-1", tick: 100, action: "create", feeMilli: 5, status: "bogus" },
        ],
      }).status,
    ).toBe("invalid");
    // fill receipt 字段损坏（filledAmount 非正）。
    expect(
      validateFeeLedger({
        ...base,
        processedFills: [
          {
            key: "3:txao",
            transactionId: "tx",
            orderId: "ao",
            tick: 100,
            filledAmount: 0,
            preRemainingAmount: 5,
            allocatedFeeDebtMilli: 1,
          },
        ],
      }).status,
    ).toBe("invalid");
    // carried debt 负值。
    expect(
      validateFeeLedger({ ...base, carriedFeeDebtMilli: { energy: -5 } })
        .status,
    ).toBe("invalid");
    // 损坏的 invalid 标记本身也视为整体损坏。
    expect(
      validateFeeLedger({ ...base, invalid: { reason: "", observedAt: 1 } })
        .status,
    ).toBe("invalid");
    // 完好 blocked 账本（blocker 形状合法）→ 校验通过，blocker 生效中。
    const blockedValid = validateFeeLedger(
      createFeeLedgerBlocked("reason", 100),
    );
    expect(blockedValid.status).toBe("valid");
  });

  it("blocked 账本：窗口推进与克隆传播 blocker；费用写入与提取一律抛错", () => {
    const blocked = createFeeLedgerBlocked("quarantined evidence", 100);
    // 窗口推进不洗掉 blocker。
    const advanced = advanceFeeLedgerWindow(blocked, 105, LIMITS);
    expect(advanced.invalid).toMatchObject({ reason: "quarantined evidence" });
    expect(advanced.feeEvents).toHaveLength(0);

    expect(() =>
      commitProspectiveFeeReservation({
        ledger: blocked,
        reservationId: "r-1",
        gameTime: 100,
        limits: LIMITS,
      }),
    ).toThrow(/blocked/);
    expect(() =>
      takeCarriedFeeDebt(blocked, "energy"),
    ).toThrow(/blocked/);
    expect(() =>
      resolveExternalOrderMutationFeeGap({
        ledger: blocked,
        orderId: "o-1",
        resourceType: "energy",
        verifiedRemainingFeeDebtMilli: 0,
      }),
    ).toThrow(/blocked/);
  });

  it("blocked 账本：fill receipt / 外部篡改 gap / 消失订单 reconcile 均不落账", () => {
    const blocked = createFeeLedgerBlocked("quarantined evidence", 100);

    const fill = applyFillFeeDebt({
      ledger: blocked,
      gameTime: 100,
      transactionId: "tx-1",
      orderId: "o-1",
      feeDebtMilli: 10,
      filledAmount: 1,
      preRemainingAmount: 3,
      limits: LIMITS,
    });
    expect(fill).toMatchObject({ applied: false, duplicate: false, reconcileGap: true });
    expect(fill.ledger.processedFills).toHaveLength(0);
    expect(fill.ledger.invalid?.reason).toBe("quarantined evidence");

    const mutationGap = markExternalOrderMutationFeeGap({
      ledger: blocked,
      gameTime: 100,
      orderId: "o-1",
    });
    expect(mutationGap.reconcileGap).toBeUndefined();
    expect(mutationGap.invalid?.reason).toBe("quarantined evidence");

    const disappearance = reconcileDisappearedOrderFeeDebt({
      ledger: blocked,
      gameTime: 100,
      orderId: "o-1",
      resourceType: "energy",
      remainingFeeDebtMilli: 42,
      reason: "policy_cancelled",
    });
    expect(disappearance).toMatchObject({
      resolved: false,
      classification: "reconcile_gap",
      carriedFeeDebtMilli: 0,
      preservedFeeDebtMilli: 42,
    });
    expect(disappearance.ledger.carriedFeeDebtMilli).toEqual({});
    expect(disappearance.ledger.invalid?.reason).toBe("quarantined evidence");
  });

  it("operator 显式修复是唯一恢复入口；修复后 gate 不再报 fee_ledger_invalid", () => {
    const blocked = createFeeLedgerBlocked("quarantined evidence", 100);
    // expectedReason 不匹配 → 拒绝（不可误修复）。
    expect(() =>
      resolveFeeLedgerInvalid({ ledger: blocked, expectedReason: "other" }),
    ).toThrow(/match/);
    // 无 blocker 的健康账本没有可修复对象。
    expect(() =>
      resolveFeeLedgerInvalid({ ledger: createEmptyMarketSaleFeeLedger() }),
    ).toThrow(/no invalid blocker/);

    const resolved = resolveFeeLedgerInvalid({
      ledger: blocked,
      expectedReason: "quarantined evidence",
    });
    expect(resolved.invalid).toBeUndefined();
    const gated = reserveProspectiveFee({
      ...GATE_INPUT,
      reservationId: "r-after-repair",
      ledger: resolved,
    });
    expect(gated.reasons).not.toContain("fee_ledger_invalid");
    expect(gated.allowed).toBe(true);
  });
});
