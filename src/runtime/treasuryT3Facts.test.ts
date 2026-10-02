import { encodeTreasuryT1DurableFacts, decodeTreasuryT1DurableFacts, TREASURY_T1_RUN_ID } from "@/runtime/treasuryT1Facts";
import { encodeTreasuryT2DurableFacts, decodeTreasuryT2DurableFacts, TREASURY_T2_RUN_ID } from "@/runtime/treasuryT2Facts";
import { encodeTreasuryT3DurableFacts, decodeTreasuryT3DurableFacts, TREASURY_T3_RUN_ID } from "@/runtime/treasuryT3Facts";

describe("T3 durable OH事实不被旧H/UH解码器解释", () => {
  const source = { id: "source-terminal", resourceAmount: 26, energy: 10_000, used: 10_026,
    free: 289_974, capacity: 300_000, cooldown: 0 };
  const target = { id: "target-terminal", resourceAmount: 4, energy: 2000, used: 4359,
    free: 295_641, capacity: 300_000, cooldown: 0 };
  const facts = { schemaVersion: 1 as const, runId: TREASURY_T3_RUN_ID,
    taskId: "90:1:OH:E4N58->E1N57", taskCreatedAt: 90, amount: 26, tick: 100,
    quote: 2, username: "forster", source, target };
  it("roundtrip明确OH、两端、automatic和UH2O用途", () => {
    const encoded = encodeTreasuryT3DurableFacts(facts);
    expect(encoded).toContain("|OH|E4N58|E1N57|automatic|synthesis:E1N57:UH2O|");
    expect(decodeTreasuryT3DurableFacts(encoded)).toEqual(facts);
    expect(decodeTreasuryT1DurableFacts(encoded)).toBeNull();
    expect(decodeTreasuryT2DurableFacts(encoded)).toBeNull();
  });
  it.each([[0, "t2"], [1, TREASURY_T2_RUN_ID], [2, "UH"], [2, "H"], [3, "E3N59"], [4, "E3N59"],
    [5, "manual"], [6, "synthesis:E1N57:OH"], [9, "101"], [11, "101"]])
  ("拒绝field %i=%s重绑", (index, value) => {
    const parts = encodeTreasuryT3DurableFacts(facts)!.split("|"); parts[index as number] = value as string;
    expect(decodeTreasuryT3DurableFacts(parts.join("|"))).toBeNull();
  });
  it("旧T1/T2事实仍roundtrip，不能复制成T3事实", () => {
    const h = { ...facts, runId: TREASURY_T1_RUN_ID,
      source: { ...source, hydrogen: source.resourceAmount }, target: { ...target, hydrogen: target.resourceAmount } };
    const uh = { ...facts, runId: TREASURY_T2_RUN_ID };
    const hRaw = encodeTreasuryT1DurableFacts(h); const uhRaw = encodeTreasuryT2DurableFacts(uh);
    expect(decodeTreasuryT1DurableFacts(hRaw)).toMatchObject({ runId: TREASURY_T1_RUN_ID, amount: 26 });
    expect(decodeTreasuryT2DurableFacts(uhRaw)).toEqual(uh);
    expect(decodeTreasuryT3DurableFacts(hRaw)).toBeNull(); expect(decodeTreasuryT3DurableFacts(uhRaw)).toBeNull();
  });
});
