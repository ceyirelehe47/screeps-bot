/**
 * 【Round 22 Remediation IX 工作流 B / 5.1】Treasury 持久 store 的机器可
 * 检查 lifecycle inventory 架构守护。
 *
 * 系统级不变量：No persistent store without a lifecycle contract.——
 * 架构测试对照源码扫描验证 registry 完备性与分类约束；runtime 固定反例
 * 在 treasuryRound22RemediationIX.test.ts（A/H/O/Q/S 组）。
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  TREASURY_STORE_LIFECYCLE_CONTRACTS,
  lookupTreasuryStoreLifecycleContract,
  type TreasuryStoreLifecycleContract,
} from "@/runtime/treasury/treasuryLifecycleContract";
import { TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES } from "@/runtime/treasury/attemptIssuanceTicket";

const SRC_ROOT = join(process.cwd(), "src");

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 扫描 treasury 分支下被引用的持久 store 键（宽松正则——宁多勿漏）。 */
function scanTreasuryStoreKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  const pattern = /treasury\s*\??\.\s*([A-Za-z][A-Za-z0-9]*)/g;
  for (const filePath of listFilesRecursive(join(SRC_ROOT, "runtime", "treasury"))) {
    if (filePath.endsWith(".test.ts")) continue;
    const relative = filePath.split(/[\\/]/).slice(-3).join("/");
    const source = readFileSync(filePath, "utf8");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const key = match[1]!;
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key)!.push(relative);
    }
  }
  return keys;
}

const AUTHORITY_CLASSIFICATIONS = new Set(["active-unresolved", "recent-exact-detail", "permanent-anti-reuse"]);

