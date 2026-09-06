# Core Rewrite IV · Remediation III — Agent 本地验证报告

任务身份：Remediation III（当前义务单步清理、严格成功确认与断点／attempt 事件隔离）。
编制日期：2026-09-06。本报告是 **Agent 本地验证记录，不是独立审查放行**。

## 1. 起点与交付

| 项 | 值 |
| --- | --- |
| 预期起点（任务书） | `3f4e701a6203159183067288c830f88b710d6339` |
| 实际起点（fetch 后本地 = 远端） | `3f4e701a6203159183067288c830f88b710d6339`（无前移） |
| 生产/测试修复提交 | `b7cb554`（R1/R2 kernel+commands、V1/V2 oracle+harness、G 矩阵、基线证据） |
| 测试修订提交 | `1e918ac`（G03 矩阵逐 tick 全注入 + G20 负向变体） |
| 文档提交 | `78258f4`（design §8 / tasks / test-migration-map §10 / authority-retirement-map） |
| 预算锚点提交（= 最终验证 HEAD） | `fd5f0f5`（230/1360，manifest 基线 `78258f4`） |
| 基线反例 worktree | `baseline-r3-3f4e701`（HEAD=3f4e701，node_modules junction 复用主仓） |

## 2. 基线反例（四项真实红灯，evidence/core-rewrite-iv-remediation-iii/baseline/）

命令：`npx jest --config jest.config.cjs --runInBand --runTestsByPath r1/r2/v1/v2-baseline-replicator.test.ts`（干净基线 worktree），退出码 **1**。日志 `baseline-replicators.log`；源码（非收集后缀 `.ts`）与 SHA-256 见 `baseline-sha256.txt`。

| 目标 | 基线实测轨迹（console 证据） | 修复后 |
| --- | --- | --- |
| R1 同 kernel 重入 | releaseCalls `[D0,D1,D0,D1]`；最终 remaining `[D0]`（D0 成功未落地）；budgetUsed=8；仍 closing | 各恰一次、retry_ready、remaining 空、budgetUsed=4 |
| R2 truthy | `{ok:false}` → phase=retry_ready（义务被误清理） | closing 保留、failures=1；恢复 true 后完成 |
| V1 最近截断 | 恢复 B0（世界 1000）后 outcome=**committed**（借 B1 效果事件） | not_executed（B0 分支事实）；B1 对照 committed |
| V2 参数反查 | visibleFor(A)=[]、visibleFor(B)=[entered,effect]（A 的事件全归 B） | 归 A、B 空 |

## 3. 修复实现

### R1（kernel.ts / commands.ts）

- 模块级 `lifecycleAdvanceInFlight` guard：同调度域（同模块全部实例）唯一推进栈；重入 beginTick 结构化零 stats；endTick 关窗事实（lastEndTick）仍写入、跳过 dispatching 恢复循环；finally 释放；完整 reset 重建模块后丢失（非持久权威）。
- closing 清理逐项单位：每次迭代现读健康记录/remaining/phase/cursor → 按 cursor 选当前成员 → 成对预扣（2 份+下一位置同次发布、独立 expected 读回）→ 端口 → 按单位确认（成功 `[key]`、失败空清单+有界失败计数）→ 确认后重读再选下一项。跨回调旧数组与批末 `released[]` 删除。
- `triedKeys`（≤8）防同访问重复尝试刚失败成员；预扣失败时外层 `budgetShortfall` break——**恢复 IV/D19 防空转饿死**（该缺陷在 D19 测试真实复现：cursor 卡 4、每 tick 重复访问 sticky4-6；修复后有限 tick 完成）。
- `nextServiceCursor`（commands.ts）：单成员确认移除后按记录现值 cursor 反推本次服务位，重定位到同一下一待服务成员；无对应关系保守保留现值。

### R2（kernel.ts）

`returned === true` 严格原始布尔判定；不读对象字段（getter 不触发）、不 await/then、不做 Boolean 强转。throw 归端口异常（catch → false 路径）。

### V1（treasuryExactOracle / treasuryResetHarness）

journal 状态改 `{entries, baseLength, epoch, invocationStack, unlinkedCalls}`；`captureBranch()` 冻结当时可见事件不可变副本并返回 marker（`kind: "treasury-journal-branch"`）；`TreasuryHostBreakpoint.eventBranch` 携带 marker；`resetRuntimeCore` 在安装断点 Memory 后调用 `reopen()`——entries=副本、baseLength=副本长度、epoch+1、调用栈清空。`visibleFor` = 祖先基础（i<baseLength）∪ 本 epoch。可变 `cut`/`registerAttempt`/`startBranch` API 删除。

### V2（treasuryExactOracle）

`runWithInvocation(identity, expectedArgs, fn)` 以真实接纳/rearm 许可身份建立栈式作用域（异常 finally 弹栈）；`execute` 读栈顶并 `stableStringify` 逐次核对参数，匹配才归属；无作用域/不匹配 → `unlinkedCalls` 诊断、不归属任何 attempt。

## 4. G01–G20 矩阵（映射见 test-migration-map §10）

