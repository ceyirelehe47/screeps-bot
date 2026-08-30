const fs = require("fs");
const applied = [];
function patch(file, pairs) {
  const full = "D:/code/screeps/screeps-bot/src/runtime/treasury/" + file;
  let text = fs.readFileSync(full, "utf8");
  for (const [name, oldStr, newStr] of pairs) {
    if (text.split(oldStr).length - 1 !== 1) throw new Error(file + " " + name);
    text = text.split(oldStr).join(newStr);
    applied.push(file + ":" + name);
  }
  fs.writeFileSync(full, text, "utf8");
}

// ── reconciliation.ts：窄接口加只读 validate ────────────────────────────────
patch("reconciliation.ts", [
  [
    "authority-if",
    `export interface TreasuryReconciliationCapabilityAuthority {`,
    `export interface TreasuryReconciliationCapabilityAuthority {
  /**
   * 只读验证（第十轮 3.12.8）：对象身份 → 单次未用 → generation → tick——
   * 零消费（消费移至 staged resolution 写入之后；staged 前的任何拒绝不得
   * 烧掉 capability）。
   */
  validateReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;`,
  ],
]);

// ── faultResolution.ts：kernel token 注册 + validate 化 + 强匹配 ────────────
patch("faultResolution.ts", [
  [
    "kernel-token",
    `export type { TreasuryReconciliationConclusion } from "@/runtime/treasury/reconciliation";`,
    `export type { TreasuryReconciliationConclusion } from "@/runtime/treasury/reconciliation";

// ── resolution kernel token（第十轮 3.12.8） ────────────────────────────────
// resolution kernel 只接受由当前 Treasury service 闭包注册的 authority 对象
//（WeakSet 对象身份——结构兼容的伪 service 一律无效）。注册入口仅供 facade
// 调用（架构测试守护生产模块不得引用）。
const resolutionKernelRegistry = new WeakSet<object>();
export function registerTreasuryResolutionKernelForService(authority: object): void {
  resolutionKernelRegistry.add(authority);
}
function isRegisteredResolutionKernel(authority: object): boolean {
  return resolutionKernelRegistry.has(authority);
}`,
  ],
  [
    "prevalidate-consume",
    `  // capability 防伪：对象身份/单次使用/generation/tick。
  // capability 校验并消费（第九轮 4.8：service 闭包校验——generation 由当前
  // service 自身判定，调用者无法提交 serviceGeneration 数字绕过；校验通过
  // 即标记单次使用）。
  const capabilityCheck = service.consumeReconciliationCapability(input.capability);
  if (capabilityCheck.status !== "valid") {`,
    `  // capability 防伪（第十轮 3.12.8）：**只读验证**（对象身份/单次未用/
  // generation/tick——零消费）。消费移至 staged resolution intent 写入之后：
  // staged 前的任何拒绝（store fatal/authority mismatch/evidence/slot）都
  // 不烧掉 capability（可重试）。
  const capabilityCheck = service.validateReconciliationCapability(input.capability);
  if (capabilityCheck.status !== "valid") {`,
  ],
  [
    "strong-match",
    `  // capability 扩展绑定匹配（第九轮 4.8）：authorityKind/contract digest/
  // adapter version——capability 与不同 contract/reconciler version 的
  // authority 不匹配时拒绝。
  if (capability.authorityKind !== undefined && capability.authorityKind !== authority.authorityKind) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `capability 的 authorityKind ${capability.authorityKind} 与实际 authority ${authority.authorityKind} 不一致`,
      },
    };
  }
  if (authority.contractDigest !== undefined && capability.contractDigest !== undefined && capability.contractDigest !== authority.contractDigest) {
    countRejected();
    return {
      stop: { status: "rejected", reason: "reconciler_mismatch", detail: "capability 绑定的 contract digest 与 authority 不一致" },
    };
  }
  if (authority.adapterVersion !== undefined && capability.reconcilerVersion !== authority.adapterVersion) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `capability 的 reconciler version ${String(capability.reconcilerVersion)} 与 authority adapter version ${String(authority.adapterVersion)} 不一致`,
      },
    };
  }`,
    `  // capability 绑定强匹配（第十轮 3.12.8）：contract-backed authority（携带
  // 合同事实）的全部绑定字段必须**双方都存在且完全一致**——弱 optional 检查
  //（双方都存在才比）删除：authority 有 contract/adapter 事实而 capability
  // 缺失对应绑定即为不匹配。
  if (capability.authorityKind !== undefined && capability.authorityKind !== authority.authorityKind) {
    countRejected();
    return {
      stop: {
        status: "rejected",
        reason: "reconciler_mismatch",
        detail: `capability 的 authorityKind ${capability.authorityKind} 与实际 authority ${authority.authorityKind} 不一致`,
      },
    };
  }
  const contractBacked =
    authority.contractId !== undefined || authority.contractDigest !== undefined || authority.adapterVersion !== undefined;
  if (contractBacked) {
    if (capability.contractId === undefined || authority.contractId === undefined || capability.contractId !== authority.contractId) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 contractId 必须双方存在且一致（capability 绑定缺失即不匹配）" },
      };
    }
    if (capability.contractDigest === undefined || authority.contractDigest === undefined || capability.contractDigest !== authority.contractDigest) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 contractDigest 必须双方存在且一致" },
      };
    }
    if (authority.adapterVersion === undefined || capability.reconcilerVersion !== authority.adapterVersion) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 adapter/reconciler version 必须双方存在且一致" },
      };
    }
    if (authority.durablePayloadVersion !== undefined && capability.durablePayloadVersion !== authority.durablePayloadVersion) {
      countRejected();
      return {
        stop: { status: "rejected", reason: "reconciler_mismatch", detail: "contract-backed authority 的 durable payload version 与 capability 绑定不一致" },
      };
    }
  }`,
  ],
]);

console.log("applied:", applied.join(", "));
