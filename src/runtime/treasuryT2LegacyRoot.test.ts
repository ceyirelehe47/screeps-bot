import { armTreasuryT2FirstLive } from "@/runtime/treasuryT2FirstLiveControl";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { initializeT2, T2_TARGET } from "../../test/treasuryT2Fixture";

describe("T2 unknown legacy Treasury roots are not silently empty", () => {
  let context: ReturnType<typeof initializeT2>;
  beforeEach(() => { context = initializeT2(); });

  it.each([{ schemaVersion: 999 }, { receipts: null }, { receipts: 0 }, { receipts: [{}] },
    { unknownResponsibility: {} }, { receipts: { oldAttempt: {} } }, { intents: "lost" }])
  ("refuses opaque or malformed legacy root %j without altering its facts", (root) => {
    (Memory.runtime as unknown as Record<string, unknown>).treasury = root;
    const before = JSON.stringify(Memory);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(JSON.stringify(Memory)).toBe(before);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
  });

  it.each([{}, { receipts: {}, intents: {} }, { receipts: [], intents: [], retiredAttemptRanges: [] }])("preserves a recognized empty legacy root %j while allowing bounded new binding", (root) => {
    (Memory.runtime as unknown as Record<string, unknown>).treasury = root;
    const before = JSON.stringify(root);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    expect(JSON.stringify((Memory.runtime as unknown as Record<string, unknown>).treasury)).toBe(before);
  });

  it.each([{ receipts: null }, { unknownResponsibility: {} }])("rechecks in-place legacy corruption %j after a clear same-tick fence", (change) => {
    const root = {} as Record<string, unknown>;
    (Memory.runtime as unknown as Record<string, unknown>).treasury = root;
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    Object.assign(root, change);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });
});
