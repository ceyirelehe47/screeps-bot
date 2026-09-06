# Empire Treasury — Core Rewrite IV · Remediation V 本地验证报告

**状态：Agent 本地验证完成（无独立 CI——空 checks 不是 PASS）。内核候选版仍待独立审查，不自动成为部署许可。**

## 1. 身份与提交链

- 任务书：`treasury-core-rewrite-IV-remediation-V-implementation.md`（先关窗后恢复、缺失来源拒绝与验证证据闭合）
- 起点（审查远端 HEAD）：`fb5e44b43cfd14991a721c5ee8fed4a13c5d4d97`（分支 `refactor/empire-treasury-rearchitecture`，与远端一致、工作树干净）
- **最终验证 HEAD：`7e977660d9dd1ab74a6c8799307a7b4cc9a01a8b`**；budget 锚点 `e65257dd1f2e848d527682ef7e066920b226644e`；dist/main.js sha256 `fcc5382db4e91eb90c04cb8c524d44bbae641a27315771ca53a765d4660f9832`

| 提交 | 职责 |
| --- | --- |
| a1aaa7a | 前置卫生：5 文件历史 NUL 字节→`\x00` 转义（零行为变化；grep/read 工具恢复可用） |
| 2ecb43e | R1 生产修复：endTick 关窗先行（否决标记 + publishTickClosure + 关窗后现读 + 尾部幂等重申；admit/executeDispatch/executeRearm 与 facade 授权窗口共享消费；closurePersisted 如实返回；resetTreasuryCoreStoreForTest 清模块级生命周期事实；G02 等价重组） |
| 5fb07ca | V1 工具修复：performTreasuryFullReset 来源必备（配对一致性前置；oracle 断点缺 eventBranch/普通数组通道拒；memorySnapshot+oracle 拒；非 oracle 不受限）；F17 等价迁移 |
| 4a41376 | I 矩阵 19 用例（VKernel 11 + VService 8，含 I13 四成本 fixture 实测） |
| e65257d+前序 | 基线/负向变体证据 + openspec 四文档 + budget 锚点/计数滚动（235/1404，锚点即本提交） |
| 7e97766 | budget 滚动提交 = 固定验证 HEAD（本报告验证产物全部对应该 HEAD） |

## 2. R1/V1 与 I01–I16 状态

**R1（先关窗后恢复）——完成。** 语义顺序：endTick 请求即置模块级按 tick 失效否决标记（单一、固定大小、仅否决）→ 安全写协议发布并确认 lastEndTick（幂等；结果如实）→ 关窗后现读驱动恢复循环 → 同一推进所有权下回调 → 尾部只维护预算/游标并幂等重申关窗（事实一致跳过）。发布失败/篡改：不谎报（closurePersisted=false）、跨实例否决、恢复写可确认关闭。异常：已发布恢复/关闭不撤销、guard finally 释放、清理继续。嵌套 endTick 仍有界关窗。

**V1（缺来源拒绝）——完成。** oracle 断点恢复必须携带匹配 eventBranch（缺失/普通数组通道在对账前、任何状态修改前拒绝，零修改）；显式旧 memorySnapshot+oracle 拒；继续当前世界=入口即时快照；kernel 面裸 Memory 仍可用且不宣称 exact；伪造断点保持"断点配对不一致"口径。

