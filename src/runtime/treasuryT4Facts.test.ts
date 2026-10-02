import { decodeTreasuryT1DurableFacts } from "@/runtime/treasuryT1Facts";
import { decodeTreasuryT2DurableFacts } from "@/runtime/treasuryT2Facts";
import { decodeTreasuryT3DurableFacts } from "@/runtime/treasuryT3Facts";
import { encodeTreasuryT4DurableFacts, decodeTreasuryT4DurableFacts, TREASURY_T4_RUN_ID } from "@/runtime/treasuryT4Facts";

describe("T4持久slice事实绑定独立sequence和26硬上限", () => {
  const source = { id: "source-terminal", resourceAmount: 26, energy: 10_000, used: 10_026,
    free: 289_974, capacity: 300_000, cooldown: 0 };
  const target = { id: "target-terminal", resourceAmount: 4, energy: 2000, used: 4359,
    free: 295_641, capacity: 300_000, cooldown: 0 };
  const facts = { schemaVersion: 1 as const, runId: TREASURY_T4_RUN_ID, sequence: 1,
    taskId: "90:1:OH:E4N58->E1N57:T4", taskCreatedAt: 90, amount: 10, tick: 100,
    quote: 2, username: "forster", source, target };
  it("roundtrip明确OH、两端、automatic、UH2O和sequence，旧解码器全部拒绝", () => {
    const encoded = encodeTreasuryT4DurableFacts(facts);
    expect(encoded).toContain("|OH|E4N58|E1N57|automatic|synthesis:E1N57:UH2O|1|");
    expect(decodeTreasuryT4DurableFacts(encoded)).toEqual(facts);
    expect(decodeTreasuryT1DurableFacts(encoded)).toBeNull(); expect(decodeTreasuryT2DurableFacts(encoded)).toBeNull();
    expect(decodeTreasuryT3DurableFacts(encoded)).toBeNull();
  });
  it.each([1, 26])("允许合法硬边界amount%i", (amount) => {
    const value = { ...facts, amount, sequence: 128 };
    expect(decodeTreasuryT4DurableFacts(encodeTreasuryT4DurableFacts(value))).toEqual(value);
  });
  it.each([0, 27, 100, 1.5, NaN, Infinity])("拒绝非法amount%s", (amount) => {
    expect(encodeTreasuryT4DurableFacts({ ...facts, amount })).toBeNull();
  });
  it.each([0, 129, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("拒绝非法sequence%s", (sequence) => {
    expect(encodeTreasuryT4DurableFacts({ ...facts, sequence })).toBeNull();
  });
  it.each([[0, "t3"], [1, "treasury-production-T3-2026-10-02"], [2, "UH"], [3, "E3N59"],
    [4, "E3N59"], [5, "manual"], [6, "synthesis:E1N57:OH"], [7, "129"], [10, "27"]])
  ("拒绝field%i=%s重绑", (index, replacement) => {
    const parts = encodeTreasuryT4DurableFacts(facts)!.split("|"); parts[index as number] = replacement as string;
    expect(decodeTreasuryT4DurableFacts(parts.join("|"))).toBeNull();
  });
});
