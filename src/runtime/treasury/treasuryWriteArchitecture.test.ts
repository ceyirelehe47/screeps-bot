/**
 * Treasury write-admission 架构边界测试（第五轮建立、第九轮升级全量扫描）：
 * - 全部规则扫描 src 下全部生产 .ts（测试豁免）——新增生产模块自动受约束；
 * - 单阶段入口退役：生产模块不得调用 recordAcceptedTransaction/
 *   recordAcceptedAction 或 compat 兼容入口；
 * - compat 模块只允许 Treasury 自身测试引用，任何 src 生产模块不得 import；
 * - 故障注入器（setTreasuryCommitFaultInjectorForTest）只允许测试引用；
 * - writer kernel 封闭（第九轮）：executePreparedAction/prepareTransaction/
 *   授权消费原语/contract 入口只允许 treasury 协议栈内部与测试；
 * - reservation/quarantine/intent/resolution store 直写只允许各自权威模块。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

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
  it("单阶段入口退役（全量扫描）：生产模块不得调用 recordAccepted*/compat 兼容入口", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      const isTest = filePath.endsWith(".test.ts");
      // facade.ts 是 recordAccepted* 的对象实现载体；compat.ts 是退役隔离
      // 模块自身——两者之外（含第九轮新增的任何生产模块）一律禁止。
      const isAuthority =
        relative === "runtime/treasury/facade.ts" ||
        relative === "runtime/treasury/compat.ts" ||
        // 第十轮：kernel 通道（类型签名提及 compat 入口）与测试 harness 白名单。
        relative === "runtime/treasury/kernelChannel.ts" ||
        relative === "runtime/treasury/testHarness.ts";
      if (isTest || isAuthority) continue;
      const source = readFileSync(filePath, "utf8");
      for (const reference of SINGLE_STAGE_REFERENCES) {
        if (source.includes(reference)) {
          violations.push(`${relative} 引用了单阶段入口 ${reference}`);
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
        relative === "runtime/treasury/resolutionStore.ts" ||
        // 第十轮：facade 是 service.resolveUnresolvedTransaction 管理入口的
        // 实现载体（经闭包 resolution kernel 调用，生产 tick 不自动调用）。
        relative === "runtime/treasury/facade.ts" ||
        // 第十一轮 3.13.10：resolutionAuthority 是 service 闭包的 resolution
        // 内部载体（pre-execution 恢复协议；生产 tick 不自动调用）。
        relative === "runtime/treasury/resolutionAuthority.ts";
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
      const isAuthority =
        relative === "runtime/treasury/faultResolution.ts" ||
        relative === "runtime/treasury/facade.ts" ||
        relative === "runtime/treasury/resolutionAuthority.ts";
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

  it("第九轮：writer kernel 封闭（全量扫描——新增生产模块自动受约束）", () => {
    // 低层写原语（任意 callback 执行/直接 prepare/授权消费/自填授权）只
    // 允许 treasury 协议栈内部（协议实现互相引用）与测试使用——任何新增
    // 生产模块自动受本规则约束（不再依赖固定文件清单）。真实生产 writer
    // 的未来接入 = executeTreasuryActionContract（须经注册 adapter 的正式
    // 接入评审，本轮未接任何真实 writer）。
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative.startsWith("runtime/treasury/")) continue; // 协议栈内部
      const source = readFileSync(filePath, "utf8");
      if (source.includes("executePreparedAction")) {
        violations.push(`${relative} 引用任意 callback 入口 executePreparedAction（writer kernel 内部原语）`);
      }
      if (source.includes("prepareTransaction")) {
        violations.push(`${relative} 直接调用 prepareTransaction（生产必须经 executeTreasuryActionContract）`);
      }
      if (source.includes("consumeTreasuryAuthorization") || source.includes("authorizeResourceUse")) {
        violations.push(`${relative} 直接消费授权原语（生产必须经 authorizeTreasuryActionContract + actionContracts 入口）`);
      }
      if (
        source.includes("buildTreasuryActionContract") ||
        source.includes("executeTreasuryActionContract") ||
        source.includes("authorizeTreasuryActionContract")
      ) {
        violations.push(`${relative} 直接构建/授权/执行 contract（须经注册 adapter 的正式接入评审，本轮未接真实 writer）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("【第十轮 3.12.5】kernel 通道与 test harness 边界：非 treasury 协议栈生产模块不得引用 kernelChannel/testHarness", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const isTest = filePath.endsWith(".test.ts");
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative.startsWith("runtime/treasury/")) continue; // 协议栈内部（kernelChannel/testHarness 互引合法）
      const source = readFileSync(filePath, "utf8");
      if (isTest) {
        // 测试文件允许显式 test harness；但不得直接引用 kernelChannel symbol
        //（低层原语一律经 testHarness 视图）。
        if (source.includes("kernelChannel")) {
          violations.push(`${relative}（测试）直接引用 kernel 通道——应经 testHarness`);
        }
        continue;
      }
      if (source.includes("kernelChannel") || source.includes("testHarness") || source.includes("TREASURY_WRITER_KERNEL")) {
        violations.push(`${relative} 引用 writer kernel 通道或测试 harness（生产不可达）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("【第十一轮 3.13.8】resolution kernel 通道封闭：仅 facade/faultResolution/testHarness 可引用 resolutionKernelChannel", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      const isTest = filePath.endsWith(".test.ts");
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (isTest) continue; // 规则针对生产源码（测试文件经 testHarness 视图访问）
      if (
        relative === "runtime/treasury/facade.ts" ||
        relative === "runtime/treasury/faultResolution.ts" ||
        relative === "runtime/treasury/testHarness.ts" ||
        relative === "runtime/treasury/resolutionKernelChannel.ts" ||
        relative === "runtime/treasury/resolutionAuthority.ts"
      ) continue;
      const source = readFileSync(filePath, "utf8");
      if (source.includes("resolutionKernelChannel") || source.includes("TREASURY_RESOLUTION_KERNEL")) {
        violations.push(`${relative} 引用 resolution kernel 通道（仅 facade/faultResolution/testHarness 可达）`);
      }
    }
    // 公共 TreasuryService 类型与运行时枚举不得再出现被移除的内部方法。
    const facadeSource = readSource("src/runtime/treasury/facade.ts");
    expect(facadeSource.includes("treasuryResolutionGuard")).toBe(false);
    expect(facadeSource.includes("treasuryServiceGeneration")).toBe(false);
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

  it("第九轮：capability registry 私有化——reconciliation.ts 不得导出注册/校验/消费入口", () => {
    // reconciliation.ts 只承载类型与结论枚举；任何 register/validate/consume
    // 导出都会让普通模块把自构对象加入 registry 或绕过 service 校验。
    const source = readSource("src/runtime/treasury/reconciliation.ts");
    const forbidden = [
      /export function registerTreasuryReconciliationCapability/,
      /export function validateTreasuryReconciliationCapability/,
      /export function consumeTreasuryReconciliationCapability/,
      /const capabilityRegistry/,
      /const consumedCapabilities/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
    // faultResolution 只能经窄接口（service.consumeReconciliationCapability）
    // 消费 capability——不得自行构造 capability 或引用旧 validate/consume。
    const frSource = readSource("src/runtime/treasury/faultResolution.ts");
    // 【第十一轮 3.13.8】kernel 通道形态：resolve 函数经 resolution kernel
    // symbol 消费（模块级注册函数已删除）。
    expect(frSource).toContain("kernel.consumeReconciliationCapability(input.capability)");
    expect(frSource.includes("registerTreasuryResolutionKernelForService")).toBe(false);
    expect(/registerTreasuryReconciliationCapability|validateTreasuryReconciliationCapability/.test(frSource)).toBe(false);
    // 其它生产模块不得访问 capability 注册/消费内核（faultResolution 经窄
    // 接口是唯一消费方）。
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (
        relative === "runtime/treasury/facade.ts" ||
        relative === "runtime/treasury/faultResolution.ts" ||
        relative === "runtime/treasury/reconciliation.ts" ||
        relative === "runtime/treasury/resolutionKernelChannel.ts" ||
        relative === "runtime/treasury/resolutionAuthority.ts" ||
        relative === "runtime/treasury/testHarness.ts"
      ) continue;
      const fileSource = readFileSync(filePath, "utf8");
      if (/consumeReconciliationCapability|registerTreasuryReconciliationCapability/.test(fileSource)) {
        violations.push(`${relative} 访问 capability 注册/消费内核（仅 service 闭包与 faultResolution 窄接口）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("第十七轮：child ID derive helper 是 test-only 边界——production 源码不得导入（child ID 只能经 issueTreasuryRearmCapability 交付）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      // attemptRearm.ts 自身定义该导出（test-only 标注）。
      if (relative === "runtime/treasury/attemptRearm.ts") continue;
      const fileSource = readFileSync(filePath, "utf8");
      if (/deriveTreasuryRearmChildTransactionId/.test(fileSource)) {
        violations.push(`${relative} 引用 deriveTreasuryRearmChildTransactionId（test-only——production 的 child 派生权威在 attemptLineage.deriveTreasuryLineageNextChildTransactionId，只经 facade issue 通道）`);
      }
      // tr1_ 命名空间判定单一权威在 transactionId.ts。【第二十轮 6.1】
      // isTreasuryRearmAttemptId 是收敛后的唯一判定入口（production 禁止
      // raw startsWith("tr1_")——下方另有专项扫描）；消费方白名单：
      // facade（门禁）、faultResolution（chain 终态收敛）、semanticLineage/
      // exactIdentity/GRA/receipts/resolutionStore/committedVerifier/
      // lineageHandoff（第二十轮 semantic proof 与 exact identity 的协议栈
      // 内部窄边界）。
      const REARM_NAMESPACE_CONSUMERS = new Set([
        "runtime/treasury/transactionId.ts",
        "runtime/treasury/facade.ts",
        "runtime/treasury/faultResolution.ts",
        "runtime/treasury/semanticLineageValidation.ts",
        "runtime/treasury/exactAttemptIdentity.ts",
        "runtime/treasury/generationRetirementAuthority.ts",
        "runtime/treasury/receipts.ts",
        "runtime/treasury/resolutionStore.ts",
        "runtime/treasury/committedProofVerifier.ts",
        "runtime/treasury/lineageHandoff.ts",
        "runtime/treasury/lineageGenerationRetirement.ts",
        "runtime/treasury/intents.ts",
        "runtime/treasury/quarantine.ts",
        "runtime/treasury/resolutionStateSemantics.ts",
        // 【Remediation III】facade 门禁语义的 stage handlers 迁移目标
        //（semantic lineage verdict / chain close 的 tr1_ 判定经此承载）。
        "runtime/treasury/resolutionCleanupStageHandlers.ts",
        // 【Remediation V 六】authorization fault v5 的 tr1_ lineage 携带矩阵
        //（写入前校验）与 tr1_ redemption fault 的 lineage publication 分支。
        "runtime/treasury/authorizationFaults.ts",
        "runtime/treasury/resolutionAuthority.ts",
        // 【Remediation VII】durable settlement authority 的 chain 级数据源
        //（tr1_ child ID 的 generation-addressable 查询路由）。
        "runtime/treasury/chainRetirementCertificate.ts",
        // 【Remediation VIII】production contract 通道的 ID 命名空间分类
        //（tr1_ 经 capability 门禁放行——facade 单一权威）与统一
        // reconciliation 的 tr1_ 查询路由（root/child 来源分流）。
        "runtime/treasury/actionContracts.ts",
        "runtime/treasury/historicalSettlementAuthority.ts",
      ]);
      if (/isTreasuryRearmAttemptId/.test(fileSource) && !REARM_NAMESPACE_CONSUMERS.has(relative)) {
        violations.push(`${relative} 引用 isTreasuryRearmAttemptId（tr1_ 判定单一权威在 transactionId.ts，门禁在 facade）`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── 【Round 22 Remediation VIII S10 / 十一节】统一 reconciliation 与
//    reservation handoff 的架构守护 ────────────────────────────────────────

describe("Treasury write-admission 架构边界（Remediation VIII）", () => {
  it("S10：安全关键模块不得直接拼装 historical/certificate/range truth graph（统一 resolver 单一入口）", () => {
    // 受控例外：统一 resolver（historicalSettlementAuthority）、底层实现
    //（chainRetirementCertificate / cleanupSupersessionAuthority）、压缩
    // 编排（lineageRetirementSummary——certificate/range 的 replacement
    // 在位检查）与注释引用（cleanupCompletionReplacement）。
    const LOW_LEVEL_LOOKUP_ALLOWLIST = new Set([
      "runtime/treasury/historicalSettlementAuthority.ts",
      "runtime/treasury/chainRetirementCertificate.ts",
      "runtime/treasury/cleanupSupersessionAuthority.ts",
      "runtime/treasury/cleanupCompletionReplacement.ts",
      "runtime/treasury/lineageRetirementSummary.ts",
    ]);
    const LOOKUP_PATTERN = /\b(?:lookupTreasuryHistoricalCompletion|lookupTreasuryChainRetirementCertificate|lookupTreasuryChainRetirementGenerationOutcome|checkTreasuryAttemptRetiredRange)\b/;
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.slice(SRC_ROOT.length + 1).split("\\").join("/");
      if (!relative.startsWith("runtime/treasury/")) continue;
      if (LOW_LEVEL_LOOKUP_ALLOWLIST.has(relative)) continue;
      const fileSource = readFileSync(filePath, "utf8");
      // 注释行不扫描（文档性引用不算拼装）。
      for (const line of fileSource.split("\n")) {
        const code = line.replace(/\/\/.*$/, "");
        if (LOOKUP_PATTERN.test(code)) {
          violations.push(`${relative} 直接调用底层 settlement 权威 lookup（安全关键模块必须经 resolveTreasuryDurableSettlementAuthority / resolveTreasuryCleanupCompletionAuthority）`);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("reservation consume/release 不得被 void 忽略（结构化结果必须检查）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.slice(SRC_ROOT.length + 1).split("\\").join("/");
      if (!relative.startsWith("runtime/treasury/")) continue;
      // 定义处（completionHeadroomReservation）与 checked owner
      //（cleanupCompletionHandoff——内部检查并计数）例外。
      if (relative === "runtime/treasury/completionHeadroomReservation.ts" || relative === "runtime/treasury/cleanupCompletionHandoff.ts") continue;
      const fileSource = readFileSync(filePath, "utf8");
      const VOID_PATTERN = /^\s*(?:const|let|var)?\s*(?:consume|release)TreasuryCompletionHeadroomReservation\([^)]*\)\s*;/;
      for (const line of fileSource.split("\n")) {
        if (VOID_PATTERN.test(line)) {
          violations.push(`${relative} 裸调用 reservation mutation（结果不得被 void 忽略——须检查结构化结果或经 checked owner）`);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("completion publication 的生产调用方只有 cleanup stage acknowledgement（受控 handoff owner 内）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.slice(SRC_ROOT.length + 1).split("\\").join("/");
      if (!relative.startsWith("runtime/treasury/")) continue;
      if (relative === "runtime/treasury/cleanupCompletionAuthority.ts" || relative === "runtime/treasury/cleanupStageAcknowledgement.ts") continue;
      const fileSource = readFileSync(filePath, "utf8");
      const code = fileSource.replace(/\/\/[^\n]*/g, "");
      if (/recordTreasuryCleanupCompletion\(/.test(code)) {
        violations.push(`${relative} 直接调用 completion publication（生产 publication 只能经 cleanupStageAcknowledgement 的 matching reservation handoff）`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── 【Round 22 Remediation VII T20】service-issued ID / archive 结果守护 ────

describe("Treasury write-admission 架构边界（Remediation VII）", () => {
  it("production contract 通道调用方必须经 mint/capability 取得 transactionId（arbitrary caller ID 只存在于测试域）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      if (filePath.endsWith("actionContracts.ts")) continue; // enforcement 自身
      const relative = filePath.split(/[\/]/).slice(-3).join("/");
      const fileSource = readFileSync(filePath, "utf8");
      const usesContractChannel = /executeTreasuryActionContract|buildTreasuryActionContract/.test(fileSource);
      if (!usesContractChannel) continue;
      const minted = /mintTreasuryInitialAttemptId|issueTreasuryRearmCapability/.test(fileSource);
      if (!minted) {
        violations.push(`${relative} 使用 production contract 通道但未经 service-issued ID authority（mint/capability）取得 transactionId`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("production 源码不得以 void 忽略 completion archive 结果（依赖回收成功的路径必须处理结构化结果）", () => {
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\/]/).slice(-3).join("/");
      const fileSource = readFileSync(filePath, "utf8");
      if (/void\s+archiveTreasuryCleanupCompletionViaAuthority/.test(fileSource)) {
        violations.push(`${relative} 以 void 忽略 archiveTreasuryCleanupCompletionViaAuthority 结果`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── 【Round 22 Remediation III 8.4】cleanup 阶段推进的架构守卫 ───────────────

describe("Treasury cleanup 阶段推进架构守卫（Remediation III）", () => {
  it("journal 写原语只有受控调用方：生产代码不得直接调用 mark/activate/complete（唯一 ack 实现之外）", () => {
    const violations: string[] = [];
    const ALLOWED = new Set([
      // 原语定义（本模块）。
      "runtime/treasury/resolutionCleanupJournal.ts",
      // 唯一 durable acknowledgement 实现（内部调用检查返回值）。
      "runtime/treasury/cleanupStageAcknowledgement.ts",
    ]);
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (ALLOWED.has(relative)) continue;
      const fileSource = readFileSync(filePath, "utf8");
      if (/markTreasuryResolutionCleanupStage\s*\(/.test(fileSource)) {
        violations.push(`${relative} 调用 markTreasuryResolutionCleanupStage（阶段推进必须经 cleanupStageAcknowledgement 的结构化 ack）`);
      }
      if (/activateTreasuryResolutionCleanupProof\s*\(/.test(fileSource)) {
        violations.push(`${relative} 调用 activateTreasuryResolutionCleanupProof（activation 必须经 settlementProofActivation 的 matching proof 验证）`);
      }
      if (/completeTreasuryResolutionCleanup\s*\(/.test(fileSource)) {
        violations.push(`${relative} 调用 completeTreasuryResolutionCleanup（journal completion 必须经 completeTreasuryCleanupAcknowledged 的删除 read-back）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("cleanupStageAcknowledgement 内部调用必须检查返回值（不允许表达式语句）", () => {
    const source = readFileSync(join(SRC_ROOT, "runtime/treasury/cleanupStageAcknowledgement.ts"), "utf8");
    const violations: string[] = [];
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      const statement = line.match(/^\s*(?:markTreasuryResolutionCleanupStage|completeTreasuryResolutionCleanup)\s*\(/);
      if (statement) {
        violations.push(`cleanupStageAcknowledgement.ts:${String(index + 1)} 表达式语句调用写原语（返回值必须被检查）`);
      }
    });
    // 实际调用（if 条件内）不在行首——表达式语句正则应零命中。
    expect(violations).toEqual([]);
    // 且模块内确实存在受控调用（防退化成空壳）。
    expect(source).toMatch(/if \(!markTreasuryResolutionCleanupStage\(/);
    expect(source).toMatch(/if \(!completeTreasuryResolutionCleanup\(/);
  });

  it("staged/committed destructive 路径的 receipt 读取必须 release-trusted（replay 直读只允许显式预检标记）", () => {
    const violations: string[] = [];
    const GUARDED = ["runtime/treasury/resolutionStore.ts", "runtime/treasury/faultResolution.ts"];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (!GUARDED.includes(relative)) continue;
      const lines = readFileSync(filePath, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (/readTreasurySettlementProof\s*\(/.test(line)) {
          // 上方 3 行内必须有 replay 预检标记（显式查询用途——正式 proof 走 trusted）。
          const context = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
          if (!context.includes("replay-readable 预检") && !context.includes("replay 预检")) {
            violations.push(`${relative}:${String(index + 1)} 直读 readTreasurySettlementProof 而无 replay 预检标记（release 路径必须 readTreasuryTrustedSettlementProofForAttempt）`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("单一 destructive owner：journal 恢复只经装配的 recovery driver（不存在第二套阶段推进）", () => {
    const journalSource = readFileSync(join(SRC_ROOT, "runtime/treasury/resolutionCleanupJournal.ts"), "utf8");
    // journal 恢复循环不得直接调用 discharge/release/finalize 原语（driver 装配推进）。
    expect(journalSource).toMatch(/recoveryDriver\.advance\(/);
    expect(journalSource).toMatch(/registerTreasuryResolutionCleanupRecoveryDriverForAssembly/);
    // immediate 路径与恢复共用 coordinator 的 advance。
    const facadeSource = readFileSync(join(SRC_ROOT, "runtime/treasury/facade.ts"), "utf8");
    expect(facadeSource).toMatch(/advanceTreasuryResolutionCleanupPhases\(/);
    const faultResolutionSource = readFileSync(join(SRC_ROOT, "runtime/treasury/faultResolution.ts"), "utf8");
    expect(faultResolutionSource).toMatch(/advanceTreasuryResolutionCleanupPhases\(/);
    const resolutionStoreSource = readFileSync(join(SRC_ROOT, "runtime/treasury/resolutionStore.ts"), "utf8");
    expect(resolutionStoreSource).toMatch(/advanceTreasuryResolutionCleanupPhases\(/);
  });
});

// ── 【Round 22 Remediation VI 4.5/T14】completion 删除单一权威入口 ──────────

describe("Treasury completion supersession 架构守卫（Remediation VI）", () => {
  it("completion 底层 release 只允许统一 supersession/archive authority 模块使用（T14）", () => {
    const violations: string[] = [];
    // 底层 release 原语（cleanupCompletionAuthority 定义处）+ 统一入口
    //（cleanupSupersessionAuthority——内部承载"验证 → historical authority
    // 写入 read-back → 删除 → 删除 read-back"固定顺序）之外的生产模块一律
    // 禁止：attemptLineage / lineageRetirementSummary / headroom reclaim /
    // cleanup acknowledgement 等调用方只能经 archiveTreasuryCleanup
    // CompletionViaAuthority。
    const ALLOWED = new Set([
      "runtime/treasury/cleanupCompletionAuthority.ts",
      "runtime/treasury/cleanupSupersessionAuthority.ts",
    ]);
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (ALLOWED.has(relative)) continue;
      const source = readFileSync(filePath, "utf8");
      if (/releaseTreasuryCleanupCompletionOfAttempt/.test(source)) {
        violations.push(`${relative} 直接引用 completion 底层 release（删除必须经 cleanupSupersessionAuthority 统一入口）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("不得重新引入 transactionId-only supersession / tombstone-alone-completed 模式（T14）", () => {
    // 统一入口内部必须 exact 验证 replacement（outcome + 全维度 identity），
    // 且 coordinator 的 journal-absent 完成判定只依赖 completion/historical
    // authority（GRA/tombstone 不再单独证明 cleanup completed）。
    const authoritySource = readFileSync(join(SRC_ROOT, "runtime/treasury/cleanupSupersessionAuthority.ts"), "utf8");
    expect(authoritySource).toMatch(/verifyTreasuryExactCompletionReplacement/);
    expect(authoritySource).toMatch(/input\.completion\.resolution !== "not-executed"/);
    const coordinatorSource = readFileSync(join(SRC_ROOT, "runtime/treasury/resolutionCleanupCoordinator.ts"), "utf8");
    // 【Remediation VII】journal-absent 完成判定升级为单一 durable settlement
    // resolver（live completion → historical → chain certificate——压缩后
    // 不退化为 no_cleanup_authority）。
    expect(coordinatorSource).toMatch(/resolveTreasuryDurableSettlementAuthority/);
    expect(coordinatorSource).not.toMatch(/verifyTreasuryCleanupCompletionSupersession/);
    // lifecycle 驱动点（attemptLineage / summary compaction）只经统一入口。
    const attemptLineageSource = readFileSync(join(SRC_ROOT, "runtime/treasury/attemptLineage.ts"), "utf8");
    expect(attemptLineageSource).toMatch(/archiveTreasuryCleanupCompletionViaAuthority/);
    expect(attemptLineageSource).not.toMatch(/releaseTreasuryCleanupCompletionOfAttempt/);
    const summarySource = readFileSync(join(SRC_ROOT, "runtime/treasury/lineageRetirementSummary.ts"), "utf8");
    expect(summarySource).toMatch(/archiveTreasuryCleanupCompletionViaAuthority/);
    expect(summarySource).not.toMatch(/releaseTreasuryCleanupCompletionOfAttempt/);
  });

  it("state-changing 路径的 completion headroom preflight 已接入（authorize/prepare/execute）", () => {
    const facadeSource = readFileSync(join(SRC_ROOT, "runtime/treasury/facade.ts"), "utf8");
    const occurrences = facadeSource.split("ensureTreasuryCleanupCompletionHeadroom").length - 1;
    // authorize + prepare + execute 三处调用 + readinessSources 装配 import。
    expect(occurrences).toBeGreaterThanOrEqual(3);
    expect(facadeSource).toMatch(/"completion_headroom_exhausted"/);
    expect(facadeSource).toMatch(/"completion_store_unhealthy"/);
  });
});
