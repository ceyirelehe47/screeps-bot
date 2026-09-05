import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

/**
 * Treasury 承诺索引失效架构约束：
 * - resourceTransferTasks / resourceReservation 的每个导出 mutation 函数
 *   体内必须调用 bumpTreasuryCommitmentRevision（新写入口不得绕过）；
 * - resourceControl 的 syncResourceControlTransferTask（任务字段直接写入的
 *   统一同步点）必须同样通知失效；
 * - 纯读函数不要求（也不禁止）调用。
 */

const REPO_ROOT = resolve(__dirname, "..");

interface FunctionRequirement {
  fileName: string;
  functionName: string;
  kind: "mutation-required" | "sync-point-required" | "migration-required" | "adapter-forward";
}

const MUTATION_FUNCTIONS: FunctionRequirement[] = [
  // resourceTransferTasks.ts：创建/合并/取消/阻塞/解阻/进度/自动回收/清理。
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "createResourceTransferTaskWithOrigin", kind: "mutation-required" },
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "cancelResourceTransferTask", kind: "mutation-required" },
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "markResourceTransferTaskBlocked", kind: "mutation-required" },
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "clearResourceTransferTaskBlocker", kind: "mutation-required" },
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "recordResourceTransferTaskProgress", kind: "mutation-required" },
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "cancelAutomaticTask", kind: "mutation-required" },
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "cleanupResourceTransferTaskStore", kind: "mutation-required" },
  // resourceReservation.ts：typed mutation（第五轮新增，唯一新写入口）。
  { fileName: "src/runtime/resourceReservation.ts", functionName: "reserveProductionResourceForOwner", kind: "mutation-required" },
  { fileName: "src/runtime/resourceReservation.ts", functionName: "releaseProductionReservationForOwner", kind: "mutation-required" },
  { fileName: "src/runtime/resourceReservation.ts", functionName: "renewProductionReservationForOwner", kind: "mutation-required" },
  // 旧字符串入口：deprecated 兼容 adapter（第七轮起必须转发 typed mutation——
  // 与 ForOwner 同一实现（schema gate + 单次 bump），不得自行 bump 二次）。
  { fileName: "src/runtime/resourceReservation.ts", functionName: "reserveProductionResource", kind: "adapter-forward" },
  { fileName: "src/runtime/resourceReservation.ts", functionName: "releaseProductionReservation", kind: "adapter-forward" },
  { fileName: "src/runtime/resourceReservation.ts", functionName: "renewProductionReservation", kind: "adapter-forward" },
  { fileName: "src/runtime/resourceReservation.ts", functionName: "gcProductionReservations", kind: "mutation-required" },
  // 裸 holderId → typed owner 的版本化迁移（改写权威数据后必须通知失效）。
  { fileName: "src/runtime/resourceReservation.ts", functionName: "migrateResourceReservationsForTypedOwner", kind: "mutation-required" },
  // resourceControl.ts：任务字段直接写入后的统一同步点。
  { fileName: "src/runtime/resourceControl.ts", functionName: "syncResourceControlTransferTask", kind: "sync-point-required" },
  // resourceTransferTasks.ts：legacy schema 迁移改写任务权威数据（一次性，
  // 但同样必须通知失效——迁移后索引不得继续用旧 origin/lastError 聚合）。
  { fileName: "src/runtime/logistics/resourceTransferTasks.ts", functionName: "migrateResourceTransferTasksToV2", kind: "migration-required" },
];

function extractFunctionBody(sourceText: string, functionName: string): string | null {
  const sourceFile = ts.createSourceFile("probe.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.body &&
        // 顶层函数（避免同名内嵌误判）。
      node.parent === sourceFile
    ) {
      body = node.body.getText(sourceFile);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body;
}

describe("Treasury commitment invalidation boundaries", () => {
  test("every authoritative task/reservation mutation notifies the commitment revision", () => {
    const violations: string[] = [];
    const fileBodies = new Map<string, Map<string, string | null>>();

    for (const requirement of MUTATION_FUNCTIONS) {
      if (!fileBodies.has(requirement.fileName)) {
        const absolutePath = resolve(REPO_ROOT, requirement.fileName);
        const sourceText = readFileSync(absolutePath, "utf8");
        const bodies = new Map<string, string | null>();
        for (const candidate of MUTATION_FUNCTIONS.filter((entry) => entry.fileName === requirement.fileName)) {
          if (!bodies.has(candidate.functionName)) {
            bodies.set(candidate.functionName, extractFunctionBody(sourceText, candidate.functionName));
          }
        }
        fileBodies.set(requirement.fileName, bodies);
      }
      const bodies = fileBodies.get(requirement.fileName)!;
      const body = bodies.get(requirement.functionName);
      if (body === null) {
        violations.push(`${requirement.fileName}: 找不到顶层函数 ${requirement.functionName}`);
        continue;
      }
      if (requirement.kind === "adapter-forward") {
        // deprecated adapter 必须转发 typed 入口（preflight gate + 单次 bump
        // 都在 ForOwner 内）——不得自行 bump（第七轮修复双重 bump 缺陷）。
        const forwarded =
          body.includes("reserveProductionResourceForOwner(") ||
          body.includes("releaseProductionReservationForOwner(") ||
          body.includes("renewProductionReservationForOwner(");
        if (!forwarded || body.includes("bumpTreasuryCommitmentRevision")) {
          violations.push(
            `${requirement.fileName}: ${requirement.functionName} 必须转发 typed mutation（单次 bump 在 ForOwner 内；adapter 不得自行 bump）`,
          );
        }
        continue;
      }
      if (!body.includes("bumpTreasuryCommitmentRevision")) {
        violations.push(
          `${requirement.fileName}: ${requirement.functionName} 是承诺权威 mutation/同步点，必须调用 bumpTreasuryCommitmentRevision`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("cleanup/gc 变体函数为条件失效（有实际删除才 bump）也满足约束", () => {
    // cleanupResourceTransferTaskStore / gcProductionReservations 可能只在
    // 实际删除时 bump——只要函数体内包含调用点即可（上面的主测试已覆盖），
    // 这里补充断言：bump 调用不得被完全移除（防回归）。
    const tasksSource = readFileSync(resolve(REPO_ROOT, "src/runtime/logistics/resourceTransferTasks.ts"), "utf8");
    const reservationSource = readFileSync(resolve(REPO_ROOT, "src/runtime/resourceReservation.ts"), "utf8");
    const resourceControlSource = readFileSync(resolve(REPO_ROOT, "src/runtime/resourceControl.ts"), "utf8");
    expect(tasksSource).toContain("bumpTreasuryCommitmentRevision");
    expect(reservationSource).toContain("bumpTreasuryCommitmentRevision");
    expect(resourceControlSource).toContain("bumpTreasuryCommitmentRevision");
  });
});
