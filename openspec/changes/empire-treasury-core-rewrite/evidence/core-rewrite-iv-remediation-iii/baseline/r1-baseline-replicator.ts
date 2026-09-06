/**
 * Remediation III / R1 基线反例（锁定 3f4e701）：
 * 两义务 closing(not_executed)，D0 端口回调内同 kernel 重入 beginTick；
 * 内层 D1=true、D0=false（in-flight 标志），最外层 D0=true。
 *
 * 基线缺陷：外层继续使用进入循环前保存的旧义务数组 [D0,D1]——
 * 内层确认移除 D1 后，外层再次预扣并调用已移除的 D1（第二次调用），
 * 批末确认 [D0,D1] 因包含不存在的 D1 被整体拒绝，D0 的成功无法落地。
 *
 * 本文件只在基线 worktree 运行（--runTestsByPath），不属于仓库测试集。
 */
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import type { TreasuryCoreIdentityFacts, TreasuryCoreWorstCaseLeg } from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";

function identity(): TreasuryCoreIdentityFacts {
  return {
    actionKind: "d.kind",
    adapterVersion: 1,
    adapterRegistrationId: "reg-r1",
    adapterSemanticIdentity: "d.adapter-r1",
    canonicalDigest: "a".repeat(16),
    postingsDigest: "b".repeat(16),
    retryFactsDigest: "c".repeat(16),
    durableFacts: null,
  };
}

function legs(): TreasuryCoreWorstCaseLeg[] {
  return [
    { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -50 },
    { roomName: "W2N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: 50 },
  ];
}

function ports(): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) =>
      kind === "d.kind"
        ? { kind, version: 1, registrationId: "reg-r1", semanticIdentity: "d.adapter-r1", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : undefined,
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
  };
}

function admitInput(consumers: readonly string[], workKey: string): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: identity(),
    worstCase: legs(),
    externalConsumers: consumers,
    canonicalArgs: { n: 1 },
    postings: legs(),
    admissionContext: { contractId: "ac:r1", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

interface ActiveShape {
  phase: string;
  cleanup: { consumerKeys: readonly string[]; cursor: number };
}

function activeShape(attemptId: string): ActiveShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, ActiveShape> } | undefined;
  return store?.active?.[attemptId];
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

describe("R1 基线反例：回调重入后继续使用旧义务数组", () => {
  it("同 kernel 重入：修复后 D0/D1 各调用一次、remaining 空、retry_ready、份额 4", () => {
    const releaseCalls: string[] = [];
    let inFlight = false;
    let kernel: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    const base = ports();
    const hooked: TreasuryCoreKernelPorts = {
      ...base,
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        if (key === "ext:r1:D0") {
          if (!inFlight) {
            inFlight = true;
            kernel.beginTick(); // 同 kernel 重入（内层 D1=true、D0=false）
            inFlight = false;
            return true; // 最外层 D0 最后返回 true
          }
          return false; // 内层 D0
        }
        return true; // D1 始终 true
      },
    };
    kernel = createTreasuryCoreKernel(hooked);
    const admitted = kernel.admit(admitInput(["ext:r1:D0", "ext:r1:D1"], "biz:r1:reentry"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
    Game.time += 1;
    kernel.beginTick();
    console.log("R1 releaseCalls:", JSON.stringify(releaseCalls));
    console.log("R1 final shape:", JSON.stringify(activeShape(admitted.attemptId)));
    const core = Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number } };
    console.log("R1 budgetUsed:", core.recovery.budgetUsed);
    // 修复后语义断言（基线上红）：
    expect(releaseCalls.filter((k) => k === "ext:r1:D0").length).toBe(1); // D0 恰一次
    expect(releaseCalls.filter((k) => k === "ext:r1:D1").length).toBe(1); // D1 恰一次（基线 2 次）
    const shape = activeShape(admitted.attemptId)!;
    expect(shape.phase).toBe("retry_ready"); // 全部确认成功 → not_executed 退出
    expect(shape.cleanup?.consumerKeys ?? []).toEqual([]); // remaining 空
    expect(core.recovery.budgetUsed).toBe(4); // 2 单位 × 2 份
  });
});
