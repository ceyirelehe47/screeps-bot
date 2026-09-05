# Core Rewrite IV · Remediation I — 本地验证记录

日期：2026-09-06。起点：远端 `aea70350e5bafab00cb7748937e5e8ae5cbc8576`（IV 最终交付）。
任务书：`treasury-core-rewrite-IV-remediation-I-implementation.md`（四项实现缺口 R1–R4 + 三项验证缺口 V1–V3）。

## 1. 缺口 → 实现 → 测试

| 缺口 | 实现 | 验证 |
| --- | --- | --- |
| R1 调用边界 | `TreasuryCoreWorkRecord.invocationBoundary`（types.ts）；dispatch_start 命令携带 boundaryWorldSequence 与 phase 同次写入（commands.ts dispatchStartCommand）；观察接管 anchor 链 invocation→external→invocationBoundary（commands.ts observationTakesOverEffect + kernel.ts beginTick 预检）；rearm child 从 null 起步；validator 阶段强制（store.ts：dispatching/outcome_unknown ⇒ 非空、invocation/external ⇒ 边界同在、pending 零调用侧事实）；cancel_pending 防御检查 | 基线 R1 反例（真实 adapter 内捕获"结果未写"快照→reset→unknown→executed 对账→观察接管退出）红→绿；E01/E03（D11 真实路径）；E04/E05 |
| R2 记录内公平 | `TreasuryCoreCleanupState.cursor`（types.ts）；advance_cleanup 命令 rotationCursor 参数随成对预算确认命令持久化（commands.ts）；beginTick 消费者遍历从 cursor 旋转 + **预算耗尽 break 前也持久化**（kernel.ts——实现中发现：无此步则失败前缀每 tick 重新占据，R2 等于未修）；validator cursor 非负安全整数；worst 构造器含极值 | 基线 R2 反例红→绿；E06（逐 tick JSON 重载 ≤3 tick）、E07（恢复/变体/回绕）、E08（中断/丢写）、E09（重入）、E10（跨记录混合逐 tick 重载，推导界 40） |
| R3 rearm 拒绝 | facade.ts executeRearm 入口：非空 externalConsumers 结构化拒绝（理由含"不支持"）；非法类型 invalid input；先于 verify/capacity 等高成本处理 | 基线 R3 红→绿；E11（frontier/active/父代不变+capability 复用）；E12（类型+合法对照+child 无义务） |
| R4 认证前置 | kernel.ts 新增只读 preflightDispatchPermit/preflightRearmPermit（WeakSet 真实性/tick/generation/未消费/活跃记录与阶段）；facade.ts executeAuthorizedDispatch 在形状预检后、evaluateRevalidation 前调用；executeRearm 在 contract 验证前调用 | 基线 R4 红→绿；E13（克隆 >fresh 上限：fresh/policy/persisted 零增量+真许可 committed）；E14（过期/已消费/已退出/伪造）；E15（合法阻断+对照） |
| V1 D11 断点失真 | D11 改造为真实 adapter 断点捕获（execute 入口 = 边界已发布效果未发生；效果后 = 结果未写）+ memorySnapshot 指定快照 reset | D11 两用例（快照事实核查：phase/boundary/invocation/external） |
| V2 reset 不装快照 | performTreasuryFullReset 增加 memorySnapshot 参数；入口无条件 `installWholeMemorySnapshot(指定 ?? 当前)` | 基线 V2（引用隔离）红→绿；E16（指定快照严格使用+毒字段不污染）；E17（嵌套引用断言） |
| V3 组合测试名不副实 | D19 逐 tick JSON 重载重建运行时；D23 RETRIED 分支真实化（60 对完整 retry 链） | D19（界内完成+失败保留）；D23（parent/child ID 不同、旧许可回放拒、世界账目一致、reset 接管） |

## 2. 基线证据（§9.1）

`evidence/core-rewrite-iv-remediation-i/baseline/`：
- `baseline-red.log`（sha256 31b01eb0ffae4cebf1b7c00f50dd94427141bb9b63160255251f75103a492c1b）：aea7035 上 5/5 红灯（R1/R2/R3/R4/V2 各一；命令与退出码见文件尾）。
- `baseline-repro.source.patch`（当次源码快照，sha256 见文件头注释对应的 887bf3f8… 版本内容；不可执行拷贝）：修复后 5/5 转绿并转为持续回归 `test/baseline/treasuryRemediationIBaseline.test.ts`（预算内正式测试）。
- R4 基线从真实签发许可取得克隆（`{...permit}` 公开字段相同）；R2 基线为合法 8 义务；R1 基线为真实 dispatch_start+实际调用后的持久快照。

