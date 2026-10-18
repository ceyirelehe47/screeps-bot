import { readFileSync, readdirSync } from "fs";
import { join } from "path";

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

it("creep 全量枚举只能由 TickContext 建立，cargo 与任务不得另建私有全扫快照", () => {
  const violations = productionFiles(join(__dirname, "..")).filter(path => !path.endsWith("/tickContext.ts"))
    .filter(path => /Object\.(?:values|entries)\(Game\.creeps\)/.test(readFileSync(path, "utf8")));
  expect(violations).toEqual([]);
});

it.each(["runtime/outboundMissionPolicy.ts", "roles/combatBoosts.ts"])("共享边界 %s 不直接解释具体任务 Memory", file => {
  const source = readFileSync(join(__dirname, "..", file), "utf8");
  expect(source).not.toMatch(/Memory\.data|from ["'][^"']*(?:war\/|depositHarvest|powerBankHarvest|colonization)[^"']*["']/);
});

it("独立 Game 对账入口仅由只读影子验证器使用，不回流业务决策", () => {
  const violations = productionFiles(join(__dirname, "..")).filter(path => !path.endsWith("/tickContext.ts") && !path.endsWith("/empireInventoryShadow.ts"))
    .filter(path => /\.readLiveCreepsForAudit\(/.test(readFileSync(path, "utf8")));
  expect(violations).toEqual([]);
});

it("出生执行只分发 owner 生命周期，配置规划使用 revision 索引", () => {
  const mount = readFileSync(join(__dirname, "../mount/mountSpawn.ts"), "utf8");
  expect(mount).not.toMatch(/from ["'][^"']*(?:war\/|depositHarvest|powerBankHarvest|colonization)[^"']*["']/);
  const planner = readFileSync(join(__dirname, "spawnPlanner.ts"), "utf8");
  expect(planner).not.toMatch(/\.list\(|\.readStore\(/);
  expect(planner).toContain(".getReadIndex()");
});

it("显式寻路统一经过 ops 账本，生产调用方不绕过内核使用原生 findPathTo", () => {
  const violations = productionFiles(join(__dirname, "..")).filter(path => !path.endsWith("/pathSearch.ts"))
    .filter(path => /PathFinder\.search\(|\.findPathTo\(/.test(readFileSync(path, "utf8")));
  expect(violations).toEqual([]);
});

it("周期生产任务通过 cadence 入口错峰，禁止恢复裸 Game.time 取模调度", () => {
  const violations = productionFiles(join(__dirname, "..")).filter(path => !path.endsWith("/cadence.ts"))
    .filter(path => /Game\s*\.\s*time\s*%/.test(readFileSync(path, "utf8")));
  expect(violations).toEqual([]);
});


it("矩阵只读布局接口不反向加载规划执行器", () => {
  const source = readFileSync(join(__dirname, "../movement/matrixLayers.ts"), "utf8");
  expect(source).toContain("@/runtime/sourceWorkPosition");
  expect(source).not.toContain("roomPlannerConstruction");
});

it.each([
  "runtime/colonization.ts", "runtime/crossShardColonization.ts", "runtime/colonizationSupport.ts",
  "runtime/rescue.ts", "runtime/remoteMining.ts", "runtime/depositHarvest.ts", "roles/depositHarvester.ts",
  "runtime/powerBankTaskState.ts", "runtime/war/fsm.ts", "runtime/factoryControl.ts",
])("任务状态通过生命周期所有者转移：%s", file => {
  expect(readFileSync(join(__dirname, "..", file), "utf8")).not.toMatch(/\.status\s*=[^=]/);
});


it("中央 GC 仅调度领域 owner，不读取领域数据或改写运行时子树", () => {
  expect(readFileSync(join(__dirname, "memoryCleanup.ts"), "utf8")).not.toMatch(/Memory\.(data|runtime)/);
  expect(readFileSync(join(__dirname, "minerBodyPolicy.ts"), "utf8")).not.toMatch(/\.suicide\(|retireCreep\(/);
});
