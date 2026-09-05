/**
 * Treasury 测试通道（Core Rewrite I）。
 *
 * 边界：仅 `*.test.ts` 可 import 本模块（架构测试守护）；treasury 协议栈
 * 之外的生产模块不得 import。旧 writer-kernel symbol 通道已随旧协议栈
 * 退役——测试统一走公共 API（authorize/executeDispatch/settle/rearm），
 * 不存在绕开真实 gate 的"方便入口"。本模块只补充测试观察工具：
 * 活跃聚合/环的直接读取、store 损坏注入与恢复辅助。
 */

import type { TreasuryService } from "@/runtime/treasury/facade";
import {
  readTreasuryCoreStoreHealth,
} from "@/runtime/treasury/kernel/store";
import type {
  TreasuryCoreMemory,
  TreasuryCoreRingEntry,
  TreasuryCoreWorkRecord,
} from "@/runtime/treasury/kernel/types";

export interface TreasuryTestHarness {
  /** 活跃聚合只读快照（浅拷贝记录；不修改权威）。 */
  readonly activeWorks: () => readonly TreasuryCoreWorkRecord[];
  readonly ring: () => readonly TreasuryCoreRingEntry[];
  readonly store: () => TreasuryCoreMemory | undefined;
  /** 直接写 store 根（损坏/边界注入专用；测试外不得调用）。 */
  readonly writeStoreForTest: (mutate: (root: TreasuryCoreMemory) => void) => boolean;
}

export function treasuryTestHarness(_service: TreasuryService): TreasuryTestHarness {
  void _service;
  return {
    activeWorks: () => {
      const health = readTreasuryCoreStoreHealth();
      if (health.status !== "healthy") return [];
      return Object.values(health.memory.active).slice().sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
    },
    ring: () => {
      const health = readTreasuryCoreStoreHealth();
      if (health.status !== "healthy") return [];
      return health.memory.ring;
    },
    store: () => {
      const health = readTreasuryCoreStoreHealth();
      return health.status === "healthy" ? health.memory : undefined;
    },
    writeStoreForTest: (mutate) => {
      const runtime = Memory.runtime as Record<string, unknown> | undefined;
      const root = runtime?.treasuryCore as TreasuryCoreMemory | undefined;
      if (root === undefined) return false;
      mutate(root);
      return true;
    },
  };
}

/** 测试辅助：清除 treasuryCore 持久根（等价 service.resetForTest 的存储侧）。 */
export function resetTreasuryCoreStoreForTest(): void {
  const runtime = Memory.runtime as Record<string, unknown> | undefined;
  if (runtime && typeof runtime === "object") {
    delete runtime.treasuryCore;
  }
}
