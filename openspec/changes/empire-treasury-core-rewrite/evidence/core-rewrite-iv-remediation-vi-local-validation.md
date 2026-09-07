# Empire Treasury — Core Rewrite IV · Remediation VI 本地验证报告

**任务身份**：Core Rewrite IV · Remediation VI（持久关窗统一门禁与健康满载恢复验收，验收索引 J01–J08）。编制日期 2026-09-07。本文是 Agent 本地验证交付物，不构成部署许可。

## 1. 身份与提交链

| 项目 | 值 |
| --- | --- |
| 起点（编制时远端 HEAD，实测一致） | `4ba065a5d0a2e7306406ae855c06be756f3136e7` |
| R1 生产修复 | `335b06d`（kernel.ts + facade.ts） |
| V1 测试修复 + J 矩阵 | `b8fc019`（H18 重写 + treasuryRemediationVIKernel.test.ts 新建） |
| budget 锚点 | `b8fc019ab34d8854003d918c4c6a8343422124b3`（236/1415；budget 提交 `c1f61ba`） |
| 最终验证 HEAD | `2e15fe375a3be9c4c829d4984ba9528e13877191`（= docs/证据提交；验证时工作树 clean） |
| dist/main.js SHA-256 | `2cee7a92b3f7f473eb63e00db26a1633e481f8cd5a74bd7c237670b604da5ae4`（上轮 fcc5382d…仅供追溯，非本轮产物） |
| 证据目录 | `evidence/core-rewrite-iv-remediation-vi/{baseline,final,negative-variants}` |

提交链（线性，无 rebase/force/amend）：`4ba065a → 335b06d → b8fc019 → c1f61ba → 2e15fe3 →（验收结论补交）`。

## 2. R1：kernel 读取同 tick 的持久关窗

### 基线反例（真实运行，evidence/baseline）

干净 worktree（4ba065a）上以"断言修复后语义"的重现器运行（exit 1，主反例红、两对照绿），TRACES 给出缺陷实际形态：

- tick T=2 成功关窗（`closurePersisted=true`、持久 `lastEndTick=2`）→ 同 tick 完整 reset（memorySnapshot、runBeginTick:false、模块重建）→ `heapVetoActive=false`（heap 否决丢失）、`lastEndTick=2`（持久仍在）。
- **`post-reset-admit={status:"admitted", frontierDelta:1, activeDelta:1}`**——持久关窗下新 kernel 直接接纳。
- **`post-reset-dispatch={status:"not_executed", adapterCalls:1}`**——错误签发的新许可执行并进入 adapter。
- **`post-reset-execute-rearm={status:"admitted"}`**——rearm 通道同样漏（child 替换父代）。

缺口定位与任务书 §2.1 一致：`admissionVetoActive()` 只查模块级 heap 事实；持久 `lastEndTick` 只有 facade 读取。

### 最小修复（335b06d）

- kernel 新增 **admissionGateStatus** 共享只读判定：健康持久核心 `lifecycle.lastEndTick === 当前 tick`（持久先查）或 heap 否决（兜底）任一成立即关闭；**原因文本区分来源**（"endTick 后不得接纳/执行/rearm"持久口径 vs "运行时否决标记生效（持久发布待确认或失败）"heap 口径），不互相冒充。
- admit/executeDispatch/executeRearm 三入口改用共享门禁（closed 不进 `requireWritableHealth`；blocked/rejected 不消费许可、不替换父代、frontier/active 增量 0）。
- facade `admissionWindowOpen` 改为消费 `kernel.admissionGateStatus()`——两侧判定顺序与文案统一，不再各自维护双口径实现。
- `admissionVetoActive` 保持 heap-only 语义（接口文档明示"仅表示 heap"）。查询纯读零写（J03 实测 unhealthy/坏 ring 下 Memory 逐字节不变）；非健康核心退化 heap 单口径，原 `store_unhealthy`/`incompatible` 拒绝不退化；坏 ring（ringDegraded）不阻断持久关窗判定；下一 tick 无闩锁；same-tick beginTick 不重开窗口（J03/J04/I05 回归）。

