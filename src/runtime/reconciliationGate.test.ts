import { recordReconciled, shouldReconcile } from "./reconciliationGate";

describe("reconciliationGate", () => {
  it("only records success and invalidates on revision, external facts, time reversal and heap owner replacement", () => {
    const owner = {}; Game.time = 100;
    expect(shouldReconcile(owner, "W1N1", "rev1:alive")).toBe(true);
    expect(shouldReconcile(owner, "W1N1", "rev1:alive")).toBe(true);
    recordReconciled(owner, "W1N1", "rev2:alive");
    Game.time++;
    expect(shouldReconcile(owner, "W1N1", "rev2:alive")).toBe(false);
    expect(shouldReconcile(owner, "W1N1", "rev3:alive")).toBe(true);
    expect(shouldReconcile(owner, "W1N1", "rev2:dead")).toBe(true);
    expect(shouldReconcile({}, "W1N1", "rev2:alive")).toBe(true);
    Game.time = 99;
    expect(shouldReconcile(owner, "W1N1", "rev2:alive")).toBe(true);
    Game.time = 200;
    expect(shouldReconcile(owner, "W1N1", "rev2:alive")).toBe(true);
  });
  it("bounds retained scopes independently per owner", () => {
    const owner = {}; Game.time = 100;
    for (let i = 0; i <= 100; i++) recordReconciled(owner, String(i), "same");
    expect(shouldReconcile(owner, "0", "same")).toBe(true);
    expect(shouldReconcile(owner, "100", "same")).toBe(false);
  });
});
