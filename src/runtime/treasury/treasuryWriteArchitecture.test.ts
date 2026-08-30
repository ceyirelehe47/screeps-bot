/**
 * Treasury write-admission 架构边界测试（第五轮）：
 * - 单阶段入口退役：terminal/market/factory/lab/carrier/ResourceControl 等
 *   生产 writer 模块不得调用 recordAcceptedTransaction/recordAcceptedAction
 *   或 compat 兼容入口；
 * - compat 模块只允许 Treasury 自身测试引用，任何 src 生产模块不得 import；
 * - 故障注入器（setTreasuryCommitFaultInjectorForTest）只允许测试引用；
 * - reservation store 的直接写入只允许发生在 resourceReservation.ts
 *   （typed mutation 是唯一新写入口；外部不得绕过权威 mutation）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** 生产 writer 模块（未来真实 Game 写动作的候选承载方）。 */
const PRODUCTION_WRITER_MODULES: readonly string[] = [
  "src/runtime/resourceControl.ts",
  "src/runtime/marketDirectContinuousAutomation.ts",
  "src/runtime/marketSaleProtection.ts",
  "src/runtime/marketSaleProtectionAdapter.ts",
  "src/runtime/hubPlanner.ts",
  "src/runtime/factoryControl.ts",
  "src/runtime/synthesisControl.ts",
  "src/runtime/nukerControl.ts",
  "src/runtime/terminalActionEnergyOwnership.ts",
];

const SINGLE_STAGE_REFERENCES = [
  "recordAcceptedTransaction",
  "recordAcceptedAction",
  "compatRecordAcceptedTransaction",
  "compatRecordAcceptedAction",
];

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Treasury write-admission 架构边界", () => {
  it("生产 writer 模块不得调用单阶段入口（必须走 prepare/execute/commit）", () => {
    const violations: string[] = [];
    for (const modulePath of PRODUCTION_WRITER_MODULES) {
      const source = readSource(modulePath);
      for (const reference of SINGLE_STAGE_REFERENCES) {
        if (source.includes(reference)) {
          violations.push(`${modulePath} 引用了单阶段入口 ${reference}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("compat 模块只允许 Treasury 测试引用：任何 src 生产模块不得 import", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      const isCompatItself = filePath.endsWith(join("treasury", "compat.ts"));
      if (isTest || isCompatItself) continue;
      const source = readFileSync(filePath, "utf8");
      if (source.includes('from "@/runtime/treasury/compat"')) {
        violations.push(`${relative} import 了 treasury/compat（生产模块禁用）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("故障注入器只允许测试文件引用（生产不得设置 commit fault injector）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const source = readFileSync(filePath, "utf8");
      if (source.includes("setTreasuryCommitFaultInjectorForTest")) {
        const relative = filePath.split(/[\\/]/).slice(-3).join("/");
        if (relative === "runtime/treasury/writeFault.ts") continue; // 定义处
        violations.push(`${relative} 引用了故障注入器（仅测试可用）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("reservation store 直接写入只允许 resourceReservation.ts（typed mutation 唯一权威）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      const isAuthority = relative === "src/runtime/resourceReservation.ts";
      // 测试断言与市场保护快照允许只读引用；权威 mutation 之外禁止写入。
      if (isTest || isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      const writePatterns = [
        /Memory\.runtime\.resourceReservations\[[^\]]*\]\s*=/,
        /resourceReservations\s*=\s*\{/,
      ];
      for (const pattern of writePatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative} 直接写入 reservation store（须经 typed mutation API）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("fault resolution 入口只存在于 faultResolution 模块（生产 tick 不得自动调用）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      // writeFault.ts 定义受控 marker 清除；faultResolution.ts 是协议唯一入口。
      const isAuthority =
        relative === "runtime/treasury/faultResolution.ts" ||
        relative === "runtime/treasury/writeFault.ts";
      // 定义处允许；writeFault 的受控 marker 清除仅供 faultResolution 调用。
      if (isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      const resolutionReferences = [
        "resolveTreasuryQuarantinedTransactionAsCommitted",
        "resolveTreasuryQuarantinedTransactionAsNotExecuted",
        "clearTreasuryWriteFaultMarkerForResolution",
      ];
      for (const reference of resolutionReferences) {
        if (source.includes(reference)) {
          violations.push(`${relative} 引用了 fault resolution 入口（仅显式管理/修复路径）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("无条件 clear write-fault 入口已移除（任何模块不得重新引入）", () => {
    // 旧的"直接删除 marker"修复入口已在第六轮删除——扫描全部源码的**调用
    // 形态**（标识符 + 调用括号），防止以同名路径回归；注释中的历史说明
    // 不构成回归。
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const source = readFileSync(filePath, "utf8");
      if (/clearTreasuryWriteFaultForRepair\s*\(/.test(source)) {
        violations.push(`${filePath.split(/[\\/]/).slice(-3).join("/")} 调用已移除的无条件 clear 入口`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("reservation store key 拼接只允许 resourceReservation/ownerIdentity 权威（外部不得自行拼接持久 key）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      const isAuthority =
        relative === "src/runtime/resourceReservation.ts" ||
        relative === "runtime/treasury/ownerIdentity.ts" ||
        relative === "runtime/treasury/commitments.ts" || // 只读聚合（taskKey 为内存索引，非持久 key）
        relative === "runtime/treasury/quarantine.ts" || // 自有 q: 前缀键（非 reservation store）
        relative === "runtime/treasury/facade.ts" || // treasuryLocationKey（位置键，非 reservation store）
        relative === "runtime/treasury/projection.ts" ||
        relative === "runtime/treasury/shadow.ts" ||
        relative === "runtime/treasury/receipts.ts" ||
        relative === "runtime/treasury/writeFault.ts" ||
        relative === "runtime/treasury/faultResolution.ts";
      if (isTest || isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      // 持久 key 形状：`${room}:${resource}:` 前的显式拼接（reservation store 专用形状）。
      if (/resourceReservations[^;]*`\$\{[^}]*\}\s*:\s*\$\{[^}]*\}\s*:/.test(source)) {
        violations.push(`${relative} 自行拼接 reservation store 持久 key（须经 makeReservationStoreKey）`);
      }
    }
    expect(violations).toEqual([]);
  });
});
