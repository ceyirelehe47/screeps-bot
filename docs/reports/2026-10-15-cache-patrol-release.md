# 缓存统计与 E2N54 巡逻修复发布记录

2026-10-15，Asia/Shanghai。**已提交并完成一次生产部署**。代码提交 `a4cca805b3d20b55f4284e51cfafdcd5092de3e2`，发布版本 `2026.10.15-1`。服务器完整回归、类型检查、构建通过；远端代码回读逐字节一致，运行中的版本、commit、tree 与 bundle hash 均匹配。

## 发布身份

| 项目 | 值 |
| --- | --- |
| 目标 | `forster / shard1 / default` |
| 线上原提交 | `642e25996fa2aa7418a8c4a190ecaff6381c2ec3` |
| 原 main SHA-256 | `f503c21b1a5745afe5bbfe7eb2b6a25cfdb94e7ca172d15f6b0c5ad40ee6b461` |
| 最终代码提交 | `a4cca805b3d20b55f4284e51cfafdcd5092de3e2` |
| 最终 tree | `2666aed8d7874673f7032ee89b20c9c1469caa6e` |
| 完整 tag | `2026.10.15-1+a4cca80@2026-10-15T07:47:44.733Z` |
| main 大小 | `3,678,062` 字节 |
| main SHA-256 | `2212c05cfd5cb364894ba5c513fc4d5dcd3f644399eb1816843912bd18112050` |
| bundle 内嵌 payload hash | `30a78f8aeea77828db92a61b813b4b28b473f3a4a43de13baf7514b7f833f48d` |
| 上传回读时间 | `2026-10-15 15:50:26.397 +08:00` |
| 运行时部署 tick | `74346393` |

本记录为部署后的文档补充；运行时 commit 固定指向上述代码提交，不指向后续纯文档提交。

## 最终改动

原工作目录停留在旧基线 `cc4fa697`，与线上相差 972 个文件。本次从核实的线上 `642e259` 创建隔离 worktree，保留线上后续功能与市场 r7 策略。旧基线成果另存 `3c56f098`，未从旧目录构建上线。缓存候选 `07eecd02` 仅作为中间验证记录，最终只上传合并巡逻修复的 a4 产物一次。

相对线上共 9 个文件，298 行新增、57 行删除：3 个生产源码、4 个既有测试、2 个版本文件。

- `cpuMonitor.ts`：用窗口内样本计数管理统计键；保留合法零值，清除最后一份样本淘汰后的浮点残差。兼容旧 heap，缺少内部计数时从 history 恢复，保留 EMA 与现有健康字段。
- `roomTopologyRevision.ts`：复用 TickContext 的 Deposit 查询，保留逐房 memo、诊断及远采读取时序。
- `meleeAttacker.ts`：邻近 wall/rampart 不再抢走核心目标或已确认的覆盖 rampart；搜索预算保持 2000 ops，耗尽时不授权破墙；没有路径或突破证明时停止任意敲邻墙；战争目标失效后下一 tick 重选。
- 回归覆盖开放绕行、搜索预算耗尽、相邻屏障抢目标、必要突破、普通角色回退及精确现场场景。

原计划中的有效 ignoreCreeps 传递与静态矩阵按房复用已在当前线上实现，本次保留生产实现并加强测试。没有修改主循环、market、treasury、permit、线上配置或直接写 Memory。

## E2N54 根因与现场验收

上线前，watch `E1N57:TooAngel:E2N54|E3N53|E3N57` 的 towerDrainDuo 第 58 代停在房间东侧。攻击手 `meleeAttacker-74344803` 位于 `(48,5)`，actionLog 指向 `(47,6)` 的 180 万血 constructedWall。真正的塔在 `(18,3)`，同格 rampart 只有 10,201 血。

代码首先识别塔下覆盖 rampart，但后续扫描把相邻墙认作可直接接近的目标，覆盖了原本的目标选择；在这条现场分支中尚未执行 PathFinder。因此不能把现场原因归为搜索预算不足。

用户所说的“有路”已被地形与结构检查证实：存在经 `(47,10)` 缺口的 33 步路线（含 10 格沼泽），以及经 `(47,30) → (46,31)` 的 66 步全平地路线，均不依赖边缘迁房。几何开放仍不同于当前安全可走：最初敌兵堵住 `(48,8)`，活塔附近伤害超过当时治疗能力。安全限制原样保留。

上线后两次只读快照分别采于 **15:50:52** 与 **15:52:03**，匹配同一新 tag、同一第 58 代：

| 观察 | 第一快照 | 第二快照 |
| --- | --- | --- |
| 攻击手位置 | `(48,6)` | 开口 `(47,10)` |
| 攻击手血量 / 疲劳 | `5000/5000 / 0` | `5000/5000 / 0` |
| actionLog.attack | 无 | 无 |
| `(47,6)` 旧厚墙血量 | `1,551,011` | `1,551,011` |
| breach 目标 | `(18,3)` 塔下 rampart | 同一 rampart |
| 配对状态 | `breaching` | `retreating / healing_or_body` |