| I 项 | 入口与断言位置 | 状态 |
| --- | --- | --- |
| I01 | VKernel `I01…`（对照+主用例）：回调进入时 lastEndTick===Game.time、authorize 拒 lifecycle_closed、frontier/active 增量 0；对照三候选 admitted | 绿 |
| I02 | VKernel `I02…`：dispatch blocked/动作 0/P 保持 pending；rearm 拒/child 0；父代保持 retry_ready + 下一 tick 重签能力 admitted | 绿 |
| I03 | VKernel `I03…`：抛错后 A unknown、lastEndTick 保持、另一 facade 拒、beginTick cleaned>0、推进后仍拒 | 绿 |
| I04 | VKernel `I04…`×2：丢写（closurePersisted=false/active/budget 不变/跨实例拒/重申确认）+ 篡改（health healthy/跨实例拒/幂等重申） | 绿 |
| I05 | VKernel `I05…`：预算满关窗写仍确认、同 tick begin 不复活、嵌套四方向零推进/零恢复、下一 tick admitted（新句柄） | 绿 |
| I06 | VKernel `I06…`×2：关闭后切点恢复保持关闭+下一 tick 完成 dispatch；关闭前切点窗口开启 | 绿 |
| I07 | VService `I07…`×2：缺分支恢复前拒绝+零修改（逐项 JSON 相等）；携带分支对照（空分支 not_executed） | 绿 |
| I08 | VService `I08…`×3：memorySnapshot+oracle 拒；普通数组拒/非 oracle 不受限；kernel 面可用不宣称 exact | 绿 |
| I09 | VService `I09…`：空 B0≠缺来源、B1 committed、B0 子分支 C→B2（A 不借废弃效果、C committed、A 有界保留）、错 J 拒 | 绿 |
| I10 | VService `I10…`×2：当前世界 reset（世界/journal 一致续用、新业务 admitted）；H15 同参数父子恢复重跑全链 | 绿 |
| I11/I12 | 既有 G01–G08/H07/H17/F/C/E 系列全量重跑（I 轮验证流程） | 绿 |
| I13 | VKernel `I13…`×2：四 fixture 实测（见 final/README 表；含逐 tick 释放 ≤4、份额 ≤8、有界写尝试） | 绿 |
| I14 | evidence/negative-variants：R1 晚关窗（I01/I03 红；I02 不红=分层证据）、V1 删校验（I07/I08 红）；还原 11/11、8/8 绿 | 红→绿 |
| I15 | final/：固定 HEAD 的 typecheck/build/三组 jest JSON/budget/diff-check/状态前后 | 全过 |
| I16 | 本报告 + 取证修订（探针转 .txt；上轮压力口径纠正） | 完成 |

## 3. 基线反例（fb5e44b 干净 worktree 真实复现）

- R1（exit=1）：对照绿；反例 1 红（回调进入时 lastEndTick=null、authorize admitted、dispatch 实际执行、发行 +2）；反例 2 红（全丢写后另一 facade admitted）；反例 3 红（抛错后窗口仍开）。修复后复跑 **4/4 绿**（exit=0）。
- V1（exit=1）：TRACE 绿——错结论真实复现（世界回 1000 + J 含后来 effect + settle committed）；REJECT 红。修复后复跑 TRACE 红（路径已封闭）+ REJECT 绿。
- 详见 evidence/core-rewrite-iv-remediation-v/baseline/（源码/命令/日志/退出码/SHA/README）。

## 4. 验证数字（固定 HEAD 7e97766 原始产物）

- 全仓默认收集：**235 suites / 1404 tests / 1404 passed**；failed、pending、todo、runtime errors 均为 0（jest-full.json）。
- Treasury 定向（src/runtime/treasury/）：31 suites/558；test/baseline 单独归类 2 suites/11；Defense 冻结集合：11 suites/118。
- budget：`JEST_TEST_BUDGET=PASSED`（manifest=仓库=锚点 e65257dd 三方一致；protected/Defense 集合保持）。
- 旧压力用例（口径修正后的事实）：`10,000 项完成工作`（107s）与 `1,000 次 retry 链`（11s）在本轮最终全仓**实际重跑 passed**（jest-full.json 断言级记录）；上轮报告"未重跑"表述与其自身 final/jest-full.json 不符——两轮实际都重跑了，上轮口径有误，特此纠正。

## 5. 取证修订（I16）

- 上轮验证后补交的 `v1-declared-identity-split.attribution-probe.ts` 已转**非执行 .txt 归档**（`git mv`，历史不改写；README 注明二分依据与行为等价断言的去向——I07/I08/I09 与 IV 轮 H08/H12 测试树）。
- 本轮全部可执行变更（生产/测试/工具/budget 常量）均在固定验证 HEAD 之前提交；验证后仅追加本报告与 final/README（非执行文档）。

## 6. 支持模型与未完成项

- 支持模型不变：受控同步效果世界、选定断点状态保留后的完整运行时重建；不声称覆盖真实 driver 非原子窗口、任意旧备份回滚或整份 Memory 丢失；不作 exactly-once 承诺。关窗请求在全 heap 丢失后不可从未落盘信息重建（§2.3 故障模型边界，如实报告）。
- 观察（非本轮范围，已记 tasks.md）：H18 手工满载记录不满足结构校验（store unhealthy，部分断言空转）——下轮应改用合法记录形状；facade 旧栈 beginTick 不接线 releaseExternalConsumer 时 kernel 面接纳的义务在 service 面清理中保守保留（仅测试装配差异）。
- 不部署、不合并 main、不接触真实 writer/凭证；Defense 生产文件零 diff；内核候选验收、真实引擎验证与生产部署是不同关口。
