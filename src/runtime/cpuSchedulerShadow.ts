/** 旧 CPU 历史样本的只读兼容类型；生产已由 processScheduler 实际执行。 */
import type { CpuPriorityTier } from "@/runtime/processTable";
export interface CpuSchedulerShadow {
  mode: "shadow";
  evaluated: Record<CpuPriorityTier, number>;
  wouldDefer: Record<string, { tier: CpuPriorityTier; reason: "bucket" | "cpu"; used: number }>;
}