第二快照的治疗 telemetry 位于 E3N54 `(1,5)`。两次快照证实错误拆邻墙已停止，攻击手也到达了已有开口；尚未证明后续持续安全通行或完成攻塔。同期敌兵已离开堵口，塔能量自然降至 2，因此不把全部推进归因于补丁。各 API 读取不是同 tick 原子快照。

## 服务器验证

构建、类型检查及全部 Jest 均在 dsh 的隔离目录执行，本机仅编辑、传输、轻量哈希核对与上线控制。

| 检查 | 结果 |
| --- | --- |
| 旧生产源码 + 新巡逻用例的反例 | 7 个预期失败，验证能抓住问题 |
| 修复后巡逻测试 | 15/15 通过 |
| 战争、治疗、移动相关回归 | 16 套 / 211 用例通过 |
| build/test 双 TypeScript 检查 | 通过 |
| 完整 Jest | **253 套 / 1870 用例全部通过** |
| 测试集合核对 | tracked = listTests = 实际结果，253 文件完全相同 |
| 用例数核对 | 相比缓存候选 1865，只增加 melee 的 5 个用例，其余 252 文件数量不变 |
| failed / pending / todo / runtime-error | 全部 0 |
| 最终构建 | detached a4、clean、default，exit 0 |
| 源码与产物身份 | 本机/服务器 9 文件哈希、commit/tree、内嵌 hash 全部一致 |
| 独立范围审查与 diff check | 通过，无本轮 P0/P1/P2 |

既有 `test:budget` 清单已漂移：仍固定 193 套/683 用例，缺少 64 个现存文件并引用 4 个在上线基线已删除的测试，运行时在 Jest 前 ENOENT。此项记录为 **PREEXISTING_STALE_FAILED**，未修改预算、恢复旧测试、缩减用例或改 Jest 配置来伪造通过。其余 14 个现存 protected 文件与线上基线逐字节相同。本次用无路径过滤的正式全量 Jest，加三集合一致性与逐文件断言数核对作为完整回归证据，不称旧预算通过。

## 线上观察与保留问题

上传后日志观察窗口为 **15:50:29–15:53:32**：48 个 console 事件、39 个 CPU socket 事件。未观察到 JS 异常或其它运行时错误；记录到 **7 次 bucket empty、2 次 CPU time limit**，后两次都在上传后的前 20 秒。旧版约 10 分钟基线为 18 次 bucket empty、1 次 CPU time limit，同样没有 JS 异常。不同窗口与负载不可直接比较，也不能据此把新版具体超时热点认定为旧问题。

新版本完成 checkpoint 已观察到 `74346407`、`74346425`、`74346437`，运行时 lastGlobalStartAt 为本次部署 tick `74346393`。初次快照的 CPU/health 仍属于旧 tick，未把它当作新版本成功证据。checkpoint 范围不代表其中每个 tick 都完成。

后续三次 CPU 样本 bucket 为 11、88、23，CPU 压力仍在，**未宣称总体 CPU 收益或稳定性已经解决**。本次缓存改动的正确性由离线回归验证；没有从少量线上样本外推性能结论。

四次只读配置比较的人工配置变更键均为空；完整 cfg 仅 hubPlanner 自动拥有的 synthesis reactions 与 revision 自然变化。market 仍为 `market-base-resource-v3-r7` / direct，pending create 与 pending mutation 均为 0。未修改线上配置，未执行 console probe 或 Memory 写入。未触发回滚；原生产模块和立即上传前模块均已本机保留，回滚路径要求当前线上仍是本候选，防止覆盖他人新部署。

## 可定位证据

- 同目录 `2026-10-15-cache-patrol-evidence.json`：脱敏验证、构建、上传、运行和巡逻摘要。SHA-256：`ec8c7ae8d91411c75ebf8b5db71d5eef1030d5793b78f1baa8807837a88bf73c`。
- 原始验证摘要：`/Users/forst/code/screeps/monitor-data/20261015-deploy/final-patrol/validation-summary.json`，SHA-256 `3e1237387b3e0d5412175917ede0c47c15d60c82bcef14d26f659565fc629b27`。
- 完整 Jest 原始 JSON：同目录 `full-jest.results.json`，SHA-256 `9c7c115cff3c5cba762b3babf448d9cd35fbd896ef484a0d4df6481f105df8df`。
- 服务器日志：`dsh:/root/codex-jobs/20261015-screeps-live-cache-01a13e43/logs/final-patrol/`。
- 线上部署与日志：`/Users/forst/code/screeps/monitor-data/20261015-deploy/`。
- E2N54 原始、地形、路径及两次上线后快照：`/Users/forst/code/screeps/monitor-data/20261015-patrol/`。

原始 Memory、模块回滚快照和凭据均未提交；报告与机器摘要不含 secret/token。
