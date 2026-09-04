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
