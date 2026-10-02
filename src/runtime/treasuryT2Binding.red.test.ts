import { registerTreasuryProductionTerminalTransfer } from "@/runtime/treasuryTerminalTransfer";
import { findTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";

describe("T2 UH formal-path preimplementation counterexamples", () => {
  it("registers a separate UH action contract on the production registry", () => {
    registerTreasuryProductionTerminalTransfer();
    expect(findTreasuryActionAdapter("production.terminal-transfer.uh-synthesis.slice0")).toBeDefined();
  });

  it("offers a durable T2 binding entry instead of authorizing UH through the H grant", () => {
    let control: Record<string, unknown> = {};
    try { control = require("@/runtime/treasuryT2FirstLiveControl") as Record<string, unknown>; }
    catch { /* Baseline has no UH authority. Preserve the semantic assertion. */ }
    expect(control.armTreasuryT2FirstLive).toEqual(expect.any(Function));
  });
});