- kernel 层 `treasuryRemediationIIIKernel.test.ts`：G01–G08、G18（16 tests）。
- service/工具层 `treasuryRemediationIIIService.test.ts`：G09–G17（16 tests）。
- G19 由最终验证流程承担（见 §5）；G20 由 negative-variants 承担（见 §6）。

测试过程修订（任务书 §6.1/§7.4 授权的语义修订，均保留原安全要求）：
- **F06 重复切点**：逐项写序列（预扣1、确认1、预扣2…）下第 2 次放行写=单位 1（f0 sticky 失败）的确认写；断言改为份额 2、f0 保留、cursor 停 1、恢复续 f1/f2/f3、closing 保留。
- **F08 重入**：内层被 guard 拒绝（无"内层已发布位置"）；cursor 数值断言（≥4 / ==4）改为下一待服务成员语义（`consumerKeys[cursor % len]`）——旧数值 4 在 [w4..w7] 中指向 w7、跳过 w4。
- **G03 矩阵修订**：13 种返回值必须逐 tick 全注入（每 tick 4 个消费者单位，单 tick 只触达前 4 种 falsy——truthy 对象未被注入时矩阵不构成证明；R2 负向变体验证时发现并修正）。
- IIService/IService 调用点迁移：`registerAttempt/recordCut/startBranch` → `runWithInvocation/captureBranch`（harness reopen 消费）。

## 5. 最终验证（evidence/core-rewrite-iv-remediation-iii/final/）

验证 HEAD：`fd5f0f5`（全部可执行修改先提交；budget manifest 的锚点/计数常量按既有约定随最终提交）。模板执行 `run-validation.sh`（仓库外 .tmp-r3-final，产物拷入 final/）：typecheck、build（rollup）、Treasury 定向、Defense 冻结集合（11 文件）、全仓 --runInBand --json、`dist/main.js` SHA-256、`git diff --check`、head 前后一致、工作树干净。逐项退出码见 `*.exit-code.txt`；数字汇总见 §7。

## 6. 负向变体（G20，evidence/core-rewrite-iv-remediation-iii/negative-variants/）

| 变体 | patch | 目标红灯（exit=1） | 还原（exit=0） |
| --- | --- | --- | --- |
| R1 guard 检查移除 | r1-guard-disabled.patch | G01（D0 重入重复调用） | restored.log |
| R2 truthy 回归 | r2-truthy-regression.patch | G03（truthy 对象误释放） | restored.log |
| V1 不消费断点事件分支 | v1-no-reopen.patch | G09/G10/G11（借 B1 效果等，3 failed） | restored.log |
| V2 忽略参数逐次核对 | v2-skip-args-check.patch | G14（参数不匹配仍归属） | restored.log |

变体取舍记录：R1 首版 `=== 999` 恒假比较因 TS2367 编译错误弃用（编译失败不算行为红灯），改移除 guard 检查行；V2 首版（恢复 argsMap 单值注册表）在新测试形态下无覆盖数据来源（测试不再显式登记 attempt）、不构成行为红，改为删除参数逐次核对（§5.2 同属 V2 目标语义）。

## 7. 实测数字汇总

| 项 | 值 |
| --- | --- |
| Treasury 定向 | 26 suites / 514 tests / 514 passed（含新增 G 矩阵 2 文件 32 tests；原 24/482 全保留） |
| Defense 冻结集合 | 11 suites / 118 tests（见 final/jest-defense.json） |
| 全仓 | 230 suites / 1360 tests / 1360 passed；failed/pending/todo = 0 |
| test/baseline（目录外） | 2 suites / 11 tests（不在 Treasury 计数内） |
| 预算 | verify-jest-budget.mjs PASSED（230/1360；manifest 基线 78258f4） |
| bundle | dist/main.js SHA-256 见 final/bundle-sha256.txt |
| 逻辑份额/释放 | G01 实测 4 份/2 次调用；G02/G18 实测 ≤8/≤4 |
| 事件期望口径 | 独立于生产 outcome/occupancy（oracle 只读受控宿主事件）；未采集项：物理写入字节数（本轮未引入新 store 字段，写次数由成对预扣/确认命令数上界约束） |

## 8. 支持模型与限制

- Agent 本地验证（Windows/Git Bash、Node 22.19.0）；无独立 CI（combined status 与 check runs 查询无权限时如实记录为本地验证）。
- 支持范围仍是受控同步生效测试世界与断点状态保留后的全运行时重建；真实 driver 非原子窗口不在范围内（经济 writer 继续关闭、不部署、不合并 main）。
- `python3` 在本机为 WindowsApps stub（静默 exit 49）——本轮若干 patch 最初经其执行未生效，全部改用 `python` 重做并验证写入；此为环境工程坑记录，不影响仓库产物。
- guard 是模块级运行时协调：不同模块实例（完整 reset 后）天然互不共享；同模块多实例共享同一调度域（G02 实测）。

## 9. 尚未完成

- 独立审查（本轮交付后由独立 Agent 执行——本报告不构成放行）。
- 生产 `releaseExternalConsumer` 端口接线（facade 仍未装配——生产走端口缺失分支；R2 严格判定在测试端口下验证）。
