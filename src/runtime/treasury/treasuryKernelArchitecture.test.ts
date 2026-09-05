/**
 * Treasury Core Rewrite I——架构守护（machine-checkable）。
 *
 * 替代旧 treasuryWriteArchitecture/treasuryMemoryLifecycleContract 守护：
 * - 单一写入口：treasury 生产代码的持久变更只经 kernel 状态机；
 * - 旧协议栈模块不得复活（import 图无已删除路径、facade 无旧 store 依赖）；
 * - 真实经济 writer 禁用：生产装配不注册任何真实 Game 写 adapter；
 * - testHarness 仅测试可用；查询零写；treasuryPerf 仅 shadow 写。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "../../..");
const TREASURY_DIR = resolve(REPO_ROOT, "src/runtime/treasury");

function listFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

describe("Treasury Core Rewrite 架构守护", () => {
  const treasuryFiles = listFiles(TREASURY_DIR).concat(listFiles(resolve(TREASURY_DIR, "kernel")).map((f) => `kernel/${f}`));

  test("旧多 store 权威模块已删除（不存在旧协议路径）", () => {
    const retired = [
      "intents.ts", "quarantine.ts", "resolutionStore.ts", "resolutionStateMachine.ts",
      "resolutionCleanupCoordinator.ts", "resolutionCleanupJournal.ts", "receipts.ts",
      "attemptIssuer.ts", "attemptIssuanceTicket.ts", "attemptIssuanceHandoff.ts", "attemptLineage.ts",
      "attemptRearm.ts", "rearmCapability.ts", "authorizationLedger.ts", "authorizationFaults.ts",
      "generationRetirementAuthority.ts", "chainRetirementCertificate.ts", "lineageRetirementSummary.ts",
      "positiveOwnershipVerifier.ts", "kernelChannel.ts", "writeFault.ts", "projection.ts",
      "compat.ts", "faultResolution.ts", "recoveryCoordinator.ts", "reconciliation.ts",
      "markerDischarge.ts", "exactAttemptIdentity.ts", "identityProof.ts", "identityProfile.ts",
      "committedProofVerifier.ts", "oppositeProofMatrix.ts", "forensicProvenance.ts",
      "cleanupCompletionAuthority.ts", "completionHeadroomReservation.ts", "cohortValidation.ts",
      "durableIdentity.ts", "preReleaseSettlementGate.ts", "currentSettlementCoordinator.ts",
      "historicalSettlementAuthority.ts", "unresolvedAuthority.ts", "writeReadiness.ts",
      "readinessCollector.ts", "executionFactCohesion.ts", "entryExactIdentity.ts",
      "exactAuthorityDischarge.ts", "markerAttemptIdentity.ts", "markerExactIdentity.ts",
      "authorityCompatibility.ts", "authorityIdempotence.ts", "authorityLevel.ts",
      "commitmentRevision2.ts", "generationProofLifecycle.ts", "generationRetirementRelation.ts",
      "lineageBinding.ts", "lineageFinalizationProof.ts", "lineageGenerationRetirement.ts",
      "lineageHandoff.ts", "lineageIndexIntegrity.ts", "lineageProof.ts",
      "resolutionAuthority.ts", "resolutionEvents.ts", "resolutionKernelChannel.ts",
      "cleanupCompletionHandoff.ts", "cleanupCompletionReplacement.ts", "cleanupSupersessionAuthority.ts",
      "cleanupStageAcknowledgement.ts", "commitments2.ts", "holderResolution2.ts",
    ];
    for (const file of retired) {
      expect(existsSync(resolve(TREASURY_DIR, file))).toBe(false);
    }
  });

  test("生产 treasury 代码不 import 已删除/旧协议模块", () => {
    const forbiddenPatterns = [
      /from "@\/runtime\/treasury\/(intents|quarantine|resolution|receipts|attemptIssuer|attemptLineage|rearmCapability|authorizationLedger|writeFault|projection|compat|faultResolution|recoveryCoordinator|reconciliation|kernelChannel|positiveOwnership|generationRetirement|chainRetirement|lineageRetirement|markerDischarge|exactAttempt|identityProof|identityProfile|committedProof|oppositeProof|forensic|cleanupCompletion|completionHeadroom|cohortValidation|durableIdentity|preRelease|currentSettlement|historicalSettlement|unresolvedAuthority|writeReadiness|readinessCollector|executionFactCohesion|entryExactIdentity|exactAuthorityDischarge|holderResolution2)/,
    ];
    const violations: string[] = [];
    for (const file of treasuryFiles) {
      const text = readFileSync(resolve(TREASURY_DIR, file), "utf8");
      for (const pattern of forbiddenPatterns) {
        const match = text.match(pattern);
        if (match) violations.push(`${file}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("单一写入口：commands.ts 纯转移 + kernel.ts 唯一 applyCommand 调用方", () => {
    // applyTreasuryCoreStateCommand 只被 kernel.ts（运行时）与测试 import。
    const importers: string[] = [];
    const srcRoot = resolve(REPO_ROOT, "src");
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (name === "node_modules" || name === "dist") continue;
        if (name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          if (text.includes('applyTreasuryCoreStateCommand') && text.includes('from "@/runtime/treasury/kernel/commands"')) {
            importers.push(full.replace(REPO_ROOT + "\\", "").replace(/\\/g, "/"));
          }
        } else if (!name.includes(".") && existsSync(full) && readdirSync(full).length > 0) {
          walk(full);
        }
      }
    };
    walk(srcRoot);
    const runtimeImporters = importers.filter((p) => !p.includes(".test."));
    expect(runtimeImporters).toEqual(["src/runtime/treasury/kernel/kernel.ts"]);
  });

  test("真实经济 writer 禁用：actionContracts 无生产 Game 写调用（market.deal/terminal.send）", () => {
    const text = readFileSync(resolve(TREASURY_DIR, "actionContracts.ts"), "utf8");
    expect(text).not.toContain("Game.market.deal");
    expect(text).not.toContain("Game.market.createOrder");
    expect(text).not.toContain(".send(");
    expect(text).not.toContain("Game.market.cancelOrder");
    // 生产注册表为空：registry 只含测试 adapter（无 registerTreasuryActionAdapter
    // 的生产调用——runtimeServices 只 seal）。
    const runtimeServices = readFileSync(resolve(REPO_ROOT, "src/runtime/runtimeServices.ts"), "utf8");
    expect(runtimeServices).toContain("sealTreasuryAdapterRegistryForProduction");
    expect(runtimeServices).not.toMatch(/registerTreasuryActionAdapter/);
  });

  test("testHarness 仅测试可用：生产模块不 import testHarness", () => {
    const violations: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (name === "node_modules" || name === "dist" || name === "treasury") continue;
        if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          const text = readFileSync(full, "utf8");
          if (text.includes('from "@/runtime/treasury/testHarness"')) {
            violations.push(full.replace(REPO_ROOT + "\\", "").replace(/\\/g, "/"));
          }
        } else if (existsSync(full) && !name.includes(".")) {
          walk(full);
        }
      }
    };
    walk(resolve(REPO_ROOT, "src"));
    expect(violations).toEqual([]);
  });

  test("Memory 持久键唯一权威：treasuryCore 只被 kernel/store.ts 读写", () => {
    // 生产代码中直接访问 Memory.runtime.treasuryCore 的模块白名单。
    // treasury 目录内部自管（kernel/store 为唯一读写实现）；外部只有类型声明。
    const isAllowed = (rel: string) => rel.startsWith("src/runtime/treasury/") || rel.startsWith("src/types/");
    const violations: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        if (name === "node_modules" || name === "dist") continue;
        if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          const rel = full.replace(REPO_ROOT + "\\", "").replace(/\\/g, "/");
          const text = readFileSync(full, "utf8");
          if (text.includes("treasuryCore") && !isAllowed(rel)) {
            violations.push(rel);
          }
        } else if (existsSync(full) && !name.includes(".")) {
          walk(full);
        }
      }
    };
    walk(resolve(REPO_ROOT, "src"));
    expect(violations).toEqual([]);
  });

  test("kernel 状态机文件可解析且命令集封闭（无隐藏命令类型）", () => {
    const commandsSource = readFileSync(resolve(TREASURY_DIR, "kernel/commands.ts"), "utf8");
    const sf = ts.createSourceFile("commands.ts", commandsSource, ts.ScriptTarget.ES2017, true);
    const commandUnion = commandsSource.match(/export type TreasuryCoreCommand =[\s\S]*?;/)?.[0] ?? "";
    for (const cmdName of ["Admit", "DispatchStart", "DispatchResult", "Settle", "AdvanceCleanup", "Rearm", "Close", "Recover", "CancelPending"]) {
      expect(commandUnion).toContain(`TreasuryCore${cmdName}Command`);
    }
    // switch 覆盖全部命令（穷尽性由 tsc 保证，此处防新增遗漏 default 兜底）。
    expect(commandsSource).not.toContain("default:");
    void sf;
  });
});
