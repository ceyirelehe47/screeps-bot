import { encodeTreasuryT1DurableFacts, decodeTreasuryT1DurableFacts, TREASURY_T1_RUN_ID } from "@/runtime/treasuryT1Facts";
import { encodeTreasuryT2DurableFacts, decodeTreasuryT2DurableFacts, TREASURY_T2_RUN_ID } from "@/runtime/treasuryT2Facts";

describe("T2 durable UH facts are explicit and distinct from old H facts", () => {
  const source = { id: "source-terminal", resourceAmount: 4000, energy: 10000, used: 14000,
    free: 286000, capacity: 300000, cooldown: 0 };
  const target = { id: "target-terminal", resourceAmount: 200, energy: 2000, used: 2200,
    free: 297800, capacity: 300000, cooldown: 0 };
  const facts = { schemaVersion: 1 as const, runId: TREASURY_T2_RUN_ID,
    taskId: "90:1:UH:E4N58->E1N57", taskCreatedAt: 90, amount: 100, tick: 100,
    quote: 10, username: "forster", source, target };
  it("round-trips explicit resource, both rooms, origin and synthesis purpose", () => {
    const encoded = encodeTreasuryT2DurableFacts(facts);
    expect(encoded).toContain("|UH|E4N58|E1N57|automatic|synthesis:E1N57:UH2O|");
    expect(decodeTreasuryT2DurableFacts(encoded)).toEqual(facts);
    expect(decodeTreasuryT1DurableFacts(encoded)).toBeNull();
  });
  it.each([[0, "t1"], [1, TREASURY_T1_RUN_ID], [2, "H"], [3, "E3N59"], [4, "E3N59"],
    [5, "manual"], [6, "synthesis:E1N57:OH"], [9, "101"], [11, "101"]])
  ("rejects unknown or ambiguously rebound field %i=%s", (index, value) => {
    const parts = encodeTreasuryT2DurableFacts(facts)!.split("|"); parts[index as number] = value as string;
    expect(decodeTreasuryT2DurableFacts(parts.join("|"))).toBeNull();
  });
  it("still decodes exact original H bytes, without accepting them as UH", () => {
    const old = { ...facts, runId: TREASURY_T1_RUN_ID,
      source: { ...source, hydrogen: source.resourceAmount }, target: { ...target, hydrogen: target.resourceAmount } };
    const encoded = encodeTreasuryT1DurableFacts(old);
    expect(encoded).toMatch(/^t1\|treasury-production-T1-2026-09-24\|/);
    expect(decodeTreasuryT1DurableFacts(encoded)).toEqual(expect.objectContaining({ runId: TREASURY_T1_RUN_ID, amount: 100 }));
    expect(decodeTreasuryT2DurableFacts(encoded)).toBeNull();
  });
});