## 3. 负向变体（E20，§8）

`evidence/core-rewrite-iv-remediation-i/negative-variants/`：五变体各自 patch + 目标测试红日志 + 还原后绿日志：

| 变体 | 回退内容 | 目标测试（红→还原绿） |
| --- | --- | --- |
| v1-no-invocation-boundary | dispatch_start 不写边界 | D11"调用边界已发布、adapter 尚未进入" |
| v2-intra-record-prefix | 消费者遍历恒从 0 开始 | E06"每 tick JSON 重载：后 4…" |
| v3-rearm-ignores-new-duties | 删除 rearm externalConsumers 检查 | E11 |
| v4-auth-after-fresh | 删除 dispatch preflight 前置调用 | E13 |
| v5-reset-skips-json-install | reset 跳过 JSON 安装 | E16 |

全部为语义断言失败（非编译/空集合失败）；还原后生产源零残留（工作树 diff 复核）。

## 4. 测试与规模

- 新增：`treasuryRemediationIKernel.test.ts`（13）、`treasuryRemediationIService.test.ts`（11）、`test/baseline/treasuryRemediationIBaseline.test.ts`（5）。
- Treasury 全量：22 suites / 449 tests 全绿（IV 基线 20/425 + 24 新 + 基线回归 5 = 22/449）。
- 全仓：225 suites / 1289 tests 零失败（IV 全仓基线 222/1260 + 29）。
- E10 推导界：每 tick 8 份额=4 成对单位、9 条 closing 轮转、噪声（sweep ≤3 + dispatching 恢复 ≤2 份额）挤占后界=40 tick；实测界内完成（详见测试注释与运行日志）。
- E19 满载实测：64×worst（含 invocationBoundary/cursor 极值）+128×worst ring + 元信息 = 343,817 字符 ≤ 360,000；受控字符集 bytes=chars。

## 5. 最终验证（验证 HEAD = 223e06c95fa922626003c4403aaf3c489c466780）

验证 HEAD = 分支提交链末端（生产 04f22f4 → 测试 ab678e1 → 文档/evidence c18a6bc → budget 223e06c）；预算代码锚点 = c18a6bc（budget 自带全仓重跑 PASSED，追加验证实际 HEAD = 223e06c，见 final/jest-full.exit-code.txt）。

命令模板 = 任务书 §11.2；全部退出码 0（final/*.exit-code.txt），HEAD 前后一致、工作树前后干净（status-before/after 均为空）：

| 步骤 | 结果 |
| --- | --- |
| typecheck（tsc --noEmit） | 0 错误 |
| build（npm run build，仅本地） | 成功；dist/main.js sha256 = 6ee470700f3c9e4a1b3bf7dab7bdcb65b70c94289f1a8f5f77fb61cec095d6cb |
| jest-treasury | 22 suites / 449 tests / 449 passed / 0 failed / 0 pending / 0 todo / 0 runtime-error |
| jest-defense（含 memoryDeclarationBoundaries） | 11 suites / 118 tests / 118 passed / 0 failed |
| jest-full | 225 suites / 1289 tests / 1289 passed / 0 failed / 0 pending / 0 todo / 0 runtime-error |
| git diff --check | 干净 |
| verify-jest-budget.mjs（budget 提交时） | JEST_TEST_BUDGET=PASSED（225/1289，锚点 c18a6bc） |

环境：node/npm 版本见 final/node-version.txt、final/npm-version.txt。

## 6. 支持的断点模型与限制（不扩大）

- 已验证：受控同步生效测试世界的真实路径断点（边界发布前/边界后未进入/效果后结果未写/结果写失败保守恢复/确认丢写/预扣后中断）+ 指定快照完整 reset + 全清 heap/global/模块重建。
- 未验证（保持 IV 声明）：真实 Screeps driver 非原子窗口、效果保留而最新 Memory 回退、任意旧备份回滚、整份 Memory 丢失。真实经济 writer 始终禁用；部署/合并 main 未发生。
- 缺锚点旧记录（aea7035 及更早产生的 dispatching/outcome_unknown 持久数据）在本版本被 validator 明确拒绝（不兼容数据处理，无在线迁移）——按任务书 §4.3 保留基线重现分别验证。