治愈复验：同一重现器在修复后主仓全绿（`baseline-healed-on-fix.log`：`post-reset-admit={status:"rejected", reasonCode:"lifecycle_closed", frontierDelta:0, activeDelta:0}`、rearm rejected、父代保持 retry_ready）。

## 3. V1：H18 从"不健康空转"改为有效的满载恢复验收

### 基线反例（真实运行，evidence/baseline）

旧 H18 fixture（closing 有确定 outcome 但 `outcomeEvidence=null`、retry_ready/pending 的 `outcome=null`）被生产 validator 判 **unhealthy**（"active[tk1_h18_00] 阶段 closing 但结果未确定或无证据（结构矛盾）"）→ 生命周期静默早退：**12 tick 释放 [0×12]、total 0、四阶段数量零变化**——旧断言（释放 ≤4、unknown 计数=20、失败义务在）在零推进下空转成立。这是对测试缺陷的红灯（未放宽 validator）。

### 修复（b8fc019：H18 整体重写，规模构成不变）

- **J05**：`buildH18MixedLoad` 工厂构造 64 条合法混合（30 closing×3 义务、committed/not_executed 混排 + C0:D0 持续失败义务 / 20 unknown 有调用边界 / 10 retry_ready exact not-executed 且义务空、期限 T+40 / 4 pending 无任何调用侧事实）——生产 validator 判 healthy；构成/证据结论一致/发行 65/ring 0/chars 57,976 ≤360,000 逐项断言。
- **J06**：12 tick 观察段每 tick `JSON.stringify → performTreasuryKernelFullReset → 新 store 模块 healthy 前置 → beginTick → healthy 后置`；逐 tick 份额 ≤8、释放 ≤4、20 unknown 按 ID 保留、pending 2 tick 内安全取消（active 60/ring 4）、h18HasProgress 真、可完成 closing 真实完成（committed 退出/not_executed 转 retry_ready）、成功义务恰好调用一次、失败义务在且 C1+ 健康项被服务（不饿死）。**有界收尾**：上界推导写明（89 可完成义务 ×2 份 + 30 退出/转化 + 失败重试 2 份/tick，每 tick ≤8 份 ⇒ 26 tick + 调度余量 = 40 上界），实测 13 tick 完成剩余义务与 closing 收尾；**失败恢复**：宿主恢复端口后 1 tick C0 完成清理并退出；**安全退出**：剩余 retry_ready 经 `closeWork({reason:"abandoned"})` 正常业务放弃；**终态**：active=20 且 ID 集合精确等于 unknownIds、ring 44 ≤128、chars 21,879。H18-TRACE 实测入 final。
- **零推进负向对照**：healthy fixture 下推进为零时（完整 reset 但不调 beginTick），进度判别函数判 false、remaining/阶段/active 零变化——J06 进度断言可判别，上限与 unknown 保留断言单独绿不构成通过。
- 旧 H18 空转用例整体替换，不再保留宣称通过；上轮 Remediation V 报告中的 H18 空转记载保留为历史，本轮 tasks.md 观察项关闭、test-migration-map §13.1 如实纠正覆盖口径（I06 此前只测 facade authorize——kernel 直接入口由 J01/J02 补齐）。

## 4. J01–J08 状态

