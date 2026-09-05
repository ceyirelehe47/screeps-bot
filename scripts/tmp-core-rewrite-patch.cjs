const fs = require("fs");
const p = "src/runtime/treasury/facade.ts";
let s = fs.readFileSync(p, "utf8");

const oldSettle = `    settleUnknownOutcome(request: TreasurySettleRequest) {
      const adapterIdentity = (() => {
        const h = readTreasuryCoreStoreHealth();
        if (h.status !== "healthy") return undefined;
        return h.memory.active[request.attemptId]?.identity.adapterSemanticIdentity;
      })();
      return kernel.settle({
        attemptId: request.attemptId,
        evidenceKind: request.evidenceKind,
        conclusion: request.conclusion,
        adapterSemanticIdentity: request.evidenceKind === "adapter_reconcile" ? adapterIdentity : undefined,
      });
    },`;

if (!s.includes(oldSettle)) {
  console.error("settle block MISS");
  process.exit(1);
}

const newSettle = `    settleUnknownOutcome(request: TreasurySettleRequest) {
      // adapter_reconcile 证据的结论必须来自注册 reconciler 本身——facade
      // 内部调用（durable facts + 当前 shared observation），调用方不可传
      // conclusion（防伪造）。external_settlement_receipt 是显式外部对账
      // 通道（本轮真实 driver 禁用；结论由受控协作者传入并在证据中记录
      // 来源——接入真实 driver 前必须升级为受控 capability，见 design 限制）。
      let conclusion: "executed" | "not_executed" | "still_uncertain";
      let adapterIdentity: string | undefined;
      if (request.evidenceKind === "adapter_reconcile") {
        const h = readTreasuryCoreStoreHealth();
        if (h.status !== "healthy") {
          return { status: "rejected", reason: "kernel store 不可读" };
        }
        const record = h.memory.active[request.attemptId];
        if (record === undefined) return { status: "rejected", reason: "attempt 不在活跃集合" };
        const adapter = findTreasuryActionAdapter(record.identity.actionKind);
        if (
          adapter === undefined ||
          adapter.registrationId !== record.identity.adapterRegistrationId ||
          adapter.semanticIdentity !== record.identity.adapterSemanticIdentity
        ) {
          return { status: "rejected", reason: "reconciler 注册身份与聚合不一致" };
        }
        if (adapter.reconcile === undefined) {
          return { status: "rejected", reason: "该 action kind 未提供 reconciler" };
        }
        let raw: TreasuryActionReconcilerConclusion;
        try {
          raw = adapter.reconcile(
            { version: 1, durableFacts: record.identity.durableFacts ?? undefined, contractId: "ac:" + record.identity.canonicalDigest },
            service.observation(),
          );
        } catch (error) {
          return { status: "rejected", reason: "reconciler 抛错：" + String(error instanceof Error ? error.message : error).slice(0, 96) };
        }
        conclusion = raw === "observed_committed" ? "executed" : raw === "observed_not_executed" ? "not_executed" : "still_uncertain";
        adapterIdentity = adapter.semanticIdentity;
      } else {
        if (request.conclusion === undefined) {
          return { status: "rejected", reason: "external_settlement_receipt 必须提供结论" };
        }
        conclusion = request.conclusion;
      }
      return kernel.settle({
        attemptId: request.attemptId,
        evidenceKind: request.evidenceKind,
        conclusion,
        adapterSemanticIdentity: adapterIdentity,
      });
    },`;

s = s.replace(oldSettle, newSettle);
// TreasurySettleRequest 的 conclusion 字段对 adapter_reconcile 模式应为可选
s = s.replace(
  `export interface TreasurySettleRequest {
  readonly attemptId: string;
  readonly evidenceKind: "adapter_reconcile" | "external_settlement_receipt";
  readonly conclusion: "executed" | "not_executed" | "still_uncertain";
}`,
  `export interface TreasurySettleRequest {
  readonly attemptId: string;
  /** adapter_reconcile：结论由 facade 调用注册 reconciler 得出（不可传入）。 */
  readonly evidenceKind: "adapter_reconcile" | "external_settlement_receipt";
  /** 仅 external_settlement_receipt 模式使用（受控外部对账通道）。 */
  readonly conclusion?: "executed" | "not_executed" | "still_uncertain";
}`,
);
// import TreasuryActionReconcilerConclusion 类型
s = s.replace(
  'import type { TreasuryActionContract } from "@/runtime/treasury/actionContracts";',
  'import type { TreasuryActionContract, TreasuryActionReconcilerConclusion } from "@/runtime/treasury/actionContracts";',
);
fs.writeFileSync(p, s, "utf8");
console.log("settle hardened");
