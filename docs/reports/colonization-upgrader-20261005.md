# 殖民 T3 支援改为专用 upgrader 执行 v13

日期：2026-10-05（Asia/Shanghai），正式 shard1，账号 forster。

## 问题

用户指出殖民房的 T3 upgrader 实际在运行 worker 逻辑。此问题确实存在：v12 的支援配置角色为 `colonizerWorker`，抵达目标后调用 `workerRole`，会领取建造、维修等任务。

tick 74134810 原生读回：E3N54 为本方 RCL2，两名支援的 Memory 与配置角色均为 `colonizerWorker`；E4N57 尚有 Invader 预订。不能将身体已增强、支持升级任务等同于真正的专用 upgrader 行为。

## 修正

- 新增 `colonizerUpgrader` 角色，复用 `upgrader.ts` 提取的取能与直接升级核心。它只取能并执行 `upgradeController`，不调用 `workerRole`，不领取 worker 任务，也不建造、维修或拆除。
- 取能采用现有 upgrader 顺序：控制器范围内有能量的 Link、Container，其后目标房 Storage、本地通用拾取。工作前必须已经抵达目标房，控制器为本方且 RCL1–5。
- 普通 RCL8 维护 upgrader 的准入和清理逻辑保持原状。殖民专用角色独立登记到角色目录、注册表、身体配置及出境识别中，避免落入维护角色清理范围。
- 支援身体继续为 15 WORK / 10 CARRY / 25 MOVE，全部 WORK 使用 XGH2O；空手出发，只使用目标房能量。完成闩、RCL6 停止补员、归还余能和返回 E1N57 的规则保留。
- 现役与 `:retiring:` 过渡单位原位转换角色，同步备用 roleArgs，释放旧 worker 与取能绑定，重新检查准备状态；已经增强的部件不会重复增强，不重生、不修改身体。
- 保留现有配置 ID 和已出生 creep 名字。ID 或名字中的 `worker` 是历史标识，实际执行以新配置和 Memory 的 `colonizerUpgrader` 为准；后续新生单位使用新角色名。
- 普通殖民 worker 继续处理建设。worker 升级席位只计实际 worker，专用支援不占 worker 任务席位。

## 服务器验证与冻结发布

全部构建与测试在 dsh 隔离目录 `/srv/screeps-treasury-build/colonization-upgrader-20261005` 执行。本机仅编辑、轻量查询、文件传输和上线控制。

| 项目 | 结果 |
| --- | --- |
| 线上基线 | `33fe093aaae68d511e36133df1c479510b9a4195`（v12） |
| 最终源码 | `efd9e7a1850635e4d741a944ba4621b9a04af184` |
| 源码 tree | `ded96a35c6b893cc3efca3551007cf6e28759b3b` |
| 构建标识 | `2026.10.5-13+efd9e7a@2026-10-05T05:05:17.043Z` |
| main.js 最终字节数 | 3,648,078 |
| 最终文件 SHA-256 | `592f7ec73badb269b6964aeaf915c7aed72f45bc3c82cd25cc6ef85d2a3852d7` |
| 生产、测试类型检查 | 均通过 |
| 定向回归 | 12 套、50 项全部通过 |
| 全量回归 | 244 套、1759 项全部通过，332.319 秒，无失败或跳过 |
| 构建 | 通过，42.6 秒，保留既有循环依赖提示 |
| 正式上传 | 一次 POST 接受，独立 GET 字节数与 SHA-256 完全匹配 |

首轮测试类型检查发现 `roleCatalog.test.ts` 的静态联合清单漏登新角色，按实际角色目录补齐并更新精确数量检查；没有放宽边界。最终完整检查在冻结来源上重新执行，初轮日志保留。SSH 曾在传输/连接阶段中断，恢复后继续服务器验证，没有改在本机构建。

发布前核对账号、v12 在线哈希、四 shard 无未处理 Treasury 责任、两房支援配置、E4N57 的 E3N57 过境许可、OH 50k 配置及原有三房共享清剿观察配置；备份完整代码和 Memory。本次没有修改主循环顺序、HUB 供货实现、市场或 Treasury 策略。

## 原生验收

v13 发布前的最终读回（tick 74135366）：E3N54、E4N57 均已认领，现有殖民流程处于 `bootstrapping`。该次完整 Memory 中，先前 E3N54 的 `colonizerWorker-74134379` 和 `colonizerWorker-74133821` 已不在 creep 记录中；本次不能宣称把这两名已不存在的单位原位切换。没有取得它们此前消失的原因。

tick 74135402：v13 原生部署标签正确。E4N57 支援 `colonizerWorker-74135170` 的 Memory 和配置角色均已原位转为 `colonizerUpgrader`，所有 15 WORK 为 XGH2O，空载经过 E3N57，worker 绑定为 null。当时 E4N57 为本方 RCL1、进度 0；E3N54 为 RCL2、进度 1958。

tick 74135506：E4N57 支援已抵达目标房 `(32,32)`，从本地取得能量（当时 489）。E3N54 缺员已自动补上队列：`colonizerUpgrader-74135464` 在 E1N57 Spawn11 孵化，总 150 tick、剩余 108，能量 0，角色正确。没有手工创建额外配置或强制孵化。

最终 tick 74135542：E4N57 **实际从 RCL1 升至 RCL2，进度 778**。支援仍为配置/Memory 双侧的 `colonizerUpgrader`，身体 **15 WORK / 10 CARRY / 25 MOVE**，15 WORK 全部 XGH2O；本地能量已消耗完，`working:false` 正在回取能，worker 绑定仍为 null。E3N54 替补的角色、配置和 50 部件身体读回一致，当前仍在源房孵化，空载且没有 worker 绑定；不将其孵化中状态报告为已抵达或已完成增强。

上述控制台采集窗口未记录原生错误。两房的 RCL6 完成尚未发生，其终止、归还余能与返回规则由定向/全量回归覆盖。最终 main.js 的独立读取已核对完整文件哈希；产物尾部绑定的运行时摘要为 `adc788cccf8b16e2eeda58efcf36401211eb3e6223c85f06cc8d168e56ed8768`，计算范围是 append 前正文，与表中完整文件摘要分别核对。

## 证据位置

- 本次冻结清单、日志和发布结果：`/Users/forst/Downloads/screeps-colonization-upgrader-20261005`。
- 原生控制台 intent、HTTP 回应及 websocket events：`/Users/forst/Downloads/screeps-colonize-e3n54-e4n57-20261005` 中的 `upgrader-before`、`upgrader-after-*`。
- 服务器原始日志：`/srv/screeps-treasury-build/colonization-upgrader-20261005/evidence`。
- 上传不重放未知写结果，生产角色切换由已发布运行时维护完成。
