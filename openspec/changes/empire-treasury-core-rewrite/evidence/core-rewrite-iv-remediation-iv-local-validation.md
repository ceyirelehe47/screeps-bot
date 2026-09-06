# Empire Treasury — Core Rewrite IV · Remediation IV 本地验证报告

**任务身份**：Empire Treasury — Core Rewrite IV · Remediation IV：双入口推进互斥、许可直连执行与断点事件来源封闭（验收索引 H01–H20；任务书 `treasury-core-rewrite-IV-remediation-IV-implementation.md`）。

**状态**：本地验证完成。**不是部署许可**；内核候选版仍待独立审查。

## 1. 起点与提交链

| 项 | 值 |
| --- | --- |
| 实际起点 | `44593c8cc759ecc560ff40b4542716f0d24300e1`（与任务书一致；分支 `refactor/empire-treasury-rearchitecture`） |
| R1/V1/V2 生产与工具修复 | `21c705b` |
| H 矩阵与 28 调用点迁移 | `a563a39` |
| openspec 四份 + baseline/negative-variants 证据 | `dca0b6d` |
| budget 锚点（233/1385） | `2080d34` |
| evidence 基线副本改名（非 .test.ts 后缀） | `0f955cf` |
| 最终验证 HEAD | `8d77d7d8de8feb8d2558cbb2161ed2678742de2c` |

无 reset/rebase/force push/amend 已推送提交/合并 main；锁文件与依赖版本未动；未部署、未调用任何真实经济 writer、未接触真实玩家 Memory 或凭证；Defense 冻结文件零 diff。

## 2. R1/V1/V2/V3 逐项状态

### R1（生产）：独立 endTick 推进所有权与预算不回退 — 完成

- 基线反例（44593c8 worktree 实测，`baseline/baseline-replicators.log`）：独立 endTick 的 onEffect 回调重入 beginTick 实际获得推进权——嵌套 `cleaned:3`、预算轨迹 `1→7→1`（尾写把持久 7 覆盖回 1）、同 tick 再 beginTick 累计释放 6 次 > 4 上限、C 剩余义务 2。
- 修复（`kernel.ts` endTick）：运行恢复循环前取得模块级 guard（与 beginTick 同一推进域）；嵌套 endTick 只写 `lastEndTick` 关窗事实（不递归恢复、不覆盖 recovery）；尾部预算写回 `max(used, 持久现读)`、游标写持久现读值。
- 修复后轨迹（`src/runtime/treasury/treasuryR4BaselineReplicators.test.ts` R1-TRACE）：`[嵌套后 1, endTick 后 1, beginTick 后 7]`、释放 3 次（D0/D1/D2）、C 剩余 5 项义务、下一 tick 继续（H01 断言预算 8/累计 7 次释放）。

### V1（测试工具）：许可直连执行包装 — 完成

- 基线反例：`journal.runWithInvocation(b, args, () => execute(a.dispatch))`（同参数、声明 B、实际提交 A）——`visibleFor(A)=[]`，事件被错记到 B。
- 修复（`treasuryExactOracle.ts`）：删除公共 `runWithInvocation`；新增 `executeTreasuryAdmittedDispatch(journal, service, admitted)`——核对聚合 attempt 与实际 dispatch 许可一致（错配在执行前、作用域建立前拒绝），作用域身份与预期参数均取自该许可对象（`permit.attemptId`/`permit.canonicalArgs`），由包装器自身调用生产执行入口。低层 `runWithPermitScope` 仅模块内部实现。28 个旧调用点全部迁移（III/IIService/IService）；G14 重组（错配→错误配对拒绝、嵌套→真实 adapter 嵌套、异常→内层错误配对 throw 冒泡）。
- 同参数错身份在结构上不可表达；负向对照保留可运行测试（H08/H10 + 变体探针）。

### V2（测试工具）：断点事件来源封闭 — 完成

- 基线反例：捕获器收 `J2.captureBranch()`、adapter 实际用 J1——恢复入口不拒绝；世界已恢复 1000 时可据 J1 旧分支效果误判 committed。
- 修复：`TreasuryJournalBranchMarker` 携带 `source`（捕获来源 journal）、oracle adapter 暴露 `journal`；`performTreasuryFullReset` 在 `resetRuntimeCore` 之前核实来源关联——缺失（旧形态 marker/裸 adapter）或错配（同世界序不同 journal）在对账前、任何状态修改前拒绝（不留半恢复状态：世界/J1 事件均未被触碰，`negative-variants/v2-*.red.log` 及 H12 断言）。journal entry 逐条冻结（查询返回对象写入不穿透，H14）。

### V3（验收补齐）：完全同参数父子与结果写回前断点 — 完成

- 旧 G15 不等价原因：父 `outcome:"non-ok"`/child `outcome:"ok"` 使完整 args 不同（outcome 是 args 字段），且全程无捕获/恢复断点——已改名"普通 rearm 回归"保留。
- 新组合（H15）：宿主结果计划 `results:["non-ok","ok"]`（args 不带 outcome 差异）——父子共用同一份 args（`JSON.stringify(canonicalArgs)` 全等断言）、父 not_executed→清理→retry_ready→真实 capability→rearm 新 child ID→child 真实效果后**结果写入前**断点（`afterWorldEffect` 捕获：world-effect 已入分支日志、dispatch_result 未写）→完整 reset→child unknown→settle exact committed→下一 tick 观察接管退出 active。世界恰一笔变化（950）；父 entered=1/effect=0、child entered=1/effect=1；快照无人工补 evidence（捕获自真实状态）。
- 负向（H16）：child 执行前断点恢复→pending（无事件不解除）；父/子事件独立；旧父/child 许可重放 rejected（零调用）；正确来源恢复后 committed 完整退出。

