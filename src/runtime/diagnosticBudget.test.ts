import { hasDiagnosticBudget } from "@/runtime/diagnosticBudget";

describe("诊断 bucket 余量", () => {
  it("默认在 8000 恢复，显式 override 可支持低 bucket 定向诊断", () => {
    Game.cpu = { bucket: 7999, limit: 120, tickLimit: 500, getUsed: () => 0 } as typeof Game.cpu;
    expect(hasDiagnosticBudget()).toBe(false);
    Game.cpu.bucket = 8000;
    expect(hasDiagnosticBudget()).toBe(true);
    Game.cpu.bucket = 0;
    expect(hasDiagnosticBudget(0)).toBe(true);
    expect(hasDiagnosticBudget(-100)).toBe(true);
    for (const invalid of [NaN, Infinity, -Infinity]) expect(hasDiagnosticBudget(invalid)).toBe(false);
    Game.cpu.bucket = 10000;
    expect(hasDiagnosticBudget(10001)).toBe(true);
  });
});
