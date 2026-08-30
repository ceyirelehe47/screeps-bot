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
      // writeFault.ts 定义受控 marker 清除；faultResolution.ts 是协议唯一
      // 入口；resolutionStore.ts 是 staged 状态机的 store 级载体（beginTick
      // 的幂等恢复 recoverStagedResolutions 属设计要求的自动恢复路径——
      // 不是 resolve* 结算入口）。
      const isAuthority =
        relative === "runtime/treasury/faultResolution.ts" ||
        relative === "runtime/treasury/writeFault.ts" ||
        relative === "runtime/treasury/resolutionStore.ts";
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

  it("生产模块不得 import faultResolution（协议只允许显式管理/修复路径与测试引用）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      const isAuthority = relative === "runtime/treasury/faultResolution.ts";
      if (isTest || isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      if (source.includes('from "@/runtime/treasury/faultResolution"')) {
        violations.push(`${relative} import 了 faultResolution（生产禁用——metrics 聚合走 resolutionEvents）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("ForRepair/ForResolution 修复入口生产禁调（仅 faultResolution 定义处与测试可引用）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      // 定义处：resourceReservation.ts 定义 repairReservationStoreCorruptionForRepair；
      // faultResolution.ts 定义并转发 repairTreasuryQuarantineStoreForResolution。
      const isAuthority =
        relative === "src/runtime/resourceReservation.ts" ||
        relative === "runtime/treasury/faultResolution.ts" ||
        relative === "runtime/treasury/quarantine.ts"; // repair 底层实现（仅供 faultResolution 调用）
      if (isTest || isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      const repairCallPatterns = [
        /repairReservationStoreCorruptionForRepair\s*\(/,
        /repairTreasuryQuarantineStoreForResolution\s*\(/,
        /repairTreasuryQuarantineStoreMetadataForResolution\s*\(/,
      ];
      for (const pattern of repairCallPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative} 调用显式 repair 入口（仅显式管理/修复路径与测试可用）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("quarantine store 直接写入只允许 quarantine.ts（版本化权威唯一写入方）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      // 权威：quarantine.ts（写入/释放/repair）。receipts.ts 的测试清理
      // (clearTreasuryPersistenceForTest) 使用 delete（非赋值形态，不命中）。
      const isAuthority = relative === "runtime/treasury/quarantine.ts";
      if (isTest || isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      const writePatterns = [
        /\.treasury\.quarantine\s*=\s*[^=]/,
        /treasury\.quarantine\[[^\]]*\]\s*=/,
        /quarantine\.entries\[[^\]]*\]\s*=[^=]/,
        /quarantine\.entryCount\s*=[^=]/,
      ];
      for (const pattern of writePatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative} 直接写入 quarantine store（须经 quarantine.ts 权威 API）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("reservation mutation 必须经 schema activation gate（全部入口共用 preflight）", () => {
    const source = readSource("src/runtime/resourceReservation.ts");
    // 三个 typed mutation 入口（reserve/renew/release ForOwner）各自调用
    // preflightMutation（内含 ensureReservationSchemaActivated + 全字段验证）；
    // deprecated adapter 只经 typed 入口转发（不二次绕过）。
    expect(source).toMatch(/export function reserveProductionResourceForOwner[\s\S]*?preflightMutation\(/);
    expect(source).toMatch(/export function releaseProductionReservationForOwner[\s\S]*?preflightMutation\(/);
    expect(source).toMatch(/export function renewProductionReservationForOwner[\s\S]*?preflightMutation\(/);
    // deprecated adapter 必须转发 ForOwner（不自行实现写入）。
    expect(source).toMatch(/export function reserveProductionResource\([\s\S]*?return reserveProductionResourceForOwner\(/);
    expect(source).toMatch(/export function releaseProductionReservation\([\s\S]*?return releaseProductionReservationForOwner\(/);
    expect(source).toMatch(/export function renewProductionReservation\([\s\S]*?return renewProductionReservationForOwner\(/);
    // gate 本身必须存在且 fail closed 三分支。
    expect(source).toContain("export function ensureReservationSchemaActivated");
    expect(source).toContain('"migration_failed"');
    expect(source).toContain('"unknown_version"');
    expect(source).toContain('"store_corrupted"');
  });

  it("第八轮：生产 writer 候选禁用任意 callback 入口/直接 prepare/自构 postings（唯一生产路径 = 授权→contract→注册 adapter）", () => {
    const violations: string[] = [];
    for (const relative of PRODUCTION_WRITER_MODULES) {
      const source = readSource(relative);
      if (source.includes("executePreparedAction")) {
        violations.push(`${relative} 引用任意 callback 入口 executePreparedAction（第八轮起为内部/test-only 原语）`);
      }
      if (source.includes("prepareTransaction")) {
        violations.push(`${relative} 直接调用 prepareTransaction（生产必须经 executeTreasuryActionContract）`);
      }
      if (source.includes("consumeTreasuryAuthorization") || source.includes("authorizeResourceUse")) {
        violations.push(`${relative} 直接消费授权原语（生产必须经 actionContracts 入口）`);
      }
      if (source.includes("buildTreasuryActionContract") || source.includes("executeTreasuryActionContract")) {
        violations.push(`${relative} 直接构建/执行 contract（须经注册 adapter 的正式接入评审，本轮未接真实 writer）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("第八轮：adapter registry 注册边界（仅 actionContracts.ts 自身与测试可注册）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/actionContracts.ts") continue;
      const source = readFileSync(filePath, "utf8");
      for (const reference of [
        "registerTreasuryActionAdapter",
        "replaceTreasuryActionAdapterForTest",
        "unregisterTreasuryActionAdapterForTest",
      ]) {
        if (source.includes(reference)) {
          violations.push(`${relative} 调用 adapter 注册边界 ${reference}（注册只允许 actionContracts.ts 与测试）`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("第八轮：intent store 直写仅限 intents.ts（外部不得绕过权威模块）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/intents.ts") continue;
      const source = readFileSync(filePath, "utf8");
      const intentWritePattern = /treasury\.intents\s*=|\.intents\.entries\[[^\]]*\]\s*=/;
      if (intentWritePattern.test(source)) {
        violations.push(`${relative} 直接写 intent store（权威写入只允许 intents.ts）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("第八轮：resolution store 直写仅限 resolutionStore.ts（staged 状态机权威）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/resolutionStore.ts") continue;
      const source = readFileSync(filePath, "utf8");
      const resolutionWritePattern = /treasury\.resolutions\s*=|\.resolutions\.entries\[[^\]]*\]\s*=/;
      if (resolutionWritePattern.test(source)) {
        violations.push(`${relative} 直接写 resolution store（权威写入只允许 resolutionStore.ts）`);
      }
    }
    expect(violations).toEqual([]);
  });
});