## 3. H01–H20 状态

全部交付；真实入口/前提/断言定位见 `../test-migration-map.md` §11 表（每项含具体文件与用例名）。要点：

- H01/H02/H03：三份互斥轨迹 + 四方向嵌套零推进 + 多 dispatching 事件一一对应；均带"非零正常释放对照"（H01 下一 tick 预算 8/累计 7 次；H02 顺序 beginTick 处理 C；H03 顺序 beginTick 清 3 项）。
- H04/H05/H06：异常路径 guard 释放/成功写保留；推进中关窗生效且 facade 业务阻断（回调内+外层返回后+同 tick 再 begin 后三段断言，下一 tick 新窗口接纳成功）；interceptor 故障注入四场景 + G07 模式硬切点（`callsAtBreakpoint=0`）完整 reset。
- H07：G01–G08 核心行为抽查（错误真值/单步确认/每 tick 恰一次/失败责任保留）；完整矩阵仍由既有 G01–G08 承担。
- H08–H17：见 §2 V1/V2/V3 与迁移表。
- H18：64 active 满载（30 closing 含义务 + 20 unknown + 10 retry_ready + 4 pending）字符 ≤360,000（`treasuryCoreSerializedChars` 实测断言）、12 tick 每 tick 完整 reset+beginTick、每 tick 释放 ≤4、20 条 unknown 全保留、失败义务不被删除。
- H19：最终验证（§4）。
- H20：三件负向变体（§5）。

## 4. 最终验证（固定 HEAD `8d77d7d`）

| 项 | 结果 |
| --- | --- |
| typecheck / build | 0 / 0（bundle sha256 `f1543c228eaa4e70aa78195b44b9458e3a0276f9d517691909377d683cb4d516`） |
| Treasury 目录 | 29 suites / 539 tests 全过 |
| Defense 冻结集合 | 11 suites / 118 tests 全过 |
| 全仓 | 233 suites / 1385 tests 全过（failed/pending/todo/runtime error 均 0；含 test/baseline/ 2 suites/11 tests） |
| budget | `JEST_TEST_BUDGET=PASSED`（233/1385；锚点 `0f955cf`；manifest 文件集=仓库测试文件集=锚点文件集三方一致） |
| git diff --check / 工作树 | 干净；validation-head == head-after |
| CI | 仓库无独立 CI——以上为 Agent 本地验证（如实记录，空 checks 不作为 PASS 依据） |

原始日志/JSON/命令/退出码在 `final/`（32 个文件）。

## 5. 负向变体（H20）

| 变体 | 红灯 | 还原 |
| --- | --- | --- |
| R1 endTick 漏锁（`r1-endtick-no-ownership.patch`） | H01 红（嵌套实际推进/预算回退/释放超限） | H01 绿 |
| V1 声明身份分离（`v1-declared-identity-split.patch`） | H08 红（错配不再被拒）+ 事件归属探针红（`visibleFor(A)=[]`——事件归声明 B，`*.attribution-red.log`） | H08 绿 |
| V2 删来源核实（`v2-no-source-verification.patch`） | H12 红（错 journal 断点恢复被放行） | H12 绿 |

三变体均为可运行 Jest 用例的行为红灯（非编译错误）；还原经 `git checkout --`（修复已先提交）。

## 6. 实测数字与口径

- **逻辑份额/实际外部释放**（受控测试世界，非真实 CPU 时间）：H01 fixture 每 tick 份额 8、外部释放 ≤4——修复后实际轨迹 `endTick 1 + beginTick 6 = 7 份额 / 3 释放`、下一 tick `8 份额 / 4 释放`；H18 每 tick 释放 ≤4（12 tick 实测）。
- **满载表示**：64 active 下 `treasuryCoreSerializedChars` ≤360,000（断言通过；逐字符数值未单独采样）。
- **本轮组合规模**：H15/H16 同参数父子闭环为单父单 child + 一次完整 reset 恢复；H18 为 64 记录 × 12 tick。此前轮次的 10,000 完成/1,000 retry 压力是旧规模数据，未在本轮重跑、不冒充本轮结果。
- **物理写入尝试/成功次数、扫描数、最长服务等待**：本轮未逐项采集（测试断言口径为行为轨迹与份额上限）。此三项明确列为未采集，不做推测。

## 7. 支持模型与限制

- 支持范围仍为受控同步生效测试世界及选定断点状态保留后的全运行时重建；真实 driver 非原子窗口、任意旧备份回滚、整份 Memory 丢失、未支持异步效果不在范围；writer 继续关闭（生产 facade 仍不装配 releaseExternalConsumer——接纳侧拒绝非空 externalConsumers，无"产生义务无人清理"路径）。
- 模块级推进 guard 经 jest.resetModules 丢失属预期（运行时协调非持久权威）；同模块多实例共享（H02 用 reset 后 require 的同模块实例验证——顶层 import 是另一模块副本，不算同模块实例）。
- 测试分支恢复不是生产世界回滚能力；宿主结果计划只控制测试执行结果，不向 reconciler 提供结论。

## 8. 未完成项

- 独立审查（下一轮安排）；内核候选版不自动升级为部署许可。
- 生产 releaseExternalConsumer 端口接线、Core Rewrite V 均未启动（按任务书范围边界）。
