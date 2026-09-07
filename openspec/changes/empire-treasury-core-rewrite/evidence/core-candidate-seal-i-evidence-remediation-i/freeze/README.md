# freeze/ —— 冻结身份与差异分类（Evidence Remediation I）

| 文件 | 内容 |
| --- | --- |
| freeze-base.txt | 生产冻结基线 869149dcdd6f2068572354917bf23c52727cf9b6 |
| expected-start.txt | 实施起点（编制时远端 HEAD）7c790712315c0cdde75a262e62b7d728b86a5ed8 |
| validation-head.txt | 本轮固定验证 HEAD d9cd60e07f4c4e7559aec14383ee805aea0e2051 |
| changes-from-freeze.txt | 869149d → d9cd60e 完整 name-status 差异清单 |
| changes-scripts-test.txt | scripts/ 与 test/ 差异逐文件分类 |
| production-freeze.* | `git diff --exit-code` 生产源码（排除 *.test.ts/*.spec.ts）→ exit 0 零差异 |
| config-freeze.* | 六配置文件（package.json/package-lock.json/rollup.config.js/tsconfig×2/jest.config.cjs）→ exit 0 |
| defense-freeze.* + defense-prod-files.txt | Defense 七个生产文件（src/runtime 平铺路径）→ exit 0 |

## 差异分类结论

869149d → d9cd60e 的全部差异（changes-from-freeze.txt）分三类，**无任何生产 runtime/类型/状态转移/许可/存储/覆盖判断/oracle 装配差异，无配置差异，无 Defense 差异**：

1. **测试侧可执行（2 文件）**：`src/runtime/treasury/treasuryRemediationIVKernel.test.ts`（IVKernel 14→17）、`test/mock/treasurySealEvidence.ts`（证据 helper；非 .test.ts 不被 Jest 收集，生产不得 import——typescriptConfigBoundaries 守护）。
2. **预算元数据（2 文件，§7 允许）**：`scripts/verify-jest-budget.mjs`（requiredBaselineCommit/requiredTarget 同步 236/1420 与注释头）、`test/test-suite-budget.json`（baseline/target/IVKernel 条目/allocation.note）。
3. **OpenSpec 文档与历史证据（全部 A/M 的 openspec/**）**：Seal I（62d6457/7a2ee36/7c79071 已在起点之前）+ 本轮 6592705（tasks/migration/design 勘误）与 d9cd60e 内 openspec 更新。

scripts/ 与 test/ 的差异全部列入上述 1/2 类（changes-scripts-test.txt），无生产逻辑搬进排除路径制造零 diff 的情况——`src/**`（除测试）与六配置、Defense 七文件三组 `--exit-code=0` 独立证明。
