# Core Candidate Seal I · 冻结基线与差异分类（K01）

## 身份

| 项 | 值 |
| --- | --- |
| 冻结基线 FREEZE_BASE | 869149dcdd6f2068572354917bf23c52727cf9b6（见 freeze-base.txt；本轮起点核验时远端未前移，工作树干净） |
| 最终验证 HEAD VALIDATION_HEAD | 62d645743ac986b9f405cdfebb055e6d171c1d9b（见 validation-head.txt；全部可执行改动在此之前提交） |
| 提交链 | 869149d → 046e4c0（test：Seal 证据 helper + H18 全轨迹 + 敏感性）→ 09dec15（chore(budget)：锚点滚动）→ 62d6457（docs(openspec)：K 矩阵与勘误） |

## 差异分类（changes-from-freeze.txt 全量，共 7 文件）

| 文件 | 分类 | 说明 |
| --- | --- | --- |
| `src/runtime/treasury/treasuryRemediationIVKernel.test.ts` | 测试（src 内 co-located，被 production-freeze 的 glob 排除规则豁免） | H18 全轨迹化 + Seal 敏感性 2 用例（IVKernel 12→14） |
| `test/mock/treasurySealEvidence.ts` | 测试辅助（test/ 下，非 Jest 收集，不进生产 build） | 轨迹/风险基线/完整性核验/导出 helper |
| `scripts/verify-jest-budget.mjs` | budget 元数据（脚本常量：锚点 commit 与 target 数字；无功能逻辑变更） | requiredBaselineCommit/requiredTarget 滚动 |
| `test/test-suite-budget.json` | budget 元数据 | baseline/target 236-1417 + IVKernel 条目 14 |
| `openspec/.../design.md`、`tasks.md`、`test-migration-map.md` | 文档 | Seal I 段/§14 K 矩阵/§10.6 边界 + 40/10 勘误 |

**无任何生产源码、生产类型、构建配置或依赖变更**——production-freeze
（`git diff --exit-code FREEZE_BASE..HEAD -- src 排除 *.test.ts/*.spec.ts`）
与 config-freeze（package.json / package-lock.json / rollup.config.js /
tsconfig.json / tsconfig.build.json / jest.config.cjs）均 exit=0（见
*.exit-code.txt）。Defense 冻结 7 生产文件（defenseFocusFire.ts、
engagementFallbackRevision.ts、defenderRampartAllocation.ts、
homeDefense.ts、towerControl.ts、physicalRampartOwnership.ts、
src/roles/homeDefender.ts）同样 exit=0（defense-frozen-files.*）。

没有已获准的生产修复例外。本目录核对命令与最终验证模板（final/）中的
同名检查独立运行两次（实施者主树 + reviewer 第二 worktree），结果一致。

## git 身份备注

`git worktree add --detach` 创建的复验工作树中 HEAD 为同 SHA detached，
不影响分支指针；变体 worktree 用后即删（`git worktree remove --force`）。
