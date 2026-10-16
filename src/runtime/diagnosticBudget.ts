/** 只读诊断的默认 bucket 余量；生产恢复、战斗及交易安全门不使用此门控。 */
export const DIAGNOSTIC_MIN_BUCKET = 8_000;

export function hasDiagnosticBudget(minBucket?: number): boolean {
  const threshold = typeof minBucket === "number" && Number.isFinite(minBucket)
    ? Math.max(0, Math.min(10_000, Math.floor(minBucket)))
    : DIAGNOSTIC_MIN_BUCKET;
  return Game.cpu.bucket >= threshold;
}