describe("Remediation IX：Treasury Memory lifecycle contract（machine-checkable inventory）", () => {
  it("registry 完备性：源码引用的全部 treasury store 键均已登记 lifecycle contract（新 store 未登记 → 失败）", () => {
    const scanned = scanTreasuryStoreKeys();
    const registered = new Set(TREASURY_STORE_LIFECYCLE_CONTRACTS.map((contract) => contract.storeKey));
    // 方法调用形态（treasury.<fn>(...)）的误报豁免：这些键是函数调用而非
    // 持久 store（kernelChannel/policyAuthority 的 service 动态访问）。
    const METHOD_CALL_FALSE_POSITIVES = new Set(["writer", "test", "resolution"]);
    const missing: string[] = [];
    for (const [key, holders] of scanned) {
      if (registered.has(key)) continue;
      if (METHOD_CALL_FALSE_POSITIVES.has(key)) continue;
      missing.push(`${key}（${[...new Set(holders)].slice(0, 3).join(", ")}）`);
    }
    expect(missing).toEqual([]);
  });

  it("temporal store 必须有退出路径（terminalCondition 与 cleanupOwner 非空——无退出路径的时效数据不得存在）", () => {
    const violations: string[] = [];
    for (const contract of TREASURY_STORE_LIFECYCLE_CONTRACTS) {
      if (contract.classification === "telemetry-audit") continue; // 覆盖写无退出语义
      if (contract.terminalCondition.trim().length === 0) {
        violations.push(`${contract.storeKey} 缺 terminalCondition`);
      }
      if (contract.cleanupOwner.trim().length === 0) {
        violations.push(`${contract.storeKey} 缺 cleanupOwner`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("安全权威 store 不得被标成 telemetry-audit（authority store 的容量压力不得静默覆盖）", () => {
    const violations: string[] = [];
    for (const contract of TREASURY_STORE_LIFECYCLE_CONTRACTS) {
      if (contract.classification === "telemetry-audit" && contract.retentionPolicy !== "ring-overwrite") {
        violations.push(`${contract.storeKey} 标为 telemetry 但 retentionPolicy 非 ring-overwrite`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("active/unresolved store 不得配置年龄淘汰（满载必须阻断新 writer，不按 FIFO/年龄删除）", () => {
    const violations: string[] = [];
    for (const contract of TREASURY_STORE_LIFECYCLE_CONTRACTS) {
      if (contract.classification !== "active-unresolved") continue;
      if (contract.allowsAgeEviction) violations.push(`${contract.storeKey}（active/unresolved）允许年龄淘汰`);
      if (contract.retentionPolicy === "ring-overwrite") violations.push(`${contract.storeKey}（active/unresolved）配置 ring-overwrite`);
      if (contract.overflowBehavior === "overwrite-oldest") violations.push(`${contract.storeKey}（active/unresolved）满载覆盖最旧`);
    }
    expect(violations).toEqual([]);
  });

  it("全部 store 必须声明硬容量或单标量说明（无界 store 不允许）", () => {
    const violations: string[] = [];
    for (const contract of TREASURY_STORE_LIFECYCLE_CONTRACTS) {
      if (contract.hardCapacity === null && contract.capacityNote.trim().length === 0) {
        violations.push(`${contract.storeKey} 无硬容量且无 capacityNote`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("recent-exact-detail store 必须声明 replacement authority（淘汰前的接管者）", () => {
    const violations: string[] = [];
    for (const contract of TREASURY_STORE_LIFECYCLE_CONTRACTS) {
      if (contract.classification !== "recent-exact-detail") continue;
      if (contract.replacementAuthority === null || contract.replacementAuthority.trim().length === 0) {
        violations.push(`${contract.storeKey}（recent exact detail）缺 replacementAuthority`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("GC coordinator 由 facade beginTick 唯一接线（query 路径零 GC）", () => {
    const callers: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const source = readFileSync(filePath, "utf8");
      if (/runTreasuryLifecycleGcCoordinator\s*\(/.test(source) && !source.includes("export function runTreasuryLifecycleGcCoordinator")) {
        callers.push(filePath.split(/[\\/]/).slice(-3).join("/"));
      }
    }
    expect(callers).toEqual(["runtime/treasury/facade.ts"]);
    // lifecycle contract registry 是纯数据（无 Memory 写——query 零写守护）。
    const registrySource = readFileSync(join(SRC_ROOT, "runtime", "treasury", "treasuryLifecycleContract.ts"), "utf8");
    expect(/Memory\.runtime\s*=/.test(registrySource)).toBe(false);
  });

  it("destructive eviction 调用方必须使用结构化 retired range 查询（boolean 折叠 API 不得用于 GC 决策）", () => {
    // eviction/compaction 决策文件（summary 满载驱逐 + certificate 满载驱逐）
    // 不得调用 checkTreasuryAttemptRetiredRange（store unhealthy 折叠为
    // retired=true 的最外层 fail-closed API——Q1）。
    const evictionFiles = [
      join(SRC_ROOT, "runtime", "treasury", "lineageRetirementSummary.ts"),
      join(SRC_ROOT, "runtime", "treasury", "chainRetirementCertificate.ts"),
    ];
    const violations: string[] = [];
    for (const filePath of evictionFiles) {
      const source = readFileSync(filePath, "utf8");
      // certificate 模块内部定义 checkTreasuryAttemptRetiredRange（允许——
      // 定义处），但 eviction 函数体内不得调用（粗粒度：全文件调用点数
      // 应只出现在定义与最外层 replay 折叠 API 自身）。
      const callMatches = source.match(/checkTreasuryAttemptRetiredRange\s*\(/g) ?? [];
      const definitionCount = (source.match(/export function checkTreasuryAttemptRetiredRange\s*\(/g) ?? []).length;
      if (callMatches.length > definitionCount) {
        violations.push(`${filePath.split(/[\\/]/).slice(-1)[0]} 调用了 boolean 折叠 range API（eviction 决策必须用 lookupTreasuryRetiredRangeStructured）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("reservation mutation（acquire/consume/release）结果不得被语句位置忽略（H9 源码扫描）", () => {
    const patterns = [
      /^\s*(?:consumeTreasuryCompletionHandoff|releaseTreasuryCompletionHeadroomChecked|consumeTreasuryCompletionHeadroomReservation|releaseTreasuryCompletionHeadroomReservation)\([^)]*\);\s*$/gm,
    ];
    const violations: string[] = [];
    for (const filePath of listFilesRecursive(join(SRC_ROOT, "runtime", "treasury"))) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      // 定义文件自身的 re-export 形态豁免（模块内部的一行委托）。
      if (relative === "runtime/treasury/completionHeadroomReservation.ts") continue;
      const source = readFileSync(filePath, "utf8");
      for (const pattern of patterns) {
        const match = pattern.exec(source);
        if (match !== null) {
          violations.push(`${relative}: ${match[0]!.trim().slice(0, 80)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("production 签发通道唯一：mint 只存在于受控 opening（attemptIssuanceTicket）与 issuer 模块内部", () => {
    const callers: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/attemptIssuer.ts" || relative === "runtime/treasury/attemptIssuanceTicket.ts") continue;
      const source = readFileSync(filePath, "utf8");
      if (/mintTreasuryInitialAttemptId\s*\(/.test(source)) {
        callers.push(relative);
      }
    }
    expect(callers).toEqual([]);
  });

  it("issuer 版本边界：新协议不得复用旧 store version / 旧命名空间而无迁移语义（守护 1/2）", () => {
    const issuerSource = readFileSync(join(SRC_ROOT, "runtime", "treasury", "attemptIssuer.ts"), "utf8");
    // 新 store version=2、当前命名空间 ti2_、legacy 记录保留（不清空旧 Memory）。
    expect(issuerSource).toContain("TREASURY_ATTEMPT_ISSUER_VERSION = 2");
    expect(issuerSource).toContain('TREASURY_ISSUED_ID_PREFIX = "ti2_"');
    expect(issuerSource).toContain("legacy");
    expect(issuerSource).toContain("migrateLegacyIssuerStore");
    // contract 通道的 ti1_ 拒绝语义（legacy namespace 不进 production callback）。
    const contractSource = readFileSync(join(SRC_ROOT, "runtime", "treasury", "actionContracts.ts"), "utf8");
    expect(contractSource).toContain("旧 ti1_ issued namespace");
  });

  it("lifecycle contract 的分类完整性（本轮新增 store 全部登记——issuedAttemptTickets / GC coordinator 一致）", () => {
    const ticketContract = lookupTreasuryStoreLifecycleContract("issuedAttemptTickets");
    expect(ticketContract).toBeDefined();
    if (ticketContract !== undefined) {
      expect(ticketContract!.classification).toBe("active-unresolved");
      // 【X 工作流 G】总 entry 硬容量（active 64 是并发上限，不是 store 容量）。
      expect(ticketContract!.hardCapacity).toBe(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
      expect(ticketContract!.allowsAgeEviction).toBe(false);
      expect(ticketContract!.overflowBehavior).toBe("fail-closed");
    }
    // 全部 active-unresolved 契约的 TTL 策略必须声明唯一清理状态机（owner
    // truth graph 恢复由 treasuryLifecycleOwnerResolver 统一承载——O1-O6）。
    for (const contract of TREASURY_STORE_LIFECYCLE_CONTRACTS as readonly TreasuryStoreLifecycleContract[]) {
      if (contract.classification === "active-unresolved" && contract.retentionPolicy === "ttl") {
        expect(contract.cleanupOwner.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// ══【Round 22 Remediation X】架构守护（第五节 12 项）════════════════════════

describe("Remediation X：ticket handoff / namespace / health-complete 架构守护", () => {
  function readSource(relative: string): string {
    return readFileSync(join(SRC_ROOT, ...relative.split("/")), "utf8");
  }

  it("X1：production initial attempt 执行路径必须引用内部 ticket handoff gate", () => {
    // prepare 层 gate（contract 与低层 kernel 通道的必经点）+ execution-started
    // 后的 handoff consume 都在 facade.executePreparedAction / prepareTransaction。
    const facadeSource = readSource("runtime/treasury/facade.ts");
    expect(facadeSource).toContain("gateTreasuryIssuedAttemptTicketForPrepare");
    expect(facadeSource).toContain("gateTreasuryIssuedAttemptTicketForContractExecution");
    expect(facadeSource).toContain("completeTreasuryIssuedTicketHandoff");
    // contract binding gate 先于 redemption / intent / callback。
    const facadeGateIndex = facadeSource.indexOf("bindingGate");
    expect(facadeGateIndex).toBeGreaterThan(-1);
    const redemptionIndex = facadeSource.indexOf("redeemAuthorizationBundleAtomic(", facadeGateIndex);
    expect(redemptionIndex).toBeGreaterThan(facadeGateIndex);
  });

  it("X2：production 模块不得直接调用 mintTreasuryInitialAttemptId（受控 opening 唯一）", () => {
    const callers: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/attemptIssuer.ts" || relative === "runtime/treasury/attemptIssuanceTicket.ts") continue;
      if (/mintTreasuryInitialAttemptId\s*\(/.test(readFileSync(filePath, "utf8"))) {
        callers.push(relative);
      }
    }
    expect(callers).toEqual([]);
  });

  it("X3：production 模块不得手工调用 ticket consume 绕开接管协议（owner-gated handoff 唯一）", () => {
    const callers: string[] = [];
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (filePath.endsWith(".test.ts")) continue;
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/attemptIssuanceTicket.ts" || relative === "runtime/treasury/attemptIssuanceHandoff.ts") continue;
      if (/consumeTreasuryIssuedAttemptTicketForHandoff\s*\(/.test(readFileSync(filePath, "utf8"))) {
        callers.push(relative);
      }
    }
    expect(callers).toEqual([]);
    // 【XII】handoff 模块的 consume 必须在 positive-owner verifier 判定
    // 之后（verify → matching 三态才允许 consume）。
    const handoffSource = readSource("runtime/treasury/attemptIssuanceHandoff.ts");
    const verifyIndex = handoffSource.indexOf("verifyTreasuryPositiveOwnershipForOpening(transactionId, expected)");
    const consumeIndex = handoffSource.indexOf("consumeTreasuryIssuedAttemptTicketForHandoff(transactionId)");
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(consumeIndex).toBeGreaterThan(verifyIndex);
  });

  it("X4：retired range destructive API 必须携带 issuer domain（裸 sequence 不再是合法入参）", () => {
    const source = readSource("runtime/treasury/chainRetirementCertificate.ts");
    // 导出签名的第一参数是 namespace 枚举。
    expect(source).toMatch(/export function absorbTreasuryRetiredSequence\(\s*namespace: TreasuryRetiredRangeNamespace,/);
    // 全部调用点首参为发行域（namespace 枚举 / "legacy" / "current" /
    // parse 结果的 namespace 字段——无裸 sequence 调用残留）。
    const callHeads = [...source.matchAll(/absorbTreasuryRetiredSequence\(\s*([\w."]+)/g)].map((match) => match[1]!);
    expect(callHeads.length).toBeGreaterThanOrEqual(3);
    for (const head of callHeads) {
      expect(["namespace", '"legacy"', '"current"', "parsed.namespace", "parsedRoot.namespace", "parsedEvictRoot.namespace"]).toContain(head);
    }
    // rangeAbsorbsSequence 的 guard 同样按域匹配。
    expect(source).toContain("rangeAbsorbsSequence(namespace: \"legacy\" | \"current\", sequence: number)");
  });

  it("X5：namespace-aware range/certificate store 全部登记 lifecycle contract（v2 语义）", () => {
    const rangeContract = lookupTreasuryStoreLifecycleContract("retiredAttemptRanges");
    expect(rangeContract).toBeDefined();
    expect(rangeContract!.protectedFact).toContain("namespace");
    expect(rangeContract!.resetRecovery).toContain("v1 裸 sequence store 经 tick-boundary migration owner 显式迁移");
    const certificateContract = lookupTreasuryStoreLifecycleContract("chainRetirementCertificates");
    expect(certificateContract).toBeDefined();
  });

  it("X6：destructive orphan consumer 必须调用统一 lifecycle owner resolver（不自拼 owner 列表）", () => {
    // retired range gap coalesce 与 reservation TTL sweep 均经 resolver。
    const certificateSource = readSource("runtime/treasury/chainRetirementCertificate.ts");
    expect(certificateSource).toContain("resolveTreasuryAttemptLifecycleOwnership");
    const handoffSource = readSource("runtime/treasury/cleanupCompletionHandoff.ts");
    expect(handoffSource).toContain("resolveTreasuryAttemptLifecycleOwnership");
  });

  it("X7：Intent/Quarantine 的 fatal-折叠 read API 不得在未检查健康时作为 absence 证明（resolver 内 validation 前置 + 零写）", () => {
    const resolverSource = readSource("runtime/treasury/treasuryLifecycleOwnerResolver.ts");
    // 【XII/D】Intent/Quarantine 维度均改零写全量校验视图（不 load、不迁移、
    // 不创建空 store——legacy 版本 migration_required fail closed），单条
    // 读取用 ForQuery 变体（零写）。
    expect(resolverSource).toContain("peekTreasuryIntentStoreValidation()");
    expect(resolverSource).toContain("readTreasuryIntentEntryForQuery(transactionId)");
    const intentEnsure = resolverSource.indexOf("peekTreasuryIntentStoreValidation()");
    const intentRead = resolverSource.indexOf("readTreasuryIntentEntryForQuery(transactionId)");
    expect(intentRead).toBeGreaterThan(intentEnsure);
    expect(resolverSource).toContain("peekTreasuryQuarantineStoreValidation()");
    expect(resolverSource).toContain("readTreasuryQuarantineEntryForQuery(transactionId)");
    const quarantineEnsure = resolverSource.indexOf("peekTreasuryQuarantineStoreValidation()");
    const quarantineRead = resolverSource.indexOf("readTreasuryQuarantineEntryForQuery(transactionId)");
    expect(quarantineRead).toBeGreaterThan(quarantineEnsure);
    // Authorization Fault 维度同样零写校验前置（migration_required 不折叠为 absent）。
    expect(resolverSource).toContain("peekTreasuryAuthorizationFaultStoreValidation()");
    // settled receipt 的整店 health 前置。
    expect(resolverSource).toContain("peekTreasuryReceiptHealth()");
    // summary probe 未装配 → owned（不静默跳过维度）。
    expect(resolverSource).toContain("retirement summary probe 未装配");
  });

  it("X8：GRA capacity eviction 必须调用 exact replacement verifier（存在性检查不得授权驱逐）", () => {
    const graSource = readSource("runtime/treasury/generationRetirementAuthority.ts");
    expect(graSource).toContain("verifyTreasuryGenerationSummaryReplacement");
    // 【XI 工作流 D】全部生产删除收敛到统一 release primitive——驱逐扫描的
    // verifier → 依赖检查 → primitive 删除顺序仍成立（primitive 内部自验
    // replacement relation + 依赖关闭 + 索引 + read-back）。
    const verifierIndex = graSource.indexOf("const relationError = verifyTreasuryGenerationSummaryReplacement(proof, summary);");
    expect(verifierIndex).toBeGreaterThan(-1);
    const dependencyIndex = graSource.indexOf("generationProofDependenciesActive(proof)");
    expect(dependencyIndex).toBeGreaterThan(verifierIndex);
    const evictCallIndex = graSource.indexOf('releaseGenerationProofDestructive(runtime, key, "summary_superseded")', dependencyIndex);
    expect(evictCallIndex).toBeGreaterThan(dependencyIndex);
    // 统一 primitive 是唯一删除实现点（函数体内含 delete + 双索引 + read-back）。
    const primitiveIndex = graSource.indexOf("function releaseGenerationProofDestructive(");
    expect(primitiveIndex).toBeGreaterThan(-1);
    const primitiveDeleteIndex = graSource.indexOf("delete runtime.store.entries[key];", primitiveIndex);
    expect(primitiveDeleteIndex).toBeGreaterThan(primitiveIndex);
    // 驱逐索引维护：byAttempt 与 byLineage 双清（primitive 内）。
    expect(graSource).toContain("runtime.byAttempt.delete(proof.transactionId);");
    expect(graSource).toContain("runtime.byLineage.get(proof.lineageId)");
  });

  it("X9：legacy replay-only summary 不得成为 destructive replacement source（modern-only probe）", () => {
    const summarySource = readSource("runtime/treasury/lineageRetirementSummary.ts");
    const probeIndex = summarySource.indexOf("__registerGenerationSummaryProbe({");
    const modernOnlySnippet = summarySource.slice(probeIndex, probeIndex + 700);
    expect(modernOnlySnippet).toContain("schemaVersion !== TREASURY_RETIREMENT_SUMMARY_VERSION");
    // GRA verifier 的 schema 维度。
    const graSource = readSource("runtime/treasury/generationRetirementAuthority.ts");
    expect(graSource).toContain("summary 不是当前 exact schema");
  });

  it("X10：ticket store 总容量常量与 validator / lifecycle contract 三方一致", () => {
    const ticketSource = readSource("runtime/treasury/attemptIssuanceTicket.ts");
    expect(ticketSource).toContain("TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES = 128");
    expect(ticketSource).toContain("超过总硬容量");
    // open 的总容量检查在 mint 之前（watermark 不预推进）。
    const totalCheckIndex = ticketSource.indexOf("runtime.store.entryCount >= TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES");
    const mintIndex = ticketSource.indexOf("const minted = mintTreasuryInitialAttemptId();");
    expect(totalCheckIndex).toBeGreaterThan(-1);
    expect(mintIndex).toBeGreaterThan(totalCheckIndex);
    const contract = lookupTreasuryStoreLifecycleContract("issuedAttemptTickets");
    expect(contract!.hardCapacity).toBe(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
  });

  it("X11：facade query 路径不得运行 ticket GC 或其它 Memory mutation（GC 由 beginTick 唯一接线）", () => {
    const facadeSource = readSource("runtime/treasury/facade.ts");
    // ticket GC（expire/retire）只经 coordinator，facade 不直接调用。
    expect(facadeSource).not.toMatch(/expireTreasuryIssuedAttemptTickets\s*\(/);
    expect(facadeSource).not.toMatch(/retireTreasuryTerminalIssuedAttemptTickets\s*\(/);
    expect(facadeSource).toContain("runTreasuryLifecycleGcCoordinator()");
    const coordinatorSource = readSource("runtime/treasury/treasuryLifecycleGcCoordinator.ts");
    expect(coordinatorSource).toContain("runTreasuryLifecycleGcCoordinator");
    // gate 的 durable-owner 恢复是 owner-gated consume（写路径），不得进入
    // query 入口——以 query 函数（observation/metrics/writeAdmission）不含
    // gate 调用验证。
    const observationIndex = facadeSource.indexOf("observation():");
    const gateIndex = facadeSource.indexOf("gateTreasuryIssuedAttemptTicketForPrepare(");
    expect(observationIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(-1);
  });

  it("X12：Defense 生产文件零修改（本轮 Treasury-only 冻结）", () => {
    // 源码级确认：Defense 生产模块不引用 Treasury ticket/handoff 内部协议。
    const defenseFiles = listFilesRecursive(SRC_ROOT).filter((filePath) => {
      const relative = filePath.split(/[\\/]/).slice(-2).join("/");
      return !filePath.endsWith(".test.ts") && relative.startsWith("runtime/") &&
        /defense|Defender|focusFire|fallback|tower/i.test(filePath.split(/[\\/]/).pop() ?? "");
    });
    expect(defenseFiles.length).toBeGreaterThan(0);
    for (const filePath of defenseFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/attemptIssuance(Ticket|Handoff)/);
      expect(source).not.toMatch(/consumeTreasuryIssuedAttemptTicket/);
    }
  });
});

// ══ 【Round 22 Remediation XI】正向 handoff / canonical identity / 统一
//     GRA release / query-pure migration 架构守护 ═════════════════════════

describe("Remediation XI：positive handoff / canonical identity / unified release / query-pure migration 架构守护", () => {
  function readSource(relative: string): string {
    return readFileSync(join(SRC_ROOT, ...relative.split("/")), "utf8");
  }

  it("XI1：ticket handoff 必须消费结构化 positive-owner verdict（不得用通用 resolver 的模糊 owned 授权 consume）", () => {
    const handoffSource = readSource("runtime/treasury/attemptIssuanceHandoff.ts");
    // 【XII】consume 授权来自 positive verifier 的 matching 三态（expected
    // identity 绑定当前 opening），不再消费 resolver 的 exact_owner。
    expect(handoffSource).toContain('verifyTreasuryPositiveOwnershipForOpening');
    expect(handoffSource).toContain('verdict.verdict !== "matching_not_started_owner"');
    // 模糊 owned（含 unhealthyOwned 保守阻断与 conflict blocker）不得作为
    // consume 依据——handoff 内不得出现 status === "owned" 判定。
    expect(handoffSource).not.toContain('ownership.status === "owned"');
    // resolver 的 verdict 三值结构化（exact_owner / blocked / absent）。
    const resolverSource = readSource("runtime/treasury/treasuryLifecycleOwnerResolver.ts");
    expect(resolverSource).toContain('verdict: "exact_owner"');
    expect(resolverSource).toContain('verdict: "blocked"');
    expect(resolverSource).toContain('verdict: "absent"');
    // conflict blocker 是 storeUnhealthy=false 的 blocked（不得用
    // !storeUnhealthy 区分安全语义）。
    expect(resolverSource).toContain("blockerOwned");
  });

  it("XI2：gate 不得忽略 handoff mutation result（生产面零 void consume）", () => {
    for (const module of [
      "runtime/treasury/attemptIssuanceHandoff.ts",
      "runtime/treasury/facade.ts",
    ]) {
      const source = readSource(module);
      expect(source).not.toMatch(/void\s+completeTreasuryIssuedTicketHandoff/);
    }
    // consume 原语的唯一合法调用方是 handoff 模块（X 轮守护复验）。
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) continue;
      const source = readFileSync(filePath, "utf8");
      if (source.includes("consumeTreasuryIssuedAttemptTicketForHandoff(")) {
        const normalized = filePath.replace(/\\/g, "/");
        const isAllowed =
          normalized.endsWith("attemptIssuanceHandoff.ts") || // 唯一合法调用方
          normalized.endsWith("attemptIssuanceTicket.ts"); // 定义处
        expect(isAllowed).toBe(true);
      }
    }
  });

  it("XI3：ticket validator 必须调用 canonical current ID 校验；certificate validator 必须校验 canonical current root", () => {
    const ticketSource = readSource("runtime/treasury/attemptIssuanceTicket.ts");
    expect(ticketSource).toContain("verifyTreasuryCurrentIssuedIdCanonical(");
    const certificateSource = readSource("runtime/treasury/chainRetirementCertificate.ts");
    // validateCertificateCanonicalRelations 内的 current root canonical 校验。
    const relationsIndex = certificateSource.indexOf("function validateCertificateCanonicalRelations(");
    expect(relationsIndex).toBeGreaterThan(-1);
    const relationsBody = certificateSource.slice(relationsIndex, relationsIndex + 2400);
    expect(relationsBody).toContain("verifyTreasuryCurrentIssuedIdCanonical(");
    // record 的满载驱逐分支同样复验（不吸收不删除不 canonical 的 root）。
    const evictIndex = certificateSource.indexOf("驱逐候选的防御性 canonical 复验");
    expect(evictIndex).toBeGreaterThan(-1);
  });

  it("XI4：GRA production delete 只有统一 primitive（唯一实现点 + 双索引 + read-back 恢复）", () => {
    const graSource = readSource("runtime/treasury/generationRetirementAuthority.ts");
    expect(graSource).toContain("function releaseGenerationProofDestructive(");
    // `delete runtime.store.entries[key]` 只允许出现在 persist 回滚（2 处）、
    // 统一 primitive（1 处）与 ForTest 命名的 fixture helper（1 处）——共 4 处
    //（test-only helper 以 ForTest 命名 + 生产零调用豁免）。
    const deleteMatches = graSource.match(/delete runtime\.store\.entries\[key\]/g) ?? [];
    expect(deleteMatches.length).toBe(4);
    expect(graSource).toContain("function removeTreasuryGenerationRetirementProofForTest(");
    // 三个入口（releaseOfAttempt / releaseOrphan / evict）不直接 delete——
    // 逐段验证函数体内无 delete 语句。
    for (const fnName of [
      "releaseTreasuryGenerationRetirementProofOfAttempt",
      "releaseOrphanTreasuryGenerationRetirementProofs",
      "evictGenerationProofsSupersededBySummary",
    ]) {
      const fnIndex = graSource.indexOf(`function ${fnName}(`);
      expect(fnIndex).toBeGreaterThan(-1);
      const nextFn = graSource.indexOf("\nfunction ", fnIndex + 1);
      const body = graSource.slice(fnIndex, nextFn === -1 ? undefined : nextFn);
      expect(body).not.toMatch(/delete runtime\.store\.entries/);
    }
    // caller 不得静默忽略 blocked：resolutionStore 消费结构化 hook 结果；
    // compaction 消费 pending 报告。
    const resolutionSource = readSource("runtime/treasury/resolutionStore.ts");
    expect(resolutionSource).toContain("lastGenerationProofReleaseBlockedDetail");
    const summarySource = readSource("runtime/treasury/lineageRetirementSummary.ts");
    expect(summarySource).toContain("releaseOrphanTreasuryGenerationRetirementProofs(record.lineageId)");
    expect(summarySource).toContain("peekTreasuryCompactionOrphanReleasePending");
  });

  it("XI5：query 路径不得调用迁移 writer；migration 只有一个 tick-boundary owner", () => {
    const certificateSource = readSource("runtime/treasury/chainRetirementCertificate.ts");
    // 三个 query 函数体内零 loadRangeRuntime / 零 migrate 调用。
    for (const fnName of [
      "peekTreasuryRetiredRangeHealth",
      "lookupTreasuryRetiredRangeStructured",
      "checkTreasuryAttemptRetiredRange",
    ]) {
      const fnIndex = certificateSource.indexOf(`export function ${fnName}(`);
      expect(fnIndex).toBeGreaterThan(-1);
      const bodyEnd = certificateSource.indexOf("\nexport ", fnIndex + 1);
      const body = certificateSource.slice(fnIndex, bodyEnd === -1 ? undefined : bodyEnd);
      expect(body).not.toContain("loadRangeRuntime()");
      expect(body).not.toContain("migrateLegacyRetiredRangeStore(");
    }
    // migrateLegacyRetiredRangeStore 的调用方全仓只有 coordinator（生产）。
    for (const filePath of listFilesRecursive(SRC_ROOT)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) continue;
      const source = readFileSync(filePath, "utf8");
      if (!source.includes("migrateLegacyRetiredRangeStore(")) continue;
      const normalized = filePath.replace(/\\/g, "/");
      const isAllowed =
        normalized.endsWith("chainRetirementCertificate.ts") || // 定义处
        normalized.endsWith("treasuryLifecycleGcCoordinator.ts"); // 唯一 owner
      expect(isAllowed).toBe(true);
    }
    // coordinator 的 migration 阶段是 runTreasuryLifecycleGcCoordinator 的
    // 前置（先于 ticket GC）。
    const coordinatorSource = readSource("runtime/treasury/treasuryLifecycleGcCoordinator.ts");
    const migrationCall = coordinatorSource.indexOf("runTreasuryRetiredRangeMigrationAtTickBoundary();");
    const expireCall = coordinatorSource.indexOf("expireTreasuryIssuedAttemptTickets();");
    expect(migrationCall).toBeGreaterThan(-1);
    expect(expireCall).toBeGreaterThan(migrationCall);
  });

  it("XI6：legacy/current 容量策略登记在 lifecycle contract（quota 三方一致）", () => {
    const certificateSource = readSource("runtime/treasury/chainRetirementCertificate.ts");
    expect(certificateSource).toContain("export const TREASURY_RETIRED_RANGE_CURRENT_QUOTA = 48");
    expect(certificateSource).toContain("export const TREASURY_RETIRED_RANGE_LEGACY_QUOTA = 16");
    const contractSource = readSource("runtime/treasury/treasuryLifecycleContract.ts");
    expect(contractSource).toContain("TREASURY_RETIRED_RANGE_CURRENT_QUOTA");
    expect(contractSource).toContain("TREASURY_RETIRED_RANGE_LEGACY_QUOTA");
  });

  it("XI7：Defense 生产代码不得引用 ticket / GRA 内部协议（复验）", () => {
    const defenseFiles = listFilesRecursive(SRC_ROOT).filter((filePath) => {
      const relative = filePath.split(/[\\/]/).slice(-2).join("/");
      return !filePath.endsWith(".test.ts") && relative.startsWith("runtime/") &&
        /defense|Defender|focusFire|fallback|tower/i.test(filePath.split(/[\\/]/).pop() ?? "");
    });
    expect(defenseFiles.length).toBeGreaterThan(0);
    for (const filePath of defenseFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/attemptIssuance(Ticket|Handoff)/);
      expect(source).not.toMatch(/generationRetirementAuthority/);
      expect(source).not.toMatch(/releaseTreasuryGenerationRetirementProof/);
    }
  });
});
