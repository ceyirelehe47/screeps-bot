# Treasury Production T1：隔离引擎验收（2026-09-25）

## 身份与环境

- 产品源码：`69bf15cf2a533a8adc3f642f7de16bc529915d53`。它以旧生产源码 `06ffedb7` 为底，包含已经在 shard1 单独部署的巡逻修复 `5cef62c5`。本候选没有上传到正式 Screeps。
- 冻结 `main`：4,946,214 字节，SHA-256 `368196906dbd95dffe69bd830c2274988425fcef09d32a817eb0bfcdb6bb576c`；[manifest.json](treasury-production-T1-engine-evidence-20260925/manifest.json) 与每份原始快照中的代码指纹一致。
- 真实引擎：服务器 `dsh` 上的 Screeps `4.3.0`、官方 Node `22.22.1`，仅绑定回环地址；合成账号 `lab_treasury_t1` 拥有 `E3N59`、`E4N58` 两个 RCL8 房间。没有使用正式账号、正式 shard 或真实 Steam 密钥。
- 服务器：2 vCPU、约 3.6 GiB RAM；隔离服务限制 3 GiB，实测内存峰值 503,857,152 字节。系统只有 `/swap-screeps.img` 一份 8 GiB swap，本轮用量 0；原 `/swap.img` 已删除，`/etc/fstab` 只保留新条目。既有 `dsh.service` 和 nginx 在测试结束后仍运行。引擎当前已停止，安装、世界和证据保留于 `/srv/screeps-treasury-t1`。

## 第一轮：生产任务入口到原生交易

在合成世界预置一条尚余 250 H 的旧 `resourceControl` 任务、一条非空旧预约，并让两个真实 terminal 的初始 H/energy 分别为源 `1000/10000`、目标 `200/2000`。`Game.market.calcTransactionCost(100, E3N59, E4N58)` 的引擎报价为 4 energy。候选代码经 `src/main.ts → runResourceControl() → runTreasuryTerminalTransferTask()` 触发原生 `terminal.send`，没有从测试脚本直接调用发送 API。

| 暂停快照 | 模式 | 旧任务余量 | 累计交易 | 源 terminal H/energy | 目标 H | 结果 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `pre-canary`，tick 315 | shadow | 250 | 0 | 1000/10000 | 200 | 预约非空；Treasury 内核与配额均不存在。此前 OFF 运行也未隐式迁移。 |
| `post-canary`，tick 343 | canary | 150 | 1 | 900/9996 | 300 | tick 320 只发送一次 100 H；旧任务在交易确认后恰扣 100；预约迁至 typed owner v4，仍为 1 条；内核 active 清空，ring 留一条 committed。 |
| `drain`，tick 365 | drain | 150 | 1 | 900/9996 | 300 | 没有追加发送，也没有提前交给旧 writer。 |
| `post-off`，tick 386 | OFF | 0 | 2 | 750/9991 | 450 | 关闭租约并排空配额后，旧 writer 在 tick 370 发送剩余 150 H，费用 5 energy。 |
| `post-restart-off`，tick 404 | OFF | 0 | 2 | 750/9991 | 450 | 停止并重启引擎，继续运行后没有重发。 |

第一轮的世界与 Memory 原始快照、交易记录、校验脚本和结果位于 [证据目录](treasury-production-T1-engine-evidence-20260925/)。在候选分支执行 `python3 docs/reports/treasury-production-T1-engine-evidence-20260925/verify.py docs/reports/treasury-production-T1-engine-evidence-20260925` 得到 `success_path_pass`，失败项为零。服务器另存第一轮完成后的数据库副本 `/srv/screeps-treasury-t1/evidence/db-after-first-run.json`。

## 第二轮：带采样的合成成本复测

第一轮成功链路没有开启逐阶段 CPU profiler。为测量成本，我们在**已备份的同一隔离世界**人工清除合成配额并新增 `lab-cpu-H-task`；这只是一轮新的实验装夹，不属于产品自动 rearm 行为。核心保留上一轮 committed ring，新增任务仍从旧 `resourceControl` 入口进入。CPU profiler 每 tick 采样，滚动摘要只取最近 10 tick；`roomRoleAggregation=false`、`heapStats=false`。

第二轮 tick 440 的原生交易再发送 100 H，源 H/energy 从 `750/9991` 变为 `650/9987`，目标 H 从 `450` 变为 `550`，费用仍为 4。发送当 tick 旧任务仍余 250；tick 441 经交易对账才变为 150。`drain` 至 tick 475 没有新交易。切回 OFF 后旧 writer 发送余下 150 H，最终源 `500/9982`、目标 `700`、旧任务完成。第一轮及第二轮累计 4 笔，其中各一笔由 Treasury 发送。

| CPU 采样 tick | 阶段 | 总 CPU | `treasuryBeginTick` | 整段 `resourceControl` | `treasuryEndTick` | 最近 10 tick 总 CPU 均值 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 424 | OFF 稳态 | 2.552 | 0.018 | 0.092 | — | 4.558 |
| 439 | shadow 稳态 | 4.906 | 0.016 | 0.065 | — | 3.885 |
| 440 | canary 原生发送 | 38.796 | 3.720 | 28.908 | 1.388 | 7.445 |
| 441 | 交易对账、任务扣减 | 8.298 | 3.240 | 1.335 | 1.127 | 7.793 |
| 460 | canary 已确认后 | 12.021 | 0.516 | 1.996 | 0.143 | 5.367 |
| 475 | drain 稳态 | 7.869 | 0.320 | 0.044 | 0.107 | 6.076 |
| 490 | OFF 旧 writer 交回后 | 9.617 | 0.016 | 2.277 | — | 5.888 |

这些数值由实际引擎 `Game.cpu.getUsed()` 和候选已有 profiler 得出，但它们包含采样本身的开销。`resourceControl` 是整个旧调度阶段，不能把它全部归因于 Treasury；滚动总 CPU 还包含其他 Bot 阶段，不同模式的窗口也不能直接相减当作增量。隔离引擎 CPU 不是 shard1 的生产 CPU 判据。第一轮默认 profiler 关闭的成本未单独采样；第二轮满足成本观察，但不替代第一轮的一次性配额与重启验收。

## 范围与剩余门槛

- 真实引擎已覆盖默认 OFF、shadow、非空旧任务与预约、一次原生发送、费用和库存、下一 tick 对账、drain、OFF 交回及重启不重发。`outcome_unknown`、冲突 writer、坏预约和结构替换等故障注入由定向 Jest 测试覆盖，**没有**声称这些故障在真实引擎中发生。
- 模块距十进制 5 MB 仅约 53,786 字节；构建通过不代表正式 API 上传已验证。正式灰度前须重新确认候选字节、平台限制及现役代码差异。
- G2 正式 shard1 灰度与独立审查尚未执行；G1 FC1 Online II 四点测量与精确恢复也尚未执行。G1 包内旧恢复字节不含已部署的巡逻修复，不能直接当作当前恢复基线。任务包整体仍为 **PARTIAL**。首次 writer 灰度的前置、切换和停止条件见 [灰度说明](treasury-production-T1-first-gray-20260925.md)。
