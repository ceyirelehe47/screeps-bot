/**
 * Remediation III / R2 基线反例（锁定 3f4e701）：
 * 端口返回错误类型的真值（{ok:false} 对象等）被 `if (ok)` 当成释放成功，
 * 义务被误清理、记录错误进入 retry_ready。
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
    adapterRegistrationId: "reg-r2",
    adapterSemanticIdentity: "d.adapter-r2",
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

function makePorts(release: () => unknown): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) =>
      kind === "d.kind"
        ? { kind, version: 1, registrationId: "reg-r2", semanticIdentity: "d.adapter-r2", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : undefined,
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
    releaseExternalConsumer: () => release() as boolean, // 受控故障注入（测试边界 cast）
  };
}

function admitInput(workKey: string): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: identity(),
    worstCase: legs(),
    externalConsumers: ["ext:r2:D"],
    canonicalArgs: { n: 1 },
    postings: legs(),
    admissionContext: { contractId: "ac:r2", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
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

describe("R2 基线反例：错误类型的真值被当成释放成功", () => {
  it("{ok:false} 对象：修复后义务保留 closing，恢复 true 后真完成", () => {
    let mode: "bad" | "good" = "bad";
    const kernel = createTreasuryCoreKernel(makePorts(() => (mode === "bad" ? { ok: false } : true)));
    const admitted = kernel.admit(admitInput("biz:r2:truthy"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
    Game.time += 1;
    kernel.beginTick();
    console.log("R2 after bad shape:", JSON.stringify(activeShape(admitted.attemptId)));
    // 修复后语义断言（基线上红：对象真值被当成成功 → retry_ready）：
    const shape = activeShape(admitted.attemptId)!;
    expect(shape.phase).toBe("closing");
    expect(shape.cleanup.consumerKeys).toEqual(["ext:r2:D"]); // 义务未被误清理
    // 端口恢复原始 true 后下一正常 tick 真完成。
    mode = "good";
    Game.time += 1;
    kernel.beginTick();
    const recovered = activeShape(admitted.attemptId)!;
    expect(recovered.phase).toBe("retry_ready");
    expect(recovered.cleanup.consumerKeys).toEqual([]);
  });
});