| 编号 | 状态 | 证据 |
| --- | --- | --- |
| J01 | PASS | VIKernel 主用例（admit/executeRearm/facade 三通道 lifecycle_closed、增量 0）+ 未关窗/下一 tick 两对照绿；基线 admit/dispatch/rearm 三通道错误放行 TRACES（baseline）；不以旧许可失效代替 |
| J02 | PASS | VIKernel 门禁隔离用例：真 P/R（preflight valid 前置）→ 真实 endTick → 仅 `resetTreasuryCoreLifecycleFactsForTest` 清 heap → executeDispatch blocked（动作增量 0、P 仍 pending）、executeRearm rejected（父代未替换、child 0、frontier 不变）；许可未消费经 preflight valid 直接验证；未关窗对照成功 |
| J03 | PASS | VIKernel 三用例：仅 heap 原因文本不冒充持久成功 + 下一 tick 失效；unhealthy 拒绝不退化 + 门禁查询零写（Memory JSON 逐字节相等）；坏 ring 不阻断持久判定 + 恢复清理入口继续 |
| J04 | PASS | VIKernel：关窗 tick 内 beginTick 清理推进（cleaned>0、义务减少）、cancelPending/closeWork ok、release 非零；下一 tick 完整 reset 新 admit+dispatch 成功 |
| J05 | PASS | IVKernel 新 H18 第 1 用例（validator healthy + 构成/证据/发行/期限逐项） |
| J06 | PASS | IVKernel 新 H18 第 2 用例（12 tick 观察 + 13 tick 有界收尾 + 1 tick 失败恢复 + closeWork 退出 + 终态 20 unknown 精确集合）+ 零推进负向对照第 3 用例 |
| J07 | PASS | 两负向变体（patch 入 negative-variants）：仅 heap 门禁 → J01/J02 主用例 + J03 持久判定 3 红（行为断言非编译错）；零推进 → J06 红 + H 系列 8 进度用例红、J05/零推进对照绿（判别准确）；还原后 21/21 绿。zero-advance 首版提前 return 因不可编译弃用（编译友好版：份额视为已尽） |
| J08 | PASS | 见 §5 最终验证 |

## 5. 最终验证（固定 HEAD 2e15fe3）

| 项 | 结果 |
| --- | --- |
| typecheck（tsc --noEmit） | exit 0 |
| build（npm run build，仅本地构建无部署目标） | exit 0；dist/main.js sha256 `2cee7a92…da5ae4` |
| Treasury 定向 | 32 suites / 569 tests 全过（含 IVKernel 12[新 H18×3]、VIKernel 9[J01–J04]、VKernel 11、VService 8） |
| Defense 冻结集合（11 文件） | 11 suites / 118 tests 全过；冻结生产文件零 diff |
| 全仓 jest | 236 suites / 1415 tests 全过；failed/pending/todo/runtime errors = 0 |
| budget | `JEST_TEST_BUDGET=PASSED`（manifest 236/1415，锚点 b8fc019；自带全仓重跑另存 final/budget.log） |
| git diff --check（工作树口径） | exit 0；验证前后 status clean、HEAD 未移动 |

I13 成本 fixture 随 VKernel 在最终验证中真实重跑（final/i13-cost-excerpt.txt）：空 endTick 7 读/1 写；恢复 A+清理 8C tick1 41 读/7 写/7 份额/2 释放、完成 2 tick 逐 tick 释放 [4,2]、total 8；关窗发布失败 2 次尝试/0 放行；64 活跃混合推进 53 读/10 写/8 份额（recovered 2 + cleaned 6 + 关窗确认）。Node 耗时不是 Screeps CPU 保证。本轮满载 reset 规模（64 记录×12+13+1 tick 完整重载）与既有大规模压力（10,000 完成/1,000 retry 等，随全仓 236/1415 真实重跑）分开报告。

## 6. 支持模型与未完成项

- 支持模型不变：受控同步效果世界、选定持久状态保留后的完整运行时重建。本轮不证明真实 driver 非原子窗口、任意旧备份回滚或整份 Memory 丢失；不声称数据库式 exactly-once。
- 无新永久事实、无新协议、无真实 writer 接线；Defense 生产行为冻结（零 diff）。不部署、不合并 main；未 reset/rebase/force/amend 已推送历史；依赖与 lockfile 未动。
- CI：无独立 CI——以上全部为 Agent 本地验证（node/npm 版本见 final）；空 checks 不构成通过。
- 未完成项：无本轮范围内的未完成目标。上轮低危 CONCERN 待办（VKernel I02 冗余写法清理、evidence 归档策略统一）仍留在 tasks.md 下轮待办——涉可执行文件须随下轮验证，本轮未动。
