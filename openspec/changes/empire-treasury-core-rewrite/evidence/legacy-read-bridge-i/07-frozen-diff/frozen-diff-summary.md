# 冻结差异验收（相对 06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c → 7ceabba9f2f100b28a34a94e624968452516a8ea）

A	docs/treasury-compat-source-manifest.json
A	docs/treasury-legacy-read-bridge.md
M	scripts/verify-jest-budget.mjs
M	src/main.test.ts
M	src/main.ts
A	src/runtime/treasuryCompatConfig.ts
A	src/runtime/treasuryCompatRead.ts
A	src/runtime/treasuryCompatReadCore.generated.ts
A	src/runtime/treasuryCompatRuntime.ts
A	src/runtime/treasuryCompatTypes.ts
M	test/test-suite-budget.json
A	test/treasury-compat/bridge.spec.cjs
A	test/treasury-compat/helpers.cjs
A	test/treasury-compat/independent.spec.cjs
A	test/treasury-compat/real-readers.spec.cjs
A	test/treasuryCompatIndependent.test.ts
A	test/treasuryCompatRead.test.ts

## 关键路径字节不变（27/27）
```
src/runtime/resourceControl.ts / resourceReservation.ts / runtimeServices.ts / memoryCleanup.ts
src/types/memory/runtime.d.ts / package.json / package-lock.json / rollup.config.js
tsconfig.json / tsconfig.build.json / scripts/lib/deployGuard.cjs
src/runtime 全部 Defense 文件、src/runtime/logistics 全部执行层文件
```
核对方式：两侧 rev-parse blob 全等（脚本实测 27/27，见主报告）。

## main.ts 精确 diff（仅 2 行新增）
```diff
+import { runTreasuryCompatRead } from "@/runtime/treasuryCompatRuntime";
 
 mountAll();
 registerGlobalApi();
@@ -106,6 +107,7 @@ function gameLoop(): void {
   // 库存影子等价验证（Phase 1 只读观察者）：低频对账新索引与直读 Store，
   // 不参与任何生产决策；详见 empireInventoryShadow.ts。
   cpuProfiler.measure("empireInventoryShadow", runEmpireInventoryShadowCheck);
+  cpuProfiler.measure("treasuryCompatRead", runTreasuryCompatRead);
   cpuProfiler.flush();
 }
 
```

## main.test.ts（38→39）
+    ["treasuryCompatRead", "runTreasuryCompatRead"],
-    expect(order).toHaveLength(38);
+    expect(order).toHaveLength(39);
